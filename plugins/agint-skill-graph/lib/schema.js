/**
 * agint-skill-graph: FROZEN schema + 枚举 + 阈值 + 配置（P2-2 §3.1 / §3.2 / §4.3）。
 *
 * 上游设计：`DSH-AGINT.wiki/设计-P2-2-技能使用统计与学习图谱.md` v0.4。
 *
 * 红线（§4.3 七条不变量，本文件承载其中 2 / 5 的常量部分）：
 *   1. 技能身份唯一：节点主键恒为 `skillName`（= SKILL.md frontmatter.name /
 *      目录名），**禁止引入第二套 ID**（v0.1 的 `skillId` 在 curator 与全库都不存在）。
 *   2. 边必须带证据：`evidence` 缺失或为空对象的边非法（validate 强校验）。
 *   3. 零数据必须"响"：空图 → health=EMPTY + recommend 返回 INSUFFICIENT_DATA。
 *   4. 不复制上游常量：`SKILL_STATES` / `isExcludedRecord` / `OVERLAP_THRESHOLDS`
 *      一律从 agint-curator 引用（§〇 Q4、§3.2 路径 B「阈值引用不复制」）。
 */

import { z } from 'zod';

import {
  SKILL_STATES,
  EXCLUDED_DATA_SOURCES,
  DATA_SOURCE_BLACKLIST_VERSION,
  isExcludedRecord,
} from '../../agint-curator/lib/schema.js';
import { OVERLAP_THRESHOLDS } from '../../agint-curator/lib/dedup.js';

// ── 域与版本（§3.1：独立域 agint_skill_graph，schemaVersion 1 一次定够）─────

export const DOMAIN_NAME = 'agint_skill_graph';
export const SCHEMA_VERSION = 1;

// ── 复用 curator 既有契约（引用不复制；跨插件 import 已有先例）────────────

export {
  SKILL_STATES,
  EXCLUDED_DATA_SOURCES,
  DATA_SOURCE_BLACKLIST_VERSION,
  isExcludedRecord,
  OVERLAP_THRESHOLDS,
};

// ── 节点状态（§3.1）──────────────────────────────────────────────────────
//
// 前 5 个 = curator SKILL_STATES 原样透传（`protected` 是布尔属性不是状态，
// v0.1 记错）；`provisional` 是 P2-2 自有的第 6 态 = autocreate 候选未发布。

export const PROVISIONAL = 'provisional';
export const NODE_STATES = Object.freeze([...SKILL_STATES, PROVISIONAL]);

// ── 边类型（§3.2 四类，v0.3 新增 related 并提为首选）──────────────────────

export const EDGE_TYPES = Object.freeze(['related', 'overlap', 'co_use', 'similar']);

/** §3.2 总表：confidence 由边类型决定，不由算法打分 */
export const CONFIDENCE_BY_TYPE = Object.freeze({
  related: 'high',   // 作者/策展人显式声明，四类中最高
  overlap: 'medium', // curator 三维判定
  co_use: 'high',    // 真实行为共现
  similar: 'low',    // metadata 相似；LLM 标注不高于 medium
});

/** §3.2：`similar` 实测描述维最高相似度 0.201、阈值 0.70 为空集 → Sprint 20 观察项，默认关 */
export const SIMILAR_DEFAULT_ENABLED = false;

// ── 阈值（§3.2 / §六bis）─────────────────────────────────────────────────

export const THRESHOLDS = Object.freeze({
  /** co_use：同会话 30min 窗口内两技能先后被调用 */
  CO_USE_WINDOW_MS: 30 * 60 * 1000,
  /** co_use：同窗口共现 ≥3 次才建边（2026-09-13 实测：真实数据产出 4 条边，
   *  最高 9 会话 —— 设计稿 §六bis 记的「最多 2 对 × 各 1 次 → 0 条」已过时，
   *  是使用流量累积后的新结果，以本注释为准） */
  CO_USE_MIN_SESSIONS: 3,
  /** similar：元数据维阈值，与 overlap 的 desc 维**分开定**（不得复用 0.85 造成语义混淆） */
  SIMILAR_DESC: 0.7,
});

