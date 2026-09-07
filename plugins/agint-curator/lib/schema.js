/**
 * agint-curator: FROZEN schema + LIMITS + 配置默认值 + 数据源黑名单。
 *
 * 上游：
 *   - `设计-P0-2-技能策展人机制.md` §4（数据结构）/ §8（配置项）
 *   - `Sprint14-设计稿.md` §3（阶段 1 裁剪）/ §2.1（D1–D4 数据源隔离）
 *
 * 与 P0-2 原文的三处**有意**偏离（Sprint 14 设计稿后出，以其为准）：
 *   1. 表上限取 Sprint14 §3.2（200/500/52/1000），非 P0-2 §4.2/§4.3 的
 *      1000/5000。理由：Sprint14 明确「对齐 agint-skill-autocreate 既有
 *      惯例：超限 warn 不 prune」，当前技能规模远不到 200。
 *   2. `state` 枚举含 `pinned`（Sprint14 §3.3 状态机把 PINNED 画成状态），
 *      不再单独保留 `pinned` 布尔标志。理由：避免「pinned=true 但
 *      state=archived」的双源真值矛盾态。
 *   3. 表只有 4 张（skill_states / curation_actions / reports / audit_log）。
 *      overlap_candidates 属 Sprint 15，届时 schemaVersion → 2 增表。
 *
 * 红线：
 *   - 自我评估禁止（P0-2 §9.4）：技能名/描述含 curator/策展/curation 关键词
 *     → 自动 protected，永不参与自动转换。
 */

import { z } from 'zod';

// ── 上限（Sprint14 §3.2）─────────────────────────────────────────────────

export const LIMITS = Object.freeze({
  SKILL_STATES: 200,      // 超限 warn，不自动 prune
  CURATION_ACTIONS: 500,  // 超限 warn
  REPORTS: 52,            // 每周一份，约一年
  AUDIT_LOG: 1000,        // 唯一自动滚动清理
  OVERLAP_CANDIDATES: 200,// Sprint 15 增表（超限 warn 不 prune）
});

// ── 状态机（Sprint14 §3.3 + Sprint15 §3.2 质量扩展）──────────────────────

/**
 * active  ──30天未用──▶ stale ──90天未用──▶ archived
 *   ▲                    │                    │
 *   └──7天内有使用────────┘                    └──人工 unarchive──▶ active
 *   │
 *   └──人工 pin──▶ pinned（不参与任何自动转换）
 *
 * Sprint 15 质量扩展（P0-2 §3.2 / §7.2）：
 *   active ──质量下降(成功率连续2周降>10% 或 HARM 连续2次<0)──▶ quality_declining
 *   active ──质量加速 stale(规则1: HARM连续2次<0 且 成功率<0.5)──▶ stale
 *   stale  ──质量加速 archive(规则2: HARM持续下降, 60天)──▶ archived
 *   stale  ──质量保护(规则3: HARM>1.0 且 成功率>0.8)──▶ 不归档, 标 review
 *   quality_declining ──7天内有使用且质量恢复──▶ active
 *   quality_declining ──陈旧达阈值──▶ archived
 *
 * 偏离登记（P0-2 §3.2 REVIEW 态）：REVIEW 不引入独立状态（避免「进了
 * review 出不来」的悬空态），由 quality_declining + curationNotes
 * 'review-suggested' + 报告建议承载，人工经既有 pin/archive/unarchive 处置。
 * pinned 作为状态而非标志位，见文件头偏离说明 2。
 */
export const SKILL_STATES = Object.freeze([
  'active', 'stale', 'archived', 'pinned', 'quality_declining',
]);

/** 受策展管理的来源；bundled/hub/external 只读不碰（P0-2 §1.3） */
export const MANAGED_SOURCES = Object.freeze(['auto', 'manual']);
export const UNMANAGED_SOURCES = Object.freeze(['bundled', 'hub', 'external']);
export const ALL_SOURCES = Object.freeze([...MANAGED_SOURCES, ...UNMANAGED_SOURCES]);

/** curation_actions.action（P0-2 §4.3，阶段 1 只用到子集） */
export const CURATION_ACTIONS = Object.freeze([
  'state_change', 'pin', 'unpin', 'archive', 'unarchive',
  'dry_run', 'pause', 'resume', 'weekly_run',
]);

