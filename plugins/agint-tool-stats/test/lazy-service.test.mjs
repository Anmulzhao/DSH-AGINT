// agint-tool-stats 懒取上游服务的回归测试（2026-10-21）
//
// 判据纪律（three-state-audit）：不测「我抄的逻辑」，真调生产导出的 lazyService。
// 每条都配阴性对照（放宽 ⇒ 变红）。
//
// ⛔ 背景（运行态取证）：重启后 tool-stats 落盘的 20 条记录里
//    deltaTokens 恒 null、tokenSource 19 条为 null —— 字段落了、值恒空，
//    表现是"接上了 tokenMeter"其实没接。根因是 `ctx.get('tokenMeter')`
//    在插件 apply 时求值，而上游服务注册与插件 apply 没有顺序保证。

import test from 'node:test';
import assert from 'node:assert/strict';
import { lazyService } from '../lib/index.js';

test('懒取：上游一开始不在 ⇒ 取到 null（不抛）', () => {
  const ctx = { get: () => undefined };
  assert.equal(lazyService(ctx, 'tokenMeter')(), null);
});

test('⛔ 懒取：上游晚于插件注册 ⇒ 之后能取到（不能是 apply 时的快照）', () => {
  let svc;
  const ctx = { get: (k) => (k === 'tokenMeter' ? svc : undefined) };
  const get = lazyService(ctx, 'tokenMeter');
  assert.equal(get(), null, '一开始上游不在');
  svc = { measure: () => ({ totalTokens: 42 }) };   // 上游随后注册
  assert.ok(get(), '上游出现后必须能取到');
  assert.equal(get().measure().totalTokens, 42);
});

test('⛔ 懒取：上游消失后必须取到 null（不能拿旧值硬撑）', () => {
  let svc = { measure: () => ({ totalTokens: 1 }) };
  const ctx = { get: (k) => (k === 'tokenMeter' ? svc : undefined) };
  const get = lazyService(ctx, 'tokenMeter');
  assert.ok(get());
  svc = undefined;
  assert.equal(get(), null, '上游消失后必须探到 null');
});

test('懒取：ctx 异常（get 抛错 / 没有 get）⇒ 返回 null，不炸', () => {
  const boom = { get: () => { throw new Error('ctx exploded'); } };
  assert.equal(lazyService(boom, 'tokenMeter')(), null);
  assert.equal(lazyService({}, 'tokenMeter')(), null);
  assert.equal(lazyService(null, 'tokenMeter')(), null);
});

test('懒取：只取指定键（不误取别的服务）', () => {
  const seen = [];
  const ctx = { get: (k) => { seen.push(k); return k === 'x' ? { ok: true } : null; } };
  lazyService(ctx, 'x')();
  assert.deepEqual(seen, ['x']);
});