/** §4.1：状态判定线 —— nodesWithEdges/nodes < 0.3 或 edges === 0 → INSUFFICIENT_DATA */
export const INSUFFICIENT_COVERAGE_RATIO = 0.3;

/** §六 降级链 3：图数据 14 天未刷新 → recommend 带 stale 警告 */
export const STALE_AFTER_DAYS = 14;

/** §六 默认权重（L1-adjustable，落 config，非 FROZEN） */
export const DEFAULT_WEIGHTS = Object.freeze({
  intentMatch: 0.4,
  neighborBoost: 0.3,
  successRate: 0.2,
  recency: 0.1,
});

/** §六 recencyBoost 指数衰减半衰期 */
export const RECENCY_HALF_LIFE_DAYS = 14;

/** §五 5.3 标定期模式：未跑过标定期直接切 live → 抛错（对齐 P2-1 不变量） */
export const RECORD_MODES = Object.freeze(['count-only', 'live']);

// ── 记录 schema ──────────────────────────────────────────────────────────

export const UsageStatsSchema = z.object({
  skillName: z.string().min(1),      // 主键：= SKILL.md 目录名 / frontmatter.name
  dirName: z.string().default(''),   // 技能目录名（漂移时对账用）
  presets: z.array(z.string()).default([]), // 该技能被哪些预设收录（实测 3 预设 / 去重 11 技能）
  status: z.enum(NODE_STATES).default('active'),
  calls: z.number().int().min(0).default(0), // 主口径 = tool-stats 中 tool==='skill' 的记录数
  /** 被"查看/加载但未真正使用"的计数（对齐 Hermes view_count）；AGINT 无独立数据源 → 恒 null，不编造 */
  viewCount: z.number().int().min(0).nullable().default(null),
  /** 被修改过的累计次数（对齐 Hermes patch_count）；无数据源 → 恒 null */
  patchCount: z.number().int().min(0).nullable().default(null),
  /**
   * 0-1；数据不足时 null。**当前必然 null**（§3.3）——Hermes 的技能级同样没有成功率，
   * 说明"技能级成功率不可得"是这类系统的固有属性，不是本设计的实现缺陷。
   */
  successRate: z.number().min(0).max(1).nullable().default(null),
  lastUsedAt: z.string().nullable().default(null),
  firstUsedAt: z.string().nullable().default(null),
  firstSeenAt: z.string().default(''),
  updatedAt: z.string().default(''),
  /** provisional（autocreate 候选未发布）：计入图但不计使用（§3.3「节点与使用的关系」） */
  provisional: z.boolean().default(false),
  /** 指向 curator skill_states.quality.history 的引用键，**不复制周趋势**（§3.1） */
  qualityRef: z.string().nullable().default(null),
});

export const EdgeEvidenceSchema = z.record(z.unknown());

export const SkillEdgeSchema = z.object({
  edgeId: z.string().min(1),
  src: z.string().min(1),   // 无向边存字典序小者为 src
  dst: z.string().min(1),
  type: z.enum(EDGE_TYPES),
  weight: z.number().min(0).max(1).default(0.5),
  evidence: EdgeEvidenceSchema,           // 不变量 2：必须带证据
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
  createdAt: z.string().default(''),
  supersededBy: z.string().nullable().default(null),
  /** related 边专用：A 声明 B 而 B 未声明 A → 保留边但标记（单向声明是合法表达） */
  asymmetric: z.boolean().default(false),
}).passthrough();

/** 每种边类型必须有这些 evidence 键，否则 validateEdge 判非法（§九「声明-计算分工」） */
export const EVIDENCE_REQUIRED_KEYS = Object.freeze({
  related: ['method', 'field', 'declaredIn'],
  overlap: ['method', 'similarity', 'source'],
  co_use: ['method', 'sessions', 'window', 'sessionIds'],
  similar: ['method', 'fields'],
});

/** §4.1 空图诚实指标。nodesWithUsage 是 v0.3 追加的第二个分母（§12.5 开放问题 6）。 */
export const CoverageSchema = z.object({
  nodes: z.number().int().min(0).default(0),
  nodesWithEdges: z.number().int().min(0).default(0),
  nodesWithUsage: z.number().int().min(0).default(0),
  ratio: z.number().min(0).max(1).default(0),
  usageRatio: z.number().min(0).max(1).default(0),
});

