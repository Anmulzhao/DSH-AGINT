/**
 * agint-abtest v0.7.0 — 统计修复（方案 v2.1 §八，老板 2026-11-18 拍板）
 *
 * v0.6.4 → v0.7.0 修复四处：
 *   1. p 值改 t 分布 CDF（不完全贝塔连分式），不再用正态近似（小样本假阳性）。
 *   2. 零方差 epsilon 护栏：浮点噪声方差（常数组 meanVar ~1e-32）不得造出假显著。
 *   3. Bonferroni 按 numExperiments（同时判定的实验数），不再除任务数。
 *   4. 新增 decideWinnerPaired：同任务 A/B 配对差值单样本 t 检验（report 主路径）。
 *
 * 约束：不依赖第三方统计库。
 *   - logGamma 用 Lanczos 近似（g=7, n=9 系数）
 *   - 正则不完全贝塔 I_x(a,b) 用连分式（Numerical Recipes betacf），
 *     x > (a+1)/(a+b+2) 时走对称式 I_x(a,b) = 1 − I_{1−x}(b,a) 保证收敛
 *   - t 双尾 p = I_x(df/2, 1/2)，x = df/(df+t²)
 */

// 方差低于此值视为零方差（score ∈ [0,1]，浮点噪声 ~1e-32，真实差异 ≥1e-6 量级）
const VAR_EPS = 1e-12;

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

// ── t 分布 CDF（不完全贝塔）────────────────────────────────────────────

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

function logGamma(z) {
  if (z < 0.5) {
    // 反射公式 Γ(z)Γ(1−z) = π/sin(πz)
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < LANCZOS.length; i++) x += LANCZOS[i] / (z + i + 1);
  const t = z + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function betacf(a, b, x) {
  const FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}

/** 正则不完全贝塔 I_x(a,b) */
function regIncBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** t 分布双尾 p 值：p = I_x(df/2, 1/2)，x = df/(df+t²) */
export function tTwoTailedP(t, df) {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return 1;
  if (t === 0) return 1;
  const x = df / (df + t * t);
  return regIncBeta(x, df / 2, 0.5);
}

// ── welchTTest ────────────────────────────────────────────────────────
export function welchTTest(samplesA, samplesB) {
  const a = Array.isArray(samplesA) ? samplesA : [];
  const b = Array.isArray(samplesB) ? samplesB : [];
  const nA = a.length, nB = b.length;
  if (nA < 2 || nB < 2) return { t: 0, df: 0, pValue: 1 };
  const ma = meanVar(a), mb = meanVar(b);
  const vA = ma.variance, vB = mb.variance;
  if (vA + vB < VAR_EPS) return { t: 0, df: 0, pValue: 1 };
  const se2 = vA / nA + vB / nB;
  const se = Math.sqrt(se2);
  const t = (ma.mean - mb.mean) / se;
  const df = (se2 * se2) / ((vA * vA) / ((nA - 1) * nA * nA) + (vB * vB) / ((nB - 1) * nB * nB));
  const pValue = tTwoTailedP(t, df);
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
  if (pooledVar < VAR_EPS) return 0;
  return (ma.mean - mb.mean) / Math.sqrt(pooledVar);
}

// ── decideWinner（独立样本，保留兼容；report 主路径已切配对）───────────
export function decideWinner({ samplesA, samplesB, threshold = 0.05, taskSuite = [], numExperiments = 1 }) {
  const a = Array.isArray(samplesA) ? samplesA : [];
  const b = Array.isArray(samplesB) ? samplesB : [];
  const nA = a.length, nB = b.length;
  const samples = nA + nB;
  if (nA < 10 || nB < 10) {
    return { winner: 'inconclusive', pValue: 1, effectSize: 0, samples, reason: 'samples < 10' };
  }
  // Bonferroni 按同时判定的实验数（v0.7.0 修复：不再除任务数——每实验只有 1 个假设）。
  // taskSuite 参数保留兼容旧调用方，不参与校正。
  const adjustedAlpha = bonferroniAdjust(threshold, numExperiments);
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

// ── decideWinnerPaired（v0.7.0 新增：配对差值单样本 t）─────────────────
// pairs: [{ taskId, scoreA, scoreB }] —— 只纳入同任务 A/B 都有分的配对。
// d_i = scoreA_i − scoreB_i；检验 mean(d) vs 0；Cohen's d = mean(d)/sd(d)。
export function decideWinnerPaired({ pairs, threshold = 0.05, numExperiments = 1 }) {
  const ps = Array.isArray(pairs) ? pairs : [];
  const n = ps.length;
  const samples = n * 2;
  if (n < 10) {
    return { winner: 'inconclusive', pValue: 1, effectSize: 0, samples, reason: 'pairs < 10' };
  }
  const diffs = ps.map((p) => p.scoreA - p.scoreB);
  const { mean, variance } = meanVar(diffs);
  if (variance < VAR_EPS) {
    return { winner: 'inconclusive', pValue: 1, effectSize: 0, samples, reason: 'zero diff variance' };
  }
  const se = Math.sqrt(variance / n);
  const t = mean / se;
  const df = n - 1;
  const pValue = tTwoTailedP(t, df);
  const effectSize = mean / Math.sqrt(variance);
  const adjustedAlpha = bonferroniAdjust(threshold, numExperiments);
  if (pValue >= adjustedAlpha) {
    return { winner: 'inconclusive', pValue, effectSize, samples, reason: 'pValue >= adjustedAlpha' };
  }
  if (Math.abs(effectSize) < 0.3) {
    return { winner: 'inconclusive', pValue, effectSize, samples, reason: 'effectSize < 0.3' };
  }
  return { winner: mean > 0 ? 'A' : 'B', pValue, effectSize, samples, reason: 'winner' };
}