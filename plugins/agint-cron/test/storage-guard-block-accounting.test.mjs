// plugins/agint-cron/test/storage-guard-block-accounting.test.mjs
// 提案 d6994da2（2026-11-14）：per-record 目录按逻辑字节计量会系统性少报盘上占用；
// 且冻结的 legacy 单文件不该再与同域活跃数据重复计入运行态。
// 全部用 tmp fixture，不碰生产 storages。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  scanStorage, buildGuardMetrics, toSnapshot,
  BLOCK_SIZE, MEASUREMENT_VERSION,
} from '../lib/storage-guard.js';

function fixture({ withLegacy = true, withPerRecord = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'guard-blk-'));
  // 普通单文件域（2 行）
  writeFileSync(join(root, 'agint_metrics.json'), JSON.stringify({
    unit: { name: 'agint_metrics', version: 1 },
    tables: { metric: { m1: {}, m2: {} } },
  }));
  if (withLegacy) {
    // 冻结的回滚备份（4 行）
    writeFileSync(join(root, 'agint_event_bus.json'), JSON.stringify({
      unit: { name: 'agint_event_bus', version: 1 },
      tables: { events: { e1: {}, e2: {}, e3: {}, e4: {} } },
    }));
  }
  if (withPerRecord) {
    const ev = join(root, 'agint_event_bus', 'events');
    mkdirSync(ev, { recursive: true });
    writeFileSync(join(ev, 'r1.json'), JSON.stringify({ record: { envelope: { topic: 'a' } } }));
    writeFileSync(join(ev, 'r2.json'), JSON.stringify({ record: { envelope: { topic: 'b' } } }));
    writeFileSync(join(ev, 'r3.json'), ''); // 0 字节：不该凭空算出一个块
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('B1 块占用按 4KB 对齐求和，逻辑字节口径保留，空文件不造块', () => {
  const f = fixture();
  try {
    const scan = scanStorage(f.root);
    const bus = scan.dirs.find((d) => d.domain === 'agint_event_bus');
    assert.ok(bus, 'per-record 目录必须被扫到');
    assert.equal(bus.files, 3);
    assert.equal(bus.allocatedBytes, 2 * BLOCK_SIZE, '两个小文件各占 1 块，0 字节文件占 0 块');
    assert.ok(bus.bytes < bus.allocatedBytes, '逻辑字节必须小于盘上块占用');
    assert.equal(bus.blockAmplification, Math.round((bus.allocatedBytes / bus.bytes) * 1000) / 1000);
    assert.equal(scan.allocatedBytes, bus.allocatedBytes);
  } finally { f.cleanup(); }
});

test('B2 同名非空 per-record 目录 ⇒ legacy 单文件单独归口，不混进运行态', () => {
  const f = fixture();
  try {
    const scan = scanStorage(f.root);
    assert.equal(scan.legacy.length, 1);
    assert.equal(scan.legacy[0].domain, 'agint_event_bus');
    assert.equal(scan.legacy[0].rows, 4, 'legacy 行数仍可读，便于与活跃行数对照');
    assert.equal(scan.legacyBytes, scan.legacy[0].bytes);
    assert.ok(scan.totalBytes >= scan.legacyBytes, '物理占盘总量仍要算它');
    assert.ok(!scan.domains.some((d) => d.domain === 'agint_event_bus'),
      'legacy 不再进运行态 domains');
    assert.equal(scan.domainBytes, scan.totalBytes - scan.legacyBytes,
      'domainBytes 不含冻结备份');
    assert.equal(scan.totalRows, 5, '2 行 metrics + 3 个 per-record 记录；legacy 的 4 行不得重复计入');
  } finally { f.cleanup(); }
});

test('B3 新增两条块口径指标 + legacy 指标，且旧运行态 key 不再为 legacy 产出', () => {
  const f = fixture();
  try {
    const scan = scanStorage(f.root);
    const byKey = new Map(buildGuardMetrics({ scan }).map((m) => [m.key, m]));
    assert.ok(byKey.has('storage.bytes.perrecord.agint_event_bus'), '原逻辑字节 key 保留');
    assert.ok(byKey.has('storage.bytes.perrecord.agint_event_bus.allocatedBytes'));
    assert.ok(byKey.has('storage.bytes.perrecord.agint_event_bus.blockAmplification'));
    assert.equal(byKey.get('storage.bytes.perrecord.agint_event_bus.allocatedBytes').value, 2 * BLOCK_SIZE);
    assert.equal(byKey.get('storage.bytes.perrecord.agint_event_bus').value, scan.dirs[0].bytes);
    assert.ok(byKey.has('storage.legacy.bytes.agint_event_bus'));
    assert.equal(byKey.get('storage.legacy.bytes.agint_event_bus').meta.rows, 4);
    assert.ok(!byKey.has('storage.bytes.agint_event_bus'), '冻结备份不再冒充运行态域体积');
    assert.ok(!byKey.has('storage.rows.agint_event_bus.events'), '冻结备份不再冒充运行态表行数');
    assert.ok(byKey.has('storage.bytes.agint_metrics'), '普通单文件域不受影响');
  } finally { f.cleanup(); }
});

test('B4 回归：无 per-record 目录时，单文件 event_bus 照常计入运行态', () => {
  const f = fixture({ withPerRecord: false });
  try {
    const scan = scanStorage(f.root);
    assert.equal(scan.legacy.length, 0);
    assert.ok(scan.domains.some((d) => d.domain === 'agint_event_bus'));
    assert.equal(scan.totalRows, 6, '2 行 metrics + 4 行 events');
    const byKey = new Map(buildGuardMetrics({ scan }).map((m) => [m.key, m]));
    assert.ok(byKey.has('storage.bytes.agint_event_bus'));
    assert.ok(byKey.has('storage.rows.agint_event_bus.events'));
  } finally { f.cleanup(); }
});

test('B5 快照带口径版本；旧快照缺该字段不得被误判成首日基线', () => {
  const f = fixture();
  try {
    const scan = scanStorage(f.root);
    const snap = toSnapshot(scan, { now: Date.parse('2026-11-14T00:00:00Z') });
    assert.equal(snap.measurementVersion, MEASUREMENT_VERSION);
    assert.equal(snap.legacyBytes, scan.legacyBytes);
    assert.equal(snap.allocatedBytes, scan.allocatedBytes);

    // 旧快照（v1 形状，无 measurementVersion）仍应走真 delta。
    const previous = { date: '2026-11-13', totalBytes: 100, totalRows: 1 };
    const byKey = new Map(buildGuardMetrics({ scan, previous, today: '2026-11-14' }).map((m) => [m.key, m]));
    assert.equal(byKey.get('storage.dailyDelta.bytes').meta.baseline, false);
    assert.equal(byKey.get('storage.dailyDelta.bytes').meta.measurementVersion, MEASUREMENT_VERSION);
    assert.match(byKey.get('storage.dailyDelta.bytes').meta.accountingNote, /口径切换/);
  } finally { f.cleanup(); }
});
