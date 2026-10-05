/**
 * agint-mount — 种群登记接线回归测试（W2，2026-10-05）
 * Run: node --test plugins/agint-mount/test/population-ingest.test.mjs
 *
 * 接线出处：README「与兄弟插件的接口」—— mount → `agint.population.ingest`（仅 SMOKE PASS 后调用），
 * 新个体标 origin=synthesized。此前这条只写在文档里，代码从不调用，被家族面板判为悬空声明。
 *
 * 本测试锁死两件事：
 *  ① 解析形态 —— event-bus 那起事故（bus-resolve.test.mjs 记着）证明「只认一种取法」会静默
 *     降级成生产 0 条，所以子键 / 裸键 / get / getService 四种形态任一可用都必须解析出 ingest。
 *  ② 软失败纪律 —— 登记不成**只带 reason 回来，绝不抛错**。挂载已成功的产物不该因为种群留痕
 *     失败而被判失败；但原因必须说清，不许静默。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePopulationIngest, recordSynthesizedVariant } from '../lib/orchestrator.js';

const GOOD_PROPOSAL = {
  id: 'prop-1',
  kind: 'TOOL_SYNTHESIS',
  atomicScope: 'prompt',
  expectedEffect: { metric: 'success_rate', direction: 'increase', window: '7d' },
  rollbackCondition: { trigger: 'regression >10% → rollback' },
  payload: { source: 'x' },
};

// ── ① 解析形态 ────────────────────────────────────────────────────────

test('分服务名形态：ctx.get("agint.population.ingest") 优先命中', () => {
  const ingest = async () => ({ variant_id: 'v1' });
  const ctx = { get: (k) => (k === 'agint.population.ingest' ? ingest : undefined), getService: () => undefined };
  assert.equal(resolvePopulationIngest(ctx), ingest);
});

test('getService 只给子键时也要能解析出来', () => {
  const ingest = async () => ({});
  const ctx = { get: () => undefined, getService: (k) => (k === 'agint.population.ingest' ? ingest : undefined) };
  assert.equal(resolvePopulationIngest(ctx), ingest);
});

test('只有裸键对象形态：取 .ingest 且必须 bind 到服务对象', async () => {
  const bus = {
    label: 'population',
    async ingest(input) { return { variant_id: `ok-${this.label}`, echo: input }; },
  };
  const ctx = { get: (k) => (k === 'agint.population' ? bus : undefined), getService: () => undefined };
  const fn = resolvePopulationIngest(ctx);
  assert.equal(typeof fn, 'function', '裸键对象必须解析出 ingest');
  const r = await fn({ proposal: GOOD_PROPOSAL });
  assert.equal(r.variant_id, 'ok-population', 'this 丢失就说明没 bind（裸键形态会当场失效）');
});

test('两种键都不可得 → null，不抛错', () => {
  assert.equal(resolvePopulationIngest({ get: () => undefined, getService: () => undefined }), null);
  assert.equal(resolvePopulationIngest({}), null, 'ctx 连 get/getService 都没有时必须安静返回 null');
});

// ── ② 软失败纪律 ──────────────────────────────────────────────────────

test('服务缺位 → ingested:false + 原因，不抛错', async () => {
  const r = await recordSynthesizedVariant({ get: () => undefined, getService: () => undefined }, GOOD_PROPOSAL, 't-1');
  assert.equal(r.ingested, false);
  assert.match(r.reason, /agint\.population\.ingest unavailable/);
  assert.equal(r.ticketId, 't-1', '结果要能归位到具体 ticket');
});

test('正常路径 → 投 ingest，并补 origin=synthesized', async () => {
  let seen = null;
  const ctx = { get: (k) => (k === 'agint.population.ingest' ? async (input) => { seen = input; return { variant_id: 'v-42' }; } : undefined), getService: () => undefined };
  const r = await recordSynthesizedVariant(ctx, GOOD_PROPOSAL, 't-2');
  assert.equal(r.ingested, true);
  assert.equal(r.variantId, 'v-42');
  assert.equal(seen.proposal.source, 'synthesized', '设计稿要求新个体标 origin=synthesized');
  assert.equal(seen.parent_variant_id, null);
});

test('proposal 自带 source 时尊重原归属，不覆盖成 synthesized', async () => {
  let seen = null;
  const ctx = { get: (k) => (k === 'agint.population.ingest' ? async (input) => { seen = input; return {}; } : undefined), getService: () => undefined };
  await recordSynthesizedVariant(ctx, { ...GOOD_PROPOSAL, source: 'attribution-driven' }, 't-3');
  assert.equal(seen.proposal.source, 'attribution-driven');
});

test('缺 expectedEffect / rollbackCondition → 先自挡并说明原因，不去制造假失败样本', async () => {
  let called = 0;
  const ctx = { get: (k) => (k === 'agint.population.ingest' ? async () => { called++; return {}; } : undefined), getService: () => undefined };
  const r = await recordSynthesizedVariant(ctx, { id: 'p', kind: 'X' }, 't-4');
  assert.equal(r.ingested, false);
  assert.match(r.reason, /missing expectedEffect\/rollbackCondition/);
  assert.equal(called, 0, '自挡必须在调用 ingest 之前 —— ingest 会抛错并顺带写 failure_pattern');
});

test('ingest 抛错 → 带回原因，绝不外抛', async () => {
  const ctx = { get: (k) => (k === 'agint.population.ingest' ? async () => { throw new Error('variants table full'); } : undefined), getService: () => undefined };
  const r = await recordSynthesizedVariant(ctx, GOOD_PROPOSAL, 't-5');
  assert.equal(r.ingested, false);
  assert.match(r.reason, /ingest threw: variants table full/);
});

test('proposal 非法形态（null / 非对象）→ invalid-proposal，不抛错', async () => {
  const ctx = { get: (k) => (k === 'agint.population.ingest' ? async () => ({}) : undefined), getService: () => undefined };
  for (const bad of [null, undefined, 42, 'str']) {
    const r = await recordSynthesizedVariant(ctx, bad, 't-6');
    assert.equal(r.ingested, false, `非法 proposal ${String(bad)} 必须判未登记`);
    assert.match(r.reason, /invalid-proposal/);
  }
});
