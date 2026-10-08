#!/usr/bin/env node
// agint-ov-strategy / 总线订阅晚挂修复 unit test
//
// 2026-10-07 取证：`dream.completed`（countPromoted=14）确实发出并投递给
// agint-self-model / agint-trajectory，但订阅者列表里**没有 agint-ov-strategy**，
// 且它也不在 orphanSubscriptions（有订阅但 0 投递会被列出来）里 —— 判定为
// 「根本没有订阅」。
//
// 根因：wireBusSubscriptions() 只在 apply 末尾调一次，bus 服务缺席时静默 return；
// 而 OV runtime 包装走 ensureObserver()，它有 apply + runtimeNow + 工具 hook 三处
// 晚挂。两者设计不对称 ⇒ 依赖 apply 顺序的软依赖，被写成了硬依赖。
//
// 症状形态值得单独记：ov.recall.checked / ov.session.flushed / ov.profile.delivered
// 三个观测事件在正常发布（走晚挂路径），而投影 remember() 一次没触发（不走晚挂）——
// 「一半活着一半死」，最容易被读成「投影功能没实现」而不是「顺序竞争」。
//
// 本文件只锁一件事：**bus 晚于本插件 apply 时，订阅最终必须建立，且只建一次**。
// 不在此断言 OV 写入成功与否（那是传输层，本文件不覆盖）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

const flush = () => new Promise((r) => setImmediate(r));

function makeMockRuntime() {
  return {
    states: new Map(),
    addMessageCalls: [],
    healthOk: true,
    addMessageResult: { ok: true, status: 200 },
    searchResult: { ok: true, result: { entries: [{ uri: 'viking://x' }] } },
    recallResult: { form: 'recall', content: 'x'.repeat(40) },
    profileResult: { content: 'p'.repeat(10) },
  };
}

/** services 可变 —— 用来模拟「bus 在 apply 之后才注册」。 */
function makeMockCtx({ runtime = null, services = {} } = {}) {
  const provides = new Map();
  const effects = [];
  const hooks = new Map();
  const get = (key) => {
    if (key === 'openvikingMemory') return runtime;
    if (key in services) return services[key];
    return undefined;
  };
  const ctx = {
    get,
    provide: (k, v) => { provides.set(k, v); },
    effect: (fn) => { effects.push(fn); },
    on: (event, handler) => {
      if (!hooks.has(event)) hooks.set(event, []);
      hooks.get(event).push(handler);
      return () => {};
    },
  };
  ctx.provides = provides;
  ctx.effects = effects;
  ctx.hooks = hooks;
  return { ctx, provides, effects, hooks };
}

function loadPlugin(ctx, config) {
  apply(ctx, config);
  return ctx.provides.get('agint.ovStrategy');
}

// ── ① bus 晚到：必须最终订阅上 ──────────────────────────────────────

test('bus 晚于 apply 注册 → 晚挂后订阅建立（修复前 0 次）', () => {
  const rt = makeMockRuntime();
  const services = {};                      // 故意为空：apply 时 bus 还没来
  const { ctx } = makeMockCtx({ runtime: rt, services });
  const svc = loadPlugin(ctx);

  // apply 阶段：拿不到 subscribe，订阅必然为 0
  assert.equal(svc.status().counters.attempted, 0);

  // bus 现在才注册（模拟 agint-event-bus 晚 apply）
  const subs = [];
  services['agint.eventBus.subscribe'] = (sub, handler) => {
    subs.push({ topics: sub.topics, handler, mode: sub.mode });
    return () => {};
  };

  // 晚挂触发口：status() → runtimeNow() → ensureLateAttach()
  svc.status();
  assert.equal(subs.length, 1, 'bus 晚到时订阅必须被补挂');
  assert.deepEqual(subs[0].topics, ['dream.completed', 'diagnosis.completed']);
  assert.equal(subs[0].mode, 'async');
});

// ── ② 幂等：补挂不能重复订阅 ────────────────────────────────────────

test('反复触发晚挂 → 订阅只建一次（否则每步都重订阅，事件重复处理）', () => {
  const rt = makeMockRuntime();
  const services = {
    'agint.eventBus.subscribe': () => () => {},
  };
  const { ctx } = makeMockCtx({ runtime: rt, services });
  const svc = loadPlugin(ctx);

  const subs = [];
  services['agint.eventBus.subscribe'] = (sub, handler) => {
    subs.push(sub);
    return () => {};
  };

  // bus 本来就在时，apply 已经建过一次；这里重装一个计数版再验幂等
  svc.status();
  svc.status();
  svc.status();
  // 上面 3 次不会再建（busWired 已在 apply 时置位），所以计数仍为 0
  assert.equal(subs.length, 0, 'bus 一开始就在时，晚挂不得重复订阅');
  assert.ok(svc.status().observer.enabled, '观测开关仍开着');
});

// ── ③ 两半都活着才算修好（防「只补了一半」）────────────────────────

test('半死形态回归：runtime 晚到 + bus 晚到，两条晚挂路径都要活', () => {
  const rt = null;                          // runtime 也晚到
  const services = {};
  const { ctx } = makeMockCtx({ runtime: rt, services });
  const svc = loadPlugin(ctx);

  assert.equal(svc.status().runtimeAvailable, false);

  // runtime 后到
  const lateRt = makeMockRuntime();
  let current = null;
  const get = (key) => {
    if (key === 'openvikingMemory') return current;
    if (key in services) return services[key];
    return undefined;
  };
  ctx.get = get;
  current = lateRt;

  const subs = [];
  services['agint.eventBus.subscribe'] = (sub) => { subs.push(sub); return () => {}; };

  svc.status();
  assert.equal(svc.status().runtimeAvailable, true, 'runtime 晚到要能被补挂发现');
  assert.equal(subs.length, 1, 'bus 晚到也要能被补挂发现');
});
