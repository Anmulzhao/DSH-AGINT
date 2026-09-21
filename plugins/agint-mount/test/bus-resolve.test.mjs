/**
 * agint-mount — event-bus 服务解析回归测试（A4 接线，2026-09-20）
 * Run: node --test plugins/agint-mount/test/bus-resolve.test.mjs
 *
 * 事故复盘：mountEventBusPublish 原来只查 `ctx.getService('agint.eventBus')`（伞键），
 * 但 agint-event-bus 注册的是**分服务名** agint.eventBus.publish / .subscribe / .inspect，
 * 伞键不存在 → publish 恒为 undefined → 10 处 mount.* 发布全部静默降级到 emitEvent，
 * 生产存储 0 条，且不报错、不告警、测试全绿（因为测试只断言不抛错）。
 *
 * 本测试锁死：三种形态任一可用都必须解析出 publish/subscribe。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBusPublish, resolveBusSubscribe } from '../lib/orchestrator.js';

test('分服务名形态（现役主路径）→ 解析出 publish', () => {
  const publish = async () => ({ envelopeId: 'x' });
  const ctx = { get: (k) => (k === 'agint.eventBus.publish' ? publish : undefined), getService: () => undefined };
  assert.equal(resolveBusPublish(ctx), publish, 'ctx.get("agint.eventBus.publish") 必须优先命中');
});

test('只有伞键形态 → 也能解析出 publish（且已 bind）', () => {
  const bus = { publish(_env) { return this.ok; }, ok: 42 };
  const ctx = { get: () => undefined, getService: (k) => (k === 'agint.eventBus' ? bus : undefined) };
  const fn = resolveBusPublish(ctx);
  assert.equal(typeof fn, 'function');
  assert.equal(fn(), 42, '从伞键取出的 publish 必须 bind，否则 this 丢失');
});

test('伞键挂在 ctx.get 上（部分 dispatcher bridge）→ 也能解析', () => {
  const bus = { publish: () => ({}) };
  const ctx = { get: (k) => (k === 'agint.eventBus' ? bus : undefined), getService: () => undefined };
  assert.equal(typeof resolveBusPublish(ctx), 'function');
});

test('bus 完全不可用 → 返回 null（软降级，由调用方走 emitEvent fallback）', () => {
  assert.equal(resolveBusPublish({}), null);
  assert.equal(resolveBusPublish({ get: () => undefined, getService: () => undefined }), null);
  assert.equal(resolveBusSubscribe({}), null);
});

test('ctx.get 抛错时不炸，继续试下一个形态', () => {
  const bus = { publish: () => ({}) };
  const ctx = {
    get: () => { throw new Error('boom'); },
    getService: (k) => (k === 'agint.eventBus' ? bus : undefined),
  };
  assert.equal(typeof resolveBusPublish(ctx), 'function', '第一个形态抛错应被吞掉并继续探测');
});

test('订阅侧同样能从分服务名解析（不再只认伞键）', () => {
  const subscribe = () => () => {};
  const ctx = { get: (k) => (k === 'agint.eventBus.subscribe' ? subscribe : undefined), getService: () => undefined };
  assert.equal(resolveBusSubscribe(ctx), subscribe);
});
