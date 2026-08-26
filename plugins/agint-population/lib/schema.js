/**
 * agint-population v0.6.2 — FROZEN schema definitions.
 *
 * 设计稿 `AGINT.wiki/Sprint9-设计稿.md` §二.2 / §四.2 / §五.1 / §六 落地。
 *
 * FROZEN schema（不要改字段名 / 不要改 enum 顺序；改动走 L0 治理）：
 *   - StageSchema              enum 11 值（状态机全集）
 *   - MutationKindSchema       enum 3 值（继承 mutator）
 *   - MutationSourceSchema     enum 3 值（继承 mutator）
 *   - PolicyDecisionSchema     enum 4 值（继承 quality-policy）
 *   - TrafficReasonSchema      enum 7 值（traffic_log 变更原因）
 *   - ExpectedEffectSchema     { metric, direction, window }
 *   - RollbackConditionSchema  { trigger }
 *   - FitnessDimensionsSchema  6 维原始 + 归一化 + HARM 4 维映射
 *   - VariantSchema            主表（含 parent_variant_id 谱系树 + fitness_detail）
 *   - FitnessHistorySchema     历史表
 *   - TrafficLogSchema         流量变更日志
 *   - GenerationLogSchema      世代日志
 *
 * 上限（设计稿 §二.2）：
 *   variants 100 / fitness_history 500 / traffic_log 500 / generation_log 50
 *
 * 设计原则（设计稿 §六 + AGENTS.md）：
 *   - 简洁 > 冗余：单插件 lib 净增 ≤ 400 行
 *   - 安全 > 效率：safety 维度权重 0.30 + safety<0.5 硬门控（fitness.js 落地）
 *   - 真实 > 讨好：FROZEN 字段 + L0 治理
 *   - 主动 > 被动：必填字段缺则抛错，不静默跳过
 */

import { z } from 'zod';

// ── FROZEN enums ─────────────────────────────────────────────────────────

/**
 * StageSchema（FROZEN，11 值枚举 — 设计稿 §六 状态机）。
 *   终态：REJECTED / FIXED / CULLED / ROLLED_BACK
 *   入口：PENDING_REVIEW
 *   阶梯：NEW → OBSERVING → PROMOTING → EXPANDING → FULL
 *   旁路：FROZEN_OBSERVE（D10 修订）
 */
export const StageSchema = z.enum([
  'PENDING_REVIEW',  // Policy Gate pending；traffic=0
  'REJECTED',        // Policy Gate reject；终态
  'NEW',             // 阶梯 1: 1% 流量
  'OBSERVING',       // 阶梯 2: 5%
  'PROMOTING',       // 阶梯 3: 20%
  'EXPANDING',       // 阶梯 4: 50%
  'FULL',            // 阶梯 5: 100%（Fixate 候选）
  'FIXED',           // 已固化 → 新 baseline；终态
  'FROZEN_OBSERVE',  // 同 scope 其余变体；1 世代观察（D10）
  'CULLED',          // 淘汰；终态（已 rollback）
  'ROLLED_BACK',     // 紧急回滚；终态（已 rollback）
]);
export const STAGES = Object.freeze([
  'PENDING_REVIEW', 'REJECTED', 'NEW', 'OBSERVING', 'PROMOTING',
  'EXPANDING', 'FULL', 'FIXED', 'FROZEN_OBSERVE', 'CULLED', 'ROLLED_BACK',
]);

/** 终态判定（fixate/cull/rollback 后不再流转）。 */
export const TERMINAL_STAGES = Object.freeze(new Set(['REJECTED', 'FIXED', 'CULLED', 'ROLLED_BACK']));
export function isTerminalStage(stage) {
  return TERMINAL_STAGES.has(stage);
}

/**
 * MutationKindSchema（FROZEN，3 值 — 继承 mutator 决策 D2 精简）。
 */
export const MutationKindSchema = z.enum(['PROMPT_MUTATION', 'TOOL_SYNTHESIS', 'STRATEGY_REWRITE']);
export const MUTATION_KINDS = Object.freeze(['PROMPT_MUTATION', 'TOOL_SYNTHESIS', 'STRATEGY_REWRITE']);

/**
 * MutationSourceSchema（FROZEN，3 值 — 继承 mutator §二.3）。
 */
export const MutationSourceSchema = z.enum(['attribution-driven', 'dream-random', 'evolution-reversed']);
export const MUTATION_SOURCES = Object.freeze(['attribution-driven', 'dream-random', 'evolution-reversed']);

