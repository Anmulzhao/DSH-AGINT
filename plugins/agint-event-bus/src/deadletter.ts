/**
 * deadletter.ts — 死信落 agint_event_bus 存储域（设计稿 §A3）
 *
 * 写入路径：
 *   - id = `${envelope.id}:${sub.id}`（避免同 envelope 多订阅者互相覆盖）
 *   - value = { envelope, sub, reason, attempts, recordedAt, ttl }
 *   - 保留策略：retentionMs 默认 604800000ms（7 天，yaml constraints）；
 *     2026-10-07 起由 sweepExpiredDeadletters 真正执行（启动 + 每 24h），此前只写不删
 *
 * 不变量：
 *   - 不直接调 ambient I/O；通过 ctx.tables.deadletter（TableHandle）
 *   - 不抛错打断 publish 主路径；recordDeadletterInternal 失败仅 metric 计数
 */

import { previewEntry } from './envelope.js';
import type { EventEnvelope } from './envelope.js';
import type { EventBusContext, SubscriptionRecord } from './types.js';

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 604800000

export interface DeadLetterEntry {
  id: string;
  envelope: EventEnvelope;
  payloadPreview: unknown;
  subscriber: string;
  subscriptionId: string;
  reason: string;
  attempts: number;
  sync: boolean;
  recordedAt: string;
  ttl: number;
}

/**
 * 记录一条死信。失败不抛（publish 主路径保护），仅 metric 计数。
 * 兼容内层 await；外层 try/catch 双兜底。
 */
export async function recordDeadletter(
  ctx: EventBusContext,
  envelope: EventEnvelope,
  sub: SubscriptionRecord,
  meta: { reason: string; attempts: number; sync?: boolean },
): Promise<void> {
  try {
    await recordDeadletterInternal(ctx, envelope, sub, meta);
  } catch {
    if (ctx.metrics) ctx.metrics('eventBus.deadletterWriteFailed', 1);
    // 不重抛 —— 设计稿 §A3：deadletter 失败仅 metric，发布主路径必须继续
  }
}

async function recordDeadletterInternal(
  ctx: EventBusContext,
  envelope: EventEnvelope,
  sub: SubscriptionRecord,
  meta: { reason: string; attempts: number; sync?: boolean },
): Promise<void> {
  const entry: DeadLetterEntry = {
    id: `${envelope.id}:${sub.id}`,
    envelope,
    payloadPreview: previewEntry(envelope),
    subscriber: sub.subscriber,
    subscriptionId: sub.id,
    reason: meta.reason,
    attempts: meta.attempts,
    sync: Boolean(meta.sync),
    recordedAt: new Date().toISOString(),
    ttl: DEFAULT_RETENTION_MS,
  };
  await ctx.tables.deadletter.put(entry.id, entry);
  if (ctx.metrics) ctx.metrics('eventBus.deadletter', 1);
}

/** 列出域内所有死信（inspect 增强用） */
export async function listDeadletters(ctx: EventBusContext): Promise<DeadLetterEntry[]> {
  const out: DeadLetterEntry[] = [];
  const entries = ctx.tables.deadletter.entries();
  for await (const [, value] of entries) {
    if (value && typeof value === 'object') out.push(value as DeadLetterEntry);
  }
  return out;
}

/**
 * 清理过期死信（2026-10-07 补 reaper，与 lib/deadletter.js 同步）。
 * 判据 recordedAt + DEFAULT_RETENTION_MS；失败静默；返回删除条数。
 * 由 index.ts 的 apply 注册：启动时 + 每 24h 一次。
 */
export async function sweepExpiredDeadletters(ctx: EventBusContext, now: number = Date.now()): Promise<number> {
  const t = ctx?.tables?.deadletter;
  if (!t || typeof t.entries !== 'function' || typeof (t as any).delete !== 'function') return 0;
  let removed = 0;
  try {
    const expired: string[] = [];
    for await (const [id, value] of t.entries()) {
      const recorded = value && typeof (value as any).recordedAt === 'string' ? Date.parse((value as any).recordedAt) : NaN;
      if (!Number.isNaN(recorded) && now - recorded >= DEFAULT_RETENTION_MS) expired.push(id);
    }
    for (const id of expired) {
      try { await (t as any).delete(id); removed += 1; } catch { /* 单条失败不中断整轮 */ }
    }
  } catch { /* 表不可用：静默，下轮再试 */ }
  return removed;
}
