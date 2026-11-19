/**
 * agint-evolution-driver: bucket-writer.js（B 包写端）。
 * Run: node --test plugins/agint-evolution-driver/test/bucket-writer.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBucketWriter } from '../lib/bucket-writer.js';

const NOW = '2026-11-19T00:00:00.000Z';

function outcomeOver(over = {}) {
  return {
    contractId: 'c1', targetMetric: 'SUCCESS_RATE',
    actualDelta: 2, predictedDelta: 3, predictionQuality: 0.8,
    isDeadZone: false, ...over,
  };
}
function entryOver(over = {}) {
  return { contractId: 'c1', summary: { mutationType: 'PROMPT_MUTATION' }, ...over };
}
function makeEvo({ outcomes = [], entries = [] } = {}) {
  const buckets = new Map();
  return {
    buckets,
    listPredictionOutcomes: async () => outcomes,
    ledger: { list: async () => entries },
    recordKnowledgeBucket: async (b) => { buckets.set(b.bucketKey, b); return { ...b }; },
  };
}
function build(evo, warns = []) {
  return createBucketWriter(
    { get: (n) => (n === 'agint.evolution' ? evo : null) },
    { warn: (m, e) => warns.push([m, e]), now: () => NOW },
  );
}

test('W1: 按 mutationType::targetMetric 分组；DA 从存储字段重算；lastUpdated 注入', async () => {
  const evo = makeEvo({
    outcomes: [outcomeOver(), outcomeOver({ contractId: 'c2', actualDelta: 4, predictionQuality: 0.9 })],
    entries: [entryOver(), entryOver({ contractId: 'c2' })],
  });
  const r = await build(evo).rebuild();
  assert.equal(r.ok, true);
  assert.equal(r.bucketsWritten, 1);
  assert.equal(r.sampleTotal, 2);
  const b = evo.buckets.get('PROMPT_MUTATION::SUCCESS_RATE');
  assert.equal(b.sampleSize, 2);
  assert.equal(b.confidence, 'CALIBRATING');
  assert.equal(b.directionalAccuracy, 1, '两条同向 ⇒ DA=1');
  assert.equal(b.lastUpdated, NOW);
});

test('W2: pq=null 剔除（NOT_PREDICTED 无校准可言）', async () => {
  const evo = makeEvo({
    outcomes: [outcomeOver(), outcomeOver({ contractId: 'c2', predictionQuality: null, pqReason: 'NOT_PREDICTED' })],
    entries: [entryOver(), entryOver({ contractId: 'c2' })],
  });
  const r = await build(evo).rebuild();
  assert.equal(r.sampleTotal, 1);
  assert.equal(r.skipped.noPQ, 1);
});

test('W3: 无 ledger 条目 / 无 mutationType ⇒ 跳过计数，⛔ 不猜', async () => {
  const evo = makeEvo({
    outcomes: [outcomeOver(), outcomeOver({ contractId: 'c2' }), outcomeOver({ contractId: 'c3' })],
    entries: [entryOver(), entryOver({ contractId: 'c3', summary: {} })],
  });
  const r = await build(evo).rebuild();
  assert.equal(r.skipped.noLedgerEntry, 1);
  assert.equal(r.skipped.noMutationType, 1);
  assert.equal(r.sampleTotal, 1);
});

test('W4: 空表 ⇒ 0 桶 ok:true；服务缺方法 ⇒ SERVICE_UNAVAILABLE 不抛', async () => {
  const r0 = await build(makeEvo()).rebuild();
  assert.deepEqual({ ok: r0.ok, n: r0.bucketsWritten }, { ok: true, n: 0 });
  const r1 = await build({}).rebuild();
  assert.equal(r1.ok, false);
  assert.equal(r1.status, 'SERVICE_UNAVAILABLE');
});

test('W5: recordKnowledgeBucket 抛错 ⇒ 外壳收回，ok:false 不毁整轮', async () => {
  const evo = makeEvo({ outcomes: [outcomeOver()], entries: [entryOver()] });
  evo.recordKnowledgeBucket = async () => { throw new Error('disk full'); };
  const warns = [];
  const r = await build(evo, warns).rebuild();
  assert.equal(r.ok, false);
  assert.equal(r.status, 'RECORD_FAILED');
  assert.ok(warns.length > 0);
});