/**
 * PolicyDecisionSchema（FROZEN，4 值 — 继承 quality-policy）。
 */
export const PolicyDecisionSchema = z.enum(['AUTO_DEPLOY', 'PENDING_REVIEW', 'REJECT', 'ABSTAIN']);
export const POLICY_DECISIONS = Object.freeze(['AUTO_DEPLOY', 'PENDING_REVIEW', 'REJECT', 'ABSTAIN']);

/**
 * TrafficReasonSchema（FROZEN，7 值 — traffic_log reason 字段）。
 */
export const TrafficReasonSchema = z.enum(['INGEST', 'PROMOTE', 'DEMOTE', 'ROLLBACK', 'FIXATE', 'CULL', 'FREEZE']);
export const TRAFFIC_REASONS = Object.freeze(['INGEST', 'PROMOTE', 'DEMOTE', 'ROLLBACK', 'FIXATE', 'CULL', 'FREEZE']);

// ── FROZEN 嵌套 schema ─────────────────────────────────────────────────────────

/** ExpectedEffectSchema — Ingest 前置校验非空（含 metric + direction + window）。 */
export const ExpectedEffectSchema = z.object({
  metric: z.string().min(1),       // 例: 'success_rate' / 'error_rate'
  direction: z.enum(['increase', 'decrease']),
  window: z.string().min(1),       // 例: '7d'
});

/** RollbackConditionSchema — Ingest 前置校验非空（含 trigger；禁止空字符串/主观词）。 */
export const RollbackConditionSchema = z.object({
  trigger: z.string().min(3),      // 例: 'harm >10% → rollback'
});

/**
 * FitnessDimensionsSchema — 6 维原始指标 + 归一化得分 + HARM 4 维映射。
 * 字段语义：
 *   raw       — 6 维原始观测（来自 metrics）
 *   normalized — 6 维归一化得分 ∈ [0,1]
 *   weights   — 6 维权重（含 user_satisfaction 缺失时重分配）
 *   gates     — 6 维健康门控（不达标 → 该维归零；任一触发 → 整体乘 0）
 *   harm      — { H, A, R, M } 四维映射（与 v0.4 HARM 报告链路对齐）
 */
export const FitnessDimensionsSchema = z.object({
  raw: z.object({
    success_rate: z.number().min(0).max(1),
    error_rate: z.number().min(0).max(1),
    latency_p99: z.number().min(0),
    token_cost: z.number().min(0),
    safety_violations: z.number().int().min(0),
    user_satisfaction: z.number().min(0).max(5).nullable(),
    sample_count: z.number().int().min(0),
  }),
  normalized: z.object({
    success_rate: z.number().min(0).max(1),
    error_rate: z.number().min(0).max(1),
    latency_p99: z.number().min(0).max(1),
    token_cost: z.number().min(0).max(1),
    safety: z.number().min(0).max(1),
    user_satisfaction: z.number().min(0).max(1),
  }),
  weights: z.record(z.string(), z.number().min(0).max(1)),
  gates: z.record(z.string(), z.boolean()),
  harm: z.object({
    H: z.number().min(0).max(1),
    A: z.number().min(0).max(1),
    R: z.number().min(0).max(1),
    M: z.number().min(0).max(1),
  }),
});

// ── FROZEN 主表 schemas（设计稿 §二.2） ─────────────────────────────────────────

/**
 * VariantSchema（FROZEN）— variants 主表。
 * 关键字段：
 *   parent_variant_id  谱系树父节点；baseline 直接变异 → null
 *   expected_effect / rollback_condition 从 mutator 继承，Ingest 校验非空
 *   fitness_detail 含 HARM 4 维（合并原 fitness_history.dimensions，消除双写）
 */
export const VariantSchema = z.object({
  variant_id: z.string().min(1),
  commit_id: z.string().min(1),
  parent_variant_id: z.string().min(1).nullable(),
  mutation_kind: MutationKindSchema,
  source: MutationSourceSchema,
  atomic_scope: z.string().min(1),                 // 例: 'prompt' / 'tool' / 'strategy'
  payload: z.unknown(),                             // 形态由 MutationPayloadSchema 二次校验
  expected_effect: ExpectedEffectSchema,
  rollback_condition: RollbackConditionSchema,
  policy_decision: PolicyDecisionSchema,
  stage: StageSchema,
  traffic_pct: z.number().min(0).max(100),
  fitness_score: z.number().min(0).max(1),
  fitness_detail: FitnessDimensionsSchema.nullable(),
  generation: z.number().int().min(0),
  consecutive_pass: z.number().int().min(0),
  created_at: z.string(),
  updated_at: z.string(),
  fixed_at: z.string().nullable(),
  culled_at: z.string().nullable(),
  rolled_back_at: z.string().nullable(),
  frozen_at: z.string().nullable(),
  safety_violations_total: z.number().int().min(0).default(0),
});

