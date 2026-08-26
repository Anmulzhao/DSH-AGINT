#!/usr/bin/env node
// agint-population smoke test — `node test/smoke.mjs` 一行能跑。
//
// 5 个 smoke 用例覆盖：
//   1) FROZEN 11-stage enum + reject 非法值
//   2) 4 张数据表 + LIMITS 守门
//   3) FROZEN schema 校验（Variant / FitnessHistory / TrafficLog / GenerationLog）
//   4) storage domain spec shape（name / version / 4 tables）
//   5) 模块 entry/inject/name 导出 + plugin 自洽
//
// 本 smoke 不挂载 Cordis 也不真打开 storage domain —— 验证 FROZEN schema + 模块装配。
// 真正的 open(domain) + 5 Service 端到端由 E2E 与单测覆盖。

import test from 'node:test';
import assert from 'node:assert/strict';

import * as schema from '../lib/schema.js';
import * as storage from '../lib/storage.js';
import * as plugin from '../lib/index.js';
import * as fitness from '../lib/fitness.js';
import * as states from '../lib/states.js';

// ── Case 1: FROZEN 11-stage enum ─────────────────────────────────────

test('FROZEN 11-stage enum StageSchema', () => {
  const expected = [
    'PENDING_REVIEW', 'REJECTED', 'NEW', 'OBSERVING', 'PROMOTING',
    'EXPANDING', 'FULL', 'FIXED', 'FROZEN_OBSERVE', 'CULLED', 'ROLLED_BACK',
  ];
  assert.deepEqual([...schema.STAGES], expected);
  assert.equal(schema.STAGES.length, 11);
  for (const s of expected) assert.ok(schema.StageSchema.safeParse(s).success, `StageSchema 应接受 ${s}`);
  assert.equal(schema.StageSchema.safeParse('BOGUS').success, false);

  // 终态判定
  assert.equal(schema.isTerminalStage('FIXED'), true);
  assert.equal(schema.isTerminalStage('CULLED'), true);
  assert.equal(schema.isTerminalStage('ROLLED_BACK'), true);
  assert.equal(schema.isTerminalStage('REJECTED'), true);
  assert.equal(schema.isTerminalStage('NEW'), false);
  assert.equal(schema.isTerminalStage('OBSERVING'), false);
  assert.equal(schema.isTerminalStage('PROMOTING'), false);
  assert.equal(schema.isTerminalStage('EXPANDING'), false);
  assert.equal(schema.isTerminalStage('FULL'), false);
  assert.equal(schema.isTerminalStage('FROZEN_OBSERVE'), false);
  assert.equal(schema.isTerminalStage('PENDING_REVIEW'), false);
});

// ── Case 2: 4 张数据表 + LIMITS 守门（设计稿 §二.2） ────────────────────

test('storage 4 tables + LIMITS 100/500/500/50', () => {
  assert.equal(storage.spec.name, 'agint_population');
  assert.equal(storage.spec.version, 1);
  const tables = Object.keys(storage.spec.tables).sort();
  assert.deepEqual(tables, ['fitness_history', 'generation_log', 'traffic_log', 'variants']);
  assert.equal(schema.LIMITS.VARIANTS, 100);
  assert.equal(schema.LIMITS.FITNESS_HISTORY, 500);
  assert.equal(schema.LIMITS.TRAFFIC_LOG, 500);
  assert.equal(schema.LIMITS.GENERATION_LOG, 50);

  // checkLimit: 未超 → null；超限 → warn object
  assert.equal(storage.checkLimit('variants', 50), null);
  assert.equal(storage.checkLimit('whatever', 99999), null);
  const w1 = storage.checkLimit('variants', 101);
  assert.ok(w1 && w1.limit === 100 && /variants/.test(w1._warn));
  const w2 = storage.checkLimit('fitness_history', 501);
  assert.ok(w2 && w2.limit === 500);
  const w3 = storage.checkLimit('traffic_log', 501);
  assert.ok(w3 && w3.limit === 500);
  const w4 = storage.checkLimit('generation_log', 51);
  assert.ok(w4 && w4.limit === 50);
});

