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
import { readFileSync } from 'node:fs';
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

// ─────────────────── 1. 主题覆盖（不能漏） ───────────────────

test('订阅覆盖全部主题，且每条都有独立 metric key', () => {
  // 2026-11-02（B1）新增两条宿主事件桥主题。刻意继续用**字面量列表**而不是
  // `assert.ok(SUBSCRIBED_TOPICS.length >= 5)` —— 后者对「悄悄删掉一条」完全无感。
  // 代价是每次加主题都要改这里，这是值得的：本文件守的正是「订阅真的挂上了」。
  assert.deepEqual(
    [...SUBSCRIBED_TOPICS].sort(),
    [
      'abtest.concluded',
      'abtest.started',
      'input.signal.host.domain-changed',
      // 2026-11-11：宿主 subagent 边界事件（生产已有 40/35 条却零订阅方）
      'input.signal.host.subagent-end',
      'input.signal.host.subagent-start',
      'input.signal.host.workflow-end',
      'input.signal.host.workflow-phase',
      'quality.contract.violated',
      'rules.changed',
      'wiki.updated',
    ],
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

test('门禁可见性（源码级）：topics 必须是**字面量数组**，换成变量就让防线瞎', () => {
  // §6.15.3 教训：`bin/check-wiring.mjs` 的订阅侧靠正则 /topics:\s*\[([^\]]*)\]/ 扫源码。
  // 变量形式对它**不可见** ⇒「代码对了，回归防线瞎了」（第一版就踩过：
  // topics: SUBSCRIBED_TOPICS，门禁照样报 NO_SUBSCRIBER(rules.changed)）。
  // 上一条断言只比对「SUBSCRIPTION.topics ↔ key 映射」：两者若**同时**改成变量，
  // 它照样绿，但门禁已经看不见任何一条订阅。这里直接读源码，钉死字面量这件事。
  const src = readFileSync(new URL('../lib/eventCounters.js', import.meta.url), 'utf8');
  const m = src.match(/topics:\s*\[([^\]]*)\]/);
  assert.ok(m, '源码里找不到 topics: [...] 字面量数组 —— 门禁的正则扫不到它');
  for (const t of Object.keys(COUNTER_METRIC_KEYS)) {
    assert.ok(m[1].includes(`'${t}'`), `topics 字面量里缺 ${t} —— 门禁看不到这条订阅`);
  }
});

test('新补的三条宿主主题各自落一条计数，key 不串、payload 事实不丢', async () => {
  const tableFn = makeTableFn();
  const cases = [
    ['input.signal.host.subagent-start', 'host.subagentStartCount'],
    ['input.signal.host.subagent-end', 'host.subagentEndCount'],
    ['input.signal.host.workflow-phase', 'host.workflowPhaseCount'],
  ];
  for (const [topic] of cases) {
    await recordEventCounter({
      tableFn,
      randomIdFn,
      envelope: {
        topic,
        source: 'agint-event-bus',
        payload: { hostEvent: topic, provider: 'spawn', stopReason: 'completed', messageLength: 42 },
      },
    });
  }
  const rows = tableFn.tbl.entries();
  assert.equal(rows.length, 3, '三条主题应各落一条');
  assert.deepEqual(rows.map((r) => r.key).sort(), cases.map(([, k]) => k).sort());
  for (const r of rows) {
    assert.equal(r.value, 1, '计数器必须是增量 1');
    const meta = JSON.parse(r.meta);
    assert.equal(meta.source, 'agint-event-bus');
    // 事实不丢：后续要按 provider / 终态聚合，只能靠 meta 里这份原文
    assert.equal(meta.payload.provider, 'spawn');
    assert.equal(meta.payload.stopReason, 'completed');
  }
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
