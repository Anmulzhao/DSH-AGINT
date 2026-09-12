/**
 * agint-compress-guard: FROZEN 常量 / 枚举 / 记录 schema / 配置（P3-1 设计稿 §3.1 / §4.3）。
 *
 * 设计稿 v0.3 要点回写：
 *   - 洞察层是**增益层**，不是 M4 的必要条件（Hermes 对照，§〇ter）——M4 的最低
 *     达成口径是「被压缩原文存在一条可用的检索路径」。
 *   - 接线梯子降为两档：B（session/event 过滤 compaction/*，唯一主战场）/
 *     C（显式 checkpoint() 兜底）。A 档（继承 BasicCompactionEngine）已移出设计。
 *   - 两段式 fail-closed（Q2）：检查点写入失败 → 硬门（BLOCKED）；洞察提取失败
 *     → 软降级（DEGRADED_INSIGHT），不中止压缩。
 *   - 降级态必须可恢复（不变量 8）：连续失败降级满 recoveryProbeMs 后放行一次
 *     探针级检查点，成功则复位（Hermes「跳闸 → 300s 冷却 → 探针 → 计数降 1」）。
 *
 * 事件名核实（不变量 7，2026-09-13 grep 实证）：
 *   - 订阅 `memory.pre-compress-checkpoint` / `memory.provider-activated`：
 *     plugins/agint-memory-provider/lib/manager.js 发布，全库命中。
 *   - B 档 `compaction/start|summary|end|prune`：宿主
 *     @deepseek-ai/dsh-session/lib/types/known-event-types.js + dsh-compaction-basic
 *     lib/index.js（session.append("compaction/summary", { compactionId,
 *     shadowedRange, shadowedSeqs, shadowedTokenCount, ... })）。
 *   - `session/event` post-commit feed：dsh-compaction-basic/lib/index.js
 *     `ctx.on("session/event", (session, event) => ...)` 同款用法。
 */

import { join } from 'node:path';
import { z } from 'zod';

// ── 枚举（FROZEN v0.1.0）─────────────────────────────────────────────────

/** 洞察三类型（设计稿 §1.3；Q1：规则版起步，LLM 默认关） */
export const INSIGHT_TYPES = Object.freeze(['decision', 'fact', 'preference']);

/** 保留策略：preference 默认 highRetention，prune 不删（§3.1） */
export const RETENTION_LEVELS = Object.freeze(['normal', 'highRetention']);

/** 双 id 空间（v0.2 修正，§3.1）：pcc_* ← P1-1；compactionId ← 宿主 */
export const CHECKPOINT_REF_KINDS = Object.freeze(['p1-checkpoint', 'host-compaction']);

/** 接线档位（§5.3）。A 档已从设计移出，枚举保留仅为 guard_log 审计完整性；
 *  本插件**永不产出** tier='A' 的行（测试断言）。 */
export const GUARD_TIERS = Object.freeze(['A', 'B', 'C']);

/** guard_log 状态机（§3.2 两段式 fail-closed + 零数据显式态） */
export const GUARD_STATUSES = Object.freeze([
  'PASSED', 'DEGRADED_INSIGHT', 'BLOCKED_CHECKPOINT', 'NO_SOURCE_REACHED',
]);

/** 提取器版本（§3.1；v0.1 恒 rule-v1） */
export const EXTRACTOR_VERSIONS = Object.freeze(['rule-v1', 'llm-v1']);

// ── 事件 topic（发布 / 订阅，全部已 grep 核实）───────────────────────────

/** 本插件发布（§5.2）。blocked 是告警级事件，周报必现。 */
export const TOPICS_PUBLISHED = Object.freeze([
  'compress-guard.blocked',
  'compress-guard.checkpointed',
]);

/** 本插件订阅（§5.1）。真名以 memory-provider manager.js 为准。 */
export const TOPICS_SUBSCRIBED = Object.freeze([
  'memory.pre-compress-checkpoint',
  'memory.provider-activated',
]);

/** B 档监听的宿主会话事件（known-event-types.js 已核实） */
export const SESSION_COMPACTION_EVENTS = Object.freeze([
  'compaction/start', 'compaction/summary', 'compaction/end', 'compaction/prune',
]);

// ── 上限（§3.1 / storage 滚动清理）────────────────────────────────────────

export const LIMITS = Object.freeze({
  /** 洞察条数上限（只增不改 + supersededBy，超限仅 warn 不自动删） */
  INSIGHTS: 5000,
  /** guard_log 滚动清理上限 */
  GUARD_LOG: 2000,
  /** 洞察正文上限（字节） */
  INSIGHT_CONTENT_BYTES: 2048,
  /** 每次压缩最多提取条数（防提取风暴；config.maxInsightsPerCompress 默认同值） */
  MAX_INSIGHTS_PER_COMPRESS: 20,
});

export const ROLLING_TABLES = Object.freeze(['guard_log']);

/** 恢复探测冷却（不变量 8；对齐 Hermes 300s，§〇ter 第 5 条） */
export const RECOVERY_PROBE_MS_DEFAULT = 300_000;
/** 提取软超时（§3.2 [2]） */
export const EXTRACT_TIMEOUT_MS_DEFAULT = 3_000;
/** 兜底防重复 LRU 容量（§6.2 单次不回写） */
export const FALLBACK_LRU_SIZE = 100;

// ── 记录 schema ──────────────────────────────────────────────────────────

