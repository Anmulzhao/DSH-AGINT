/**
 * agint-executor/lib/env.js —— 「这次失败是不是环境的错」的纯判据（无 IO、无时钟）。
 *
 * ## 它补的是哪个洞（2026-11-07 实证，提案 `cdf41d63`）
 *
 * driver 在 LLM 通路失败时**抛错**（`evolution-driver aborted: llm unavailable:
 * stopReason=error`），执行器只把它当一条普通失败：排一次 5 分钟重试，第二次
 * 到点仍失败就 `finishExecution(ok:false)` ⇒ 提案 `execState=failed` ⇒ 面板
 * 「已批准·执行失败·等处理」。
 *
 * 实测后果（2026-11-07）：子代理通道从 11-05 14:35 起全挂，当天 5 条执行行
 * 全部同一个错，每条都烧掉 2 次重试额度，全部被记成**提案失败**。提案本身
 * 一行代码都没改、也一行都没错 —— 是机器没跑起来。
 *
 * ⇒ 环境故障必须与提案失败分开记账：
 *    · 提案失败：这条提案有问题，要人看。
 *    · 环境故障：机器暂时不可用，等它好，**不消耗**提案的重试额度。
 *
 * ## 为什么判据要单独成文件
 *
 * 同一套判据会被执行器（记账）、面板（显示）、周报（归因）三处问。判据散成
 * 三份就会出现「面板说环境、周报说提案」的自相矛盾。plan.js 那份已经踩过。
 *
 * ⛔ 本文件不读 env、不拿 Date.now()：时间一律由调用方传。
 */

/**
 * 环境级故障的特征串。
 *
 * 判据来源是 driver 真实抛出的文本（`plugins/agint-evolution-driver/lib/index.js`
 * 的 `spawnLlm` 与 `runOnce`），不是猜的：
 *   · `llm unavailable: stopReason=error` —— 子代理 turn 未正常结束
 *   · `agents service missing` / `subagents method missing` —— 宿主能力没挂上
 *   · `timeout after Nms` —— 模型慢，撞了 driver 的超时闸
 *   · 网络类 —— provider 端不可达
 *
 * ⛔ 刻意**不**收 /oldText not found|not applicable|fabricated|validate rejected/
 *    这类：那是 LLM 的产出不合格，是这条提案/这次编辑的问题，重试无用。它们由
 *    driver 判 deterministic，走收口路径，不许在这里被当成环境故障放行。
 */
const ENVIRONMENT_PATTERNS = [
  /llm unavailable/i,
  /stopReason=error/i,
  /llm error:/i,
  /agents service missing/i,
  /subagents service missing/i,
  /subagents method missing/i,
  /spawn provider not registered/i,
  /timeout after \d+ms/i,
  /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i,
  /\b(429|503|502)\b/,
];

/**
 * 这次失败是否可以归因到「环境暂时不可用」。
 *
 * @param {string} text 失败原因（driver 的 reason 或抛错文本）
 * @returns {boolean}
 */
export function isEnvironmentFailure(text) {
  const s = String(text ?? '');
  if (s === '') return false;
  return ENVIRONMENT_PATTERNS.some((re) => re.test(s));
}

/**
 * 环境故障的退避间隔：base → 2×base → 4×base …，封顶 maxMs。
 *
 * ⛔ 与普通重试（固定 `retryDelayMs`）刻意不同：LLM 通道挂掉的恢复时间通常是
 *    分钟到小时级，固定 5 分钟只会在故障期里反复撞墙。指数退避让「通道一直坏」
 *    的代价从「每 5 分钟烧一次」降到「半小时一次」。
 *
 * @param {number} attempts 本次是第几次（claim 后已 +1，最小按 1 算）
 * @param {number} baseMs 首次退避
 * @param {number} maxMs 上限
 * @returns {number} 毫秒
 */
export function envBackoffMs(attempts, baseMs, maxMs) {
  const base = Number(baseMs) > 0 ? Number(baseMs) : 5 * 60_000;
  const cap = Number(maxMs) > 0 ? Number(maxMs) : 30 * 60_000;
  const n = Math.max(1, Math.min(20, Math.trunc(Number(attempts) || 1)));
  const wait = base * 2 ** (n - 1);
  return Math.min(Math.round(wait), Math.round(cap));
}
