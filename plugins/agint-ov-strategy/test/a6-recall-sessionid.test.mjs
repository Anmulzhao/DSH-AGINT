#!/usr/bin/env node
// agint-ov-strategy / A6 召回 sessionId 埋点 unit test
//
// A6（2026-10-03）：`ov.recall.checked` 载荷补 sessionId。
//
// 为什么需要：一条召回观测不指向任何会话时，检索质量分析只能看全局比率 ——
// 「命中了 60%」这个数字既不能定位到哪次会话差，也不能与 flush / profile
// 的会话级观测对齐。补上身份后才能按会话聚合。
//
// ⛔ 验收纪律：本次只做**载荷补字段**这一件事。检索质量半侧的判据、
// 聚合口径、消费方都不在本项范围内（路线图原文已明写「outcome 半侧仍阻塞，
// 别当完成」）。本文件**不**宣称解锁了任何分析能力。

import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

// ── mock（照抄 smoke.mjs 的形状，不自造）────────────────────────────────
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

function makeMockBus() {
  const published = [];
  const handlers = [];
  return {
    published,
    services: {
      'agint.eventBus.publish': async (envelope) => { published.push(envelope); return { accepted: true }; },
      'agint.eventBus.subscribe': (sub, handler) => {
        handlers.push({ topics: sub.topics, handler, mode: sub.mode });
        return () => {};
      },
    },
  };
}

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
    // ⛔ effect 不立即执行 fn —— smoke.mjs 的 mock 就是纯收集。
    //   第一版写成 `effects.push(fn); fn();`，等于在 apply 里提前跑副作用，
    //   与真实 cordis 的effect 语义不同（生命周期不同 ⇒ 挂载时机断言会失真）。
    effect: (fn) => { effects.push(fn); },
    on: (event, handler) => {
      if (!hooks.has(event)) hooks.set(event, []);
      hooks.get(event).push(handler);
      return () => {};
    },
  };
  // loadPlugin 依赖 ctx.provides —— 第一版把它挂在返回值上而没挂到 ctx 上，
  // 于是 apply() 之后读 ctx.provides.get(...) 直接 TypeError（10 条用例全红）。
  ctx.provides = provides;
  ctx.effects = effects;
  ctx.hooks = hooks;
  return { ctx, provides, effects, hooks };
}

function loadPlugin(ctx, config) {
  apply(ctx, config);
  return ctx.provides.get('agint.ovStrategy');
}

/** 跑一次被包装的 recallMessage，返回发出的 ov.recall.checked 事件。 */
async function recallOnce(agentArg, messages = [{ content: 'q' }], recallResult = undefined) {
  const rt = makeMockRuntime();
  if (recallResult !== undefined) rt.recallResult = recallResult;
  rt.recallMessage = async (agent, msgs) => rt.recallResult;
  const bus = makeMockBus();
  const { ctx } = makeMockCtx({ runtime: rt, services: bus.services });
  loadPlugin(ctx);
  await rt.recallMessage(agentArg, messages);
  await flush();
  const evs = bus.published.filter((e) => e.topic === 'ov.recall.checked');
  return { evs, last: evs[evs.length - 1], rt, bus };
}

// ── ① sessionId 进了载荷 ────────────────────────────────────────────

test('A6: ov.recall.checked 载荷含 sessionId（取自 args[0].id）', async () => {
  const r = await recallOnce({ id: 'sess-42' });
  assert.equal(r.evs.length, 1);
  assert.equal(r.last.payload.sessionId, 'sess-42');
});

test('A6: 命中与未命中都带 sessionId（「查了但 0 命中」是回溯需要的事实）', async () => {
  const hit = await recallOnce({ id: 's-hit' }, [{ content: 'q' }], { form: 'recall', content: 'x' });
  const miss = await recallOnce({ id: 's-miss' }, [{ content: 'q' }], null);
  assert.equal(hit.last.payload.sessionId, 's-hit');
  assert.equal(hit.last.payload.injected, true);
  assert.equal(miss.last.payload.sessionId, 's-miss');
  assert.equal(miss.last.payload.injected, false);
});

