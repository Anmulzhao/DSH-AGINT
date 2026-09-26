/**
 * bus.ts — agint-event-bus 总线编排（设计稿 §A2 / §A3）
 *
 * 三 Service：
 *   - publish(envelope|input)        => PublishResult（不阻塞 async 投递）
 *   - subscribe(Subscription + handler) => Unsubscribe
 *   - inspect(filter)                  => EventLogEntry[]
 *
 * 路由策略：
 *   - publish 时按 envelope.topic 精确匹配订阅表的 topics 列表
 *   - 多订阅者隔离：每个订阅者独立 Promise，不互相影响
 *   - sync 模式等待（如本次 publish 调用须等全部 sync 投递完成才返回 deliveredTo）
 *     —— 语义对齐 mount.request 的"端到端同步"模型
 *
 * 不变量：
 *   - 订阅表是模块级 Map，每次 subscribe 增、Unsubscribe 删
 *   - 不在模块级持有 ambient timer；退避由 delivery.ts 的 setTimeoutPromise 持有并 dispose
 *   - 不调 qualityEvaluator（self-evaluation forbidden）
 */

import { randomUUID } from 'node:crypto';
import { makeEnvelope, assertEnvelope, previewEntry } from './envelope.js';
import type { EventEnvelope } from './envelope.js';
import {
  validateSubscription,
} from './schemas.js';
import { deliverAsync, deliverSync } from './delivery.js';
import {
  RingBuffer,
  buildEventLogEntry,
  recordDelivery,
  filterEntries,
  summarize,
} from './observability.js';
import type {
  EventBusContext,
  Handler,
  InspectFilter,
  PublishResult,
  Subscription,
  SubscriptionRecord,
  Unsubscribe,
  EventLogEntry,
} from './types.js';

/** 全局 sync 订阅上限（yaml constraints / 设计稿 §A2.6） */
const SYNC_GLOBAL_LIMIT = 3;

/** 订阅表：模块级 Map；每次 dispose 由 cordis ctx effect 触发 bus.dispose() */
const subscriptions = new Map<string, SubscriptionRecord>();
const ring = new RingBuffer();

/**
 * Sprint 13 / s12-09 断言③：已接受发布计数（accepted publishes）。
 *
 * 用途：`eventBus.metricsSnapshot().publishedCount` 作为死信率的分母 ——
 * metrics.js 的 `eventBus.deadletterRate = deadletterCount / publishedCount * 100`。
 * v0.7.0 的 metricsSnapshot 只返 deadletterCount，导致 publishedCount 恒为 0、
 * 死信率要么记 0 要么不 push（A10 尾巴未收口）。这里补齐分母。
 *
 * 语义：只统计 schema 校验通过（accepted=true）的 publish；非法 envelope 不计。
 */
let publishedCount = 0;

/** 读取当前已接受发布计数（供 metricsSnapshot / 测试断言使用） */
export function publishedCounter(): number {
  return publishedCount;
}

/**
 * events 表写入失败计数（2026-09-26 新增）。
 *
 * 背景：publish 的顺序是「**先分发、再写 events 表**」，而写表失败此前只打
 * 一个内部 metric、不打任何日志 —— 结果是「事件已经在 handler 里跑过了，但
 * events 表里查不到」，排查时看起来像"总线上什么都没发生"（2026-09-26 的
 * 诊断自激环就是这样被隐藏了 26 小时）。
 *
 * 现在：失败即 console.warn（限流：首条 + 每 100 条一条）+ 计数入 metricsSnapshot。
 */
let eventWriteFailedCount = 0;

/** 读取 events 表写入失败计数 */
export function eventWriteFailedCounter(): number {
  return eventWriteFailedCount;
}

function countSyncSubs(): number {
  let n = 0;
  for (const sub of subscriptions.values()) if (sub.mode === 'sync') n += 1;
  return n;
}

/**
 * publish —— 接受完整 envelope 或 PublishInput（业务插件多走 PublishInput）
 * - 校验 → 路由 → 调用 delivery → 写 ring + logBuffered
 * - 不阻塞 async 投递；只等 sync 投递
 */
