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
 * Windows 上的硬性要求（否则新 dsh 会「每调一次工具弹一次黑框」）：
 *   新 dsh 必须**拥有一个控制台**，否则它的子进程会各自新建控制台窗口。
 *   缘由见 launchHiddenWin32 的注释——dsh 的 Windows 沙箱刻意不做控制台隔离，
 *   前提就是「子进程共享宿主控制台」。detached / windowsHide 都会抹掉这个前提。
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
import { existsSync, readFileSync, writeFileSync, appendFileSync, openSync, closeSync, statSync, mkdirSync, rmSync } from 'node:fs';
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

/** 拉起新 dsh：按平台分发。win32 见 launchHiddenWin32 的说明。 */
function launchProcess(launch, logFile, stateDir, { forceDetached = false } = {}) {
  if (process.platform !== 'win32' || forceDetached) {
    return { mode: 'detached', pid: launchDetachedPosix(launch, logFile) };
  }
  return { mode: 'hidden', pid: launchHiddenWin32(launch, logFile, stateDir) };
}

/**
 * 探测「WScript 隐藏启动」链路是否可用（wscript.exe 被组策略禁用 / 缺失时不可用）。
 * 这是保命用的：探测失败就回退到旧的 detached 方式——虽然会弹窗，但 dsh 至少能起来。
 * 用 `Run(cmd, 0, True)`（True = 等待）跑一个只写一个标记文件的 .cmd，然后看文件在不在。
 */
function canHideLaunch(stateDir) {
  return new Promise((resolve) => {
    const cmdPath = join(stateDir, 'respawn-probe.cmd');
    const vbsPath = join(stateDir, 'respawn-probe.vbs');
    const outPath = join(stateDir, 'respawn-probe.out');
    try {
      mkdirSync(stateDir, { recursive: true });
      rmSync(outPath, { force: true });
      writeFileSync(cmdPath, `@echo off\r\necho ok > ${quoteCmdArg(outPath)}\r\n`);
      writeFileSync(vbsPath, `CreateObject("WScript.Shell").Run ${quoteVbsString(cmdPath)}, 0, True\r\n`);
    } catch {
      return resolve(false);
    }
    execFile('wscript.exe', [vbsPath], { timeout: 10000, windowsHide: true }, (err) => {
      resolve(!err && existsSync(outPath));
    });
  });
}

/** POSIX：detached spawn + stdio 重定向到日志，父进程退出不影响它。 */
function launchDetachedPosix(launch, logFile) {
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
  });
  child.unref();
  if (typeof fd === 'number') closeSync(fd);
  return child.pid;
}

/**
 * win32：借 WScript 的「隐藏窗口」启动，让新 dsh 拥有一个**不可见的控制台**。
 *
 * 为什么不能用 spawn 的 detached / windowsHide：
 *   - `detached: true`  → DETACHED_PROCESS：新进程**没有**控制台
 *   - `windowsHide: true` → CREATE_NO_WINDOW：新进程**也没有**控制台
 *   两者都会让 dsh 变成"无控制台的孤儿"。而 dsh 的沙箱（dsh-sandbox-windows-acl）
 *   在源码里明确写着控制台隔离是**故意不加**的——它的前提是"子进程共享宿主控制台"。
 *   宿主没有控制台时，Windows 会给每个新建的控制台进程分配一个新窗口：表现为
 *   **每调一次工具就弹一次黑框**（沙箱子进程、node-pty 辅助进程、pwsh 工具…）。
 *
 * WScript.Shell.Run(cmd, 0, False) 的窗口风格 0 = SW_HIDE：窗口不可见，但进程
 * **真的分配到了一个控制台**，此后 dsh 的所有子进程共享它，不再新建窗口。
 * Node 的 spawn 表达不出这个语义（它只有"没有控制台"和"继承父控制台"两种），
 * 所以绕一层 WScript。中间再包一个 .cmd 接管 stdout/stderr 重定向
 * （VBS 的 Run 本身不支持重定向）。
 *
 * 返回值是壳进程（wscript）的 pid；真实 dsh pid 在就绪后由 findListenerPid 反查补上。
 */
function launchHiddenWin32(launch, logFile, stateDir) {
  const cwd = launch.cwd || process.cwd();
  const cmdPath = join(stateDir, 'respawn-launch.cmd');
  const vbsPath = join(stateDir, 'respawn-launch.vbs');

  const argv = [launch.command, ...launch.args].map(quoteCmdArg).join(' ');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    cmdPath,
    '@echo off\r\n' +
      `cd /d ${quoteCmdArg(cwd)}\r\n` +
      `${argv} >> ${quoteCmdArg(logFile)} 2>&1\r\n`,
  );
  writeFileSync(
    vbsPath,
    `CreateObject("WScript.Shell").Run ${quoteVbsString(cmdPath)}, 0, False\r\n`,
  );

  const child = spawn('wscript.exe', [vbsPath], {
    cwd,
    env: { ...process.env, ...(launch.env ?? {}) },
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

/** VBS 字符串字面量：内容里的 " 写成 ""。 */
function quoteVbsString(s) {
  return `"${String(s).replace(/"/g, '""')}"`;
}

/** cmd 参数引号：含空白或 cmd 元字符时加引号（内部 " 转义为 \"）。 */
function quoteCmdArg(a) {
  const s = String(a);
  if (s === '') return '""';
  if (!/[\s"&^<>|]/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

/** 反查监听指定端口的进程 pid（win32 走 netstat -ano）——用来把壳 pid 换成真实 dsh pid。 */
function findListenerPid(port) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !port) return resolve(null);
    execFile('netstat', ['-ano'], (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const m = String(stdout).match(new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i'));
      resolve(m ? Number(m[1]) : null);
    });
  });
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

  // 3. 拉起新实例（win32 先探测隐藏启动链路是否可用，不可用则回退 detached 保底）
  try {
    const needHidden = process.platform === 'win32' && !(await canHideLaunch(stateDir));
    if (needHidden) log(logFile, 'respawn: 隐藏启动链路不可用（wscript 探测失败），回退到 detached 方式');
    const launched = launchProcess(req.launch, req.logFile || join(stateDir, 'dsh-web.log'), stateDir, {
      forceDetached: needHidden,
    });
    result.launchMode = launched.mode;
    result.launchShellPid = launched.pid;
    result.newPid = launched.pid;
    result.launched = true;
    log(logFile, `respawn: 新实例已拉起 mode=${launched.mode} shellPid=${launched.pid} cmd=${req.launch.command} ${req.launch.args.join(' ')}`);
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
    // 壳进程（wscript）不是 dsh 本身——就绪后用「谁在监听端口」反查出真实 pid。
    if (ready.ready) {
      const realPid = await findListenerPid(req.readiness?.port);
      if (realPid && realPid !== result.launchShellPid) {
        result.newPid = realPid;
        log(logFile, `respawn: 真实 dsh pid=${realPid}（壳 pid=${result.launchShellPid}）`);
      }
    }
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
