/**
 * agint-metrics snapshotPublisher tests — Sprint 12 / A7.
 * Run: node --test plugins/agint-metrics/test/snapshot-publisher.test.mjs
 *
 * 覆盖：
 *   1. flushSnapshotOnce 正确 publish 多条 envelope（topic/source/payload 各字段）
 *   2. delta 来自 summary 的相同 key
 *   3. empty collected → published=0 不 publish
 *   4. publishFn=null → soft-degrade (degraded=true, published=0)
 *   5. publishFn 抛错 → 软降级（不 throw，published=0）
 *   6. buildMetricsService._flushSnapshotOnce 接通 service 层（返回 {published,total,degraded}）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flushSnapshotOnce,
  publishSnapshot,
  buildSnapshotPayload,
  attachSnapshotPublisher,
  METRICS_SNAPSHOT_TOPIC,
} from '../lib/snapshotPublisher.js';
import { buildMetricsService } from '../lib/service.js';
import { computeMetrics } from '../lib/metrics.js';

test('METRICS_SNAPSHOT_TOPIC = metrics.snapshot', () => {
  assert.equal(METRICS_SNAPSHOT_TOPIC, 'metrics.snapshot');
});

test('buildSnapshotPayload 构造 slim payload（≤200 字符）', () => {
  const p = buildSnapshotPayload({
    snapshotId: 'snap-1', generatedAt: '2026-08-30T00:00:00Z', key: 'cron.staleJobs',
    value: 2, delta: 1, tags: { source: 'agint-metrics', periodic: true },
  });
  assert.equal(p.snapshotId, 'snap-1');
  assert.equal(p.key, 'cron.staleJobs');
  assert.equal(p.value, 2);
  assert.equal(p.delta, 1);
  assert.equal(p.tags.source, 'agint-metrics');
  const len = JSON.stringify(p).length;
  assert.ok(len <= 200, `payload should be slim <=200 chars, got ${len}`);
});

test('flushSnapshotOnce publish 每条 record 一条 envelope', async () => {
  const published = [];
  const publishFn = async (env) => { published.push(env); return { published: true, deliveredTo: ['x'] }; };
  const collectFn = async () => ({
    collected: [{ key: 'cron.staleJobs', value: 2 }, { key: 'rules.adherencePct', value: 95 }],
    collectedAt: '2026-08-30T00:00:00Z',
  });
  const summaryFn = async () => ({ metrics: [{ key: 'cron.staleJobs', delta: 1 }] });
  const r = await flushSnapshotOnce({ publishFn, collectFn, summaryFn, randomIdFn: () => 'snap-1' });
  assert.equal(r.published, 2);
  assert.equal(r.total, 2);
  assert.equal(r.degraded, false);
  assert.equal(published.length, 2);
  assert.equal(published[0].topic, 'metrics.snapshot');
  assert.equal(published[0].source, 'agint-metrics');
  assert.equal(published[0].version, 1);
  assert.equal(published[0].payload.key, 'cron.staleJobs');
  assert.equal(published[0].payload.delta, 1); // delta from summary
  // 保序：第二条是 rules.adherencePct
  assert.equal(published[1].payload.key, 'rules.adherencePct');
  assert.equal(published[1].payload.delta, null); // 不在 summary → null
});

test('empty collected → published=0 不 publish', async () => {
  const published = [];
  const publishFn = async (env) => { published.push(env); return { published: true }; };
  const collectFn = async () => ({ collected: [], collectedAt: '2026-08-30T00:00:00Z' });
  const r = await flushSnapshotOnce({ publishFn, collectFn, summaryFn: null, randomIdFn: () => 's' });
  assert.equal(r.published, 0);
  assert.equal(r.total, 0);
  assert.equal(r.degraded, false);
  assert.equal(published.length, 0);
});

test('publishFn=null → soft-degrade', async () => {
  const collectFn = async () => ({ collected: [{ key: 'cron.staleJobs', value: 2 }], collectedAt: 'x' });
  const r = await flushSnapshotOnce({ publishFn: null, collectFn, summaryFn: null, randomIdFn: () => 's' });
  assert.equal(r.published, 0);
  assert.equal(r.degraded, true);
});

test('publishSnapshot 抛错 → 软降级返回 false 不 throw', async () => {
  const bad = async () => { throw new Error('bus down'); };
  const ok = await publishSnapshot({ publishFn: bad, payload: {} });
  assert.equal(ok, false);
  const missing = await publishSnapshot({ publishFn: null, payload: {} });
  assert.equal(missing, false);
});

test('attachSnapshotPublisher 用 ctx.setInterval + ctx.effect disposer', () => {
  let intervalCleared = false;
  const ctx = {
    get: () => null,
    setInterval: () => ({ dispose: () => { intervalCleared = true; } }),
    effect: (fn) => { const disposer = fn(); return disposer; },
  };
  let collectCalls = 0;
  const dispose = attachSnapshotPublisher({
    ctx, collectFn: async () => { collectCalls += 1; return { collected: [], collectedAt: 'x' }; },
    summaryFn: null, randomIdFn: () => 's', intervalMs: 1000,
  });
  assert.equal(typeof dispose, 'function');
  dispose();
  assert.ok(intervalCleared, 'disposer 应清理 interval');
});

test('buildMetricsService._flushSnapshotOnce 接通 service 层（有 publishFn）', async () => {
  const store = new Map();
  const table = async () => ({
    put: async (id, v) => store.set(id, v),
    entries: () => store.entries(),
    get: async (id) => store.get(id),
  });
  const published = [];
  const ctx = {
    get: (k) => {
      if (k === 'agint.eventBus.publish') {
        return async (env) => { published.push(env); return { published: true, deliveredTo: ['x'] }; };
      }
      // 提供最小 cron source 让 computeMetrics 产出至少一条
      if (k === 'agint.cron') return { health: () => ({ healthy: true, issues: [], jobs: [] }) };
      return null;
    },
  };
  const svc = buildMetricsService({ ctx, table, computeMetrics, describeMetric: () => ({}), randomId: () => 'm-1' });
  const r = await svc._flushSnapshotOnce();
  assert.equal(typeof r.published, 'number');
  assert.equal(typeof r.total, 'number');
  assert.equal(typeof r.degraded, 'boolean');
  assert.notEqual(r.degraded, undefined);
});

test('buildMetricsService.collect() 主路径返回值不变（不带 publish 副作用破坏）', async () => {
  const store = new Map();
  const table = async () => ({
    put: async (id, v) => store.set(id, v),
    entries: () => store.entries(),
    get: async (id) => store.get(id),
  });
  const ctx = {
    get: (k) => {
      if (k === 'agint.eventBus.publish') return null; // 无 bus → 不触发影子
      if (k === 'agint.cron') return { health: () => ({ healthy: true, issues: [], jobs: [] }) };
      return null;
    },
  };
  const svc = buildMetricsService({ ctx, table, computeMetrics, describeMetric: () => ({}), randomId: () => 'm-1' });
  const c = await svc.collect();
  assert.equal(typeof c.collectedAt, 'string');
  assert.equal(typeof c.count, 'number');
  assert.ok(Array.isArray(c.collected));
});
