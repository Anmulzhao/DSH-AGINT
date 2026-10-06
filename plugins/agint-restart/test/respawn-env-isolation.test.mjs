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