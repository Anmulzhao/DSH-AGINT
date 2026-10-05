/**
 * 面板 host 半：collectDeliveryByTopic / collectSubscriptions 的出口契约与降级。
 *
 * 为什么这层要单测：事件链表「投递」列此前一律标 unknown。这两个 collect 是
 * 面板拿到投递事实的**唯一通道**，且都必须「永不抛、只降级自己这一块」——
 * event-bus 没挂 / 版本过旧 / 返回结构不认识，都不能连坐其他六个判据。
 *
 * 覆盖：
 *   1) 两出口读的是 agint.eventBus 的对应方法，且是伞键路径（不是全名子键）
 *   2) 出口缺失 → state=unavailable + reason，**不抛**
 *   3) bus整体缺失 → unavailable，**不抛**
 *   4) get 抛错 → state=error（不是 unavailable），**不抛**
 *   5) 返回结构不认识 → unavailable，**不抛**
 *   6) 数值字段非有限数（NaN/undefined）→ 归零，不把 NaN 传给前端渲染
 *   7) bootAt 必给（前端措辞要靠它说清「0 since boot ≠ never」）
 *   8) ring 边界字段透传（full / oldestOccurredAt）—— 口径提醒靠它，前端要显示
 *   9) orphan 两个集合原样透传，且做了类型收窄
 *  10) collectSubscriptions 同契约（回归护栏，防只测新出口忘了旧出口）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectDeliveryByTopic, collectSubscriptions } from '../lib/index.js';

const okRing = {
  generatedAt: '2026-10-05T13:00:00.000Z',
  ring: { size: 12, capacity: 2000, full: false, oldestOccurredAt: '2026-10-05T12:00:00.000Z', newestOccurredAt: '2026-10-05T13:00:00.000Z' },
  totals: { published: 5, delivered: 3, deadLettered: 1, pending: 0, failed: 0, other: 0, deliveryAttempts: 4 },
  topics: [
    { topic: 'x.hit', published: 3, delivered: 3, deadLettered: 0, pending: 0, failed: 0, other: 0, deliveryAttempts: 3, subscribers: ['a', 'b'], lastOccurredAt: '2026-10-05T13:00:00.000Z' },
    { topic: 'x.lonely', published: 2, delivered: 0, deadLettered: 0, pending: 0, failed: 0, other: 0, deliveryAttempts: 0, subscribers: [], lastOccurredAt: '2026-10-05T12:30:00.000Z' },
  ],
  orphanPublished: ['x.lonely'],
  orphanSubscriptions: [{ subscriber: 'ghost', mode: 'async', topics: ['y.never'] }],
};

const ctxWith = (bus) => ({ get: () => bus });

test('collectDeliveryByTopic：走伞键读deliveryByTopic，字段原样透传', () => {
  let called = null;
  const bus = { deliveryByTopic: function () { called = this; return okRing; } };
  const out = collectDeliveryByTopic(ctxWith(bus));
  assert.equal(out.state, 'ok');
  assert.equal(called, bus, '必须以 bus 为 this 调用（伞键方法）');
  assert.equal(out.ring.capacity, 2000);
  assert.equal(out.ring.full, false, 'ring.full 必须透传 —— 前端靠它显示口径受限');
  assert.equal(out.ring.oldestOccurredAt, '2026-10-05T12:00:00.000Z');
  assert.equal(out.totals.delivered, 3);
  assert.equal(out.topics.length, 2);
  assert.deepEqual(out.topics[0].subscribers, ['a', 'b']);
  assert.deepEqual(out.orphanPublished, ['x.lonely']);
  assert.deepEqual(out.orphanSubscriptions, [{ subscriber: 'ghost', mode: 'async', topics: ['y.never'] }]);
});

test('collectDeliveryByTopic：出口缺失 → unavailable，不抛', () => {
  for (const bus of [{}, { deliveryByTopic: 'not-a-function' }]) {
    const out = collectDeliveryByTopic(ctxWith(bus));
    assert.equal(out.state, 'unavailable', '出口缺失/形状不对须降级');
    assert.ok(out.reason && out.reason.length > 0, '降级必须带 reason，前端据此措辞');
  }
});

test('collectDeliveryByTopic：bus 整体缺失 → unavailable，不抛', () => {
  const out = collectDeliveryByTopic(ctxWith(null));
  assert.equal(out.state, 'unavailable');
  assert.match(out.reason, /未挂载/);
  assert.ok(out.bootAt, '降级时也要给 bootAt');
});

test('collectDeliveryByTopic：get 抛错 → state=error（区别于 unavailable），不抛', () => {
  const ctx = { get: () => { throw new Error('boom'); } };
  const out = collectDeliveryByTopic(ctx);
  assert.equal(out.state, 'error');
  assert.match(out.reason, /boom/);
});

test('collectDeliveryByTopic：返回结构不认识 → unavailable，不抛', () => {
  for (const v of [null, undefined, {}, { topics: 'not-array' }, 42]) {
    const out = collectDeliveryByTopic(ctxWith({ deliveryByTopic: () => v }));
    assert.equal(out.state, 'unavailable', `结构 ${JSON.stringify(v)} 须降级`);
  }
});

test('collectDeliveryByTopic：非有限数值归零，不把 NaN 递给前端', () => {
  const out = collectDeliveryByTopic(ctxWith({
    deliveryByTopic: () => ({
      ring: { size: NaN, capacity: undefined, full: 0 },
      totals: {},
      topics: [{ topic: 'x', published: NaN, delivered: undefined, deliveryAttempts: null, subscribers: 'not-array' }],
      orphanPublished: 'not-array',
      orphanSubscriptions: 'not-array',
    }),
  }));
  assert.equal(out.state, 'ok', '结构对就应 ok，字段脏不该降级');
  assert.equal(out.ring.size, 0, 'NaN 必须归零');
  assert.equal(out.ring.capacity, 0);
  assert.equal(out.ring.full, false, 'full 用 Boolean() 收窄，0 不得当true');
  assert.equal(out.topics[0].published, 0);
  assert.equal(out.topics[0].delivered, 0);
  assert.deepEqual(out.topics[0].subscribers, [], '非数组订阅者须收窄为空数组');
  assert.deepEqual(out.orphanPublished, []);
  assert.deepEqual(out.orphanSubscriptions, []);
});

test('collectDeliveryByTopic：bootAt 必给且为合法 ISO', () => {
  const out = collectDeliveryByTopic(ctxWith({ deliveryByTopic: () => okRing }));
  assert.ok(out.bootAt, 'bootAt 必给');
  assert.ok(Number.isFinite(Date.parse(out.bootAt)), `bootAt 不是合法时间：${out.bootAt}`);
  assert.ok(out.generatedAt, 'generatedAt 必给');
});

test('collectSubscriptions：同契约回归（旧出口不能因本批改动退化）', () => {
  const subsRaw = {
    generatedAt: '2026-10-05T13:00:00.000Z',
    total: 2,
    syncCount: 1,
    syncGlobalLimit: 3,
    entries: [
      { subscriber: 'a', mode: 'async', topics: ['x.y'], createdAt: '2026-10-05T12:00:00.000Z', deliveries: 3, outcomes: { DELIVERED: 3 } },
      { subscriber: 'ghost', mode: 'async', topics: ['z.never'], createdAt: '2026-10-05T12:00:00.000Z', deliveries: NaN, outcomes: null },
    ],
  };
  const ok = collectSubscriptions(ctxWith({ subscriptions: () => subsRaw }));
  assert.equal(ok.state, 'ok');
  assert.equal(ok.total, 2);
  assert.equal(ok.syncGlobalLimit, 3);
  assert.deepEqual(ok.entries[1].outcomes, {}, 'null outcomes 须收窄为空对象');
  assert.equal(ok.entries[1].deliveries, 0, 'NaN deliveries 须归零');

  assert.equal(collectSubscriptions(ctxWith(null)).state, 'unavailable', 'bus 缺失须降级');
  assert.equal(collectSubscriptions(ctxWith({})).state, 'unavailable', '出口缺失须降级');
  assert.equal(collectSubscriptions(ctxWith({ subscriptions: () => ({}) })).state, 'unavailable', '结构不认识须降级');
  assert.equal(collectSubscriptions({ get: () => { throw new Error('x'); } }).state, 'error');
});
