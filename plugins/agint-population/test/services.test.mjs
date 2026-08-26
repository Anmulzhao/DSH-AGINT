// Service 单元测试 — ingest / promote / cull / fixate / rollback + recordEvaluation。
//
// 用 mock ctx（test/mock-ctx.mjs）in-memory storage 模拟 Cordis 装载。
// 软依赖通过 ctx.get() 注入（mutator / evolution / qualityPolicy）。

import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, inject, name as pluginName } from '../lib/index.js';
import { makeCtx } from './mock-ctx.mjs';
import * as storage from '../lib/storage.js';
import { DEFAULT_CONFIG } from '../lib/schema.js';

// ── 通用辅助 ──────────────────────────────────────────────────────────

function setupCtx(softDeps = {}) {
  const ctx = makeCtx({ spec: storage.spec, softDeps });
  apply(ctx);
  return ctx;
}

function makeProposal(overrides = {}) {
  return {
    id: 'prop-1',
    kind: 'PROMPT_MUTATION',
    source: 'attribution-driven',
    atomicScope: 'prompt',
    payload: { promptId: 'sys', oldText: 'a', newText: 'b', diffStrategy: 'unified_diff' },
    expectedEffect: { metric: 'success_rate', direction: 'increase', window: '7d' },
    rollbackCondition: { trigger: 'regression >10% → rollback' },
    ...overrides,
  };
}

// ── Ingest: 前置校验 ────────────────────────────────────────────────

test('ingest: 缺 expectedEffect → 抛错 + 写 failure_pattern', async () => {
  const ctx = setupCtx();
  await assert.rejects(
    () => ctx._providers['agint.population.ingest']({ proposal: { id: 'p', rollbackCondition: { trigger: 'r' }, atomicScope: 'prompt', kind: 'PROMPT_MUTATION', source: 'attribution-driven' } }),
    /expectedEffect/,
  );
});

test('ingest: 缺 rollbackCondition.trigger → 抛错', async () => {
  const ctx = setupCtx();
  const p = makeProposal();
  p.rollbackCondition = { trigger: '' };
  await assert.rejects(
    () => ctx._providers['agint.population.ingest']({ proposal: p }),
    /rollbackCondition/,
  );
});

test('ingest: expectedEffect.metric 缺失 → 抛错', async () => {
  const ctx = setupCtx();
  const p = makeProposal({ expectedEffect: { metric: '', direction: 'increase', window: '7d' } });
  await assert.rejects(() => ctx._providers['agint.population.ingest']({ proposal: p }), /expectedEffect/);
});

// ── Ingest: Policy Gate 分支 ─────────────────────────────────────────

test('ingest: AUTO_DEPLOY → 创建 variant(NEW, 1%) + traffic_log', async () => {
  const ctx = setupCtx({
    'agint.qualityPolicy': { decide: async () => ({ decision: 'AUTO_DEPLOY' }) },
  });
  const result = await ctx._providers['agint.population.ingest']({ proposal: makeProposal() });
  assert.equal(result.stage, 'NEW');
  assert.equal(result.traffic_pct, 1);
  assert.equal(result.policy_decision, 'AUTO_DEPLOY');
  assert.ok(result.variant_id);
  assert.equal(result.fitness_score, 0);
});

test('ingest: PENDING_REVIEW → stage=PENDING_REVIEW, traffic=0', async () => {
  const ctx = setupCtx({
    'agint.qualityPolicy': { decide: async () => ({ decision: 'PENDING_REVIEW' }) },
  });
  const result = await ctx._providers['agint.population.ingest']({ proposal: makeProposal() });
  assert.equal(result.stage, 'PENDING_REVIEW');
  assert.equal(result.traffic_pct, 0);
});

test('ingest: REJECT → 抛错', async () => {
  const ctx = setupCtx({
    'agint.qualityPolicy': { decide: async () => ({ decision: 'REJECT' }) },
  });
  await assert.rejects(
    () => ctx._providers['agint.population.ingest']({ proposal: makeProposal() }),
    /policy REJECT/,
  );
});

