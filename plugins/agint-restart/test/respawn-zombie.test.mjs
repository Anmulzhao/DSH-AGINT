#!/usr/bin/env node
// agint-restart / respawn.js 的僵尸进程判活回归测试
//
// 2026-10-07 取证：连续三次插件发起的重启都是 `exited=false forced=true waitedMs≈45100`，
// 而同一份 restart-result.json 里 `portFree={free:true, waitedMs:9}` —— 旧进程 9ms 就
// 释放了 3080 端口，说明它**早就退出了**。根因：
//
//   respawn.js 的 isAlive() 用 `process.kill(pid, 0)` 判活，而**僵尸进程对 signal 0
//   仍然响应**（pid 条目还在进程表里）。本容器 PID 1 = `sleep infinity`，从不调用
//   wait()，所以 respawn 派生的 shell/node 退出后永远滞留为 Zs 僵尸 ⇒
//   waitForExit 白等满 30s → SIGKILL（对僵尸是空操作）→ 再等 15s → 放弃。
//   实测 /proc 里 1351 / 5823 / 7641 三个被"强杀"的 pid 此刻 state 全是 Z。
//
// 代价：每次重启多花 45 秒 + 僵尸持续累积（实测已积 8 个）。
//
// 本测试造一个真僵尸，让 respawn 去认它，断言**不该**走强杀路径。
// ⛔ 造不出僵尸时必须显式 skip 并说明原因 —— 静默跳过 = 假防线。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RESPAWN = join(PLUGIN_DIR, 'lib', 'respawn.js');

/**
 * 取一个僵尸 pid。两条路径：
 *   1) 现造：起一个常驻父进程，它 spawn 一个秒退的子进程 ⇒ 子必为僵尸
 *   2) 复用：扫 /proc 找已存在的 Z 状态进程（本机 PID 1 = sleep 不 reap，
 *      respawn 派生的 shell/node 退出后会长期滞留为僵尸，实测常有若干）
 * 两条都拿不到才返回 null。
 *
 * 注：路径 1 在部分环境下拿不到（孤儿被中间层回收），所以必须有路径 2 兜底，
 * 否则这台机器上会静默跳过判据 —— 静默跳过 = 假防线。
 */
function scanZombies() {
  let names = [];
  try { names = readdirSync('/proc'); } catch { return []; }
  const out = [];
  for (const d of names) {
    if (!/^[0-9]+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      const state = stat.slice(stat.lastIndexOf(')') + 2).trim()[0];
      if (state === 'Z') out.push(Number(d));
    } catch { /* 竞态：刚被回收 */ }
  }
  return out;
}

function readState(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).trim()[0];
  } catch { return null; }
}

async function makeZombie() {
  // 路径 1：父进程常驻 6s，子进程秒退 ⇒ 子在父活着期间必为僵尸
  const parent = spawn(process.execPath, ['-e',
    "const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore'});"
    + "process.stdout.write(String(c.pid));setTimeout(()=>process.exit(0),6000);",
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const pid = await new Promise((resolve) => {
      let buf = '';
      const timer = setTimeout(() => resolve(null), 4000);
      parent.stdout.on('data', (d) => {
        buf += d;
        const n = Number(String(buf).trim());
        if (!Number.isInteger(n) || n <= 0) return;
        clearTimeout(timer);
        resolve(n);
      });
      parent.on('error', () => { clearTimeout(timer); resolve(null); });
    });
    if (pid) {
      for (let i = 0; i < 20; i += 1) {
        if (readState(pid) === 'Z') return pid;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  } finally {
    parent.kill('SIGKILL');
  }
  // 路径 2：复用机器上已有的僵尸
  const existing = scanZombies();
  return existing.length ? existing[0] : null;
}

function runRespawn(targetPid, stateDir) {
  const lease = join(stateDir, 'sentinel.lease');
  const requestFile = join(stateDir, 'restart-request.json');
  const launch = {
    command: process.execPath,
    args: ['-e', `require('fs').writeFileSync(${JSON.stringify(lease)}, 'up')`],
    cwd: stateDir,
    env: {},
  };
  writeFileSync(requestFile, JSON.stringify({
    requestId: 'zombie-probe',
    reason: 'zombie detection test',
    requestedAt: new Date().toISOString(),
    targetPid,
    stateDir,
    launch,
    waitExitMs: 6000,        // 修复前会等满这 6 秒
    forceKillAfterMs: 0,      // 关掉强杀，让 exited 字段直接反映判活结果
    portFreeTimeoutMs: 2000,
    readiness: { leasePath: lease, port: null, timeoutMs: 10000 },
    logFile: join(stateDir, 'dsh-web.log'),
  }, null, 2));
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [RESPAWN, requestFile], { encoding: 'utf8', timeout: 30000 });
  return { wallMs: Date.now() - t0, r };
}

test('僵尸 pid 必须被判为已退出（不得走 30s 强杀路径）', async () => {
  const stateDir = join(tmpdir(), `agint-restart-zombie-${process.pid}-${Date.now()}`);
  mkdirSync(stateDir, { recursive: true });

  const zpid = await makeZombie();
  if (zpid === null) {
    // 显式跳过：说清是「造不出也扫不到僵尸」，不是编一个原因
    console.log('    ↷ SKIP：既造不出新僵尸，/proc 里也没有现存 Z 状态进程 —— 本判据在本机不适用');
    return;
  }
  assert.equal(readState(zpid), 'Z', `拿到的 pid ${zpid} 当前不是僵尸状态，判据前提不成立`);
  try {
    const { wallMs, r } = runRespawn(zpid, stateDir);
    const resultFile = join(stateDir, 'restart-result.json');
    assert.ok(existsSync(resultFile), `respawn 应写出结果文件；stdout=${r.stdout} stderr=${r.stderr}`);
    const result = JSON.parse(readFileSync(resultFile, 'utf8'));
    const exit = result.exit || {};

    assert.equal(exit.exited, true,
      `僵尸 pid ${zpid} 被判成「还活着」（exited=${exit.exited} forced=${exit.forced} waitedMs=${exit.waitedMs}）—— `
      + 'isAlive 用 kill(pid,0) 判活，僵尸会误判，导致每次重启拖成 45s 强杀');
    assert.equal(exit.forced, false, '不该走到强杀分支');
    assert.ok((exit.waitedMs ?? Infinity) < 3000,
      `应在下一次轮询（200ms）附近就判定退出，实测 waitedMs=${exit.waitedMs}`);
    assert.ok(wallMs < 8000, `整体墙钟时间应远小于 waitExitMs=6000，实测 ${wallMs}ms`);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('真实存活的进程仍应被判为活着（修僵尸判定不能把活进程误杀）', () => {
  const stateDir = join(tmpdir(), `agint-restart-alive-${process.pid}-${Date.now()}`);
  mkdirSync(stateDir, { recursive: true });
  // 起一个会睡很久的进程当"旧实例"
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{},20000)'], { stdio: 'ignore' });
  try {
    const { r } = runRespawn(sleeper.pid, stateDir);
    const resultFile = join(stateDir, 'restart-result.json');
    assert.ok(existsSync(resultFile), `respawn 应写出结果文件；stderr=${r.stderr}`);
    const result = JSON.parse(readFileSync(resultFile, 'utf8'));
    const exit = result.exit || {};
    assert.equal(exit.exited, false,
      `活着的 pid ${sleeper.pid} 被误判为已退出（exited=${exit.exited}）—— 僵尸判定过头了`);
  } finally {
    sleeper.kill('SIGKILL');
    rmSync(stateDir, { recursive: true, force: true });
  }
});
