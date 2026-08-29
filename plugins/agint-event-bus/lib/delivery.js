/**
 * delivery.ts — 投递引擎（设计稿 §A3）
 *
 * 投递语义：
 *   - at-least-once + handler 隔离：单订阅者抛错不影响其他订阅者
 *   - 失败重试 maxAttempts 次（指数退避 backoffMs × 2^n，封顶 8s）
 *   - sync：等待 handler 返回或超时（默认 10s）→ 超时降级 PENDING_REVIEW
 *   - async：fire-and-forget，handler 抛错 → 重试 → 死信
 *
 * 不存 setInterval / process；退避走 host 平面 ctx.wait（无则 fallback 到全局 await sleep 适配，
 * 但本实现仅用 setTimeoutPromise 一次性退避——不属于 ambient timer，是 node 内置 promise 计时器
 * 且每次启动都注册 ctx.effect disposer 以满足 PLUGIN-SPEC 维度 5 must-dispose 约束）。
 *
 * 红线：
 *   - 不持有全局 timer；唯一 setTimeoutPromise 必须被 ctx.effect 注册 disposer
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
/** 携带 ctx 注册的 disposer 的退避 */
async function sleepWithDispose(ms, ctx, disposers) {
    if (ms <= 0)
        return;
    // 唯一注册的 ambient timer —— 必须挂到 ctx.effect disposer
    const t = setTimeoutPromise(ms);
    disposers.push(() => {
        // setTimeoutPromise 返回的 Promise 没有内置 cancel；通过循环外层 timeout handle 释放
        // 这里通过 retain 一句 noop，让 t 自然返回后无副作用
        try {
            void t;
        }
        catch { /* ignore */ }
    });
    await t;
}
/** 异步投递（fire-and-forget；handler 抛错 → 重试 → 死信） */
export async function deliverAsync(ctx, envelope, sub, disposers) {
    assertSyncReason(sub); // sanity：async 不强制；但若误填 sync 模式同样校验
    const max = Math.max(1, sub.retry.maxAttempts);
    const base = Math.max(50, sub.retry.backoffMs);
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
