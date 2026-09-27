/**
 * agint-ov-strategy smoke tests — v0.2.0.
 * Run: node plugins/agint-ov-strategy/test/smoke.mjs
 *
 * 覆盖（设计稿 §7 验收口径「插件级」）：
 *   T1  bundle 不可用 → 软失败 'bundle-unavailable'，不抛
 *   T2  kill-switch（env AGINT_OV_STRATEGY=off）→ 'disabled'
 *   T3  正常写入链：stateFor → ensureState → enqueueWrite(addMessage) → dispose
 *       （含 payload 形状：[scope] 前缀 + peer_id；伪会话 id 规则）
 *   T4  addMessage retryable 失败 → enqueuePending 兜底（R4）
 *   T5  scope 白名单过滤 → 'scope-not-allowed'
 *   T6  短文本过滤 → 'too-short'
 *   T7  recall 成功透传 entries；失败软返回
 *   T8  bus 订阅：dream.completed（promoted>0 记 / =0 不记）+ diagnosis.completed 恒记
 *   T9  status() 计数与 runtimeAvailable
 *   T10 卸载：effect disposer 解绑订阅；disposed 后 remember → 'disposed'
 *   T11 观测通路 A：OV MCP 工具调用 → ov.tool.called，恒 next() 放行；非 OV 工具不镜像
 *   T12 观测通路 B：runtime.recallMessage 包装 → ov.recall.checked（命中/未命中都镜像）
 *   T13 观测通路 B/C：profile.delivered + session.flushed 镜像
 *   T14 冻结 runtime → 包装降级（wraps=false）不抛，主路径无损伤
 *   T15 observe:false → 不注册钩子、不包装
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { name, inject, apply, isRetryableFailure, TOPIC_SUMMARIZERS } from '../lib/index.js';

// 微任务排空：观测是 fire-and-forget，断言前先等队列落定
const flush = () => new Promise(r => setImmediate(r));

// ── Mock runtime：镜像官方 OpenVikingRuntime v0.5.8 的被消费面 ──────────────
function makeMockRuntime(opts = {}) {
  const rt = {
    states: new Map(),
    addMessageCalls: [],
    pendingCalls: [],
    disposed: [],
    healthOk: opts.healthOk !== false,
    addMessageResult: opts.addMessageResult || { ok: true, status: 200 },
    searchResult: opts.searchResult !== undefined ? opts.searchResult : { ok: true, result: { entries: [{ uri: 'viking://x' }] } },
    client: {
      addMessage: async (sessionId, payload, peerId) => {
        rt.addMessageCalls.push({ sessionId, payload, peerId });
        if (typeof rt.addMessageResult === 'function') return rt.addMessageResult(sessionId, payload);
        return rt.addMessageResult;
      },
      fetchJSON: async (path, init) => {
        rt.searchPath = path;
        rt.searchBody = JSON.parse(init.body);
        if (typeof rt.searchResult === 'function') return rt.searchResult(path, init);
        return rt.searchResult;
      },
    },
    stateFor(session) {
      let state = rt.states.get(session.id);
      if (state) return state;
      state = {
        dshSessionId: String(session.id),
        ovSessionId: `dsh-${session.id}`,
        config: { peerId: 'agint', commitTokenThreshold: 20000 },
        ready: false,
        initializationRetryable: false,
        hasPendingWrites: false,
        pendingCreatedAt: 0,
        disposing: null,
        writes: Promise.resolve(),
      };
      rt.states.set(session.id, state);
      return state;
    },
    async ensureState(state) {
      state.ready = rt.healthOk;
      return state;
    },
    enqueueWrite(state, op) {
      // 官方语义：链式不 await，catch→log（结果靠 op 内闭包捕获 + 调用方 await state.writes）
      state.writes = state.writes.then(op).catch(() => {});
    },
    async enqueuePending(state, type, payload) {
      rt.pendingCalls.push({ sessionId: state.ovSessionId, type, payload });
      state.hasPendingWrites = true;
      return { ok: true };
    },
    dispose(session) {
      rt.disposed.push(session.id);
      rt.states.delete(session.id);
      return Promise.resolve();
    },
    // 官方 runtime 还有这三个被钩子面调用的方法（观测镜像的包装对象）
    recallMessage: async () => null,
    profileMessage: async () => null,
    flush: async () => {},
  };
  return rt;
}

// ── Mock host ctx：provides 表 + effect 捕获 + 可选服务 ─────────────────────
// provides/effects 直接挂在 ctx 上，测试侧 destructure 单一对象即可。
function makeMockCtx({ runtime = null, services = {} } = {}) {
  const provides = new Map();
  const effects = [];
  const hooks = new Map();                     // event -> [handler]
  const get = (key) => {
    if (key === 'openvikingMemory') return runtime;
    if (key in services) return services[key];
    return undefined;
  };
  const ctx = {
    get,
    provide: (k, v) => { provides.set(k, v); },
    effect: (fn) => { effects.push(fn); },
    // 宿主钩子面（dsh ctx.on）：观测镜像用
    on: (event, handler) => {
      if (!hooks.has(event)) hooks.set(event, []);
      hooks.get(event).push(handler);
      return () => {};
    },
  };
  ctx.provides = provides;
  ctx.effects = effects;
  ctx.hooks = hooks;
  return { ctx };
}

// Mock event bus：publish/subscribe 双面
function makeMockBus() {
  const published = [];
  const handlers = [];                       // { topics, handler, unsub }
  return {
    published,
    services: {
      'agint.eventBus.publish': async (envelope) => { published.push(envelope); return { accepted: true }; },
      'agint.eventBus.subscribe': (sub, handler) => {
        handlers.push({ topics: sub.topics, handler, mode: sub.mode });
        return () => {};
      },
    },
    handlers,
    async emit(topic, payload) {
      for (const h of handlers) {
        if (h.topics.includes(topic)) await h.handler({ topic, payload });
      }
    },
  };
}

function loadPlugin(ctx, config) {
  apply(ctx, config);
  return ctx.provides.get('agint.ovStrategy');
}

const VALID_TEXT = '这是一条足够长的经验沉淀文本，用于通过最小长度过滤。';

// ── T1 ───────────────────────────────────────────────────────────────────────
test('T1: bundle 不可用 → 软失败 bundle-unavailable，不抛', async () => {
  const { ctx } = makeMockCtx({ runtime: null });
  const svc = loadPlugin(ctx);
  const r = await svc.remember({ scope: 'manual', text: VALID_TEXT });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bundle-unavailable');
});

// ── T2 ───────────────────────────────────────────────────────────────────────
test('T2: kill-switch env AGINT_OV_STRATEGY=off → disabled（出厂即开，off 才关）', async () => {
  const rt = makeMockRuntime();
  const { ctx } = makeMockCtx({ runtime: rt });
  process.env.AGINT_OV_STRATEGY = 'off';
  try {
    const svc = loadPlugin(ctx);
    const r = await svc.remember({ scope: 'manual', text: VALID_TEXT });
    assert.equal(r.reason, 'disabled');
    assert.equal(rt.addMessageCalls.length, 0);
    assert.equal(svc.status().enabled, false);
  } finally {
    delete process.env.AGINT_OV_STRATEGY;
  }
  // env 缺省 = 开
  const { ctx: ctx2 } = makeMockCtx({ runtime: rt });
  const svc2 = loadPlugin(ctx2);
  assert.equal(svc2.status().enabled, true);
});

// ── T3 ───────────────────────────────────────────────────────────────────────
test('T3: 正常写入链 → ok，payload 带 [scope] 前缀与 peer_id，dispose 被调', async () => {
  const rt = makeMockRuntime();
  const bus = makeMockBus();
  const { ctx } = makeMockCtx({ runtime: rt, services: bus.services });
  const svc = loadPlugin(ctx);
  const r = await svc.remember({ scope: 'evolution', text: VALID_TEXT, traceId: 'evo-9' });
  assert.equal(r.ok, true);
  assert.equal(r.ovSessionId, 'dsh-agint-evolution-evo-9');
  assert.equal(rt.addMessageCalls.length, 1);
  const call = rt.addMessageCalls[0];
  assert.equal(call.peerId, 'agint');
  assert.equal(call.payload.role, 'user');
  assert.match(call.payload.content, /^\[evolution\]/);
  assert.equal(call.payload.peer_id, 'agint');
  assert.deepEqual(rt.disposed, ['agint-evolution-evo-9']);
  // 观测事件
  const remembered = bus.published.filter(e => e.topic === 'ov.strategy.remembered');
  assert.equal(remembered.length, 1);
  assert.equal(remembered[0].source, name);
});

// ── T4 ───────────────────────────────────────────────────────────────────────
test('T4: addMessage retryable 失败（503）→ enqueuePending 兜底', async () => {
  const rt = makeMockRuntime({ addMessageResult: { ok: false, status: 503 } });
  const { ctx } = makeMockCtx({ runtime: rt });
  const svc = loadPlugin(ctx);
  const r = await svc.remember({ scope: 'manual', text: VALID_TEXT });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^add-message-failed:503$/);
  assert.equal(rt.pendingCalls.length, 1);
  assert.equal(rt.pendingCalls[0].type, 'addMessage');
  // 4xx 语义错误不重试
  const rt2 = makeMockRuntime({ addMessageResult: { ok: false, status: 400 } });
  const { ctx: ctx2 } = makeMockCtx({ runtime: rt2 });
  const svc2 = loadPlugin(ctx2);
  await svc2.remember({ scope: 'manual', text: VALID_TEXT });
  assert.equal(rt2.pendingCalls.length, 0);
});

// ── T5 ───────────────────────────────────────────────────────────────────────
test('T5: scope 不在白名单 → scope-not-allowed，零网络副作用', async () => {
  const rt = makeMockRuntime();
  const { ctx } = makeMockCtx({ runtime: rt });
  const svc = loadPlugin(ctx);
  const r = await svc.remember({ scope: 'random', text: VALID_TEXT });
  assert.equal(r.reason, 'scope-not-allowed');
  assert.equal(rt.addMessageCalls.length, 0);
});

// ── T6 ───────────────────────────────────────────────────────────────────────
test('T6: 短文本 → too-long/too-short 过滤', async () => {
  const rt = makeMockRuntime();
  const { ctx } = makeMockCtx({ runtime: rt });
  const svc = loadPlugin(ctx);
  assert.equal((await svc.remember({ scope: 'manual', text: '太短' })).reason, 'too-short');
  assert.equal(
    (await svc.remember({ scope: 'manual', text: 'x'.repeat(4001) })).reason,
    'too-long',
  );
  assert.equal(rt.addMessageCalls.length, 0);
});

// ── T7 ───────────────────────────────────────────────────────────────────────
test('T7: recall 成功透传 entries；失败软返回（R3）', async () => {
  const rt = makeMockRuntime();
  const { ctx } = makeMockCtx({ runtime: rt });
  const svc = loadPlugin(ctx);
  const r = await svc.recall('上次 mount 失败的根因');
  assert.equal(r.ok, true);
  assert.deepEqual(r.entries, [{ uri: 'viking://x' }]);
  assert.equal(rt.searchPath, '/api/v1/search/search');
  assert.equal(rt.searchBody.mode, 'context');

  const rt2 = makeMockRuntime({ searchResult: { ok: false, status: 500 } });
  const { ctx: ctx2 } = makeMockCtx({ runtime: rt2 });
  const svc2 = loadPlugin(ctx2);
  const r2 = await svc2.recall('任意查询');
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /^search-failed:500$/);

  // bundle 缺席
  const { ctx: ctx3 } = makeMockCtx({ runtime: null });
  const svc3 = loadPlugin(ctx3);
  assert.equal((await svc3.recall('任意查询')).reason, 'bundle-unavailable');
  // 坏入参
  assert.equal((await svc3.recall('  ')).reason, 'bad-query');
});

// ── T8 ───────────────────────────────────────────────────────────────────────
test('T8: bus 订阅——dream promoted>0 才记 / =0 不记；diagnosis 恒记', async () => {
  const rt = makeMockRuntime();
  const bus = makeMockBus();
  const { ctx } = makeMockCtx({ runtime: rt, services: bus.services });
  const svc = loadPlugin(ctx);
  assert.equal(bus.handlers.length, 1, '恰好建立一个订阅');
  assert.equal(bus.handlers[0].mode, 'async');
  assert.deepEqual(bus.handlers[0].topics, ['dream.completed', 'diagnosis.completed']);

  const base = rt.addMessageCalls.length;
  await bus.emit('dream.completed', {
    sweepId: '111', countCandidates: 5, countGated: 2, countPromoted: 0,
  });
  assert.equal(rt.addMessageCalls.length, base, '空转 sweep（promoted=0）不记');

  await bus.emit('dream.completed', {
    sweepId: '222', countCandidates: 5, countGated: 3, countPromoted: 2,
    diaryPath: 'D:/x/diary.md', dedupeStats: { dropped: 1 },
  });
  assert.equal(rt.addMessageCalls.length, base + 1);
  const dreamCall = rt.addMessageCalls[base];
  assert.match(dreamCall.sessionId, /^dsh-agint-dream-222$/);
  assert.match(dreamCall.payload.content, /^\[dream\] dream sweep 完成/);
  assert.match(dreamCall.payload.content, /晋升=2/);

  await bus.emit('diagnosis.completed', {
    reportId: 'rep-1', clusterCount: 3, rootCauseDistribution: { a: 2 },
  });
  const diagCall = rt.addMessageCalls[base + 1];
  assert.match(diagCall.sessionId, /^dsh-agint-diagnosis-rep-1$/);
  assert.match(diagCall.payload.content, /^\[diagnosis\] 诊断报告完成/);
  assert.ok(svc.status().counters.succeeded >= 2);
});

// ── T9 ───────────────────────────────────────────────────────────────────────
test('T9: status() 反映 runtime 可用性与计数', async () => {
  const rt = makeMockRuntime();
  const { ctx } = makeMockCtx({ runtime: rt });
  const svc = loadPlugin(ctx);
  const s0 = svc.status();
  assert.equal(s0.runtimeAvailable, true);
  assert.equal(s0.enabled, true);
  assert.deepEqual(s0.scopes, ['dream', 'diagnosis', 'evolution', 'manual']);

  const { ctx: ctx2 } = makeMockCtx({ runtime: null });
  const svc2 = loadPlugin(ctx2);
  assert.equal(svc2.status().runtimeAvailable, false);
});

// ── T10 ──────────────────────────────────────────────────────────────────────
test('T10: 卸载——effect disposer 解绑订阅；disposed 后 remember 拒绝', async () => {
  const rt = makeMockRuntime();
  const bus = makeMockBus();
  let unsubCalled = false;
  bus.services['agint.eventBus.subscribe'] = (sub, handler) => {
    return () => { unsubCalled = true; };
  };
  const { ctx } = makeMockCtx({ runtime: rt, services: bus.services });
  const svc = loadPlugin(ctx);
  assert.equal(ctx.effects.length, 1);
  const disposer = ctx.effects[0]();        // effect 注册的是工厂，先取 disposer
  await disposer();                          // 再触发卸载
  assert.equal(unsubCalled, true, '订阅被解绑');
  const r = await svc.remember({ scope: 'manual', text: VALID_TEXT });
  assert.equal(r.reason, 'disposed');
});

// ── T11：观测通路 A ──────────────────────────────────────────────────────────
test('T11: OV MCP 工具调用 → ov.tool.called；恒 next() 放行；非 OV 工具不镜像', async () => {
  const rt = makeMockRuntime();
  const bus = makeMockBus();
  const { ctx } = makeMockCtx({ runtime: rt, services: bus.services });
  const svc = loadPlugin(ctx);
  const handler = ctx.hooks.get('tools/post-execute')?.[0];
  assert.ok(handler, '已注册 tools/post-execute');

  let nextCalled = false;
  const out = await handler(
    { name: 'openviking_write', arguments: { uri: 'viking://a', content: 'x' } },
    { ok: true },
    async () => { nextCalled = true; return 'passed'; },
  );
  assert.equal(out, 'passed', '镜像不改写执行结果');
  assert.equal(nextCalled, true, '恒放行');
  await flush();
  const events = bus.published.filter(e => e.topic === 'ov.tool.called');
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.tool, 'openviking_write');
  assert.deepEqual(events[0].payload.argKeys, ['uri', 'content']);
  assert.equal(events[0].payload.ok, true);
  assert.equal(events[0].source, name);

  // 非 OV 工具（shell）不镜像
  await handler({ name: 'shell', arguments: { cmd: 'ls' } }, {}, async () => 'ok');
  await flush();
  assert.equal(bus.published.filter(e => e.topic === 'ov.tool.called').length, 1);
  assert.equal(svc.status().counters.observedTool, 1);
});

// ── T12：观测通路 B（recall）─────────────────────────────────────────────────
test('T12: runtime.recallMessage 包装 → ov.recall.checked；命中/未命中都镜像', async () => {
  const rt = makeMockRuntime();
  rt.recallMessage = async (agent, messages) => rt.recallResult;
  rt.recallResult = { form: 'recall', content: 'x'.repeat(80) };
  const bus = makeMockBus();
  const { ctx } = makeMockCtx({ runtime: rt, services: bus.services });
  const svc = loadPlugin(ctx);
  assert.equal(svc.status().observer.wraps.recallMessage, true, 'runtime 已被包装');

  const r = await rt.recallMessage({ session: { id: 's1' } }, [{ content: '上次挂载为什么失败' }]);
  assert.deepEqual(r, rt.recallResult, '包装透传原返回值');
  await flush();
  let ev = bus.published.filter(e => e.topic === 'ov.recall.checked');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.injected, true);
  assert.equal(ev[0].payload.querySize, '上次挂载为什么失败'.length);
  assert.equal(ev[0].payload.blockSize, JSON.stringify(rt.recallResult).length);

  // 未命中（返回 null）也镜像——「查了但 0 命中」是回溯需要的事实
  rt.recallResult = null;
  await rt.recallMessage({}, [{ content: 'q' }]);
  await flush();
  ev = bus.published.filter(e => e.topic === 'ov.recall.checked');
  assert.equal(ev.length, 2);
  assert.equal(ev[1].payload.injected, false);
  assert.equal(svc.status().counters.observedRecall, 2);
});

// ── T13：观测通路 B/C（profile + flush）──────────────────────────────────────
test('T13: profile.delivered（仅成功注入才记）与 session.flushed 镜像', async () => {
  const rt = makeMockRuntime();
  rt.profileMessage = async () => rt.profileResult;
  rt.profileResult = { content: 'p'.repeat(10) };
  rt.flush = async (session) => { rt.flushCalls = (rt.flushCalls || 0) + 1; };
  const bus = makeMockBus();
  const { ctx } = makeMockCtx({ runtime: rt, services: bus.services });
  const svc = loadPlugin(ctx);

  await rt.profileMessage({ session: { id: 's1' } });
  await flush();
  let ev = bus.published.filter(e => e.topic === 'ov.profile.delivered');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.blockSize > 0, true);

  // profile 返回 null（已注入过/被跳过）→ 不记
  rt.profileResult = null;
  await rt.profileMessage({});
  await flush();
  ev = bus.published.filter(e => e.topic === 'ov.profile.delivered');
  assert.equal(ev.length, 1, '跳过不镜像');

  await rt.flush({ id: 'sess-9' });
  await flush();
  ev = bus.published.filter(e => e.topic === 'ov.session.flushed');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.sessionId, 'sess-9');
  assert.equal(ev[0].payload.ok, true);
  assert.equal(svc.status().counters.observedFlush, 1);
});

// ── T14：冻结 runtime → 包装降级不抛，主路径无损伤 ──────────────────────────
test('T14: 冻结 runtime → wraps 全 false、不抛；remember 照常成功', async () => {
  const rt = Object.freeze(makeMockRuntime());
  const bus = makeMockBus();
  const { ctx } = makeMockCtx({ runtime: rt, services: bus.services });
  const svc = loadPlugin(ctx);
  const r = await svc.remember({ scope: 'manual', text: VALID_TEXT });
  assert.equal(r.ok, true, '主路径无损伤');
  const wraps = svc.status().observer.wraps;
  assert.equal(wraps.recallMessage, false, '冻结对象赋值失败 → 观测降级');
  assert.equal(bus.published.filter(e => e.topic.startsWith('ov.recall')).length, 0);
});

// ── T15：observe:false → 观测整体关闭 ────────────────────────────────────────
test('T15: config observe:false → 不注册钩子、不包装 runtime', async () => {
  const rt = makeMockRuntime();
  const bus = makeMockBus();
  const { ctx } = makeMockCtx({ runtime: rt, services: bus.services });
  const svc = loadPlugin(ctx, { observe: false });
  assert.equal(ctx.hooks.get('tools/post-execute'), undefined, '未注册工具钩子');
  assert.equal(svc.status().observer.enabled, false);
  assert.deepEqual(Object.values(svc.status().observer.wraps), [false, false, false]);
  // 写入主路径不受 observe 影响
  const r = await svc.remember({ scope: 'manual', text: VALID_TEXT });
  assert.equal(r.ok, true);
});

// ── 附加：导出的纯函数契约 ───────────────────────────────────────────────────
test('附加: isRetryableFailure 与 inject=[] 契约', () => {
  assert.deepEqual(inject, []);
  assert.equal(isRetryableFailure(null), true);
  assert.equal(isRetryableFailure({ ok: true }), false);
  assert.equal(isRetryableFailure({ ok: false, status: 502 }), true);
  assert.equal(isRetryableFailure({ ok: false, status: 404 }), false);
  assert.deepEqual(Object.keys(TOPIC_SUMMARIZERS).sort(), ['diagnosis.completed', 'dream.completed']);
});
