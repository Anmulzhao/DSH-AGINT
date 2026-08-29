#!/usr/bin/env node
/**
 * agint-event-bus v0.7.0 smoke — `node test/smoke.mjs` 一行能跑
 *
 * 覆盖（设计稿 Sprint12 §A5）：
 *   1) envelope 构造 + 缺 topic 抛错
 *   2) 多订阅者隔离（一个抛错不影响另一个）
 *   3) sync 超时降级（fake handler sleep 11s → 返回 PENDING_REVIEW 非抛）
 *   4) Unsubscribe 后不再收事件
 *   5) traceId 缺省生成（crypto.randomUUID 格式）
 *   6) inspect 查询（filter by topic）
 *   7) FROZEN schema YAML 字面校对（与 src/schemas.ts 一致）
 *
 * 与 mount smoke 体例对齐：直接 import lib/ 编译产物 + mock EventBusContext。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(__dirname, '..');
const SCHEMA_YAML = join(PLUGIN_DIR, 'schemas', 'event-bus.schema.yaml');

const { makeEnvelope, assertEnvelope } = await import('../lib/envelope.js');
const { publish, subscribe, inspect, disposeBus, _subscriptionsSnapshot } = await import('../lib/bus.js');

// ── Mock EventBusContext（mock 内存表 + logBuffered + metrics） ──

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
    reset: function reset() {
      events.clear();
      deadletter.clear();
      pendingReview.count = 0;
      metricCounts.clear();
      logEntries.length = 0;
      disposeBus();
    },
  };
}

// ── Case 1: envelope 构造 + 缺 topic 抛错 ───────────────────────────

test('CASE 1: envelope 构造 + 缺 topic 抛错（makeEnvelope 要求 topic 必填）', () => {
  const e = makeEnvelope({
    topic: 'evolution.evaluated',
    source: 'agint-evolution-memory',
    payload: { ok: true },
  });
  // 8 顶层字段齐
  assert.equal(typeof e.id, 'string', 'id 是 string');
  assert.match(e.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(e.topic, 'evolution.evaluated');
  assert.equal(e.version, 1);
  assert.match(e.occurredAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.equal(e.source, 'agint-evolution-memory');
  assert.equal(typeof e.traceId, 'string');
  assert.equal(typeof e.payload, 'object');
  // 缺 topic → 抛错
  assert.throws(() => makeEnvelope({ topic: '', source: 'x' }), /topic is required/);
  // 无 source → 抛错
  assert.throws(() => makeEnvelope({ topic: 'evolution.ok', source: '' }), /source is required/);
});

// ── Case 2: 多订阅者隔离 ───────────────────────────────────────────

test('CASE 2: 多订阅者隔离（抛错的订阅者不影响其他订阅者）', async () => {
  const { ctx, state, reset } = makeMockCtx();
  reset();
  const received = [];
  subscribe({
    subscriber: 'sub-good',
    topics: ['mount.succeeded'],
    mode: 'async',
    reason: 'audit',
    timeoutMs: 10000,
    retry: { maxAttempts: 1, backoffMs: 50 },
  }, async (env) => { received.push(['good', env.id]); });
  subscribe({
    subscriber: 'sub-bad',
    topics: ['mount.succeeded'],
    mode: 'async',
    reason: 'audit',
    timeoutMs: 10000,
    retry: { maxAttempts: 1, backoffMs: 50 },
  }, async () => { throw new Error('intentional'); });
  subscribe({
    subscriber: 'sub-late',
    topics: ['mount.succeeded'],
    mode: 'async',
    reason: 'audit',
    timeoutMs: 10000,
    retry: { maxAttempts: 1, backoffMs: 50 },
  }, async (env) => { received.push(['late', env.id]); });

  const result = await publish(ctx, { topic: 'mount.succeeded', source: 'agint-mount' });
  // 等待所有 async 投递完成（bus publish 不等 async，但 ring 已记录 deliveries）
  await new Promise((r) => setTimeout(r, 50));
  // 两个 good/late 应收到；bad 在投递结果里是 DEAD_LETTERED（重试 1 次后抛）
  assert.deepEqual(result.deliveredTo.sort(), ['sub-good', 'sub-late']);
  assert.deepEqual(result.deadLettered, ['sub-bad']);
  // 隔离：good 与 late 都进了 received
  const tags = received.map((x) => x[0]).sort();
  assert.deepEqual(tags, ['good', 'late']);
  // metric 至少有一次 handlerError
  assert.ok(state.metricCounts.get('eventBus.handlerError') >= 1, 'sub-bad 失败计入 handlerError');
});

// ── Case 3: sync handler 超时 → 降级 PENDING_REVIEW ───────────────────────────────────────

test('CASE 3: sync handler 超时 → 降级 PENDING_REVIEW（非抛）', async () => {
  const { ctx, state, reset } = makeMockCtx();
  reset();
  // handler sleep 300ms > timeoutMs 100 → 必走超时分支
  subscribe({
    subscriber: 'sub-slow',
    topics: ['evolution.evaluated'],
    mode: 'sync',
    reason: 'policy-boundary audit (smoke)',
    timeoutMs: 100,
    retry: { maxAttempts: 1, backoffMs: 50 },
  }, async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
  const t0 = Date.now();
  const result = await publish(ctx, { topic: 'evolution.evaluated', source: 'agint-quality' });
  const elapsed = Date.now() - t0;
  assert.equal(result.accepted, true);
  // PENDING 不计入 deliveredTo/deadLettered（仅 ring 记 PENDING）
  assert.deepEqual(result.deliveredTo, []);
  assert.deepEqual(result.deadLettered, []);
  assert.ok(state.pendingReview.count >= 1, 'sync timeout 必须降级 pendingReview');
  assert.ok(state.metricCounts.get('eventBus.syncTimeout') >= 1, 'sync timeout 计入 metric');
  // elapsed 应 < 500ms（100ms 触发，不等 handler 完成）
  assert.ok(elapsed < 500, `elapsed=${elapsed}ms 应在 ~100ms 区间`);
});
// ── Case 4: Unsubscribe 后不再收事件 ────────────────────────────────

test('CASE 4: Unsubscribe 后不再收事件', async () => {
  const { ctx, state, reset } = makeMockCtx();
  reset();
  let count = 0;
  const off = subscribe({
    subscriber: 'sub-once',
    topics: ['wiki.updated'],
    mode: 'async',
    reason: 'audit',
    timeoutMs: 10000,
    retry: { maxAttempts: 1, backoffMs: 50 },
  }, async () => { count += 1; });
  // 第一次发布
  await publish(ctx, { topic: 'wiki.updated', source: 'agint-wiki' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(count, 1);
  // 退订
  off();
  // 第二次发布
  await publish(ctx, { topic: 'wiki.updated', source: 'agint-wiki' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(count, 1, 'unsubscribe 后不应再触发');
});

// ── Case 5: traceId 缺省生成 ───────────────────────────────────────

test('CASE 5: traceId 缺省生成（不传时自动填 UUIDv4）', () => {
  const e = makeEnvelope({
    topic: 'rules.added',
    source: 'agint-rules',
    payload: {},
  });
  assert.equal(typeof e.traceId, 'string');
  // 二次构造应拿到不同 traceId
  const e2 = makeEnvelope({
    topic: 'rules.added',
    source: 'agint-rules',
    payload: {},
  });
  assert.notEqual(e.traceId, e2.traceId, '不同 envelope 的 traceId 必不同（uuid 兜底）');
  // UUID 格式校验
  assert.match(e.traceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  // 显式传入则保留
  const fixed = randomUUID();
  const e3 = makeEnvelope({
    topic: 'rules.added',
    source: 'agint-rules',
    traceId: fixed,
    payload: {},
  });
  assert.equal(e3.traceId, fixed);
});

// ── Case 6: inspect 查询（filter by topic） ──────────────────────────

test('CASE 6: inspect 查询（filter by topic；其他 topic 应被过滤）', async () => {
  const { ctx, state, reset } = makeMockCtx();
  reset();
  // 投 2 条不同 topic 的事件
  await publish(ctx, { topic: 'evolution.evaluated', source: 'agint-quality' });
  await publish(ctx, { topic: 'mount.succeeded', source: 'agint-mount' });
  // 让所有 async 投递落定
  await new Promise((r) => setTimeout(r, 30));
  // inspect 默认 → 全量
  const all = inspect();
  assert.equal(all.length, 2);
  // inspect filter topic → 仅命中
  const evo = inspect({ topic: 'evolution.evaluated' });
  assert.equal(evo.length, 1);
  assert.equal(evo[0].topic, 'evolution.evaluated');
  assert.equal(typeof evo[0].payloadPreview, 'object');
  // inspect filter traceId（用某条 result.traceId 命中）
  const t = evo[0].traceId;
  const byTrace = inspect({ traceId: t });
  assert.equal(byTrace.length, 1);
  assert.equal(byTrace[0].traceId, t);
});

// ── Case 7: FROZEN EventEnvelope schema YAML 字面校对 ──────────────

test('CASE 7: FROZEN EventEnvelope schema YAML 字面 8 字段校对', () => {
  const yaml = readFileSync(SCHEMA_YAML, 'utf-8');
  // 8 字段字面
  for (const k of ['id', 'topic', 'version', 'occurredAt', 'source', 'traceId', 'correlationId', 'payload']) {
    assert.ok(yaml.includes(k), `FROZEN 字段必须含 ${k}`);
  }
  // required 集合（必含 7 字段；correlationId 可选）
  assert.match(yaml, /required:\s*\[id, topic, version, occurredAt, source, traceId, payload\]/);
  // Subscription required 3
  assert.match(yaml, /required:\s*\[subscriber, topics, mode\]/);
  // mode enum
  assert.ok(yaml.includes("enum: [sync, async]") || yaml.match(/enum:\s*\[sync,\s*async\]/));
});

// ── Case 8: manifest 8 维度 + agint_event_bus 域 ─────────────────────

test('CASE 8: manifest spec.cordis.provides 三字段名 + storage domain', () => {
  const mf = JSON.parse(readFileSync(join(PLUGIN_DIR, 'manifest.json'), 'utf-8'));
  const provides = mf.spec.cordis.provides;
  assert.deepEqual(
    provides,
    ['agint.eventBus.publish', 'agint.eventBus.subscribe', 'agint.eventBus.inspect'],
  );
  // 域
  assert.deepEqual(mf.spec.storage.domains, ['agint_event_bus']);
  // mountOrder
  assert.equal(mf.spec.mountOrder, 50);
  // 8 维度字段必含
  for (const k of ['cordis', 'storage', 'dependencies', 'permissions', 'lifecycle', 'tests', 'docs', 'changelog']) {
    assert.ok(k in mf.spec, `spec 应含 ${k}`);
  }
  // 不写朝外暴露的域名（只暴露 agint_event_bus）
  assert.ok(!mf.spec.storage.domains.includes('agint_event_log'), '不得引入 agint_event_log 域');
});

// ── Case 9: assertEnvelope + correlationId 可选 ─────────────────────

test('CASE 9: assertEnvelope 接受完整 envelope；correlationId 可缺省', () => {
  const e = makeEnvelope({
    topic: 'memory.written',
    source: 'agint-memory',
    payload: { ok: true },
    correlationId: 'trace-root-1',
  });
  assert.equal(e.correlationId, 'trace-root-1');
  // 二次 assertEnvelope 不会丢字段
  const asserted = assertEnvelope(e);
  assert.deepEqual(asserted, e);
  // 不合法 envelope → 抛
  assert.throws(() => assertEnvelope({ topic: 'invalid' }), /validation failed/);
});

// ── Case 10: disposeBus 后订阅表清空 ───────────────────────────────

test('CASE 10: disposeBus 清空 ring + 订阅表', async () => {
  const { ctx, state, reset } = makeMockCtx();
  reset();
  subscribe({
    subscriber: 'sub-x',
    topics: ['rules.added'],
    mode: 'async',
    reason: 'audit',
    timeoutMs: 10000,
    retry: { maxAttempts: 1, backoffMs: 50 },
  }, async () => {});
  assert.equal(_subscriptionsSnapshot().length, 1);
  await publish(ctx, { topic: 'rules.added', source: 'agint-rules' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(inspect().length, 1);
  reset(); // 这里 disposeBus 已隐式调用
  assert.equal(_subscriptionsSnapshot().length, 0, 'dispose 后订阅表为空');
  assert.equal(inspect().length, 0, 'dispose 后 ring 为空');
});
