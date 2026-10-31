/**
 * agint-executor/lib/week.js —— 自然周边界。
 *
 * ⛔ 为什么不 import `agint-evolve/lib/execution.js` 里的同名函数：
 *    本仓的硬约定是**跨插件不许直接 import**（部署位上两个插件虽然同目录，
 *    但一次单侧升级就会让另一侧的 import 路径失效 ⇒ 整个 preset 起不来，
 *    而症状只是"某个插件没挂上"）。家族面板对 `proposalBlocked()` 也是这么处理的：
 *    各自保留一份等价实现，由两端用例钉住口径一致。
 *    一致性由 `test/week-parity.test.mjs` 对着 evolve 的导出验，不靠人工记忆。
 */

/** 本周起点（周一 00:00 本地时间）的毫秒时间戳。 */
export function startOfWeek(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0=Sun
  const back = (dow + 6) % 7; // 周一=0 … 周日=6
  d.setDate(d.getDate() - back);
  return d.getTime();
}

/** 下一个自然周起点（ISO）。 */
export function nextWeekStart(now = Date.now()) {
  const d = new Date(startOfWeek(now));
  d.setDate(d.getDate() + 7);
  return d.toISOString();
}
