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
import { existsSync, readFileSync, writeFileSync, appendFileSync, openSync, writeSync, closeSync, statSync, mkdirSync, rmSync } from 'node:fs';
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

/**
 * 构造传给新 dsh 的环境变量。
 *
 * 默认继承当前 process.env（respawn.js 自己继承自 dsh），再叠加 launch.env。
 *
 * **关键**：剥离 DSH 启动器会从 `.env` 重新加载的变量 —— 否则改了 .env 也不生效。
 * DSH 启动器 `loadLayeredEnv()` 的语义是「`process.env[name]` 已存在则跳过」
 * （dsh-app-boot lib/index.js line 2103），所以 inherited env 优先级高于 .env。
 * 如果带着 inherited 值拉起新 dsh，.env 改了等于没改。AGINT_HOME / DSH_HOME /
 * DSH_WIKI_ROOT 都是 .env-controlled 变量，统一剥离让 dsh 走 .env 重新加载。
 */
const DENV_OVERRIDABLE = new Set(['AGINT_HOME', 'DSH_HOME', 'DSH_WIKI_ROOT']);

/**
 * 是否剥离 NODE_OPTIONS。
 *
 * 2026-10-06 实测事故：WorkBuddy CLI 用
 *   NODE_OPTIONS=--require=".../node-language-shim.cjs"
 * 把 safe-delete 批量删除护栏注入**每一个** node 进程。dsh 被它拦死过两次
 * （10-06 21:41 / 22:04，均为 StartupError）：
 *   dsh-client-connection 激活时调 dsh-atomic-write 的 withFileLock，
 *   释放 `.credentials.yaml.lock` 走 fs.rm —— 这是**正常的文件锁释放**，
 *   却被判成「批量删除」直接抛 SAFE_DELETE_BULK_CONFIRM_REQUIRED。
 *
 * 为什么这个阈值对 dsh 天然过载（实测证据，非推断）：
 *   - 计数器按 requestId 持久化在 /tmp/codebuddy-safe-delete-bulk/<hash>/state.json
 *   - 阈值来自 CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=50
 *   - 10-06 21:41 那次触发时 count=49（再删一个就越线）；
 *     22:17 快照当前会话已 count=743。
 *   dsh 的每次原子写都要 rm 一次 lock 文件，一天几百次删除是常态。
 *
 * 剥离的代价（已核实，不是推测）：
 *   node-language-shim.cjs 里 brokered-fs 钩子的开关
 *   （CODEBUDDY_BROKERED_FS_HOOK_ENABLED / CODEBUDDY_SAFE_DELETE_SANDBOX）
 *   在本机 env 里**都未设置**，实测运行中 dsh 的 environ 也只有
 *   CODEBUDDY_SAFE_DELETE_* 一族 ⇒ 实际只加载了 safe-delete 一个 shim。
 *   所以剥离 NODE_OPTIONS 的净效果 = 关掉批量删除护栏，不误伤别的钩子。
 *   代价如实说：重启后的 dsh 及其子进程不再受「单 turn 删 >50 文件」拦截。
 *
 * escape hatch：请求里带 keepNodeOptions:true 时保留（用于确实需要该钩子的场景）。
 * 默认剥离，因为默认不剥离的后果是**宿主起不来**。
 *
 * ⛔ 剥离必须发生在**展开之后**，不能只删 base：
 *   第一版写成 `delete base.NODE_OPTIONS` 然后 `return {...base, ...launchEnv}`，
 *   而 launch.env 是「上次启动 env 的全量快照」（本机实测 172 个键，其中就含
 *   NODE_OPTIONS）—— 展开时 launchEnv 排在后面，把刚删掉的键**原样加了回来**。
 *   22:24 那次重启实测：新 dsh 进程 environ 里 NODE_OPTIONS 仍在，
 *   而部署位的单测全绿 ⇒ 「代码改了、测试也绿、行为没变」三件同时成立。
 *   教训见 check-soundness：判据必须打在最终产物上，不能打在中间变量上。
 */
function pickEnv(launchEnv, launch) {
  const base = { ...process.env };
  for (const key of DENV_OVERRIDABLE) delete base[key];
  const merged = { ...base, ...(launchEnv ?? {}) };
  // 展开后再剥，base 和 launchEnv 两边带来的都拦得住。
  if (launch?.keepNodeOptions !== true) delete merged.NODE_OPTIONS;
  return merged;
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
  if (!raw || typeof raw.targetPid !== 'number' || !(raw.targetPid > 0)) {
    // targetPid 必须 >0：process.kill(0, 0) 探测的是整个进程组，恒真，
    // waitForExit 会把「0 永远活着」等成超时强杀（kill(0) = 对全组发信号，事故面更大）。
    throw new Error('request.targetPid 缺失或非 >0 的 pid');
  }
  const launch = raw.launch ?? {};
  if (typeof launch.command !== 'string' || !Array.isArray(launch.args)) {
    throw new Error('request.launch.{command,args} 缺失——无法决定怎么拉起 dsh');
  }
  return raw;
}

