/**
 * 提案 55d8eb24：memory_forget_scan 的「0 动作自解释」。
 *
 * 背景：池子里没有任何条目达到 90 天门槛时，扫描返回「0 planned, 0 applied」。
 * 这个结果既可能是「机制正常但池子太新」，也可能是「机制坏了」。
 * report 增加 oldestEntryDays / nextThresholdDays / nextTransition 后，
 * 0 动作自带原因：oldest=42d, L1->L2 in 48d。
 *
 * 为什么有一节端到端：只测 scanHorizon 纯函数，证明不了 decayScanRun 真的
 * 把字段并进了 report（函数级单测证明不了上游有没有调用它，K143）。
 * 所以这里用 fake ctx 起真插件、真调 service、真喂 render。
 *
 * 运行：node --test plugins/agint-memory/test/forget-scan-horizon.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { scanHorizon, THRESHOLDS } from '../lib/decay.js';
import { apply as applyService } from '../lib/index.js';
import { apply as applyTools } from '../lib/tools.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const iso = (daysAgo, now = Date.now()) => new Date(now - daysAgo * DAY).toISOString();
const entry = (daysAgo, level = 'L1', now = Date.now()) => ({
  level,
  confidence: 0.8,
  lastRecall: iso(daysAgo, now),
  updatedAt: iso(daysAgo, now),
  content: `row-${daysAgo}-${level}`,
});

/** 起真插件，拿到 ctx.provide 出来的 agint.memory service。 */
function makeService(rows) {
  const store = new Map(rows.map(([id, e]) => [id, { ...e }]));
  const table = {
    entries: () => store.entries(),
    get: (id) => store.get(id),
    put: async (id, rec) => { store.set(id, rec); return rec; },
    delete: async (id) => store.delete(id),
  };
  let service = null;
  const ctx = {
    storageDomain: { open: async () => ({ table: () => table, close: async () => {} }) },
    provide(name, svc) { if (name === 'agint.memory') service = svc; },
    effect() {},
    get() { return undefined; }, // 订阅初始化走软降级，不牵扯事件总线
  };
  applyService(ctx);
  assert.ok(service, 'fake ctx 必须拿到 agint.memory service');
  return service;
}

function forgetScanTool(service) {
  const registered = [];
  applyTools({
    'agint.memory': service,
    tools: { register(def) { registered.push(def); } },
  });
  const tool = registered.find((t) => t.name === 'memory_forget_scan');
  assert.ok(tool, 'memory_forget_scan 未注册');
  return tool;
}

function render(tool, value) {
  return tool.output.render({}, value).map((part) => part.text).join('\n');
}

// ── 纯函数：口径与边界 ────────────────────────────────────────────────

test('scanHorizon: 空池三个字段都是 null', () => {
  assert.deepEqual(scanHorizon([], NOW), {
    oldestEntryDays: null,
    nextThresholdDays: null,
    nextTransition: null,
  });
});

test('scanHorizon: 42 天 L1 报 oldest=42 / L1->L2 还差 48 天', () => {
  const h = scanHorizon([['a', entry(42, 'L1', NOW)]], NOW);
  assert.equal(h.oldestEntryDays, 42);
  assert.equal(h.nextThresholdDays, 48);
  assert.equal(h.nextTransition, 'L1->L2');
  // oldest + remaining 必须等于 L1 门槛，口径不能被别处改写
  assert.equal(h.oldestEntryDays + h.nextThresholdDays, THRESHOLDS.L1);
});

test('scanHorizon: 取全池最近的一个阈值，不是最老那条自己的阈值', () => {
  const h = scanHorizon([
    ['a', entry(42, 'L1', NOW)],   // 离 L1->L2 还差 48 天
    ['b', entry(170, 'L2', NOW)],  // 离 L2->L3 只差 10 天
    ['c', entry(1, 'L1', NOW)],
  ], NOW);
  assert.equal(h.oldestEntryDays, 170);
  assert.equal(h.nextThresholdDays, 10);
  assert.equal(h.nextTransition, 'L2->L3');
});