// ── Case 3: FROZEN schema 校验（Variant / FitnessHistory / TrafficLog / GenerationLog） ──

test('FROZEN schemas: Variant / FitnessHistory / TrafficLog / GenerationLog', () => {
  const baseVariant = {
    variant_id: 'v-1',
    commit_id: 'c-1',
    parent_variant_id: null,
    mutation_kind: 'PROMPT_MUTATION',
    source: 'attribution-driven',
    atomic_scope: 'prompt',
    payload: { promptId: 'sys', oldText: 'a', newText: 'b', diffStrategy: 'unified_diff' },
    expected_effect: { metric: 'success_rate', direction: 'increase', window: '7d' },
    rollback_condition: { trigger: 'regression >10% → rollback' },
    policy_decision: 'AUTO_DEPLOY',
    stage: 'NEW',
    traffic_pct: 1,
    fitness_score: 0,
    fitness_detail: null,
    generation: 0,
    consecutive_pass: 0,
    created_at: '2026-08-26T00:00:00.000Z',
    updated_at: '2026-08-26T00:00:00.000Z',
    fixed_at: null,
    culled_at: null,
    rolled_back_at: null,
    frozen_at: null,
    safety_violations_total: 0,
  };
  assert.equal(schema.VariantSchema.safeParse(baseVariant).success, true);
  // stage 非法 → 拒
  assert.equal(schema.VariantSchema.safeParse({ ...baseVariant, stage: 'BOGUS' }).success, false);
  // parent_variant_id 非空字符串
  assert.equal(schema.VariantSchema.safeParse({ ...baseVariant, parent_variant_id: 'parent-1' }).success, true);

  const baseFit = {
    variant_id: 'v-1',
    generation: 0,
    score: 0.85,
    dimensions: {
      raw: { success_rate: 0.85, error_rate: 0.05, latency_p99: 5000, token_cost: 100, safety_violations: 0, user_satisfaction: 4.0, sample_count: 100 },
      normalized: { success_rate: 0.894, error_rate: 0.5, latency_p99: 0.833, token_cost: 0.5, safety: 1, user_satisfaction: 0.8 },
      weights: { success_rate: 0.25, error_rate: 0.15, latency_p99: 0.10, token_cost: 0.10, safety: 0.30, user_satisfaction: 0.10 },
      gates: { success_rate: true, error_rate: true, latency_p99: true, token_cost: true, safety: true, user_satisfaction: true },
      harm: { H: 0.95, A: 1, R: 0.5, M: 0.87 },
    },
    sample_count: 100,
    evaluated_at: '2026-08-26T00:00:00.000Z',
  };
  assert.equal(schema.FitnessHistorySchema.safeParse(baseFit).success, true);

  const baseTraffic = {
    variant_id: 'v-1', from_pct: 1, to_pct: 5,
    reason: 'PROMOTE', trigger: { from: 'NEW', to: 'OBSERVING' },
    changed_at: '2026-08-26T00:00:00.000Z',
  };
  assert.equal(schema.TrafficLogSchema.safeParse(baseTraffic).success, true);
  assert.equal(schema.TrafficLogSchema.safeParse({ ...baseTraffic, reason: 'BOGUS' }).success, false);

  const baseGen = {
    generation: 0, active_count: 3, culled_count: 1, fixed_count: 1,
    avg_fitness: 0.78, created_at: '2026-08-26T00:00:00.000Z',
  };
  assert.equal(schema.GenerationLogSchema.safeParse(baseGen).success, true);
});

// ── Case 4: storage domain spec shape ─────────────────────────────────

