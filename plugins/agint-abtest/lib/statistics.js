/**
 * agint-abtest v0.6.4 — Sprint 10 #9b
 *
 * 4 个统计纯函数（设计稿 §二.6 + AGINT Sprint 10 #9b）：
 *   - welchTTest(samplesA, samplesB)  → { t, df, pValue }
 *   - bonferroniAdjust(alpha, k)      → adjustedAlpha
 *   - cohensD(samplesA, samplesB)     → number
 *   - decideWinner({...})             → { winner, pValue, effectSize, samples, reason }
 *
 * 约束：不依赖第三方统计库；normal CDF 用 Abramowitz & Stegun 7.1.26 近似
 *       （误差 < 7.5e-8，对 z ∈ [0, ∞) 单调递增，pValue 用 2*(1-normalCdf(|t|))）。
 */

function sum(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s;
}

function meanVar(arr) {
  const n = arr.length;
  if (n === 0) return { mean: 0, variance: 0 };
  const m = sum(arr) / n;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const d = arr[i] - m;
    acc += d * d;
  }
  return { mean: m, variance: n > 1 ? acc / (n - 1) : 0 };
}

// Abramowitz & Stegun 7.1.26 — error < 7.5e-8
function normalCdf(z) {
  if (z < 0) return 1 - normalCdf(-z);
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989422804014327 * Math.exp(-z * z / 2); // 1/sqrt(2π)
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return 1 - p;
}

// ── welchTTest ────────────────────────────────────────────────────────
export function welchTTest(samplesA, samplesB) {
  const a = Array.isArray(samplesA) ? samplesA : [];
  const b = Array.isArray(samplesB) ? samplesB : [];
  const nA = a.length, nB = b.length;
  if (nA < 2 || nB < 2) return { t: 0, df: 0, pValue: 1 };
  const ma = meanVar(a), mb = meanVar(b);
  const vA = ma.variance, vB = mb.variance;
  if (vA + vB === 0) return { t: 0, df: 0, pValue: 1 };
  const se2 = vA / nA + vB / nB;
  const se = Math.sqrt(se2);
  const t = (ma.mean - mb.mean) / se;
  const df = (se2 * se2) / ((vA * vA) / ((nA - 1) * nA * nA) + (vB * vB) / ((nB - 1) * nB * nB));
  const pValue = 2 * (1 - normalCdf(Math.abs(t)));
  return { t, df, pValue };
}

// ── bonferroniAdjust ──────────────────────────────────────────────────
export function bonferroniAdjust(alpha, numTests) {
  if (!Number.isFinite(numTests) || numTests <= 0) return alpha;
  return alpha / numTests;
}

// ── cohensD ───────────────────────────────────────────────────────────
export function cohensD(samplesA, samplesB) {
  const a = Array.isArray(samplesA) ? samplesA : [];
  const b = Array.isArray(samplesB) ? samplesB : [];
  const nA = a.length, nB = b.length;
  if (nA + nB < 3) return 0;
  const ma = meanVar(a), mb = meanVar(b);
  const pooledVar = ((nA - 1) * ma.variance + (nB - 1) * mb.variance) / (nA + nB - 2);
  if (pooledVar <= 0) return 0;
  return (ma.mean - mb.mean) / Math.sqrt(pooledVar);
}

// ── decideWinner ──────────────────────────────────────────────────────
export function decideWinner({ samplesA, samplesB, threshold = 0.05, taskSuite = [] }) {
  const a = Array.isArray(samplesA) ? samplesA : [];
  const b = Array.isArray(samplesB) ? samplesB : [];
  const nA = a.length, nB = b.length;
  const samples = nA + nB;
  if (nA < 10 || nB < 10) {
    return { winner: 'inconclusive', pValue: 1, effectSize: 0, samples, reason: 'samples < 10' };
  }
  const adjustedAlpha = bonferroniAdjust(threshold, taskSuite.length);
  const { pValue } = welchTTest(a, b);
  const effectSize = cohensD(a, b);
  const meanA = meanVar(a).mean;
  const meanB = meanVar(b).mean;
  if (pValue >= adjustedAlpha) {
    return { winner: 'inconclusive', pValue, effectSize, samples, reason: 'pValue >= adjustedAlpha' };
  }
  if (Math.abs(effectSize) < 0.3) {
    return { winner: 'inconclusive', pValue, effectSize, samples, reason: 'effectSize < 0.3' };
  }
  return { winner: meanA > meanB ? 'A' : 'B', pValue, effectSize, samples, reason: 'winner' };
}