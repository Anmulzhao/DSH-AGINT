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
import { validateSubscription, } from './schemas.js';
import { deliverAsync, deliverSync } from './delivery.js';
import { RingBuffer, buildEventLogEntry, recordDelivery, filterEntries, summarize, } from './observability.js';
/** 全局 sync 订阅上限（yaml constraints / 设计稿 §A2.6） */
const SYNC_GLOBAL_LIMIT = 3;
/** 订阅表：模块级 Map；每次 dispose 由 cordis ctx effect 触发 bus.dispose() */
const subscriptions = new Map();
const ring = new RingBuffer();
function countSyncSubs() {
    let n = 0;
    for (const sub of subscriptions.values())
        if (sub.mode === 'sync')
            n += 1;
    return n;
}
/**
 * publish —— 接受完整 envelope 或 PublishInput（业务插件多走 PublishInput）
 * - 校验 → 路由 → 调用 delivery → 写 ring + logBuffered
 * - 不阻塞 async 投递；只等 sync 投递
 */
export async function publish(ctx, input) {
    let envelope;
    try {
        envelope = 'id' in input && input.topic && input.source
            ? assertEnvelope(input)
            : makeEnvelope(input);
    }
    catch (err) {
        if (ctx.metrics)
            ctx.metrics('eventBus.publishInvalid', 1);
        return {
            accepted: false,
            deliveredTo: [],
            deadLettered: [],
            envelopeId: '',
            traceId: '',
        };
    }
    const matched = [];
    for (const sub of subscriptions.values()) {
        if (sub.topics.includes(envelope.topic))
            matched.push(sub);
    }
    const deliveredTo = [];
    const deadLettered = [];
    const disposers = [];
    const entry = buildEventLogEntry(envelope);
    for (const sub of matched) {
        try {
            const outcome = sub.mode === 'sync'
                ? await deliverSync(ctx, envelope, sub, disposers)
                : await deliverAsync(ctx, envelope, sub, disposers);
            const status = outcome.status === 'PENDING_REVIEW' ? 'PENDING' : outcome.status;
            recordDelivery(entry, sub, status);
            if (outcome.status === 'DELIVERED')
                deliveredTo.push(sub.subscriber);
            else if (outcome.status === 'DEAD_LETTERED')
                deadLettered.push(sub.subscriber);
        }
        catch (err) {
            // 防御：单个订阅者异常不能击穿 publish（订阅者隔离硬保证）
            const reason = err instanceof Error ? err.message : String(err ?? 'unknown');
            recordDelivery(entry, sub, 'FAILED');
            deadLettered.push(sub.subscriber);
            if (ctx.metrics)
                ctx.metrics('eventBus.handlerError', 1);
        }
    }
    // 清理本轮注册的退避 disposer（防止 listener 累积）
    for (const dispose of disposers) {
        try {
            dispose();
        }
        catch { /* ignore */ }
    }
    ring.push(entry);
    try {
        await ctx.tables.events.put(envelope.id, {
            envelope,
            payloadPreview: previewEntry(envelope),
            occurredAt: envelope.occurredAt,
            traceId: envelope.traceId,
        });
    }
    catch {
        if (ctx.metrics)
            ctx.metrics('eventBus.eventWriteFailed', 1);
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
export function subscribe(rawSub, handler) {
    const validated = validateSubscription(rawSub);
    if (validated.mode === 'sync') {
        if (countSyncSubs() >= SYNC_GLOBAL_LIMIT) {
            throw new Error(`[agint-event-bus] sync 订阅已达全局上限 ${SYNC_GLOBAL_LIMIT}（policy-boundary edge 限制）；subscriber=${validated.subscriber}`);
        }
    }
    const id = randomUUID();
    const record = {
        ...validated,
        id,
        createdAt: new Date().toISOString(),
        handler,
    };
    subscriptions.set(id, record);
    return function unsubscribe() {
        subscriptions.delete(id);
    };
}
/** inspect —— 只读过滤查询 */
export function inspect(filter = {}) {
    return filterEntries(ring.snapshot(), filter);
}
/** 当前订阅表快照（仅 host 内部调试；不导出给业务插件） */
export function _subscriptionsSnapshot() {
    return Array.from(subscriptions.values());
}
/** inspect 聚合（语义糖：summary + filter） */
export function inspectSummary(filter = {}) {
    const entries = inspect(filter);
    return { entries, summary: summarize(entries) };
}
/** bus 清退（cordis ctx dispose 时调用） */
export function disposeBus() {
    subscriptions.clear();
    ring.clear();
}
