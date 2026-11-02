/**
 * agint-curriculum — W3：`goal/*` 订阅与目标对齐观测面（2026-11-03）
 * Run: node --test plugins/agint-curriculum/test/goal-alignment.test.mjs
 *
 * 这个文件守两件事：
 *   1. 事件**只记账不改课程队列** —— 课程队列是持久事实，让一次目标编辑
 *      自动重排＝不可回滚的课程增删（理由写在 lib/index.js 的 W3 段）；
 *   2. `received:false`（链路没通电）与 `goalId:''`（通电了但宿主没带 goal）
 *      必须**不同形** —— 否则排障时「没接上」和「没有目标」长得一样。
 *
 * 阴性对照：把 revision 比较（迟到的旧事件丢弃）删掉，第 3 条必须红；
 *           把 goalId 缺失时写成 `String(p.goalId)`，第 4 条必须红。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../lib/index.js';

/** 假存储域（内存兜底），与其它 curriculum 测试同构 */
function fakeDomain() {
  const tables = new Map();
  const mk = () => {
    const m = new Map();
    return {
      put: async (k, v) => { if (v === undefined) m.delete(k); else m.set(k, v); },
      entries: () => [...m.entries()],
      size: m.size,
      del: async (k) => { m.delete(k); },
      _map: m,
    };
  };
  return { close: async () => {}, table: (n) => { if (!tables.has(n)) tables.set(n, mk()); return tables.get(n); } };
}

function makeBus() {
  const subs = [];
  return {
    subs,
    subscribe: (sub, handler) => subs.push({ sub, handler }),
    publish: async () => ({ accepted: true }),
    fire(topic, payload = {}) {
      for (const s of subs.filter((x) => x.sub?.topic === topic)) {
        s.handler({ topic, payload });
      }
    },
  };
}

async function mount({ withBus = true } = {}) {
  const bus = makeBus();
  const dom = fakeDomain();
  const provided = {};
  const ctx = {
    storageDomain: { open: async () => dom },
    get: (k) => ({ 'agint.eventBus.subscribe': bus.subscribe, 'agint.eventBus.publish': bus.publish }[k] ?? null),
    provide: (k, v) => { provided[k] = v; },
    effect: () => {},
  };
  if (!withBus) ctx.get = () => null;
  apply(ctx, {});
  await new Promise((r) => setTimeout(r, 30));
  return { ctx, bus, service: provided['agint.curriculum'], dom };
}

test('订阅两条 goal 主题（changed + activation-changed）', async () => {
  const { bus } = await mount();
  const topics = bus.subs.map((s) => s.sub?.topic).sort();
  assert.deepEqual(topics, [
    'input.signal.host.goal-activation-changed',
    'input.signal.host.goal-changed',
  ]);
});

test('goal/changed：记账 goalId / revision / activation，且不触发任何课程写入', async () => {
  const { bus, service, dom } = await mount();
  bus.fire('input.signal.host.goal-changed', {
    operation: 'update', goalId: 'g-1', revision: 3, activation: 'active',
  });
  const st = service.goalAlignment();
  assert.equal(st.received, true);
  assert.equal(st.goalId, 'g-1');
  assert.equal(st.revision, 3);
  assert.equal(st.activation, 'active');
  assert.ok(st.eventsSeen >= 1);

  // ⛔ 核心断言：课程队列一张表都不许被写
  for (const name of ['challenges', 'attempts', 'difficulty', 'audit_log']) {
    const t = dom.table(name);
    assert.equal(
      t._map.size,
      0,
      `${name} 必须仍是空的 —— 目标变更只许记账，不许自动重排课程（不可回滚）`,
    );
  }
});

test('迟到的旧 revision 被丢弃（防止乱序事件把对齐状态拉回去）', async () => {
  const { bus, service } = await mount();
  bus.fire('input.signal.host.goal-changed', { goalId: 'g-1', revision: 9 });
  bus.fire('input.signal.host.goal-changed', { goalId: 'g-1', revision: 4 }); // 迟到
  assert.equal(service.goalAlignment().revision, 9, '旧 revision 不许覆盖新状态');
  // 但 eventsSeen 要照常涨 —— 丢弃的是状态覆盖，不是观测
  assert.equal(service.goalAlignment().eventsSeen, 2);
});

test('received 与 goalId 是两个问题：没通电 vs 通电了没带 goal', async () => {
  const off = await mount({ withBus: false });
  const on = await mount();
  on.bus.fire('input.signal.host.goal-activation-changed', { sessionId: 's-1' }); // 宿主没带 goal

  assert.equal(off.service.goalAlignment().received, false, '总线不在 ⇒ received=false');
  assert.equal(on.service.goalAlignment().received, true, '收到过事件 ⇒ received=true');
  assert.equal(
    on.service.goalAlignment().goalId,
    '',
    '宿主没带 goal 时 goalId 记空串（而不是 undefined/null）—— 面板要判得出「带了但为空」',
  );
  assert.notEqual(
    off.service.goalAlignment().received,
    on.service.goalAlignment().received,
    '⛔ 这两种情况必须不同形，否则排障分不清',
  );
});

test('activation-changed 也参与同一口径（session 级事件同样更新对齐）', async () => {
  const { bus, service } = await mount();
  bus.fire('input.signal.host.goal-activation-changed', {
    sessionId: 'sess-9', goalId: 'g-2', revision: 1, activation: 'inactive',
  });
  const st = service.goalAlignment();
  assert.equal(st.sessionId, 'sess-9');
  assert.equal(st.goalId, 'g-2');
  assert.equal(st.activation, 'inactive');
});

test('无总线时纯降级：课程本体仍可用，不抛', async () => {
  const { service } = await mount({ withBus: false });
  assert.equal(service.goalAlignment().received, false);
  assert.equal(typeof service.probe, 'function', '降级后服务面必须完整');
  assert.equal(typeof service.generate, 'function');
});
