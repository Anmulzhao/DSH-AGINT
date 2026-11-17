/**
 * agint-quality-policy/lib/crossCapabilityGuard.js — 跨能力回归门
 *
 * 来源：RSI-Env（arXiv 2611.01736）表 1。Knowledge Self 让 SimpleQA
 * 从 82.0 涨到 88.0 的同时，GPQA Diamond 从 65.2 掉到 53.0，
 * Terminal-Bench 2.1 从 12.4 掉到 5.6。Open-General Self 也让 GPQA
 * 涨 8.0 的同时 SimpleQA 掉 4.8。只盯目标维度的门禁会放行
 * 「拆东墙补西墙」的改进。
 *
 * 分工：本模块只判「非目标维度是否退化」。
 * 它不替代 composite score，也不替代 falseHarmonyDetector ——
 * 后者检测的是评估器行为异常（决策一致、放水、退化漏报），
 * 不检测单期改进造成的跨能力退化（2026-11-11 读函数体核实）。
 *
 * 分数口径：dimension.score.score，0..1，与 agint-quality-eval/lib/evaluators.js 一致。
 *
 * 四条纪律（Γ 契约，见 docs/specs/evolution-contract-v1.md）：
 *   1. 预测绝不填补缺失证据。
 *   2. 「没测过」不等于「没退化」。
 *   3. 没核过必须留痕（unmeasured 带 reason，不静默当 stable）。
 *   4. 真实基线由调用方给，本函数不自己造数、不拿 0 占位。
 */

export const DEFAULT_CROSS_CAPABILITY_CONFIG = {
  // 允许的下降幅度。0.10 = 10 个百分点（0..1 口径）。
  dropThreshold: 0.10,
};

/**
 * @param {object} args
 * @param {object|null} args.baseline        改前各维度分数 { [key]: number }
 * @param {object|null} args.current         改后各维度分数 { [key]: number }
 * @param {string[]}    args.targetDimensions 本轮改进的目标维度 key
 * @param {number}      args.dropThreshold   允许下降幅度，默认 0.10
 * @returns {{ verdict: 'stable'|'regressed'|'unmeasured', reason: string,
 *             regressions: Array, skipped: Array }}
 */
export function detectCrossCapabilityRegression({
  baseline = null,
  current = null,
  targetDimensions = [],
  dropThreshold = DEFAULT_CROSS_CAPABILITY_CONFIG.dropThreshold,
} = {}) {
  // 没声明目标就无法区分「目标维度」与「非目标维度」。不猜。
  if (!Array.isArray(targetDimensions) || targetDimensions.length === 0) {
    return { verdict: 'unmeasured', reason: 'target-dimensions-unspecified', regressions: [], skipped: [] };
  }
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    return { verdict: 'unmeasured', reason: 'baseline-missing', regressions: [], skipped: [] };
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    return { verdict: 'unmeasured', reason: 'current-missing', regressions: [], skipped: [] };
  }

  const targets = new Set(targetDimensions);
  const regressions = [];
  const skipped = [];
  for (const [key, before] of Object.entries(baseline)) {
    if (targets.has(key)) continue;
    const after = current[key];
    if (typeof before !== 'number' || typeof after !== 'number') {
      skipped.push({ dimension: key, reason: after == null ? 'current-missing' : 'non-numeric' });
      continue;
    }
    const delta = after - before;
    if (delta < -Math.abs(dropThreshold)) {
      regressions.push({
        dimension: key,
        before,
        after,
        delta: Math.round(delta * 1000) / 1000,
      });
    }
  }

  // 只要有一个非目标维度没测到，整轮结论就是 unmeasured。
  // 不能拿「其余维度没退化」冒充「全部核过」。
  if (skipped.length > 0) {
    return {
      verdict: 'unmeasured',
      reason: `dimensions-unmeasured:${skipped.map((s) => s.dimension).join(',')}`,
      regressions,
      skipped,
    };
  }
  if (regressions.length > 0) {
    return {
      verdict: 'regressed',
      reason: `non-target-regression:${regressions.map((r) => r.dimension).join(',')}`,
      regressions,
      skipped,
    };
  }
  return { verdict: 'stable', reason: 'no-non-target-regression', regressions, skipped };
}