export async function publish(
  ctx: EventBusContext,
  input: EventEnvelope | import('./envelope.js').PublishInput,
): Promise<PublishResult> {
  let envelope: EventEnvelope;
  try {
    envelope = 'id' in input && input.topic && input.source
      ? assertEnvelope(input)
      : makeEnvelope(input as import('./envelope.js').PublishInput);
  } catch (err) {
    if (ctx.metrics) ctx.metrics('eventBus.publishInvalid', 1);
    return {
      accepted: false,
      deliveredTo: [],
      deadLettered: [],
      envelopeId: '',
      traceId: '',
    };
  }

  const matched: SubscriptionRecord[] = [];
  for (const sub of subscriptions.values()) {
    if (sub.topics.includes(envelope.topic)) matched.push(sub);
  }

  const deliveredTo: string[] = [];
  const deadLettered: string[] = [];
  const disposers: Array<() => void> = [];
  const entry = buildEventLogEntry(envelope);

  for (const sub of matched) {
    try {
      const outcome = sub.mode === 'sync'
        ? await deliverSync(ctx, envelope, sub, disposers)
        : await deliverAsync(ctx, envelope, sub, disposers);
      const status = outcome.status === 'PENDING_REVIEW' ? 'PENDING' : outcome.status;
      recordDelivery(entry, sub, status as 'DELIVERED' | 'DEAD_LETTERED' | 'FAILED' | 'PENDING');
      if (outcome.status === 'DELIVERED') deliveredTo.push(sub.subscriber);
      else if (outcome.status === 'DEAD_LETTERED') deadLettered.push(sub.subscriber);
    } catch (err) {
      // 防御：单个订阅者异常不能击穿 publish（订阅者隔离硬保证）
      const reason = err instanceof Error ? err.message : String(err ?? 'unknown');
      recordDelivery(entry, sub, 'FAILED');
      deadLettered.push(sub.subscriber);
      if (ctx.metrics) ctx.metrics('eventBus.handlerError', 1);
    }
  }

  // 清理本轮注册的退避 disposer（防止 listener 累积）
  for (const dispose of disposers) {
    try { dispose(); } catch { /* ignore */ }
  }

  ring.push(entry);
  publishedCount += 1;
  try {
    await ctx.tables.events.put(envelope.id, {
      envelope,
      payloadPreview: previewEntry(envelope),
      occurredAt: envelope.occurredAt,
      traceId: envelope.traceId,
    });
  } catch (err) {
    // 不再静默：events 表是"事件真的发生过"的唯一持久证据，写失败必须可见。
    // 限流（首条 + 每 100 条）以避免存储风暴期把日志刷爆。
    eventWriteFailedCount += 1;
    if (eventWriteFailedCount === 1 || eventWriteFailedCount % 100 === 0) {
      const msg = err instanceof Error ? err.message : String(err ?? 'unknown');
      console.warn(`[agint-event-bus] events 表写入失败（事件已分发但未落库）第 ${eventWriteFailedCount} 次：${msg}`);
    }
    if (ctx.metrics) ctx.metrics('eventBus.eventWriteFailed', 1);
  }

  if (ctx.logBuffered) {
    await ctx.logBuffered({
      id: `event-bus-publish-${envelope.id}`,
      evidence: `topic=${envelope.topic} delivered=${deliveredTo.length} dl=${deadLettered.length}`,
      pattern: envelope.topic,
      reason: `published by ${envelope.source}`,
    });
  }

  return {
    accepted: true,
    deliveredTo,
    deadLettered,
    envelopeId: envelope.id,
    traceId: envelope.traceId,
  };
}

/**
 * subscribe —— 注册一个订阅；返回 Unsubscribe 函数
 * 硬校验（zod 内已做）：sync mode + 空 reason 硬抛错
 * 配额校验：超过 SYNC_GLOBAL_LIMIT 即抛（设计稿 §A2.6）
 */
export function subscribe(
  rawSub: import('./types.js').Subscription,
  handler: Handler,
): Unsubscribe {
  const validated: Subscription = validateSubscription(rawSub);
  if (validated.mode === 'sync') {
    if (countSyncSubs() >= SYNC_GLOBAL_LIMIT) {
      throw new Error(
        `[agint-event-bus] sync 订阅已达全局上限 ${SYNC_GLOBAL_LIMIT}（policy-boundary edge 限制）；subscriber=${validated.subscriber}`,
      );
    }
  }
  const id = randomUUID();
  const record: SubscriptionRecord = {
    ...validated,
    id,
    createdAt: new Date().toISOString(),
    handler,
  };
  subscriptions.set(id, record);
  return function unsubscribe(): void {
    subscriptions.delete(id);
  };
}

/** inspect —— 只读过滤查询 */
export function inspect(filter: InspectFilter = {}): EventLogEntry[] {
  return filterEntries(ring.snapshot(), filter);
}

/** 当前订阅表快照（仅 host 内部调试；不导出给业务插件） */
export function _subscriptionsSnapshot(): SubscriptionRecord[] {
  return Array.from(subscriptions.values());
}

/** inspect 聚合（语义糖：summary + filter + sync 计数；A9 尾巴，仪表盘可读） */
export function inspectSummary(filter: InspectFilter = {}): {
  entries: EventLogEntry[];
  summary: ReturnType<typeof summarize>;
  syncSubscriptionCount: number;
  syncGlobalLimit: number;
} {
  const entries = inspect(filter);
  return { entries, summary: summarize(entries), syncSubscriptionCount: countSyncSubs(), syncGlobalLimit: SYNC_GLOBAL_LIMIT };
}

/** bus 清退（cordis ctx dispose 时调用） */
export function disposeBus(): void {
  subscriptions.clear();
  ring.clear();
  publishedCount = 0;
  eventWriteFailedCount = 0;
}

/**
 * 指标快照（A10 + Sprint 13 / s12-09 收口）：给 agint-metrics 采集用的三个数。
 *   - deadletterCount   死信条目数（分子）
 *   - publishedCount    已接受发布数（分母；v0.7.0 缺失，Sprint 13 补齐）
 *   - syncSubscriptions 当前 sync 订阅数（配额护栏）
 */
export async function metricsSnapshot(ctx: EventBusContext): Promise<{
  deadletterCount: number;
  publishedCount: number;
  syncSubscriptions: number;
  syncGlobalLimit: number;
  eventWriteFailedCount: number;
}> {
  let deadletterCount = 0;
  try {
    const dl = ctx?.tables?.deadletter;
    if (dl && typeof dl.size === 'function') deadletterCount = (await dl.size()) ?? 0;
    else if (dl && typeof dl.entries === 'function') deadletterCount = [...dl.entries()].length;
  } catch { /* 软降级→0 */ }

  let syncSubscriptions = 0;
  try { syncSubscriptions = countSyncSubs(); } catch { /* 软降级 */ }

  return { deadletterCount, publishedCount, syncSubscriptions, syncGlobalLimit: SYNC_GLOBAL_LIMIT, eventWriteFailedCount };
}
