/**
 * agint-dream: unit tests for the short-term recall store (JSONL).
 * Run with: node --test packages/agint-dream/test/recall-store.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendEntry,
  readStoreRobust,
  pruneStore,
  recordRecalls,
  markPromoted,
  listPromotedKeys,
  filterUnpromoted,
  inspectStore,
  recallKey,
  RECALL_STORE_VERSION,
} from '../lib/recall-store.js';

const NOW = Date.parse('2026-09-05T00:00:00.000Z');

async function tempPath() {
  const dir = await mkdtemp(join(tmpdir(), 'agint-recall-'));
  return join(dir, 'recall.jsonl');
}

test('recallKey: deterministic sha256 hex', () => {
  const k1 = recallKey('老板是创造者');
  const k2 = recallKey('老板是创造者');
  assert.equal(k1, k2);
  assert.equal(k1.length, 64); // sha256 hex
});

test('appendEntry + readStoreRobust: roundtrip with merged fields', async () => {
  const path = await tempPath();
  try {
    await appendEntry(path, {
      key: 'k1', path: 'memory/a.md', startLine: 1, endLine: 2,
      snippet: 'snippet 1', recallCount: 1, dailyCount: 0, groundedCount: 0,
      queryHashes: ['q1'], recallDays: ['2026-09-03'], lastRecalledAt: '2026-09-03T00:00:00.000Z',
      promotedAt: null, lineageKey: null, supersedesKey: null,
    });
    await appendEntry(path, {
      key: 'k1', path: 'memory/a.md', startLine: 1, endLine: 2,
      snippet: 'snippet 1', recallCount: 2, dailyCount: 1, groundedCount: 0,
      queryHashes: ['q1', 'q2'], recallDays: ['2026-09-04'], lastRecalledAt: '2026-09-04T00:00:00.000Z',
      promotedAt: null, lineageKey: null, supersedesKey: null,
    });
    const { entries, skippedPartial, totalLines } = await readStoreRobust(path, NOW);
    assert.equal(entries.size, 1);
    assert.equal(totalLines, 2);
    assert.equal(skippedPartial, 0);
    const merged = entries.get('k1');
    assert.equal(merged.recallCount, 3);
    assert.equal(merged.dailyCount, 1);
    assert.deepEqual(merged.queryHashes.sort(), ['q1', 'q2']);
    assert.deepEqual(merged.recallDays, ['2026-09-03', '2026-09-04']);
    assert.equal(merged.lastRecalledAt, '2026-09-04T00:00:00.000Z');
    assert.equal(merged.version, RECALL_STORE_VERSION);
  } finally {
    await rm(join(path, '..'), { recursive: true, force: true });
  }
});

test('readStoreRobust: skips partial trailing JSON line', async () => {
  const path = await tempPath();
  try {
    await appendEntry(path, { key: 'k1', snippet: 'good' });
    // 手动追加一段不完整的 JSON
    const { appendFile } = await import('node:fs/promises');
    await appendFile(path, '{"key":"k2","snippet":"partial', 'utf8'); // 故意不闭合
    const { entries, skippedPartial, totalLines } = await readStoreRobust(path, NOW);
    assert.equal(entries.size, 1);
    assert.equal(entries.get('k1').snippet, 'good');
    assert.equal(skippedPartial, 1);
    assert.equal(totalLines, 2);
  } finally {
    await rm(join(path, '..'), { recursive: true, force: true });
  }
});

test('pruneStore: keeps promoted + recent; drops old unpromoted', async () => {
  const path = await tempPath();
  try {
    const now = Date.parse('2026-09-05T00:00:00.000Z');
    const old = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
    await appendEntry(path, { key: 'old_unpromoted', snippet: 'old', lastRecalledAt: old });
    await appendEntry(path, { key: 'old_promoted', snippet: 'old-p', lastRecalledAt: old, promotedAt: old });
    await appendEntry(path, { key: 'recent_unpromoted', snippet: 'recent', lastRecalledAt: recent });
    const { kept, dropped } = await pruneStore(path, { nowMs: now, retentionDays: 30 });
    assert.equal(kept, 2); // old_promoted + recent_unpromoted
    assert.equal(dropped, 1); // old_unpromoted
  } finally {
    await rm(join(path, '..'), { recursive: true, force: true });
  }
});

test('recordRecalls: appendEntry with dedupe-aware累加', async () => {
  const path = await tempPath();
  try {
    const c1 = { key: 'k1', text: 't1', path: 'a.md', startLine: 1, endLine: 1, signalCount: 1, days: ['2026-09-04'] };
    const c2 = { key: 'k2', text: 't2', path: 'b.md', startLine: 2, endLine: 2, signalCount: 2, days: ['2026-09-04', '2026-09-05'] };
    const r = await recordRecalls(path, [c1, c2], { nowMs: NOW, dayBucket: '2026-09-05' });
    assert.equal(r.appended, 2);
    const { entries } = await readStoreRobust(path, NOW);
    assert.equal(entries.size, 2);
    assert.equal(entries.get('k1').recallCount, 1);
    assert.equal(entries.get('k2').recallCount, 2);
  } finally {
    await rm(join(path, '..'), { recursive: true, force: true });
  }
});

test('markPromoted: rewrites file with promotedAt set', async () => {
  const path = await tempPath();
  try {
    await appendEntry(path, { key: 'k1', snippet: 'a' });
    const result = await markPromoted(path, 'k1', { nowMs: NOW });
    assert.equal(result.rewritten, true);
    const { entries } = await readStoreRobust(path, NOW);
    assert.ok(entries.get('k1').promotedAt);
  } finally {
    await rm(join(path, '..'), { recursive: true, force: true });
  }
});

test('listPromotedKeys + filterUnpromoted: skip already promoted', async () => {
  const path = await tempPath();
  try {
    await appendEntry(path, { key: 'k1', snippet: 'a' });
    await appendEntry(path, { key: 'k2', snippet: 'b' });
    await markPromoted(path, 'k1', { nowMs: NOW });
    const keys = await listPromotedKeys(path);
    assert.deepEqual(keys.sort(), ['k1']);
    const { entries } = await readStoreRobust(path, NOW);
    const candidates = [
      { key: 'k1', text: 'a' },
      { key: 'k2', text: 'b' },
      { key: 'k3', text: 'c' },
    ];
    const kept = filterUnpromoted(candidates, entries);
    assert.deepEqual(kept.map((c) => c.key).sort(), ['k2', 'k3']);
  } finally {
    await rm(join(path, '..'), { recursive: true, force: true });
  }
});

test('inspectStore: filter by key/type/time window', async () => {
  const path = await tempPath();
  try {
    await appendEntry(path, { key: 'a', snippet: 'alpha beta', lastRecalledAt: '2026-09-01T00:00:00.000Z', sourceType: 'preference' });
    await appendEntry(path, { key: 'b', snippet: 'beta gamma', lastRecalledAt: '2026-09-03T00:00:00.000Z', sourceType: 'decision' });
    await appendEntry(path, { key: 'c', snippet: 'gamma delta', lastRecalledAt: '2026-09-05T00:00:00.000Z', sourceType: 'preference' });

    const all = await inspectStore(path, {});
    assert.equal(all.rows.length, 3);

    const sinceOnly = await inspectStore(path, { since: '2026-09-02T00:00:00.000Z' });
    assert.equal(sinceOnly.rows.length, 2);

    const untilOnly = await inspectStore(path, { until: '2026-09-02T23:59:59.000Z' });
    assert.equal(untilOnly.rows.length, 1);

    const typeOnly = await inspectStore(path, { type: 'preference' });
    assert.equal(typeOnly.rows.length, 2);

    const keyOnly = await inspectStore(path, { key: 'beta' });
    assert.equal(keyOnly.rows.length, 2);

    const limited = await inspectStore(path, { limit: 1 });
    assert.equal(limited.rows.length, 1);
  } finally {
    await rm(join(path, '..'), { recursive: true, force: true });
  }
});

test('readStoreRobust: ENOENT returns empty map, no throw', async () => {
  const path = join(tmpdir(), 'definitely-not-exists-', String(Date.now()), 'recall.jsonl');
  const { entries, skippedPartial, totalLines } = await readStoreRobust(path, NOW);
  assert.equal(entries.size, 0);
  assert.equal(skippedPartial, 0);
  assert.equal(totalLines, 0);
});
