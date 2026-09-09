/**
 * fixture-B-implemented / lib/index.js
 * 真实现 computeComposite（plugin-check dim 10 对照 fixture）
 */
export function computeComposite({ metric_a, metric_b }) {
  // 0.5 * metric_a + 0.5 * metric_b — fixture self-impl
  return 0.5 * metric_a + 0.5 * metric_b;
}