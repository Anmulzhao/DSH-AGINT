/**
 * agint-mount — 健康探针
 *
 * 规则（设计稿 ADR-11-3 红线）：
 *   - 连续成功 ≥ 3 次 → HEALTHY
 *   - 连续失败 ≥ 2 次 → DISABLE（不删除 plugin；保留现场供归因）
 *   - 探针接口由 index.ts 注入（probeFn），默认 stub `probeStaging`
 *
 * 资源管理：
 *   - setInterval 必须经 ctx.effect 注册 disposer
 *   - 探针运行中遇到 ctx dispose → 优雅停止（clearInterval）
 *
 * Sprint 11 第 1 周 dsh HMR spike 结论：
 *   - 真实 dsh 探针路径留 hook（probeFn），Sprint 11 默认用 stub
 *   - 4 态路径 RESTART_REQUESTED 之后才启动探针（ACTIVATED 之后才有 dsh 实例可探）
 */
import type { MountContext } from './types.js';
import { packProbe, nowIso } from './storage.js';
import { PHASES } from './schemas.js';

export interface ProbeConfig {
  intervalMs: number;     // 探针间隔
  successThreshold: number; // 连续成功达标进入 HEALTHY
  failureThreshold: number; // 连续失败达标进入 DISABLE
}

export const DEFAULT_PROBE_CONFIG: ProbeConfig = Object.freeze({
  intervalMs: 10_000,
  successThreshold: 3,
  failureThreshold: 2,
});

/** 探针函数：ctx 注入；返回 ok + reason + latency */
export type ProbeFn = (ticketId: string) => Promise<{ ok: boolean; reason?: string; latencyMs?: number }>;

/** 默认 stub：永远 ok（仅用于 Sprint 11 骨架阶段；真实实现由 codex-D 接 dsh HMR） */
export async function probeStaging(_ticketId: string): Promise<{ ok: boolean; reason?: string; latencyMs?: number }> {
  return { ok: true, reason: 'stub', latencyMs: 0 };
}

/**
 * 单次探针结果记录：成功 / 失败按阈值推进 phase。
 * 返回最新 phase（可能变为 HEALTHY / DISABLED）。
 */
export async function recordProbeResult(
  ctx: MountContext,
  ticketId: string,
  ok: boolean,
  reason?: string,
  latencyMs?: number,
  cfg: ProbeConfig = DEFAULT_PROBE_CONFIG,
): Promise<{ phase: string; consecutiveSuccess: number; consecutiveFailure: number }> {
  // 1) 查 ticket
  const tt = ctx.tables?.tickets;
  if (!tt) throw new Error('health-probe: tickets table unavailable');
  const entry = await tt.get(`t-${ticketId}`);
  if (!entry) throw new Error(`health-probe: ticket ${ticketId} not found`);

  // 2) 写 probe_history
  const ph = ctx.tables?.probe_history;
  if (ph) {
    const probeEntry = packProbe({ ticketId, at: nowIso(), ok, reason, latencyMs });
    await ph.put(probeEntry.id, probeEntry);
  }

  // 3) 更新 tickets.probeStats
  const prevStats = (entry as any).probeStats || {
    consecutiveSuccess: 0, consecutiveFailure: 0, lastProbeAt: null, lastReason: undefined,
  };
  const nextStats = {
    consecutiveSuccess: ok ? prevStats.consecutiveSuccess + 1 : 0,
    consecutiveFailure: ok ? 0 : prevStats.consecutiveFailure + 1,
    lastProbeAt: nowIso(),
    lastReason: reason,
  };
  let nextPhase = (entry as any).phase as string;

  // 4) 阈值判定（不破坏 FROZEN phase 集）
  if (nextStats.consecutiveSuccess >= cfg.successThreshold && nextPhase === 'ACTIVATED') {
    nextPhase = 'HEALTHY';
  } else if (nextStats.consecutiveFailure >= cfg.failureThreshold && PHASES.includes(nextPhase)) {
    nextPhase = 'DISABLED';
  }

  const updated = { ...entry, probeStats: nextStats, phase: nextPhase, updatedAt: nowIso() };
  await tt.put(updated.id, updated);

  // 5) DISABLE 触发：emit mount.failed + evolution 留痕
  if (nextPhase === 'DISABLED' && (entry as any).phase !== 'DISABLED') {
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
    } catch { /* 软依赖失败忽略 */ }
    try { ctx.emitEvent?.('mount.failed', { ticketId, fromPhase: 'ACTIVATED', reason: 'probe-consecutive-failure', actions: [] }); }
    catch { /* event 通道失败忽略 */ }
  }

  return { phase: nextPhase, consecutiveSuccess: nextStats.consecutiveSuccess, consecutiveFailure: nextStats.consecutiveFailure };
}

/**
 * 启动探针循环（per ticket）。返回 disposer 供 ctx.effect 注册。
 *
 * 注意：本函数不直接调 setInterval；循环交给 ctx.effect 的 onTick 适配器。
 * Sprint 11 骨架阶段返回 start/stop 函数对象，由 index.ts 在 ctx.effect 内调用 setInterval。
 */
export interface ProbeLoop {
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

export function makeProbeLoop(
  ctx: MountContext,
  ticketId: string,
  probeFn: ProbeFn,
  cfg: ProbeConfig = DEFAULT_PROBE_CONFIG,
  onPhaseChange?: (phase: string) => void,
): ProbeLoop {
  let running = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (!running) return;
    try {
      const r = await probeFn(ticketId);
      const out = await recordProbeResult(ctx, ticketId, r.ok, r.reason, r.latencyMs, cfg);
      onPhaseChange?.(out.phase);
      if (out.phase === 'HEALTHY' || out.phase === 'DISABLED') {
        // 终态自动停探针
        stop();
      }
    } catch (e: any) {
      // 探针自身抛错视为失败 +1
      await recordProbeResult(ctx, ticketId, false, `probe-throw:${e.message}`, undefined, cfg).catch(() => {});
    }
  };

  function start() {
    if (running) return;
    running = true;
    timer = setInterval(tick, cfg.intervalMs);
    // 立刻跑一次，不等第一个 interval
    void tick();
  }
  function stop() {
    running = false;
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { start, stop, isRunning: () => running };
}
