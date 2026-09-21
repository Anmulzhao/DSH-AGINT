/**
 * agint-metrics — mount.* 计数订阅测试（A2 接线，2026-09-20）
 * Run: node --test plugins/agint-metrics/test/mount-counters.test.mjs
 *
 * 背景：mount.* 六个 topic 有真实发布方、但订阅方为 0，挂载成功/失败不可观测。
 * 本测试锁死订阅侧契约：收到 envelope → 落一条计数记录，未知 topic 不写库。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MOUNT_TOPICS,
  recordMountCounter,
  attachMountCounterSubscription,
} from '../lib/mountCounters.js';

function makeTableFn() {
  const rows = new Map();
  const tableFn = async () => ({
    put: async (id, v) => { rows.set(id, v); return true; },
    get: (id) => rows.get(id) ?? null,
    entries: () => [...rows.entries()],
  });
  return { tableFn, rows };
}

const randomIdFn = () => 'fixed-id';

test('mount.succeeded → 写一条 mount.succeededCount 计数', async () => {
  const { tableFn, rows } = makeTableFn();
  const rec = await recordMountCounter({
    envelope: { topic: 'mount.succeeded', source: 'agint-mount', payload: { ticketId: 't-1' } },
    tableFn,
    randomIdFn,
  });
  assert.ok(rec, '已知 topic 必须落库');
  assert.equal(rec.key, 'mount.succeededCount');
  assert.equal(rec.value, 1);
  assert.equal(rec.unit, 'count');
  assert.equal(rows.size, 1);
  assert.match(rows.get('fixed-id').meta, /t-1/, 'meta 里保留 ticketId 便于对账');
});

test('mount.failed → 保留 reason，方便定位失败原因', async () => {
  const { tableFn } = makeTableFn();
  const rec = await recordMountCounter({
    envelope: { topic: 'mount.failed', source: 'agint-mount', payload: { ticketId: 't-2', reason: 'smoke-failed' } },
    tableFn,
    randomIdFn,
  });
  assert.equal(rec.key, 'mount.failedCount');
  assert.match(rec.meta, /smoke-failed/);
});

test('六个 mount topic 全部有映射（发布方发的都能落到计数）', () => {
  assert.equal(MOUNT_TOPICS.length, 6);
  for (const t of ['mount.requested', 'mount.succeeded', 'mount.failed',
    'mount.restart-requested', 'mount.restart-completed', 'mount.restart-failed']) {
    assert.ok(MOUNT_TOPICS.includes(t), `${t} 必须有计数映射`);
  }
});

test('未知 topic → 不写库（避免污染指标表）', async () => {
  const { tableFn, rows } = makeTableFn();
  const rec = await recordMountCounter({
    envelope: { topic: 'something.else' },
    tableFn,
    randomIdFn,
  });
  assert.equal(rec, null);
  assert.equal(rows.size, 0);
});

test('订阅注册：topics 覆盖全部 mount topic + mode=async', async () => {
  const { tableFn } = makeTableFn();
  let captured = null;
  let handler = null;
  const unsubscribe = attachMountCounterSubscription({
    subscribeFn: (sub, h) => { captured = sub; handler = h; return () => {}; },
    tableFn,
    randomIdFn,
  });
  assert.equal(typeof unsubscribe, 'function');
  assert.equal(captured.subscriber, 'agint-metrics');
  assert.equal(captured.mode, 'async');
  assert.deepEqual(captured.topics, MOUNT_TOPICS);
  // handler 真实跑通（不抛）
  await handler({ topic: 'mount.requested', payload: { ticketId: 't-3' } });
});

test('subscribeFn 缺失 → 返回 null（软降级，不抛）', () => {
  assert.equal(attachMountCounterSubscription({ subscribeFn: null, tableFn: async () => ({}), randomIdFn }), null);
});
