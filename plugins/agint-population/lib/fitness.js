/**
 * agint-population: 6 维适应度函数 + HARM 4 维映射 + safety 硬门控。
 *
 * 设计（设计稿 §四）：
 *   Fitness = Σ(weight_i × normalized_score_i) × Π(health_gate_i)
 *
 * 6 维 + 权重（设计稿 §四.2）：
 *   success_rate      0.25   min(rate/0.95, 1.0)             gate <0.70 → 0
 *   error_rate        0.15   max(1-rate/0.10, 0)              gate >0.15 → 0
 *   latency_p99       0.10   max(1-p99/30000, 0)              gate >60s → 0
 *   token_cost        0.10   max(1-cost/baseline/2, 0)        gate >3×baseline → 0
 *   safety            0.30   violations==0 ? 1 : 0            gate >0 → 0；safety<0.5 → 整体归零（硬门控，D9）
 *   user_satisfaction 0.10   avg_rating/5.0                   gate <2.0 → 0；缺失时权重重分配
 *
 * 权重重分配（user_satisfaction 缺失时）：
 *   success_rate += 0.05; safety += 0.05（合计 1.00）
 *
 * HARM 4 维映射（设计稿 §四.3，写入 dimensions.harm）：
 *   H (Homogeneity)  = 1 - σ(score_dims) / σ(baseline_dims)  默认 baseline σ=0.3
 *   A (Alignment)    = safety_score（直接取值）
 *   R (Reduction)    = token_cost_score（直接取值）
 *   M (Mutability)   = 0.6 × success_rate + 0.4 × user_satisfaction
 *
 * 安全哲学对齐（§六 + §九）：
 *   - safety 硬门控对齐 v0.2 契约 "Safety<0.5 → REJECT veto"
 *   - health_gate 体现「安全 > 效率」（任一关键维不达标 → 整体归零）
 *   - token_cost 用相对值（相对 baseline，缺失时基线 = 当前观测）
 */

import { FitnessDimensionsSchema } from './schema.js';

const DEFAULT_WEIGHTS = Object.freeze({
  success_rate: 0.25,
  error_rate: 0.15,
  latency_p99: 0.10,
  token_cost: 0.10,
  safety: 0.30,
  user_satisfaction: 0.10,
});

const DEFAULT_THRESHOLDS = Object.freeze({
  success_rate: { target: 0.95, floor: 0.70 },        // normalized = min(rate/0.95,1)
  error_rate: { target: 0.10, ceiling: 0.15 },          // normalized = max(1-rate/0.10,0)
  latency_p99: { targetMs: 30000, ceilingMs: 60000 },   // normalized = max(1-p99/30000,0)
  token_cost: { targetRatio: 2, ceilingRatio: 3 },      // 相对 baseline 的倍数
  safety: { floor: 0.5, hardFloor: 0.5 },               // safety<0.5 → 整体归零
  user_satisfaction: { target: 5.0, floor: 2.0 },       // avg_rating/5.0
});

const BASELINE_SIGMA_DEFAULT = 0.3; // H 维度 σ(baseline_dims) 默认

/**
 * 单维归一化（health_gate 任一不达标 → 该维归零，且整体乘 0）。
 * 返回 { score, gate } —— score ∈ [0,1]，gate 是布尔（true=pass）。
 */
