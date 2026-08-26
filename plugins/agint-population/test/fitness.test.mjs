// 适应度函数单元测试 — 覆盖 6 维度归一化 + gates + HARM + 硬门控。

import test from 'node:test';
import assert from 'node:assert/strict';

import * as fitness from '../lib/fitness.js';
import * as schema from '../lib/schema.js';

const BASELINE = { success_rate: 0.85, error_rate: 0.05, latency_p99: 5000, token_cost: 100 };

// ── 6 维度归一化（含 gate 触发） ────────────────────────────────────────

test('fitness: 6 维度归一化（baseline 健康）', () => {
  const r = fitness.evaluate({
    success_rate: 0.85, error_rate: 0.05, latency_p99: 5000,
    token_cost: 100, safety_violations: 0, user_satisfaction: 4.0, sample_count: 100,
  }, BASELINE);
  assert.equal(r.eligible, true);
  assert.ok(r.score > 0.7 && r.score < 0.9, `score 应在 0.7-0.9 区间，实测 ${r.score.toFixed(4)}`);
  // 归一化值在 [0,1]
  for (const k of ['success_rate', 'error_rate', 'latency_p99', 'token_cost', 'safety', 'user_satisfaction']) {
    assert.ok(r.dimensions.normalized[k] >= 0 && r.dimensions.normalized[k] <= 1, `${k} normalized 应在 [0,1]`);
  }
});

test('fitness: success_rate < 0.70 → gate 触发 fitness=0', () => {
  const r = fitness.evaluate({
    success_rate: 0.50, error_rate: 0.05, latency_p99: 5000,
    token_cost: 100, safety_violations: 0, user_satisfaction: 4.0, sample_count: 100,
  }, BASELINE);
  assert.equal(r.score, 0);
  assert.equal(r.eligible, false);
  assert.equal(r.dimensions.gates.success_rate, false);
  assert.match(r.reason, /health_gate/);
});

test('fitness: error_rate > 0.15 → gate 触发 fitness=0', () => {
  const r = fitness.evaluate({
    success_rate: 0.85, error_rate: 0.20, latency_p99: 5000,
    token_cost: 100, safety_violations: 0, user_satisfaction: 4.0, sample_count: 100,
  }, BASELINE);
  assert.equal(r.score, 0);
  assert.equal(r.dimensions.gates.error_rate, false);
});

test('fitness: latency_p99 > 60000 → gate 触发 fitness=0', () => {
  const r = fitness.evaluate({
    success_rate: 0.85, error_rate: 0.05, latency_p99: 70000,
    token_cost: 100, safety_violations: 0, user_satisfaction: 4.0, sample_count: 100,
  }, BASELINE);
  assert.equal(r.score, 0);
  assert.equal(r.dimensions.gates.latency_p99, false);
});

test('fitness: token_cost > 3×baseline → gate 触发 fitness=0', () => {
  const r = fitness.evaluate({
    success_rate: 0.85, error_rate: 0.05, latency_p99: 5000,
    token_cost: 350,                              // 3.5× baseline=100
    safety_violations: 0, user_satisfaction: 4.0, sample_count: 100,
  }, BASELINE);
  assert.equal(r.score, 0);
  assert.equal(r.dimensions.gates.token_cost, false);
});

test('fitness: safety_violations > 0 → 硬门控 fitness=0（D9）', () => {
  const r = fitness.evaluate({
    success_rate: 0.95, error_rate: 0.02, latency_p99: 3000,
    token_cost: 80, safety_violations: 1, user_satisfaction: 5.0, sample_count: 200,
  }, BASELINE);
  assert.equal(r.score, 0, 'safety 违规 → 整体归零');
  assert.equal(r.eligible, false);
  assert.match(r.reason, /safety_violations/);
});

test('fitness: user_satisfaction < 2.0 → gate 触发 fitness=0', () => {
  const r = fitness.evaluate({
    success_rate: 0.85, error_rate: 0.05, latency_p99: 5000,
    token_cost: 100, safety_violations: 0, user_satisfaction: 1.5, sample_count: 100,
  }, BASELINE);
  assert.equal(r.score, 0);
  assert.equal(r.dimensions.gates.user_satisfaction, false);
});

// ── user_satisfaction 缺失 → 权重重分配 ────────────────────────────────

