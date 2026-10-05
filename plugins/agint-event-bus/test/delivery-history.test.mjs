/**
 * 方案 A：events 表落deliveries 字段（评审 3.3，2026-10-05）。
 *
 * 方案 B（deliveryByTopic）只答ring 窗口；本批让投递数跨重启可答。
 *
 * 覆盖：
 *   1) publish 落库 record 带 deliveries，且内容与内存 ring 终态一致
 *   2) 落库的是**浅拷贝**：存储与 ring 不共享同一 deliveries 对象
 *      （否则后续 recordDelivery 会把已落库的行改掉——存储不是历史快照）
 *   3) 无订阅者时 deliveries 是空对象 {}，不是 undefined、不是 null
 *   4) handler 抛错 → DEAD_LETTERED 也落盘（失败也是事实）
 *   5) schema 兼容：存量行（无 deliveries）能被 EventRecordSchema 接受
 *   6) deliveryHistory 出口已注册（不是只有模块函数）+ 软降级
 *   7) **coverage 三档**：full / partial / legacyOnly —— 存量行不算「投递 0」
 *   8) 顶层 topic 缺失时（存量行）能拆 envelope 取到，不漏统计
 *   9) 读失败 → state=error + reason，不返回半截数字
 *  10) src/ 与 lib/ 双侧同签名（K78）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const busMod = await import('../lib/bus.js');
const { publish, subscribe, disposeBus, deliveryHistory } = busMod;

function makeMockCtx(seed = []) {
  const events = new Map(seed);
  const deadletter = new Map();
  const mk = (m) => ({
    get: async (id) => m.get(id) ?? null,
    put: async (id, v) => { m.set(id, v); },
    delete: async (id) => { m.delete(id); },
    entries: () => m.entries(),
    get size() { return m.size; },
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

test('落库 record 带 deliveries，且与内存 ring 终态一致', async () => {
  disposeBus();
  const { ctx, events } = makeMockCtx();
  const u = subscribe({ subscriber: 'alpha', topics: ['a.deliv'], mode: 'async' }, () => {});
  await publish(ctx, { topic: 'a.deliv', source: 'test', payload: {} });
  u();

  assert.equal(events.size, 1);
  const [record] = events.values();
  assert.ok('deliveries' in record, 'record 必须带 deliveries 字段');
  assert.deepEqual(record.deliveries, { alpha: 'DELIVERED' });

  // 与内存 ring 同一份事实对照：不是各自编的
  const ringRow = busMod.inspect({ topic: 'a.deliv' })[0];
  assert.deepEqual(record.deliveries, ringRow.deliveries, '落库内容必须等于 ring 终态');
});

test('落库的是浅拷贝：ring 后续变动不得改写已落库的行', async () => {
  disposeBus();
  const { ctx, events } = makeMockCtx();
  const u = subscribe({ subscriber: 'alpha', topics: ['a.copy'], mode: 'async' }, () => {});
  await publish(ctx, { topic: 'a.copy', source: 'test', payload: {} });
  const [, record] = [...events.values()][0] ? [[...events.keys()][0], [...events.values()][0]] : [];
  const snapshot = JSON.parse(JSON.stringify(record.deliveries));

  // 再发布一次（会往同一 ring entry 无关的新entry，但验证对象不共享）
  await publish(ctx, { topic: 'a.copy', source: 'test', payload: {} });
  u();

  assert.deepEqual(record.deliveries, snapshot, '已落库行的 deliveries 不得被后续发布改写');
  // 反证：ring 里现有两条，而存储里两行内容各自独立
  assert.equal(events.size, 2);
});

test('无订阅者时 deliveries 是空对象，不是 undefined/null', async () => {
  disposeBus();
  const { ctx, events } = makeMockCtx();
  await publish(ctx, { topic: 'a.nobody', source: 'test', payload: {} });
  const [, record] = [[...events.keys()][0], [...events.values()][0]];
  assert.ok('deliveries' in record, '字段必须存在，否则读侧无法区分「没订阅」与「旧数据」');
  assert.deepEqual(record.deliveries, {}, '无订阅者 ⇒ 空对象');
  assert.notEqual(record.deliveries, null);
  assert.notEqual(record.deliveries, undefined);
});

test('handler 抛错 → DEAD_LETTERED 也落盘', async () => {
  disposeBus();
  const { ctx, events } = makeMockCtx();
  const boom = subscribe({ subscriber: 'boom', topics: ['a.fail'], mode: 'async', retry: { maxAttempts: 1, backoffMs: 50 } }, () => {
    throw new Error('boom');
  });
  await publish(ctx, { topic: 'a.fail', source: 'test', payload: {} });
  boom();
  const [, record] = [[...events.keys()][0], [...events.values()][0]];
  assert.deepEqual(record.deliveries, { boom: 'DEAD_LETTERED' }, '失败也是事实，必须落盘');
});

test('EventRecordSchema 接受存量行（无 deliveries 字段）', () => {
  // EventRecordSchema 未导出，且真守卫在 dsh-storage-domain 载入时的 zod 校验
  //（它读的就是 lib/index.js 里声明的 schema）。故此处断言源码形状：
  // deliveries 必须是 optional —— 若误改成必填，存量 21,803 行载入时整域会被拒绝。
  const src = readFileSync(join(PLUGIN_DIR, 'lib', 'index.js'), 'utf8');
  assert.match(src, /deliveries:\s*z\.record\(z\.string\(\),\s*z\.string\(\)\)\.optional\(\)/,
    'deliveries 必须声明为 optional —— 存量 21,803 行没有它，必填会让整域载入失败');
  // passthrough 兜底：即便形状再变也不拒旧行
  assert.match(src, /\}\)\.passthrough\(\)/, 'EventRecordSchema 必须保持 passthrough');
});

test('deliveryHistory 出口已注册到 ctx（不只是模块函数）', async () => {
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
    assert.ok(provided.has('agint.eventBus.deliveryHistory'), '未 provide deliveryHistory');
    assert.equal(typeof provided.get('agint.eventBus.deliveryHistory'), 'function');
    const umbrella = provided.get('agint.eventBus');
    assert.equal(typeof umbrella.deliveryHistory, 'function', 'umbrella 键缺 deliveryHistory');
    const out = await provided.get('agint.eventBus.deliveryHistory')();
    assert.equal(out.state, 'ok', '软降级 stub 下也应返回 ok 零值');
    assert.equal(out.scope, 'events-table');
  } finally {
    if (typeof disposer === 'function') disposer();
  }
});

test('coverage 三档：full / partial / legacyOnly，存量行不算「投递 0」', async () => {
  disposeBus();
  const legacyA = { envelope: { topic: 'h.legacy', occurredAt: '2026-09-01T00:00:00.000Z' }, occurredAt: '2026-09-01T00:00:00.000Z' };
  const legacyB = { envelope: { topic: 'h.legacy', occurredAt: '2026-09-02T00:00:00.000Z' }, occurredAt: '2026-09-02T00:00:00.000Z' };
  const fresh = { topic: 'h.fresh', envelope: { topic: 'h.fresh', occurredAt: '2026-10-05T00:00:00.000Z' }, occurredAt: '2026-10-05T00:00:00.000Z', deliveries: { s: 'DELIVERED' } };
  const mixed1 = { topic: 'h.mixed', envelope: { topic: 'h.mixed' }, occurredAt: '2026-09-03T00:00:00.000Z' };
  const mixed2 = { topic: 'h.mixed', envelope: { topic: 'h.mixed' }, occurredAt: '2026-10-05T01:00:00.000Z', deliveries: { s: 'DELIVERED' } };
  const emptyRow = { topic: 'h.empty', envelope: { topic: 'h.empty' }, occurredAt: '2026-10-05T02:00:00.000Z', deliveries: {} };
  const { ctx } = makeMockCtx([
    ['k1', legacyA], ['k2', legacyB], ['k3', fresh], ['k4', mixed1], ['k5', mixed2], ['k6', emptyRow],
  ]);
  const out = await deliveryHistory(ctx);
  assert.equal(out.state, 'ok');
  assert.equal(out.scanned, 6);
  assert.equal(out.legacyRows, 3, '两条 h.legacy + 一条 h.mixed 旧行');
  assert.equal(out.withDeliveries, 3, 'h.fresh / h.mixed 新行 / h.empty');

  const byName = Object.fromEntries(out.topics.map((r) => [r.topic, r]));
  assert.equal(byName['h.fresh'].coverage, 'full');
  assert.equal(byName['h.fresh'].delivered, 1);
  assert.equal(byName['h.legacy'].coverage, 'legacyOnly', '全存量行 ⇒ 投递数 unknown');
  assert.equal(byName['h.legacy'].delivered, 0, 'legacyOnly 的 0 是「未知」的实现形态，不是「没投递过」');
  assert.equal(byName['h.legacy'].rowsWithDeliveries, 0);
  assert.equal(byName['h.mixed'].coverage, 'partial', '部分带 ⇒ 下界');
  assert.equal(byName['h.mixed'].delivered, 1);
  assert.equal(byName['h.mixed'].rows, 2);
  assert.equal(byName['h.empty'].coverage, 'full', 'deliveries:{} 也算「带字段」⇒ full');
  assert.equal(byName['h.empty'].delivered, 0);
  assert.deepEqual(out.unknownDeliveryTopics, ['h.legacy'], 'legacyOnly 集合只收 h.legacy');
  // 顶层 topic 缺失的存量行不能漏统计
  assert.equal(byName['h.legacy'].rows, 2);
});

test('读失败 → state=error + reason，不返回半截数字', async () => {
  const ctx = { tables: { events: { entries: () => { throw new Error('storage down'); } } } };
  const out = await deliveryHistory(ctx);
  assert.equal(out.state, 'error');
  assert.match(out.reason, /storage down/);
  assert.deepEqual(out.topics, [], '失败时不得返回半截聚合');

  const noTable = await deliveryHistory({ tables: {} });
  assert.equal(noTable.state, 'error', '句柄缺失也是 error（不是假装 ok 零值）');
  assert.match(noTable.reason, /句柄不可用/);
});

test('src/ 与 lib/ 双侧同签名（K78）', () => {
  const pairs = [
    ['src/bus.ts', readFileSync(join(PLUGIN_DIR, 'src', 'bus.ts'), 'utf8')],
    ['lib/bus.js', readFileSync(join(PLUGIN_DIR, 'lib', 'bus.js'), 'utf8')],
  ];
  for (const [name, text] of pairs) {
    assert.match(text, /export async function deliveryHistory\(/, `${name} 缺 deliveryHistory`);
  }
  const idx = [
    ['src/index.ts', readFileSync(join(PLUGIN_DIR, 'src', 'index.ts'), 'utf8')],
    ['lib/index.js', readFileSync(join(PLUGIN_DIR, 'lib', 'index.js'), 'utf8')],
  ];
  for (const [name, text] of idx) {
    assert.match(text, /agint\.eventBus\.deliveryHistory/, `${name} 未注册 deliveryHistory 服务`);
  }
  const tools = readFileSync(join(PLUGIN_DIR, 'lib', 'tools.js'), 'utf8');
  assert.match(tools, /eventBus_deliveryHistory/, 'tools.js 未注册工具出口');
  // put 载荷两侧都要带 deliveries
  for (const [name, text] of pairs) {
    assert.match(text, /deliveries:\s*\{\s*\.\.\.entry\.deliveries\s*\}/, `${name} put 载荷未落 deliveries`);
  }
});