test('A6: 出错时也带 sessionId（失败的召回同样要能定位到会话）', async () => {
  const rt = makeMockRuntime();
  rt.recallMessage = async () => { throw new Error('viking timeout'); };
  const bus = makeMockBus();
  const { ctx } = makeMockCtx({ runtime: rt, services: bus.services });
  loadPlugin(ctx);
  await assert.rejects(() => rt.recallMessage({ id: 's-err' }, [{ content: 'q' }]));
  await flush();
  const ev = bus.published.filter((e) => e.topic === 'ov.recall.checked')[0];
  assert.ok(ev, '出错也要镜像 —— 否则「静默失败的召回」在观测里看不见');
  assert.equal(ev.payload.sessionId, 's-err');
  assert.equal(ev.payload.injected, false);
  assert.match(ev.payload.error, /viking timeout/);
});

// ── ② 身份来源与 ov.session.flushed 同源（这是 A6 的核心判据）─────────

test('A6: recall 与 flush 读到的是同一个 id（同一身份，不是两套推断）', async () => {
  const rt = makeMockRuntime();
  rt.recallMessage = async () => rt.recallResult;
  rt.flush = async () => {};
  const bus = makeMockBus();
  const { ctx } = makeMockCtx({ runtime: rt, services: bus.services });
  loadPlugin(ctx);

  await rt.recallMessage({ id: 'sess-same' }, [{ content: 'q' }]);
  await rt.flush({ id: 'sess-same' });
  await flush();

  const recallEv = bus.published.filter((e) => e.topic === 'ov.recall.checked')[0];
  const flushEv = bus.published.filter((e) => e.topic === 'ov.session.flushed')[0];
  assert.equal(recallEv.payload.sessionId, flushEv.payload.sessionId,
    '两个事件的会话身份必须能对上，否则按会话join 出来的数据全是错的');
});

test('A6: sessionId 字段位置与 ov.session.flushed 一致（payload.sessionId）', async () => {
  const r = await recallOnce({ id: 's1' });
  assert.ok('sessionId' in r.last.payload, '必须在 payload 里，不能塞在别处');
  const flushLike = { payload: { sessionId: 'x' } };
  assert.deepEqual(Object.keys(r.last.payload).filter((k) => k === 'sessionId'),
    Object.keys(flushLike.payload).filter((k) => k === 'sessionId'));
});

// ── ③ 拿不到就报 null，绝不猜 ────────────────────────────────────────

test('A6: 无会话对象 → sessionId=null（不拿消息内容去猜会话）', async () => {
  const r = await recallOnce({});
  assert.equal(r.last.payload.sessionId, null);
});

test('A6: 首参整个缺失 → sessionId=null 且不抛', async () => {
  const rt = makeMockRuntime();
  rt.recallMessage = async () => rt.recallResult;
  const bus = makeMockBus();
  const { ctx } = makeMockCtx({ runtime: rt, services: bus.services });
  loadPlugin(ctx);
  await rt.recallMessage(undefined, [{ content: 'q' }]);
  await flush();
  const ev = bus.published.filter((e) => e.topic === 'ov.recall.checked')[0];
  assert.equal(ev.payload.sessionId, null);
});

test('A6: 冻结 runtime → 观测缺席，主路径无损伤（既有T14 不被破坏）', async () => {
  const rt = Object.freeze(makeMockRuntime());
  const bus = makeMockBus();
  const { ctx } = makeMockCtx({ runtime: rt, services: bus.services });
  const svc = loadPlugin(ctx);
  assert.equal(svc.status().observer.wraps.recallMessage, false);
  // 不抛就是全部要求
});

// ── ④ 既有字段一个不少 ──────────────────────────────────────────────

test('A6: 既有载荷字段全部保留（纯加法，不得改动老字段）', async () => {
  const r = await recallOnce({ id: 's1' }, [{ content: '上次为什么失败' }], { form: 'recall', content: 'y'.repeat(30) });
  const p = r.last.payload;
  for (const k of ['injected', 'querySize', 'blockSize', 'error', 'sessionId']) {
    assert.ok(k in p, `缺字段 ${k}`);
  }
  assert.equal(p.querySize, '上次为什么失败'.length);
  assert.equal(p.blockSize, JSON.stringify({ form: 'recall', content: 'y'.repeat(30) }).length);
  assert.equal(p.error, null);
});