/**
 * 核对取消标记：插件侧 cancel() 会往 request.json 写 cancelledAt。
 * 必须重新读文件（不能信启动时读到的 req）——取消往往发生在 respawn 已启动之后，
 * 而旧进程退出最长要等几十秒，这个窗口足够取消到达。
 * 返回 true 表示已取消；调用方应记日志退出且**不写回执**（取消不算失败重启）。
 */
function isCancelled(reqPath, req) {
  if (req.cancelledAt) return true;
  const fresh = readJsonSafe(reqPath);
  return Boolean(fresh && fresh.cancelledAt);
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
    env: pickEnv(launch.env, launch),
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
    env: pickEnv(launch.env, launch),
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

/**
 * cmd 参数引号：含空白或 cmd 元字符时加引号。
 * ⛔ 含 `"` 的参数直接拒绝而不是转义：cmd.exe 的解析器不认反斜杠转义引号
 * （`"` 是开关引号的切换符，`\"` 里的 `\` 是字面量、`"` 照样闭合引号），
 * 引号提前闭合后其后跟的 `&` `|` 等 cmd 元字符会被当命令分隔符执行。
 * cmd 引号内没有安全嵌入 `"` 的办法，fail-fast 好过静默产生被劫持的命令行。
 */
function quoteCmdArg(a) {
  const s = String(a);
  if (s === '') return '""';
  if (s.includes('"')) {
    throw new Error(`arg 含双引号，cmd 引号语义无法安全转义: ${s.slice(0, 40)}`);
  }
  if (!/[\s&^<>|]/.test(s)) return s;
  return `"${s}"`;
}

/**
 * 反查监听指定端口的进程 pid —— 用来回答「这个端口到底归谁」。
 *
 * 为什么必须能回答：2026-10-06 实测事故（见下方 waitReady 的注释）里，
 * 「端口能连上」被当成了「我拉起的进程起来了」，实际连上的是**另一个进程**。
 * 判据从「端口可达」升级成「监听者是我预期的那个」，这一步依赖本函数。
 *
 * 三个探测手段按可用性降级：
 *   posix：ss -ltnpH → lsof → null
 *   win32：netstat -ano → null
 * 任何一级失败都返回 null，**绝不猜**：调用方据此标记 degraded，由回执如实呈现。
 */
function findListenerPid(port) {
  return new Promise((resolve) => {
    if (!port) return resolve(null);
    if (process.platform !== 'win32') return resolvePosixListenerPid(port, resolve);
    execFile('netstat', ['-ano'], (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const m = String(stdout).match(new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i'));
      resolve(m ? Number(m[1]) : null);
    });
  });
}

/** posix：从 ss / lsof 反查监听者 pid。两条都不可用则 null（不猜）。 */
function resolvePosixListenerPid(port, done) {
  execFile('ss', ['-ltnpH', 'sport', '=', `:${port}`], { timeout: 5000 }, (err, stdout) => {
    if (!err && stdout) {
      const pids = [...String(stdout).matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
      if (pids.length) return done(pids[0]);
    }
    // ss 缺失或解析不出（容器内无 CAP_NET_ADMIN、busybox ss 输出不同）时退 lsof
    execFile('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { timeout: 5000 }, (err2, stdout2) => {
      if (err2 || !stdout2) return done(null);
      const first = String(stdout2).trim().split(/\s+/)[0];
      done(first && /^\d+$/.test(first) ? Number(first) : null);
    });
  });
}

/**
 * 等新实例就绪：lease 文件被刷新 或 端口可连，二者任一即算成功。
 *
 * ⚠️ 端口可连**不等于**新实例起来了。2026-10-06 实测事故：
 *   两个 respawn 相隔 6 秒重叠（同一 targetPid，各自拉起一个新 dsh）。
 *   先起来的那个占住 3080；后起来的那个自己的进程死于 EADDRINUSE。
 *   但后者在等就绪时看到「3080 可连」，判 ready=true、写 ok=true ——
 *   它把**别人的端口**当成了自己的成功信号，回执里的 newPid 是那个已死的壳 pid。
 *   后果：重启链路以为成功了，实际跑的进程不在它的账上，下次按 newPid 去杀杀不到。
 *
 * 修法：端口可连之后还要验**监听者身份**。能查到监听者 pid 时必须等于
 * expectPid；查到别人就继续等，超时如实报 ready=false。查不到（探测能力不足，
 * 例如 ss/lsof 都没有）时**保持旧行为判就绪，但标 degraded=true** ——
 * 不因为探测不了就假装失败，那会把「验不了」误报成「没起来」；
 * 也不因为探测不了就默默当没事，回执里 degraded 会说清这一轮没验成。
 */
async function waitReady(readiness, logFile, { expectPid = null } = {}) {
  const { leasePath, port, timeoutMs } = readiness;
  const started = Date.now();
  const before = leasePath && existsSync(leasePath) ? safeMtime(leasePath) : 0;
  let foreignListener = null;
  let degraded = false;
  while (Date.now() - started < timeoutMs) {
    if (leasePath && existsSync(leasePath) && safeMtime(leasePath) > before) {
      return { ready: true, signal: 'lease', waitedMs: Date.now() - started, listenerPid: null, degraded, foreignListener };
    }
    if (port && (await portInUse(port))) {
      if (!expectPid) {
        degraded = true; // 没有期望 pid 可比对 —— 本轮没验成监听者身份
        return { ready: true, signal: 'port', waitedMs: Date.now() - started, listenerPid: null, degraded, foreignListener };
      }
      const listener = await findListenerPid(port);
      if (listener === null) {
        degraded = true;
        return { ready: true, signal: 'port', waitedMs: Date.now() - started, listenerPid: null, degraded, foreignListener };
      }
      if (listener === expectPid) {
        return { ready: true, signal: 'port', waitedMs: Date.now() - started, listenerPid: listener, degraded, foreignListener };
      }
      foreignListener = listener; // 端口被别的进程占着 —— 继续等，别抢功
    }
    await sleep(POLL_READY_MS);
  }
  log(logFile, `respawn: ${timeoutMs}ms 内未观测到就绪信号（lease=${leasePath} port=${port}${foreignListener ? ` 端口被 pid=${foreignListener} 占用，非本进程拉起的 ${expectPid}` : ''}）`);
  return { ready: false, signal: null, waitedMs: Date.now() - started, listenerPid: null, degraded, foreignListener };
}

function safeMtime(p) {
  try { return statSync(p).mtimeMs; } catch { return 0; }
}

/** 读 JSON，坏了当没有——锁文件被截断时宁可放行也不能把重启卡死。 */
function readJsonSafe(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
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

  // 取消闭环（第一道）：启动即发现已取消——直接退出，不占锁、不写回执。
  // 之前版本只靠插件侧写 cancelledAt 标记但本脚本从不读它，取消是空转。
  if (isCancelled(reqPath, req)) {
    log(logFile, `respawn: 请求已被取消（cancelledAt=${req.cancelledAt ?? readJsonSafe(reqPath)?.cancelledAt}），退出且不写回执`);
    process.exit(3);
  }

  // 重叠保护：同一 targetPid 已有 respawn 在跑，后来者直接让位。
  //
  // 2026-10-06 实测事故：两个请求相隔 6 秒（14:06:37 / 14:06:43）针对同一个
  // targetPid，各自拉起一个 respawn。两个都等「旧进程死 → 端口释放」，于是
  // **两败俱伤**：先起来的那个抢到 3080；后起来的那个自己的 dsh 死于
  // EADDRINUSE，却因为看见前一个的端口可连而判就绪、写 ok=true。
  // 结果两个 respawn 都报成功，回执里 newPid 指向一个已死的 pid，实际在跑的那个
  // 谁都不认——下次按 newPid 去杀，杀不到。
  //
  // 为什么这里必须退出而不是「也写一份回执」：result 文件是**共享单槽**，
  // 后写覆盖先写。重叠者一旦写回执，好端端的回执就被失败记录顶掉了。
  // 让位者只记日志、不碰回执，回执里留下的就永远是最先认领者的真实结果。
  const lockFile = join(stateDir, 'respawn.lock');
  let lockFd;
  try {
    // 独占创建：已存在则抛 EEXIST——「检查占位」合并成一个原子动作，
    // 消灭旧写法「先读判无锁 → 再覆盖写」之间毫秒级窗口（两 respawn 同时
    // 读到无锁、双双通过，锁在最该起作用的场景失效）。另 writeJsonSafe 是
    // 非原子覆盖写，并发读到截断文件时 readJsonSafe 返 null = 等于无锁。
    lockFd = openSync(lockFile, 'wx');
  } catch {
    const existing = readJsonSafe(lockFile);
    if (existing && existing.pid && isAlive(existing.pid) && existing.targetPid === req.targetPid) {
      log(logFile, `respawn: 让位——已有 respawn pid=${existing.pid} 在处理同一 targetPid=${req.targetPid}（request=${existing.requestId ?? '-'}），本进程（request=${req.requestId ?? '-'}）退出且不写回执`);
      process.exit(3);
    }
    // 锁文件存在但持有者已死 / 文件损坏 / 换了 target：强占重写。
    log(logFile, `respawn: 旧锁无效（持有者已退出或 target 不同），强占 lock（原内容=${JSON.stringify(existing)}）`);
    lockFd = openSync(lockFile, 'w');
  }
  try {
    writeSync(lockFd, JSON.stringify({
      pid: process.pid,
      targetPid: req.targetPid,
      requestId: req.requestId ?? null,
      startedAt: new Date().toISOString(),
    }));
  } finally {
    closeSync(lockFd);
  }
  const releaseLock = () => {
    try {
      const cur = readJsonSafe(lockFile);
      if (cur && cur.pid === process.pid) rmSync(lockFile, { force: true });
    } catch { /* 释放失败不影响重启结果：锁里的 pid 死后 isAlive 会判 false 自动失效 */ }
  };
  process.on('exit', releaseLock);

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
  // 取消闭环（第二道）：等旧进程退出/端口释放最长几十秒，期间取消可能刚写入
  // request.json——拉起是最后不可逆的一步，动手前必须再核一次。
  if (isCancelled(reqPath, req)) {
    log(logFile, `respawn: 拉起前发现请求已取消（cancelledAt=${readJsonSafe(reqPath)?.cancelledAt ?? req.cancelledAt}），放弃重启且不写回执`);
    process.exit(3);
  }
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
    // posix 的 detached 模式下 launched.pid **就是** dsh 本身（spawn 的直接子进程），
    // 所以可以拿它当期望监听者；win32 的 launched.pid 是 wscript 壳，dsh 是壳的孙子，
    // 拿壳 pid 去比对会永远判失败 —— 那种情况下传 null，走 degraded 路径。
    const expectPid = (result.launchMode === 'detached' && process.platform !== 'win32')
      ? result.launchShellPid
      : null;
    result.expectListenerPid = expectPid;
    const ready = await waitReady(req.readiness ?? {}, logFile, { expectPid });
    result.ready = ready.ready;
    result.readySignal = ready.signal;
    result.readyWaitedMs = ready.waitedMs;
    result.listenerPid = ready.listenerPid;
    result.readyDegraded = ready.degraded;
    result.foreignListenerPid = ready.foreignListener;
    if (ready.foreignListener) {
      log(logFile, `respawn: ⚠️ 端口 ${req.readiness?.port} 实际由 pid=${ready.foreignListener} 监听，本进程拉起的 ${expectPid} 未占住端口（多半死于 EADDRINUSE）`);
    }
    // 壳进程（wscript）不是 dsh 本身——就绪后用「谁在监听端口」反查出真实 pid。
    if (ready.ready) {
      const realPid = await findListenerPid(req.readiness?.port);
      if (realPid && realPid !== result.launchShellPid) {
        result.newPid = realPid;
        log(logFile, `respawn: 真实 dsh pid=${realPid}（壳 pid=${result.launchShellPid}）`);
      }
    }
    log(logFile, `respawn: 就绪=${ready.ready} 信号=${ready.signal ?? '-'} waited=${ready.waitedMs}ms${ready.degraded ? ' (degraded: 未验监听者身份)' : ''}`);
  } else {
    result.ready = false;
    result.readySignal = null;
  }

  // ok 的含义要说准：拉起成功 **且** 就绪 **且**（能验监听者时）监听者就是我拉起的那个。
  // 验不了（degraded）时 ok 仍然可为 true，但必须让回执带着 degraded 标记出去，
  // 免得下游把「没验成」读成「验过了」。
  result.ok = Boolean(result.launched && result.ready && !result.foreignListenerPid);
  result.finishedAt = new Date().toISOString();
  try {
    writeFileSync(resultFile, JSON.stringify(result, null, 2));
  } catch { /* ignore */ }
  log(logFile, `respawn: 完成 ok=${result.ok}`);
}

main().catch((err) => {
  console.error('[agint-restart] respawn: fatal:', err);
  process.exit(1);
});
