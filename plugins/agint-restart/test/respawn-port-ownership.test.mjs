/**
 * 防回归：重启回执的「就绪」判据必须验监听者身份，不能只看端口可连。
 *
 * 这组测试重演 2026-10-06 的真实事故形状（同一天两个 respawn 抢同一个端口）：
 *   先到的那个占住端口，后到的那个自己的 dsh 其实死于 EADDRINUSE，
 *   但旧判据看见「端口可连」就写 ok=true —— 把别人的成功算成自己的。
 *
 * 造法说明（为什么这么造才同形）：
 *   - 占位进程是真的 listen 真端口，不是 mock —— 事故的根因在「谁在 listen」，
 *     mock 掉这一步就等于把要验的东西验没了。
 *   - 拉起的是真的 node 子进程、真的 detached —— 与 respawn 实际拉 dsh 的形状一致。
 *   - 端口用临时高位口（不碰 3080）：测试期间本机有真 dsh 在跑，抢它会污染真环境。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RESPAWN = fileURLToPath(new URL('../lib/respawn.js', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 造一个**确定已死**的 pid。
 *
 * 不能随手写 999999：本机 pid 上限远高于此，实测 999999 就是个活进程
 * （第一次写死这个常量时，「陈旧锁」用例直接失败——锁被判成「持有者还活着」）。
 * 随手写的 pid 有两个害处：拿它当 targetPid 会让 waitForExit 真去等一个
 * 系统进程，当它碰巧活着时 forceKillAfterMs>0 的分支会**真的杀它**。
 * 所以起一个短命进程，等它退出，用它的 pid。
 */
function deadPid() {
  const out = execFileSync(process.execPath, ['-e', 'console.log(process.pid)']).toString().trim();
  const pid = Number(out);
  assert.ok(Number.isInteger(pid) && pid > 0, `未能取得可用的短命进程 pid，实得 ${out}`);
  return pid;
}

/** 起一个真监听端口的占位进程，返回 { pid, port, close() }。 */
function occupyPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], {
        detached: true,
        stdio: 'ignore',
      });
      // 占位进程自己 listen，上面那个 srv 只是用来分配端口；端口由 srv 占着。
      resolve({
        pid: child.pid,
        port,
        close: () => {
          try { srv.close(); } catch { /* ignore */ }
          try { process.kill(child.pid, 'SIGKILL'); } catch { /* ignore */ }
        },
      });
    });
  });
}

/** 造一份 request.json。launch 指向一个会一直挂着但**不占端口**的假 dsh。 */
function writeRequest(dir, overrides = {}) {
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const fakeDsh = path.join(dir, 'fake-dsh.mjs');
  fs.writeFileSync(fakeDsh, 'setInterval(() => {}, 1e6);');
  const req = {
    requestId: 'testreq1',
    reason: 'test',
    requestedAt: new Date().toISOString(),
    targetPid: deadPid(), // 确定已死 ⇒ waitForExit 立即返回 exited
    stateDir,
    launch: { command: process.execPath, args: [fakeDsh], cwd: dir },
    waitExitMs: 500,
    forceKillAfterMs: 0,
    portFreeTimeoutMs: 500,
    readiness: { leasePath: null, port: 0, timeoutMs: 800 },
    logFile: path.join(dir, 'dsh.log'),
    ...overrides,
  };
  const reqPath = path.join(stateDir, 'restart-request.json');
  fs.writeFileSync(reqPath, JSON.stringify(req, null, 2));
  return { reqPath, stateDir, req };
}

function readResult(stateDir) {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'restart-result.json'), 'utf8'));
}

