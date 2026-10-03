/**
 * agint-evolution-memory: prediction_outcomes 表服务（Phase 1.1 支点 1b / R1′）
 *
 * 覆盖的是**存储侧**的四条纪律，不是测量逻辑（测量在 driver 的 outcome-measurer）：
 *   1. 只存不算       → 服务不做任何测量/打分，原样落 schema.parse 后的 entry
 *   2. 不可覆盖       → 同 contractId 二次写入抛 prediction-outcome-already-exists，
 *                       且**首条内容不变**（事后挑一次好看的数字重写校准史 = §4.2.5 禁止）
 *   3. 覆盖门不可绕过 → testFiles: [] 在存储层同样拒收（测不到不是度量）
 *   4. 超限只 warn    → 计数超 LIMITS 仍落盘、仍列在 list 里，⛔ 不 prune
 *
 * 表句柄形状对齐宿主真实 API（dsh-storage-domain KvTableImpl）：`entries()` 返回
 * **[key, value] 迭代器**、`get` 返回存活对象、`size` 是 getter、**没有 has()**。
 * 每张表各自一个 Map —— 锁与实测记录的 key 同为 contractId，共用一个 Map 会假阳性。
 *
 * Run: node --test plugins/agint-evolution-memory/test/prediction-outcomes.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LIMITS } from '../lib/schema.js';

function makeTable() {
  const records = new Map();
  const writes = [];
  return {
    records,
    writes,
    entries: () => [...records.entries()][Symbol.iterator](),
    keys: () => [...records.keys()][Symbol.iterator](),
    get: (k) => records.get(k),
    get size() { return records.size; },
    async put(k, v) {
      writes.push(k);
      records.set(k, v);
      return true;
    },
  };
}

/** 起真插件：mock storageDomain，按表名分 Map，返回提供的 agint.evolution 服务。 */
async function bootPlugin() {
  const tables = new Map();
  const tableOf = (name) => {
    if (!tables.has(name)) tables.set(name, makeTable());
    return tables.get(name);
  };
  const warns = [];
  const ctx = {
    storageDomain: {
      open: async () => ({ table: async (name) => tableOf(name), close: async () => {} }),
    },
    effect: (fn) => { fn(); },
    get: () => null,
    on: () => {},
    logger: { warn: (msg, extra) => warns.push([msg, extra]) },
    provide(name, val) { this._provided = this._provided ?? {}; this._provided[name] = val; },
  };
  const mod = await import('../lib/index.js');
  mod.apply(ctx, {});
  await new Promise(r => setImmediate(r));
  return { evo: ctx._provided['agint.evolution'], tableOf, warns };
}

function outcomeEntry(over = {}) {
  return {
    contractId: 'EVO-0001',
    measuredAt: '2026-10-03T09:00:00.000Z',
    method: 'TEST_CORPUS_PAIR_RUN',
    targetMetric: 'SUCCESS_RATE',
    changedPath: 'plugins/agint-cron/lib/jobs.js',
    testFiles: ['plugins/agint-cron/test/schedule-layout.test.mjs'],
    baseline: { passed: 8, failed: 3, total: 11, passRate: 8 / 11 },
    candidate: { passed: 11, failed: 0, total: 11, passRate: 1 },
    actualDelta: 27.3,
    restoreVerified: true,
    ...over,
  };
}

// ── 1. 服务暴露 ────────────────────────────────────────────────────────────

test('T1: agint.evolution 提供 record/get/list PredictionOutcome 三个方法', async () => {
  const { evo } = await bootPlugin();
  assert.equal(typeof evo.recordPredictionOutcome, 'function');
  assert.equal(typeof evo.getPredictionOutcome, 'function');
  assert.equal(typeof evo.listPredictionOutcomes, 'function');
});

// ── 2. 正常路径 + 默认值补全 ───────────────────────────────────────────────

test('T2: 落盘成功，schema 默认值补齐（predictedDelta null / isDeadZone false / evidence 逐项 null）', async () => {
  const { evo, tableOf } = await bootPlugin();
  const saved = await evo.recordPredictionOutcome(outcomeEntry());

  assert.equal(saved.contractId, 'EVO-0001');
  assert.equal(saved.predictedDelta, null);
  assert.equal(saved.predictionQuality, null);
  assert.equal(saved.pqReason, null);
  assert.equal(saved.isDeadZone, false);
  assert.equal(saved.deadZoneThreshold, null);
  assert.equal(saved.baselineNoiseStd, null);
  assert.equal(saved.evidence.preimagePath, null);
  assert.equal(saved.evidence.hypothesisLock, null);
  assert.equal(saved._warn, undefined, '未超限不该带 _warn');

  const t = tableOf('prediction_outcomes');
  assert.deepEqual(t.writes, ['EVO-0001'], 'put 的 key 必须是 contractId');
  assert.deepEqual(t.get('EVO-0001'), saved);
});

