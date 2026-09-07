/**
 * agint-curriculum: FROZEN schema + LIMITS + 配置默认值 + D4 数据源黑名单副本。
 *
 * 上游：
 *   - `Sprint14-设计稿.md` §4（Part B 完整设计）/ §5.2（B-1~B-10 拆分）
 *   - `agint-self-model` v0.7.1（A11 self.model.updated + snapshot() 权威数据）
 *   - `Sprint14-设计稿.md` §2.1（D1–D4 数据源隔离）
 *
 * 关键设计（§4.4 判定外部化）：
 *   - C1：挑战必须带**可自动判定的通过条件**；无法自动判定的域 → 不生成挑战，
 *         标记 unverifiable 并写周复盘（本插件通过 challenges.status='unverifiable'
 *         + boundary-probe 返回 unverifiable 域列表承载）。
 *   - C2：自评结果（evidence.selfAssessment）只存 notes，**不得**作为 pass/fail
 *         依据；capability status 由 self-model 侧决定（本插件只提供证据）。
 *   - C3：verdict 必须带 evidence；无 evidence → 记 fail，不记 pass。
 *
 * 红线：
 *   - 不改 A11 FROZEN payload（§4.2 方案 B：A11 只当触发器，数据走 snapshot()）。
 *   - 不自动执行挑战（§4.5：executor 只出队/分发，agent 真实参与后 submit）。
 *   - 不直接改 self-model capability 表（§4.9：判定权和写入权分离，只调
 *     self-model 自己的 update() 提供证据）。
 */

import { z } from 'zod';

// ── 上限（Sprint14 §4.7）────────────────────────────────────────────────

export const LIMITS = Object.freeze({
  CHALLENGES: 200,       // 超限 warn，不自动 prune
  ATTEMPTS: 500,         // 超限 warn
  DIFFICULTY_STATE: 100, // 每域一行，超限 warn
  AUDIT_LOG: 1000,       // 唯一自动滚动清理
});

// ── 挑战状态机（§4.3 模块 + §4.5 执行边界）───────────────────────────────

export const CHALLENGE_STATUSES = Object.freeze([
  'open',          // 生成后待领取
  'in_progress',   // 已出队，agent 执行中
  'passed',        // verdict pass（有 evidence）
  'failed',        // verdict fail（有 evidence / 无 evidence）
  'expired',       // 超时未提交（保留供追溯，不自动删除）
  'unverifiable',  // 域无模板 / 无法自动判定 → 不生成挑战（C1 的存储态）
]);

export const VERDICT_RESULTS = Object.freeze(['pass', 'fail']);

// ── 难度档（§4.3 [3] difficulty-ctl）─────────────────────────────────────

export const DIFFICULTY_LEVELS = Object.freeze(['D1', 'D2', 'D3', 'D4', 'D5']);

export const DIFFICULTY_INDEX = Object.freeze(
  DIFFICULTY_LEVELS.reduce((m, lv, i) => { m[lv] = i; return m; }, {}),
);

// ── 模板域（§5.2 B-3：4 个域模板）─────────────────────────────────────────

export const TEMPLATE_DOMAINS = Object.freeze([
  'codegen',
  'reasoning',
  'planning',
  'tool-use',
]);

// ── D4：数据来源黑名单副本（三处副本之一；curriculum 自己是来源）────────────
//
// Sprint14 §2.1：curriculum 的挑战执行会刻意重复工具调用，若不隔离：
//   - skill-autocreate 会把「做挑战」误判为可标准化重复模式 → 垃圾候选
//   - curator 会把挑战调用当成「技能被使用」→ 陈旧技能被误判为活跃
//
// curriculum 持副本是「以身作则」：它生成的挑战自带 sessionId 前缀，
// 下游按本常量过滤；同时保留 sourceTags 兼容未来 tool-stats 增补 source。
// 一致性由 const-consistency.test.mjs（自动扫描所有 plugins/*/lib/schema.js）断言。

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

// ── FROZEN data schema（Sprint14 §4.7 4 表）──────────────────────────────

export const ChallengeSchema = z.object({
  id: z.string().min(1),
  domain: z.string().min(1),
  templateType: z.enum(TEMPLATE_DOMAINS),
  level: z.enum(DIFFICULTY_LEVELS),
  status: z.enum(CHALLENGE_STATUSES).default('open'),

  // 给执行者看的挑战本体（§4.1/§4.3）
  prompt: z.string().min(1),
  passCriteria: z.string().min(1),          // 人类可读的通过标准（C1 外化）

  // 可自动判定的通过条件（C1 的机器侧：verdict 用 verifySpec 还原断言）
  verifySpec: z.object({
    type: z.enum(['exit-code-output', 'conclusion-match', 'step-list', 'tool-match']),
    expected: z.any().default(null),
    minLength: z.number().int().min(0).default(0),
  }),

  // 挑战执行隔离（D1：sessionId 前缀 curriculum-，下游按黑名单过滤）
  sessionId: z.string().min(1),

  createdAt: z.string(),
  updatedAt: z.string(),
  attemptCount: z.number().int().min(0).default(0),
});

