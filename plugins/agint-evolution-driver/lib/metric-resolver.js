/**
 * agint-evolution-driver —— metric-resolver.js
 *
 * Phase 1.1 支点 1a 补片（方案②）：把 `targetMetric` 从**提案自己声明的期望**里读出来。
 *
 * ## 它补的是哪个洞
 *
 * 实测链（2026-10-03）：`agint-mutator/lib/index.js:128` 要 `expectedEffect: z.string()`
 * （FROZEN 契约，例 `'baseline 通过率 >= 95% 在 7 天'`），而
 * `agint-population/lib/index.js:173` 只认 `typeof proposal.expectedEffect === 'object'`，
 * 否则落兜底 `{ metric: 'unspecified' }`。⇒ 实时路径的 `variant.expected_effect.metric`
 * **恒为 'unspecified'** ⇒ `DEFAULT_RULE_TABLE` 查不到条目 ⇒ 每周期
 * `NO_PREDICTION_AVAILABLE` ⇒ 1a 接好线也不产生一条锁。
 *
 * ## 为什么是"读"而不是"补"
 *
 * ⛔ 不替提案编一个指标。唯一的输入是 `proposal.expectedEffect` 这串**提案自己写的**
 * 可证伪期望（mutator 的 `VALIDATE_EXPECTED_RE` 强制它带 `<指标> >= <数> 在 <N> 天`）。
 * 本模块只做一件事：把串里点名的指标归到 FROZEN 四类之一。
 * 两条判红规则：
 *
 * 1. **一个都不匹配** ⇒ `null`（`METRIC_UNSTATED`）—— 期望没点名指标，不猜。
 * 2. **匹配到两类以上** ⇒ `null`（`METRIC_AMBIGUOUS`）+ `matched` 列出全部命中，
 *    让"到底歧义在哪"事后看得见。
 *
 * 规则 2 比"取第一个命中"更烦人，但那是唯一不引入偏置的做法：关键词表顺序
 * 一旦决定成败，就是**表的顺序**在替系统做预测，不是提案在说它要改什么。
 *
 * ## 出处必须分栏
 *
 * 返回值带 `source`：`VARIANT`（variant 行本来就记着指标，照常）/
 * `EXPECTED_EFFECT`（本模块从期望串解析出来的）。调用方要把 source 一并落进
 * `cycle.summary` —— 报告里"有多少预测建立在解析出的指标上"必须是能查的数，
 * 不能靠读代码反推。
 */

/** 关键词表：封闭、单向、无优先级含义（顺序不决定成败，见文件头规则 2）。 */
export const METRIC_KEYWORDS = Object.freeze({
  SUCCESS_RATE: Object.freeze(['成功率', '通过率', '达标率', 'success rate', 'pass rate']),
  TOKEN_EFFICIENCY: Object.freeze(['token', '令牌', '上下文长度']),
  LATENCY: Object.freeze(['延迟', '时延', '耗时', '响应时间', 'latency']),
  REGRESSION: Object.freeze(['回归', 'regression']),
});

/** 四类指标 —— 与 `predictor.js` 的 DEFAULT_RULE_TABLE 列名同一份清单。 */
export const RESOLVABLE_METRICS = Object.freeze(Object.keys(METRIC_KEYWORDS));

/** population 兜底值：它不是指标，是"没定指标"的记号。 */
const PLACEHOLDER_METRIC = 'unspecified';

export const METRIC_SOURCE = Object.freeze({
  VARIANT: 'VARIANT',
  EXPECTED_EFFECT: 'EXPECTED_EFFECT',
});

/** variant 行里的指标算不算"真的定过"。 */
function usableVariantMetric(metric) {
  return typeof metric === 'string' && metric.trim() !== '' && metric !== PLACEHOLDER_METRIC;
}

/**
 * 从期望串里解析指标。
 *
 * @param {string} expectedEffect 提案自带的可证伪期望（mutator FROZEN 字段）
 * @returns {{metric: string|null, reason: string|null, matched: string[]}}
 */
export function matchMetricFromExpectedEffect(expectedEffect) {
  if (typeof expectedEffect !== 'string' || expectedEffect.trim() === '') {
    return { metric: null, reason: 'NO_EXPECTED_EFFECT', matched: [] };
  }
  // 中文关键词不受大小写影响；ASCII 词条统一按小写比对（'Token 用量' 也要命中）。
  const text = expectedEffect.toLowerCase();
  const matched = [];
  for (const metric of RESOLVABLE_METRICS) {
    if (METRIC_KEYWORDS[metric].some((kw) => text.includes(kw.toLowerCase()))) {
      matched.push(metric);
    }
  }
  if (matched.length === 0) {
    return { metric: null, reason: 'METRIC_UNSTATED', matched: [] };
  }
  if (matched.length > 1) {
    return { metric: null, reason: 'METRIC_AMBIGUOUS', matched };
  }
  return { metric: matched[0], reason: null, matched };
}

/**
 * 定出这次进化要预测哪个指标。
 *
 * 优先级只有一条：**variant 行记过指标就用它**，本模块不插手；
 * 只有 variant 落兜底（'unspecified' / 空）才去读期望串。
 * 这样接线不会改变任何"本来就定过指标"的进化的行为。
 *
 * @param {object} input
 * @param {string|null|undefined} input.variantMetric  variant.expected_effect.metric
 * @param {string|null|undefined} input.expectedEffect proposal.expectedEffect（字符串）
 * @returns {{metric: string|null, source: string|null, reason: string|null, matched: string[]}}
 */
export function resolveTargetMetric({ variantMetric, expectedEffect } = {}) {
  if (usableVariantMetric(variantMetric)) {
    return { metric: variantMetric, source: METRIC_SOURCE.VARIANT, reason: null, matched: [] };
  }
  const m = matchMetricFromExpectedEffect(expectedEffect);
  if (!m.metric) {
    // 解析不出来时把原因原样交出去：调用方要么留 null（诚实），要么显式标 NO_PREDICTION。
    return { metric: null, source: null, reason: m.reason, matched: m.matched };
  }
  return { metric: m.metric, source: METRIC_SOURCE.EXPECTED_EFFECT, reason: null, matched: m.matched };
}

export default { resolveTargetMetric, matchMetricFromExpectedEffect, METRIC_KEYWORDS, METRIC_SOURCE };
