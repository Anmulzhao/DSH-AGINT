/**
 * agint-event-bus —— events 表写入失败的可见性测试（2026-09-26）
 * Run: node plugins/agint-event-bus/test/event-write-visibility.test.mjs
 *
 * 背景：publish 的顺序是「先分发订阅者、再写 events 表」（bus.js）。写表失败此前
 * 只 `ctx.metrics('eventBus.eventWriteFailed', 1)` —— 不打日志、不进快照。
 * 后果：事件已经在 handler 里跑过了，但 events 表里查不到，排查时看起来像
 * "总线上什么都没发生"。2026-09-26 的诊断自激环就被这层静默隐藏了很久。
 *
 * 本测试锁住三件事：
 *   1) 写表失败会产生可见告警（console.warn）
 *   2) 失败计数进 metricsSnapshot（可观测出口）
 *   3) 失败**不影响**投递与 publish 返回（订阅者隔离硬保证不被破坏）
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { publish, subscribe, disposeBus, metricsSnapshot } from '../lib/bus.js';

function makeMockCtx({ eventsPutThrows = false } = {}) {
  const events = new Map();
  const metricCounts = new Map();
  return {
    ctx: {
      tables: {
        events: {
          get: async (id) => events.get(id) ?? null,
          put: async (id, v) => {
            if (eventsPutThrows) throw new Error('EPERM: operation not permitted, rename → agint_event_bus.json');
            events.set(id, v);
          },
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
      metrics: (k, d) => { metricCounts.set(k, (metricCounts.get(k) ?? 0) + d); },
    },
    state: { events, metricCounts },
  };
}

/** 截获 console.warn（处理异步：必须 await 完 fn 再还原） */
async function captureWarn(fn) {
  const seen = [];
  const orig = console.warn;
  console.warn = (...args) => { seen.push(args.join(' ')); };
  try {
    const result = await fn();
    return { seen, result };
  }
  finally { console.warn = orig; }
}

before(() => { disposeBus(); });
after(() => { disposeBus(); });
beforeEach(() => { disposeBus(); });

test('events 表写入失败 → 产生可见告警 + 计数进快照 + publish 仍成功', async () => {
  const { ctx, state } = makeMockCtx({ eventsPutThrows: true });
  let handlerCalls = 0;
  subscribe({ subscriber: 'probe', topics: ['probe.topic'], mode: 'async' }, async () => { handlerCalls += 1; });

  const { seen, result } = await captureWarn(() => publish(ctx, {
    topic: 'probe.topic', version: 1, source: 'test', payload: {},
  }));
  const res = await result;

  // 1) 告警可见
  assert.equal(seen.length, 1, '首次失败必须打 warn');
  assert.match(seen[0], /events 表写入失败/);
  assert.match(seen[0], /EPERM/);

  // 2) 计数可观测
  const snap = await metricsSnapshot(ctx);
  assert.equal(snap.eventWriteFailedCount, 1);
  assert.equal(state.metricCounts.get('eventBus.eventWriteFailed'), 1);

  // 3) 投递与返回不受影响（先分发、后写表 —— 失败不得击穿）
  assert.equal(handlerCalls, 1, '订阅者仍应被投递');
  assert.equal(res.accepted, true);
  assert.deepEqual(res.deliveredTo, ['probe']);
});

test('限流：连续失败只打首条 + 每 100 条，但计数逐次累加', async () => {
  const { ctx } = makeMockCtx({ eventsPutThrows: true });
  const { seen, result } = await captureWarn(async () => {
    for (let i = 0; i < 5; i += 1) {
      await publish(ctx, { topic: 'probe.topic', version: 1, source: 'test', payload: { i } });
    }
  });
  await result;
  assert.equal(seen.length, 1, '5 次失败只打 1 条 warn（限流，避免风暴期刷屏）');
  const snap = await metricsSnapshot(ctx);
  assert.equal(snap.eventWriteFailedCount, 5, '计数必须逐次累加，不能被限流吞掉');
});

test('写入正常时零告警、计数为 0（不误报）', async () => {
  const { ctx, state } = makeMockCtx({ eventsPutThrows: false });
  const { seen, result } = await captureWarn(() => publish(ctx, {
    topic: 'probe.topic', version: 1, source: 'test', payload: {},
  }));
  await result;
  assert.equal(seen.length, 0);
  const snap = await metricsSnapshot(ctx);
  assert.equal(snap.eventWriteFailedCount, 0);
  assert.equal(state.events.size, 1, '正常时应真的落库');
});
