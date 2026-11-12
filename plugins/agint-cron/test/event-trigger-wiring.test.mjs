/**
 * agint-cron 入口接线集成测试（2026-11-12，评估报告 §七 步骤 1）
 *
 * WHY：test/smoke.mjs 是**纯逻辑**测试，从不 import lib/index.js ⇒
 * `ctx.provide('agint.cron', cronService)` 与 ensureEventTriggerAttached()
 * 这段接线此前一次都没被真跑过。单测 event-trigger.test.mjs 只覆盖桥的
 * 纯逻辑，覆盖不了「服务键取没取到 / 订阅挂没挂上 / dispose 收不收得回」。
 *
 * 用最小 fake ctx 直接调 apply()：不挂 cordis、不连 3080、不碰 storages。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

function makeCtx({ bus = true } = {}) {
  const provided = new Map();
  const disposers = [];
  const subs = [];
  const offs = [];
  const services = bus
    ? {
      'agint.eventBus.subscribe': (sub, handler) => {
        subs.push({ sub, handler });
        return () => offs.push(sub.subscriber);
      },
      'agint.eventBus.inspect': () => [],
      'agint.eventBus.publish': async () => ({ accepted: true }),
    }
    : {};

  const ctx = {
    storageDomain: {
      open: () => Promise.resolve({
        table: () => ({
          // ⛔ entries() 返回 [key,value] 元组迭代器，不是数组
          entries: () => [][Symbol.iterator](),
          get: async () => null,
          put: async () => {},
          delete: async () => {},
          size: () => 0,
        }),
        close: async () => {},
      }),
    },
    // cordis effect：兼容「fn 返回 disposer」与「fn 自身即 disposer」两种写法
    effect: (fn) => {
      const d = fn();
      disposers.push(typeof d === 'function' ? d : fn);
    },
    setInterval: () => ({ dispose() {} }),
    get: (key) => services[key] ?? null,
    provide: (key, value) => { provided.set(key, value); },
  };
  return { ctx, provided, disposers, subs, offs };
}

const cleanup = (disposers) => {
  for (const d of disposers) { try { d(); } catch { /* ignore */ } }
};

test('总线可用：apply 后 agint.cron 提供 eventTrigger 面，且两条订阅真挂上', () => {
  const { ctx, provided, subs, disposers } = makeCtx({ bus: true });
  try {
    apply(ctx, {});
    const svc = provided.get('agint.cron');
    assert.ok(svc, 'agint.cron 必须 provide');
    const s = svc.eventTrigger.status();
    assert.equal(s.attached, true);
    assert.equal(s.subscribed, 2);
    assert.equal(s.cronRetained, true, '事件快路径不得删 cron');
    assert.deepEqual(
      subs.map((x) => x.sub.topics[0]),
      ['input.signal.host.skills-change', 'curator.run-completed'],
    );
    assert.ok(svc.list().length >= 27, 'cron job 表仍完整');
    assert.equal(typeof svc.runNow, 'function');
    assert.equal(typeof svc.health, 'function');
  } finally {
    cleanup(disposers);
  }
});

test('总线缺席：软降级 attached:false，cron 服务完整可用（兜底不丢）', () => {
  const { ctx, provided, disposers } = makeCtx({ bus: false });
  try {
    apply(ctx, {});
    const svc = provided.get('agint.cron');
    assert.ok(svc);
    const s = svc.eventTrigger.status();
    assert.equal(s.attached, false);
    assert.equal(s.cronRetained, true);
    assert.ok(s.reason.includes('cron 兜底照常'));
    assert.ok(svc.list().length >= 27);
    assert.equal(typeof svc.runNow, 'function');
  } finally {
    cleanup(disposers);
  }
});

test('真实事件经入口订阅入队：pending=true + 5s 去抖 timer 排上', () => {
  const { ctx, provided, subs, disposers } = makeCtx({ bus: true });
  try {
    apply(ctx, {});
    const svc = provided.get('agint.cron');
    const handler = subs.find(
      (x) => x.sub.topics.includes('input.signal.host.skills-change'),
    )?.handler;
    assert.equal(typeof handler, 'function', 'skills-change 必须有订阅者');

    handler({ topic: 'input.signal.host.skills-change', payload: { hostEvent: 'skills/change' } });
    const s = svc.eventTrigger.status();
    const c = s.triggers.find((t) => t.jobId === 'curator-weekly');
    assert.equal(c.pending, true);
    assert.equal(c.timer, true, '5s 去抖 timer 已排上');

    // dry-run 的 run-completed 不该排 evolve-review 的 timer
    const doneHandler = subs.find((x) => x.sub.topics.includes('curator.run-completed'))?.handler;
    doneHandler({ topic: 'curator.run-completed', payload: { dryRun: true } });
    const e = svc.eventTrigger.status().triggers.find((t) => t.jobId === 'evolve-review');
    assert.equal(e.pending, false);
  } finally {
    cleanup(disposers); // 取消挂起的 5s timer，避免测试进程被拖住
  }
});

test('dispose 收回两条订阅与挂起 timer，不留野订阅', () => {
  const { ctx, provided, subs, offs, disposers } = makeCtx({ bus: true });
  apply(ctx, {});
  const handler = subs.find(
    (x) => x.sub.topics.includes('input.signal.host.skills-change'),
  ).handler;
  handler({ topic: 'input.signal.host.skills-change', payload: {} });
  assert.equal(offs.length, 0);
  cleanup(disposers);
  assert.equal(offs.length, 2, '两条订阅各自 unsubscribe');
  const s = provided.get('agint.cron').eventTrigger.status();
  assert.equal(s.attached, false);
});
