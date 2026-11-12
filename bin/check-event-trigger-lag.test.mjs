/**
 * bin/check-event-trigger-lag.test.mjs —— 终态滞后门禁自测
 *
 * 不读生产存储、不连 3080：全部走导出的纯函数。
 * 锁住三个最容易骗人的点：新旧两种落盘形状、时间邻近口径、窗口内零事件不假绿。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectEvents, evaluateLag, parseArgs,
  TRIGGER_TOPIC, TERMINAL_TOPICS, DEFAULT_WINDOW_MIN,
} from './check-event-trigger-lag.mjs';

const T0 = Date.parse('2026-11-12T10:00:00.000Z');
const at = (ms) => new Date(T0 + ms).toISOString();
const trigger = (ms) => ({ topic: TRIGGER_TOPIC, occurredAt: at(ms), ts: T0 + ms, payload: { hostEvent: 'skills/change' } });
const done = (ms) => ({ topic: 'curator.run-completed', occurredAt: at(ms), ts: T0 + ms, payload: { dryRun: false } });
const failed = (ms) => ({ topic: 'curator.run-failed', occurredAt: at(ms), ts: T0 + ms, payload: { error: 'EPERM' } });

test('collectEvents 兼容新旧两种落盘形状（envelope 优先 + 顶层兜底）', () => {
  const raw = {
    tables: {
      events: {
        a: { envelope: { topic: TRIGGER_TOPIC, occurredAt: at(0), payload: {} }, deliveries: {} },
        b: { topic: 'curator.run-completed', occurredAt: at(1000), payload: { dryRun: false } },
      },
    },
  };
  const out = collectEvents(raw);
  assert.equal(out.length, 2);
  assert.equal(out[0].topic, TRIGGER_TOPIC);
  assert.equal(out[1].topic, 'curator.run-completed');
  assert.equal(out[0].ts, T0);
});

test('collectEvents 丢弃无 topic / 无时间 / 时间不可解析的脏行，并按时间排序', () => {
  const raw = {
    events: [
      { topic: TRIGGER_TOPIC, occurredAt: at(5000) },
      { topic: TRIGGER_TOPIC },
      { occurredAt: at(0) },
      { topic: 'x.y', occurredAt: 'not-a-date' },
      { topic: 'curator.run-completed', occurredAt: at(1000) },
      null,
      'junk',
    ],
  };
  const out = collectEvents(raw);
  assert.deepEqual(out.map((e) => e.ts), [T0 + 1000, T0 + 5000]);
});

test('窗口内 0 条触发 → NO_TRIGGER_EVENTS，verified=false（不判绿也不判红）', () => {
  const r = evaluateLag([done(1000)], { since: T0, now: T0 + 3600_000 });
  assert.equal(r.verdict, 'NO_TRIGGER_EVENTS');
  assert.equal(r.verified, false);
  assert.equal(r.triggerCount, 0);
  assert.ok(r.attribution.includes('不证明因果关系'), '必须显式写出时间邻近口径，防假绿');
});

test('触发 + 窗口内成功终态 → OK，lagMs 如实', () => {
  const r = evaluateLag([trigger(0), done(90_000)], { since: T0, now: T0 + 3600_000 });
  assert.equal(r.verdict, 'OK');
  assert.equal(r.verified, true);
  assert.equal(r.matched.length, 1);
  assert.equal(r.matched[0].terminalTopic, 'curator.run-completed');
  assert.equal(r.matched[0].lagMs, 90_000);
  assert.equal(r.missing.length, 0);
});

test('触发 + 失败终态也算有终态（§4.2：失败不能静默断链）', () => {
  const r = evaluateLag([trigger(0), failed(60_000)], { since: T0, now: T0 + 3600_000 });
  assert.equal(r.verdict, 'OK');
  assert.equal(r.failedTerminalCount, 1);
  assert.equal(r.matched[0].terminalTopic, 'curator.run-failed');
  assert.ok(TERMINAL_TOPICS.includes('curator.run-failed'));
});

test('终态超出 windowMin → TERMINAL_MISSING，不拿窗口外的记录冒充', () => {
  const r = evaluateLag(
    [trigger(0), done(DEFAULT_WINDOW_MIN * 60_000 + 1)],
    { since: T0, now: T0 + 3600_000 },
  );
  assert.equal(r.verdict, 'TERMINAL_MISSING');
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0].triggerAt, at(0));
  assert.equal(r.matched.length, 0);
});

test('终态早于触发 → 不算配对（不能拿上一次周策展顶数）', () => {
  const r = evaluateLag([done(-60_000), trigger(0)], { since: T0 - 3600_000, now: T0 + 3600_000 });
  assert.equal(r.verdict, 'TERMINAL_MISSING');
});

test('部分缺失 → missing 明细逐条可查，matched 只列真配上的', () => {
  const r = evaluateLag(
    [trigger(0), done(60_000), trigger(600_000), trigger(1_200_000)],
    { since: T0, now: T0 + 3600_000 },
  );
  assert.equal(r.verdict, 'TERMINAL_MISSING');
  assert.equal(r.triggerCount, 3);
  assert.equal(r.matched.length, 1);
  assert.equal(r.missing.length, 2);
  assert.deepEqual(r.missing.map((m) => m.triggerAt), [at(600_000), at(1_200_000)]);
});

test('--since 过滤掉历史触发，只核启用之后的窗口', () => {
  const r = evaluateLag(
    [trigger(-86_400_000), done(-86_400_000 + 60_000)],
    { since: T0, now: T0 + 3600_000 },
  );
  assert.equal(r.verdict, 'NO_TRIGGER_EVENTS');
  assert.equal(r.triggerCount, 0);
});

test('parseArgs 支持 since / window-min / json / storage', () => {
  const a = parseArgs(['--since', '2026-11-12T00:00:00Z', '--window-min', '60', '--json', '--storage', '/tmp/x.json']);
  assert.equal(a.since, Date.parse('2026-11-12T00:00:00Z'));
  assert.equal(a.windowMin, 60);
  assert.equal(a.json, true);
  assert.equal(a.storage, '/tmp/x.json');
  assert.equal(parseArgs([]).windowMin, DEFAULT_WINDOW_MIN);
});
