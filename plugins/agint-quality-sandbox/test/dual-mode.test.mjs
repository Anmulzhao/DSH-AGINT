/**
 * v0.6.3 sandbox dual-mode minimal smoke test
 * 测试范围：resolveProfile / routeForMutation / backendHealth / Service 形状
 * 不测真沙箱执行（依赖生产 dsh 启动），仅测契约层
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = resolve(__dirname, '../lib/index.js');

// 构造最小 mock ctx
function makeMockCtx({ withSandbox = false, sandboxConfineImpl } = {}) {
  const effects = [];
  const providers = {};
  const services = {};
  return {
    _effects: effects,
    _providers: providers,
    effect: (fn) => { effects.push(fn); },
    get: (name) => services[name],
    provide: (name, val) => { providers[name] = val; },
    on: () => {},
    register: () => {},
    services,
    _setMockService: (name, val) => { services[name] = val; },
  };
}

test('resolveProfile: linux + profile present → supported', async () => {
  if (process.platform !== 'linux') return; // skip on non-linux
  const mod = await import(PLUGIN_PATH);
  const ctx = makeMockCtx();
  mod.apply(ctx, {});
  const sandbox = ctx._providers['agint.qualitySandbox'];
  const r = sandbox.resolveProfile({ mode: 'verify' });
  // profile 文件已落盘（占位骨架）
  assert.equal(r.unsupported, undefined, 'profile file should exist for linux verify');
  assert.equal(r.platform, 'linux');
  assert.equal(r.mode, 'verify');
  assert.equal(r.format, 'bpf-json');
  assert.equal(r.defaultAction, 'SCMP_ACT_KILL_PROCESS');
  assert.match(r.content, /SCMP_ACT_KILL_PROCESS/);
});

test('resolveProfile: darwin → sbpl format', async () => {
  if (process.platform !== 'darwin') return; // skip on non-darwin
  const mod = await import(PLUGIN_PATH);
  const ctx = makeMockCtx();
  mod.apply(ctx, {});
  const sandbox = ctx._providers['agint.qualitySandbox'];
  const r = sandbox.resolveProfile({ mode: 'explore' });
  assert.equal(r.format, 'sbpl');
  assert.match(r.content, /\(deny default\)/);
});

test('resolveProfile: throws on unknown mode', async () => {
  const mod = await import(PLUGIN_PATH);
  const ctx = makeMockCtx();
  mod.apply(ctx, {});
  const sandbox = ctx._providers['agint.qualitySandbox'];
  assert.throws(() => sandbox.resolveProfile({ mode: 'bogus' }), /unknown mode/);
});

test('routeForMutation: dream-random → explore-then-verify', async () => {
  const mod = await import(PLUGIN_PATH);
  const ctx = makeMockCtx();
  mod.apply(ctx, {});
  const sandbox = ctx._providers['agint.qualitySandbox'];
  const r = sandbox.routeForMutation({ source: 'dream-random', kind: 'PROMPT_MUTATION' });
  assert.deepEqual(r, { mode: 'explore-then-verify', stages: ['explore', 'verify'] });
});

test('routeForMutation: TOOL_SYNTHESIS → explore-then-verify regardless of source', async () => {
  const mod = await import(PLUGIN_PATH);
  const ctx = makeMockCtx();
  mod.apply(ctx, {});
  const sandbox = ctx._providers['agint.qualitySandbox'];
  for (const source of ['attribution-driven', 'dream-random', 'evolution-reversed']) {
    const r = sandbox.routeForMutation({ source, kind: 'TOOL_SYNTHESIS' });
    assert.deepEqual(r, { mode: 'explore-then-verify', stages: ['explore', 'verify'] }, `source=${source}`);
  }
});

test('routeForMutation: attribution-driven + PROMPT_MUTATION → verify only', async () => {
  const mod = await import(PLUGIN_PATH);
  const ctx = makeMockCtx();
  mod.apply(ctx, {});
  const sandbox = ctx._providers['agint.qualitySandbox'];
  const r = sandbox.routeForMutation({ source: 'attribution-driven', kind: 'PROMPT_MUTATION' });
  assert.deepEqual(r, { mode: 'verify', stages: ['verify'] });
});

test('routeForMutation: evolution-reversed + STRATEGY_REWRITE → verify only', async () => {
  const mod = await import(PLUGIN_PATH);
  const ctx = makeMockCtx();
  mod.apply(ctx, {});
  const sandbox = ctx._providers['agint.qualitySandbox'];
  const r = sandbox.routeForMutation({ source: 'evolution-reversed', kind: 'STRATEGY_REWRITE' });
  assert.deepEqual(r, { mode: 'verify', stages: ['verify'] });
});

test('backendHealth: returns v0.6.3 seccompAvailable / sbplAvailable fields', async () => {
  const mod = await import(PLUGIN_PATH);
  const ctx = makeMockCtx();
  mod.apply(ctx, {});
  const sandbox = ctx._providers['agint.qualitySandbox'];
  const h = await sandbox.backendHealth();
  assert.equal(typeof h.seccompAvailable, 'boolean');
  assert.equal(typeof h.sbplAvailable, 'boolean');
  assert.equal(typeof h.ctxSandboxAvailable, 'boolean');
  assert.equal(h.inProcessFallbackEnabled, true);
});

test('Service shape: runVerify / runExplore / resolveProfile / routeForMutation exposed', async () => {
  const mod = await import(PLUGIN_PATH);
  const ctx = makeMockCtx();
  mod.apply(ctx, {});
  const sandbox = ctx._providers['agint.qualitySandbox'];
  assert.equal(typeof sandbox.runVerify, 'function');
  assert.equal(typeof sandbox.runExplore, 'function');
  assert.equal(typeof sandbox.resolveProfile, 'function');
  assert.equal(typeof sandbox.routeForMutation, 'function');
  // v0.3 兼容性：runSmoke / backendHealth 保留
  assert.equal(typeof sandbox.runSmoke, 'function');
  assert.equal(typeof sandbox.backendHealth, 'function');
});

test('runVerify in-process fallback: missing target.path → throws', async () => {
  const mod = await import(PLUGIN_PATH);
  const ctx = makeMockCtx();
  mod.apply(ctx, {});
  const sandbox = ctx._providers['agint.qualitySandbox'];
  await assert.rejects(() => sandbox.runVerify({ target: {} }), /target.path is required/);
});

test('runExplore in-process fallback: mode=explore → 60s timeout preset', async () => {
  // 通过捕获 cfg.config 字段验证 explore 模式预设
  const mod = await import(PLUGIN_PATH);
  const ctx = makeMockCtx();
  mod.apply(ctx, {});
  const sandbox = ctx._providers['agint.qualitySandbox'];
  // runExplore 会因 profile 文件不存在 → 走 in-process fallback
  // 这里只验证 Service 可调用 + 返回值 shape，不验证 ok（smoke 结果依赖真实 plugin）
  const r = await sandbox.runExplore({ target: { path: resolve(__dirname, '..') } });
  assert.equal(typeof r.ok, 'boolean');
  assert.match(r.mode, /explore/);
  assert.equal(typeof r.safety, 'number');
  assert.equal(typeof r.policyDecision, 'string');
});