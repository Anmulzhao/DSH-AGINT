/**
 * agint-executor/lib/verdict.js —— 一次自动执行的**终局判决判据**（2026-11-08）。
 *
 * ## 它补的是哪个洞
 *
 * 老板 2026-11-08 要求：执行器要么给出执行结果，要么给出最终判决并结案。
 * 此前执行器只在「跑成了」和「没跑成」之间二选一。失败的提案留在
 * `status=approved + execState=failed`，没有自动出口。实测生产存储
 * （2026-11-08）：2 条这样的悬案、37 条 failed 执行行、0 条 deferred。
 *
 * ## 为什么判决必须是纯函数
 *
 * 提案 `cdf41d63` 的第一次失败（11-04）是 LLM 判「没有可改的目标」。那条提案
 * 横跨 cron 核心、metrics 与文档，实际可改，LLM 判否。把判决再交给 LLM，
 * 等于把同一个不可靠环节复制一遍。
 *
 * ⇒ 本文件只认**结构化证据**：driver 的 deterministic 标志、执行行的错误原文、
 *    尝试次数、环境顺延次数。不调 LLM、不读时钟、不碰存储、不改入参。
 *
 * ⛔ 枚举与 agint-evolve/lib/execution.js 的 EXEC_VERDICTS 逐字一致。
 *    改一处必须改另一处；等价关系由 test/verdict.test.mjs 的断言钉住。
 *
 * ## 不判什么
 *
 * `applied` / `partial` 由成功路径产生（agint-evolve.finishExecution），
 * 本文件不生成它们。`decideVerdict()` 返回 `null` 表示「还没到终局」：
 * 继续重试、继续顺延，或者继续跑下一个单元。
 */

import { isEnvironmentFailure } from './env.js';

/** 全部判决。顺序与 EXEC_VERDICTS 一致。 */
export const VERDICTS = Object.freeze([
  'applied',
  'partial',
  'not-actionable',
  'exhausted',
  'env-blocked',
  'interrupted',
]);

/** 会落终态（settleExecution → status=wontfix）的判决。applied/partial 不在内。 */
export const TERMINAL_VERDICTS = Object.freeze([
  'not-actionable',
  'exhausted',
  'env-blocked',
  'interrupted',
]);

/**
 * 「重试不会变」的特征串。判据取自 driver 真实抛出的文本与生产存储里的错误原文，
 * 不是猜的。与 lib/env.js 刻意互补：那边明确**不收**这类串，由 driver 判
 * deterministic；这边负责把同样的失败归成 not-actionable 判决。
 */
const NOT_ACTIONABLE_PATTERNS = [
  /not-actionable/i,
  /no target asset resolved/i,
  /no target produced an applicable edit/i,
  /没有可改的目标/i,
  /llm judged not applicable/i,
  /oldText not found/i,
  /fabricated/i,
  /validate rejected/i,
  // 事务门：同 scope 已有 PENDING proposal。生产 04d6199c 的原文。
  /已有 PENDING proposal/i,
  /同 scope 只允许 1 条 PENDING/i,
];

/** 「被宿主重启 / 进程中断打断」的特征串。生产 531e2631 的原文。 */
const INTERRUPTED_PATTERNS = [
  /宿主重启/,
  /进程中断/,
  /孤儿执行/,
  /本次执行未结算/,
];

/** 这条错误原文是不是「重试不会变」。 */
export function isNotActionable(text) {
  const s = String(text ?? '');
  if (s === '') return false;
  return NOT_ACTIONABLE_PATTERNS.some((re) => re.test(s));
}

/** 这条错误原文是不是「被中断打断」。 */
export function isInterrupted(text) {
  const s = String(text ?? '');
  if (s === '') return false;
  return INTERRUPTED_PATTERNS.some((re) => re.test(s));
}

/** 这个判决要不要把提案落到终态。 */
export function isTerminalVerdict(v) {
  return TERMINAL_VERDICTS.includes(String(v));
}

