/**
 * agint-event-bus A9/A10 tests — Sprint 12.
 * Run: node --test plugins/agint-event-bus/test/a9-a10.test.mjs
 *
 * A9 tail:  sync 订阅配额(SYNC_GLOBAL_LIMIT=3) + inspectSummary 暴露 syncSubscriptionCount
 * A10 tail: 连续抛错订阅者重试 3 次 → 死信落库；其余订阅者不受影响（隔离）
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { publish, subscribe, inspectSummary, disposeBus, _subscriptionsSnapshot } from '../lib/bus.js';

// Mock EventBusContext（与 smoke.mjs 同型）
function makeMockCtx() {
  const events = new Map();
  const deadletter = new Map();
  const pendingReview = { count: 0 };
  const metricCounts = new Map();
  const logEntries = [];
  return {
    ctx: {
      tables: {
        events: {
          get: async (id) => events.get(id) ?? null,
          put: async (id, v) => { events.set(id, v); },
          delete: async (id) => { events.delete(id); },
          entries: () => events.entries(),
          size: async () => events.size,
        },
        deadletter: {
          get: async (id) => deadletter.get(id) ?? null,
          put: async (id, v) => { deadletter.set(id, v); },
          delete: async (id) => { deadletter.delete(id); },
          entries: () => deadletter.entries(),
          size: async () => deadletter.size,
        },
      },
      logBuffered: async (entry) => { logEntries.push(entry); },
      pendingReview: async () => { pendingReview.count += 1; },
      metrics: (k, d) => { metricCounts.set(k, (metricCounts.get(k) ?? 0) + d); },
    },
    state: { events, deadletter, pendingReview, metricCounts, logEntries },
  };
}

before(() => { disposeBus(); });
after(() => { disposeBus(); });

test('A9: sync 订阅配额——达到 SYNC_GLOBAL_LIMIT 即抛错', () => {
  disposeBus();
  const { ctx } = makeMockCtx();
  // 注册 3 个 sync 订阅（不触发 handler，只占配额）
  const unsubs = [];
  let threw = false;
  try {
    for (let i = 0; i < 3; i++) {
      unsubs.push(subscribe({ subscriber: `sync-${i}`, topics: [`evt.a`], mode: 'sync', reason: `r-${i}` }, async () => {}));
    }
    // 第 4 个 sync 订阅应抛
    try {
      subscribe({ subscriber: 'sync-4', topics: ['evt.b'], mode: 'sync', reason: 'r-4' }, async () => {});
    } catch (e) {
      threw = true;
      assert.match(e.message, /sync 订阅已达全局上限 3/);
    }
  } finally {
    for (const u of unsubs) u();
  }
  assert.ok(threw, '第 4 个 sync 订阅应抛错');
});

test('A9: inspectSummary 暴露 syncSubscriptionCount 与 syncGlobalLimit', async () => {
  disposeBus();
  const { ctx } = makeMockCtx();
  const unsubs = [
    subscribe({ subscriber: 'a', topics: ['evt.a'], mode: 'sync', reason: 'r-a' }, async () => {}),
    subscribe({ subscriber: 'b', topics: ['evt.b'], mode: 'sync', reason: 'r-b' }, async () => {}),
    subscribe({ subscriber: 'c', topics: ['evt.c'], mode: 'async' }, async () => {}),
  ];
  const info = inspectSummary();
  assert.equal(typeof info.entries, 'object');
  assert.equal(typeof info.summary, 'object');
  assert.equal(info.syncSubscriptionCount, 2); // 2 个 sync
  assert.equal(info.syncGlobalLimit, 3);
  for (const u of unsubs) u();
  await new Promise((r) => setTimeout(r, 10));
  disposeBus();
});

test('A10: 连续抛错订阅者重试 3 次 → 死信落库', async () => {
  disposeBus();
  const { ctx, state } = makeMockCtx();
  let attempts = 0;
  subscribe({ subscriber: 'bad', topics: ['dl.test'], mode: 'async', retry: { maxAttempts: 3, backoffMs: 50 } }, async () => {
    attempts += 1;
    throw new Error('boom');
  });
  const ok = await publish(ctx, { topic: 'dl.test', version: 1, source: 'test-src', payload: { id: 'x' } });
  // 等 async 投递完成（backoff 50ms × 重试）
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(attempts, 3, '应重试 3 次');
  assert.equal(ok.deliveredTo.length, 0);
  assert.equal(ok.deadLettered.length, 1);
  // 死信落库
  const dlEntries = [...state.deadletter.values()];
  assert.equal(dlEntries.length, 1);
  assert.equal(dlEntries[0].subscriber, 'bad');
  assert.equal(dlEntries[0].attempts, 3);
  assert.match(dlEntries[0].reason, /boom/);
});

test('A10: 抛错订阅者不影响其他订阅者（隔离）', async () => {
  disposeBus();
  const { ctx, state } = makeMockCtx();
  const received = [];
  subscribe({ subscriber: 'good', topics: ['iso.test'], mode: 'async' }, async (env) => { received.push(env.id); });
  subscribe({ subscriber: 'bad', topics: ['iso.test'], mode: 'async', retry: { maxAttempts: 2, backoffMs: 50 } }, async () => { throw new Error('intentional'); });
  const ok = await publish(ctx, { topic: 'iso.test', version: 1, source: 'test-src', payload: { a: 1 } });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(received.length, 1, 'good 订阅者应收到');
  assert.equal(ok.deliveredTo.length, 1);
  assert.equal(ok.deadLettered.length, 1);
});
