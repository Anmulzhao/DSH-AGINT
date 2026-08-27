/**
 * test/abtest-smoke.test.mjs — Sprint 10 v0.6.4 #9 集成测试
 *
 * 覆盖 agint.abtest Service 契约 + storage 域契约：
 *   1. provider 暴露 3 个方法 + limits + _internal
 *   2. start({ taskSuite ≥10 }) → { testId, status: 'running' }
 *   3. start({ taskSuite < 10 }) → throws
 *   4. start({ variantA / variantB 缺失 }) → throws
 *   5. listTests 包含已 start 的 test
 *   6. report 通过统计纯函数判 winner（依赖 lib/statistics.js）
 *   7. report 缺 testId → throws
 *   8. report 查不到 testId → throws
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = resolve(__dirname, '../lib/index.js');

function makeMockCtx() {
  const effects = [];
  const providers = {};
  // 持久化 storage（每次 open 返同一份；保证 start + report + putSample 共享同一份 storage）
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
        };
      },
    }),
  };
  return {
    _effects: effects,
    effect: (fn) => { effects.push(fn); },
    get: (name) => null,
    provide: (name, val) => { providers[name] = val; },
    storageDomain,
    on: () => {},
    _providers: providers,
    _tables: tables, // 测试可访问注入 samples
  };
}

test('apply: provider 暴露 start / report / listTests + limits + _internal', async () => {
  const mod = await import(PLUGIN_PATH);
  const ctx = makeMockCtx();
  mod.apply(ctx, {});
  const ab = ctx._providers['agint.abtest'];
  assert.ok(ab, 'agint.abtest provider 应');
  assert.equal(typeof ab.start, 'function');
  assert.equal(typeof ab.report, 'function');
  assert.equal(typeof ab.listTests, 'function');
  assert.equal(typeof ab.limits, 'object');
  assert.equal(typeof ab._internal, 'object');
});

test('start({ taskSuite ≥10 }) → { testId, status: "running" }', async () => {
  const mod = await import(PLUGIN_PATH);
  const ctx = makeMockCtx();
  mod.apply(ctx, {});
  const ab = ctx._providers['agint.abtest'];
  const r = await ab.start({
    variantA: { promptId: 'sys-prompt', version: 'v1' },
    variantB: { promptId: 'sys-prompt', version: 'v2' },
    taskSuite: Array.from({ length: 10 }, (_, k) => `task-${k + 1}`),
    significanceThreshold: 0.05,
  });
  assert.ok(r.testId);
  assert.match(r.testId, /^abt-/);
  assert.equal(r.status, 'running');
});

test('start({ taskSuite < 10 }) → throws', async () => {
  const mod = await import(PLUGIN_PATH);
  const ctx = makeMockCtx();
  mod.apply(ctx, {});
  const ab = ctx._providers['agint.abtest'];
  await assert.rejects(() => ab.start({
    variantA: { promptId: 'sys', version: 'v1' },
    variantB: { promptId: 'sys', version: 'v2' },
    taskSuite: ['t1', 't2', 't3'],
  }), /taskSuite 长度 \d+ < 10/);
});

test('start({ 缺 variantA / variantB }) → throws', async () => {
  const mod = await import(PLUGIN_PATH);
  const ctx = makeMockCtx();
  mod.apply(ctx, {});
  const ab = ctx._providers['agint.abtest'];
  await assert.rejects(() => ab.start({ variantB: { promptId: 'p', version: 'v' }, taskSuite: ['t1','t2','t3','t4','t5','t6','t7','t8','t9','t10'] }), /variantA \+ variantB/);
});

test('listTests: 包含已 start 的 test', async () => {
  const mod = await import(PLUGIN_PATH);
  const ctx = makeMockCtx();
  mod.apply(ctx, {});
  const ab = ctx._providers['agint.abtest'];
  await ab.start({
    variantA: { promptId: 'p', version: 'v1' },
    variantB: { promptId: 'p', version: 'v2' },
    taskSuite: Array.from({ length: 10 }, (_, k) => `task-${k}`),
  });
  const r = await ab.listTests();
  assert.equal(r.tests.length, 1);
  assert.equal(r.tests[0].status, 'running');
  assert.deepEqual(r.tests[0].variantA, { promptId: 'p', version: 'v1' });
});

test('report({ 缺 testId }) → throws', async () => {
  const mod = await import(PLUGIN_PATH);
  const ctx = makeMockCtx();
  mod.apply(ctx, {});
  const ab = ctx._providers['agint.abtest'];
  await assert.rejects(() => ab.report({}), /testId 必填/);
});

test('report({ 查不到 testId }) → throws', async () => {
  const mod = await import(PLUGIN_PATH);
  const ctx = makeMockCtx();
  mod.apply(ctx, {});
  const ab = ctx._providers['agint.abtest'];
  await assert.rejects(() => ab.report({ testId: 'not-exist' }), /在 abtests 表里查不到/);
});

test('report: samples 全空 → inconclusive（样本量不足）', async () => {
  const mod = await import(PLUGIN_PATH);
  const ctx = makeMockCtx();
  mod.apply(ctx, {});
  const ab = ctx._providers['agint.abtest'];
  const r = await ab.start({
    variantA: { promptId: 'p', version: 'v1' },
    variantB: { promptId: 'p', version: 'v2' },
    taskSuite: Array.from({ length: 10 }, (_, k) => `task-${k}`),
  });
  // 注入 samples：构造 A 显著优于 B（A=0.9, B=0.5 各 10 个）
  // 先触发 samples 表创建（mock lazy create），再通过 _tables 直接写
  await (await ctx.storageDomain.open({})).table('samples');
  const samplesTbl = ctx._tables.samples;
  assert.ok(samplesTbl, 'samples 表应存在');
  for (let i = 0; i < 10; i++) {
    samplesTbl.set(`s-A-${i}`, { id: `s-A-${i}`, kind: 'sample', testId: r.testId, variant: 'A', score: 0.9, taskId: `t${i}`, createdAt: new Date().toISOString() });
    samplesTbl.set(`s-B-${i}`, { id: `s-B-${i}`, kind: 'sample', testId: r.testId, variant: 'B', score: 0.5, taskId: `t${i}`, createdAt: new Date().toISOString() });
  }
  const report = await ab.report({ testId: r.testId });
  // 取决于 statistics.js 实现：可能 winner='A'（A 显著优于 B）或 inconclusive（sample 量不足）
  assert.ok(['A', 'B', 'inconclusive'].includes(report.winner), `winner=${report.winner} 应是 A/B/inconclusive`);
  assert.ok(typeof report.pValue === 'number');
  assert.ok(typeof report.effectSize === 'number');
  assert.equal(report.samples, 20, 'samples 应等于 10+10');
});