/** 丢弃与异常必须可观测（§3.3 / §九「零数据必须响」） */
export const CountersSchema = z.object({
  scanFailures: z.number().int().min(0).default(0),
  droppedEdges: z.number().int().min(0).default(0),
  /** tool-stats 中无技能归属的记录数（口径留痕） */
  skippedNoSkillField: z.number().int().min(0).default(0),
  /** related_skills 声明了但目标节点不存在 → 丢弃并计数（不静默） */
  droppedRelatedTargets: z.number().int().min(0).default(0),
  /** tool-stats 里 tool==='skill' 但 args.name 指向不存在的技能 → 丢弃并计数（不静默） */
  unknownSkillName: z.number().int().min(0).default(0),
  /** 边写入失败（fail-open 留痕） */
  writeFailures: z.number().int().min(0).default(0),
  /** 权重配置损坏回退次数（§六降级链 2） */
  weightFallbacks: z.number().int().min(0).default(0),
});

/** 标定期报告：count-only 跑出来的"若转 live 会得到多少节点/边"（§5.3 切档凭证） */
export const CalibrationSchema = z.object({
  week: z.string().default(''),
  ranAt: z.string().default(''),
  nodes: z.number().int().min(0).default(0),
  edges: z.number().int().min(0).default(0),
  edgesByType: z.record(z.number().int().min(0)).default({}),
  promotable: z.boolean().default(false),
});

export const GraphMetaSchema = z.object({
  lastFullScanAt: z.string().nullable().default(null),
  mode: z.enum(RECORD_MODES).default('count-only'),
  coverage: CoverageSchema.default(() => CoverageSchema.parse({})),
  counters: CountersSchema.default(() => CountersSchema.parse({})),
  lastCalibration: CalibrationSchema.nullable().default(null),
  updatedAt: z.string().default(''),
}).passthrough();

// ── 边工具函数 ───────────────────────────────────────────────────────────

/** 无向边归一化：字典序小者为 src（§3.1 取舍） */
export function normalizePair(a, b) {
  return a <= b ? [a, b] : [b, a];
}

export function makeEdgeId(type, a, b) {
  const [src, dst] = normalizePair(a, b);
  let h = 0;
  const s = `${type}:${src}:${dst}`;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `edge_${src}_${dst}_${type}_${h.toString(16).padStart(8, '0')}`;
}

/**
 * 不变量 2 + §九「声明-计算分工」：边必须带可审计证据，且按类型具备必备键。
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validateEdge(edge) {
  if (!edge || typeof edge !== 'object') return { ok: false, reason: 'edge is not an object' };
  if (!EDGE_TYPES.includes(edge.type)) return { ok: false, reason: `unknown edge type: ${edge.type}` };
  if (!edge.src || !edge.dst) return { ok: false, reason: 'edge missing src/dst' };
  if (edge.src === edge.dst) return { ok: false, reason: 'self-loop edge is illegal' };
  const ev = edge.evidence;
  if (!ev || typeof ev !== 'object' || Array.isArray(ev) || Object.keys(ev).length === 0) {
    return { ok: false, reason: 'evidence is required and must be non-empty' };
  }
  for (const key of EVIDENCE_REQUIRED_KEYS[edge.type] ?? []) {
    if (ev[key] === undefined || ev[key] === null) {
      return { ok: false, reason: `evidence.${key} is required for type ${edge.type}` };
    }
  }
  return { ok: true };
}

// ── 配置（cordis patch config；非 FROZEN）────────────────────────────────

const dshHome = () => process.env.DSH_HOME || `${process.env.HOME ?? ''}/.dsh`;

/**
 * ⚠️ zod 4 的 `.default({})` **不会**再跑一遍内层 schema —— 缺省值原样返回 `{}`，
 * 内层字段默认值全部丢失。所以嵌套对象一律用 `.default(() => X.parse({}))`
 * （curator 的 `QualitySchema.default({})` 属于同型隐患，只是消费方恰好容错）。
 */
