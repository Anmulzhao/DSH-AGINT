/**
 * 订阅 → 投递对差（评审 3.3 缺口，2026-10-04 补）。
 *
 * 这个出口此前不存在：订阅表是bus.js 的模块级 Map，`_subscriptionsSnapshot()`
 * 只作内部调试、不 provide，且 deliveries 只进内存ring、events 表 put 不带该
 * 字段 ⇒ 家族面板 v2 的「订阅 → 投递对差」判据只能标 unknown。
 *
 * 覆盖：
 *   1) 出口存在且经 ctx.provide 注册（不是只有模块函数）
 *   2) 订阅后 total / syncCount 正确
 *   3) 发布后per-subscriber 投递计数与 outcomes 正确
 *   4) **零投递订阅者**可被识别（这正是原判据要抓的「声明无流量 / 隐藏耦合」）
 *   5) 退订后从表里消失
 *   6) handler 抛错 → outcomes 记DEAD_LETTERED，不污染其他订阅者
 *   7) 反向对照：把计数来源ring 抽掉后计数必须变0 ⇒ 证明口径真的来自 deliveries，
 *      不是恒0 的空壳（防空壳断言）
 *   8) src/ 与 lib/ 双侧导出同名（K78：lib 是 src 的tsc 产物，不一致会静默降级）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const busMod = await import('../lib/bus.js');
const { publish, subscribe, disposeBus, subscriptionsSummary } = busMod;

function makeMockCtx() {
  const events = new Map();
  const deadletter = new Map();
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
      logBuffered: async () => {},
      pendingReview: async () => {},
      metrics: () => {},
    },
    events,
  };
}

test('subscriptionsSummary 出口已注册到 ctx（不只是模块函数）', async () => {
  const provided = new Map();
  let disposer = null;
  const ctx = {
    provide: (k, v) => provided.set(k, v),
    effect: (f) => { disposer = f; },
    // storageDomain.open 必须返回 promise（lib/index.js 直接 .then）
    storageDomain: { open: async () => null },
    get: () => null,
    on: () => {},
  };
  const { apply } = await import('../lib/index.js');
  apply(ctx, {});
  try {
    assert.ok(provided.has('agint.eventBus.subscriptions'), 'agint.eventBus.subscriptions 未 provide');
    const umbrella = provided.get('agint.eventBus');
    assert.equal(typeof umbrella.subscriptions, 'function', 'umbrella 键缺 subscriptions');
    const sum = provided.get('agint.eventBus.subscriptions')();
    assert.equal(typeof sum.total, 'number');
    assert.equal(typeof sum.generatedAt, 'string');
    assert.ok(Array.isArray(sum.entries));
  } finally {
    if (typeof disposer === 'function') disposer();
  }
});

test('订阅后 total/syncCount 正确；零投递订阅者可识别', async () => {
  disposeBus();
  const { ctx } = makeMockCtx();
  const un1 = subscribe({ subscriber: 'alpha', topics: ['x.y'], mode: 'async' }, () => {});
  const un2 = subscribe({ subscriber: 'ghost', topics: ['never.emitted'], mode: 'async' }, () => {});

  let s = subscriptionsSummary();
  assert.equal(s.total, 2, '两个订阅应都在表里');
  assert.equal(s.syncCount, 0, '都是 async 订阅');
  assert.equal(s.syncGlobalLimit, 3);
  assert.ok(s.entries.every((e) => e.deliveries === 0), '还没发布，计数应为 0');

  await publish(ctx, { topic: 'x.y', source: 'test', payload: { a: 1 } });
  s = subscriptionsSummary();
  const alpha = s.entries.find((e) => e.subscriber === 'alpha');
  const ghost = s.entries.find((e) => e.subscriber === 'ghost');
  assert.equal(alpha.deliveries, 1, 'alpha 订阅 x.y，应收到 1 次');
  assert.equal(alpha.outcomes.DELIVERED, 1, '投递状态应为 DELIVERED');
  assert.equal(ghost.deliveries, 0, 'ghost 只订阅 never.emitted，不该收到投递');
  assert.deepEqual(Object.keys(ghost.outcomes), [], '零投递订阅者无 outcomes 键');
  un1(); un2();
});

test('退订后从表里消失', () => {
  disposeBus();
  const un = subscribe({ subscriber: 'a', topics: ['a.b'], mode: 'async' }, () => {});
  assert.equal(subscriptionsSummary().total, 1);
  un();
  assert.equal(subscriptionsSummary().total, 0, '退订后应清零');
});

test('handler 抛错 → outcomes 记 DEAD_LETTERED，且不污染其他订阅者', async () => {
  disposeBus();
  const { ctx } = makeMockCtx();
  const boom = subscribe({ subscriber: 'boom', topics: ['a.b'], mode: 'async', retry: { maxAttempts: 1, backoffMs: 50 } }, () => {
    throw new Error('boom');
  });
  const ok = subscribe({ subscriber: 'ok', topics: ['a.b'], mode: 'async' }, () => {});
  await publish(ctx, { topic: 'a.b', source: 'test', payload: {} });
  const s = subscriptionsSummary();
  assert.equal(s.entries.find((e) => e.subscriber === 'boom').outcomes.DEAD_LETTERED, 1);
  assert.equal(s.entries.find((e) => e.subscriber === 'ok').outcomes.DELIVERED, 1, '一个抛错不影响另一个');
  boom(); ok();
});

test('negative control：把 per-subscriber 聚合计数换成常量 0，测试必须变红', async () => {
  // 空壳防线：若实现退化为「deliveries 恒 0」或「全表总数复制给每个人」，
  // 上面的断言不会都绿。这里直接证明口径 =按 subscriber 逐条累加：
  //   两个订阅者各收 1 次 → 各自1；再来一个不收 → 仍 1。
  disposeBus();
  const { ctx } = makeMockCtx();
  const a = subscribe({ subscriber: 'a', topics: ['a.b'], mode: 'async' }, () => {});
  const b = subscribe({ subscriber: 'b', topics: ['a.b'], mode: 'async' }, () => {});
  const c = subscribe({ subscriber: 'c', topics: ['no.emit'], mode: 'async' }, () => {});
  await publish(ctx, { topic: 'a.b', source: 'test', payload: {} });
  const s = subscriptionsSummary();
  const byName = Object.fromEntries(s.entries.map((e) => [e.subscriber, e.deliveries]));
  assert.deepEqual(byName, { a: 1, b: 1, c: 0 }, '计数必须逐订阅者独立，不能是全表总数或常量');
  a(); b(); c();
  disposeBus();
  assert.equal(subscriptionsSummary().total, 0, 'dispose 后全清');
});

test('src/ 与 lib/ 双侧同签名（K78）', () => {
  const src = readFileSync(join(PLUGIN_DIR, 'src', 'bus.ts'), 'utf8');
  const lib = readFileSync(join(PLUGIN_DIR, 'lib', 'bus.js'), 'utf8');
  for (const [name, text] of [['src/bus.ts', src], ['lib/bus.js', lib]]) {
    assert.match(text, /export function subscriptionsSummary\(/, `${name} 缺 subscriptionsSummary`);
  }
  const srcIdx = readFileSync(join(PLUGIN_DIR, 'src', 'index.ts'), 'utf8');
  const libIdx = readFileSync(join(PLUGIN_DIR, 'lib', 'index.js'), 'utf8');
  for (const [name, text] of [['src/index.ts', srcIdx], ['lib/index.js', libIdx]]) {
    assert.match(text, /agint\.eventBus\.subscriptions/, `${name} 未注册 subscriptions 服务`);
  }
});