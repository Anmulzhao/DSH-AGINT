// v0.7.2：runSmoke 拒相对路径（fail-closed）—— 2026-09-29
//
// 背景（真实事故，非假想）：evolution-driver v0.2.7 调
//   sandbox.runSmoke({ target: { path: commit.path } })   // commit.path = 'bin/plugin-check.sh'
// 而 sandbox 内部第一行就是 `resolve(target.path)` —— Node 的 path.resolve
// **按 process.cwd() 解析**。宿主 cwd 是 C:\Users\Administrator\Desktop，
// 于是仓库里那个文件被验成了 Desktop\bin\plugin-check.sh，
// failure_pattern 记 sandbox-smoke-failed:plugin-not-found。
// **验的根本不是调用方指的那个文件，却一路走到了 policy.decide。**
//
// 修法：target.path 必须是绝对路径，否则 fail-closed 返回 ok:false。
// 刻意**返回而不是 throw** —— quality-eval evaluate() 对任何 !smoke.ok 一律
// REJECT（无 provisional 分支），而 driver/mutator 也把 ok:false 当门禁结果；
// throw 会把「门禁判死」升级成「链路崩」，与 argv-shape-guard 的降级理由同源。
//
// 跑法：node --test plugins/agint-quality-sandbox/test/relative-path-guard.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = pathToFileURL(resolve(__dirname, '../lib/index.js')).href;

function makeMockCtx() {
  const providers = {};
  const services = {};
  return {
    effect: () => {},
    get: (name) => services[name],
    provide: (name, val) => { providers[name] = val; },
    on: () => {},
    register: () => {},
    services,
    _setMockService: (name, val) => { services[name] = val; },
    _providers: providers,
  };
}

async function loadSandbox(mockConfine, config = {}) {
  const mod = await import(PLUGIN_PATH);
  const ctx = makeMockCtx();
  // confine 绝不该被调用 —— 被拒的路径在进 sandbox 之前就返回了。
  let confineCalls = 0;
  ctx._setMockService('sandbox', {
    confine: (...args) => { confineCalls++; return mockConfine ? mockConfine(...args) : []; },
  });
  mod.apply(ctx, config);
  return { sandbox: ctx._providers['agint.qualitySandbox'], ctx, confineCalls: () => confineCalls };
}

// ── 负向：相对路径必须被拒，且绝不能进 sandbox ─────────────────────────────
test('拒相对路径：bin/plugin-check.sh 这类仓库相对路径 → fail-closed，不是按 cwd resolve', async () => {
  const failures = [];
  const { sandbox, ctx, confineCalls } = await loadSandbox(null);
  ctx._setMockService('agint.evolution', {
    addFailure: async (f) => { failures.push(f); return { id: 'f1' }; },
  });

  const r = await sandbox.runSmoke({ target: { path: 'bin/plugin-check.sh', name: 'repo/bin/plugin-check.sh' } });

  assert.equal(r.ok, false, '相对路径必须判死');
  assert.equal(r.reason, 'relative-path-rejected');
  assert.equal(r.mode, 'rejected');
  assert.equal(r.target.path, null, '不得把相对路径「帮忙」解析成某个绝对路径 —— 那正是事故本身');
  assert.equal(confineCalls(), 0, '被拒的路径绝不能进 sandbox');
  assert.match(String(r.stderr), /绝对路径/, 'stderr 要说清判据，否则调用方无从修');
});

test('拒相对路径：./ 与 ../ 与裸文件名都拒（不只拦一种形态）', async () => {
  const { sandbox } = await loadSandbox(null);
  for (const p of ['./x', '../outside', 'bare', 'plugins/agint-cron']) {
    const r = await sandbox.runSmoke({ target: { path: p, name: p } });
    assert.equal(r.ok, false, `${p} 必须被拒`);
    assert.equal(r.reason, 'relative-path-rejected', `${p} 的 reason 要可机读`);
  }
});

test('被拒必须留痕：走 agint.evolution.addFailure，evidence 带 cwd', async () => {
  const failures = [];
  const { sandbox, ctx } = await loadSandbox(null);
  ctx._setMockService('agint.evolution', {
    addFailure: async (f) => { failures.push(f); return { id: 'f1' }; },
  });
  await sandbox.runSmoke({ target: { path: 'lib/x.js', name: 'x' } });
  assert.equal(failures.length, 1, '被拒必须记 failure_pattern —— 否则生产上查不到');
  assert.equal(failures[0].pattern, 'sandbox-smoke-failed:relative-path-rejected');
  assert.match(String(failures[0].evidence), /cwd=/, 'evidence 必须带 cwd：同一个相对路径在不同 cwd 下验的是不同文件');
  assert.match(String(failures[0].evidence), /lib\/x\.js/);
});

test('evolve 服务缺席时不得抛（留痕失败绝不能升级成链路崩）', async () => {
  const { sandbox } = await loadSandbox(null);   // 不注册 agint.evolution
  const r = await sandbox.runSmoke({ target: { path: 'lib/x.js', name: 'x' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'relative-path-rejected');
});

// ── 正向：绝对路径不受影响（本改动不能误伤生产）───────────────────────────
test('绝对路径照常放行：判据不能误伤现有 3 个生产调用方', async () => {
  const { sandbox } = await loadSandbox(() => ({ ok: true, stdout: '{"checks":[]}', stderr: '' }));
  // 用 sandbox 自己的目录（绝对路径），in-process fallback 会真跑 smoke
  const abs = resolve(__dirname, '..');
  const r = await sandbox.runSmoke({ target: { path: abs, name: 'agint-quality-sandbox' } });
  assert.notEqual(r.reason, 'relative-path-rejected', '绝对路径不得被这条判据拒');
  assert.equal(r.ok, typeof r.ok === 'boolean' ? r.ok : false, 'ok 必须是布尔（真跑出来的，不是抛错）');
  assert.equal(typeof r.mode, 'string');
});

test('绝对路径下的失败仍走原路径（in-process / bad-shape），不被新判据吞掉', async () => {
  const { sandbox, confineCalls } = await loadSandbox(() => ({ ok: true, stdout: '{}', stderr: '' }));
  const r = await sandbox.runSmoke({ target: { path: resolve(__dirname, '..'), name: 'x' } });
  assert.equal(confineCalls(), 1, '绝对路径必须真的进 sandbox —— 否则说明被新判据误拦了');
  assert.notEqual(r.reason, 'relative-path-rejected');
});
