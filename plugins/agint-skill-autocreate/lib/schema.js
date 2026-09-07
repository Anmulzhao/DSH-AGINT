/**
 * agint-skill-autocreate: FROZEN schema + LIMITS + 配置默认值。
 *
 * 设计稿 §4（数据结构）/ §8（配置项），版本 v0.1-draft（Sprint 14 检测层）。
 *
 * 红线：
 *   - 状态枚举 / LIMITS 与设计稿 §3.2 状态机、§4 表上限一一对应。
 *   - 自我评估禁止（§9.4）：技能名/描述含 autocreate/自动创建 关键词 → 候选
 *     生成阶段直接跳过（proposer.guardSelfReference），Phase 1 正式拦截在
 *     Sprint 15 由 agint-quality-static 落地。
 */

import { z } from 'zod';

// ── 上限（设计稿 §4.2–§4.5）─────────────────────────────────────────────

export const LIMITS = Object.freeze({
  TASK_PATTERNS: 500,   // 超限 warn，不自动 prune（策展人 P0-2 接手）
  CANDIDATES: 200,      // 超限 warn
  RELEASES: 100,        // 超限 warn（Sprint 16 使用）
  AUDIT_LOG: 1000,      // 超限自动滚动清理最旧的（唯一例外）
});

// ── 枚举（设计稿 §3.2 状态机 / §4.2 §4.3 §4.5）──────────────────────────

/** task_patterns.status（设计稿 §4.2） */
export const PATTERN_STATUSES = Object.freeze([
  'active', 'candidate', 'proposed', 'released', 'dismissed',
]);

/** candidates.status（设计稿 §3.2 / §4.3） */
export const CANDIDATE_STATUSES = Object.freeze([
  'PENDING_EVAL',
  'PHASE1_PASS', 'PHASE2_PASS', 'PHASE3_PASS',
  'REJECTED_STATIC', 'REJECTED_SANDBOX', 'REJECTED_EVAL',
  'QUEUED_FOR_RELEASE', 'BUDGET_WAIT',
  'RELEASED', 'STABLE', 'ROLLED_BACK',
]);

/** 可标准化的根因（设计稿 §3.1 [4]）—— Sprint 15 接 diagnosis 后由引擎填充 */
export const STANDARDIZABLE_ROOT_CAUSES = Object.freeze([
  'TOOL_GAP', 'KNOWLEDGE_GAP', 'PROMPT_DEFICIENCY',
]);

/** 不可标准化根因 → 标记「需人工判断」，写周复盘 */
export const NON_STANDARDIZABLE_ROOT_CAUSES = Object.freeze([
  'REASONING_ERROR', 'PLANNING_FAILURE', 'ENVIRONMENT_SHIFT', 'UNCERTAIN',
]);

// ── FROZEN data schema（设计稿 §4.2 / §4.3 / §4.5）──────────────────────

export const TaskPatternSchema = z.object({
  toolSequence: z.array(z.string().min(1)).min(1),
  paramSignature: z.record(z.string()),
  description: z.string().min(1),

  occurrenceCount: z.number().int().min(1),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  avgDurationMs: z.number().nullable().default(null),
  avgTokenCost: z.number().nullable().default(null), // tool-stats 暂无 token 数据，恒 null
  successRate: z.number().min(0).max(1),

  status: z.enum(PATTERN_STATUSES).default('active'),
  standardizable: z.boolean().nullable().default(null),
  standardizableConfidence: z.number().nullable().default(null),
  linkedCandidateId: z.string().nullable().default(null),
});

export const SkillDraftSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  category: z.string().default('productivity'),
  template: z.string().min(1),
  frontmatter: z.object({
    name: z.string(),
    description: z.string(),
    triggers: z.array(z.string()),
    tools: z.array(z.string()),
  }),
  body: z.string().min(1),
  references: z.array(z.string()).default([]),
  scripts: z.array(z.string()).default([]),
});

export const CandidateSchema = z.object({
  sourcePatternId: z.string().min(1),
  source: z.enum(['auto', 'manual']),
  triggerEvent: z.string().min(1),

  skillDraft: SkillDraftSchema,

  estimatedBenefit: z.object({
    successRateImprovement: z.number().min(0).max(1),
    timeSavingsPct: z.number().min(0).max(1),
    tokenSavingsPct: z.number().min(0).max(1),
    harmIncrementEstimate: z.number().min(0).max(1),
  }),

  status: z.enum(CANDIDATE_STATUSES).default('PENDING_EVAL'),
  evalResults: z.record(z.any()).default({}), // Sprint 15 填充 phase1/2/3
  rejectionReason: z.string().nullable().default(null),

  releasedAt: z.string().nullable().default(null),
  releasedVersion: z.string().nullable().default(null),
  rollbackReason: z.string().nullable().default(null),
});

