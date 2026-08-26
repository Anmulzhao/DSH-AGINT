// storage + lifecycle + config edge-case 测试。

import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../lib/index.js';
import { makeCtx } from './mock-ctx.mjs';
import * as schema from '../lib/schema.js';
import * as storage from '../lib/storage.js';

// ── Storage: pack/unpack round-trip 4 表 ──────────────────────────────

test('storage: packVariant round-trip 保留所有 FROZEN 字段', () => {
  const e = storage.packVariant({
    variant_id: 'v-rt', commit_id: 'c-rt', parent_variant_id: 'p-rt',
    mutation_kind: 'STRATEGY_REWRITE', source: 'evolution-reversed',
    atomic_scope: 'strategy', payload: { foo: 'bar' },
    expected_effect: { metric: 'success_rate', direction: 'increase', window: '14d' },
    rollback_condition: { trigger: 'rollback condition' },
    policy_decision: 'AUTO_DEPLOY', stage: 'OBSERVING', traffic_pct: 5,
    fitness_score: 0.75, fitness_detail: null, generation: 1, consecutive_pass: 2,
    created_at: '2026-08-26T00:00:00.000Z', updated_at: '2026-08-26T00:00:00.000Z',
    fixed_at: null, culled_at: null, rolled_back_at: null, frozen_at: null,
    safety_violations_total: 0,
  });
  assert.equal(e.id.length > 0, true);
  assert.equal(e.kind, 'variant');
  const u = storage.unpackVariant(e);
  assert.equal(u.variant_id, 'v-rt');
  assert.equal(u.parent_variant_id, 'p-rt');
  assert.equal(u.mutation_kind, 'STRATEGY_REWRITE');
  assert.equal(u.source, 'evolution-reversed');
});

test('storage: packFitnessHistory round-trip', () => {
  const e = storage.packFitnessHistory({
    variant_id: 'v-1', generation: 0, score: 0.81,
    dimensions: {
      raw: { success_rate: 0.85, error_rate: 0.05, latency_p99: 5000, token_cost: 100, safety_violations: 0, user_satisfaction: 4.0, sample_count: 100 },
      normalized: { success_rate: 0.894, error_rate: 0.5, latency_p99: 0.833, token_cost: 0.5, safety: 1, user_satisfaction: 0.8 },
      weights: { success_rate: 0.25, error_rate: 0.15, latency_p99: 0.10, token_cost: 0.10, safety: 0.30, user_satisfaction: 0.10 },
      gates: { success_rate: true, error_rate: true, latency_p99: true, token_cost: true, safety: true, user_satisfaction: true },
      harm: { H: 0.95, A: 1, R: 0.5, M: 0.87 },
    },
    sample_count: 100, evaluated_at: '2026-08-26T00:00:00.000Z',
  });
  const u = storage.unpackFitnessHistory(e);
  assert.equal(u.variant_id, 'v-1');
  assert.equal(u.score, 0.81);
  assert.equal(u.dimensions.harm.A, 1);
});

test('storage: packTrafficLog / packGenerationLog round-trip', () => {
  const t1 = storage.packTrafficLog({
    variant_id: 'v-1', from_pct: 1, to_pct: 5,
    reason: 'PROMOTE', trigger: { from: 'NEW', to: 'OBSERVING' },
    changed_at: '2026-08-26T00:00:00.000Z',
  });
  assert.equal(t1.kind, 'traffic_log');
  const t2 = storage.packGenerationLog({
    generation: 0, active_count: 3, culled_count: 1, fixed_count: 1,
    avg_fitness: 0.78, created_at: '2026-08-26T00:00:00.000Z',
  });
  assert.equal(t2.kind, 'generation_log');
});

// ── Schema: enum 边界 + parse 拒绝非法值 ──────────────────────────────

test('schema: MutationKindSchema 拒绝 PIPELINE_REORDER / ARCHITECTURE_PATCH（被否决的方案）', () => {
  assert.equal(schema.MutationKindSchema.safeParse('PIPELINE_REORDER').success, false);
  assert.equal(schema.MutationKindSchema.safeParse('ARCHITECTURE_PATCH').success, false);
});

test('schema: PolicyDecisionSchema 接受全部 4 值 + 拒绝非法', () => {
  for (const v of ['AUTO_DEPLOY', 'PENDING_REVIEW', 'REJECT', 'ABSTAIN']) {
    assert.equal(schema.PolicyDecisionSchema.safeParse(v).success, true);
  }
  assert.equal(schema.PolicyDecisionSchema.safeParse('BOGUS').success, false);
});

test('schema: TrafficReasonSchema 接受全部 7 值', () => {
  for (const v of ['INGEST', 'PROMOTE', 'DEMOTE', 'ROLLBACK', 'FIXATE', 'CULL', 'FREEZE']) {
    assert.equal(schema.TrafficReasonSchema.safeParse(v).success, true);
  }
});

// ── Lifecycle: dispose 走 ctx.effect ─────────────────────────────────

test('lifecycle: ctx.effect 注册了至少 1 个 disposer（graceful shutdown 前提）', async () => {
  const ctx = makeCtx({});
  apply(ctx);
  // apply 应至少注册 1 个 effect（domain dispose）
  assert.ok(ctx._effects.length >= 1, `期望 ≥1 个 effect，实测 ${ctx._effects.length}`);
  for (const dispose of ctx._effects) {
    assert.equal(typeof dispose, 'function', 'disposer 必须是函数');
  }
});

// ── Config: updateConfig + 提供 config ────────────────────────────────

test('config: updateConfig 修改后影响后续判断', async () => {
  const ctx = makeCtx({});
  apply(ctx);
  const newCfg = ctx._providers['agint.population.updateConfig']({ capacity: 7 });
  assert.equal(newCfg.capacity, 7);
  const configProvider = ctx._providers['agint.population.config'];
  assert.equal(configProvider.capacity, 7);
});

test('config: 提供 LIMITS 硬编码 100/500/500/50', async () => {
  const ctx = makeCtx({});
  apply(ctx);
  const limits = ctx._providers['agint.population.limits'];
  assert.equal(limits.variants, 100);
  assert.equal(limits.fitness_history, 500);
  assert.equal(limits.traffic_log, 500);
  assert.equal(limits.generation_log, 50);
});

// ── Plugin entry: name / inject ──────────────────────────────────────

test('plugin entry: name=agint-population + inject=[storageDomain]', async () => {
  const m = await import('../lib/index.js');
  assert.equal(m.name, 'agint-population');
  assert.deepEqual(m.inject, ['storageDomain']);
  assert.equal(typeof m.apply, 'function');
});
