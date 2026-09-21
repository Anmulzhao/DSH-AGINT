/**
 * agint-quality-sandbox — sandbox.passed / sandbox.failed 发布测试（A3 接线，2026-09-20）
 * Run: node --test plugins/agint-quality-sandbox/test/shadow-publish.test.mjs
 *
 * 背景：v0.6.3 把插件从 plugins/agint-quality/agint-quality-sandbox/ 剥离为顶层插件时，
 * publishSandboxEvent() 没跟着迁过来 → 订阅方 agint-diagnosis 从上线那天起一条都没收到。
 * 本测试锁死"接线后"的契约：runVerify 的每个出口都必须留下事件，
 * 且 payload 与 schemas/sandbox-{passed,failed}.schema.yaml 对齐。
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

/** confine 返回一个能直接跑的 argv，stdout 是 smoke 协议的 JSON */
function argvThatPrints(obj) {
  return [process.execPath, '-e', `process.stdout.write(JSON.stringify(${JSON.stringify(obj)}))`];
}

async function mount(ctx) {
  const mod = await import(PLUGIN_PATH);
  mod.apply(ctx, { timeoutMs: 10_000 });
  return ctx._providers['agint.qualitySandbox'];
}

test('runVerify 通过 → 发布 sandbox.passed，payload 带 checks', async () => {
  const envelopes = [];
  const ctx = makeMockCtx({
    publish: async (env) => { envelopes.push(env); return { envelopeId: 'e1', deliveredTo: 1 }; },
    confineImpl: () => ({
      argv: argvThatPrints({ ok: true, checks: [{ name: 'import', ok: true, detail: 'ok' }] }),
    }),
  });
  const sandbox = await mount(ctx);
  const result = await sandbox.runVerify({ target: { path: process.cwd(), name: 'demo' } });

  assert.equal(result.ok, true, '直连返回值不受发布影响');
  assert.equal(envelopes.length, 1);
  const env = envelopes[0];
  assert.equal(env.topic, 'sandbox.passed');
  assert.equal(env.version, 1);
  assert.equal(env.source, 'agint-quality-sandbox');
  assert.equal(env.payload.mode, 'sandbox', 'mode 必须归一化到 schema enum');
  assert.equal(env.payload.target.name, 'demo');
  assert.equal(env.payload.checks[0].name, 'import');
  assert.equal(env.payload.reason, undefined, 'passed 事件不带 reason');
});

test('runVerify 失败 → 发布 sandbox.failed，payload 带 reason + failedChecks', async () => {
  const envelopes = [];
  const ctx = makeMockCtx({
    publish: async (env) => { envelopes.push(env); return { envelopeId: 'e2', deliveredTo: 1 }; },
    confineImpl: () => ({
      argv: argvThatPrints({
        ok: false,
        reason: 'smoke-failed',
        checks: [{ name: 'import', ok: true, detail: 'ok' }, { name: 'probe', ok: false, detail: 'boom' }],
      }),
    }),
  });
  const sandbox = await mount(ctx);
  const result = await sandbox.runVerify({ target: { path: process.cwd(), name: 'demo' } });

  assert.equal(result.ok, false);
  assert.equal(envelopes.length, 1);
  const env = envelopes[0];
  assert.equal(env.topic, 'sandbox.failed');
  assert.equal(env.payload.reason, 'smoke-failed', '订阅方 diagnosis 依赖 reason 做根因映射');
  assert.equal(env.payload.failedChecks.length, 1, '只取 ok=false 的子集');
  assert.equal(env.payload.failedChecks[0].name, 'probe');
});

test('runInMode 抛错（缺 target.path）→ 仍发一条 sandbox.failed，且异常继续向上抛', async () => {
  const envelopes = [];
  const ctx = makeMockCtx({
    publish: async (env) => { envelopes.push(env); return { envelopeId: 'e3', deliveredTo: 1 }; },
  });
  const sandbox = await mount(ctx);
  await assert.rejects(
    () => sandbox.runVerify({ target: { name: 'no-path' } }),
    /target\.path is required/,
    '异常必须继续抛给调用方，发布逻辑不得吞掉业务异常',
  );
  assert.equal(envelopes.length, 1, '异常出口也算一次失败，要留痕');
  assert.equal(envelopes[0].topic, 'sandbox.failed');
  assert.match(envelopes[0].payload.reason, /sandbox-run-threw/);
});

test('bus 不可用 → 不发事件、不抛错、返回值照常（软降级）', async () => {
  const ctx = makeMockCtx({
    confineImpl: () => ({ argv: argvThatPrints({ ok: true, checks: [] }) }),
  }); // 不注入 publish
  const sandbox = await mount(ctx);
  const result = await sandbox.runVerify({ target: { path: process.cwd(), name: 'demo' } });
  assert.equal(result.ok, true, 'bus 缺失不影响沙箱结果');
});
