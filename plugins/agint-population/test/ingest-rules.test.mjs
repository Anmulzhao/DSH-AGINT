// Ingest 边界条件 / 输入校验专项测试。

import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../lib/index.js';
import { makeCtx } from './mock-ctx.mjs';

function setup(softDeps = {}) {
  const ctx = makeCtx({ softDeps });
  apply(ctx);
  return ctx;
}

function makeProposal(overrides = {}) {
  return {
    id: 'p-' + Math.random().toString(36).slice(2, 8),
    kind: 'PROMPT_MUTATION',
    source: 'attribution-driven',
    atomicScope: 'prompt',
    payload: { promptId: 'sys', oldText: 'a', newText: 'b', diffStrategy: 'unified_diff' },
    expectedEffect: { metric: 'success_rate', direction: 'increase', window: '7d' },
    rollbackCondition: { trigger: 'regression >10% → rollback' },
    ...overrides,
  };
}

// ── Ingest: 5 类 expectedEffect/rollbackCondition 边界 ──────────────────

test('ingest: expectedEffect 字符串形式（≥5 字符）→ 通过', async () => {
  const ctx = setup({ 'agint.qualityPolicy': { decide: async () => ({ decision: 'PENDING_REVIEW' }) } });
  const p = makeProposal({ expectedEffect: 'baseline 通过率 >= 95% 在 7 天' });
  const r = await ctx._providers['agint.population.ingest']({ proposal: p });
  assert.equal(r.stage, 'PENDING_REVIEW');
});

test('ingest: expectedEffect 字符串过短（<5）→ 抛错', async () => {
  const ctx = setup({});
  const p = makeProposal({ expectedEffect: 'abc' });
  await assert.rejects(() => ctx._providers['agint.population.ingest']({ proposal: p }), /expectedEffect/);
});

test('ingest: rollbackCondition 字符串形式（≥3 字符）→ 通过', async () => {
  const ctx = setup({ 'agint.qualityPolicy': { decide: async () => ({ decision: 'PENDING_REVIEW' }) } });
  const p = makeProposal({ rollbackCondition: 'harm >10% → rollback' });
  const r = await ctx._providers['agint.population.ingest']({ proposal: p });
  assert.equal(r.stage, 'PENDING_REVIEW');
});

test('ingest: rollbackCondition 字符串过短（<3）→ 抛错', async () => {
  const ctx = setup({});
  const p = makeProposal({ rollbackCondition: 'no' });
  await assert.rejects(() => ctx._providers['agint.population.ingest']({ proposal: p }), /rollbackCondition/);
});

test('ingest: 缺 proposal → 抛错（input 校验）', async () => {
  const ctx = setup({});
  await assert.rejects(() => ctx._providers['agint.population.ingest']({}), /invalid input|proposal/);
});

test('ingest: parent_variant_id 透传', async () => {
  const ctx = setup({ 'agint.qualityPolicy': { decide: async () => ({ decision: 'AUTO_DEPLOY' }) } });
  const r = await ctx._providers['agint.population.ingest']({ proposal: makeProposal(), parent_variant_id: 'parent-abc' });
  assert.equal(r.parent_variant_id, 'parent-abc');
});

test('ingest: parent_variant_id 默认 null', async () => {
  const ctx = setup({ 'agint.qualityPolicy': { decide: async () => ({ decision: 'AUTO_DEPLOY' }) } });
  const r = await ctx._providers['agint.population.ingest']({ proposal: makeProposal() });
  assert.equal(r.parent_variant_id, null);
});

test('ingest: generation 透传', async () => {
  const ctx = setup({ 'agint.qualityPolicy': { decide: async () => ({ decision: 'AUTO_DEPLOY' }) } });
  const r = await ctx._providers['agint.population.ingest']({ proposal: makeProposal(), generation: 7 });
  assert.equal(r.generation, 7);
});

// ── Ingest: 3 类 source 枚举覆盖 ────────────────────────────────────────

for (const source of ['attribution-driven', 'dream-random', 'evolution-reversed']) {
  test(`ingest: source='${source}' → 创 variant 保留 source 字段`, async () => {
    const ctx = setup({ 'agint.qualityPolicy': { decide: async () => ({ decision: 'AUTO_DEPLOY' }) } });
    const r = await ctx._providers['agint.population.ingest']({ proposal: makeProposal({ source }) });
    assert.equal(r.source, source);
  });
}

// ── Ingest: 3 类 mutation_kind 枚举覆盖 ─────────────────────────────────

for (const kind of ['PROMPT_MUTATION', 'TOOL_SYNTHESIS', 'STRATEGY_REWRITE']) {
  test(`ingest: kind='${kind}' → 创 variant 保留 kind 字段`, async () => {
    const ctx = setup({ 'agint.qualityPolicy': { decide: async () => ({ decision: 'AUTO_DEPLOY' }) } });
    const r = await ctx._providers['agint.population.ingest']({ proposal: makeProposal({ kind }) });
    assert.equal(r.mutation_kind, kind);
  });
}

// ── Ingest: traffic_log 必须写入 ────────────────────────────────────────

test('ingest: AUTO_DEPLOY 写 traffic_log (INGEST reason)', async () => {
  const ctx = setup({ 'agint.qualityPolicy': { decide: async () => ({ decision: 'AUTO_DEPLOY' }) } });
  const v = await ctx._providers['agint.population.ingest']({ proposal: makeProposal() });
  const s = await ctx._providers['agint.population.stats']();
  assert.equal(s.counts.traffic_log, 1, 'AUTO_DEPLOY 必须写 1 条 traffic_log');
});
