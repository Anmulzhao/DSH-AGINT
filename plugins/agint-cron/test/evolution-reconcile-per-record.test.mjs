// plugins/agint-cron/test/evolution-reconcile-per-record.test.mjs
// 提案 b8f5123c（2026-11-14）：event bus 切到 per-record 布局后，evolution-reconcile
// 判据不能只读冻结的旧单文件。这里锁定双介质读取、合并去重与诚实守卫。
//
// fixture 全部在 tmp 下构造，不碰生产 storages。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { reconcileEvolutionStats } from '../lib/evolution-reconcile-core.js';

const GOOD = '.agint-preimage/good.bak';
const BAD = '.agint-preimage/missing.bak';

function perRecordDoc(topic, payload) {
  // 生产落盘形状：{ version, record: { envelope, deliveries } }
  return {
    version: 1,
    record: {
      envelope: { topic, occurredAt: '2026-11-13T00:00:00.000Z', payload },
      deliveries: {},
    },
  };
}
function legacyStore(committed) {
  return {
    tables: {
      events: {
        rows: committed.map((pl) => ({
          envelope: { topic: 'evolution.mutation.committed', occurredAt: '2026-10-30T00:00:00.000Z', payload: pl },
        })),
      },
    },
  };
}

function makeFixture({
  legacy = null, perRecord = null, rawBadFiles = 0,
  commitIds = [], preimageFiles = [], population = true,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'recon-pr-'));
  const storageDir = join(root, 'storages');
  mkdirSync(storageDir, { recursive: true });
  if (legacy !== null) {
    writeFileSync(join(storageDir, 'agint_event_bus.json'), JSON.stringify(legacy));
  }
  if (perRecord !== null || rawBadFiles > 0) {
    const eventsDir = join(storageDir, 'agint_event_bus', 'events');
    mkdirSync(eventsDir, { recursive: true });
    (perRecord ?? []).forEach((doc, i) => {
      writeFileSync(join(eventsDir, `e-${i}.json`), JSON.stringify(doc));
    });
    for (let i = 0; i < rawBadFiles; i++) {
      writeFileSync(join(eventsDir, `broken-${i}.json`), '{not json');
    }
  }
  if (population) {
    writeFileSync(join(storageDir, 'agint_population.json'), JSON.stringify({
      tables: {
        variants: {
          rows: commitIds.map((id, i) => ({ commit_id: id, variant_id: `v-${i}`, stage: 'PENDING_REVIEW' })),
        },
      },
    }));
  }
  writeFileSync(join(storageDir, 'agint_mutator.json'), JSON.stringify({ tables: { commits: { rows: [] } } }));
  const repoRoot = join(root, 'repo');
  mkdirSync(join(repoRoot, '.agint-preimage'), { recursive: true });
  for (const f of preimageFiles) writeFileSync(join(repoRoot, f), 'x');
  return {
    storageDir, repoRoot,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('P1 只有 per-record 目录、无 legacy 单文件 ⇒ 不再 unavailable，committed 读得出来', () => {
  const f = makeFixture({
    perRecord: [
      perRecordDoc('evolution.mutation.committed', { proposalId: 'P1', preimagePath: GOOD }),
      perRecordDoc('input.signal.host.skills-change', {}),
      perRecordDoc('curator.run-completed', {}),
    ],
    commitIds: ['P1'], preimageFiles: [GOOD],
  });
  try {
    const r = reconcileEvolutionStats({ storageDir: f.storageDir, repoRoot: f.repoRoot });
    assert.equal(r.status, 'ok');
    assert.equal(r.counts.eventBusCommitted, 1, '新布局里的 committed 事件必须被看见');
    assert.equal(r.counts.eventBusCommittedPerRecord, 1);
    assert.equal(r.counts.eventBusCommittedLegacy, 0);
    assert.equal(r.counts.eventBusPerRecordFiles, 3);
    assert.equal(r.sources.eventBusLayout, 'per-record');
    assert.equal(r.sources.eventBusPerRecordPresent, true);
  } finally { f.cleanup(); }
});

test('P2 legacy + per-record 合并去重，legacy 优先（用 preimagePath 可观测）', () => {
  const f = makeFixture({
    legacy: legacyStore([
      { proposalId: 'P1', preimagePath: GOOD },   // legacy 版：备份存在
      { proposalId: 'P2', preimagePath: GOOD },
    ]),
    perRecord: [
      perRecordDoc('evolution.mutation.committed', { proposalId: 'P1', preimagePath: BAD }), // 新版：备份缺失
      perRecordDoc('evolution.mutation.committed', { proposalId: 'P3', preimagePath: GOOD }),
    ],
    commitIds: ['P1', 'P2', 'P3'], preimageFiles: [GOOD],
  });
  try {
    const r = reconcileEvolutionStats({ storageDir: f.storageDir, repoRoot: f.repoRoot });
    assert.equal(r.counts.eventBusCommitted, 3, 'P1/P2/P3 三条，P1 不重复');
    assert.equal(r.counts.eventBusCommittedLegacy, 2);
    assert.equal(r.counts.eventBusCommittedPerRecord, 2);
    assert.equal(r.counts.eventBusDuplicatesMerged, 1);
    assert.equal(r.sources.eventBusLayout, 'both');
    assert.equal(r.diffs.R2_committedMissingPreimage.length, 0,
      'P1 必须保留 legacy 版（备份存在）；若被 per-record 覆盖就会误报 R2');
  } finally { f.cleanup(); }
});

test('P3 兼容顶层 {envelope} 形状，且非 committed topic 不计入', () => {
  const f = makeFixture({
    perRecord: [
      { envelope: { topic: 'evolution.mutation.committed', occurredAt: '2026-11-13T01:00:00Z', payload: { proposalId: 'P9', preimagePath: GOOD } }, deliveries: {} },
      perRecordDoc('metrics.pruned', { proposalId: 'NOT-A-COMMIT' }),
    ],
    commitIds: ['P9'], preimageFiles: [GOOD],
  });
  try {
    const r = reconcileEvolutionStats({ storageDir: f.storageDir, repoRoot: f.repoRoot });
    assert.equal(r.counts.eventBusCommitted, 1);
    assert.deepEqual(r.diffs.R1_committedNotInPopulation, []);
  } finally { f.cleanup(); }
});

test('P4 空 per-record 目录 + 无 legacy + 无 population ⇒ 仍 unavailable（诚实守卫不放松）', () => {
  const f = makeFixture({ perRecord: [], population: false });
  try {
    const r = reconcileEvolutionStats({ storageDir: f.storageDir, repoRoot: f.repoRoot });
    assert.equal(r.status, 'unavailable');
    assert.match(r.reason, /STORAGE_UNREADABLE/);
    assert.match(r.reason, /agint_event_bus\/events\/\*\.json/);
  } finally { f.cleanup(); }
});

test('P5 记录解析失败单独计数进 notes，不冒充「零差异通过」', () => {
  const f = makeFixture({
    perRecord: [perRecordDoc('evolution.mutation.committed', { proposalId: 'P1', preimagePath: GOOD })],
    rawBadFiles: 2,
    commitIds: ['P1'], preimageFiles: [GOOD],
  });
  try {
    const r = reconcileEvolutionStats({ storageDir: f.storageDir, repoRoot: f.repoRoot });
    assert.equal(r.counts.eventBusMalformedRecords, 2);
    assert.equal(r.counts.eventBusCommitted, 1);
    assert.ok(r.notes.some((n) => n.includes('EVENT_BUS_PER_RECORD_MALFORMED')));
  } finally { f.cleanup(); }
});
