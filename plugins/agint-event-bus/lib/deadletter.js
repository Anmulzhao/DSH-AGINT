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
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 604800000
/**
 * 记录一条死信。失败不抛（publish 主路径保护），仅 metric 计数。
 * 兼容内层 await；外层 try/catch 双兜底。
 */
export async function recordDeadletter(ctx, envelope, sub, meta) {
    try {
        await recordDeadletterInternal(ctx, envelope, sub, meta);
    }
    catch {
        if (ctx.metrics)
            ctx.metrics('eventBus.deadletterWriteFailed', 1);
        // 不重抛 —— 设计稿 §A3：deadletter 失败仅 metric，发布主路径必须继续
    }
}
async function recordDeadletterInternal(ctx, envelope, sub, meta) {
    const entry = {
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
    if (ctx.metrics)
        ctx.metrics('eventBus.deadletter', 1);
}
/** 列出域内所有死信（inspect 增强用） */
export async function listDeadletters(ctx) {
    const out = [];
    const entries = ctx.tables.deadletter.entries();
    for await (const [, value] of entries) {
        if (value && typeof value === 'object')
            out.push(value);
    }
    return out;
}
/**
 * 清理过期死信（2026-10-07 补 reaper）。
 *
 * 背景：ttl（604800000 = 7 天）此前**只写不删**——全仓没有任何消费者，
 * 「7 天保留」是写在 yaml constraints 与本文件头注释里的纸面约定，死信表
 * 实际无界增长（每条存完整 envelope）。本函数由 lib/index.js 的 apply 注册：
 * 启动时 + 每 24h 各清一次，ctx.effect 保证 dispose 清 timer。
 *
 * 判据用 recordedAt + DEFAULT_RETENTION_MS（ttl 字段存的是时长不是绝对时刻，
 * 存量条目统一按 recordedAt 判，语义等价）。失败静默：reaper 不打断主流程。
 * 返回删除条数（0 = 无过期或表不可用），供日志/测试观测。
 */
export async function sweepExpiredDeadletters(ctx, now = Date.now()) {
    const t = ctx?.tables?.deadletter;
    if (!t || typeof t.entries !== 'function' || typeof t.delete !== 'function')
        return 0;
    let removed = 0;
    try {
        const expired = [];
        for await (const [id, value] of t.entries()) {
            const recorded = value && typeof value.recordedAt === 'string' ? Date.parse(value.recordedAt) : NaN;
            if (!Number.isNaN(recorded) && now - recorded >= DEFAULT_RETENTION_MS)
                expired.push(id);
        }
        for (const id of expired) {
            try {
                await t.delete(id);
                removed += 1;
            }
            catch { /* 单条失败不中断整轮 */ }
        }
    }
    catch { /* 表不可用（stub / 迭代失败）：静默，下轮再试 */ }
    return removed;
}