/** 洞察来源引用（§3.1 source）。checkpointRef 必填；id 在 linkPending 期间可为 null。 */
export const CheckpointRefSchema = z.object({
  kind: z.enum(CHECKPOINT_REF_KINDS),
  id: z.string().min(1).nullable(),
  shadowedSeqs: z.array(z.number().int()).optional(),
  shadowedTokenCount: z.number().int().nonnegative().optional(),
  sessionId: z.string().min(1).nullable().optional(),
  trajectoryId: z.string().min(1).nullable().optional(),
  rawOffset: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).optional(),
  extractedAt: z.string().min(1),
  extractor: z.enum(EXTRACTOR_VERSIONS),
});

export const InsightSourceSchema = z.object({
  checkpointRef: CheckpointRefSchema,
});

export const InsightSchema = z.object({
  type: z.enum(INSIGHT_TYPES),
  content: z.string().min(1),
  source: InsightSourceSchema,
  retention: z.enum(RETENTION_LEVELS),
  recallCount: z.number().int().nonnegative(),
  lastRecalledAt: z.string().nullable(),
  supersededBy: z.string().nullable(),
  /** P1-1 路径载荷缺口（§5.1）：onPreCompress 时拿不到 checkpointId，先以
   *  linkPending=true 落库，等事件回填；search 默认排除 pending。 */
  linkPending: z.boolean(),
});

export const GuardLogSchema = z.object({
  checkpointRef: z.object({ kind: z.enum(CHECKPOINT_REF_KINDS), id: z.string().nullable() }),
  tier: z.enum(GUARD_TIERS),
  status: z.enum(GUARD_STATUSES),
  insightsExtracted: z.number().int().nonnegative(),
  rawBytes: z.number().int().nonnegative(),
  startedAt: z.string().min(1),
  endedAt: z.string().min(1),
  /** 诚实备注：shadow 降级 / 降级原因 / 探针复位等，不塞进 status 枚举 */
  note: z.string().nullable(),
});

export const CountersSchema = z.object({
  extractFailures: z.number().int().nonnegative(),
  checkpointWriteFailures: z.number().int().nonnegative(),
  recallMisses: z.number().int().nonnegative(),
  recallHits: z.number().int().nonnegative(),
  p1CheckpointsSeen: z.number().int().nonnegative(),
  hostCompactionsSeen: z.number().int().nonnegative(),
  disabledPassThrough: z.number().int().nonnegative(),
  blockedShadowed: z.number().int().nonnegative(),
  recoveryProbes: z.number().int().nonnegative(),
});

export const ConfigRecordSchema = z.object({
  enabled: z.boolean(),
  shadowMode: z.boolean(),
  llmExtractEnabled: z.boolean(),
  maxInsightsPerCompress: z.number().int().min(1).max(100),
  fallbackEnabled: z.boolean(),
});

// ── 插件配置（manifest config 经 ConfigSchema.parse）────────────────────

export const ConfigSchema = z.object({
  /** 全局熔断（默认 true） */
  enabled: z.boolean().default(true),
  /** shadow 观察档（设计稿 §七挂载策略）：BLOCKED 降级为「记录告警不真中止」，
   *  观察一周误触发率后由老板拍板转硬门。默认 true。 */
  shadowMode: z.boolean().default(true),
  /** Q1 开关（默认 false；Sprint 21 单独拍板） */
  llmExtractEnabled: z.boolean().default(false),
  maxInsightsPerCompress: z.number().int().min(1).max(100).default(LIMITS.MAX_INSIGHTS_PER_COMPRESS),
  /** §6.2 检索兜底默认开启；enabled=false 时一并关闭 */
  fallbackEnabled: z.boolean().default(true),
  extractTimeoutMs: z.number().int().min(100).default(EXTRACT_TIMEOUT_MS_DEFAULT),
  recoveryProbeMs: z.number().int().min(1000).default(RECOVERY_PROBE_MS_DEFAULT),
  /** dsh 会话根目录（session-reader 用；跨平台 path.join，无写死盘符） */
  sessionsRoot: z.string().min(1).default(() => {
    const home = process.env.DSH_HOME || (process.env.HOME + '/.dsh');
    return join(home, 'sessions');
  }),
  debug_mode: z.boolean().default(false),
});

// ── 小工具 ───────────────────────────────────────────────────────────────

export function nowIso() {
  return new Date().toISOString();
}

/** 日期前缀 id：<prefix>_YYYYMMDD_<6 位随机>（与 P1-1 datedId('pcc') 同风格） */
export function datedId(prefix) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const c = globalThis.crypto;
  const rand = c && typeof c.randomUUID === 'function'
    ? c.randomUUID().replace(/-/g, '').slice(0, 6)
    : Math.random().toString(36).slice(2, 8);
  return `${prefix}_${day}_${rand}`;
}

/**
 * 不变量 1「raw 先于洞察」validate 强校验：
 * 洞察必须有 checkpointRef（kind + 非 null id），或显式 linkPending（待回填）。
 * @returns {{ok: boolean, reason: string|null}}
 */
export function validateInsight(insight) {
  const ref = insight?.source?.checkpointRef;
  if (!ref || typeof ref !== 'object') {
    return { ok: false, reason: 'source.checkpointRef 缺失（raw 先于洞察）' };
  }
  if (!CHECKPOINT_REF_KINDS.includes(ref.kind)) {
    return { ok: false, reason: `checkpointRef.kind 非法: ${ref.kind}` };
  }
  if (ref.id === null || ref.id === undefined) {
    if (insight.linkPending !== true) {
      return { ok: false, reason: 'checkpointRef.id 为空且未标记 linkPending（不变量 1）' };
    }
    return { ok: true, reason: null };
  }
  if (typeof ref.id !== 'string' || !ref.id.trim()) {
    return { ok: false, reason: 'checkpointRef.id 必须是非空字符串' };
  }
  return { ok: true, reason: null };
}