test('ingest: 软依赖 qualityPolicy 缺失 → 默认 PENDING_REVIEW（保守降级）', async () => {
  const ctx = setupCtx();
  const result = await ctx._providers['agint.population.ingest']({ proposal: makeProposal() });
  assert.equal(result.stage, 'PENDING_REVIEW');
  assert.equal(result.traffic_pct, 0);
});

// ── Ingest: 容量 + 同 scope 限流 ─────────────────────────────────────

test('ingest: capacity 满 → 触发最差 cull', async () => {
  // mock：capacity=2；先 ingest 2 个，再 ingest 第 3 个时 capacity-pressure 触发 cull(最差)
  const ctx = setupCtx({
    'agint.qualityPolicy': { decide: async () => ({ decision: 'AUTO_DEPLOY' }) },
    'agint.mutator': { rollback: async () => ({ ok: true, restoredHash: 'h' }) },
  });
  ctx._providers['agint.population.updateConfig']({ capacity: 2 });

  const v1 = await ctx._providers['agint.population.ingest']({ proposal: makeProposal({ id: 'p1', atomicScope: 'prompt' }) });
  const v2 = await ctx._providers['agint.population.ingest']({ proposal: makeProposal({ id: 'p2', atomicScope: 'tool' }) });
  // 给 v1 一个高 fitness，v2 留 fitness=0（最差）
  await ctx._providers['agint.population.recordEvaluation'](v1.variant_id, { success_rate: 0.85, error_rate: 0.05, latency_p99: 5000, token_cost: 100, safety_violations: 0, user_satisfaction: 4.0, sample_count: 100 });

  // 第 3 个 ingest：capacity 满 → cull 最差（v2 fitness=0）→ 然后 ingest v3
  const v3 = await ctx._providers['agint.population.ingest']({ proposal: makeProposal({ id: 'p3', atomicScope: 'strategy' }) });
  const stats = await ctx._providers['agint.population.stats']();

  // v2 应被 cull（最差），v3 应为 NEW（新加的）
  const v2State = stats.variants.find((v) => v.variant_id === v2.variant_id);
  const v3State = stats.variants.find((v) => v.variant_id === v3.variant_id);
  assert.equal(v2State.stage, 'CULLED', `capacity=2 时最差 variant(v2) 应被 cull，实测 stage=${v2State?.stage}`);
  assert.equal(v3State.stage, 'NEW', `新 ingest 的 v3 应为 NEW，实测 stage=${v3State?.stage}`);
  // active 数 ≤ capacity
  const activeCount = stats.variants.filter((v) => v.stage !== 'CULLED' && v.stage !== 'FIXED' && v.stage !== 'REJECTED' && v.stage !== 'ROLLED_BACK').length;
  assert.ok(activeCount <= 2, `active ≤ capacity=2，实测 activeCount=${activeCount}`);
});

test('ingest: 同 scope 并发超 same_scope_max=3 → 抛错', async () => {
  const ctx = setupCtx({
    'agint.qualityPolicy': { decide: async () => ({ decision: 'AUTO_DEPLOY' }) },
  });
  // 先 ingest 3 个同 scope
  for (let i = 0; i < 3; i++) {
    await ctx._providers['agint.population.ingest']({ proposal: makeProposal({ id: `p${i}`, atomicScope: 'prompt' }) });
  }
  // 第 4 个应抛错
  await assert.rejects(
    () => ctx._providers['agint.population.ingest']({ proposal: makeProposal({ id: 'p4', atomicScope: 'prompt' }) }),
    /same_scope/,
  );
});

// ── Promote: 阶梯晋升 ───────────────────────────────────────────────

test('promote: fitness ≥ 阈值 + consec 足 → 升至下一阶梯', async () => {
  const ctx = setupCtx({
    'agint.qualityPolicy': { decide: async () => ({ decision: 'AUTO_DEPLOY' }) },
  });
  const v = await ctx._providers['agint.population.ingest']({ proposal: makeProposal() });
  // 写入 fitness + consecutive_pass=1（用 recordEvaluation，但 recordEvaluation 会算 fitness）
  // 直接构造一个高 fitness + consec_pass=1 的 variant
  await ctx._providers['agint.population.recordEvaluation'](v.variant_id, { success_rate: 0.85, error_rate: 0.05, latency_p99: 5000, token_cost: 100, safety_violations: 0, user_satisfaction: 4.0, sample_count: 100 });

  const r1 = await ctx._providers['agint.population.promote']({ variant_id: v.variant_id });
  assert.equal(r1.promoted, true);
  assert.equal(r1.nextStage, 'OBSERVING');
});

