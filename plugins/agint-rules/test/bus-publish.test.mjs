/**
 * agint-rules — rules.changed 发布接线测试（2026-10-09，工作项 B1）
 * Run: node --test plugins/agint-rules/test/bus-publish.test.mjs
 *
 * 背景：agint-rules 长期对事件总线零感知（查 E' 的 UNWIRED 头名），
 *   而它的规则集被 agint-evolve:234 / agint-metrics:47 以 `ctx.get('agint.rules')`
 *   硬编码直连消费 —— deny 门禁增删对下游不可见，只能等被调用时现场拉快照。
 *   取证与判据见 proposals/agint-eventbus-unwired-plugins-20261009.md。
 *
 * 本测试锁死三组契约：
 *   1. 发布侧 —— add / remove / setEnabled 每次真实变更发出一条 envelope；
 *   2. 直连红线 —— bus 缺席或 publish 抛错时，规则操作**照常成功**，不阻断；
 *   3. 探测形态 —— 分服务名与伞键两种注册形态都要能发（K63 回归防线：
      只查伞键会恒 undefined 并静默降级，那正是 mount.* 空转四个月的机制）。
 *
 * ⚠️ 不要写成「插件注册了服务就算通过」——那正是旧缺口能隐身的原因。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

function makeMockCtx({ bus } = {}) {
  const tables = new Map();
  const ctx = {
    storageDomain: {
      async open(spec) {
        return {
          name: spec.name,
          version: spec.version,
          table(name) {
            let t = tables.get(name);
            if (!t) { t = new Map(); tables.set(name, t); }
            return {
              get: (id) => t.get(id) ?? null,
              put: async (id, value) => { t.set(id, value); return true; },
              delete: async (id) => t.delete(id),
              entries: () => [...t.entries()],
            };
          },
          async close() {},
        };
      },
    },
    _effects: [],
    _provides: new Map(),
    _warns: [],
    logger: { warn: (msg, extra) => { ctx._warns.push({ msg, extra }); } },
    effect(fn) { this._effects.push(fn()); },
    provide(k, v) { this._provides.set(k, v); },
    get(k) { return this._provides.get(k) ?? null; },
    on() {},
    setInterval() { return { dispose() {} }; },
  };
  // bus 可以是函数（分服务名形态），也可以是 {publish} 对象（伞键形态）
  if (typeof bus === 'function') ctx.provide('agint.eventBus.publish', bus);
  else if (bus) ctx.provide('agint.eventBus', bus);
  return ctx;
}

function makeRules(bus) {
  const ctx = makeMockCtx({ bus });
  apply(ctx, {});
  return { ctx, rules: ctx.get('agint.rules') };
}

/** 收集器：既能当 publish 用，也能事后查发了什么 */
function recorder() {
  const envelopes = [];
  const fn = async (env) => {
    envelopes.push(env);
    return { envelopeId: 'env-1', deliveredTo: 0, deadLettered: 0 };
  };
  fn.envelopes = envelopes;
  return fn;
}

const RULE = { id: 'r-test-1', tool: 'deploy', pattern: 'prod', action: 'deny', reason: '生产禁直连' };

// ───────────────────────── 1. 发布侧 ─────────────────────────

test('add() 发布 rules.changed，envelope 符合订阅方契约', async () => {
  const rec = recorder();
  const { rules } = makeRules(rec);

  const rule = await rules.add(RULE);

  assert.equal(rec.envelopes.length, 1, `add() 应发恰好 1 条，实际 ${rec.envelopes.length}`);
  const env = rec.envelopes[0];
  assert.equal(env.topic, 'rules.changed');
  assert.equal(env.version, 1);
  assert.equal(env.source, 'agint-rules');
  // 订阅方要能据此判断「变了什么」——载荷缺字段等于没接
  assert.equal(env.payload.change, 'added');
  assert.equal(env.payload.ruleId, rule.id);
  assert.equal(env.payload.tool, rule.tool);
  assert.equal(env.payload.action, rule.action);
  assert.equal(env.payload.level, rule.level);
});

test('remove() 只在真的删掉时发布；删不存在的规则不发', async () => {
  const rec = recorder();
  const { rules } = makeRules(rec);
  await rules.add(RULE);
  rec.envelopes.length = 0;

  await rules.remove('r-not-there');
  assert.equal(rec.envelopes.length, 0, '删除不存在的规则不该产生事件（否则订阅方会收到假变更）');

  await rules.remove(RULE.id);
  assert.equal(rec.envelopes.length, 1);
  assert.equal(rec.envelopes[0].payload.change, 'removed');
  assert.equal(rec.envelopes[0].payload.ruleId, RULE.id);
});

