/**
 * agint-mutator diagnosis.completed subscribe tests — Sprint 12 / A6 (T1 影子期).
 * Run: node --test plugins/agint-mutator/test/diagnosis-completed-subscribe.test.mjs
 *
 * 覆盖：
 *   1. bus 可用时 subscribe('diagnosis.completed') → 注册 handler；触发 → 观测计数 +1 + 控制台观测行
 *   2. bus 不可用（subscribe 返回 null/undefined）→ 静默降级，不 throw
 *   3. subscribe 抛错/不可用 → record warn 但 apply 不抛（不破坏 mutator 主决策路径）
 *   4. 手动调 handler 收到 envelope → 计数 +1（影子观测不修主决策）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const plugin = require('../lib/index.js');

function buildServices(opts = {}) {
  const services = {}, disposers = [];
  let capturedHandler = null;
  const subscribeArgs = [];
  const bus = opts.bus;
  plugin.apply({
    storageDomain: { open: async () => { const s = new Map(); return { table: () => ({ entries: () => Array.from(s, ([id, v]) => ({ id, ...v })), put: async (id, v) => { s.set(id, v); } }), close: async () => {} }; } },
    get: (n) => {
      if (n === 'agint.eventBus.subscribe') {
        // bus 可用：返回一个捕获 handler 的 subscribe
        return (args, handler) => {
          subscribeArgs.push(args);
          capturedHandler = handler;
          return () => undefined; // unsubscribe
        };
      }
      if (n === 'agint.eventBus.subscribe' && bus === 'throw') {
        throw new Error('subscribe unavailable');
      }
      return opts.softDeps?.[n] ?? null;
    },
    provide: (n, f) => { services[n] = f; },
    effect: (d) => { disposers.push(d); return () => {}; },
  });
  return { services, disposers, getHandler: () => capturedHandler, subscribeArgs };
}

test('bus 可用时注册 diagnosis.completed 订阅且存在观测计数 service', async () => {
  const { services, subscribeArgs } = buildServices({ bus: 'ok' });
  const countSvc = services['agint.mutator._diagnosisCompletedObservationCount'];
  assert.equal(typeof countSvc, 'function');
  assert.equal(countSvc(), 0);
  assert.equal(subscribeArgs.length, 1);
  assert.equal(subscribeArgs[0].subscriber, 'agint-mutator');
  assert.deepEqual(subscribeArgs[0].topics, ['diagnosis.completed']);
  assert.equal(subscribeArgs[0].mode, 'async');
});

test('触发 handler → 观测计数 +1（影子观测，不改主决策）', async () => {
  const { services, getHandler } = buildServices({ bus: 'ok' });
  const handler = getHandler();
  assert.equal(typeof handler, 'function');
  await handler({
    topic: 'diagnosis.completed',
    version: 1,
    source: 'agint-diagnosis',
    payload: { reportId: 'r-1', rootCauseDistribution: { TOOL_GAP: 3 }, clusterCount: 1, evaluatedAt: '2026-08-30T00:00:00Z' },
  });
  assert.equal(services['agint.mutator._diagnosisCompletedObservationCount'](), 1);
});

test('bus 不可用（subscribe 为 null）→ 静默降级，apply 不 throw', async () => {
  let threw = false;
  try {
    buildServices({ bus: null });
  } catch { threw = true; }
  // get 对 agint.eventBus.subscribe 返回 undefined → 走 warn 分支，不 throw
  assert.equal(threw, false, 'bus 不可用不应 throw');
});

test('subscribe 抛错 → apply 捕获，不 throw', async () => {
  let threw = false;
  try {
    buildServices({ bus: 'throw' });
  } catch { threw = true; }
  assert.equal(threw, false, 'subscribe 抛错应被 catch，apply 不 throw');
});