const EdgeTypesSchema = z.object({
  related: z.boolean().default(true),
  overlap: z.boolean().default(true),
  co_use: z.boolean().default(true),
  similar: z.boolean().default(SIMILAR_DEFAULT_ENABLED),
});
const WeightsSchema = z.object({
  intentMatch: z.number(),
  neighborBoost: z.number(),
  successRate: z.number(),
  recency: z.number(),
});
const LimitsSchema = z.object({
  usage_stats: z.number().int().positive().default(500),
  skill_edges: z.number().int().positive().default(2000),
});

export const ConfigSchema = z.object({
  /** 节点全集 = presetsDir 下每个 preset 的 skills/{技能名}/SKILL.md（§2.1 R8） */
  presetsDir: z.string().default(() => `${dshHome()}/.agent-presets`),
  /** 唯一在产的使用信号来源（§3.3 主口径） */
  toolStatsPath: z.string().default(() => `${dshHome()}/storages/agint_tool_stats.jsonl`),
  lookbackDays: z.number().int().min(1).default(180),

  /** 落盘档位：默认 count-only（§5.3 标定期，未跑过就切 live 会抛错） */
  mode: z.enum(RECORD_MODES).default('count-only'),
  enabled: z.boolean().default(true),

  /** 边类型开关（similar 默认关 = §12.5 开放问题 4 的结论） */
  edgeTypes: EdgeTypesSchema.default(() => EdgeTypesSchema.parse({})),

  /** overlap 路径 B：需要回溯历史时才离线重算（阈值读 curator 常量，不写副本） */
  overlapOfflineRecompute: z.boolean().default(false),

  coUseWindowMs: z.number().int().min(1000).default(THRESHOLDS.CO_USE_WINDOW_MS),
  coUseMinSessions: z.number().int().min(1).default(THRESHOLDS.CO_USE_MIN_SESSIONS),
  similarDescThreshold: z.number().min(0).max(1).default(THRESHOLDS.SIMILAR_DESC),

  /** §六 推荐权重（L1-adjustable；损坏 → 回退默认 + counters 留痕） */
  recommendWeights: WeightsSchema.default(() => ({ ...DEFAULT_WEIGHTS })),
  recencyHalfLifeDays: z.number().positive().default(RECENCY_HALF_LIFE_DAYS),
  /** 主方案（§六 v0.3 建议）：返回列表不打分 */
  recommendMode: z.enum(['list', 'score']).default('list'),

  /** 事件订阅总开关（关掉后退化为全量扫） */
  enableEventSubscribe: z.boolean().default(true),

  /** 表上限（超限 warn 不 prune，对齐 curator / autocreate 惯例） */
  limits: LimitsSchema.default(() => LimitsSchema.parse({})),

  /** 导出目录（runtime，gitignored；禁止写死盘符/斜杠） */
  exportDir: z.string().default(() => `${dshHome()}/skill-graph/export`),
  /** §5.3 cron（agint-cron 侧读取本值，本插件仅透出） */
  weeklyCron: z.string().default('0 7 * * 0'),
}).passthrough();

export const DEFAULT_CONFIG = Object.freeze(ConfigSchema.parse({}));

/** 运行时可配置子集（skillGraph_config 允许改的字段） */
export const RUNTIME_CONFIG_KEYS = Object.freeze([
  'mode',
  'enabled',
  'recommendMode',
  'similarDescThreshold',
  'coUseMinSessions',
  'lookbackDays',
]);

/** 权重归一化：损坏（非正数 / NaN / 总和 0）→ 回退默认并标记 */
export function normalizeWeights(raw) {
  const keys = Object.keys(DEFAULT_WEIGHTS);
  const out = {};
  let sum = 0;
  for (const k of keys) {
    const v = Number(raw?.[k]);
    if (!Number.isFinite(v) || v < 0) return { weights: { ...DEFAULT_WEIGHTS }, fallback: true };
    out[k] = v;
    sum += v;
  }
  if (sum <= 0) return { weights: { ...DEFAULT_WEIGHTS }, fallback: true };
  for (const k of keys) out[k] = +(out[k] / sum).toFixed(6);
  return { weights: out, fallback: false };
}
