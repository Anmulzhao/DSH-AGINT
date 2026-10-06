/**
 * 防回归：respawn 拉起的新 dsh 必须脱离 WorkBuddy 的 NODE_OPTIONS 注入。
 *
 * 2026-10-06 实测事故：WorkBuddy CLI 用
 *   NODE_OPTIONS=--require=".../node-language-shim.cjs"
 * 把 safe-delete 批量删除护栏注入每个 node 进程，dsh 被它拦死过两次
 * （21:41 count=49 / 22:04 count=735，阈值 50）—— 受害者是
 * dsh-atomic-write 释放 `.credentials.yaml.lock` 的正常文件锁 rm。
 *
 * 判据怎么取：让被拉起的「假 dsh」把自己的 NODE_OPTIONS 写进文件再退出，
 * 而不是去断言父进程传了什么 —— 前者是新进程真实拿到的东西，后者是
 * 「我以为我传了什么」。两者不一致时只有前者算数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RESPAWN = fileURLToPath(new URL('../lib/respawn.js', import.meta.url));

function deadPid() {
  const out = execFileSync(process.execPath, ['-e', 'console.log(process.pid)']).toString().trim();
  return Number(out);
}

/** 造一次 respawn：拉起的假 dsh 把 NODE_OPTIONS 写到 probe 文件里。 */
/**
 * 造一个真实存在的空 shim 文件。
 *
 * 不能拿不存在的路径当注入值：NODE_OPTIONS=--require="<不存在>" 会让 node 在
 * 启动阶段直接抛 ENOENT 崩掉，假 dsh 根本没机会写 probe，测试报的是
 * "probe 没生成" 而不是 "注入被错误地保留/剥离" —— 判据落在症状上，不是判据上。
 * （这个坑真踩过一次：第一版 keepNodeOptions 用例用了 /fake/shim.cjs。）
 */
function writeRealShim(dir) {
  const shim = path.join(dir, 'real-shim.cjs');
  fs.writeFileSync(shim, '/* no-op shim */\n');
  return shim;
}

function runOnce(dir, launchOverrides = {}) {
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const probeFile = path.join(dir, 'probe.json');
  const fakeDsh = path.join(dir, 'fake-dsh.mjs');
  fs.writeFileSync(
    fakeDsh,
    `import { writeFileSync } from 'node:fs';\n` +
    `writeFileSync(${JSON.stringify(probeFile)}, JSON.stringify({ nodeOptions: process.env.NODE_OPTIONS ?? null }));\n`,
  );

  const req = {
    requestId: 'envtest1',
    reason: 'test',
    requestedAt: new Date().toISOString(),
    targetPid: deadPid(),
    stateDir,
    launch: { command: process.execPath, args: [fakeDsh], cwd: dir, ...launchOverrides },
    waitExitMs: 500,
    forceKillAfterMs: 0,
    portFreeTimeoutMs: 300,
    readiness: { leasePath: null, port: 0, timeoutMs: 300 },
    logFile: path.join(dir, 'dsh.log'),
  };
  const reqPath = path.join(stateDir, 'restart-request.json');
  fs.writeFileSync(reqPath, JSON.stringify(req, null, 2));
  execFileSync(process.execPath, [RESPAWN, reqPath], { stdio: 'ignore' });

  assert.ok(fs.existsSync(probeFile), '假 dsh 应已把自己的 NODE_OPTIONS 写进 probe 文件');
  return JSON.parse(fs.readFileSync(probeFile, 'utf8'));
}

test('默认：拉起的新进程不得继承 NODE_OPTIONS（切断 safe-delete shim 链）', async (t) => {
  if (process.platform === 'win32') return t.skip('本组测试造 posix detached 子进程形状');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agint-restart-nodeopts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 先确认前置条件成立：本测试确实跑在带注入的 NODE_OPTIONS 环境下，
  // 否则本用例是「在本来就干净的环境里断言干净」——那种绿是假的。
  assert.ok(
    typeof process.env.NODE_OPTIONS === 'string' && process.env.NODE_OPTIONS.includes('require'),
    `前置条件：本进程应带 NODE_OPTIONS require 注入，实得 ${process.env.NODE_OPTIONS ?? '<unset>'}`,
  );

  const probe = runOnce(dir);
  assert.equal(probe.nodeOptions, null, '新拉起的进程不得再继承 NODE_OPTIONS');
});

test('escape hatch：launch.keepNodeOptions=true 时保留注入', async (t) => {
  if (process.platform === 'win32') return t.skip('本组测试造 posix detached 子进程形状');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agint-restart-nodeopts-keep-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const probe = runOnce(dir, { keepNodeOptions: true });
  assert.ok(
    probe.nodeOptions && probe.nodeOptions.includes('require'),
    `keepNodeOptions:true 时应原样保留，实得 ${probe.nodeOptions}`,
  );
});