test('A6: 观测计数器照常累加', async () => {
  const rt = makeMockRuntime();
  rt.recallMessage = async () => rt.recallResult;
  const bus = makeMockBus();
  const { ctx } = makeMockCtx({ runtime: rt, services: bus.services });
  const svc = loadPlugin(ctx);
  await rt.recallMessage({ id: 's' }, [{ content: 'q' }]);
  await rt.recallMessage({ id: 's' }, [{ content: 'q' }]);
  await flush();
  assert.equal(svc.status().counters.observedRecall, 2);
});

// ── ⑤ C3（2026-10-19）：hitUris —— 召回身份可 join ──────────────────────
// 路线图 2.1「检索质量半侧」此前只有 {injected, blockSize}：知道"注入了"，
// 不知道"注入了哪几条记忆" ⇒ 无法把结果回填到具体记忆条目。
// 上游形状（recall-core.mjs:396）：每条 hit 渲染 `- [kind score%] viking://…`。

test('C3: 命中时载荷带 hitUris（真实渲染形状的 viking:// URI）', async () => {
  const rendered = [
    '- [memory 82%] viking://user/anmul/memories/preferences/login-port.md',
    '- [memory 82%] 登录 NAS 用 2222 端口',
    '- [skill 40%] viking://agent/skills/github-push/SKILL.md',
  ].join('\n');
  const r = await recallOnce({ id: 's1' }, [{ content: 'q' }], { form: 'recall', content: rendered });
  assert.deepEqual(r.last.payload.hitUris, [
    'viking://user/anmul/memories/preferences/login-port.md',
    'viking://agent/skills/github-push/SKILL.md',
  ]);
});

test('C3: 未注入（result=null）⇒ hitUris=[] 而不是缺字段（0 命中是事实，要可聚合）', async () => {
  const r = await recallOnce({ id: 's-miss' }, [{ content: 'q' }], null);
  assert.deepEqual(r.last.payload.hitUris, []);
});

test('C3: 出错 ⇒ hitUris=[]（错误路径不猜身份）', async () => {
  const rt = makeMockRuntime();
  rt.recallMessage = async () => { throw new Error('viking down'); };
  const bus = makeMockBus();
  const { ctx } = makeMockCtx({ runtime: rt, services: bus.services });
  loadPlugin(ctx);
  await assert.rejects(() => rt.recallMessage({ id: 's-e' }, [{ content: 'q' }]));
  await flush();
  const ev = bus.published.filter((e) => e.topic === 'ov.recall.checked')[0];
  assert.deepEqual(ev.payload.hitUris, []);
});

test('C3: 去重 + 上限 8（畸形结果不得撑爆事件载荷）', async () => {
  const many = [];
  for (let i = 0; i < 12; i++) many.push(`- [memory 50%] viking://u/x${i % 6}`);
  const r = await recallOnce({ id: 's1' }, [{ content: 'q' }], { form: 'recall', content: many.join('\n') });
  assert.equal(r.last.payload.hitUris.length, 6, '12 行但只有 6 个不同 URI ⇒ 去重生效');
  const r2 = await recallOnce({ id: 's2' }, [{ content: 'q' }], { form: 'recall', content: Array.from({ length: 20 }, (_, i) => `- [m] viking://u/${i}`).join('\n') });
  assert.equal(r2.last.payload.hitUris.length, 8, '20 个不同 URI ⇒ 截到上限 8');
});

test('C3: 正文不外泄 —— hitUris 只含 URI，不含 hit 文本内容', async () => {
  const rendered = '- [memory 82%] viking://u/p.md\n- [memory 82%] 密码是 hunter2';
  const r = await recallOnce({ id: 's1' }, [{ content: 'q' }], { form: 'recall', content: rendered });
  const joined = r.last.payload.hitUris.join('|');
  assert.ok(!joined.includes('hunter2'), 'URI 列表里不得混进正文');
  assert.deepEqual(r.last.payload.hitUris, ['viking://u/p.md']);
});