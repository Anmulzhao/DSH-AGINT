import { packProbe, nowIso } from './storage.js';
import { PHASES } from './schemas.js';
export const DEFAULT_PROBE_CONFIG = Object.freeze({
    intervalMs: 10_000,
    successThreshold: 3,
    failureThreshold: 2,
});
/** 默认 stub：永远 ok（仅用于 Sprint 11 骨架阶段；真实实现由 codex-D 接 dsh HMR） */
export async function probeStaging(_ticketId) {
    return { ok: true, reason: 'stub', latencyMs: 0 };
}
/**
 * 单次探针结果记录：成功 / 失败按阈值推进 phase。
 * 返回最新 phase（可能变为 HEALTHY / DISABLED）。
 */
export async function recordProbeResult(ctx, ticketId, ok, reason, latencyMs, cfg = DEFAULT_PROBE_CONFIG) {
    // 1) 查 ticket
    const tt = ctx.tables?.tickets;
    if (!tt)
        throw new Error('health-probe: tickets table unavailable');
    const entry = await tt.get(`t-${ticketId}`);
    if (!entry)
        throw new Error(`health-probe: ticket ${ticketId} not found`);
    // 2) 写 probe_history
    const ph = ctx.tables?.probe_history;
    if (ph) {
        const probeEntry = packProbe({ ticketId, at: nowIso(), ok, reason, latencyMs });
        await ph.put(probeEntry.id, probeEntry);
    }
    // 3) 更新 tickets.probeStats
    const prevStats = entry.probeStats || {
        consecutiveSuccess: 0, consecutiveFailure: 0, lastProbeAt: null, lastReason: undefined,
    };
    const nextStats = {
        consecutiveSuccess: ok ? prevStats.consecutiveSuccess + 1 : 0,
        consecutiveFailure: ok ? 0 : prevStats.consecutiveFailure + 1,
        lastProbeAt: nowIso(),
        lastReason: reason,
    };
    let nextPhase = entry.phase;
    // 4) 阈值判定（不破坏 FROZEN phase 集）
    if (nextStats.consecutiveSuccess >= cfg.successThreshold && nextPhase === 'ACTIVATED') {
        nextPhase = 'HEALTHY';
    }
    else if (nextStats.consecutiveFailure >= cfg.failureThreshold && PHASES.includes(nextPhase)) {
        nextPhase = 'DISABLED';
    }
    const updated = { ...entry, probeStats: nextStats, phase: nextPhase, updatedAt: nowIso() };
    await tt.put(updated.id, updated);
    // 5) DISABLE 触发：emit mount.failed + evolution 留痕
    if (nextPhase === 'DISABLED' && entry.phase !== 'DISABLED') {
        try {
            const evo = ctx.getService?.('agint.evolution');
            if (evo?.addFailure) {
                await evo.addFailure({
                    pattern: `mount-disabled:${ticketId}`,
                    category: 'mount',
                    severity: 'critical',
                    evidence: `probe consecutiveFailure=${nextStats.consecutiveFailure} reason=${reason ?? 'unknown'}`,
                    tags: ['mount-disabled'],
                });
            }
        }
        catch { /* 软依赖失败忽略 */ }
        try {
            ctx.emitEvent?.('mount.failed', { ticketId, fromPhase: 'ACTIVATED', reason: 'probe-consecutive-failure', actions: [] });
        }
        catch { /* event 通道失败忽略 */ }
    }
    return { phase: nextPhase, consecutiveSuccess: nextStats.consecutiveSuccess, consecutiveFailure: nextStats.consecutiveFailure };
}
export function makeProbeLoop(ctx, ticketId, probeFn, cfg = DEFAULT_PROBE_CONFIG, onPhaseChange) {
    let running = false;
    let timer = null;
    const tick = async () => {
        if (!running)
            return;
        try {
            const r = await probeFn(ticketId);
            const out = await recordProbeResult(ctx, ticketId, r.ok, r.reason, r.latencyMs, cfg);
            onPhaseChange?.(out.phase);
            if (out.phase === 'HEALTHY' || out.phase === 'DISABLED') {
                // 终态自动停探针
                stop();
            }
        }
        catch (e) {
            // 探针自身抛错视为失败 +1
            await recordProbeResult(ctx, ticketId, false, `probe-throw:${e.message}`, undefined, cfg).catch(() => { });
        }
    };
    function start() {
        if (running)
            return;
        running = true;
        timer = setInterval(tick, cfg.intervalMs);
        // 立刻跑一次，不等第一个 interval
        void tick();
    }
    function stop() {
        running = false;
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
    }
    return { start, stop, isRunning: () => running };
}