test('scanHorizon: L4 不进降级候选（clear 需 resolved/replaced，不是降级）', () => {
  const h = scanHorizon([['a', { ...entry(800, 'L4', NOW), resolved: true }]], NOW);
  assert.equal(h.oldestEntryDays, 800);
  assert.equal(h.nextThresholdDays, null);
  assert.equal(h.nextTransition, null);
});

test('scanHorizon: 天数口径回退到 updatedAt / createdAt，与 decayScan 同源', () => {
  const onlyCreated = { level: 'L1', createdAt: iso(30, NOW) };
  const h = scanHorizon([['a', onlyCreated]], NOW);
  assert.equal(h.oldestEntryDays, 30);
  assert.equal(h.nextThresholdDays, 60);
});

// ── negative control：判据对数据变化必须敏感 ──────────────────────────

test('negative control: 同一条数据跨过 90 天，nextThresholdDays 必须从 48 变 0 且产生动作', async () => {
  const fresh = await makeService([['a', entry(42)]]).decayScanRun({ apply: false });
  const stale = await makeService([['a', entry(95)]]).decayScanRun({ apply: false });
  assert.equal(fresh.actions.length, 0);
  assert.ok(fresh.report.nextThresholdDays > 47 && fresh.report.nextThresholdDays < 49);
  assert.equal(stale.report.nextThresholdDays, 0);
  assert.equal(stale.actions.length, 1);
  // 若有人把 scanHorizon 从 report 里摘掉，上面三行至少有一行会变红。
});

// ── 端到端：真 service → 真 report → 真 render ─────────────────────────

test('decayScanRun: 0 动作的 report 自带 oldest / nextThreshold（本次改动的生产出口）', async () => {
  const service = makeService([
    ['a', entry(42)],
    ['b', entry(10)],
    ['c', entry(3)],
  ]);
  const out = await service.decayScanRun({ apply: false });
  assert.equal(out.actions.length, 0, '池子太新，应该 0 动作');
  assert.equal(out.applied.length, 0);
  assert.equal(out.report.scanned, 3, '既有 report 字段不能丢');
  assert.ok(out.report.counts, '既有 counts 不能丢');
  assert.ok(Math.abs(out.report.oldestEntryDays - 42) < 0.11);
  assert.ok(Math.abs(out.report.nextThresholdDays - 48) < 0.11);
  assert.equal(out.report.nextTransition, 'L1->L2');
});

test('render: 0 动作时打印解释行，且仍保留原有动作明细行', async () => {
  const service = makeService([['a', entry(42)]]);
  const tool = forgetScanTool(service);
  const out = await tool.execute({ apply: false });
  const text = render(tool, out);
  assert.match(text, /^memory_forget_scan: 0 planned, 0 applied/);
  assert.match(text, /oldest=42d, L1->L2 in 48d/);
  assert.equal(tool.output.schema.properties.report.additionalProperties, true,
    'report 必须允许新增字段，否则 strict-mode 会把 horizon 丢掉');
});

test('render: 空池与无待降级池都不打印 in nulld', async () => {
  const empty = forgetScanTool(makeService([]));
  const emptyText = render(empty, await empty.execute({ apply: false }));
  assert.match(emptyText, /oldest=n\/a \(empty pool\)/);

  const l4 = forgetScanTool(makeService([['a', { ...entry(800, 'L4'), resolved: true }]]));
  const l4Text = render(l4, await l4.execute({ apply: false }));
  assert.match(l4Text, /oldest=800d, no pending downgrade/);
  assert.doesNotMatch(l4Text, /in nulld/);
});

test('decayScanRun: apply:true 应用动作后，report 仍带 horizon', async () => {
  const service = makeService([['a', entry(95)]]);
  const out = await service.decayScanRun({ apply: true });
  assert.equal(out.applied.length, 1);
  assert.equal(out.report.nextThresholdDays, 0);
  assert.equal(out.report.nextTransition, 'L1->L2');
  assert.ok(out.report.oldestEntryDays >= 95);
});
