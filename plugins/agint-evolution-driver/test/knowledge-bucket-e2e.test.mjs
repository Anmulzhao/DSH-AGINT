/**
 * B 包 E2E：真 memory 服务（真 dsh-storage-json）+ 真 ledger + 真 locker。
 * 10 条同类 STABLE 样本 ⇒ L3 胜出；9 条 ⇒ 仍降级。
 * Run: node --test plugins/agint-evolution-driver/test/knowledge-bucket-e2e.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';

import { createBucketWriter } from '../lib/bucket-writer.js';
import { createPredictionLocker } from '../lib/prediction-locker.js';
import { scorePrediction, deadZoneThreshold } from '../lib/prediction-scoring.js';

const BUCKET_KEY = 'PROMPT_MUTATION::SUCCESS_RATE';

/** 起真 agint.evolution：真 DomainFacility + 真 JsonStorageBackend（⛔ 不 mock 存储域）。 */
async function openEvolution(root) {
  const backend = new JsonStorageBackend(root);
  const domainCtx = {
    logger: { error: () => {}, warn: () => {} },
    effect: (fn) => { fn(); },
    on: () => {},
    storage: { backend: { get: (n) => (n === 'json' ? backend : undefined) } },
  };
  const facility = new DomainFacility(domainCtx, { backend: 'json', routes: {} });
  const ctx = {
    storageDomain: facility,
    effect: (fn) => { fn(); },
    get: () => null,
    on: () => {},
    logger: { warn: () => {} },
    provide(name, val) { this._provided = this._provided ?? {}; this._provided[name] = val; },
  };
  const mod = await import('../../agint-evolution-memory/lib/index.js');
  mod.apply(ctx, {});
  await new Promise((r) => setImmediate(r));
  return { evo: ctx._provided['agint.evolution'], backend };
}

/** 经真服务入 n 条同类条目 + 实测记录（actualDelta 取 1..n 的偶数序列）。 */
async function seedSamples(evo, n) {
  for (let i = 0; i < n; i += 1) {
    const contractId = `EVO-B-${String(i).padStart(2, '0')}`;
    const ts = `2026-11-19T00:00:${String(i).padStart(2, '0')}.000Z`;
    await evo.ledger.append({
      contractId,
      generation: 'GEN-B',
      summary: {
        mutationType: 'PROMPT_MUTATION',
        changedPlugins: ['agint-demo'],
        targetMetric: 'SUCCESS_RATE',
        hypothesisDigest: 'B 包样本',
        predictedDelta: 3,
        predictionSource: 'DEFAULT_RULE',
        decision: 'AUTO_DEPLOY',
      },
      references: {},
      timestamp: ts,
    });
    const actualDelta = (i + 1) * 2;
    const scored = scorePrediction({ predictedDelta: 3, actualDelta, targetMetric: 'SUCCESS_RATE' });
    const dz = deadZoneThreshold('SUCCESS_RATE');
    await evo.recordPredictionOutcome({
      contractId,
      measuredAt: ts,
      method: 'TEST_CORPUS_PAIR_RUN',
      targetMetric: 'SUCCESS_RATE',
      changedPath: 'plugins/agint-demo/lib/index.js',
      testFiles: ['plugins/agint-demo/test/demo.test.mjs'],
      baseline: { passed: 1, failed: 1, total: 2, passRate: 0.5 },
      candidate: { passed: 2, failed: 0, total: 2, passRate: 1 },
      actualDelta,
      predictedDelta: 3,
      predictionQuality: scored.pq,
      isDeadZone: Math.abs(actualDelta) < dz.threshold,
      deadZoneThreshold: dz.threshold,
      baselineNoiseStd: 0,
      restoreVerified: true,
    });
  }
}

function makeCtx(evo) {
  return { get: (n) => (n === 'agint.evolution' ? evo : null) };
}

async function runCase(n, contractId) {
  const root = await mkdtemp(join(tmpdir(), 'agint-bucket-e2e-'));
  const { evo, backend } = await openEvolution(root);
  try {
    await seedSamples(evo, n);
    const writer = createBucketWriter(makeCtx(evo), { now: () => '2026-11-19T00:00:00.000Z' });
    const rebuilt = await writer.rebuild();
    assert.equal(rebuilt.ok, true, JSON.stringify(rebuilt));
    assert.equal(rebuilt.sampleTotal, n);

    const bucket = await evo.getKnowledgeBucket(BUCKET_KEY);
    assert.ok(bucket, '桶必须落表');
    assert.equal(bucket.sampleSize, n);

    const locker = createPredictionLocker(makeCtx(evo), { now: () => '2026-11-19T00:00:00.000Z' });
    const locked = await locker.lock({
      contractId,
      mutationType: 'PROMPT_MUTATION',
      targetMetric: 'SUCCESS_RATE',
      changedComponents: ['agint-demo'],
    });
    return { bucket, locked };
  } finally { await backend.close(); await rm(root, { recursive: true, force: true }); }
}

test('E2E: 10 条同类样本 ⇒ STABLE 桶通电 L3，predictedDelta=桶中位数', async () => {
  const { bucket, locked } = await runCase(10, 'e2e-l3-10');
  assert.equal(bucket.confidence, 'STABLE');
  assert.equal(bucket.medianActualDelta, 11, '样本 2..20 的中位数 = 11');
  assert.equal(locked.status, 'LOCKED', JSON.stringify(locked));
  assert.equal(locked.predictionSource, 'KNOWLEDGE_BASE');
  assert.equal(locked.predictedDelta, 11);
});

test('E2E 对照: 9 条同类样本 ⇒ 仍 PROVISIONAL，L3 不先验', async () => {
  const { bucket, locked } = await runCase(9, 'e2e-l3-9');
  assert.equal(bucket.confidence, 'PROVISIONAL');
  assert.notEqual(locked.predictionSource, 'KNOWLEDGE_BASE');
});