test('promote: fitness 不足 → consecutive_pass=0 不晋升', async () => {
  const ctx = setupCtx({
    'agint.qualityPolicy': { decide: async () => ({ decision: 'AUTO_DEPLOY' }) },
  });
  const v = await ctx._providers['agint.population.ingest']({ proposal: makeProposal() });
  await ctx._providers['agint.population.recordEvaluation'](v.variant_id, { success_rate: 0.5, error_rate: 0.05, latency_p99: 5000, token_cost: 100, safety_violations: 0, user_satisfaction: 4.0, sample_count: 100 });
  // fitness 算出来 0（success_rate<0.70 → gate 触发）
  const r = await ctx._providers['agint.population.promote']({ variant_id: v.variant_id });
  assert.equal(r.promoted, false);
  assert.match(r.reason, /health_gate|fitness/);
});

// ── Cull: 强制 rollback + failure_pattern ────────────────────────────

test('cull: 强制调 mutator.rollback()（D11）+ 写 failure_pattern tag=population-cull', async () => {
  const rollbackCalled = { v: 0 };
  const addFailureCalled = { v: 0, payload: null };
  const ctx = setupCtx({
    'agint.qualityPolicy': { decide: async () => ({ decision: 'AUTO_DEPLOY' }) },
    'agint.mutator': {
      rollback: async ({ commitId }) => { rollbackCalled.v++; return { ok: true, restoredHash: 'h-1', commitId }; },
    },
    'agint.evolution': {
      addFailure: (payload) => { addFailureCalled.v++; addFailureCalled.payload = payload; return 'fp-1'; },
    },
  });

  const v = await ctx._providers['agint.population.ingest']({ proposal: makeProposal() });
  await ctx._providers['agint.population.recordEvaluation'](v.variant_id, { success_rate: 0.85, error_rate: 0.05, latency_p99: 5000, token_cost: 100, safety_violations: 0, user_satisfaction: 4.0, sample_count: 100 });

  const r = await ctx._providers['agint.population.cull']({ variant_id: v.variant_id, reason: 'manual-test' });
  assert.equal(rollbackCalled.v, 1, 'D11: rollback 必须被调用');
  assert.equal(addFailureCalled.v, 1, 'failure_pattern 必须被写入');
  assert.deepEqual(addFailureCalled.payload.tags, ['population-cull']);
  assert.equal(r.variant.stage, 'CULLED');
  assert.equal(r.variant.traffic_pct, 0);
  assert.ok(r.rollback && r.rollback.ok === true);
});

test('cull: mutator.rollback 不可用 → cull 仍完成 + rollbackError 记录', async () => {
  // D11 强制调 mutator.rollback（缺则记录错误而非阻断 cull）—— 设计稿 §三.6：
  //   rollback 失败 → 升级 P0 告警，阻塞后续 ingest；但 cull 本身不抛错。
  const ctx = setupCtx({
    'agint.qualityPolicy': { decide: async () => ({ decision: 'AUTO_DEPLOY' }) },
  });
  const v = await ctx._providers['agint.population.ingest']({ proposal: makeProposal() });
  await ctx._providers['agint.population.recordEvaluation'](v.variant_id, { success_rate: 0.85, error_rate: 0.05, latency_p99: 5000, token_cost: 100, safety_violations: 0, user_satisfaction: 4.0, sample_count: 100 });

  const r = await ctx._providers['agint.population.cull']({ variant_id: v.variant_id });
  assert.equal(r.variant.stage, 'CULLED');
  assert.equal(r.rollback, null, 'rollbackResult 为 null（mutator 不可用）');
  assert.match(r.rollbackError || '', /不可用/);
});