test('端口被别人的进程占着时：不得判就绪、不得写 ok=true', async (t) => {
  if (process.platform === 'win32') return t.skip('本组测试造 posix detached 子进程形状');
  const holder = await occupyPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agint-restart-foreign-'));
  t.after(() => { holder.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const { reqPath, stateDir } = writeRequest(dir, {
    readiness: { leasePath: null, port: holder.port, timeoutMs: 1200 },
  });

  // 后台跑 respawn，等它自己结束
  execFileSync(process.execPath, [RESPAWN, reqPath], { stdio: 'ignore' });

  const result = readResult(stateDir);
  assert.equal(result.launched, true, '假 dsh 确实被拉起了');
  assert.equal(result.ready, false, '端口被外人占着 ⇒ 不该判就绪（这就是 10-06 事故的根因）');
  assert.equal(result.ok, false, 'ok 必须为 false —— 旧代码在这里会写 true');
  assert.equal(
    result.foreignListenerPid,
    process.pid,
    `foreignListenerPid 应如实记下占端口的真实监听者（测试进程 ${process.pid} 占着该端口），实得 ${result.foreignListenerPid}`,
  );
});

test('重叠保护：同一 targetPid 已有 respawn 在跑时，后来者让位且不写回执', async (t) => {
  if (process.platform === 'win32') return t.skip('本组测试造 posix detached 子进程形状');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agint-restart-overlap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const dead = deadPid();
  const { reqPath, stateDir } = writeRequest(dir, {
    targetPid: dead,
    readiness: { leasePath: null, port: 0, timeoutMs: 500 },
  });

  // 先手工放一个「正在跑」的锁：pid 用本进程（一定活着），targetPid 与请求一致
  fs.writeFileSync(
    path.join(stateDir, 'respawn.lock'),
    JSON.stringify({ pid: process.pid, targetPid: dead, requestId: 'first', startedAt: new Date().toISOString() }),
  );

  // 让位路径是 process.exit(3)，非 0 退出码在 execFileSync 上表现为抛错
  let exitCode = 0;
  try {
    execFileSync(process.execPath, [RESPAWN, reqPath], { stdio: 'ignore' });
  } catch (err) {
    exitCode = err.status;
  }

  assert.equal(exitCode, 3, `让位者应以退出码 3 退出，实得 ${exitCode}`);
  assert.equal(
    fs.existsSync(path.join(stateDir, 'restart-result.json')),
    false,
    '让位者不得写回执 —— result 是共享单槽，覆盖掉会把先认领者的真实结果顶没',
  );
});

test('重叠保护：锁里的 pid 已死（陈旧锁）时不得挡住重启', async (t) => {
  if (process.platform === 'win32') return t.skip('本组测试造 posix detached 子进程形状');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agint-restart-stalelock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const dead = deadPid();
  const { reqPath, stateDir } = writeRequest(dir, {
    targetPid: dead,
    readiness: { leasePath: null, port: 0, timeoutMs: 300 },
  });

  // 陈旧锁：pid 是一个早已退出的进程（isAlive 判 false）
  fs.writeFileSync(
    path.join(stateDir, 'respawn.lock'),
    JSON.stringify({ pid: dead, targetPid: dead, requestId: 'ancient', startedAt: '2020-01-01T00:00:00.000Z' }),
  );

  execFileSync(process.execPath, [RESPAWN, reqPath], { stdio: 'ignore' });

  const result = readResult(stateDir);
  // 判据是「陈旧锁没挡住」而不是「重启成功」：本用例没配就绪信号源
  //（port=0、leasePath=null），所以 ok 必然为 false —— 那是信号源缺失的
  // 正常结果，与锁无关。锁要是真挡住了，launched 会是 false 且根本走不到读回执。
  assert.equal(result.launched, true, '陈旧锁不该挡住重启（新 dsh 确实被拉起了）');
  assert.equal(result.targetPid, dead, '本进程认领的目标应是请求里的那个已死 pid');
  assert.equal(
    fs.existsSync(path.join(stateDir, 'respawn.lock')),
    false,
    '退出时应释放自己的锁',
  );
  const logText = fs.readFileSync(path.join(stateDir, 'restart.log'), 'utf8');
  assert.ok(!logText.includes('让位'), '陈旧锁场景下不得走进「让位」分支');
});

test('无任何就绪信号源时：判失败而不是假装成功', async (t) => {
  if (process.platform === 'win32') return t.skip('本组测试造 posix detached 子进程形状');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agint-restart-degraded-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const { reqPath, stateDir } = writeRequest(dir, {
    readiness: { leasePath: null, port: 0, timeoutMs: 300 },
  });

  execFileSync(process.execPath, [RESPAWN, reqPath], { stdio: 'ignore' });

  const result = readResult(stateDir);
  // port=0 且 leasePath=null ⇒ 一个就绪信号源都没有 ⇒ 等满超时判失败。
  // 这是改动前就有的行为，改动没有把它变松也没有变紧；记在这里是为了钉住
  // 「没有信号源就不许报成功」——新加的 degraded 分支最容易在这里被误写成 true。
  assert.equal(result.ready, false, '无信号源时不得判就绪');
  assert.equal(result.ok, false, '无信号源时 ok 必须为 false');
  assert.equal(result.readySignal, null, '无信号源时不得编造信号名');
  assert.equal(
    result.readyDegraded,
    false,
    'degraded 只表示「有端口但验不了监听者」；无端口可验时不标 degraded',
  );
});

test('degraded 语义：端口有人听但查不到监听者身份时，判就绪但标 degraded', async (t) => {
  if (process.platform === 'win32') return t.skip('本组测试造 posix detached 子进程形状');
  const holder = await occupyPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agint-restart-degraded2-'));
  t.after(() => { holder.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const { reqPath, stateDir } = writeRequest(dir, {
    readiness: { leasePath: null, port: holder.port, timeoutMs: 800 },
  });

  // 让 findListenerPid 查不到：把 PATH 掏空，ss / lsof 都不可达。
  // 此时 waitReady 应保持旧行为判就绪（探测不了不等于没起来），
  // 但必须标 degraded，让下游看得出这一轮**没验成**监听者身份。
  const prevPath = process.env.PATH;
  try {
    execFileSync(process.execPath, [RESPAWN, reqPath], {
      stdio: 'ignore',
      env: { ...process.env, PATH: '' },
    });
  } finally {
    process.env.PATH = prevPath;
  }

  const result = readResult(stateDir);
  assert.equal(result.ready, true, '探测能力不足时保持旧行为判就绪，不制造假失败');
  assert.equal(result.readyDegraded, true, '但必须标 degraded —— 不许把「没验成」读成「验过了」');
  assert.equal(result.listenerPid, null, '查不到监听者时如实记 null，不猜');
});