test('setEnabled() 发布，且区分启用与停用', async () => {
  const rec = recorder();
  const { rules } = makeRules(rec);
  await rules.add(RULE);
  rec.envelopes.length = 0;

  await rules.setEnabled(RULE.id, false);
  assert.equal(rec.envelopes[0].payload.change, 'disabled');
  assert.equal(rec.envelopes[0].payload.enabled, false);

  rec.envelopes.length = 0;
  await rules.setEnabled(RULE.id, true);
  assert.equal(rec.envelopes[0].payload.change, 'enabled');
  assert.equal(rec.envelopes[0].payload.enabled, true);
});

test('setEnabled() 对不存在的规则不发事件', async () => {
  const rec = recorder();
  const { rules } = makeRules(rec);
  await rules.setEnabled('r-ghost', true);
  assert.equal(rec.envelopes.length, 0);
});

// ───────────────────── 2. 直连红线（不得阻断业务） ─────────────────────

test('红线：bus 完全缺席时，规则操作照常成功', async () => {
  const { rules } = makeRules(null);
  const rule = await rules.add(RULE);
  assert.equal(rule.id, RULE.id, 'bus 缺席不该让 add 失败');
  assert.equal((await rules.list()).length, 1, '规则必须真的落库');
  assert.equal(await rules.remove(RULE.id), true, 'bus 缺席不该让 remove 失败');
});

test('红线：publish 抛错时，规则操作照常成功（只告警不冒泡）', async () => {
  const { ctx, rules } = makeRules(async () => { throw new Error('bus exploded'); });
  const rule = await rules.add(RULE);
  assert.equal(rule.id, RULE.id, 'publish 抛错不该让 add 失败');
  assert.equal((await rules.list()).length, 1);
  assert.ok(
    ctx._warns.some((w) => String(w.msg).includes('rules.changed')),
    'publish 失败必须留下告警，否则静默失败无人知晓（K64 教训）',
  );
});

// ───────────── 3. 探测形态（K63 回归防线） ─────────────

test('伞键形态（agint.eventBus.publish 挂在对象上）也能发布', async () => {
  // agint-event-bus 用 spec.provides 注册的是三个**分服务名**，没有伞键；
  // 但部分 host 变体是伞键。mount 当年只查伞键 ⇒ 恒 undefined ⇒ 静默降级 ⇒
  // mount.* 生产数据恒 0（gap 文档 §6.4）。这里钉死两种形态都要能发。
  const rec = recorder();
  const { rules } = makeRules({ publish: rec });
  await rules.add(RULE);
  assert.equal(rec.envelopes.length, 1, '伞键形态下没发布 —— 探测形态写窄了');
  assert.equal(rec.envelopes[0].topic, 'rules.changed');
});

test('探测路径上的三种异常形态都不应让插件崩掉或阻断规则操作', async () => {
  // 探测是**每次变更时**才走的软依赖，不是启动期一次性解析：
  //   ① ctx.get 抛错（host 服务表异常）
  //   ② 伞键对象存在但没有 publish（别的插件占了这个名字）
  //   ③ 三个形态全取不到（bus 尚未 apply，apply 顺序不保证）
  // 三种都必须降级为「不发事件」，而不是把 add/remove 一起带崩。
  const ctxThrowing = makeMockCtx();
  const getReal = ctxThrowing.get.bind(ctxThrowing);
  // 只让总线相关的取服务炸（host 服务表局部异常），其余服务仍要能取到 ——
  // 全都抛的话连 agint.rules 都拿不到，那测的是 mock 而不是插件。
  ctxThrowing.get = (k) => {
    if (typeof k === 'string' && k.startsWith('agint.eventBus')) throw new Error('ctx.get exploded');
    return getReal(k);
  };
  assert.doesNotThrow(() => apply(ctxThrowing, {}), '① ctx.get 抛错不该让 apply 崩');
  const rulesThrowing = ctxThrowing.get('agint.rules');
  assert.ok(rulesThrowing, '① apply 后仍应提供 agint.rules');
  assert.equal((await rulesThrowing.add(RULE)).id, RULE.id, '① 规则操作不该被阻断');

  const { rules: rulesNoPublish } = makeRules({ notPublish: () => {} });
  assert.equal((await rulesNoPublish.add(RULE)).id, RULE.id, '② 伞键无 publish 时不该阻断');

  const { rules: rulesNoBus } = makeRules(null);
  assert.equal((await rulesNoBus.add(RULE)).id, RULE.id, '③ bus 完全缺席时不该阻断');
});
