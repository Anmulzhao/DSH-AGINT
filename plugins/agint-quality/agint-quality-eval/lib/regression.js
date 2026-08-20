/**
 * agint-quality-eval/lib/regression.js — 退化探测纯函数
 *
 * 设计：
 *   - 纯函数 + 简单算法，unit-testable with node --test
 *   - 不依赖任何 service，纯输入/输出
 *   - Sprint 2 落地；Sprint 3 由 agint-quality-policy 复用做自动决策
 *
 * 三类判定：
 *   1. baseline-regression-suite: 固定 plugin 集评估通过率对比
 *      delta = currentRate - baselineRate
 *      delta < -0.02 → alert 'regression'
 *
 *   2. stagnation-check: 连续 K 次综合分增量 < 0.5 → 停滞
 *      scores = [s1, s2, ..., sN]（按时间升序，最早→最近）
 *      deltas = [s_{i+1} - s_i for i in 0..N-2]
 *      最近 K-1 个 delta 都 < threshold → alert 'stagnation'
 *
 *   3. freeze-state: 触发告警后写 failure-pattern (tags=['freeze'])，
 *      老板手动解冻（清 failure-pattern + setBaseline）
 *
 * 阈值常量（与 ROADMAP P3 §退化探测 + evolution-framework §8 对齐）：
 *   REGRESSION_DELTA_THRESHOLD = -0.02   # 通过率下降 > 2%
 *   STAGNATION_K = 5                    # 连续 5 次评估
 *   STAGNATION_DELTA_THRESHOLD = 0.5    # 增量 < 0.5
 */

/**
 * 固定 baseline 评估 target 集（老板 2026-08-20 拍板：9 个核心 plugin 全覆盖）
 * 选 AGINT 仓本身的 9 个 plugin（不含 quality-eval 自身 + 沙箱 + evolution-memory，
 * 那 3 个是基础设施，eval 自身排除是 contract 自防）。
 */
export const BASELINE_TARGETS = [
  { id: 'agint-memory', kind: 'plugin' },
  { id: 'agint-rules', kind: 'plugin' },
  { id: 'agint-metrics', kind: 'plugin' },
  { id: 'agint-cron', kind: 'plugin' },
  { id: 'agint-dream', kind: 'plugin' },
  { id: 'agint-evolve', kind: 'plugin' },
  { id: 'agint-wiki', kind: 'plugin' },
  { id: 'agint-tool-stats', kind: 'plugin' },
  { id: 'agint-quality-contract', kind: 'plugin' },
];

export const REGRESSION_DELTA_THRESHOLD = -0.02;
export const STAGNATION_K = 5;
export const STAGNATION_DELTA_THRESHOLD = 0.5;

/**
 * Compare current passRate against baseline.
 * Returns { delta, isRegression, threshold }.
 */
export function baselineDelta(currentRate, baselineRate) {
  return {
    delta: currentRate - baselineRate,
    isRegression: (currentRate - baselineRate) < REGRESSION_DELTA_THRESHOLD,
    threshold: REGRESSION_DELTA_THRESHOLD,
  };
}

/**
 * Compute pass rate from a list of per-target results.
 * input: [{ id, ok: boolean, score: number|null }]
 * Returns { passRate, passed, total, failed }.
 */
export function computePassRate(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return { passRate: 0, passed: 0, total: 0, failed: 0 };
  }
  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  return {
    passRate: passed / total,
    passed,
    total,
    failed: total - passed,
  };
}

/**
 * Run baseline-regression-suite comparison.
 * input: { baselineRate: number, currentRate: number }
 * Returns { delta, isRegression, threshold, severity }.
 *
 * severity tiers:
 *   - isRegression=false → 'ok'
 *   - delta < -0.02 (2% drop) → 'warn'
 *   - delta < -0.10 (10% drop) → 'high'
 *   - delta < -0.25 (25% drop) → 'blocker'
 */
export function checkRegression({ baselineRate, currentRate }) {
  const { delta, isRegression, threshold } = baselineDelta(currentRate, baselineRate);
  let severity = 'ok';
  if (delta < -0.25) severity = 'blocker';
  else if (delta < -0.10) severity = 'high';
  else if (delta < threshold) severity = 'warn';
  return { delta, isRegression, threshold, severity };
}

/**
 * Check for stagnation in evolution-log scores.
 * input: { scores: number[] } — sorted ascending by time (oldest → newest)
 * Returns { isStagnated, k, threshold, deltas, recentDeltas, recentMaxDelta }.
 *
 * Definition: 倒序最近 K-1 个 delta（最新 → 次新）都 < threshold → 停滞。
 * 即"最近 K 次评估都没明显增长"。
 *
 * 注：老板拍板"连续 K=5 次进化 HARM 增量 < 0.5"——按"连续"含义，
 * 我们检查最近 K-1 个 delta（即 K 个 score → K-1 个 delta）。
 */
export function checkStagnation({ scores, k = STAGNATION_K, threshold = STAGNATION_DELTA_THRESHOLD } = {}) {
  if (!Array.isArray(scores) || scores.length < 2) {
    return {
      isStagnated: false,
      k,
      threshold,
      reason: 'insufficient-data',
      deltas: [],
      recentDeltas: [],
      recentMaxDelta: null,
    };
  }

  // Compute deltas (ascending: deltas[i] = scores[i+1] - scores[i])
  const deltas = [];
  for (let i = 0; i < scores.length - 1; i++) {
    deltas.push(scores[i + 1] - scores[i]);
  }

  // 最近 K-1 个 delta（deltas 末尾 K-1 个）
  const window = Math.min(k - 1, deltas.length);
  const recentDeltas = deltas.slice(-window);
  const recentMaxDelta = recentDeltas.length > 0 ? Math.max(...recentDeltas) : null;
  // 全部 < threshold → 停滞（包含负增长 / 零增长）
  const isStagnated = recentDeltas.length >= window && recentDeltas.every((d) => d < threshold);

  return {
    isStagnated,
    k,
    threshold,
    reason: isStagnated ? 'recent-deltas-all-below-threshold' : 'active-growth',
    deltas,
    recentDeltas,
    recentMaxDelta,
  };
}

/**
 * Compute baseline snapshot from historical results.
 * Used by setBaseline() to store the reference point.
 *
 * input: { results: [{ id, ok, score }], capturedAt?: ISO }
 * Returns snapshot record: { passRate, passed, total, failed, targetIds, capturedAt }.
 */
export function makeBaselineSnapshot({ results, capturedAt } = {}) {
  const rate = computePassRate(results ?? []);
  return {
    passRate: rate.passRate,
    passed: rate.passed,
    total: rate.total,
    failed: rate.failed,
    targetIds: (results ?? []).map((r) => r.id),
    capturedAt: capturedAt ?? new Date().toISOString(),
  };
}

/**
 * Pick a baseline snapshot from history (most recent).
 * input: { history: [{ ...snapshot, capturedAt }] }
 * Returns the latest snapshot or null if history is empty.
 */
export function pickLatestBaseline(history) {
  if (!Array.isArray(history) || history.length === 0) return null;
  return [...history].sort((a, b) => (b.capturedAt ?? '').localeCompare(a.capturedAt ?? ''))[0];
}
