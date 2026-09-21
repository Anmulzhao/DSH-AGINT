/**
 * agint-quality-sandbox — runSmoke 入口的影子发布回归测试（2026-09-21）
 * Run: node --test plugins/agint-quality-sandbox/test/runSmoke-publish.test.mjs
 *
 * ⭐ 为什么单独为 runSmoke 建测试：
 *   A3 接线（2026-09-20）只把 publishSandboxEvent 包进了 **新入口 runVerify / runExplore**，
 *   漏了**被上游沿用的旧入口 runSmoke**。全仓调用分布（grep 实证）：
 *     agint-mount/lib/orchestrator.js:308          → runVerify  ✅
 *     agint-mutator/lib/index.js:596               → runSmoke   ❌（改插件的日常路径）
 *     agint-skill-autocreate/lib/evaluator.js:108  → runSmoke   ❌（生成技能路径）
 *   ⇒ 高频路径沙箱真跑了也不发事件，`sandbox.*` 生产恒 0。
 *
 * 本测试锁死：**三个入口必须行为一致**（同一个 withPublish 包装）。
 * 老的 shadow-publish.test.mjs 只覆盖 runVerify —— 这正是缺陷溜过去的原因。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = pathToFileURL(resolve(__dirname, '../lib/index.js')).href;

function makeMockCtx({ publish, confineImpl } = {}) {
  const services = {};
  const ctx = {
    _effects: [],
    _providers: {},
    effect: (fn) => { ctx._effects.push(fn); },
    get: (name) => services[name],
    provide: (name, val) => { ctx._providers[name] = val; },
    on: () => {},
    register: () => {},
    services,
  };
  if (publish) services['agint.eventBus.publish'] = publish;
  if (confineImpl) services['sandbox'] = { confine: confineImpl };
  return ctx;
}

function argvThatPrints(obj) {
  return [process.execPath, '-e', `process.stdout.write(JSON.stringify(${JSON.stringify(obj)}))`];
}

async function mount(ctx) {
  const mod = await import(PLUGIN_PATH);
  mod.apply(ctx, { timeoutMs: 10_000 });
  return ctx._providers['agint.qualitySandbox'];
}

test('⭐ runSmoke 通过 → 必须发布 sandbox.passed（漏接线回归）', async () => {
  const envelopes = [];
  const ctx = makeMockCtx({
    publish: async (env) => { envelopes.push(env); return { envelopeId: 's1', deliveredTo: 1 }; },
    confineImpl: () => ({
      argv: argvThatPrints({ ok: true, checks: [{ name: 'plugin-exists', ok: true, detail: 'ok' }] }),
    }),
  });
  const sandbox = await mount(ctx);
  const result = await sandbox.runSmoke({ target: { path: process.cwd(), name: 'demo' } });

  assert.equal(result.ok, true, 'runSmoke 返回值不受发布影响');
  assert.equal(envelopes.length, 1, '⭐ runSmoke 也必须发事件（此前恒 0 的缺陷）');
  const env = envelopes[0];
  assert.equal(env.topic, 'sandbox.passed');
  assert.equal(env.source, 'agint-quality-sandbox');
  assert.equal(env.payload.mode, 'sandbox', 'mode 必须归一化到 schema enum');
  assert.equal(env.payload.target.name, 'demo');
});

test('⭐ runSmoke 失败 → 必须发布 sandbox.failed，payload 带 reason', async () => {
  const envelopes = [];
  const ctx = makeMockCtx({
    publish: async (env) => { envelopes.push(env); return { envelopeId: 's2', deliveredTo: 1 }; },
    confineImpl: () => ({
      argv: argvThatPrints({
        ok: false,
        reason: 'smoke-failed',
        checks: [{ name: 'plugin-exists', ok: true, detail: 'ok' }, { name: 'exports', ok: false, detail: 'missing apply' }],
      }),
    }),
  });
  const sandbox = await mount(ctx);
  const result = await sandbox.runSmoke({ target: { path: process.cwd(), name: 'demo' } });

  assert.equal(result.ok, false);
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].topic, 'sandbox.failed');
  assert.equal(envelopes[0].payload.reason, 'smoke-failed');
  assert.equal(envelopes[0].payload.failedChecks[0].name, 'exports');
});

test('runSmoke 抛错（缺 target.path）→ 事件留痕 + 异常继续向上抛', async () => {
  const envelopes = [];
  const ctx = makeMockCtx({
    publish: async (env) => { envelopes.push(env); return { envelopeId: 's3', deliveredTo: 1 }; },
  });
  const sandbox = await mount(ctx);
  await assert.rejects(
    () => sandbox.runSmoke({ target: { name: 'no-path' } }),
    /target\.path is required/,
    'FROZEN Service 契约：异常语义必须与包装前完全一致',
  );
  assert.equal(envelopes.length, 1, '异常出口也要留痕');
  assert.equal(envelopes[0].topic, 'sandbox.failed');
  assert.match(envelopes[0].payload.reason, /sandbox-run-threw/);
});

test('runSmoke 在 bus 不可用时：不发事件、不抛错、返回值照常（软降级）', async () => {
  const ctx = makeMockCtx({
    confineImpl: () => ({ argv: argvThatPrints({ ok: true, checks: [] }) }),
  });
  const sandbox = await mount(ctx);
  const result = await sandbox.runSmoke({ target: { path: process.cwd(), name: 'demo' } });
  assert.equal(result.ok, true, 'bus 缺失不得影响 runSmoke 结果');
});

test('⭐ 入口一致性不变量：runVerify / runSmoke 对同一输入发出同 topic 事件', async () => {
  const mk = async (method) => {
    const envelopes = [];
    const ctx = makeMockCtx({
      publish: async (env) => { envelopes.push(env); return { envelopeId: 'x', deliveredTo: 1 }; },
      confineImpl: () => ({ argv: argvThatPrints({ ok: true, checks: [] }) }),
    });
    const sandbox = await mount(ctx);
    await sandbox[method]({ target: { path: process.cwd(), name: 'demo' } });
    return envelopes;
  };
  const a = await mk('runVerify');
  const b = await mk('runSmoke');
  assert.equal(a.length, 1, 'runVerify 发 1 条');
  assert.equal(b.length, 1, 'runSmoke 发 1 条');
  assert.equal(a[0].topic, b[0].topic, '两个入口在同等输入下必须发同一 topic');
});
