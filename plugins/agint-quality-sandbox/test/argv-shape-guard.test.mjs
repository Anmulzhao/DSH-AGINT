// Sprint 18：sandbox argv shape 防护 — 2026-09-17
// 背景：sandboxService.confine() 在真实 dsh 某些模式返回非数组结构，
// 原代码 `result.argv ?? result` 后直接 `argv.slice(1)` 抛 TypeError。
//
// 修法定稿（2026-09-17）：先校验 shape；不是数组 → **降级走 in-process smoke**
// （runSmokeInProcess，真实跑测试），而非盲返 ok:false。
//   原因：quality-eval evaluate()（agint-quality-eval/lib/index.js:220）对任何
//   `!smoke.ok` 一律 makeSandboxRejectedResult → REJECT，**没有** E0/provisional 分支。
//   所以若 bad-shape 直接返 ok:false，autocreate 候选会被 policy REJECT 死锁。
//   降级 in-process 才是「真质量门 + 不误杀」。
//   与插件既有行为一致：ctx.sandbox 缺失时本就降级 in-process（Config.allowInProcessFallback 默认 true）。
//   仅当 allowInProcessFallback=false 时才干净返回 ok:false（fail-closed，不抛）。
//
// 跑法：node --test test/argv-shape-guard.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = pathToFileURL(resolve(__dirname, '../lib/index.js')).href;

function makeMockCtx() {
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

async function loadSandbox(mockConfine, config = {}) {
  const mod = await import(PLUGIN_PATH);
  const ctx = makeMockCtx();
  if (mockConfine !== undefined) {
    ctx._setMockService('sandbox', { confine: mockConfine });
  }
  mod.apply(ctx, config);
  return ctx._providers['agint.qualitySandbox'];
}

// ── Case 1: confine 返回裸对象 {ok, stdout, stderr}（非 argv 形状）─────────────
test('Sprint 18 防护：ctx.sandbox.confine 返回非数组（裸对象 {ok, stdout, stderr}）时不应抛 → 降级 in-process', async () => {
  const mockConfine = (argv, policy) => ({ ok: true, stdout: '{}', stderr: '', checks: [] });
  const sandbox = await loadSandbox(mockConfine);
  const result = await sandbox.runVerify({ target: { path: resolve(__dirname, '..') } });
  // 不应抛 TypeError；应降级走 in-process smoke（真跑质量门）
  assert.equal(result.fallback, 'in-process', '非数组结构应触发 in-process 降级');
  assert.match(String(result.mode), /in-process-fallback/, `mode 应标 in-process-fallback，实际 ${result.mode}`);
  assert.equal(typeof result.ok, 'boolean', 'ok 应为真实 smoke 结果');
});

test('Sprint 18 防护：ctx.sandbox.confine 返回字符串也不应抛 → 降级 in-process', async () => {
  const mockConfine = () => 'unexpected-string';
  const sandbox = await loadSandbox(mockConfine);
  const result = await sandbox.runVerify({ target: { path: resolve(__dirname, '..') } });
  assert.equal(result.fallback, 'in-process');
  assert.equal(typeof result.ok, 'boolean');
});

test('Sprint 18 防护：ctx.sandbox.confine 返回 null 也不应抛 → 降级 in-process', async () => {
  const mockConfine = () => null;
  const sandbox = await loadSandbox(mockConfine);
  const result = await sandbox.runVerify({ target: { path: resolve(__dirname, '..') } });
  assert.equal(result.fallback, 'in-process');
  assert.equal(typeof result.ok, 'boolean');
});

// ── Case 4: 显式禁用 fallback → 坏形状走干净 fail-closed（不抛）──────────────
test('Sprint 18 防护：allowInProcessFallback=false + 非数组 → 干净 fail-closed（不抛、ok=false）', async () => {
  const mockConfine = () => ({ ok: true, stdout: '{}' });
  const sandbox = await loadSandbox(mockConfine, { allowInProcessFallback: false });
  const result = await sandbox.runVerify({ target: { path: resolve(__dirname, '..') } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'sandbox-bad-shape');
  assert.equal(result.safety, 0.0, 'verify 模式 failureSafety=0.0');
});

// ── Case 5: confine 返回合法 {argv:[string,...]} → 正常走 spawn ───────────────
test('Sprint 18 防护：ctx.sandbox.confine 返回 {argv: [string, ...]} 正常走 spawn', async () => {
  const mockConfine = () => ({ argv: [process.execPath, '-e', "console.log(JSON.stringify({ok:true,checks:['mock-passed'],reason:'ok'}))"] });
  const sandbox = await loadSandbox(mockConfine);
  const result = await sandbox.runVerify({ target: { path: resolve(__dirname, '..') } });
  // shape 通过 → spawn 能起来 → stdout 可解析 → ok=true；关键是不应抛 TypeError
  assert.notEqual(result.reason?.includes?.('slice'), true, `reason 不应提到 slice：${result.reason}`);
  assert.notEqual(result.reason?.includes?.('TypeError'), true, `reason 不应是 TypeError：${result.reason}`);
  assert.equal(result.ok, true, 'argv shape 合法 + spawn 返回 ok:true → result.ok=true');
});

// ── Case 6: confine 抛错 → 走原 sandbox-confine-failed 路径 ──────────────────
test('Sprint 18 防护：ctx.sandbox.confine 抛错走原 sandbox-confine-failed 路径', async () => {
  const mockConfine = () => { throw new Error('sandbox subprocess missing'); };
  const sandbox = await loadSandbox(mockConfine);
  const result = await sandbox.runVerify({ target: { path: resolve(__dirname, '..') } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'sandbox-confine-failed');
  assert.match(result.stderr, /sandbox subprocess missing/);
});
