/**
 * agint-abtest — abtest.started / abtest.concluded 发布接线测试（2026-10-26）
 * Run: node --test plugins/agint-abtest/test/bus-publish.test.mjs
 *
 * 背景：agint-abtest 此前对事件总线零感知（check-wiring 查 E' 的 UNWIRED）——
 *   A/B 结论**从未送达任何下游**，quality-eval / metrics 想看结论只能反查存储。
 *
 * ⚠️ 本测试证明的是「接线正确」，**不是「该域有生产数据」**：
 *   生产 `agint_abtest` 存储域至今 DEAD（start() 从未被真实调用）。接线 ≠ 通电。
 *
 * 本测试锁死三组契约：
 *   1. 发布侧 —— start → abtest.started；report → abtest.concluded（带 winner/pValue）；
 *   2. 不造事件 —— start 参数不合法（taskSuite < 10）抛错且不发事件；
 *   3. 直连红线 —— bus 缺席或 publish 抛错时 start/report 语义完全不变。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

function makeMockCtx({ bus } = {}) {
  const tables = new Map();
  const ctx = {
    _provides: new Map(),
    _warns: [],
    logger: { warn: (msg, extra) => { ctx._warns.push({ msg, extra }); } },
    storageDomain: {
      async open(spec) {
        return {
          name: spec.name,
          version: spec.version,
          table(name) {
            let t = tables.get(name);
            if (!t) { t = new Map(); tables.set(name, t); }
            return {
              get: (id) => t.get(id) ?? null,
              put: async (id, value) => { t.set(id, value); return true; },
              entries: () => [...t.values()],
              get size() { return t.size; },
            };
          },
          async close() {},
        };
      },
    },
    effect(fn) { fn(); },
    provide(k, v) { this._provides.set(k, v); },
    get(k) { return this._provides.get(k) ?? null; },
    on() {},
  };
  if (typeof bus === 'function') ctx.provide('agint.eventBus.publish', bus);
  else if (bus) ctx.provide('agint.eventBus', bus);
  return ctx;
}

function recorder() {
  const envelopes = [];
  const fn = async (env) => {
    envelopes.push(env);
    return { envelopeId: 'env-1', deliveredTo: 0, deadLettered: 0 };
  };
  fn.envelopes = envelopes;
  return fn;
}

function makeAbtest(bus) {
  const ctx = makeMockCtx({ bus });
  apply(ctx, {});
  return { ctx, abtest: ctx.get('agint.abtest') };
}

const VA = { promptId: 'p-a', version: '1' };
const VB = { promptId: 'p-b', version: '1' };
/** 门槛：任务集 ≥10（设计稿 §二.6，老板拍板初版） */
const TASK_SUITE = Array.from({ length: 10 }, (_, i) => `task-${i}`);

/** 往 samples 表塞一批分数（report 的输入） */
async function seedSamples(ctx, testId, scoresA, scoresB) {
  const d = await ctx.storageDomain.open({ name: 'agint_abtest', version: 1 });
  const t = d.table('samples');
  for (const [i, s] of scoresA.entries()) {
    const id = `s-a-${i}`;
    await t.put(id, { id, kind: 'sample', testId, variant: 'A', score: s, taskId: `task-${i}`, createdAt: new Date().toISOString() });
  }
  for (const [i, s] of scoresB.entries()) {
    const id = `s-b-${i}`;
    await t.put(id, { id, kind: 'sample', testId, variant: 'B', score: s, taskId: `task-${i}`, createdAt: new Date().toISOString() });
  }
}

// ─────────────────── 1. 发布侧 ───────────────────

test('start() 发布 abtest.started，载荷带 variant / taskSuiteSize', async () => {
  const rec = recorder();
  const { abtest } = makeAbtest(rec);

  const { testId, status } = await abtest.start({ variantA: VA, variantB: VB, taskSuite: TASK_SUITE });
  assert.equal(status, 'running');

  assert.equal(rec.envelopes.length, 1, `start 应发恰好 1 条，实际 ${rec.envelopes.length}`);
  const env = rec.envelopes[0];
  assert.equal(env.topic, 'abtest.started');
  assert.equal(env.version, 1);
  assert.equal(env.source, 'agint-abtest');
  assert.equal(env.payload.testId, testId);
  assert.deepEqual(env.payload.variantA, VA);
  assert.deepEqual(env.payload.variantB, VB);
  assert.equal(env.payload.taskSuiteSize, 10, '下游要据此判断统计功效，不能只记「开跑了」');
});