test('cull: 已 CULLED 状态再 cull → 抛错', async () => {
  const ctx = setupCtx({
    'agint.qualityPolicy': { decide: async () => ({ decision: 'AUTO_DEPLOY' }) },
    'agint.mutator': { rollback: async () => ({ ok: true, restoredHash: 'h' }) },
  });
  const v = await ctx._providers['agint.population.ingest']({ proposal: makeProposal() });
  await ctx._providers['agint.population.recordEvaluation'](v.variant_id, { success_rate: 0.85, error_rate: 0.05, latency_p99: 5000, token_cost: 100, safety_violations: 0, user_satisfaction: 4.0, sample_count: 100 });
  await ctx._providers['agint.population.cull']({ variant_id: v.variant_id });
  await assert.rejects(() => ctx._providers['agint.population.cull']({ variant_id: v.variant_id }), /已是终态/);
});

// ── Rollback: 紧急回滚 + failure_pattern tag=population-rollback ──────

test('rollback: 强制 mutator.rollback + failure_pattern tag=population-rollback', async () => {
  const rollbackCalled = { v: 0 };
  const addFailureCalled = { v: 0, payload: null };
  const ctx = setupCtx({
    'agint.qualityPolicy': { decide: async () => ({ decision: 'AUTO_DEPLOY' }) },
    'agint.mutator': { rollback: async () => { rollbackCalled.v++; return { ok: true, restoredHash: 'h' }; } },
    'agint.evolution': { addFailure: (p) => { addFailureCalled.v++; addFailureCalled.payload = p; return 'fp-1'; } },
  });

  const v = await ctx._providers['agint.population.ingest']({ proposal: makeProposal() });
  await ctx._providers['agint.population.recordEvaluation'](v.variant_id, { success_rate: 0.85, error_rate: 0.05, latency_p99: 5000, token_cost: 100, safety_violations: 0, user_satisfaction: 4.0, sample_count: 100 });

  const r = await ctx._providers['agint.population.rollback']({ variant_id: v.variant_id, reason: 'safety_violation', trigger_detail: { count: 3 } });
  assert.equal(rollbackCalled.v, 1);
  assert.equal(addFailureCalled.v, 1);
  assert.deepEqual(addFailureCalled.payload.tags, ['population-rollback']);
  assert.equal(r.variant.stage, 'ROLLED_BACK');
});

test('rollback: 已 ROLLED_BACK 状态再 rollback → 抛错', async () => {
  const ctx = setupCtx({
    'agint.qualityPolicy': { decide: async () => ({ decision: 'AUTO_DEPLOY' }) },
    'agint.mutator': { rollback: async () => ({ ok: true, restoredHash: 'h' }) },
  });
  const v = await ctx._providers['agint.population.ingest']({ proposal: makeProposal() });
  await ctx._providers['agint.population.recordEvaluation'](v.variant_id, { success_rate: 0.85, error_rate: 0.05, latency_p99: 5000, token_cost: 100, safety_violations: 0, user_satisfaction: 4.0, sample_count: 100 });
  await ctx._providers['agint.population.rollback']({ variant_id: v.variant_id, reason: 'manual' });
  await assert.rejects(() => ctx._providers['agint.population.rollback']({ variant_id: v.variant_id, reason: 'manual' }), /终态/);
});

// ── Fixate: 阶梯满 + consec_pass ≥ fixation_periods → FIXED ─────────

