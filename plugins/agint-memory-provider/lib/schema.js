/**
 * agint-memory-provider: FROZEN schema + LIMITS + 配置默认值。
 *
 * 设计稿 §4（数据结构）/ §8（配置项），版本 v0.1-draft（Sprint 15 基础抽象层）。
 *
 * 红线：
 *   - LIMITS 与设计稿 §4.2–§4.6 表上限一一对应。
 *   - 单外部 provider 限制（§9.1 L0）：一次只能激活一个外部 provider。
 *   - 自我评估禁止（§9.3）：本插件不自动切换 provider、不自动改配置；
 *     provider 选择与配置由人工决定。
 */

import { z } from 'zod';

// ── 上限（设计稿 §4.2–§4.6）─────────────────────────────────────────────

export const LIMITS = Object.freeze({
  PROVIDER_CONFIG: 20,              // 每个 provider 一条；超限 warn
  ACTIVATION_LOG: 1000,             // 超限滚动清理最旧的
  FALLBACK_EVENTS: 5000,            // 超限滚动清理最旧的（Sprint 16 写入）
  PRE_COMPRESS_CHECKPOINTS: 500,    // 超限 warn（Sprint 16 写入）
  AUDIT_LOG: 1000,                  // 超限滚动清理最旧的
});

/** 超限自动滚动清理最旧记录的表（其余仅 warn，不 prune） */
export const ROLLING_TABLES = Object.freeze([
  'activation_log',
  'fallback_events',
  'audit_log',
]);

// ── 枚举（设计稿 §4.3 / §4.4 / §4.5）────────────────────────────────────

/** activation_log.action（§4.3） */
export const ACTIVATION_ACTIONS = Object.freeze([
  'activate', 'deactivate', 'fallback', 'recover',
]);

/** provider_config.validationResult（§4.2） */
export const VALIDATION_RESULTS = Object.freeze([
  'available', 'unavailable', 'error',
]);

/** fallback_events.operation（§4.4）—— Sprint 16 写入，先冻结枚举 */
export const FALLBACK_OPERATIONS = Object.freeze([
  'prefetch', 'sync_turn', 'handle_tool_call', 'on_pre_compress',
]);

/** fallback_events.errorType（§4.4） */
export const FALLBACK_ERROR_TYPES = Object.freeze([
  'network', 'timeout', 'rate_limit', 'auth', 'unknown',
]);

/** fallback_events.recoveryAction（§4.4） */
export const RECOVERY_ACTIONS = Object.freeze([
  'fallback_to_builtin', 'retry', 'switch_provider',
]);

/** pre_compress_checkpoints.checkpointStatus（§4.5） */
export const CHECKPOINT_STATUSES = Object.freeze([
  'success', 'failed', 'skipped', 'best_effort',
]);

/** 内置 provider 名（§9.1 L0：始终可用，不可被卸载） */
export const BUILTIN_PROVIDER = 'builtin';

// ── FROZEN data schema（设计稿 §4.2 / §4.3 / §4.5 / §4.6）───────────────

export const ProviderConfigSchema = z.object({
  providerName: z.string().min(1),
  updatedAt: z.string(),

  // 非敏感配置（§4.2）
  config: z.record(z.any()).default({}),

  // 敏感配置只记 env var 名，不存实际值（§9.1 L2 数据安全）
  secrets: z.record(z.string()).default({}),

  isConfigured: z.boolean().default(false),
  lastValidatedAt: z.string().nullable().default(null),
  validationResult: z.enum(VALIDATION_RESULTS).nullable().default(null),
});

export const ActivationLogSchema = z.object({
  timestamp: z.string(),
  action: z.enum(ACTIVATION_ACTIONS),
  providerName: z.string().min(1),
  // fallback 时记录降级到哪个 provider（§4.3）
  targetProvider: z.string().nullable().default(null),
  reason: z.string().default(''),
  sessionId: z.string().nullable().default(null),
  details: z.record(z.any()).default({}),
});

