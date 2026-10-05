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
      // 2026-09-27（提案 0f91c868 问题2）：顶层冗余 topic/source。
      // 此前外部工具想按 topic/source 过滤必须拆 value.envelope；
      // 补两个标量字段让存储文件可直读。声明进 EventRecordSchema（optional，
      // 存量 1155 条没有这两个字段）。hashtable 形状本身是 dsh-storage-domain
      // 的 KV 契约，不改（改数组 = 破坏全仓存储域统一格式，且仓库内零读取方）。
      topic: envelope.topic,
      source: envelope.source,
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

/** 一个订阅者的可观测摘要（不含 handler 引用 —— 那是不可序列化的函数）。 */
export interface SubscriptionSummary {
  id: string;
  subscriber: string;
  mode: 'sync' | 'async';
  /** 订阅的 topic 列表（通配订阅如实给 ['*']）。 */
  topics: string[];
  createdAt: string;
  /** 本进程生命周期内该订阅者收到的投递次数。 */
  deliveries: number;
  /** 其中状态分布：DELIVERED / DEAD_LETTERED / FAILED / PENDING。 */
  outcomes: Record<string, number>;
}

/**
 * 订阅 → 投递对差（评审3.3 缺口，2026-10-04 补）。
 *
 * 为什么之前给不出：订阅表是模块级 `Map`（进程内、重启重建），既没有对外查询
 * 接口，deliveries 也只写进内存ring（capacity 2000）且 events 表 put 不带该字段
 * ⇒ 「声明无流量 / 隐藏耦合」这类判据在存储里无据可查，只能标 unknown。
 *
 * 现在给得出：per-subscriber 计数器在 publish 路径上累加（本函数读它），
 * 于是「订阅存在但投递恒0」= 隐藏耦合或死订阅者，可直接判。
 *
 * ⚠️ 口径边界（不猜）：计数器**只覆盖本进程生命周期**，重启即清零；
 * 「已投递 0」等价于「自上次重启起没被投递过」，不等于「从来没有流量」。
 * 跨重启口径要靠 events 表落deliveries，那是另一个改动（会改存储 schema）。
 */
export function subscriptionsSummary(): {
  generatedAt: string;
  total: number;
  syncCount: number;
  syncGlobalLimit: number;
  entries: SubscriptionSummary[];
} {
  const bySubscriber = new Map<string, { deliveries: number; outcomes: Record<string, number> }>();
  const bump = (name: string, status: string): void => {
    const rec = bySubscriber.get(name) ?? { deliveries: 0, outcomes: {} };
    rec.deliveries += 1;
    rec.outcomes[status] = (rec.outcomes[status] ?? 0) + 1;
    bySubscriber.set(name, rec);
  };
  for (const entry of ring.snapshot()) {
    for (const [name, outcome] of Object.entries(entry.deliveries ?? {})) bump(name, outcome);
  }
  const entries = [...subscriptions.values()].map((s) => {
    const stat = bySubscriber.get(s.subscriber) ?? { deliveries: 0, outcomes: {} };
    return {
      id: s.id,
      subscriber: s.subscriber,
      mode: s.mode,
      topics: Array.isArray(s.topics) ? [...s.topics] : [],
      createdAt: s.createdAt,
      deliveries: stat.deliveries,
      outcomes: { ...stat.outcomes },
    };
  });
  entries.sort((a, b) => b.deliveries - a.deliveries || a.subscriber.localeCompare(b.subscriber));
  return {
    generatedAt: new Date().toISOString(),
    total: entries.length,
    syncCount: countSyncSubs(),
    syncGlobalLimit: SYNC_GLOBAL_LIMIT,
    entries,
  };
}

/** 单个 topic 的窗口内投递聚合行。 */
export interface DeliveryTopicRow {
  topic: string;
  /** ring 窗口内该 topic 的发布数（非全历史；全历史只有 events 表能答）。 */
  published: number;
  delivered: number;
  deadLettered: number;
  pending: number;
  failed: number;
  /** 未知 status 的兜底计数；正常路径恒为 0，非 0 说明有新status 未归类。 */
  other: number;
  /** 投递尝试总数（delivered + deadLettered + pending + failed + other）。 */
  deliveryAttempts: number;
  /** 窗口内至少被投递过一次的订阅者名（去重、字典序）。 */
  subscribers: string[];
  lastOccurredAt: string | null;
}

/** 窗口内零投递的订阅者（消费侧孤岛，可直接判死订阅者）。 */
export interface OrphanSubscription {
  subscriber: string;
  mode: 'sync' | 'async';
  topics: string[];
}

