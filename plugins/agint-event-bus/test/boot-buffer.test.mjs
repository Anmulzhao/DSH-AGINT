/**
 * agint-event-bus —— 启动瞬间丢事件缺口的回归测试（2026-11-12）
 * Run: node --test plugins/agint-event-bus/test/boot-buffer.test.mjs
 *
 * 复现的现象（评估报告 §五，2026-11-11 生产实测）：
 *   15:29:36 启动，ring 内 skills-change published 13 / delivered 0 / subscribers []，
 *   而 events 表 15:29:36 之后该 topic 落盘 0 行。
 *
 * 根因：`apply()` 把 busCtx.tables 初始化成内存 stub，`storageDomain.open()` 是
 * 异步 .then() 才把 **整个对象替换** 成真实表；而 publish 已 provide、宿主事件桥
 * 已同步 attach ⇒ 启动瞬间发布的事件全写进 stub，替换时连同 stub 一起被丢弃。
 *
 * 本测试锁住修复后的四条行为：
 *   1) open 未完成时发布的事件，open 完成后**一定补刷落盘**（不丢）
 *   2) 零订阅者（subscribers []）的事件同样落盘 —— 「没投递」≠「没发生」
 *   3) publish 在补刷完成前不返回（不制造「看着成功其实没写」的假绿）
 *   4) open 失败时软降级：publish 不永久挂起，且事件仍可被 inspect 读到
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
import { disposeBus } from '../lib/bus.js';

/** 构造一个可控的 cordis ctx（provide/get/effect/on 全拦截，不挂真宿主） */
function makeCtx() {
  const services = new Map();
  const effects = [];
  const handlers = new Map();
  const ctx = {
    storageDomain: { open: () => ({ then: () => {} }) }, // 由各用例覆盖
    get: (k) => services.get(k),
    provide: (k, v) => { services.set(k, v); },
    effect: (fn) => { effects.push(fn); },
    on: (ev, h) => { handlers.set(ev, h); return () => handlers.delete(ev); },
  };
  return {
    ctx,
    services,
    handlers,
    cleanup() {
      for (const eff of effects) {
        try { const c = eff(); if (typeof c === 'function') c(); } catch { /* ignore */ }
      }
      effects.length = 0;
    },
  };
}

/** 真实存储域句柄：两张表共享 Map，模拟 dsh-storage-domain 的 table(name) */
function makeRealHandle() {
  const events = new Map();
  const deadletter = new Map();
  const table = (m) => ({
    get: async (id) => m.get(id) ?? null,
    put: async (id, v) => { m.set(id, v); },
    delete: async (id) => { m.delete(id); },
    entries: () => m.entries(),
    size: async () => m.size,
  });
  return {
    events,
    deadletter,
    handle: {
      table: (name) => (name === 'events' ? table(events) : table(deadletter)),
      close: () => {},
    },
  };
}

let active = [];
beforeEach(() => { disposeBus(); active = []; });
afterEach(() => {
  for (const c of active) c.cleanup();
  active = [];
  disposeBus();
});

test('启动期发布（open 未 resolve）→ open 完成后事件补刷落盘，零订阅者也一样', async () => {
  const env = makeCtx();
  active.push(env);
  const real = makeRealHandle();

  let resolveOpen;
  env.ctx.storageDomain.open = () => new Promise((r) => { resolveOpen = r; });
  apply(env.ctx, {});

  const publish = env.services.get('agint.eventBus.publish');
  assert.equal(typeof publish, 'function', 'publish 必须已 provide');

  // open 尚未完成：publish 不应在此之前返回（等待补刷）
  let settled = false;
  const pending = publish({
    topic: 'input.signal.host.skills-change', version: 1,
    source: 'test', payload: { hostEvent: 'skills/change' },
  }).then((r) => { settled = true; return r; });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false, 'open 未完成时 publish 必须等落盘，不得抢先返回');
  assert.equal(real.events.size, 0, '此刻真实表还没挂上');

  // open 完成 → 启动期写入被补刷
  resolveOpen(real.handle);
  const result = await pending;
  assert.equal(settled, true);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.deliveredTo, [], '零订阅者场景：没投递，但事件必须存在');

  // 补刷是异步的，等一拍再断言落盘
  await new Promise((r) => setImmediate(r));
  assert.equal(real.events.size, 1, '启动瞬间的事件必须落到真实 events 表（修复前恒为 0）');
  const [row] = [...real.events.values()];
  // 落盘形状有两种：完整版带顶层 topic，精简版只留 envelope（读侧 envelope 优先）。
  // 本测试只锁「事件真的落盘了」，不锁记录形状 —— 那是另一个改动面的契约。
  assert.equal(
    row.topic ?? row.envelope?.topic,
    'input.signal.host.skills-change',
  );
  assert.deepEqual(row.deliveries, {}, '零投递要如实落 {}，不能伪装成 DELIVERED');
});

test('多条启动期事件按发布顺序全部补刷，不丢不重', async () => {
  const env = makeCtx();
  active.push(env);
  const real = makeRealHandle();
  let resolveOpen;
  env.ctx.storageDomain.open = () => new Promise((r) => { resolveOpen = r; });
  apply(env.ctx, {});
  const publish = env.services.get('agint.eventBus.publish');

  const pending = [];
  for (let i = 0; i < 13; i += 1) {
    pending.push(publish({
      topic: 'input.signal.host.skills-change', version: 1,
      source: 'test', payload: { i },
    }));
  }
  resolveOpen(real.handle);
  await Promise.all(pending);
  await new Promise((r) => setImmediate(r));
  assert.equal(real.events.size, 13, '13 条启动期事件一条都不能丢（复现报告里的 published 13）');
});

test('open 失败 → publish 不永久挂起，且事件仍可在内存中查到（软降级可见）', async () => {
  const env = makeCtx();
  active.push(env);
  env.ctx.storageDomain.open = () => Promise.reject(new Error('EPERM: open failed'));
  apply(env.ctx, {});
  const publish = env.services.get('agint.eventBus.publish');

  // 给一个 200ms 上限：修复前若用「等待 ready」写法，这里会永久挂起
  const result = await Promise.race([
    publish({ topic: 'probe.boot', version: 1, source: 'test', payload: {} }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('publish 挂起超时')), 200)),
  ]);
  assert.equal(result.accepted, true, '降级不得让 publish 失败');

  const inspect = env.services.get('agint.eventBus.inspect');
  const entries = inspect({ topic: 'probe.boot', limit: 0 });
  assert.equal(entries.length, 1, '没落盘但「发生过」这件事必须仍可取证，不许彻底消失');
});

test('attach 之后的新写入直接走真实表（不再进暂存）', async () => {
  const env = makeCtx();
  active.push(env);
  const real = makeRealHandle();
  env.ctx.storageDomain.open = () => Promise.resolve(real.handle);
  apply(env.ctx, {});
  const publish = env.services.get('agint.eventBus.publish');
  await publish({ topic: 'probe.after', version: 1, source: 'test', payload: {} });
  await new Promise((r) => setImmediate(r));
  assert.equal(real.events.size, 1, '正常路径行为不变');
});