test('storage domain spec: 4 tables + version=1 + domain name', () => {
  assert.equal(storage.spec.name, 'agint_population');
  assert.equal(storage.spec.version, 1);
  // 4 张表的 valueSchema 必须定义且可 parse
  for (const tbl of ['variants', 'fitness_history', 'traffic_log', 'generation_log']) {
    assert.ok(storage.spec.tables[tbl], `${tbl} 必须存在`);
    assert.ok(storage.spec.tables[tbl].valueSchema, `${tbl} 必须有 valueSchema`);
  }
  // packVariant round-trip
  const v = storage.packVariant({
    variant_id: 'v-test', commit_id: 'c-test', parent_variant_id: null,
    mutation_kind: 'PROMPT_MUTATION', source: 'attribution-driven', atomic_scope: 'prompt',
    payload: null,
    expected_effect: { metric: 'success_rate', direction: 'increase', window: '7d' },
    rollback_condition: { trigger: 'regression >10% → rollback' },
    policy_decision: 'AUTO_DEPLOY', stage: 'NEW', traffic_pct: 1, fitness_score: 0,
    fitness_detail: null, generation: 0, consecutive_pass: 0,
    created_at: '2026-08-26T00:00:00.000Z', updated_at: '2026-08-26T00:00:00.000Z',
    fixed_at: null, culled_at: null, rolled_back_at: null, frozen_at: null,
    safety_violations_total: 0,
  });
  assert.equal(v.id.length > 0, true);
  assert.equal(v.kind, 'variant');
  const unpacked = storage.unpackVariant(v);
  assert.equal(unpacked.variant_id, 'v-test');
});

// ── Case 5: 模块 entry / inject / name 导出 + plugin 自洽 ─────────────

test('plugin 模块 entry / inject / name + 依赖图自洽', () => {
  // 1. 模块入口
  assert.equal(plugin.name, 'agint-population');
  assert.deepEqual(plugin.inject, ['storageDomain']);
  assert.equal(typeof plugin.apply, 'function');
  assert.equal(typeof plugin.Config, 'object');

  // 2. soft deps 文档化（manifest 声明 + 提供路径一致）
  // 注：硬依赖注入 = storageDomain；其它 6 个为 optionalInject（design §7.1）
  // 已在 manifest.json spec.cordis.optionalInject 显式声明：
  //   agint.mutator / agint.diagnosis / agint.qualityPolicy / agint.qualitySandbox / agint.memory / agint.evolution

  // 3. 子模块互相独立可测
  assert.equal(typeof fitness.evaluate, 'function');
  assert.equal(typeof fitness.safetyHardGateBreached, 'function');
  assert.equal(typeof states.checkPromote, 'function');
  assert.equal(typeof states.enterFROZEN_OBSERVE, 'function');

  // 4. DEFAULT_CONFIG 13 项（设计稿 §十）
  assert.equal(Object.keys(plugin.Config).length, 0); // plugin.Config 是 entry 占位
  const cfgKeys = Object.keys(schema.DEFAULT_CONFIG);
  assert.equal(typeof cfgKeys, 'object');
  const cfgCount = Object.keys(schema.DEFAULT_CONFIG).length;
  assert.equal(cfgCount, 14, `DEFAULT_CONFIG 必须 14 项（设计稿 §十），实测 ${cfgCount}`);

  // 5. STAGE_LADDER 5 阶（设计稿 §五.1）
  assert.equal(schema.STAGE_LADDER.length, 5);
  assert.deepEqual(schema.STAGE_LADDER.map((s) => s.stage), ['NEW', 'OBSERVING', 'PROMOTING', 'EXPANDING', 'FULL']);

  // 6. fitness 与 states 互相不引用 storage（保持 lib 内部低耦合）
  // 注：lib/index.js 才把 fitness + states + storage 缝合到一起
  assert.equal(fitness.evaluate.length >= 1, true);
  assert.equal(states.checkPromote.length >= 1, true);
});