// fallback_events / pre_compress_checkpoints：Sprint 16 写入，schema 按设计稿
// §4.4 / §4.5 预置（避免后续 schemaVersion 破环性变更，与 skill-autocreate
// 预置 proposals/releases 同策略）。
export const FallbackEventSchema = z.object({
  timestamp: z.string(),
  providerName: z.string().min(1),
  operation: z.enum(FALLBACK_OPERATIONS),
  errorType: z.enum(FALLBACK_ERROR_TYPES).default('unknown'),
  errorMessage: z.string().default(''),
  sessionId: z.string().nullable().default(null),
  turnNumber: z.number().int().nullable().default(null),
  recovered: z.boolean().default(false),
  recoveryAction: z.enum(RECOVERY_ACTIONS).nullable().default(null),
});

export const PreCompressCheckpointSchema = z.object({
  timestamp: z.string(),
  providerName: z.string().min(1),
  sessionId: z.string().nullable().default(null),
  apiVersion: z.number().int().min(1).default(1),
  messagesCompressed: z.number().int().min(0).default(0),
  insightLength: z.number().int().min(0).default(0),
  checkpointStatus: z.enum(CHECKPOINT_STATUSES).default('best_effort'),
  errorMessage: z.string().nullable().default(null),
  durationMs: z.number().int().min(0).default(0),
});

export const AuditLogSchema = z.object({
  timestamp: z.string(),
  actor: z.string().min(1),        // "system" | "human:username"
  action: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string(),
  details: z.record(z.any()).default({}),
  reason: z.string().nullable().default(null),
});

// ── 配置（设计稿 §8.1）───────────────────────────────────────────────────

export const ConfigSchema = z.object({
  // Provider 选择
  active_provider: z.string().default(BUILTIN_PROVIDER),

  // 降级策略（Sprint 16 使用，先冻结默认值）
  fallback_enabled: z.boolean().default(true),
  max_consecutive_failures: z.number().int().min(1).default(3),
  failure_window_minutes: z.number().int().min(1).default(60),
  auto_recover_after_minutes: z.number().int().min(0).default(30),

  // 召回
  prefetch_enabled: z.boolean().default(true),
  prefetch_timeout_ms: z.number().int().min(100).default(3000),
  trivial_prompt_filter_enabled: z.boolean().default(true),
  recall_indicator_enabled: z.boolean().default(true),
  // builtin prefetch 召回条数上限（§11.5：builtin prefetch ≤ 50ms）
  builtin_recall_limit: z.number().int().min(1).default(8),
  // builtin prefetch 命中后是否调用 memory.recall(id) 写回 recalls/lastRecall。
  // 默认 false：写回会改变 decay.js 的陈旧度判定（lastRecall 是降级依据），
  // 违反 §12.1 验收标准「行为与现有 agint-memory 完全一致 / 不影响现有记忆
  // 数据」。现有 memory_search 工具同样只读不写回。是否开启由人工决定。
  builtin_recall_touch: z.boolean().default(false),

  // pre_compress（Sprint 16 使用）
  pre_compress_checkpoint_enabled: z.boolean().default(true),
  pre_compress_fail_closed: z.boolean().default(true),

  // 同步（Sprint 16 使用队列）
  sync_turn_enabled: z.boolean().default(true),
  sync_turn_queue_size: z.number().int().min(1).default(100),
  sync_turn_flush_on_shutdown: z.boolean().default(true),

  // 工具（Sprint 16 动态注册）
  external_provider_tools_enabled: z.boolean().default(true),
  external_tool_prefix: z.string().default(''),

  // 安全（§9.1 L3）
  require_human_approval_switch: z.boolean().default(true),
  log_sensitive_data: z.boolean().default(false),

  // 调试
  debug_mode: z.boolean().default(false),
});

export const DEFAULT_CONFIG = Object.freeze(ConfigSchema.parse({}));

/** §8.2 运行时可配置子集（memory_provider_config_set 工具允许改的字段） */
export const RUNTIME_CONFIG_KEYS = Object.freeze([
  'active_provider',
  'prefetch_enabled',
  'trivial_prompt_filter_enabled',
  'fallback_enabled',
  'max_consecutive_failures',
  'debug_mode',
]);