test('fitness: user_satisfaction 缺失 → 权重从 success_rate + safety 重分配', () => {
  const r = fitness.evaluate({
    success_rate: 0.85, error_rate: 0.05, latency_p99: 5000,
    token_cost: 100, safety_violations: 0, user_satisfaction: null, sample_count: 100,
  }, BASELINE);
  assert.equal(r.eligible, true);
  assert.equal(r.dimensions.weights.user_satisfaction, 0);
  assert.equal(r.dimensions.weights.success_rate, 0.30);  // 0.25 + 0.05
  assert.equal(r.dimensions.weights.safety, 0.35);        // 0.30 + 0.05
  // 权重之和应为 1.00
  const sum = Object.values(r.dimensions.weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-9, `权重和应为 1.0，实测 ${sum}`);
  // 缺失时 gate.user_satisfaction 应为 true（不阻断）
  assert.equal(r.dimensions.gates.user_satisfaction, true);
});

// ── HARM 4 维映射 ─────────────────────────────────────────────────────

test('fitness: HARM 4 维映射（H/A/R/M）', () => {
  const r = fitness.evaluate({
    success_rate: 0.85, error_rate: 0.05, latency_p99: 5000,
    token_cost: 100, safety_violations: 0, user_satisfaction: 4.0, sample_count: 100,
  }, BASELINE);
  const h = r.dimensions.harm;
  for (const k of ['H', 'A', 'R', 'M']) {
    assert.ok(typeof h[k] === 'number' && h[k] >= 0 && h[k] <= 1, `harm.${k} 应在 [0,1]，实测 ${h[k]}`);
  }
  // A = safety_score = 1
  assert.equal(h.A, 1);
  // R = token_cost_score = 1 - (100/100)/2 = 0.5
  assert.equal(h.R, 0.5);
  // M = 0.6 × success_rate_norm + 0.4 × user_satisfaction_norm
  //   = 0.6 × (0.85/0.95) + 0.4 × (4.0/5.0) = 0.5368 + 0.32 = 0.8568
  assert.ok(Math.abs(h.M - 0.8568) < 1e-3, `harm.M 应为 0.8568（归一化加权），实测 ${h.M.toFixed(4)}`);
  // H = 1 - σ(score_dims)/σ(baseline_dims)（设计稿 §四.3 字面）
  // 当 variant 与 baseline σ 一致时 → H = 0（既不更分散也不更集中）
  // 测试基线输入与 variant 同质 → σ(variant) ≈ σ(baseline) → H ≈ 0
  assert.ok(Math.abs(h.H) < 0.05, `与 baseline σ 相同时 H ≈ 0，实测 ${h.H.toFixed(4)}`);
});

test('fitness: HARM A 与 safety 维度直接绑定（违规时 A=0）', () => {
  const r = fitness.evaluate({
    success_rate: 0.85, error_rate: 0.05, latency_p99: 5000,
    token_cost: 100, safety_violations: 1, user_satisfaction: 4.0, sample_count: 100,
  }, BASELINE);
  assert.equal(r.dimensions.harm.A, 0);
});

test('fitness: HARM H 无 baseline 时使用默认 σ=0.3', () => {
  const r = fitness.evaluate({
    success_rate: 0.85, error_rate: 0.05, latency_p99: 5000,
    token_cost: 100, safety_violations: 0, user_satisfaction: 4.0, sample_count: 100,
  });
  // 无 baseline 时仍能算 H（fallback σ_baseline=0.3）
  assert.equal(typeof r.dimensions.harm.H, 'number');
  assert.ok(r.dimensions.harm.H >= 0 && r.dimensions.harm.H <= 1);
});

// ── safetyHardGateBreached 快速预检 ────────────────────────────────────

test('safetyHardGateBreached: violations>0 → true', () => {
  assert.equal(fitness.safetyHardGateBreached({ safety_violations: 0 }), false);
  assert.equal(fitness.safetyHardGateBreached({ safety_violations: 1 }), true);
  assert.equal(fitness.safetyHardGateBreached({ safety_violations: 5 }), true);
  assert.equal(fitness.safetyHardGateBreached(null), false);
  assert.equal(fitness.safetyHardGateBreached({}), false);
});

// ── FROZEN FitnessDimensionsSchema 验证（evaluate 输出必须能 parse） ───

test('fitness: evaluate 输出能通过 FitnessDimensionsSchema.parse', () => {
  const r = fitness.evaluate({
    success_rate: 0.85, error_rate: 0.05, latency_p99: 5000,
    token_cost: 100, safety_violations: 0, user_satisfaction: 4.0, sample_count: 100,
  }, BASELINE);
  // FitnessDimensionsSchema 期望 dimensions 含 raw/normalized/weights/gates/harm
  const parsed = schema.FitnessDimensionsSchema.safeParse(r.dimensions);
  assert.equal(parsed.success, true, 'evaluate 输出应通过 FROZEN FitnessDimensionsSchema');
});