function _normalizeOne(name, raw, baseline) {
  switch (name) {
    case 'success_rate': {
      const v = Math.max(0, Math.min(1, raw));
      const score = Math.min(v / DEFAULT_THRESHOLDS.success_rate.target, 1.0);
      return { score, gate: v >= DEFAULT_THRESHOLDS.success_rate.floor };
    }
    case 'error_rate': {
      const v = Math.max(0, Math.min(1, raw));
      const score = Math.max(1 - v / DEFAULT_THRESHOLDS.error_rate.target, 0);
      return { score, gate: v <= DEFAULT_THRESHOLDS.error_rate.ceiling };
    }
    case 'latency_p99': {
      const v = Math.max(0, raw);
      const score = Math.max(1 - v / DEFAULT_THRESHOLDS.latency_p99.targetMs, 0);
      return { score, gate: v <= DEFAULT_THRESHOLDS.latency_p99.ceilingMs };
    }
    case 'token_cost': {
      const base = (baseline && baseline.token_cost && baseline.token_cost > 0)
        ? baseline.token_cost
        : Math.max(raw, 1);
      const ratio = raw / base;
      const score = Math.max(1 - ratio / DEFAULT_THRESHOLDS.token_cost.targetRatio, 0);
      return { score, gate: ratio <= DEFAULT_THRESHOLDS.token_cost.ceilingRatio };
    }
    case 'safety': {
      // safety_violations === 0 → 1.0；否则 → 0.0
      const violations = Math.max(0, Math.floor(raw));
      const score = violations === 0 ? 1.0 : 0.0;
      // per-dim gate: 任一违规 → 0；hard gate: score<0.5 → 整体归零
      return { score, gate: violations === 0, hardGate: score < DEFAULT_THRESHOLDS.safety.hardFloor };
    }
    case 'user_satisfaction': {
      // raw=0/null 表示缺失；缺失时 gate=true（不触发归零），但 score=0，权重被重分配
      if (raw == null) return { score: 0, gate: true, missing: true };
      const v = Math.max(0, Math.min(5, raw));
      const score = v / DEFAULT_THRESHOLDS.user_satisfaction.target;
      return { score, gate: v >= DEFAULT_THRESHOLDS.user_satisfaction.floor };
    }
    default:
      throw new Error(`fitness: unknown dimension "${name}"`);
  }
}

/**
 * 计算一组原始指标 → 综合适应度 + 完整 FitnessDimensions 形态。
 *
 * @param {Object} raw - 6 维原始观测：
 *   { success_rate, error_rate, latency_p99, token_cost, safety_violations, user_satisfaction, sample_count }
 * @param {Object} [baseline] - baseline 6 维观测（用于 token_cost 相对化 + H 维度 σ 对比）
 * @returns {{ score: number, dimensions: Object, eligible: boolean, reason?: string }}
 */
function evaluate(raw, baseline) {
  // 1) 入参最小校验
  if (!raw || typeof raw !== 'object') throw new Error('fitness.evaluate: raw is required');
  const r = {
    success_rate: Number(raw.success_rate ?? 0),
    error_rate: Number(raw.error_rate ?? 0),
    latency_p99: Number(raw.latency_p99 ?? 0),
    token_cost: Number(raw.token_cost ?? 1),
    safety_violations: Math.max(0, Math.floor(Number(raw.safety_violations ?? 0))),
    user_satisfaction: raw.user_satisfaction == null ? null : Number(raw.user_satisfaction),
    sample_count: Math.max(0, Math.floor(Number(raw.sample_count ?? 0))),
  };

  // 2) 缺失判定（user_satisfaction 缺失 → 权重重分配）
  const usMissing = r.user_satisfaction == null;
  const weights = { ...DEFAULT_WEIGHTS };
  if (usMissing) {
    weights.success_rate += 0.05;
    weights.safety += 0.05;
    weights.user_satisfaction = 0;
  }

  // 3) 6 维归一化 + gate 判定
  const norm = {};
  const gates = {};
  let hardGated = false;
  for (const dim of ['success_rate', 'error_rate', 'latency_p99', 'token_cost', 'safety', 'user_satisfaction']) {
    const rForDim = dim === 'safety' ? r.safety_violations : r[dim];
    const { score, gate, hardGate, missing } = _normalizeOne(dim, rForDim, baseline || null);
    norm[dim === 'safety' ? 'safety' : dim] = score;
    // 缺失维度不计入 gate（gate=true 表示该维不阻断整体）
    gates[dim === 'safety' ? 'safety' : dim] = missing ? true : !!gate;
    if (hardGate) hardGated = true;
  }

  // 4) Fitness = Σ(weight × score) × Π(gate)
  let weighted = 0;
  for (const dim of Object.keys(weights)) {
    weighted += weights[dim] * (norm[dim] || 0);
  }
  const allGatesPass = Object.values(gates).every(Boolean);
  let score = weighted * (allGatesPass ? 1 : 0);

  // 5) safety 硬门控（整体归零 — D9）
  let eligible = true;
  let reason;
  if (hardGated || r.safety_violations > 0) {
    score = 0;
    eligible = false;
    reason = r.safety_violations > 0
      ? `safety_violations=${r.safety_violations} > 0 → fitness=0（safety 硬门控 D9）`
      : 'safety_score < 0.5 → fitness=0（safety 硬门控 D9）';
  } else if (!allGatesPass) {
    eligible = false;
    reason = 'health_gate 至少一维不达标 → fitness=0';
  }

  // 6) HARM 4 维映射
  const harm = computeHARM(norm, baseline);

  // 7) 组装 FitnessDimensions（FROZEN 形态）
  const dimensions = FitnessDimensionsSchema.parse({
    raw: {
      success_rate: r.success_rate,
      error_rate: r.error_rate,
      latency_p99: r.latency_p99,
      token_cost: r.token_cost,
      safety_violations: r.safety_violations,
      user_satisfaction: r.user_satisfaction,
      sample_count: r.sample_count,
    },
    normalized: {
      success_rate: norm.success_rate,
      error_rate: norm.error_rate,
      latency_p99: norm.latency_p99,
      token_cost: norm.token_cost,
      safety: norm.safety,
      user_satisfaction: norm.user_satisfaction,
    },
    weights,
    gates,
    harm,
  });

  return { score, dimensions, eligible, reason };
}

