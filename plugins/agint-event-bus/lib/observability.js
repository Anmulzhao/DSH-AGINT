/**
 * observability.ts — inspect 环形缓冲 + 指标聚合（设计稿 §A4）
 *
 * 设计：
 *   - 内存环形缓冲 capacity=2000（yaml constraints）
 *   - EventLogEntry 保留 deliveries / payloadPreview，不保留 payload 全文
 *   - 不订阅 process / 监听全局信号；ctx.dispose 由调用方持有
 *
 * 不变量：
 *   - 不持有全局 timer（无 setInterval / setTimeoutPromise）
 *   - 过滤逻辑纯函数；时间窗口交给 caller 解析
 */
import { previewEntry } from './envelope.js';
const RING_CAPACITY = 2000;
/**
 * 环形缓冲（FIFO 淘汰；超出按 FIFO 丢最早）
 *
 * 实现：内部用 Map 维护 id → entry，保证按插入顺序迭代，配合外部 size 计数。
 * 单测会通过 inspect filter 覆盖 FIFO 行为。
 */
export class RingBuffer {
    capacity;
    map = new Map();
    constructor(capacity = RING_CAPACITY) {
        this.capacity = capacity;
    }
    push(entry) {
        if (this.map.has(entry.id)) {
            this.map.set(entry.id, entry);
            return;
        }
        if (this.map.size >= this.capacity) {
            // FIFO：取首个 key 删除
            const firstKey = this.map.keys().next().value;
            if (firstKey !== undefined)
                this.map.delete(firstKey);
        }
        this.map.set(entry.id, entry);
    }
    get(id) {
        return this.map.get(id);
    }
    size() {
        return this.map.size;
    }
    snapshot() {
        return Array.from(this.map.values());
    }
    clear() {
        this.map.clear();
    }
}
/**
 * 构造一个 EventLogEntry 草案（含 deliveries 占位）
 * caller 拿到后填充 deliveries 后再 push。
 */
export function buildEventLogEntry(envelope) {
    return {
        id: envelope.id,
        topic: envelope.topic,
        source: envelope.source,
        traceId: envelope.traceId,
        occurredAt: envelope.occurredAt,
        deliveries: {},
        payloadPreview: previewEntry(envelope),
    };
}
/** 校验后写入/合并 deliveries */
export function recordDelivery(entry, sub, outcome) {
    entry.deliveries[sub.subscriber] = outcome;
}
/**
 * inspect 过滤（在 ring snapshot 上执行；不命中即空）
 * 所有过滤条件 AND 组合；limit 截断（默认 100；显式 0 = 不限）。
 */
export function filterEntries(entries, filter = {}) {
    const sinceMs = filter.since ? Date.parse(filter.since) : NaN;
    const untilMs = filter.until ? Date.parse(filter.until) : NaN;
    const out = [];
    for (const e of entries) {
        if (filter.topic && e.topic !== filter.topic)
            continue;
        if (filter.traceId && e.traceId !== filter.traceId)
            continue;
        if (filter.source && e.source !== filter.source)
            continue;
        const ts = Date.parse(e.occurredAt);
        if (!Number.isNaN(sinceMs) && ts < sinceMs)
            continue;
        if (!Number.isNaN(untilMs) && ts > untilMs)
            continue;
        out.push(e);
    }
    const limit = filter.limit === 0 ? out.length : (filter.limit ?? 100);
    return out.slice(0, limit);
}
/** 轻量聚合：在订阅表层做指标计数 */
export function summarize(entries) {
    let delivered = 0;
    let deadLettered = 0;
    let pending = 0;
    for (const e of entries) {
        for (const status of Object.values(e.deliveries)) {
            if (status === 'DELIVERED')
                delivered += 1;
            else if (status === 'DEAD_LETTERED')
                deadLettered += 1;
            else if (status === 'PENDING')
                pending += 1;
        }
    }
    return { total: entries.length, delivered, deadLettered, pending };
}