export const AuditLogSchema = z.object({
  timestamp: z.string(),
  actor: z.string().min(1), // "system" | "human:username"
  action: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string(),
  details: z.record(z.any()).default({}),
  reason: z.string().nullable().default(null),
});

// ── 配置（设计稿 §8.1）───────────────────────────────────────────────────

export const ConfigSchema = z.object({
  // 检测阈值
  min_occurrence_count: z.number().int().min(2).default(3),
  param_similarity_threshold: z.number().min(0).max(1).default(0.8),
  min_standardizable_confidence: z.number().min(0).max(1).default(0.6),

  // 评估阈值（Sprint 15 使用，先冻结默认值）
  phase2_min_success_improvement: z.number().default(0.1),
  phase3_min_harm_increment: z.number().default(0.5),

  // ── Sprint 15 T1/T3/T4：评估层运行参数（设计稿 §7.3）────────────────────
  // Q2 拍板：E0（无可执行物 / 沙箱证据不足）也放行，provisional 标记留给
  // Sprint 16 观察期；phase3_evidence_gate 恒 'E0'（未来收紧改配置即可）
  phase3_evidence_gate: z.enum(['E0', 'E1']).default('E0'),
  // ABSTAIN / 未决后冷却天数（T4：冷却期内禁止重评）
  eval_cooldown_days: z.number().int().min(0).default(7),
  // 单候选最大评估尝试次数（超限转人工：保持 PENDING_EVAL + audit）
  max_eval_attempts: z.number().int().min(1).default(3),
  // staging 终态后 TTL 清理天数（设计稿 §5.1：7 天）
  staging_ttl_days: z.number().int().min(1).default(7),
  // Phase 2 沙箱超时（毫秒）
  sandbox_timeout_ms: z.number().int().min(1000).default(30000),

  // 发布预算（Sprint 16 使用）
  weekly_deploy_budget: z.number().int().min(1).default(3),
  observation_period_days: z.number().int().min(1).default(7),
  rollback_threshold: z.number().min(0).max(1).default(0.2),

  // 去重（Sprint 15 使用）
  dedup_similarity_threshold: z.number().default(0.9),

  // 调度（agint-cron 侧读取，本插件仅透出）
  aggregate_cron: z.string().default('45 4 * * *'),

  // 安全
  auto_create_enabled: z.boolean().default(true),
  require_human_approval: z.boolean().default(false),
  dangerous_tools_blocklist: z.array(z.string()).default(['terminal:rm -rf', 'terminal:dd']),

  // 数据源（tool-stats JSONL，与 agint-tool-stats 默认值一致）
  jsonlPath: z.string().default(
    () => (process.env.DSH_HOME || (process.env.HOME + '/.dsh')) + '/storages/agint_tool_stats.jsonl',
  ),
  aggregate_window_hours: z.number().int().min(1).default(24),
});

export const DEFAULT_CONFIG = Object.freeze(ConfigSchema.parse({}));

/** §8.2 运行时可配置子集（autocreate_config 工具允许改的字段） */
export const RUNTIME_CONFIG_KEYS = Object.freeze([
  'auto_create_enabled',
  'weekly_deploy_budget',
  'min_occurrence_count',
  'require_human_approval',
]);

// ── D4：数据来源黑名单（三处副本之一）─────────────────────────────────────
//
// Sprint14 §2.1 D2：curriculum 的挑战执行是「同一类任务反复练」，天然命中
// 本插件的「工具序列全等 + 累计 ≥3 次」判定。不过滤的话 Sprint 14 结束后
// 会开始批量产出「做挑战」的垃圾技能候选。
//
// 判定优先 sessionId 前缀（tool-stats 记录**不支持**自定义 source 字段，
// 已确认）；若未来 tool-stats 增补 source 字段，sourceTags 分支自动生效。
//
// 冗余是有意的：AGINT 存储域互斥，不建共享模块；一致性由
// plugins/agint-curator/test/const-consistency.test.mjs 自动扫描断言。
// 改动任一副本 → 必须同步三处 + bump DATA_SOURCE_BLACKLIST_VERSION。

export const EXCLUDED_DATA_SOURCES = Object.freeze({
  sessionIdPrefixes: Object.freeze(['curriculum-']),
  sourceTags: Object.freeze(['curriculum']),
});

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

// ── 自我评估禁止（设计稿 §9.4）───────────────────────────────────────────

const SELF_REF_RE = /autocreate|auto-create|自动创建|skill-autocreate/i;

/** 技能草稿名/描述命中自我指涉关键词 → true（不得生成候选，防递归自改） */
export function isSelfReferential(skillName, description) {
  return SELF_REF_RE.test(skillName ?? '') || SELF_REF_RE.test(description ?? '');
}