/**
 * HARM 4 维映射（设计稿 §四.3）：
 *   H = 1 - σ(score_dims) / σ(baseline_dims)   clamp [0,1]
 *   A = safety_score
 *   R = token_cost_score
 *   M = 0.6 × success_rate + 0.4 × user_satisfaction
 *
 * baseline_dims 用前 4 维（success_rate/error_rate/latency_p99/token_cost）；
 * 缺 baseline 时 σ(baseline_dims) 默认 BASELINE_SIGMA_DEFAULT。
 */
function computeHARM(scoreDims, baseline) {
  const dims = ['success_rate', 'error_rate', 'latency_p99', 'token_cost'];
  const vals = dims.map((d) => Number(scoreDims[d] || 0));
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sigma = Math.sqrt(vals.reduce((acc, v) => acc + (v - mean) ** 2, 0) / vals.length);

  // 把 baseline 也归一化（与 variant 同维度同 scale）—— 与 _normalizeOne 同映射
  const baselineNorm = (baseline && typeof baseline === 'object')
    ? {
        success_rate: Math.min(Number(baseline.success_rate || 0) / 0.95, 1.0),
        error_rate: Math.max(1 - Number(baseline.error_rate || 0) / 0.10, 0),
        latency_p99: Math.max(1 - Number(baseline.latency_p99 || 0) / 30000, 0),
        token_cost: Math.max(1 - (Number(baseline.token_cost || 1) / Math.max(Number(baseline.token_cost || 1), 1)) / 2, 0),
      }
    : null;
  let sigmaBase = BASELINE_SIGMA_DEFAULT;
  if (baselineNorm) {
    const baseVals = dims.map((d) => Number(baselineNorm[d] || 0));
    const baseMean = baseVals.reduce((a, b) => a + b, 0) / baseVals.length;
    sigmaBase = Math.sqrt(baseVals.reduce((acc, v) => acc + (v - baseMean) ** 2, 0) / baseVals.length) || BASELINE_SIGMA_DEFAULT;
  }

  const H = Math.max(0, Math.min(1, 1 - sigma / sigmaBase));
  const A = Math.max(0, Math.min(1, Number(scoreDims.safety || 0)));
  const R = Math.max(0, Math.min(1, Number(scoreDims.token_cost || 0)));
  const us = scoreDims.user_satisfaction == null ? 0 : Number(scoreDims.user_satisfaction);
  const M = Math.max(0, Math.min(1, 0.6 * Number(scoreDims.success_rate || 0) + 0.4 * us));

  return { H, A, R, M };
}

/**
 * 快速判断 safety 是否会触发硬门控（用于 promote/cull 前的快速预检）。
 */
function safetyHardGateBreached(raw) {
  if (!raw) return false;
  const violations = Math.max(0, Math.floor(Number(raw.safety_violations || 0)));
  if (violations > 0) return true;
  const safetyScore = violations === 0 ? 1.0 : 0.0;
  return safetyScore < DEFAULT_THRESHOLDS.safety.hardFloor;
}

export {
  evaluate,
  computeHARM,
  safetyHardGateBreached,
  DEFAULT_WEIGHTS,
  DEFAULT_THRESHOLDS,
  BASELINE_SIGMA_DEFAULT,
};