/** State-engine 决策动作：与 CURATION_ACTIONS 对齐的最小集（纯函数输出） */
export const TRANSITION_ACTIONS = Object.freeze([
  'keep', 'stale', 'archive', 'reactivate', 'declining',
]);

// ── D4：数据来源黑名单（三处副本之一）─────────────────────────────────────
//
// Sprint14 §2.1：curriculum 的挑战执行会刻意重复工具调用，若不隔离：
//   - skill-autocreate 会把「做挑战」误判为可标准化重复模式 → 垃圾候选
//   - curator 会把挑战调用当成「技能被使用」→ 陈旧技能被误判为活跃
//
// 冗余是有意的：AGINT 存储域互斥，跨插件共享运行时常量会引入耦合，宁可
// 三处副本 + smoke 断言一致性（见 test/const-consistency.test.mjs）。
//
// Q2 已确认：tool-stats 记录字段固定为 { ts, sessionId, turn, step, tool,
// callId, latencyMs, ok, errorKind, argFingerprint, args }，**不支持自定义
// source 字段** → 采用 sessionId 前缀方案（D1 备选路径），同时保留
// sourceTags 以兼容未来 tool-stats 增补 source 字段。

export const EXCLUDED_DATA_SOURCES = Object.freeze({
  sessionIdPrefixes: Object.freeze(['curriculum-']),
  sourceTags: Object.freeze(['curriculum']),
});

/** 黑名单契约版本：任一处副本改动必须同步 bump，一致性测试断言三处相等 */
export const DATA_SOURCE_BLACKLIST_VERSION = '2026-09-14.v1';

/**
 * 判定一条 tool-stats 记录是否来自被排除的数据源。
 * 向后兼容：无 sessionId / 无 source 字段的旧记录 → false（照常处理）。
 */
export function isExcludedRecord(record) {
  if (!record || typeof record !== 'object') return false;
  const sid = record.sessionId;
  if (typeof sid === 'string' && sid) {
    for (const p of EXCLUDED_DATA_SOURCES.sessionIdPrefixes) {
      if (sid.startsWith(p)) return true;
    }
  }
  const src = record.source;
  if (typeof src === 'string' && src) {
    for (const t of EXCLUDED_DATA_SOURCES.sourceTags) {
      if (src === t) return true;
    }
  }
  return false;
}

// ── 自我评估禁止（P0-2 §9.4）─────────────────────────────────────────────

const SELF_PROTECT_RE = /curator|curation|策展/i;

/** 技能名命中策展关键词 → 自动进入 protected（防止策展优化策展） */
export function isSelfProtecting(skillName) {
  return SELF_PROTECT_RE.test(skillName ?? '');
}

// ── FROZEN data schema（P0-2 §4.2/§4.3/§4.5，阶段 1 裁剪版 + Sprint15 quality）─

export const UsageSchema = z.object({
  useCount: z.number().int().min(0).default(0),
  lastUsedAt: z.string().nullable().default(null),
  firstUsedAt: z.string().nullable().default(null),
  successRate: z.number().min(0).max(1).nullable().default(null),
  avgDurationMs: z.number().nullable().default(null),
  avgTokenCost: z.number().nullable().default(null), // tool-stats 暂无 token 计量，恒 null
});

export const QualitySnapshotSchema = z.object({
  week: z.string(),                          // ISO week，如 2026-W37
  successRate: z.number().nullable().default(null),
  useCount: z.number().int().min(0).default(0),
  harmDelta: z.number().nullable().default(null), // 当周 HARM 增量（有评估历史时）
});

export const QualitySchema = z.object({
  qualityState: z.enum(['declining', 'stable', 'unknown']).nullable().default(null),
  history: z.array(QualitySnapshotSchema).default([]), // 周快照，保留最近 8 周
  reviewSuggested: z.boolean().default(false),         // 规则 3 质量保护 → 人工审查建议
});

export const StateHistoryEntrySchema = z.object({
  from: z.enum(SKILL_STATES),
  to: z.enum(SKILL_STATES),
  at: z.string(),
  reason: z.string(),
  actor: z.string(),
});