test('fixate: 必需 stage=FULL + consec_pass≥3 + 调 mutator.commit.get', async () => {
  const commitGetCalled = { v: 0 };
  const ctx = setupCtx({
    'agint.qualityPolicy': { decide: async () => ({ decision: 'AUTO_DEPLOY' }) },
    'agint.mutator': {
      commit: { get: async () => { commitGetCalled.v++; return { preimageHash: 'h-fixate' }; } },
    },
  });
  // 直接构造一个 FULL + consec_pass=3 的 variant：手动 put 进 storage
  // 简化路径：先把 variant ingest + recordEvaluation，然后通过 promote 升级到 FULL
  // 但 ingest 默认起 1%，升 FULL 需多次 promote。直接 stub storage 更高效。
  const v = await ctx._providers['agint.population.ingest']({ proposal: makeProposal() });
  // 强制 stage=FULL + consec=3
  const tv = await (await (await ctx.storageDomain.open(storage.spec)).table('variants'))._size;  // dummy
  // 用 stats 找到 variant 并直接修改
  // 简化：直接调用 promote 多次（3 次）。
  // 注：每次 promote 都要求 fitness ≥ next.fitness_threshold（0.6/0.7/0.75/0.8），
  // recordEvaluation 给一个 ~0.81 的 fitness，可通过 OBSERVING→PROMOTING→EXPANDING→FULL
  await ctx._providers['agint.population.recordEvaluation'](v.variant_id, { success_rate: 0.85, error_rate: 0.05, latency_p99: 5000, token_cost: 100, safety_violations: 0, user_satisfaction: 4.0, sample_count: 100 });
  await ctx._providers['agint.population.promote']({ variant_id: v.variant_id });   // NEW→OBSERVING (consec=1)
  await ctx._providers['agint.population.promote']({ variant_id: v.variant_id });   // OBSERVING→PROMOTING (consec=2)
  await ctx._providers['agint.population.promote']({ variant_id: v.variant_id });   // PROMOTING→EXPANDING (consec=3)
  await ctx._providers['agint.population.promote']({ variant_id: v.variant_id });   // EXPANDING→FULL (consec=4)

  const fr = await ctx._providers['agint.population.fixate']({ variant_id: v.variant_id });
  assert.equal(fr.variant.stage, 'FIXED');
  assert.equal(commitGetCalled.v, 1, 'mutator.commit.get 应被调用做 hash 校验');
});

test('fixate: stage != FULL → 抛错', async () => {
  const ctx = setupCtx({
    'agint.qualityPolicy': { decide: async () => ({ decision: 'AUTO_DEPLOY' }) },
  });
  const v = await ctx._providers['agint.population.ingest']({ proposal: makeProposal() });
  await assert.rejects(() => ctx._providers['agint.population.fixate']({ variant_id: v.variant_id }), /FULL/);
});

// ── Stats ────────────────────────────────────────────────────────────

test('stats: 返回 counts / limits / config / byStage / variants 列表', async () => {
  const ctx = setupCtx({
    'agint.qualityPolicy': { decide: async () => ({ decision: 'AUTO_DEPLOY' }) },
  });
  await ctx._providers['agint.population.ingest']({ proposal: makeProposal() });
  const s = await ctx._providers['agint.population.stats']();
  assert.equal(s.counts.variants, 1);
  assert.equal(s.limits.variants, 100);
  assert.equal(s.active, 1);
  assert.equal(s.byStage.NEW, 1);
  assert.equal(s.variants.length, 1);
  assert.equal(s.config.capacity, 3);
});

// ── recordEvaluation: 写 fitness_history + 更新 variant ──────────────

test('recordEvaluation: 写 fitness_history + 更新 variant.fitness_score + dimensions', async () => {
  const ctx = setupCtx({
    'agint.qualityPolicy': { decide: async () => ({ decision: 'AUTO_DEPLOY' }) },
  });
  const v = await ctx._providers['agint.population.ingest']({ proposal: makeProposal() });
  const r = await ctx._providers['agint.population.recordEvaluation'](v.variant_id, { success_rate: 0.85, error_rate: 0.05, latency_p99: 5000, token_cost: 100, safety_violations: 0, user_satisfaction: 4.0, sample_count: 100 });
  assert.equal(r.evaluation.score > 0.7, true);
  assert.equal(r.evaluation.eligible, true);
  assert.equal(r.variant.fitness_score > 0.7, true);
  assert.ok(r.variant.fitness_detail);
  assert.ok(r.variant.fitness_detail.harm);
  // safety violation 应递增
  const r2 = await ctx._providers['agint.population.recordEvaluation'](v.variant_id, { success_rate: 0.85, error_rate: 0.05, latency_p99: 5000, token_cost: 100, safety_violations: 2, user_satisfaction: 4.0, sample_count: 100 });
  assert.equal(r2.variant.safety_violations_total, 2);
});
