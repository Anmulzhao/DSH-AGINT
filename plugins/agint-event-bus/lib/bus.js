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
export function publishedCounter() {
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
export function eventWriteFailedCounter() {
    return eventWriteFailedCount;
}
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
 * - 投递语义（2026-10-07 澄清，旧注释「不阻塞 async 投递」与实现相反）：
 *   对所有匹配订阅者**串行 await**，含 async 订阅者的重试+退避。阻塞时长有界：
 *   单订阅者最多 maxAttempts(≤5) × 退避(封顶 8s) ≈ 22s（默认 3×500ms ≈ 1.5s）。
 *   T1 影子期可接受；T2 切流量前需评估是否改真 fire-and-forget。
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
            // 2026-10-05（评审 3.3 方案 A）：顶层 deliveries 落盘。
            // 此前投递结果只进内存 ring，重启即丢 ⇒ per-topic 投递数跨重启不可答。
            // 这里把publish 路径已填好的 entry.deliveries 原样落库（此时分发已完成，
            // 读的是终态而非意图）。取 {...entry.deliveries} 浅拷贝：entry 随后进 ring
            // 且可能被 recordDelivery 继续写，直接存引用会让存储与ring 共享同一对象。
            // ⚠️ 存量行没有这个字段，永远补不回——历史口径仍是unknown，不回填不伪造。
            deliveries: { ...entry.deliveries },
        });
    }
    catch (err) {
        // 不再静默：events 表是"事件真的发生过"的唯一持久证据，写失败必须可见。
        // 限流（首条 + 每 100 条）以避免存储风暴期把日志刷爆。
        eventWriteFailedCount += 1;
        if (eventWriteFailedCount === 1 || eventWriteFailedCount % 100 === 0) {
            const msg = err instanceof Error ? err.message : String(err ?? 'unknown');
            console.warn(`[agint-event-bus] events 表写入失败（事件已分发但未落库）第 ${eventWriteFailedCount} 次：${msg}`);
        }
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
/**
 * 订阅 → 投递对差（评审 3.3 缺口，2026-10-04 补；与 src/bus.ts 同步维护，K78）。
 *
 * 为什么之前给不出：订阅表是模块级 Map（进程内、重启重建），既无对外查询接口，
 * deliveries 也只进内存 ring 且 events 表 put 不带该字段 ⇒ 存储里无据可查。
 * 现在 per-subscriber 计数从 ring 的 deliveries 聚合而来，「订阅存在但投递恒 0」
 * = 隐藏耦合或死订阅者，可直接判。
 *
 * ⚠️ 口径边界：计数只覆盖本进程生命周期，重启清零；「0」等价于「自上次重启起
 * 没被投递过」，不等于「从来没有流量」。
 */
export function subscriptionsSummary() {
    const bySubscriber = new Map();
    const bump = (name, status) => {
        const rec = bySubscriber.get(name) ?? { deliveries: 0, outcomes: {} };
        rec.deliveries += 1;
        rec.outcomes[status] = (rec.outcomes[status] ?? 0) + 1;
        bySubscriber.set(name, rec);
    };
    for (const entry of ring.snapshot()) {
        for (const [name, outcome] of Object.entries(entry.deliveries ?? {}))
            bump(name, outcome);
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
/**
 * topic → 投递聚合（评审 3.3 缺口，2026-10-05 补；与 src/bus.ts 同步维护，K78）。
 *
 * 为什么需要：面板事件链表一行一个 topic，「投递」列此前一律标 unknown。根因是
 * 两条路径口径不通 —— events 表按 topic 聚合但不带 deliveries，deliveries 只在
 * 内存 ring 里。subscriptionsSummary 出的是 per-subscriber 计数，面板拿不到
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
export function deliveryByTopic() {
    const snapshot = ring.snapshot();
    const byTopic = new Map();
    const touch = (topic) => {
        const rec = byTopic.get(topic) ?? {
            topic,
            published: 0,
            delivered: 0,
            deadLettered: 0,
            pending: 0,
            failed: 0,
            other: 0,
            deliveryAttempts: 0,
            subscribers: new Set(),
            lastOccurredAt: null,
        };
        byTopic.set(topic, rec);
        return rec;
    };
    for (const entry of snapshot) {
        const topic = entry.topic ?? '';
        const rec = touch(topic);
        rec.published += 1;
        if (entry.occurredAt && (!rec.lastOccurredAt || entry.occurredAt > rec.lastOccurredAt)) {
            rec.lastOccurredAt = entry.occurredAt;
        }
        for (const [name, status] of Object.entries(entry.deliveries ?? {})) {
            rec.deliveryAttempts += 1;
            rec.subscribers.add(name);
            if (status === 'DELIVERED')
                rec.delivered += 1;
            else if (status === 'DEAD_LETTERED')
                rec.deadLettered += 1;
            else if (status === 'PENDING')
                rec.pending += 1;
            else if (status === 'FAILED')
                rec.failed += 1;
            else
                rec.other += 1;
        }
    }
    const rows = [...byTopic.values()].map((r) => ({ ...r, subscribers: [...r.subscribers].sort() }));
    // 判定用 deliveryAttempts 而非 delivered：一次投递被判死信也算「命中了订阅者」——
    // 对「谁消费了这个 topic」这个问题，死信仍算接触。而 orphanPublished 判的是
    // 「压根没人订」，这时 deliveryAttempts 必然为 0。
    const topicsWithDelivery = new Set(rows.filter((r) => r.deliveryAttempts > 0).map((r) => r.topic));
    const orphanPublished = rows
        .filter((r) => r.deliveryAttempts === 0)
        .map((r) => r.topic)
        .sort();
    const orphanSubscriptions = [...subscriptions.values()]
        .map((s) => ({
            subscriber: s.subscriber,
            mode: s.mode,
            topics: Array.isArray(s.topics) ? [...s.topics] : [],
        }))
        .filter((s) => !s.topics.some((t) => topicsWithDelivery.has(t)))
        .sort((a, b) => a.subscriber.localeCompare(b.subscriber));
    const totals = rows.reduce((acc, r) => {
        acc.published += r.published;
        acc.delivered += r.delivered;
        acc.deadLettered += r.deadLettered;
        acc.pending += r.pending;
        acc.failed += r.failed;
        acc.other += r.other;
        acc.deliveryAttempts += r.deliveryAttempts;
        return acc;
    }, { published: 0, delivered: 0, deadLettered: 0, pending: 0, failed: 0, other: 0, deliveryAttempts: 0 });
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
/**
 * 跨重启口径的 topic → 投递聚合（评审 3.3 方案 A，2026-10-05 补；与 src/bus.ts 同步）。
 *
 * 与 deliveryByTopic 的分工（两个都要有，别只用其一）：
 *   - deliveryByTopic()读内存 ring ⇒ 口径 = 本进程 + 最近 2000 条，但**分类最全**
 *     （能给出 orphanSubscriptions：订阅侧的孤岛，只有内存态订阅表答得出）
 *   - deliveryHistory(ctx)  读 events 表 ⇒ 口径 = 全历史、跨重启，但**分类少**
 *     （订阅表不在存储里，给不出消费侧孤岛）
 *
 * ⚠️ 一条硬边界，违反就是把猜测当测量：
 *   events 表里2026-10-05 之前写入的行**没有 deliveries 字段，永远补不回**。
 *   本函数把这类行单独计入 `legacyRows`，并在 topic 行上标 `coverage`：
 *     - 'full'      该 topic 全部行都带 deliveries ⇒ 数字可信
 *     - 'partial'   部分行带 ⇒ 数字是**下界**，不是全量
 *     - 'legacyOnly'该 topic 全部行都是存量行 ⇒ 投递数 unknown，不报数
 *   绝不用 0 冒充「没投递过」，也不把 partial 的下界当全量报。
 */
export async function deliveryHistory(ctx) {
    const byTopic = new Map();
    let scanned = 0;
    let withDeliveries = 0;
    let legacyRows = 0;
    let readError = null;
    try {
        const table = ctx?.tables?.events;
        if (!table || typeof table.entries !== 'function')
            throw new Error('events 表句柄不可用');
        for (const [, record] of table.entries()) {
            if (!record || typeof record !== 'object')
                continue;
            scanned += 1;
            // 顶层 topic 优先；缺失时（存量行）拆 envelope，两条路都要走通。
            const topic = typeof record.topic === 'string' && record.topic
                ? record.topic
                : (record.envelope && typeof record.envelope.topic === 'string' ? record.envelope.topic : '');
            if (!topic)
                continue;
            const rec = byTopic.get(topic) ?? {
                topic,
                rows: 0,
                rowsWithDeliveries: 0,
                delivered: 0,
                deadLettered: 0,
                pending: 0,
                failed: 0,
                other: 0,
                deliveryAttempts: 0,
                subscribers: new Set(),
                firstOccurredAt: null,
                lastOccurredAt: null,
            };
            rec.rows += 1;
            const at = typeof record.occurredAt === 'string'
                ? record.occurredAt
                : (record.envelope && typeof record.envelope.occurredAt === 'string' ? record.envelope.occurredAt : null);
            if (at && (!rec.firstOccurredAt || at < rec.firstOccurredAt))
                rec.firstOccurredAt = at;
            if (at && (!rec.lastOccurredAt || at > rec.lastOccurredAt))
                rec.lastOccurredAt = at;
            // ⛔ deliveries 缺失 ≠ 投递数 0。存量行归入 legacyRows，topic 标 legacyOnly。
            if (!record.deliveries || typeof record.deliveries !== 'object') {
                legacyRows += 1;
                byTopic.set(topic, rec);
                continue;
            }
            rec.rowsWithDeliveries += 1;
            withDeliveries += 1;
            for (const [name, status] of Object.entries(record.deliveries)) {
                rec.deliveryAttempts += 1;
                rec.subscribers.add(name);
                if (status === 'DELIVERED')
                    rec.delivered += 1;
                else if (status === 'DEAD_LETTERED')
                    rec.deadLettered += 1;
                else if (status === 'PENDING')
                    rec.pending += 1;
                else if (status === 'FAILED')
                    rec.failed += 1;
                else
                    rec.other += 1;
            }
            byTopic.set(topic, rec);
        }
    }
    catch (err) {
        readError = err instanceof Error ? err.message : String(err ?? 'unknown');
    }
    const topics = [...byTopic.values()].map((r) => {
        const coverage = r.rowsWithDeliveries === 0
            ? 'legacyOnly'
            : (r.rowsWithDeliveries === r.rows ? 'full' : 'partial');
        return {
            topic: r.topic,
            coverage,
            rows: r.rows,
            rowsWithDeliveries: r.rowsWithDeliveries,
            delivered: r.delivered,
            deadLettered: r.deadLettered,
            pending: r.pending,
            failed: r.failed,
            other: r.other,
            deliveryAttempts: r.deliveryAttempts,
            subscribers: [...r.subscribers].sort(),
            firstOccurredAt: r.firstOccurredAt,
            lastOccurredAt: r.lastOccurredAt,
        };
    }).sort((a, b) => b.rows - a.rows || a.topic.localeCompare(b.topic));
    return {
        generatedAt: new Date().toISOString(),
        scope: 'events-table',
        /** 读失败时 state=error + reason，面板据此降级为 unknown，不显示半截数字。 */
        state: readError ? 'error' : 'ok',
        reason: readError,
        scanned,
        withDeliveries,
        legacyRows,
        totals: {
            rows: topics.reduce((s, r) => s + r.rows, 0),
            delivered: topics.reduce((s, r) => s + r.delivered, 0),
            deadLettered: topics.reduce((s, r) => s + r.deadLettered, 0),
            deliveryAttempts: topics.reduce((s, r) => s + r.deliveryAttempts, 0),
        },
        topics,
        /**
         * 发布侧孤岛（全历史口径）：有行但全部为存量行 ⇒ 投递数不可知。
         * 与 deliveryByTopic().orphanPublished 语义不同：那个是「窗口内有人发布
         * 但没人订」，这个是「全历史有发布但投递数查不到」。两者不可混算。
         */
        unknownDeliveryTopics: topics.filter((r) => r.coverage === 'legacyOnly').map((r) => r.topic),
    };
}
/** inspect 聚合（语义糖：summary + filter + sync 计数；A9 尾巴，仪表盘可读） */
export function inspectSummary(filter = {}) {
    const entries = inspect(filter);
    return { entries, summary: summarize(entries), syncSubscriptionCount: countSyncSubs(), syncGlobalLimit: SYNC_GLOBAL_LIMIT };
}
/** bus 清退（cordis ctx dispose 时调用） */
export function disposeBus() {
    subscriptions.clear();
    ring.clear();
    publishedCount = 0;
    eventWriteFailedCount = 0;
}
/**
 * 指标快照（A10 + Sprint 13 / s12-09 收口）：给 agint-metrics 采集用的三个数。
 *   - deadletterCount  死信条目数（分子）
 *   - publishedCount   已接受发布数（分母；v0.7.0 缺失，Sprint 13 补齐）
 *   - syncSubscriptions 当前 sync 订阅数（配额护栏）
 */
export async function metricsSnapshot(ctx) {
    let deadletterCount = 0;
    try {
        const dl = ctx?.tables?.deadletter;
        if (dl && typeof dl.size === 'function') deadletterCount = (await dl.size()) ?? 0;
        else if (dl && typeof dl.entries === 'function') {
            // 2026-10-07：旧写法 [...dl.entries()] 对异步迭代器直接抛（真实表
            // entries() 是 async iterator，spread 非同步可迭代）→ 被 catch 吞成 0。
            // 改 for-await 计数，并加 10 万条防御性上限（有 reaper 清理后不该触顶）。
            let n = 0;
            for await (const _e of dl.entries()) {
                n += 1;
                if (n >= 100000) break;
            }
            deadletterCount = n;
        }
    }
    catch { /* 软降级→0 */ }
    let syncSubscriptions = 0;
    try { syncSubscriptions = countSyncSubs(); }
    catch { /* 软降级 */ }
    return { deadletterCount, publishedCount, syncSubscriptions, syncGlobalLimit: SYNC_GLOBAL_LIMIT, eventWriteFailedCount };
}
