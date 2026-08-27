/**
 * dual-mode-transport.test.mjs — Sprint 10 v0.6.3 #3
 *
 * 测试范围：runVerify / runExplore 是否把 ResolvedProfile 透传到 ctx.sandbox.confine
 *   1. runVerify 调用 ctx.sandbox.confine 时 policy.sandboxProfile.format === 'bpf-json' (linux)
 *   2. runExplore 同上 + content 含 SCMP_ACT_KILL_PROCESS (linux)
 *   3. runVerify 在 ctx.sandbox.confine 抛错时返 { ok:false, reason:'sandbox-confine-failed', safety:0.0, policyDecision:'REJECT' }
 *
 * 注意：本测试仅断言 **policy 透传契约**。
 *   - linux → sandboxProfile.format === 'bpf-json'
 *   - darwin → sandboxProfile.format === 'sbpl'
 * 两种平台都跑断言，平台对应断言。
 *
 * L0-frozen 保护：本测试**不引用** quality-contract 任何符号。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = resolve(__dirname, '../lib/index.js');

// 构造最小 mock ctx（参考 dual-mode.test.mjs）
function makeMockCtx() {
  const effects = [];
  const providers = {};
  const services = {};
  const confineCalls = [];
  const mockConfine = (argv, policy) => {
    confineCalls.push({ argv, policy });
    return { argv };  // 透传 → 下一段 spawn 会失败但不影响 confine 透传断言
  };
  return {
    _effects: effects,
    _providers: providers,
    _confineCalls: confineCalls,
    effect: (fn) => { effects.push(fn); },
    get: (name) => services[name],
    provide: (name, val) => { providers[name] = val; },
    on: () => {},
    register: () => {},
    services,
    _installSandbox: (impl) => { services.sandbox = { confine: impl || mockConfine }; },
    _confineMock: mockConfine,
  };
}

// ── Case 1: runVerify 透传 sandboxProfile 形状 ───────────────────────────────
test('runVerify: passes sandboxProfile with platform-correct format to ctx.sandbox.confine', async () => {
  const mod = await import(PLUGIN_PATH);
  const ctx = makeMockCtx();
  mod.apply(ctx, {});
  ctx._installSandbox(ctx._confineMock);
  const sandbox = ctx._providers['agint.qualitySandbox'];
  await sandbox.runVerify({ target: { path: __dirname } });
  const calls = ctx._confineCalls;
  assert.ok(calls.length >= 1, 'should call ctx.sandbox.confine at least once');
  const profile = calls[0].policy.sandboxProfile;
  assert.equal(profile.platform, process.platform);
  if (process.platform === 'linux') {
    assert.equal(profile.format, 'bpf-json', 'linux → bpf-json');
  } else if (process.platform === 'darwin') {
    assert.equal(profile.format, 'sbpl', 'darwin → sbpl');
  }
  assert.equal(profile.mode, 'verify');
});

// ── Case 2: runExplore 透传 sandboxProfile 含 SCMP_ACT_KILL_PROCESS ──────────
test('runExplore: sandboxProfile.content contains platform-default-action marker', async () => {
  const mod = await import(PLUGIN_PATH);
  const ctx = makeMockCtx();
  mod.apply(ctx, {});
  ctx._installSandbox(ctx._confineMock);
  const sandbox = ctx._providers['agint.qualitySandbox'];
  await sandbox.runExplore({ target: { path: __dirname } });
  const calls = ctx._confineCalls;
  assert.ok(calls.length >= 1, 'should call ctx.sandbox.confine');
  const profile = calls[0].policy.sandboxProfile;
  assert.equal(profile.mode, 'explore');
  if (process.platform === 'linux') {
    assert.equal(profile.format, 'bpf-json');
    assert.match(profile.content, /SCMP_ACT_KILL_PROCESS/, 'bpf-json content should contain SCMP_ACT_KILL_PROCESS');
    assert.equal(profile.defaultAction, 'SCMP_ACT_KILL_PROCESS');
  } else if (process.platform === 'darwin') {
    assert.equal(profile.format, 'sbpl');
    assert.match(profile.content, /\(deny default\)/, 'sbpl content should contain (deny default)');
  }
});

// ── Case 3: runVerify 在 confine 抛错时返 sandbox-confine-failed 形状 ──────────
test('runVerify: confine throws → {ok:false, reason:sandbox-confine-failed, safety:0.0, policyDecision:REJECT}', async () => {
  const mod = await import(PLUGIN_PATH);
  const ctx = makeMockCtx();
  mod.apply(ctx, {});
  ctx._installSandbox(() => { throw new Error('mock confine boom'); });
  const sandbox = ctx._providers['agint.qualitySandbox'];
  const r = await sandbox.runVerify({ target: { path: __dirname } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'sandbox-confine-failed');
  assert.equal(r.safety, 0.0, 'verify mode failureSafety = 0.0');
  assert.equal(r.policyDecision, 'REJECT', 'verify mode policyDecision = REJECT');
  assert.match(r.stderr, /mock confine boom/);
});