test('T3: 读回是拷贝（顶层字段改写不污染表内；嵌套数组按 getContractLock 惯例仍是共享引用）', async () => {
  const { evo, tableOf } = await bootPlugin();
  await evo.recordPredictionOutcome(outcomeEntry());
  const stored = tableOf('prediction_outcomes').get('EVO-0001');
  const got = await evo.getPredictionOutcome('EVO-0001');
  assert.notEqual(got, stored, '必须返回新对象，不是表内存活对象本身');
  got.actualDelta = 999;
  got.baseline.passed = 0;
  assert.equal(stored.actualDelta, 27.3);
  // ⚠️ 已知边界：`{...rec}` 是浅拷贝，got.baseline 与表内同一个对象 ⇒ 改嵌套字段会穿透。
  // 与 getContractLock / listContractLocks 同一条惯例，读侧不改写即可；深拷贝留给真有需求时。
  assert.equal(stored.baseline.passed, 0, '浅拷贝：嵌套层改写会穿透（本测试如实记录，不假装防住了）');
});

test('T3b: 落盘值与 caller 传入的入参解耦（parse 产出新对象/新数组）', async () => {
  const { evo, tableOf } = await bootPlugin();
  const input = outcomeEntry();
  const testFiles = input.testFiles;
  await evo.recordPredictionOutcome(input);
  input.actualDelta = 0;
  testFiles.push('after-the-fact.js');
  const stored = tableOf('prediction_outcomes').get('EVO-0001');
  assert.equal(stored.actualDelta, 27.3);
  assert.equal(stored.testFiles.length, 1, 'caller 事后改自己的数组不得影响表内');
});

test('T4: get 缺失返回 null；空/假 id 也返回 null（不抛）', async () => {
  const { evo } = await bootPlugin();
  assert.equal(await evo.getPredictionOutcome('EVO-NOPE'), null);
  assert.equal(await evo.getPredictionOutcome(''), null);
  assert.equal(await evo.getPredictionOutcome(null), null);
});

// ── 3. 不可覆盖（防事后偏守卫）─────────────────────────────────────────────

test('T5: 同 contractId 二次写入抛 already-exists，且首条内容不变', async () => {
  const { evo, tableOf } = await bootPlugin();
  await evo.recordPredictionOutcome(outcomeEntry());
  await assert.rejects(
    () => evo.recordPredictionOutcome(outcomeEntry({ actualDelta: 99, measuredAt: '2026-10-09T09:00:00.000Z' })),
    /prediction-outcome-already-exists/,
  );
  const t = tableOf('prediction_outcomes');
  assert.equal(t.size, 1, '二次写入不得新增行');
  assert.equal(t.get('EVO-0001').actualDelta, 27.3, '⛔ 覆盖即篡改：首条必须原样留着');
  assert.deepEqual(t.writes, ['EVO-0001'], '拒写路径不得触到 put');
});

test('T6: 缺 contractId 直接抛（不给 schema 造出一条无主记录）', async () => {
  const { evo } = await bootPlugin();
  await assert.rejects(() => evo.recordPredictionOutcome(outcomeEntry({ contractId: '' })), /contractId is required/);
  await assert.rejects(() => evo.recordPredictionOutcome(undefined), /contractId is required/);
});

// ── 4. 覆盖门与形状：schema 在存储层再拦一道 ───────────────────────────────

test('T7: 非法 entry 一律拒收，且拒收后表里不留半成品', async () => {
  const { evo, tableOf } = await bootPlugin();
  const bad = [
    ['testFiles 为空数组（覆盖门不可绕过）', outcomeEntry({ testFiles: [] })],
    ['testFiles 含空串', outcomeEntry({ testFiles: [''] })],
    ['total 为 0（无分母即无测量）', outcomeEntry({ baseline: { passed: 0, failed: 0, total: 0, passRate: 0 } })],
    ['passRate 越界', outcomeEntry({ candidate: { passed: 1, failed: 0, total: 1, passRate: 1.2 } })],
    ['measuredAt 缺毫秒与时区', outcomeEntry({ measuredAt: '2026-10-03T09:00:00' })],
    ['method 非枚举值', outcomeEntry({ method: 'GUESS' })],
    ['targetMetric 非枚举值', outcomeEntry({ targetMetric: 'HAPPINESS' })],
    ['restoreVerified 缺失（护栏未核 = 不可信）', (() => { const e = outcomeEntry(); delete e.restoreVerified; return e; })()],
    ['actualDelta 非数（null 不是「没有改进」）', outcomeEntry({ actualDelta: null })],
  ];
  for (const [label, entry] of bad) {
    await assert.rejects(() => evo.recordPredictionOutcome(entry), /./, `${label} 应被拒收`);
  }
  assert.equal(tableOf('prediction_outcomes').size, 0);
});

