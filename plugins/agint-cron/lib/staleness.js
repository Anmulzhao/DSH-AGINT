/**
 * agint-cron: 调度时效的两维度判定（纯函数，零 IO、零依赖）。
 *
 * 为什么要拆维度（提案 cdf41d63，2026-11-08）：
 *   原来只有「过期未跑」一个口径（`issues`），跨过阈值时计数会**瞬移**——
 *   metrics_summary 的 cron.staleJobs 在 series 里同一分钟出现过 7 和 3 两个值，
 *   delta 因此失去意义。拆成两个维度后，每次变化都能归因到具体成因。
 *
 * 口径（改这里等于改判据，改前先想清楚）：
 *   staleOverdue  过期未跑：距「本该触发的时刻」超过半个调度窗口。
 *                  从不运行的 job 按「启动后超过 2 个固定窗口」判（历史语义，不动）。
 *   staleInactive 久未活动：距上次运行超过 2 个调度周期。
 *                  从不运行的 job 从「宿主启动时刻」起算。
 *
 * ⛔ 两维度的关系（实测推导，别想当然）：对**跑过**的 job，
 *   staleInactive ⇒ staleOverdue（idle > 2P 必然 > 1.5P 的过期阈值）。
 *   即「久未活动」是「过期未跑」的**严格子集**，不新增计数，只标注严重程度。
 *   真正新增信号的是**从未运行**的 job：过期通道对它们用固定的 7 天窗口兜底，
 *   而久未活动用真实周期（P），所以「每日任务从没跑过」会被本维度抓到。
 */

/** 久未活动的判定倍数：距上次运行 > 2 × 调度周期。 */
export const INACTIVE_PERIOD_FACTOR = 2;

/** 算不出下一次触发时刻时的兜底周期（7 天，与历史 windowMs 兜底一致）。 */
export const FALLBACK_PERIOD_MS = 7 * 86_400_000;

/**
 * 判定一个 job 的「久未活动」。
 *
 * @param {object} p
 * @param {number} p.now 当前时刻（epoch ms）
 * @param {number|null} p.lastRunAt 上次运行时刻（epoch ms）；null = 从未运行
 * @param {number} p.bootTime 宿主启动时刻（epoch ms）
 * @param {number|null} p.expectedNextRunAt 下一次应触发的时刻（epoch ms）；null = 算不出
 * @returns {{staleInactive: boolean, inactiveMs: number, periodMs: number}}
 */
export function classifyInactivity({ now, lastRunAt, bootTime, expectedNextRunAt }) {
  const last = lastRunAt ?? bootTime;
  // 周期 = 相邻两次触发的间隔（expectedNextRunAt 是从 last 推出来的下一次）。
  const periodMs = expectedNextRunAt ? Math.max(1, expectedNextRunAt - last) : FALLBACK_PERIOD_MS;
  const inactiveMs = now - last;
  return {
    staleInactive: inactiveMs > periodMs * INACTIVE_PERIOD_FACTOR,
    inactiveMs,
    periodMs,
  };
}