export const SkillStateSchema = z.object({
  skillName: z.string().min(1),
  source: z.enum(ALL_SOURCES).default('manual'),
  sourcePlugin: z.string().nullable().default(null),
  category: z.string().default('general'),
  description: z.string().default(''),

  protected: z.boolean().default(false),      // 受保护内置技能（白名单/自保护）
  cronReferenced: z.boolean().default(false), // 被 cron job 引用 → 不归档但可 stale

  state: z.enum(SKILL_STATES).default('active'),
  stateChangedAt: z.string(),
  stateHistory: z.array(StateHistoryEntrySchema).default([]),

  usage: UsageSchema.default({}),
  quality: QualitySchema.default({}),          // Sprint 15：质量快照/趋势/review 标记

  archivedAt: z.string().nullable().default(null),
  archiveReason: z.string().nullable().default(null),
  curationNotes: z.string().default(''),
});

export const CurationActionSchema = z.object({
  timestamp: z.string(),
  actor: z.string().min(1), // "system" | "human:username"
  action: z.enum(CURATION_ACTIONS),
  skillName: z.string(),
  details: z.object({
    fromState: z.enum(SKILL_STATES).nullable().default(null),
    toState: z.enum(SKILL_STATES).nullable().default(null),
    reason: z.string().default(''),
    trigger: z.string().default(''),
    dryRun: z.boolean().default(false),
  }).default({}),
  result: z.enum(['success', 'failed', 'skipped']).default('success'),
  errorMessage: z.string().nullable().default(null),
});

export const OverlapCandidateSchema = z.object({
  skillA: z.string().min(1),
  skillB: z.string().min(1),
  dims: z.object({
    desc: z.number(), tools: z.number(), triggers: z.number(),
    descHit: z.boolean(), toolsHit: z.boolean(), triggersHit: z.boolean(),
    dimsMet: z.number().int().min(0).max(3),
  }),
  recommendation: z.object({
    keep: z.string().nullable().default(null),
    archive: z.string().nullable().default(null),
    rationale: z.string().default(''),
  }),
  status: z.enum(['proposed', 'acknowledged', 'resolved']).default('proposed'),
  detectedAt: z.string(),
});

export const DecliningSkillSchema = z.object({
  skillName: z.string().min(1),
  state: z.enum(SKILL_STATES),
  reason: z.string().default(''),
  successTrendState: z.string().nullable().default(null),
  harmTrendState: z.string().nullable().default(null),
});

export const CurationReportSchema = z.object({
  week: z.string().min(1), // ISO week，形如 2026-W37
  generatedAt: z.string(),
  trigger: z.string().default('weekly_curation'),
  dryRun: z.boolean().default(false),
  summary: z.object({
    totalSkillsChecked: z.number().int().min(0),
    newlyStale: z.number().int().min(0),
    newlyArchived: z.number().int().min(0),
    reactivated: z.number().int().min(0),
    newlyDeclining: z.number().int().min(0).default(0),   // Sprint 15
    overlapsDetected: z.number().int().min(0).default(0), // Sprint 15
    pinned: z.number().int().min(0),
    protected: z.number().int().min(0),
    skipped: z.number().int().min(0),
    byState: z.record(z.number()).default({}),
  }),
  archived: z.array(z.object({
    skillName: z.string(),
    reason: z.string(),
    lastUsedAt: z.string().nullable().default(null),
  })).default([]),
  staled: z.array(z.object({
    skillName: z.string(),
    reason: z.string(),
    lastUsedAt: z.string().nullable().default(null),
  })).default([]),
  reactivated: z.array(z.object({ skillName: z.string(), reason: z.string() })).default([]),
  declining: z.array(DecliningSkillSchema).default([]),   // Sprint 15 质量下降章节
  overlaps: z.array(z.object({                            // Sprint 15 重叠章节
    skillA: z.string(), skillB: z.string(), dimsMet: z.number().int(),
    keep: z.string().nullable().default(null),
    archive: z.string().nullable().default(null),
    rationale: z.string().default(''),
  })).default([]),
  recommendations: z.array(z.string()).default([]),
});

