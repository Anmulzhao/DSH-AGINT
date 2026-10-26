/**
 * agint-input-gateway/lib/zero-hit.js — 通道零命中告警（2026-10-14）。
 *
 * 为什么需要它（两个真实案例，都是我亲手撞到的）：
 *   1. self-observation 的 detectToolAnomaly 因 `else { break; }` 恒不触发，
 *      而 health() 报 5 个检测器全 active=true、force_fetch 报 ok=true in=0
 *      —— 一切看起来健康，实则产不出信号。
 *   2. dream 侧 2026-09-10 因宿主改会话日志命名连续 7 天扫到 0 个会话，
 *      dream_status 仍报 validation=OK。
 *
 * 两者是同一类病：**「没扫到东西」与「扫到了但没过关」在返回里长得一模一样**。
 *
 * 设计取舍 —— 与 agint-dream/lib/health.js 同型（照最近的先例做，不自创）：
 *   - 判据是**纯规则**（连续计数 ≥ 阈值），机器可判、可回放，不引入 LLM；
 *   - **不阻断** fetch —— 观察层，只标记 + 落盘 + warn。
 *     ⛔ 告警杀死被告警对象是这类代码的经典自伤；
 *   - 带 kill-switch（`enabled`）与可调阈值（`threshold`），均可运行时关闭；
 *   - 状态**必须落盘**：内存计数会在进程重启时归零 ⇒ 永远等不到告警，
 *     等于把告警做成摆设。这里落在 channel_state 表（随 gateway 持久化）；
 *   - 读写失败一律 fail-open，绝不让告警链路把 fetch 搞挂。
 */

/** 连续零命中达到该次数才告警。
 *  取 3 而非 1：单次零命中可能只是这段时间没活动；连续 3 次基本是检测器坏了。
 *  与 dream 的 DEFAULT_ZERO_HIT_THRESHOLD 同值，便于两侧口径对齐。 */
export const DEFAULT_ZERO_HIT_THRESHOLD = 3;

/**
 * 纯函数：把一次 fetch 的产出情况并入状态。
 *
 * @param {object|null} prev 上一次状态（首次传 undefined/null）
 * @param {{emitted: number, nowIso?: string}} args
 * @returns {object} 新状态（不改入参）
 */
export function updateZeroHitState(prev, { emitted, nowIso } = {}) {
  const s = prev ?? {};
  const now = nowIso ?? new Date().toISOString();
  const hit = Number(emitted) > 0;
  return {
    consecutiveZeroHit: hit ? 0 : (s.consecutiveZeroHit ?? 0) + 1,
    lastNonZeroAt: hit ? now : (s.lastNonZeroAt ?? null),
  };
}

/**
 * 纯函数：状态 → 健康判定。
 *
 * @param {object|null} state
 * @param {{threshold?: number, enabled?: boolean}} opts
 * @returns {{status:'ok'|'degraded', consecutiveZeroHit:number, threshold:number,
 *            enabled:boolean, lastNonZeroAt:string|null, reason:string|null}}
 */
export function evaluateZeroHit(state, opts = {}) {
  const { threshold = DEFAULT_ZERO_HIT_THRESHOLD, enabled = true } = opts;
  const n = state?.consecutiveZeroHit ?? 0;
  const degraded = enabled === true && n >= threshold;
  return {
    status: degraded ? 'degraded' : 'ok',
    consecutiveZeroHit: n,
    threshold,
    enabled: enabled !== false,
    lastNonZeroAt: state?.lastNonZeroAt ?? null,
    reason: degraded
      ? `连续 ${n} 次 fetch 产出 0 条信号（阈值 ${threshold}）—— 该通道的检测器可能已静默失明，检查判据与真实存储形状是否对齐`
      : null,
  };
}

/**
 * 从 channel_state 记录里取出零命中子状态。
 * 字段缺失一律按初始态处理（fail-open，兼容存量记录）。
 */
export function readZeroHitState(channelState) {
  return {
    consecutiveZeroHit: channelState?.consecutiveZeroHit ?? 0,
    lastNonZeroAt: channelState?.lastNonZeroAt ?? null,
  };
}