export const AttemptSchema = z.object({
  id: z.string().min(1),
  challengeId: z.string().min(1),
  domain: z.string().min(1),
  templateType: z.enum(TEMPLATE_DOMAINS),
  level: z.enum(DIFFICULTY_LEVELS),
  result: z.enum(VERDICT_RESULTS),
  // C3：判定依据（产物路径 / 日志 / 断言输出；无 evidence → fail）
  evidence: z.record(z.any()).default({}),
  // C2：LLM 自评只进 notes，不进 result
  selfAssessment: z.string().nullable().default(null),
  reason: z.string().default(''),
  verifiedAt: z.string(),
});

export const DifficultyStateSchema = z.object({
  domain: z.string().min(1),
  level: z.enum(DIFFICULTY_LEVELS).default('D1'),
  // 滚动窗口内的判定结果（28 天；§4.6）
  windowResults: z.array(z.object({
    result: z.enum(VERDICT_RESULTS),
    at: z.string(),
  })).default([]),
  consecutivePass: z.number().int().min(0).default(0),
  consecutiveFail: z.number().int().min(0).default(0),
  // §4.6 连续 fail ≥ 3 → 标记 CANNOT 候选（供 self-model 复验）
  cannotCandidate: z.boolean().default(false),
  lastGeneratedAt: z.string().nullable().default(null),   // 同域 24h 冷却
  lastAdjustedAt: z.string().nullable().default(null),
});

export const AuditLogSchema = z.object({
  timestamp: z.string(),
  actor: z.string().min(1),          // "system" | "human:username" | "agent:xxx"
  action: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string(),
  details: z.record(z.any()).default({}),
  reason: z.string().nullable().default(null),
});

// ── 配置（§4.3/§4.6 + 7.1 风险缓解）───────────────────────────────────────

export const ConfigSchema = z.object({
  // boundary-probe（§4.3 [1]）
  stale_reverify_days: z.number().int().min(1).default(30),  // lastVerifiedAt 超 N 天未复验 → 待练

  // challenge-gen（§4.3 [2] + 7.1 防爆炸）
  generation_batch_limit: z.number().int().min(1).default(5), // 单轮生成上限
  challenge_cooldown_hours: z.number().int().min(0).default(24), // 同域 24h 冷却

  // difficulty-ctl（§4.6）
  difficulty_window_days: z.number().int().min(1).default(28),
  difficulty_min_samples: z.number().int().min(1).default(5),   // 样本 < 5 不调档
  pass_floor: z.number().min(0).max(1).default(0.40),           // < 40% 降档
  pass_ceiling: z.number().min(0).max(1).default(0.70),         // > 70% 升档
  force_promote_streak: z.number().int().min(1).default(3),     // 连续 pass ≥ 3 强制升档
  force_demote_streak: z.number().int().min(1).default(3),      // 连续 fail ≥ 3 降档 + CANNOT 候选

  // verdict（§4.4 C1/C2/C3）
  require_evidence: z.boolean().default(true),                  // 无 evidence → fail（C3）
  verdict_expires_days: z.number().int().min(1).default(30),    // 超时未提交 → expired

  // 执行边界（§4.5）
  auto_execute_enabled: z.boolean().default(false),             // Sprint 14 恒 false

  // self-model 回写（§4.9，软依赖）
  self_model_writeback: z.boolean().default(true),

  // 调度（透出给 agint-cron；本插件不自行定时）
  weekly_cron: z.string().default('0 3 * * 0'), // 周日 03:00，在 curator(02:00) 之后
});

export const DEFAULT_CONFIG = Object.freeze(ConfigSchema.parse({}));

/** 运行时可配置子集（内存态，重启还原；对齐 curator 惯例） */
export const RUNTIME_CONFIG_KEYS = Object.freeze([
  'generation_batch_limit',
  'challenge_cooldown_hours',
  'difficulty_window_days',
  'difficulty_min_samples',
  'pass_floor',
  'pass_ceiling',
  'force_promote_streak',
  'force_demote_streak',
  'require_evidence',
  'self_model_writeback',
]);

/** 模板域 → 模板描述（供工具/文档展示；实际模板见 challenge-gen.js） */
export const TEMPLATE_DESCRIPTIONS = Object.freeze({
  'codegen': '生成代码实现并运行验证（断言：exit code + 输出）',
  'reasoning': '推理题作答（断言：结论与预期匹配）',
  'planning': '任务拆解为步骤清单（断言：步骤数量 + 必需步骤）',
  'tool-use': '用指定工具完成任务（断言：工具命中 + 退出码）',
});