export const AuditLogSchema = z.object({
  timestamp: z.string(),
  actor: z.string().min(1),
  action: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string(),
  details: z.record(z.any()).default({}),
  reason: z.string().nullable().default(null),
});

// ── 配置（P0-2 §8.1，阶段 1 取用到的 + Sprint14 §3.4 新默认值 + Sprint15 质量/重叠）─

const defaultDshHome = () => (process.env.DSH_HOME || `${process.env.HOME ?? ''}/.dsh`);

export const ConfigSchema = z.object({
  // 状态转换阈值
  stale_after_days: z.number().int().min(1).default(30),
  archive_after_days: z.number().int().min(1).default(90),
  new_skill_protection_days: z.number().int().min(0).default(14), // Sprint14 §3.4 A-16
  reactivate_within_days: z.number().int().min(1).default(7),

  // 保护
  protected_skills: z.array(z.string()).default(['plan', 'memory-discipline', 'causal-reasoning']),
  self_protect_enabled: z.boolean().default(true),   // P0-2 §9.4 策展相关技能自保护
  cron_referenced_protection: z.boolean().default(true),
  // 被 cron job 引用的技能（人工声明）。自动探测见 index.js detectCronReferenced：
  // 当前 agint-cron 的 job 定义不声明技能字段，故该保护目前以人工声明为准。
  cron_referenced_skills: z.array(z.string()).default([]),

  // 预算（P0-2 §9.1 L2）
  weekly_archive_budget: z.number().int().min(1).default(10),

  // 质量评估（Sprint 15 P0-2 §7.2/§7.4）
  quality_snapshot_max_weeks: z.number().int().min(4).max(52).default(8),
  quality_trend_window_weeks: z.number().int().min(2).max(26).default(4),
  quality_success_decline_pct: z.number().min(0).max(1).default(0.10),
  quality_success_decline_streak: z.number().int().min(1).default(2),
  quality_harm_declining_count: z.number().int().min(1).default(2),
  quality_harm_review_delta: z.number().default(1.0),
  quality_protect_success_rate: z.number().min(0).max(1).default(0.8),
  quality_archive_after_days: z.number().int().min(1).default(60), // 规则 2 加速归档阈值

  // 重叠检测（Sprint 15 P0-2 §7.3）
  overlap_detection_enabled: z.boolean().default(true),
  overlap_desc_threshold: z.number().min(0).max(1).default(0.85),
  overlap_tools_threshold: z.number().min(0).max(1).default(0.7),
  overlap_triggers_threshold: z.number().min(0).max(1).default(0.6),
  overlap_min_dimensions: z.number().int().min(1).max(3).default(2),
  overlap_max_pairs: z.number().int().min(1).default(50), // 单周报告/事件上限

  // 执行
  auto_curation_enabled: z.boolean().default(true),
  dry_run_default: z.boolean().default(false),
  move_directory_on_archive: z.boolean().default(true),

  // 数据源
  skills_dir: z.string().default(() => `${defaultDshHome()}/.agent-presets/agint/skills`),
  archive_dir_name: z.string().default('.archive'),
  jsonlPath: z.string().default(() => `${defaultDshHome()}/storages/agint_tool_stats.jsonl`),
  usage_lookback_days: z.number().int().min(1).default(180),
  // 技能使用数据推断（开放问题「技能使用数据从哪来」选 C：先推断，
  // P0-1 上线后 tool-stats 带 skill 维度时自动切准确数据）
  usage_inference_enabled: z.boolean().default(true),
  usage_inference_min_tool_coverage: z.number().min(0).max(1).default(0.6),

  // 调度（agint-cron 侧读取，本插件仅透出）
  weekly_cron: z.string().default('0 2 * * 0'), // 周日 02:00，早于 evolve-review(03:45)
});

export const DEFAULT_CONFIG = Object.freeze(ConfigSchema.parse({}));

/** §8.2 运行时可配置子集（curator_config 允许改的字段） */
export const RUNTIME_CONFIG_KEYS = Object.freeze([
  'auto_curation_enabled',
  'weekly_archive_budget',
  'stale_after_days',
  'archive_after_days',
  'dry_run_default',
  'overlap_detection_enabled',
  'quality_archive_after_days',
]);
