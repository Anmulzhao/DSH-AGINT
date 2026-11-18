/**
 * test/abtest-v2.test.mjs — v2.1 注入与生命周期（方案 §九.4）
 *
 * 覆盖：
 *   1. _internal.putSample：确定性 id、score 夹 0..1、参数校验、终态拒注
 *   2. 幂等：同 (testId, taskId, variant) 重复注入不增行
 *   3. report 配对取样：任务难度混杂下配对显著而 pool 不显著；未配对样本不计入
 *   4. _internal.abort：置 aborted；查不到抛错
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = pathToFileURL(resolve(__dirname, '../lib/index.js')).href;

function makeMockCtx() {
  const effects = [];
  const providers = {};
  const tables = {};
  const storageDomain = {
    open: async () => ({
      async table(name) {
        if (!tables[name]) tables[name] = new Map();
        return {
          put: async (id, value) => { tables[name].set(id, value); return true; },
          get: (id) => tables[name].get(id) ?? null,
          delete: async (id) => { tables[name].delete(id); return true; },
          entries: () => Array.from(tables[name].values()),
          get size() { return tables[name].size; },
        };
      },
    }),
  };
  return {
    _effects: effects,
    effect: (fn) => { effects.push(fn); },
    get: () => null,
    provide: (name, val) => { providers[name] = val; },
    storageDomain,
    on: () => {},
    _providers: providers,
    _tables: tables,
  };
}

const SUITE = Array.from({ length: 12 }, (_, k) => `t${k}`);

async function freshTest(ctx, mod) {
  mod.apply(ctx, {});
  const ab = ctx._providers['agint.abtest'];
  const r = await ab.start({
    variantA: { promptId: 'plugin-preflight', version: 'old' },
    variantB: { promptId: 'plugin-preflight', version: 'new' },
    taskSuite: SUITE,
  });
  return ab;
}

// ── 1. putSample 基础 ──────────────────────────────────────────────────

test('putSample: 确定性 id = smp-<testId>-<taskId>-<variant>', async () => {
  const ctx = makeMockCtx();
  const mod = await import(PLUGIN_PATH);
  const ab = await freshTest(ctx, mod);
  const { testId } = await ab.start({
    variantA: { promptId: 'p', version: 'a' }, variantB: { promptId: 'p', version: 'b' }, taskSuite: SUITE,
  });
  await ab._internal.putSample({ testId, variant: 'A', taskId: 't0', score: 0.8 });
  const row = ctx._tables.samples.get(`smp-${testId}-t0-A`);
  assert.ok(row, '应按确定性 id 落行');
  assert.equal(row.score, 0.8);
  assert.equal(row.kind, 'sample');
});

test('putSample: score 夹 0..1（1.5→1，-0.2→0）', async () => {
  const ctx = makeMockCtx();
  const mod = await import(PLUGIN_PATH);
  const ab = await freshTest(ctx, mod);
  const { testId } = await ab.start({
    variantA: { promptId: 'p', version: 'a' }, variantB: { promptId: 'p', version: 'b' }, taskSuite: SUITE,
  });
  await ab._internal.putSample({ testId, variant: 'A', taskId: 't0', score: 1.5 });
  await ab._internal.putSample({ testId, variant: 'B', taskId: 't0', score: -0.2 });
  assert.equal(ctx._tables.samples.get(`smp-${testId}-t0-A`).score, 1);
  assert.equal(ctx._tables.samples.get(`smp-${testId}-t0-B`).score, 0);
});

test('putSample: 缺 testId / 非法 variant / 非有限 score → throws', async () => {
  const ctx = makeMockCtx();
  const mod = await import(PLUGIN_PATH);
  const ab = await freshTest(ctx, mod);
  const { testId } = await ab.start({
    variantA: { promptId: 'p', version: 'a' }, variantB: { promptId: 'p', version: 'b' }, taskSuite: SUITE,
  });
  await assert.rejects(() => ab._internal.putSample({ variant: 'A', taskId: 't0', score: 0.5 }), /testId/);
  await assert.rejects(() => ab._internal.putSample({ testId, variant: 'C', taskId: 't0', score: 0.5 }), /variant/);
  await assert.rejects(() => ab._internal.putSample({ testId, variant: 'A', taskId: 't0', score: NaN }), /score/);
  await assert.rejects(() => ab._internal.putSample({ testId: 'abt-ghost', variant: 'A', taskId: 't0', score: 0.5 }), /查不到/);
});

// ── 2. 幂等 ────────────────────────────────────────────────────────────

test('putSample: 同 (testId,taskId,variant) 重复注入不增行，覆盖旧分', async () => {
  const ctx = makeMockCtx();
  const mod = await import(PLUGIN_PATH);
  const ab = await freshTest(ctx, mod);
  const { testId } = await ab.start({
    variantA: { promptId: 'p', version: 'a' }, variantB: { promptId: 'p', version: 'b' }, taskSuite: SUITE,
  });
  await ab._internal.putSample({ testId, variant: 'A', taskId: 't0', score: 0.5 });
  await ab._internal.putSample({ testId, variant: 'A', taskId: 't0', score: 0.9 });
  assert.equal(ctx._tables.samples.size, 1, '重复注入不得增行');
  assert.equal(ctx._tables.samples.get(`smp-${testId}-t0-A`).score, 0.9);
});

// ── 3. report 配对取样 ─────────────────────────────────────────────────

test('report: 任务难度混杂——配对显著而独立 pool 不显著 → winner=A', async () => {
  const ctx = makeMockCtx();
  const mod = await import(PLUGIN_PATH);
  const ab = await freshTest(ctx, mod);
  const { testId } = await ab.start({
    variantA: { promptId: 'p', version: 'a' }, variantB: { promptId: 'p', version: 'b' }, taskSuite: SUITE,
  });
  // base 在 0.05..0.85 大幅变化（任务难度），A 恒比 B 高 ~0.12（带抖动）。
  // pool 两组：均值差 0.12 但组内方差大 → 不显著；配对差值稳定 → 显著。
  const jitter = [0.01, -0.01, 0.02, 0.0, -0.02, 0.01, 0.02, -0.01, 0.0, 0.01, -0.02, 0.02];
  for (let i = 0; i < 12; i++) {
    const base = 0.05 + i * 0.07;
    await ab._internal.putSample({ testId, variant: 'B', taskId: `t${i}`, score: base });
    await ab._internal.putSample({ testId, variant: 'A', taskId: `t${i}`, score: base + 0.12 + jitter[i] });
  }
  const r = await ab.report({ testId });
  assert.equal(r.winner, 'A', `配对检验应判 A，实际 ${r.winner}（p=${r.pValue}）`);
  assert.equal(r.samples, 24);
});

test('report: 未配对样本不计入——10 对 + 1 条 A-only → samples=20', async () => {
  const ctx = makeMockCtx();
  const mod = await import(PLUGIN_PATH);
  const ab = await freshTest(ctx, mod);
  const { testId } = await ab.start({
    variantA: { promptId: 'p', version: 'a' }, variantB: { promptId: 'p', version: 'b' }, taskSuite: SUITE,
  });
  for (let i = 0; i < 10; i++) {
    await ab._internal.putSample({ testId, variant: 'A', taskId: `t${i}`, score: 0.8 + (i % 3) * 0.01 });
    await ab._internal.putSample({ testId, variant: 'B', taskId: `t${i}`, score: 0.5 + (i % 4) * 0.01 });
  }
  await ab._internal.putSample({ testId, variant: 'A', taskId: 't-orphan', score: 0.9 });
  const r = await ab.report({ testId });
  assert.equal(r.samples, 20, '孤儿样本不得计入');
});

// ── 4. abort 与终态拒注 ────────────────────────────────────────────────

test('abort: 置 status=aborted；listTests 可见；查不到抛错', async () => {
  const ctx = makeMockCtx();
  const mod = await import(PLUGIN_PATH);
  const ab = await freshTest(ctx, mod);
  const { testId } = await ab.start({
    variantA: { promptId: 'p', version: 'a' }, variantB: { promptId: 'p', version: 'b' }, taskSuite: SUITE,
  });
  await ab._internal.abort({ testId, reason: 'timeout-24h' });
  const { tests } = await ab.listTests();
  const row = tests.find((t) => t.testId === testId);
  assert.equal(row.status, 'aborted');
  await assert.rejects(() => ab._internal.abort({ testId: 'abt-ghost' }), /查不到/);
});

test('putSample: 终态实验（completed/aborted）拒绝注入', async () => {
  const ctx = makeMockCtx();
  const mod = await import(PLUGIN_PATH);
  const ab = await freshTest(ctx, mod);
  const { testId } = await ab.start({
    variantA: { promptId: 'p', version: 'a' }, variantB: { promptId: 'p', version: 'b' }, taskSuite: SUITE,
  });
  await ab._internal.abort({ testId, reason: 'manual' });
  await assert.rejects(
    () => ab._internal.putSample({ testId, variant: 'A', taskId: 't0', score: 0.5 }),
    /终态/,
  );
});

test('listSamples: 按 testId 读回样本（续跑去重用）', async () => {
  const ctx = makeMockCtx();
  const mod = await import(PLUGIN_PATH);
  const ab = await freshTest(ctx, mod);
  const { testId } = await ab.start({
    variantA: { promptId: 'p', version: 'a' }, variantB: { promptId: 'p', version: 'b' }, taskSuite: SUITE,
  });
  await ab._internal.putSample({ testId, variant: 'A', taskId: 't0', score: 0.5 });
  await ab._internal.putSample({ testId, variant: 'B', taskId: 't0', score: 0.6 });
  const { samples } = await ab._internal.listSamples({ testId });
  assert.equal(samples.length, 2);
  assert.ok(samples.every((s) => s.testId === testId));
  const empty = await ab._internal.listSamples({ testId: 'abt-none' });
  assert.equal(empty.samples.length, 0);
});

test('results: 只读最新终态实验结论——不标状态、不发事件、不写表', async () => {
  const ctx = makeMockCtx();
  const mod = await import(PLUGIN_PATH);
  const ab = await freshTest(ctx, mod);
  const { testId } = await ab.start({
    variantA: { promptId: 'p', version: 'a' }, variantB: { promptId: 'p', version: 'b' }, taskSuite: SUITE,
  });
  for (let i = 0; i < 12; i++) {
    await ab._internal.putSample({ testId, variant: 'A', taskId: `t${i}`, score: 0.7 + (i % 3) * 0.02 });
    await ab._internal.putSample({ testId, variant: 'B', taskId: `t${i}`, score: 0.5 + (i % 4) * 0.01 });
  }
  // running 状态 → results 为空（未 report 的实验不进 policy）
  assert.deepEqual(await ab._internal.results(), []);
  await ab.report({ testId });
  const rowsBefore = ctx._tables.abtests.size;
  const r = await ab._internal.results();
  assert.equal(r.length, 1);
  assert.equal(r[0].testId, testId);
  assert.equal(r[0].winner, 'A');
  assert.equal(typeof r[0].pValue, 'number');
  assert.equal(ctx._tables.abtests.size, rowsBefore, 'results 不得写表');
});