test('report() 发布 abtest.concluded，载荷带 winner / pValue', async () => {
  const rec = recorder();
  const { ctx, abtest } = makeAbtest(rec);
  const { testId } = await abtest.start({ variantA: VA, variantB: VB, taskSuite: TASK_SUITE });
  rec.envelopes.length = 0;

  // A 组显著更好 ⇒ 应判 winner=A
  await seedSamples(ctx, testId, [92, 93, 94, 95, 96, 97, 98, 99, 100, 98], [40, 42, 41, 43, 45, 44, 46, 47, 48, 49]);
  const result = await abtest.report({ testId });

  assert.equal(rec.envelopes.length, 1, `report 应发恰好 1 条，实际 ${rec.envelopes.length}`);
  const env = rec.envelopes[0];
  assert.equal(env.topic, 'abtest.concluded');
  assert.equal(env.payload.testId, testId);
  assert.equal(env.payload.winner, result.winner, '载荷里的结论必须与返回值一致，否则下游拿到的是另一个世界');
  assert.equal(env.payload.pValue, result.pValue);
  assert.ok(env.payload.samples, '样本量是判断结论可信度的前提');
});

// ─────────────────── 2. 不造事件 ───────────────────

test('start 参数非法（taskSuite < 10）时抛错且不发事件', async () => {
  const rec = recorder();
  const { abtest } = makeAbtest(rec);
  await assert.rejects(
    () => abtest.start({ variantA: VA, variantB: VB, taskSuite: ['only-one'] }),
    /长度 1 < 10/,
  );
  assert.equal(rec.envelopes.length, 0, '开跑失败不该产生 started 事件');
});

test('report 对不存在的 testId 抛错且不发事件', async () => {
  const rec = recorder();
  const { abtest } = makeAbtest(rec);
  await assert.rejects(() => abtest.report({ testId: 'abt-ghost' }), /查不到/);
  assert.equal(rec.envelopes.length, 0);
});

// ─────────────────── 3. 直连红线 ───────────────────

test('红线：bus 缺席时 start / report 照常成功', async () => {
  const { ctx, abtest } = makeAbtest(null);
  const { testId, status } = await abtest.start({ variantA: VA, variantB: VB, taskSuite: TASK_SUITE });
  assert.equal(status, 'running', 'bus 缺席不该让 start 失败');

  await seedSamples(ctx, testId, [90, 91, 92, 93, 94, 95, 96, 97, 98, 99], [30, 31, 32, 33, 34, 35, 36, 37, 38, 39]);
  const result = await abtest.report({ testId });
  assert.ok(['A', 'B', 'inconclusive'].includes(result.winner));
});

test('红线：publish 抛错时 start 照常成功，并留下告警', async () => {
  const { ctx, abtest } = makeAbtest(async () => { throw new Error('bus exploded'); });
  const { status } = await abtest.start({ variantA: VA, variantB: VB, taskSuite: TASK_SUITE });
  assert.equal(status, 'running', 'publish 抛错不该让 start 失败');
  assert.ok(
    ctx._warns.some((w) => String(w.msg).includes('abtest.started')),
    'publish 失败必须留下告警（K64：静默失败无人知晓）',
  );
});

// ───────────── 4. 探测形态（K63 回归防线） ─────────────

test('伞键形态（agint.eventBus.publish 挂在对象上）也能发布', async () => {
  const rec = recorder();
  const { abtest } = makeAbtest({ publish: rec });
  await abtest.start({ variantA: VA, variantB: VB, taskSuite: TASK_SUITE });
  assert.equal(rec.envelopes.length, 1, '伞键形态下没发布 —— 探测形态写窄了');
  assert.equal(rec.envelopes[0].topic, 'abtest.started');
});