test('T8: prediction_outcomes 与 contract_locks 各自独立（同 key 不串表）', async () => {
  const { evo, tableOf } = await bootPlugin();
  await evo.recordContractLock({
    contractId: 'EVO-0001',
    hypothesisLock: `sha256:${'a'.repeat(64)}`,
    lockedAt: '2026-10-03T08:00:00.000Z',
  });
  await evo.recordPredictionOutcome(outcomeEntry());
  assert.match(tableOf('contract_locks').get('EVO-0001').hypothesisLock, /^sha256:/);
  assert.equal(tableOf('prediction_outcomes').get('EVO-0001').actualDelta, 27.3);
  assert.ok(await evo.getContractLock('EVO-0001'));
  assert.ok(await evo.getPredictionOutcome('EVO-0001'));
});

test('T9: listPredictionOutcomes 返回全部记录（Phase 1 收口门槛从这里数）', async () => {
  const { evo } = await bootPlugin();
  assert.deepEqual(await evo.listPredictionOutcomes(), []);
  for (const id of ['EVO-A', 'EVO-B']) {
    await evo.recordPredictionOutcome(outcomeEntry({ contractId: id }));
  }
  const all = await evo.listPredictionOutcomes();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map(r => r.contractId).sort(), ['EVO-A', 'EVO-B']);
});

// ── 5. 超限只 warn 不 prune ────────────────────────────────────────────────

test('T10: 计数超 LIMITS 仍落盘、仍在 list 里（只 warn，⛔ 不删历史）', async () => {
  const { evo, tableOf } = await bootPlugin();
  const n = LIMITS.PREDICTION_OUTCOMES;
  assert.ok(n >= 1000, 'LIMITS 被测试用作循环次数，缩水到千级以下要重写本用例');

  let last = null;
  for (let i = 0; i < n; i++) {
    last = await evo.recordPredictionOutcome(outcomeEntry({
      contractId: `EVO-${i}`,
      evidence: { ledgerSeq: i },
    }));
  }
  assert.equal(last._warn, undefined, `正好 ${n} 条时不该报警`);

  const over = await evo.recordPredictionOutcome(outcomeEntry({ contractId: `EVO-${n}` }));
  assert.match(over._warn ?? '', /prediction_outcomes count/);
  assert.equal(tableOf('prediction_outcomes').size, n + 1, '超限后条目数必须还在增长 = 没被 prune');
  assert.equal((await evo.listPredictionOutcomes()).length, n + 1);
  assert.equal((await evo.getPredictionOutcome('EVO-0'))?.actualDelta, 27.3, '最早那条不得被轮转掉');
});

test('T11: R2 的 method 与 evidence.entryTargetMetric 过 schema（0.6.10 加的两栏）', async () => {
  const { evo } = await bootPlugin();
  const row = await evo.recordPredictionOutcome(outcomeEntry({
    contractId: 'EVO-R2',
    method: 'SKILL_GATE_PAIR_RUN',
    testFiles: ['presets/agint/skills/demo/SKILL.md', 'eval/skills/agint/demo.cases.json'],
  }));
  assert.equal(row.method, 'SKILL_GATE_PAIR_RUN');
  assert.equal(row.evidence.entryTargetMetric, null,
    '缺失必须显式为 null（与 zod 的 .default({}) 不回落内层那条坑同源，见 schema 注）');

  const row2 = await evo.recordPredictionOutcome(outcomeEntry({
    contractId: 'EVO-R2B', method: 'SKILL_GATE_PAIR_RUN',
    evidence: { entryTargetMetric: 'unspecified' },
  }));
  assert.equal(row2.evidence.entryTargetMetric, 'unspecified', '条目原话要留得住');
  assert.equal(row2.evidence.preimagePath, null, '部分 evidence 的其余项照样补 null');

  const bad = await evo.recordPredictionOutcome(
    outcomeEntry({ contractId: 'EVO-R2C', method: 'SKILL_GATE_RUN' }),
  ).catch((e) => e);
  assert.ok(bad instanceof Error, 'method 拼错必须被 zod 拦下（两把尺子的名字不许混写）');
  assert.equal(await evo.getPredictionOutcome('EVO-R2C'), null, '拒收后表里不留半成品');
});
