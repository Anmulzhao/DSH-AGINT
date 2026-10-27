/**
 * agint-metrics — eventCounters 接线测试（2026-10-26）
 * Run: node --test plugins/agint-metrics/test/event-counters.test.mjs
 *
 * 背景：`node bin/check-wiring.mjs` 报 4 处硬缺口，本模块是它们的**统一订阅侧**：
 *   rules.changed（早就在发、deliveredTo 恒 0）+ 本轮新补发布方的
 *   wiki.updated / quality.contract.violated / abtest.started / abtest.concluded。
 *
 * 这个测试锁的是「订阅**真的挂上了**且**真的落库**」，不是「模块导出了函数」。
 * 老教训（gap 文档 §6.9.2 / §6.12）：订阅注册成功 ≠ handler 收到 ≠ 落库可查。
 * 所以三件事分开断言：
 *   ① attach 时传给 subscribe 的配置（topics / mode / subscriber）；
 *   ② handler 逐条落出正确的 metric key；
 *   ③ 任一层故障都不冒泡（软降级红线）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordEventCounter,
  attachEventCounterSubscription,
  COUNTER_METRIC_KEYS,
  SUBSCRIBED_TOPICS,
  SUBSCRIPTION,
} from '../lib/eventCounters.js';

/** 内存表：模仿 storage domain 的 table 句柄（put/get/entries） */
function makeTable() {
  const t = new Map();
  return {
    put: async (id, value) => { t.set(id, value); return true; },
    get: (id) => t.get(id) ?? null,
    entries: () => [...t.values()],
    get size() { return t.size; },
  };
}

function makeTableFn() {
  const tbl = makeTable();
  const fn = async () => tbl;
  fn.tbl = tbl;
  return fn;
}

let idSeq = 0;
const randomIdFn = () => `m-${++idSeq}`;

// ─────────────────── 1. 主题覆盖（5 条，不能漏） ───────────────────

test('订阅覆盖全部 5 条主题，且每条都有独立 metric key', () => {
  assert.deepEqual(
    [...SUBSCRIBED_TOPICS].sort(),
    ['abtest.concluded', 'abtest.started', 'quality.contract.violated', 'rules.changed', 'wiki.updated'],
  );
  // key 也必须两两不同，否则两条主题会写进同一个时间序列、无法区分
  const keys = Object.values(COUNTER_METRIC_KEYS);
  assert.equal(new Set(keys).size, keys.length, 'metric key 有重复');
});

test('门禁可见性：SUBSCRIPTION.topics 必须与 key 映射一一对应', () => {
  // ⚠️ 这条是防漂移的关键：门禁靠正则扫 SUBSCRIPTION 里**字面量**的 topics 数组，
  // 而落库靠 COUNTER_METRIC_KEYS。两份若不一致，会出现两种隐蔽故障：
  //   a) topics 多一条 → 收到事件但 recordEventCounter 直接 return（静默丢弃）
  //   b) key 映射多一条 → 门禁看不到订阅，回归防线对这条主题失明
  assert.deepEqual(
    [...SUBSCRIPTION.topics].sort(),
    [...Object.keys(COUNTER_METRIC_KEYS)].sort(),
  );
  assert.equal(SUBSCRIPTION.subscriber, 'agint-metrics');
  assert.equal(SUBSCRIPTION.mode, 'async');
});

// ─────────────────── 2. 落库（handler 真的写了吗） ───────────────────

test('每条主题都落一条计数记录，key / value / meta 正确', async () => {
  const tableFn = makeTableFn();
  await recordEventCounter({
    tableFn,
    randomIdFn,
    envelope: {
      topic: 'quality.contract.violated',
      source: 'agint-quality-contract',
      traceId: 'trace-1',
      payload: { violations: ['Decision'], patchKeys: ['Decision'] },
    },
  });

  const rows = tableFn.tbl.entries();
  assert.equal(rows.length, 1);
  const rec = rows[0];
  assert.equal(rec.key, 'quality.contractViolatedCount');
  assert.equal(rec.value, 1, '计数器必须是增量 1，不是累计值');
  assert.equal(rec.unit, 'count');
  assert.ok(rec.ts, '必须有时间戳，否则无法按 series 看趋势');
  // 归因信息必须落在 meta 里，否则「谁触发的」永远查不到
  const meta = JSON.parse(rec.meta);
  assert.equal(meta.source, 'agint-quality-contract');
  assert.equal(meta.traceId, 'trace-1');
  assert.deepEqual(meta.payload.violations, ['Decision']);
});

