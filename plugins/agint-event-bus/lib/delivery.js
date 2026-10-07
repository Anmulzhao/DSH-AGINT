/**
 * delivery.ts — 投递引擎（设计稿 §A3）
 *
 * 投递语义：
 *   - at-least-once + handler 隔离：单订阅者抛错不影响其他订阅者
 *   - 失败重试 maxAttempts 次（指数退避 backoffMs × 2^n，封顶 8s）
 *   - sync：等待 handler 返回或超时（默认 10s）→ 超时降级 PENDING_REVIEW
 *   - async：串行等待、有界重试（maxAttempts≤5、backoffMs≤2000，2026-10-07
 *     在 schemas 与本文件双层兜底）→ 耗尽后死信。
 *     ⚠️ 真实语义澄清（2026-10-07）：bus.publish 对 async 订阅者同样 await——
 *     并非 fire-and-forget。一个坏订阅者最多阻塞 publish 约 22s（有界），
 *     且其后订阅者排队。真 fire-and-forget 待 T2 切流量时再定。
 *
 * 不存 setInterval / process；退避用 node:timers/promises 的一次性退避
 * （非 ambient timer），每次注册的 disposer 走 AbortSignal 真取消（2026-10-07
 * 起从名义 noop 改为可中断），满足 PLUGIN-SPEC 维度 5 must-dispose 约束。
 *
 * 红线：
 *   - 不持有全局 timer；退避 Promise 必须可被 disposer 中断
 *   - 不写 storage domain；deadletter.ts 与 observability.ts 负责落库
 */
import { setTimeout as setTimeoutPromise } from 'node:timers/promises';
import { recordDeadletter } from './deadletter.js';
/** 幂等：检查 subscription 是否在 sync 模式下有非空 reason */
function assertSyncReason(sub) {
    if (sub.mode === 'sync') {
        if (typeof sub.reason !== 'string' || sub.reason.trim().length === 0) {
            throw new Error(`[agint-event-bus] mode=sync requires non-empty reason; subscriber=${sub.subscriber} 同步订阅滥用 — 拒绝执行`);
        }
    }
}
/** 指数退避计算（封顶 8000 ms） */
function backoffDelay(attempt, baseMs) {
    // attempt 从 1 起；第 1 次失败前不等待，第 2 次失败等 base*2^0，第 3 次失败等 base*2^1...
    const raw = baseMs * Math.pow(2, Math.max(0, attempt - 1));
    return Math.min(8000, Math.max(0, Math.floor(raw)));
}
/** 携带 ctx 注册的 disposer 的退避（2026-10-07 起可真取消） */
async function sleepWithDispose(ms, ctx, disposers) {
    if (ms <= 0)
        return;
    // 旧实现的 disposer 是字面 noop（void t）——「退避 timer 必须 dispose」只是名义
    // 满足，ctx dispose 后退避 Promise 仍睡满全程。现在用 AbortSignal 真中断：
    // abort 使 setTimeoutPromise 立即 reject(AbortError)，这里吞掉当「退避已结束」，
    // 重试循环随即收尾，不再把已 dispose 的 ctx 挂在睡眠上。
    const ac = new AbortController();
    disposers.push(() => {
        try {
            ac.abort();
        }
        catch { /* ignore */ }
    });
    try {
        await setTimeoutPromise(ms, undefined, { signal: ac.signal });
    }
    catch (err) {
        if (err instanceof Error && err.name === 'AbortError')
            return;
        throw err;
    }
}
/** 异步投递（串行等待、有界重试；handler 抛错 → 重试 → 死信） */
export async function deliverAsync(ctx, envelope, sub, disposers) {
    assertSyncReason(sub); // sanity：async 不强制；但若误填 sync 模式同样校验
    // 兜底 cap（2026-10-07）：schemas.js 已限 max(5)/max(2000)，这里再夹一次——
    // 防绕过 validateSubscription 的直连调用把 publish 拖进长阻塞。
    const max = Math.min(5, Math.max(1, sub.retry.maxAttempts));
    const base = Math.min(2000, Math.max(50, sub.retry.backoffMs));
    let lastErr = null;
    for (let attempt = 1; attempt <= max; attempt += 1) {
        try {
            await sub.handler(envelope);
            return { subscriber: sub.subscriber, status: 'DELIVERED', attempts: attempt };
        }
        catch (err) {
            lastErr = err;
            if (ctx.metrics)
                ctx.metrics('eventBus.handlerError', 1);
            if (attempt < max) {
                await sleepWithDispose(backoffDelay(attempt, base), ctx, disposers);
            }
        }
    }
    // 重试上限耗尽 → 死信
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown');
    await recordDeadletter(ctx, envelope, sub, { reason, attempts: max });
    return { subscriber: sub.subscriber, status: 'DEAD_LETTERED', attempts: max, reason };
}
/** 同步投递（等待 handler；超时降级 PENDING_REVIEW） */
export async function deliverSync(ctx, envelope, sub, disposers) {
    // 硬校验：sync 必须有 reason（空字符串即抛 — 设计稿 §A2 哲学审查前置）
    assertSyncReason(sub);
    const timeoutMs = Math.max(100, sub.timeoutMs);
    let timer = null;
    let timedOut = false;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            timedOut = true;
            reject(new Error(`sync timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        // timer 必须被 ctx.effect 取消
        disposers.push(() => {
            if (timer) {
                try {
                    clearTimeout(timer);
                }
                catch { /* ignore */ }
                timer = null;
            }
        });
    });
    try {
        await Promise.race([Promise.resolve(sub.handler(envelope)), timeoutPromise]);
        if (timedOut)
            throw new Error('sync timeout (race lost)'); // 竞态兜底
        return { subscriber: sub.subscriber, status: 'DELIVERED', attempts: 1 };
    }
    catch (err) {
        if (timedOut || (err instanceof Error && /sync timeout/i.test(err.message))) {
            // 降级 PENDING_REVIEW（沙箱不可用精神对齐）
            if (ctx.pendingReview) {
                await ctx.pendingReview({
                    source: envelope.source,
                    topic: envelope.topic,
                    reason: `sync timeout after ${timeoutMs}ms (sub=${sub.subscriber} reason="${sub.reason}")`,
                });
            }
            if (ctx.metrics)
                ctx.metrics('eventBus.syncTimeout', 1);
            return { subscriber: sub.subscriber, status: 'PENDING_REVIEW', attempts: 1, reason: `sync timeout after ${timeoutMs}ms` };
        }
        const reason = err instanceof Error ? err.message : String(err ?? 'unknown');
        await recordDeadletter(ctx, envelope, sub, { reason, attempts: 1, sync: true });
        return { subscriber: sub.subscriber, status: 'DEAD_LETTERED', attempts: 1, reason };
    }
}
/** 同 traceId 内对同订阅者保序（设计稿 §A3）：未实现完整版 fence，留接口供后续扩展 */
export function buildTraceGate() {
    // 骨架：v0.7.0 简化为 in-flight 计数（FIFO 语义由 delivery 主循环的同 trace 顺序处理自然实现）
    return {
        enter(_traceId) { },
        exit() { },
    };
}