/**
 * FitnessHistorySchema（FROZEN）— 适应度历史。
 * dimensions 字段含完整 6 维 + HARM 4 维映射（与 variants.fitness_detail 同形）。
 */
export const FitnessHistorySchema = z.object({
  variant_id: z.string().min(1),
  generation: z.number().int().min(0),
  score: z.number().min(0).max(1),
  dimensions: FitnessDimensionsSchema,
  sample_count: z.number().int().min(0),
  evaluated_at: z.string(),
});

/**
 * TrafficLogSchema（FROZEN）— 流量变更日志。
 */
export const TrafficLogSchema = z.object({
  variant_id: z.string().min(1),
  from_pct: z.number().min(0).max(100),
  to_pct: z.number().min(0).max(100),
  reason: TrafficReasonSchema,
  trigger: z.unknown(),                             // 触发原因详情（自由结构）
  changed_at: z.string(),
});

/**
 * GenerationLogSchema（FROZEN）— 世代日志。
 */
export const GenerationLogSchema = z.object({
  generation: z.number().int().min(0),
  active_count: z.number().int().min(0),
  culled_count: z.number().int().min(0),
  fixed_count: z.number().int().min(0),
  avg_fitness: z.number().min(0).max(1),
  created_at: z.string(),
});

// ── 上限常量（设计稿 §二.2） ─────────────────────────────────────────────────────────

export const LIMITS = Object.freeze({
  VARIANTS: 100,
  FITNESS_HISTORY: 500,
  TRAFFIC_LOG: 500,
  GENERATION_LOG: 50,
});

// ── helpers ─────────────────────────────────────────────────────────

/** 默认配置（设计稿 §十，13 项；起步 N=3 阶段）。 */
export const DEFAULT_CONFIG = Object.freeze({
  capacity: 3,                          // 起步 N=3 → 放宽至 N=20（D3）
  generation_interval_days: 7,
  elite_k: 1,                           // 起步 K=1 → 放宽至 K=3
  cull_m: 1,                            // 起步 M=1 → 放宽至 M=3
  cull_threshold: 0.3,
  fixation_periods: 3,
  min_samples: 50,
  baseline_min_traffic: 20,
  same_scope_max: 3,
  review_timeout_hours: 72,
  min_random_ratio: 0.20,               // dream-random 来源占比下限（张力平衡护栏）
  global_rollback_threshold: 0.5,       // 种群 avg fitness 低于此值 → 全量回滚
  frozen_observe_generations: 1,        // D10
  frozen_observe_ratio: 0.9,            // D10
});

/** 阶梯流量配置（设计稿 §五.1）。 */
export const STAGE_LADDER = Object.freeze([
  { stage: 'NEW', traffic: 1, min_observation_hours: 24, fitness_threshold: 0.5, consec_required: 0 },
  { stage: 'OBSERVING', traffic: 5, min_observation_hours: 48, fitness_threshold: 0.6, consec_required: 1 },
  { stage: 'PROMOTING', traffic: 20, min_observation_hours: 72, fitness_threshold: 0.7, consec_required: 2 },
  { stage: 'EXPANDING', traffic: 50, min_observation_hours: 72, fitness_threshold: 0.75, consec_required: 2 },
  { stage: 'FULL', traffic: 100, min_observation_hours: 72, fitness_threshold: 0.8, consec_required: 3 },
]);

/** 校验一个对象是否是合法 Variant；返回 boolean 而非抛错。 */
export function isVariant(value) {
  return VariantSchema.safeParse(value).success;
}

/** 给定 stage，返回下一阶段阶梯配置（null = 已是 FULL）。 */
export function nextStageConfig(stage) {
  const idx = STAGE_LADDER.findIndex((s) => s.stage === stage);
  if (idx < 0 || idx >= STAGE_LADDER.length - 1) return null;
  return STAGE_LADDER[idx + 1];
}