test('launch.env 里带 NODE_OPTIONS 时也必须剥掉（2026-10-06 22:24 回归）', async (t) => {
  if (process.platform === 'win32') return t.skip('本组测试造 posix detached 子进程形状');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agint-restart-nodeopts-launchenv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 这条用例的存在理由：第一版修复把 delete 打在 base 上、展开放在后面，
  // 于是 launch.env 里的 NODE_OPTIONS 原样覆盖回来 —— 单测全绿但行为没变
  // （22:24 真机重启后新进程 environ 里 NODE_OPTIONS 仍在）。
  // launch.env 是「上次启动 env 的全量快照」，本机实测 172 个键含 NODE_OPTIONS，
  // 所以必须按这个真实形状造，不能只在干净的 launch.env 上测。
  const shim = writeRealShim(dir);
  const probe = runOnce(dir, {
    env: {
      NODE_OPTIONS: `--require=${JSON.stringify(shim)}`,
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SOME_OTHER_SNAPSHOT_KEY: 'kept',
    },
  });
  assert.equal(probe.nodeOptions, null, 'launch.env 带进来的 NODE_OPTIONS 也必须被剥掉');
});

test('launch.env 带注入 + keepNodeOptions=true：保留，并保留同批的其它快照键', async (t) => {
  if (process.platform === 'win32') return t.skip('本组测试造 posix detached 子进程形状');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agint-restart-nodeopts-keep2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const shim = writeRealShim(dir);
  const probeFile = path.join(dir, 'probe.json');
  const fakeDsh = path.join(dir, 'fake-dsh.mjs');
  fs.writeFileSync(
    fakeDsh,
    `import { writeFileSync } from 'node:fs';\n` +
    `writeFileSync(${JSON.stringify(probeFile)}, JSON.stringify({\n` +
    `  nodeOptions: process.env.NODE_OPTIONS ?? null,\n` +
    `  other: process.env.SOME_OTHER_SNAPSHOT_KEY ?? null,\n` +
    `}));\n`,
  );
  const req = {
    requestId: 'envtest-keep2',
    reason: 'test',
    requestedAt: new Date().toISOString(),
    targetPid: deadPid(),
    stateDir,
    launch: {
      command: process.execPath,
      args: [fakeDsh],
      cwd: dir,
      keepNodeOptions: true,
      env: { NODE_OPTIONS: `--require=${JSON.stringify(shim)}`, SOME_OTHER_SNAPSHOT_KEY: 'kept', PATH: process.env.PATH },
    },
    waitExitMs: 500,
    forceKillAfterMs: 0,
    portFreeTimeoutMs: 300,
    readiness: { leasePath: null, port: 0, timeoutMs: 300 },
    logFile: path.join(dir, 'dsh.log'),
  };
  const reqPath = path.join(stateDir, 'restart-request.json');
  fs.writeFileSync(reqPath, JSON.stringify(req, null, 2));
  execFileSync(process.execPath, [RESPAWN, reqPath], { stdio: 'ignore' });

  const probe = JSON.parse(fs.readFileSync(probeFile, 'utf8'));
  assert.ok(
    probe.nodeOptions && probe.nodeOptions.includes('real-shim.cjs'),
    `keepNodeOptions:true 时 launch.env 里的注入应保留，实得 ${probe.nodeOptions}`,
  );
  assert.equal(probe.other, 'kept', 'escape hatch 只放行 NODE_OPTIONS，不牵连同批快照键');
});

test('剥离 NODE_OPTIONS 不得牵连其它 env（DSH_HOME 等仍按既有语义走 .env）', async (t) => {
  if (process.platform === 'win32') return t.skip('本组测试造 posix detached 子进程形状');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agint-restart-env-nocollateral-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const probeFile = path.join(dir, 'probe.json');
  const fakeDsh = path.join(dir, 'fake-dsh.mjs');
  fs.writeFileSync(
    fakeDsh,
    `import { writeFileSync } from 'node:fs';\n` +
    `writeFileSync(${JSON.stringify(probeFile)}, JSON.stringify({\n` +
    `  nodeOptions: process.env.NODE_OPTIONS ?? null,\n` +
    `  path: process.env.PATH ?? null,\n` +
    `  home: process.env.HOME ?? null,\n` +
    `}));\n`,
  );
  const req = {
    requestId: 'envtest2',
    reason: 'test',
    requestedAt: new Date().toISOString(),
    targetPid: deadPid(),
    stateDir,
    launch: { command: process.execPath, args: [fakeDsh], cwd: dir },
    waitExitMs: 500,
    forceKillAfterMs: 0,
    portFreeTimeoutMs: 300,
    readiness: { leasePath: null, port: 0, timeoutMs: 300 },
    logFile: path.join(dir, 'dsh.log'),
  };
  const reqPath = path.join(stateDir, 'restart-request.json');
  fs.writeFileSync(reqPath, JSON.stringify(req, null, 2));
  execFileSync(process.execPath, [RESPAWN, reqPath], { stdio: 'ignore' });

  const probe = JSON.parse(fs.readFileSync(probeFile, 'utf8'));
  assert.equal(probe.nodeOptions, null, 'NODE_OPTIONS 仍应被剥掉');
  assert.ok(probe.path, 'PATH 必须保留 —— 剥过头会让新 dsh 连 node 都找不到');
  assert.ok(probe.home, 'HOME 必须保留');
});