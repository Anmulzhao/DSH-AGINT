/**
 * agint-self-model — 校准读数三缺陷回归（提案 4df1c0db）。
 *
 * 跑法：node --test plugins/agint-self-model/test/calibration-readout.test.mjs
 * 用 import.meta.url 相对定位，不依赖 cwd（部署位同样跑得通）。
 *
 * 三个缺陷：
 *   1. queryTemplates 不读 days ⇒ 窗口不对称，actual 恒 1
 *   2. getPriorPredicted 恒 null ⇒ predicted 从 calibration_log 自引用，恒 0
 *   3. success_template 没有 category ⇒ domain 退化成 unknown
 * 每条配一个 negative control，防止断言假绿。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const selfModel = await import(new URL('../lib/index.js', import.meta.url));

const DAY = 86_400_000;
const fresh = () => new Date().toISOString();
const stale = () => new Date(Date.now() - 30 * DAY).toISOString();

function mockCtx(services) {
  const provided = new Map(Object.entries(services));
  return {
    get: (k) => provided.get(k) ?? null,
    provide: (k, v) => provided.set(k, v),
    effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {}; } catch { return () => {}; } },
    storageDomain: { open: () => { throw new Error('test: no real storage'); } },
    on: () => () => {},
  };
}

function makeHarness({ failures, templates }) {
  const calls = { failures: [], templates: [] };
  const evolution = {
    queryFailures: async (opts) => { calls.failures.push(opts); return failures(); },
    queryTemplates: async (opts) => { calls.templates.push(opts); return templates(); },
    addFailure: async () => ({}),
    getLogRange: async () => [],
    stats: async () => ({}),
  };
  const services = {
    'agint.eventBus.publish': async () => ({ accepted: true }),
    'agint.eventBus.subscribe': () => () => {},
    'agint.evolution': evolution,
    'agint.diagnosis': {
      report: async () => ({
        rootCauseDistribution: {
          REASONING_ERROR: 1, PLANNING_FAILURE: 0, PROMPT_DEFICIENCY: 0,
          TOOL_GAP: 0, KNOWLEDGE_GAP: 0, ENVIRONMENT_SHIFT: 0, UNCERTAIN: 0,
        },
      }),
    },
    'agint.metrics': {
      snapshot: async () => ({ metrics: [] }), collect: async () => ({}), summary: async () => ({ metrics: [] }),
    },
    'agint.toolStats': { summary: async () => ({ summary: [] }) },
  };
  const ctx = mockCtx(services);
  selfModel.apply(ctx, {});
  return {
    calls,
    services,
    update: ctx.get('agint.selfModel.update'),
    snapshot: ctx.get('agint.selfModel.snapshot'),
    calibrate: ctx.get('agint.selfModel.calibrate'),
  };
}

test('① 窗口对称：queryTemplates 的过期行不进 actual', async () => {
  const h = makeHarness({
    failures: () => [{ category: 'codegen', pattern: 'pf1', updatedAt: fresh() }],
    templates: () => [
      { category: 'codegen', pattern: 'pt1', updatedAt: fresh() },
      { category: 'codegen', pattern: 'pt-stale', updatedAt: stale() },
    ],
  });
  await h.update({ trigger: 'weekly' });
  const res = await h.calibrate({ windowDays: 7 });
  const row = res.find((r) => r.domain === 'codegen');
  assert.ok(row, 'codegen 域必须有校准结果');
  // 1 条 failure + 1 条窗口内 template = 2；旧实现会把过期 template 也算进来 = 3
  assert.equal(row.samples, 2, '过期 template 必须被窗口过滤');
  assert.deepEqual(h.calls.failures.at(-1), { days: 7 }, 'failures 必须带 days');
  assert.deepEqual(h.calls.templates.at(-1), { days: 7 }, 'templates 必须带 days');
});

test('① 负控制：windowDays 不传时不过滤，过期行仍计入', async () => {
  const h = makeHarness({
    failures: () => [{ category: 'codegen', pattern: 'pf1', updatedAt: fresh() }],
    templates: () => [
      { category: 'codegen', pattern: 'pt1', updatedAt: fresh() },
      { category: 'codegen', pattern: 'pt-stale', updatedAt: stale() },
    ],
  });
  await h.update({ trigger: 'weekly' });
  // DEFAULT_CALIBRATION_WINDOW_DAYS 也会被算成窗口，故用显式大窗口做对照
  const res = await h.calibrate({ windowDays: 365 });
  const row = res.find((r) => r.domain === 'codegen');
  assert.equal(row.samples, 3, '365 天窗口下过期行应保留，证明①不是碰巧');
});

test('② 域归属：success_template 用 appliesTo，不再退化成 unknown', async () => {
  const h = makeHarness({
    failures: () => [{ category: 'codegen', pattern: 'pf1', updatedAt: fresh() }],
    templates: () => [{ appliesTo: ['skill-autocreate'], pattern: 'pt1', updatedAt: fresh() }],
  });
  await h.update({ trigger: 'weekly' });
  const res = await h.calibrate({ windowDays: 7 });
  assert.ok(res.some((r) => r.domain === 'skill-autocreate'), 'appliesTo 必须成为域');
  assert.equal(res.some((r) => r.domain === 'unknown'), false, '不应再出现 unknown 域');
});

test('③ predicted 来自能力图 confidence，不再恒 0', async () => {
  const h = makeHarness({
    failures: () => [
      { category: 'codegen', pattern: 'pf1', updatedAt: fresh() },
      { category: 'codegen', pattern: 'pf2', updatedAt: fresh() },
    ],
    templates: () => [{ category: 'codegen', pattern: 'pt1', updatedAt: fresh() }],
  });
  await h.update({ trigger: 'weekly' });
  const snap = await h.snapshot({});
  // 前提：能力图里必须真有一个非零 confidence，否则本用例可能假绿
  const nonZero = snap.capabilities.filter((c) => c.confidence > 0);
  assert.ok(nonZero.length > 0, 'fixture 前提：至少一个域 confidence > 0');
  const res = await h.calibrate({ windowDays: 7 });
  for (const c of nonZero) {
    const row = res.find((r) => r.domain === c.domain);
    if (!row) continue;
    assert.equal(row.predicted, c.confidence, `${c.domain} 的 predicted 必须等于 confidence`);
  }
});

test('③ 负控制：能力图没有的域仍回落到 0，证明非零来自接线', async () => {
  let phase = 'seed';
  const h = makeHarness({
    failures: () => phase === 'seed'
      ? [{ category: 'codegen', pattern: 'pf1', updatedAt: fresh() }]
      : [{ category: 'brand-new-domain', pattern: 'pf2', updatedAt: fresh() }],
    templates: () => [],
  });
  await h.update({ trigger: 'weekly' });
  phase = 'novel';
  const res = await h.calibrate({ windowDays: 7 });
  const row = res.find((r) => r.domain === 'brand-new-domain');
  assert.ok(row, '新域应出现在校准结果里');
  assert.equal(row.predicted, 0, '能力图无该域时 predicted 回落到 0');
});
