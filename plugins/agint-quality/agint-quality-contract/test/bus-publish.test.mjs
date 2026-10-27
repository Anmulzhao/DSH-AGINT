/**
 * agint-quality-contract — quality.contract.violated 发布接线测试（2026-10-26）
 * Run: node --test plugins/agint-quality/agint-quality-contract/test/bus-publish.test.mjs
 *
 * 背景：本插件此前对事件总线零感知（check-wiring 查 E' 的 UNWIRED），
 *   而它是 agint-event-bus README 点名的 sync 边界三方之一。
 *
 * 为什么只发「违例」而不发「调参成功」：
 *   L1 参数被 policy 调整时 setConfig 已写 agint.memory 审计（那条通路是完整的）；
 *   真正黑洞在拒绝分支 —— validatePatch 不通过就 throw，**memory.write 根本没执行**，
 *   错误只随调用栈消失。而 AGENTS.md 明载「废除多签后 L0 没有事前审批」，
 *   运行时唯一守卫就是这个 validatePatch。⇒ 违例事件是安全审计信号。
 *
 * 本测试锁死三组契约：
 *   1. 违例必发 —— L0 字段被写时发一条 quality.contract.violated，载荷可归因；
 *   2. 不造事件 —— L1 合法调参不发（否则变成 setConfig 调用计数）；
 *   3. ⭐ 拒绝语义不变 —— 无论 bus 缺席还是 publish 抛错，throw 的仍是同一个
 *      err / code / violations。发布是 best-effort，**不得**软化或延后拒绝。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

function makeMockCtx({ bus } = {}) {
  const ctx = {
    _provides: new Map(),
    _warns: [],
    _logs: [],
    logger: {
      warn: (msg, extra) => { ctx._warns.push({ msg, extra }); },
      error: (msg) => { ctx._logs.push(msg); },
    },
    effect(fn) { fn(); },
    provide(k, v) { this._provides.set(k, v); },
    // agint.memory 故意返回 null：逼出「审计写入被跳过」的真实分支
    get(k) { return this._provides.get(k) ?? null; },
    on() {},
  };
  if (typeof bus === 'function') ctx.provide('agint.eventBus.publish', bus);
  else if (bus) ctx.provide('agint.eventBus', bus);
  return ctx;
}

function recorder() {
  const envelopes = [];
  const fn = async (env) => {
    envelopes.push(env);
    return { envelopeId: 'env-1', deliveredTo: 0, deadLettered: 0 };
  };
  fn.envelopes = envelopes;
  return fn;
}

function makeQuality(bus) {
  const ctx = makeMockCtx({ bus });
  apply(ctx, {});
  return { ctx, quality: ctx.get('agint.quality') };
}

// ─────────────────── 1. 违例必发 ───────────────────

test('写 L0 冻结字段时发 quality.contract.violated，载荷可归因', async () => {
  const rec = recorder();
  const { quality } = makeQuality(rec);

  await assert.rejects(
    () => quality.setConfig({ Decision: { kind: 'AUTO_DEPLOY' } }),
    (err) => {
      assert.equal(err.code, 'L0_FROZEN_VIOLATION');
      return true;
    },
  );

  assert.equal(rec.envelopes.length, 1, `违例应发恰好 1 条，实际 ${rec.envelopes.length}`);
  const env = rec.envelopes[0];
  assert.equal(env.topic, 'quality.contract.violated');
  assert.equal(env.version, 1);
  assert.equal(env.source, 'agint-quality-contract');
  // 谁试图改了什么 —— 少了这两项，事件就只是「有人试过」，无法追责到字段
  assert.deepEqual(env.payload.violations, ['Decision']);
  assert.deepEqual(env.payload.patchKeys, ['Decision']);
});

test('不落 patch 的值（避免把配置内容抄进事件存储）', async () => {
  const rec = recorder();
  const { quality } = makeQuality(rec);
  await assert.rejects(() => quality.setConfig({ HARM: { secret: 'SENSITIVE-VALUE' } }));
  const env = rec.envelopes[0];
  assert.ok(!JSON.stringify(env.payload).includes('SENSITIVE-VALUE'), 'patch 的值不该进事件体');
  assert.deepEqual(env.payload.patchKeys, ['HARM']);
});

// ─────────────────── 2. 不造事件 ───────────────────

test('L1 合法调参不发违例事件（否则变成 setConfig 调用计数）', async () => {
  const rec = recorder();
  const { quality } = makeQuality(rec);

  const next = await quality.setConfig({ thresholds: { autoDeploy: 0.85 } });
  assert.equal(next.thresholds.autoDeploy, 0.85, 'L1 调参必须真的生效');
  assert.equal(rec.envelopes.length, 0, '合法调参不该产生违例事件');
});

// ─────────────────── 3. ⭐ 拒绝语义不变 ───────────────────

test('红线：bus 缺席时仍然 throw 同一个 code + violations', async () => {
  const { quality } = makeQuality(null);
  await assert.rejects(
    () => quality.setConfig({ EvalResult: {} }),
    (err) => {
      assert.equal(err.code, 'L0_FROZEN_VIOLATION');
      assert.deepEqual(err.violations, ['EvalResult']);
      return true;
    },
  );
});

test('红线：publish 抛错时仍然 throw 同一个 code，且留下告警', async () => {
  const { ctx, quality } = makeQuality(async () => { throw new Error('bus exploded'); });
  await assert.rejects(
    () => quality.setConfig({ HARM: {} }),
    (err) => {
      // 发布失败绝不允许把拒绝软化成功
      assert.equal(err.code, 'L0_FROZEN_VIOLATION');
      assert.deepEqual(err.violations, ['HARM']);
      return true;
    },
  );
  assert.ok(
    ctx._warns.some((w) => String(w.msg).includes('contract.violated')),
    'publish 失败必须留下告警（K64：静默失败无人知晓）',
  );
});

// ───────────── 4. 探测形态（K63 回归防线） ─────────────

test('伞键形态（agint.eventBus.publish 挂在对象上）也能发布', async () => {
  const rec = recorder();
  const { quality } = makeQuality({ publish: rec });
  await assert.rejects(() => quality.setConfig({ DecisionKind: 'x' }));
  assert.equal(rec.envelopes.length, 1, '伞键形态下没发布 —— 探测形态写窄了');
  assert.equal(rec.envelopes[0].topic, 'quality.contract.violated');
});