/**
 * topic → 投递聚合（评审 3.3 缺口，2026-10-05 补）。
 *
 * 为什么需要：面板事件链表一行一个 topic，「投递」列此前一律标 unknown。根因是
 * 两条路径口径不通 —— events 表按 topic 聚合但不带 deliveries，deliveries 只在
 * 内存ring 里。subscriptionsSummary 出的是 per-subscriber 计数，面板拿不到
 * 「这个 topic 投递了几次」。
 *
 * 这个出口把ring 按 topic 折一次，顺带给出两侧的对差：
 *   - orphanPublished      发布过但窗口内零订阅者命中（发布侧孤岛）
 *   - orphanSubscriptions  订阅存在但窗口内零投递（消费侧孤岛，可直接判死订阅者）
 * 这两个集合才是评审 3.3 真正要的判据；光有per-topic 投递数答不了「谁在跟谁说话」。
 *
 * ⚠️ 口径边界（三条，不猜）：
 *   1. 只覆盖本进程生命周期，重启清零（ring 与订阅表都是模块级内存态）。
 *   2. 只覆盖 ring 窗口内最近 2000 条发布，更早的投递记录已被 FIFO 淘汰 ——
 *      `ring.full` 与 `ring.oldestOccurredAt` 就是这个边界的读数。
 *   3. `published` 是**ring 窗口内**的发布数，不是全历史发布数。全历史口径只有
 *      events 表（不含 deliveries）能答，两者不可混算。
 * 跨重启的 per-topic 投递数要靠 events 表落 deliveries（方案 A），那是另一个改动。
 */
export function deliveryByTopic(): {
  generatedAt: string;
  ring: {
    size: number;
    capacity: number;
    full: boolean;
    oldestOccurredAt: string | null;
    newestOccurredAt: string | null;
  };
  totals: Omit<DeliveryTopicRow, 'topic' | 'subscribers' | 'lastOccurredAt'>;
  topics: DeliveryTopicRow[];
  orphanPublished: string[];
  orphanSubscriptions: OrphanSubscription[];
} {
  const snapshot = ring.snapshot();
  interface Acc {
    topic: string;
    published: number;
    delivered: number;
    deadLettered: number;
    pending: number;
    failed: number;
    other: number;
    deliveryAttempts: number;
    subscribers: Set<string>;
    lastOccurredAt: string | null;
  }
  const byTopic = new Map<string, Acc>();
  const touch = (topic: string): Acc => {
    const rec = byTopic.get(topic) ?? {
      topic,
      published: 0,
      delivered: 0,
      deadLettered: 0,
      pending: 0,
      failed: 0,
      other: 0,
      deliveryAttempts: 0,
      subscribers: new Set<string>(),
      lastOccurredAt: null,
    };
    byTopic.set(topic, rec);
    return rec;
  };
  for (const entry of snapshot) {
    const rec = touch(entry.topic ?? '');
    rec.published += 1;
    if (entry.occurredAt && (!rec.lastOccurredAt || entry.occurredAt > rec.lastOccurredAt)) {
      rec.lastOccurredAt = entry.occurredAt;
    }
    for (const [name, status] of Object.entries(entry.deliveries ?? {})) {
      rec.deliveryAttempts += 1;
      rec.subscribers.add(name);
      if (status === 'DELIVERED') rec.delivered += 1;
      else if (status === 'DEAD_LETTERED') rec.deadLettered += 1;
      else if (status === 'PENDING') rec.pending += 1;
      else if (status === 'FAILED') rec.failed += 1;
      else rec.other += 1;
    }
  }
  const rows: DeliveryTopicRow[] = [...byTopic.values()].map((r) => ({
    topic: r.topic,
    published: r.published,
    delivered: r.delivered,
    deadLettered: r.deadLettered,
    pending: r.pending,
    failed: r.failed,
    other: r.other,
    deliveryAttempts: r.deliveryAttempts,
    subscribers: [...r.subscribers].sort(),
    lastOccurredAt: r.lastOccurredAt,
  }));
  // 判定用 deliveryAttempts 而非 delivered：一次投递被判死信也算「命中了订阅者」——
  // 对「谁消费了这个 topic」这个问题，死信仍算接触。而 orphanPublished 判的是
  // 「压根没人订」，这时 deliveryAttempts 必然为 0。
  const topicsWithDelivery = new Set(rows.filter((r) => r.deliveryAttempts > 0).map((r) => r.topic));
  const orphanPublished = rows
    .filter((r) => r.deliveryAttempts === 0)
    .map((r) => r.topic)
    .sort();
  const orphanSubscriptions: OrphanSubscription[] = [...subscriptions.values()]
    .map((s) => ({
      subscriber: s.subscriber,
      mode: s.mode,
      topics: Array.isArray(s.topics) ? [...s.topics] : [],
    }))
    .filter((s) => !s.topics.some((t) => topicsWithDelivery.has(t)))
    .sort((a, b) => a.subscriber.localeCompare(b.subscriber));
  const totals = rows.reduce(
    (acc, r) => {
      acc.published += r.published;
      acc.delivered += r.delivered;
      acc.deadLettered += r.deadLettered;
      acc.pending += r.pending;
      acc.failed += r.failed;
      acc.other += r.other;
      acc.deliveryAttempts += r.deliveryAttempts;
      return acc;
    },
    { published: 0, delivered: 0, deadLettered: 0, pending: 0, failed: 0, other: 0, deliveryAttempts: 0 },
  );
  const sorted = [...rows].sort((a, b) => b.published - a.published || a.topic.localeCompare(b.topic));
  const occurred = snapshot.map((e) => e.occurredAt).filter(Boolean).sort();
  return {
    generatedAt: new Date().toISOString(),
    ring: {
      size: snapshot.length,
      capacity: ring.capacity,
      full: snapshot.length >= ring.capacity,
      oldestOccurredAt: occurred[0] ?? null,
      newestOccurredAt: occurred[occurred.length - 1] ?? null,
    },
    totals,
    topics: sorted,
    orphanPublished,
    orphanSubscriptions,
  };
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
