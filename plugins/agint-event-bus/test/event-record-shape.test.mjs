/**
 * agint-event-bus —— events 表 record 形状守卫（2026-09-27）
 * Run: node --test plugins/agint-event-bus/test/event-record-shape.test.mjs
 *
 * 背景（提案 0f91c868 问题2 / 932486d6 子提案）：
 *   record 此前只有 { envelope, payloadPreview, occurredAt, traceId }，外部工具
 *   想按 topic / source 过滤必须拆 value.envelope（envelope 才是真身，7 字段全在
 *   里面）。本次在写入时补顶层冗余 `topic` / `source` 两个标量，并在
 *   EventRecordSchema 里声明为 optional（兼容存量 1155 条）。
 *
 * 本测试锁住三件事：
 *   1) publish 落库的 record 顶层带 topic / source，且与 envelope 一致；
 *   2) record 的其余四字段形状不变（存量消费者兼容）；
 *   3) KNOWN_EVENT_SOURCES 导出可用（source 文档化清单，非白名单）。
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { publish, disposeBus } from '../lib/bus.js';
import { KNOWN_EVENT_SOURCES } from '../lib/schemas.js';

function makeMockCtx() {
  const events = new Map();
  return {
    ctx: {
      tables: {
        events: {
          get: async (id) => events.get(id) ?? null,
          put: async (id, v) => { events.set(id, v); },
          delete: async (id) => { events.delete(id); },
          entries: () => events.entries(),
          get size() { return events.size; },
        },
        deadletter: {
          get: async () => null,
          put: async () => undefined,
          delete: async () => undefined,
          entries: () => [].values(),
          get size() { return 0; },
        },
      },
      logBuffered: async () => undefined,
      pendingReview: async () => undefined,
      metrics: () => undefined,
    },
    events,
  };
}

before(() => { disposeBus(); });
after(() => { disposeBus(); });
beforeEach(() => { disposeBus(); });

test('publish 落库 record：顶层带 topic/source 且与 envelope 一致', async () => {
  const { ctx, events } = makeMockCtx();
  const res = await publish(ctx, {
    topic: 'probe.shape', version: 1, source: 'agint-event-bus-test', payload: { k: 1 },
  });
  assert.equal(res.accepted, true);
  assert.equal(events.size, 1, '应真的落库');

  const [record] = events.values();

  // 顶层冗余标量（本次改动）—— 外部工具直读，不用拆 envelope
  assert.equal(record.topic, 'probe.shape', 'record.topic 必须在顶层');
  assert.equal(record.source, 'agint-event-bus-test', 'record.source 必须在顶层');

  // 与 envelope 真身交叉一致
  assert.equal(record.envelope.topic, record.topic);
  assert.equal(record.envelope.source, record.source);
  assert.equal(record.envelope.occurredAt, record.occurredAt);
  assert.equal(record.envelope.traceId, record.traceId);

  // 其余四字段形状不变（存量消费者兼容）
  assert.ok(record.envelope, 'envelope 仍是主载体');
  assert.ok('payloadPreview' in record);
  assert.equal(typeof record.occurredAt, 'string');
  assert.equal(typeof record.traceId, 'string');
  // envelope 7 字段全在（子提案 932486d6 关心 source/id/version 可达性）
  for (const k of ['id', 'topic', 'version', 'occurredAt', 'source', 'traceId', 'payload']) {
    assert.ok(k in record.envelope, `envelope.${k} 必须存在`);
  }
});

test('KNOWN_EVENT_SOURCES 导出可用：快照清单，不是白名单', () => {
  assert.ok(Array.isArray(KNOWN_EVENT_SOURCES));
  assert.ok(KNOWN_EVENT_SOURCES.includes('agint-dream'));
  assert.ok(KNOWN_EVENT_SOURCES.includes('agint-metrics'));
  assert.ok(Object.isFrozen(KNOWN_EVENT_SOURCES), '快照清单应冻结防手滑改写');
});
