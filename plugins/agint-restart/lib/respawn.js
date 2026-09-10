#!/usr/bin/env node
/**
 * agint-restart — respawn helper（独立守护进程，零依赖，只吃 node 内置模块）
 *
 * 为什么需要它：
 *   dsh 重启不能由「正在退出的进程自己」完成——新实例如果在旧进程还占着
 *   3080 端口时启动，会直接 EADDRINUSE 起不来。所以流程拆成两步：
 *     1) 插件（在 dsh 进程内）写一份 request.json，detached 拉起本脚本，然后自己退出
 *     2) 本脚本等旧 pid 真的消失 + 端口释放，再拉起新 dsh，并等它就绪
 *   本脚本是独立进程，父进程（dsh）退出后它变成孤儿继续跑，不受影响。
 *
 * 用法：
 *   node respawn.js <request.json>
 *
 * request.json 由 lib/index.js 生成，字段见 readRequest() 的校验注释。
 * 结果写两份：
 *   - <stateDir>/restart-result.json  机器可读（插件下次启动可读）
 *   - <stateDir>/restart.log          人类可读（追加）
 * 新 dsh 自身的 stdout/stderr 重定向到 request.logFile（默认 %TEMP%/dsh-web.log）。
 */
import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync, openSync, closeSync, statSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import net from 'node:net';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 轮询间隔：重启链路的固定开销全靠这几个值，容忍度是"多几次无副作用的探测"。
// 旧值统一 500/1000ms 时，退出确认 + 就绪确认合计要多等约 2 秒。
const POLL_EXIT_MS = 200;   // 等旧进程退出
const POLL_PORT_MS = 200;   // 等端口释放
const POLL_READY_MS = 250;  // 等新实例就绪（探测本身很轻：stat 文件 + TCP connect）

/** 追加一行人类可读日志（失败不影响主流程）。 */
function log(logFile, msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, line);
  } catch { /* 日志写不出去也不能让重启失败 */ }
}

/** 进程是否还活着（信号 0 = 只探测不发送）。 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** TCP 端口是否能连上（能连 = 还有人在监听）。 */
function portInUse(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    let done = false;
    const finish = (v) => { if (!done) { done = true; sock.destroy(); resolve(v); } };
    sock.setTimeout(1000);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

/** 强制杀进程：win32 用 taskkill /F，posix 用 SIGKILL。 */
function forceKill(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/F', '/PID', String(pid)], () => resolve());
    } else {
      try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
      resolve();
    }
  });
}

/** 读并校验 request.json。缺关键字段直接抛（调用方会记日志退出）。 */
function readRequest(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (!raw || typeof raw.targetPid !== 'number') throw new Error('request.targetPid 缺失');
  const launch = raw.launch ?? {};
  if (typeof launch.command !== 'string' || !Array.isArray(launch.args)) {
    throw new Error('request.launch.{command,args} 缺失——无法决定怎么拉起 dsh');
  }
  return raw;
}

/** 等旧进程退出；超时则（可选）强杀。 */
async function waitForExit(pid, waitMs, forceAfterMs, logFile) {
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    if (!isAlive(pid)) return { exited: true, forced: false, waitedMs: Date.now() - started };
    await sleep(POLL_EXIT_MS);
  }
  if (forceAfterMs > 0 && isAlive(pid)) {
    log(logFile, `respawn: PID ${pid} ${waitMs}ms 未退出，执行强杀`);
    await forceKill(pid);
    const killStart = Date.now();
    while (Date.now() - killStart < 15000) {
      if (!isAlive(pid)) return { exited: true, forced: true, waitedMs: Date.now() - started };
      await sleep(POLL_EXIT_MS);
    }
    return { exited: false, forced: true, waitedMs: Date.now() - started };
  }
  return { exited: !isAlive(pid), forced: false, waitedMs: Date.now() - started };
}

/** 等端口释放（旧进程已死但 socket 处于 TIME_WAIT 时也能等到）。 */
async function waitPortFree(port, timeoutMs, logFile) {
  if (!port) return { free: true, waitedMs: 0 };
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!(await portInUse(port))) return { free: true, waitedMs: Date.now() - started };
    await sleep(POLL_PORT_MS);
  }
  log(logFile, `respawn: 端口 ${port} ${timeoutMs}ms 仍未释放（新实例可能 EADDRINUSE）`);
  return { free: false, waitedMs: Date.now() - started };
}

