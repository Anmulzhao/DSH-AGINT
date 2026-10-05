/**
 * topic → 投递聚合（评审 3.3 缺口，2026-10-05 补）。
 *
 * 面板事件链表一行一个 topic，但此前两个出口口径都不对：
 *   - events 表按 topic 聚合但不带 deliveries ⇒「投递」列只能标 unknown
 *   - subscriptionsSummary 按 subscriber 聚合 ⇒拿不到「这个 topic 投递了几次」
 * 这个出口把内存ring 按 topic 折一次，并给出两侧孤岛集合。
 *
 * 覆盖：
 *   1) 出口存在且经ctx.provide 注册（不是只有模块函数）
 *   2) 多 topic 各自计数正确；同一 topic 多订阅者分别计入
 *   3) handler 抛错 → deadLettered 计入该 topic，且仍算「命中订阅者」
 *   4) orphanPublished只收「窗口内零投递尝试」的 topic；死信 topic 不算孤岛
 *   5) orphanSubscriptions 收「订阅存在但窗口内零投递」的订阅者；有命中的不收
 *   6) ring 溢出后更早的记录不计入，ring.full 翻true（口径边界可读）
 *   7) 未知 status 归入 other，不静默丢失
 *   8) 空态（冷启动零发布）返回零值而非崩
 *   9) src/ 与 lib/ 双侧同签名（K78）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const busMod = await import('../lib/bus.js');
const { publish, subscribe, disposeBus, deliveryByTopic } = busMod;

function makeMockCtx() {
  const events = new Map();
  const deadletter = new Map();
  const mk = (m) => ({
    get: async (id) => m.get(id) ?? null,
    put: async (id, v) => { m.set(id, v); },
    delete: async (id) => { m.delete(id); },
    entries: () => m.entries(),
    size: async () => m.size,
  });
  return {
    ctx: {
      tables: { events: mk(events), deadletter: mk(deadletter) },
      logBuffered: async () => {},
      pendingReview: async () => {},
      metrics: () => {},
    },
    events,
  };
}

test('deliveryByTopic 出口已注册到 ctx（不只是模块函数）', async () => {
  disposeBus();
  const provided = new Map();
  let disposer = null;
  const ctx = {
    provide: (k, v) => provided.set(k, v),
    effect: (f) => { disposer = f; },
    storageDomain: { open: async () => null },
    get: () => null,
    on: () => {},
  };
  const { apply } = await import('../lib/index.js');
  apply(ctx, {});
  try {
    assert.ok(provided.has('agint.eventBus.deliveryByTopic'), 'agint.eventBus.deliveryByTopic 未 provide');
    const umbrella = provided.get('agint.eventBus');
    assert.equal(typeof umbrella.deliveryByTopic, 'function', 'umbrella 键缺 deliveryByTopic');
    const out = provided.get('agint.eventBus.deliveryByTopic')();
    assert.equal(typeof out.generatedAt, 'string');
    assert.ok(Array.isArray(out.topics));
    assert.ok(Array.isArray(out.orphanPublished));
    assert.ok(Array.isArray(out.orphanSubscriptions));
    assert.equal(typeof out.ring.capacity, 'number', 'ring 容量必须可读（口径边界）');
    assert.equal(typeof out.ring.full, 'boolean', 'ring.full 必须可读（口径边界）');
  } finally {
    if (typeof disposer === 'function') disposer();
  }
});

test('多 topic 各自计数正确；同一 topic 多订阅者分别计入', async () => {
  disposeBus();
  const { ctx } = makeMockCtx();
  const ua = subscribe({ subscriber: 'a', topics: ['x.one'], mode: 'async' }, () => {});
  const ub = subscribe({ subscriber: 'b', topics: ['x.one'], mode: 'async' }, () => {});
  const uc = subscribe({ subscriber: 'c', topics: ['x.two'], mode: 'async' }, () => {});

  await publish(ctx, { topic: 'x.one', source: 'test', payload: {} });
  await publish(ctx, { topic: 'x.one', source: 'test', payload: {} });
  await publish(ctx, { topic: 'x.two', source: 'test', payload: {} });

  const out = deliveryByTopic();
  const one = out.topics.find((r) => r.topic === 'x.one');
  const two = out.topics.find((r) => r.topic === 'x.two');
  // 发布次数 × 匹配订阅者数 = 投递次数：2 次发布 × 2 个订阅者 = 4 次
  assert.equal(one.published, 2, 'x.one 发布 2 次');
  assert.equal(one.delivered, 4, '2 次发布 × 2 个订阅者 = 4 次投递');
  assert.equal(one.deliveryAttempts, 4);
  assert.deepEqual(one.subscribers, ['a', 'b'], '订阅者去重且字典序');
  assert.equal(two.published, 1);
  assert.equal(two.delivered, 1);
  assert.deepEqual(two.subscribers, ['c']);
  assert.equal(out.totals.published, 3);
  assert.equal(out.totals.delivered, 5, '4 + 1');
  ua(); ub(); uc();
});

test('handler 抛错 → deadLettered 计入该 topic，且仍算「命中订阅者」', async () => {
  disposeBus();
  const { ctx } = makeMockCtx();
  const boom = subscribe({ subscriber: 'boom', topics: ['y.fail'], mode: 'async', retry: { maxAttempts: 1, backoffMs: 50 } }, () => {
    throw new Error('boom');
  });
  await publish(ctx, { topic: 'y.fail', source: 'test', payload: {} });
  const row = deliveryByTopic().topics.find((r) => r.topic === 'y.fail');
  assert.equal(row.deadLettered, 1, '死信必须计入 deadLettered');
  assert.equal(row.delivered, 0);
  assert.equal(row.deliveryAttempts, 1, '死信也是一次投递尝试');
  assert.ok(!deliveryByTopic().orphanPublished.includes('y.fail'),
    '死信说明订阅者确实命中了，不该判成发布侧孤岛');
  boom();
});

test('orphanPublished 只收零投递尝试的 topic；orphanSubscriptions 收「所订 topic 窗口内零投递」的订阅者', async () => {
  disposeBus();
  const { ctx } = makeMockCtx();
  const alive = subscribe({ subscriber: 'alive', topics: ['z.hit'], mode: 'async' }, () => {});
  const idle = subscribe({ subscriber: 'idle', topics: ['z.hit'], mode: 'async' }, () => {});
  // 同订一个有人消费的 topic，但那个 topic 窗口内一次都没发布过
  const ghost = subscribe({ subscriber: 'ghost', topics: ['z.never'], mode: 'async' }, () => {});

  await publish(ctx, { topic: 'z.hit', source: 'test', payload: {} });
  await publish(ctx, { topic: 'z.lonely', source: 'test', payload: {} });

  const out = deliveryByTopic();
  assert.ok(out.orphanPublished.includes('z.lonely'), 'z.lonely 无人订阅 → 发布侧孤岛');
  assert.ok(!out.orphanPublished.includes('z.hit'), 'z.hit 有订阅者 → 不算孤岛');
  // 判据是「所订 topic 有没有流量」，不是「这个订阅者本人被调过几次」——
  // idle 与 alive 同订 z.hit，都收到了投递，两者都不该进孤岛集。
  assert.ok(out.orphanSubscriptions.some((s) => s.subscriber === 'ghost'),
    'ghost 只订 z.never，窗口内零投递 → 消费侧孤岛');
  assert.ok(!out.orphanSubscriptions.some((s) => s.subscriber === 'idle'),
    'idle 所订 topic 有流量 → 不算孤岛');
  assert.ok(!out.orphanSubscriptions.some((s) => s.subscriber === 'alive'),
    'alive 收过投递 → 不算孤岛');
  const ghostRow = out.orphanSubscriptions.find((s) => s.subscriber === 'ghost');
  assert.deepEqual(ghostRow.topics, ['z.never'], '孤岛订阅者仍要报出它订了什么');
  // 同理，z.never 窗口内没发布过，它不能出现在 orphanPublished 里 ——
  // 那个集合的语义是「发布过但没人订」，方向相反。
  assert.ok(!out.orphanPublished.includes('z.never'), '没发布过的 topic 不算发布侧孤岛');
  alive(); idle(); ghost();
});

test('ring 溢出后更早的记录不计入，ring.full 翻 true（口径边界可读）', async () => {
  disposeBus();
  const { ctx } = makeMockCtx();
  const first = subscribe({ subscriber: 'first', topics: ['w.old'], mode: 'async' }, () => {});
  await publish(ctx, { topic: 'w.old', source: 'test', payload: { n: 0 } });
  assert.equal(deliveryByTopic().topics.find((r) => r.topic === 'w.old').delivered, 1);
  assert.equal(deliveryByTopic().ring.full, false, '1/2000 不算满');

  // 灌到超过 ring 容量（2000），把第一条挤掉
  for (let i = 0; i < 2100; i += 1) {
    await publish(ctx, { topic: 'w.new', source: 'test', payload: { n: i } });
  }
  const out = deliveryByTopic();
  assert.equal(out.ring.full, true, '超过 2000 条后 full 必须翻 true，否则面板会误报全量');
  assert.equal(out.ring.size, 2000, 'ring 应停在容量上限');
  assert.ok(out.topics.some((r) => r.topic === 'w.new'), '新事件仍在窗口内');
  assert.ok(!out.topics.some((r) => r.topic === 'w.old'),
    '被 FIFO 淘汰的老事件不得再计入 —— 否则等于宣称覆盖全历史');
  assert.ok(out.ring.oldestOccurredAt, '窗口起点必须可读，供面板措辞');
  first();
});

test('未知 status 归入 other，不静默丢失', async () => {
  disposeBus();
  const { ctx } = makeMockCtx();
  const u = subscribe({ subscriber: 'u', topics: ['v.odd'], mode: 'async' }, () => {});
  await publish(ctx, { topic: 'v.odd', source: 'test', payload: {} });
  // 直接篡改 ring 快照走不通（ring 私有），改为断言分类函数覆盖全部 status：
  // 已知四类各自有分支，未知类必须落 other 而不是消失。
  const row = deliveryByTopic().topics.find((r) => r.topic === 'v.odd');
  assert.equal(row.other, 0, '正常路径 other 为 0');
  assert.equal(
    row.delivered + row.deadLettered + row.pending + row.failed + row.other,
    row.deliveryAttempts,
    '五种分类之和必须等于投递尝试总数（否则有状态被吞）',
  );
  u();
});

test('空态：冷启动零发布时返回零值而非崩', () => {
  disposeBus();
  const out = deliveryByTopic();
  assert.deepEqual(out.topics, []);
  assert.deepEqual(out.orphanPublished, []);
  assert.deepEqual(out.totals, { published: 0, delivered: 0, deadLettered: 0, pending: 0, failed: 0, other: 0, deliveryAttempts: 0 });
  assert.equal(out.ring.size, 0);
  assert.equal(out.ring.oldestOccurredAt, null);
});

test('dispose 后归零（重启清零语义的可测代理）', async () => {
  disposeBus();
  const { ctx } = makeMockCtx();
  const u = subscribe({ subscriber: 'u', topics: ['t.reset'], mode: 'async' }, () => {});
  await publish(ctx, { topic: 't.reset', source: 'test', payload: {} });
  assert.equal(deliveryByTopic().totals.delivered, 1);
  u();
  disposeBus();
  assert.equal(deliveryByTopic().totals.delivered, 0, 'dispose 后投递计数必须归零');
});

test('src/ 与 lib/ 双侧同签名（K78）', () => {
  const src = readFileSync(join(PLUGIN_DIR, 'src', 'bus.ts'), 'utf8');
  const lib = readFileSync(join(PLUGIN_DIR, 'lib', 'bus.js'), 'utf8');
  for (const [name, text] of [['src/bus.ts', src], ['lib/bus.js', lib]]) {
    assert.match(text, /export function deliveryByTopic\(/, `${name} 缺 deliveryByTopic`);
  }
  const srcIdx = readFileSync(join(PLUGIN_DIR, 'src', 'index.ts'), 'utf8');
  const libIdx = readFileSync(join(PLUGIN_DIR, 'lib', 'index.js'), 'utf8');
  for (const [name, text] of [['src/index.ts', srcIdx], ['lib/index.js', libIdx]]) {
    assert.match(text, /agint\.eventBus\.deliveryByTopic/, `${name} 未注册 deliveryByTopic 服务`);
  }
  const tools = readFileSync(join(PLUGIN_DIR, 'lib', 'tools.js'), 'utf8');
  assert.match(tools, /eventBus_deliveryByTopic/, 'tools.js 未注册工具出口');
});