/**
 * 一次执行跑完后，判它是不是终局。
 *
 * 判据优先级不能改：
 *   ① deterministic / 不可执行 → not-actionable（重试无用）
 *   ② 中断            → interrupted（不是提案的错，但这次执行已终结）
 *   ③ 环境故障        → 顺延到上限才 env-blocked，否则 null
 *   ④ 其它失败        → 额度用尽才 exhausted，否则 null
 *
 * ⚠️ ② 必须排在 ③ 前：孤儿回收的文案带「宿主重启」，不含环境特征串；
 *    但反过来「llm unavailable」若被中断文案覆盖会误判，故 ① 最优先。
 *
 * @param {object} o
 * @param {boolean} [o.ok] 这次执行是否成功落地（成功由 finishExecution 结案，这里不判）
 * @param {boolean} [o.deterministic] driver 的确定性判定
 * @param {string}  [o.reason] 失败原因原文
 * @param {number}  [o.attempts] 本次是第几次（claim 后已 +1）
 * @param {number}  [o.maxAttempts] 上限
 * @param {number}  [o.envDeferrals] 这条提案累计环境顺延次数
 * @param {number}  [o.maxEnvDeferrals] 顺延上限
 * @returns {string|null} EXEC_VERDICTS 之一，或 null（还没到终局）
 */
export function decideVerdict({
  ok = false,
  deterministic = false,
  reason = '',
  attempts = 1,
  maxAttempts = 2,
  envDeferrals = 0,
  maxEnvDeferrals = 6,
} = {}) {
  if (ok === true) return null;
  const text = String(reason ?? '');
  if (deterministic === true || isNotActionable(text)) return 'not-actionable';
  if (isInterrupted(text)) return 'interrupted';
  if (isEnvironmentFailure(text)) {
    const n = Number(envDeferrals) || 0;
    const cap = Number(maxEnvDeferrals) || 6;
    return n >= cap ? 'env-blocked' : null;
  }
  const a = Number(attempts) || 0;
  const m = Number(maxAttempts) || 0;
  return m > 0 && a >= m ? 'exhausted' : null;
}

/**
 * 历史悬案判决：从执行行的错误原文反推判决。
 *
 * ⚠️ 只给「不会再自动跑」的行用。调用方（settleUnsettled）必须保证：
 *     执行行最后一条是 failed、提案没有活跃 job、且已过宽限期。
 *
 * ⛔ 认不出归因时不编故事：返回 `exhausted`。依据是「执行行 failed + 无额度」这个
 *    结构化事实，不是对原因的猜测；理由原文会一并写进 execError/note。
 * ⛔ 空原文返回 null（没证据就不判）—— 对应 K117「证据须结构化」与
 *    「没核过必须留痕」。
 *
 * @param {string} text 执行行的 error/reason 原文
 * @returns {string|null}
 */
export function verdictFromError(text) {
  const s = String(text ?? '').trim();
  if (s === '') return null;
  if (isNotActionable(s)) return 'not-actionable';
  if (isInterrupted(s)) return 'interrupted';
  if (isEnvironmentFailure(s)) return 'env-blocked';
  return 'exhausted';
}

/**
 * 这条判决是不是 LLM 的**主观判否**（2026-11-08）。
 *
 * 提案 `cdf41d63` 的 11-04 失败就是 `plugin-preflight: llm judged not applicable`：
 * 提案横跨 cron 核心、metrics 与文档，实际可改，LLM 判否。这类结论不是结构化
 * 事实，不能和「目标文件不存在」「额度用尽」混成同一种口气。
 *
 * ⛔ 本函数不推翻判决（执行器不读仓库、不做目标解析），只给结案文案加一个
 *    「建议复核」的标记，让面板上一眼能区分「机器查出来的」与「模型猜的」。
 *
 * @param {string} text 失败原因原文
 * @returns {boolean}
 */
export function isLlmSubjectiveVerdict(text) {
  const s = String(text ?? '');
  if (s === '') return false;
  return /llm judged not applicable|plugin-preflight:\s*llm judged/i.test(s);
}