test('未知主题被忽略，不写脏数据', async () => {
  const tableFn = makeTableFn();
  await recordEventCounter({
    tableFn,
    randomIdFn,
    envelope: { topic: 'something.else', source: 'x', payload: {} },
  });
  assert.equal(tableFn.tbl.size, 0, '不认识的 topic 不该落库');
});

test('meta 超长载荷被截断到 1024（存储预算）', async () => {
  const tableFn = makeTableFn();
  await recordEventCounter({
    tableFn,
    randomIdFn,
    envelope: {
      topic: 'wiki.updated',
      source: 'agint-wiki',
      payload: { action: 'write', path: 'x'.repeat(4000), bytes: 1 },
    },
  });
  const rec = tableFn.tbl.entries()[0];
  assert.ok(rec.meta.length <= 1024, `meta 未截断：${rec.meta.length}`);
});

// ─────────────────── 3. attach 契约（订阅配置对不对） ───────────────────

test('attach 用正确的订阅配置，并把 handler 交给 bus', () => {
  let captured = null;
  const unsubscribe = () => {};
  const subscribeFn = (config, handler) => {
    captured = { config, handler };
    return unsubscribe;
  };

  const ret = attachEventCounterSubscription({ subscribeFn, tableFn: makeTableFn(), randomIdFn });

  assert.equal(ret, unsubscribe, 'attach 必须把 bus 的注销函数原样返回，否则 dispose 漏注销');
  assert.equal(captured.config.subscriber, 'agint-metrics');
  assert.equal(captured.config.mode, 'async', 'sync 配额全局上限 3，新主题一律 async');
  assert.deepEqual([...captured.config.topics].sort(), [...SUBSCRIBED_TOPICS].sort());
  assert.equal(typeof captured.handler, 'function');
});

test('attach 出去的 handler 收到 envelope 后真的落库', async () => {
  let handler = null;
  const tableFn = makeTableFn();
  attachEventCounterSubscription({
    subscribeFn: (_cfg, h) => { handler = h; return () => {}; },
    tableFn,
    randomIdFn,
  });

  await handler({ topic: 'rules.changed', source: 'agint-rules', payload: { change: 'added', ruleId: 'r1' } });
  await handler({ topic: 'abtest.concluded', source: 'agint-abtest', payload: { testId: 'abt-1', winner: 'A' } });

  const keys = tableFn.tbl.entries().map((r) => r.key).sort();
  assert.deepEqual(keys, ['abtest.concludedCount', 'rules.changedCount']);
});

// ─────────────────── 4. 软降级红线 ───────────────────

test('红线：subscribeFn 缺失 / 非函数时返回 null，不抛', () => {
  assert.equal(attachEventCounterSubscription({ subscribeFn: null, tableFn: makeTableFn(), randomIdFn }), null);
  assert.equal(attachEventCounterSubscription({ subscribeFn: {}, tableFn: makeTableFn(), randomIdFn }), null);
});

test('红线：subscribe 抛错时返回 null，不把 apply 带崩', () => {
  const ret = attachEventCounterSubscription({
    subscribeFn: () => { throw new Error('bus exploded'); },
    tableFn: makeTableFn(),
    randomIdFn,
  });
  assert.equal(ret, null);
});

test('红线：handler 内落库失败不冒泡（不影响同订阅的其他主题）', async () => {
  let handler = null;
  attachEventCounterSubscription({
    subscribeFn: (_cfg, h) => { handler = h; return () => {}; },
    tableFn: async () => { throw new Error('domain closed'); },
    randomIdFn,
  });
  // 不 await 抛出即通过；handler 必须自己吞掉并告警
  await assert.doesNotReject(() => handler({ topic: 'wiki.updated', source: 'agint-wiki', payload: {} }));
});
