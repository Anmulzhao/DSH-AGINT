/**
 * agint-evolution-memory: knowledge_buckets 表（B 包）。
 * Run: node --test plugins/agint-evolution-memory/test/knowledge-buckets.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { knowledgeBucketSchema, LIMITS } from '../lib/schema.js';

const BUCKET = {
  bucketKey: 'PROMPT_MUTATION::SUCCESS_RATE',
  sampleSize: 2,
  confidence: 'CALIBRATING',
  meanPQ: 0.28, medianActualDelta: 0, iqrActualDelta: 0,
  successRate: 0, directionalAccuracy: 0, deadZoneRate: 1,
  lastUpdated: '2026-11-19T00:00:00.000Z',
};

test('schema: 合法桶过门', () => {
  assert.deepEqual(knowledgeBucketSchema.parse(BUCKET), BUCKET);
});
test('schema: 空样本桶统计量全 null 过门（不用 0 冒充）', () => {
  const empty = { ...BUCKET, sampleSize: 0, meanPQ: null, medianActualDelta: null, iqrActualDelta: null, successRate: null, directionalAccuracy: null, deadZoneRate: null };
  assert.equal(knowledgeBucketSchema.parse(empty).meanPQ, null);
});
test('schema: confidence 只认三级；lastUpdated 必须 UTC 毫秒串', () => {
  assert.throws(() => knowledgeBucketSchema.parse({ ...BUCKET, confidence: 'GUESSING' }));
  assert.throws(() => knowledgeBucketSchema.parse({ ...BUCKET, lastUpdated: '2026-11-19' }));
  assert.throws(() => knowledgeBucketSchema.parse({ ...BUCKET, bucketKey: '' }));
});
test('LIMITS: KNOWLEDGE_BUCKETS 存在且为正', () => {
  assert.ok(Number.isInteger(LIMITS.KNOWLEDGE_BUCKETS) && LIMITS.KNOWLEDGE_BUCKETS > 0);
});

// ── 服务段：真 dsh-storage-json 存储域 ────────────────────────────────────
//
// ⛔ 不用纯 mock：加表不升 version 这件事必须在真 dsh-storage-json 上验
//（整单元格式做严格相等校验，mock 里没有这条行为）。

/** 起真插件，存储域走真 DomainFacility + 真 JsonStorageBackend（不是手写 Map）。 */
async function openEvolution(root) {
  const backend = new JsonStorageBackend(root);
  const domainCtx = {
    logger: { error: () => {}, warn: () => {} },
    effect: (fn) => { fn(); },
    on: () => {},
    storage: { backend: { get: (n) => (n === 'json' ? backend : undefined) } },
  };
  const facility = new DomainFacility(domainCtx, { backend: 'json', routes: {} });
  const warns = [];
  const ctx = {
    storageDomain: facility,
    effect: (fn) => { fn(); },
    get: () => null,
    on: () => {},
    logger: { warn: (msg, extra) => warns.push([msg, extra]) },
    provide(name, val) { this._provided = this._provided ?? {}; this._provided[name] = val; },
  };
  const mod = await import('../lib/index.js');
  mod.apply(ctx, {});
  await new Promise((r) => setImmediate(r));
  return { evo: ctx._provided['agint.evolution'], backend, facility, warns };
}

test('服务: recordKnowledgeBucket 首写落行，同 key 再写 = upsert（派生统计可覆盖）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agint-bucket-'));
  const { evo, backend } = await openEvolution(root);
  try {
    await evo.recordKnowledgeBucket(BUCKET);
    const updated = { ...BUCKET, sampleSize: 5, confidence: 'PROVISIONAL', lastUpdated: '2026-11-20T00:00:00.000Z' };
    await evo.recordKnowledgeBucket(updated);
    assert.deepEqual(await evo.getKnowledgeBucket(BUCKET.bucketKey), updated);
    assert.equal((await evo.listKnowledgeBuckets()).length, 1, 'upsert 不新增行');
  } finally { await backend.close(); await rm(root, { recursive: true, force: true }); }
});

test('服务: 缺 bucketKey 抛错；get 不存在返回 null；空表 list=[]', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agint-bucket-'));
  const { evo, backend } = await openEvolution(root);
  try {
    await assert.rejects(() => evo.recordKnowledgeBucket({ ...BUCKET, bucketKey: '' }), /bucketKey/);
    assert.equal(await evo.getKnowledgeBucket('NO::Such'), null);
    assert.deepEqual(await evo.listKnowledgeBuckets(), []);
  } finally { await backend.close(); await rm(root, { recursive: true, force: true }); }
});

test('服务: 旧文件加表不升 version —— 存量表行全部保留', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agint-bucket-'));
  // 生产文件副本形状：unit.version=1 + 既有表 + 一条合法 evolution_log。
  await writeFile(join(root, 'agint_evolution.json'), JSON.stringify({
    unit: { name: 'agint_evolution', version: 1 },
    global: null,
    tables: {
      evolution_log: {
        L1: { id: 'L1', kind: 'evolution-log', targetId: 'agint-demo', targetKind: 'plugin', decision: 'ABSTAIN' },
      },
      failure_pattern: {},
      success_template: {},
      contract_locks: {},
      prediction_outcomes: {},
      evolution_ledger: {},
      benchmark_frozen_set: {},
    },
  }));

  const { evo, backend } = await openEvolution(root);
  try {
    assert.deepEqual(await evo.listKnowledgeBuckets(), [], '加表 = 补空表，不从 0 以外开始');
    await evo.recordKnowledgeBucket(BUCKET);

    const doc = JSON.parse(String(await readFile(join(root, 'agint_evolution.json'), 'utf8')));
    assert.equal(doc.unit.version, 1, '⛔ 不升 version（升了生产整域打不开）');
    assert.ok(doc.tables.evolution_log.L1, '存量表行必须原样保留');
    assert.equal(doc.tables.knowledge_buckets[BUCKET.bucketKey].sampleSize, 2);
  } finally { await backend.close(); await rm(root, { recursive: true, force: true }); }
});