/** 拉起新 dsh：detached + stdio 重定向到日志，父进程退出不影响它。 */
function launchProcess(launch, logFile) {
  let fd;
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    fd = openSync(logFile, 'a');
  } catch {
    fd = 'ignore';
  }
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd || process.cwd(),
    env: { ...process.env, ...(launch.env ?? {}) },
    detached: true,
    stdio: ['ignore', fd === 'ignore' ? 'ignore' : fd, fd === 'ignore' ? 'ignore' : fd],
    windowsHide: true,
  });
  child.unref();
  if (typeof fd === 'number') closeSync(fd);
  return child.pid;
}

/** 等新实例就绪：lease 文件被刷新 或 端口可连，二者任一即算成功。 */
async function waitReady(readiness, logFile) {
  const { leasePath, port, timeoutMs } = readiness;
  const started = Date.now();
  const before = leasePath && existsSync(leasePath) ? safeMtime(leasePath) : 0;
  while (Date.now() - started < timeoutMs) {
    if (leasePath && existsSync(leasePath) && safeMtime(leasePath) > before) {
      return { ready: true, signal: 'lease', waitedMs: Date.now() - started };
    }
    if (port && (await portInUse(port))) {
      return { ready: true, signal: 'port', waitedMs: Date.now() - started };
    }
    await sleep(POLL_READY_MS);
  }
  log(logFile, `respawn: ${timeoutMs}ms 内未观测到就绪信号（lease=${leasePath} port=${port}）`);
  return { ready: false, signal: null, waitedMs: Date.now() - started };
}

function safeMtime(p) {
  try { return statSync(p).mtimeMs; } catch { return 0; }
}

async function main() {
  const reqPath = process.argv[2];
  if (!reqPath) {
    console.error('usage: node respawn.js <request.json>');
    process.exit(2);
  }
  let req;
  try {
    req = readRequest(reqPath);
  } catch (err) {
    console.error('[agint-restart] respawn: bad request:', err.message);
    process.exit(2);
  }

  const stateDir = req.stateDir || dirname(reqPath);
  const logFile = join(stateDir, 'restart.log');
  const resultFile = join(stateDir, 'restart-result.json');
  const result = {
    requestId: req.requestId ?? null,
    reason: req.reason ?? null,
    requestedAt: req.requestedAt ?? null,
    startedAt: new Date().toISOString(),
    targetPid: req.targetPid,
  };

  log(logFile, `respawn: 开始 (request=${req.requestId ?? '-'} targetPid=${req.targetPid} reason=${req.reason ?? '-'})`);

  // 1. 等旧进程退出
  const exit = await waitForExit(req.targetPid, req.waitExitMs ?? 30000, req.forceKillAfterMs ?? 20000, logFile);
  result.exit = exit;
  log(logFile, `respawn: 旧进程 exited=${exit.exited} forced=${exit.forced} waited=${exit.waitedMs}ms`);

  // 2. 等端口释放
  const portFree = await waitPortFree(req.readiness?.port, req.portFreeTimeoutMs ?? 15000, logFile);
  result.portFree = portFree;

  // 3. 拉起新实例
  try {
    result.newPid = launchProcess(req.launch, req.logFile || join(stateDir, 'dsh-web.log'));
    result.launched = true;
    log(logFile, `respawn: 新实例已拉起 pid=${result.newPid} cmd=${req.launch.command} ${req.launch.args.join(' ')}`);
  } catch (err) {
    result.launched = false;
    result.error = String(err?.message ?? err);
    log(logFile, `respawn: 拉起失败 ${result.error}`);
  }

  // 4. 等就绪
  if (result.launched) {
    const ready = await waitReady(req.readiness ?? {}, logFile);
    result.ready = ready.ready;
    result.readySignal = ready.signal;
    result.readyWaitedMs = ready.waitedMs;
    log(logFile, `respawn: 就绪=${ready.ready} 信号=${ready.signal ?? '-'} waited=${ready.waitedMs}ms`);
  } else {
    result.ready = false;
    result.readySignal = null;
  }

  result.finishedAt = new Date().toISOString();
  result.ok = Boolean(result.launched && result.ready);
  try {
    writeFileSync(resultFile, JSON.stringify(result, null, 2));
  } catch { /* ignore */ }
  log(logFile, `respawn: 完成 ok=${result.ok}`);
}

main().catch((err) => {
  console.error('[agint-restart] respawn: fatal:', err);
  process.exit(1);
});
