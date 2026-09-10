/**
 * agint-restart v0.2.0 — Cordis 入口
 *
 * 两件事：
 *   A. 重启检测 + 信息性消息投递（v0.1.0 能力，保留）
 *      —— DSH 重启后向主 agent 投递"中断时长 + 上次活跃会话"，由 agent 自主决定下一步。
 *   B. 主动重启能力（v0.2.0 新增）
 *      —— 提供 agint.restart 服务，可被工具/其他插件调用，真正把 dsh 拉起来。
 *
 * 重启为什么必须靠外部守护脚本（lib/respawn.js）：
 *   正在退出的进程不能自己拉起继任者——新实例会在旧进程还占着 3080 端口时
 *   EADDRINUSE 直接失败。所以拆成：
 *     1) 本插件写 request.json + detached 拉起 respawn.js，然后自己退出
 *     2) respawn.js 等旧 pid 消失 + 端口释放 → 拉起新 dsh → 等就绪 → 写结果
 *
 * 设计来源：nickkkkkk123123/dsh-resume-on-restart（MIT）——v0.1.0 部分 scope 1:1 移植。
 * 与上游的关键差异：
 *   1. 优雅关闭走 cordis dispose 钩子（避免上游 SIGTERM 二次 kill bug）
 *   2. 持久化目录 ~/.dsh/.agint-restart/（区别于上游的 .resume-on-restart）
 *   3. brand 前缀从 `[resume-on-restart]` 改为 `[agint-restart]`
 *   4. cordis.patch.yml 不自动挂顶层（AGINT 红线：首次挂载走 safe-update）
 *   5. v0.2.0 新增：主动重启 + 三重护栏（confirm / cooldown / 熔断）
 *
 * 兼容性：本插件只依赖 cordis ctx 的 `agents` 服务，不 import 任何 `@deepseek-ai/dsh-*`
 * 内部包，因此可在 DSH Desktop 打包环境（app.asar）下运行。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildNotice, detectRestart, shouldNotify } from './detect.js';
import {
  cancelResult, requestAccepted, requestDeny, requestDryRun, requestInternalError, requestManual,
} from './contract.js';

const name = 'agint-restart';

/** 需要的注入服务：agents（列出/访问 agent）。 */
const inject = ['agents'];

const DEFAULTS = {
  enabled: true,
  stateDir: '.agint-restart',
  target: 'primary',
  // v0.3.1：显式投递方式，取代语义反直觉的 wakeup 布尔
  //   wake   = followup = send(next-turn, wakeup=true)  → 唤醒 agent，真正开始干活
  //   silent = inject   = send(next-step, wakeup=false) → 只入收件箱，不唤醒（看不到回音）
  // 曾用名 queue/inject 仍作别名保留：queue→wake，inject→silent
  deliveryMode: 'wake',
  // 优先把通知投回"重启前最近活跃的会话"；匹配不到再回退 target 规则
  resumeLastSession: true,
  // 为"等旧会话复活"额外留出的时间（ms）；超时就接受回退目标。0 = 不等
  resumeWaitMs: 5000,
  // 相邻两次启动的间隔 < 这个窗口视为抖动，不投递（防连续 restart 反复弹通知）
  // 判据是"本次启动时间 - 上次启动时间"，**含上次进程的存活时长**。
  // 60s 太窄：验证重启时人工操作间隔常有 1-3 分钟，每次都会弹。5 分钟能覆盖连续验证场景。
  // 仅作用于"是否投递"分支；marker / status / 主动重启链路不受影响。<=0 表示关闭
  notifyDebounceMs: 300000,

  // ── v0.5.0：防弹窗 + 断环 ─────────────────────────────────────
  // 拉起新实例时，是否允许它自动打开浏览器。
  // 默认 false → 给 launch 参数补 `--no-open`。
  // 原因：`dsh web` 的 openBrowser 默认 true，插件每次拉起都会弹一次浏览器
  //      （2026-09-10 实测：16 次重启 = 16 次 "opening the default browser"）。
  // 入口页 URL/token 仍会打印在新实例日志里，需要时可手动打开。
  openBrowserOnRestart: false,
  // 自触发重启（agent 自己调 restart_request）是否也投递"恢复"通知。
  // 默认 false：切断「通知唤醒 agent → agent 干活 → agent 自己重启 → 又通知」的自维持环。
  // 理由：发起者就是 agent 自己，它知道这次重启；恢复通知是给"意外/外部中断"用的。
  // 外部重启（老板手动、进程崩溃）不受影响，照常投递。
  resumeOnSelfRestart: false,

  notice: '',
  // 关闭前"活跃即视为与任务相关"的宽限窗口（ms）
  shutdownGraceMs: 600000,
  // 活动追踪时忽略的会话 id 前缀（如多代理团队的根会话）
  ignoredSessionPrefixes: ['head-'],

  // ── v0.2.0：主动重启 ──────────────────────────────────────────
  // auto = 真拉起；manual = 只生成请求 + 命令，等人工执行（最安全）
  mode: 'auto',
  // 两次重启之间的最小间隔（ms），防止抖动
  cooldownMs: 60000,
  // 熔断：burstWindowMs 内达到 burstMax 次 → 拒绝后续请求（防重启循环）
  burstWindowMs: 600000,
  burstMax: 3,
  // 拉起新实例前，等旧进程退出的时间；超时则强杀（0 = 不强杀）
  waitExitMs: 30000,
  forceKillAfterMs: 20000,
  // 等端口释放时间
  portFreeTimeoutMs: 15000,
  // 就绪判定：lease 文件被刷新 或 端口可连
  readiness: {
    leasePath: 'sentinel.lease',  // 相对 DSH_HOME；null 表示只看端口
    port: 3080,
    timeoutMs: 60000,
  },
  // 新 dsh 的 stdout/stderr 落盘位置
  logFile: join(tmpdir(), 'dsh-web.log'),
  // 退出自身的方式：exit = process.exit；signal = 发 SIGTERM（win32 无真信号，默认 exit）
  exitStrategy: process.platform === 'win32' ? 'exit' : 'signal',
  // 发出请求后延迟多久退出自己（留出时间让调用方拿到返回值）。
  // 这段延迟完全计入用户感知的"重启等待"：3s 实测偏保守，1.5s 足够工具返回值落盘。
  shutdownDelayMs: 1500,
  // 手动覆盖拉起命令（默认从当前进程快照自动推断）
  launch: null,
};

/** 解析 DSH_HOME：优先环境变量，回退到用户主目录下的 .dsh。 */
function resolveDshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/**
 * 投递方式别名表。真实语义来自 dsh-agent-loop/lib/index.js：
 *   followup(input) { this.send(input, "next-turn", true); }   ← wakeup=true，会唤醒 driver
 *   inject(input)   { this.send(input, "next-step", false); }  ← wakeup=false，只入收件箱
 * 即：**inject 不会唤醒 agent**，消息进去了也没人处理、不会落盘、UI 上看不到。
 * 想要"重启后 agent 自动续跑"必须用 wake（= followup）。
 */
const DELIVERY_ALIASES = {
  wake: 'wake',      // 推荐名：唤醒 agent 真正干活
  queue: 'wake',     // v0.3.0 用过的名字，语义其实是"唤醒"，保留别名
  silent: 'silent',  // 只入收件箱，等下次被别的输入唤醒时才处理
  inject: 'silent',  // 直译底层方法名，保留别名
};

/**
 * 解析投递方式。
 * 优先用显式 `deliveryMode`；未给出时回退到旧的 `wakeup` 布尔
 * （wakeup:true → wake，wakeup:false → silent），避免升级后行为突变。
 */
export function resolveDeliveryMode(config) {
  const explicit = config?.deliveryMode;
  if (explicit && DELIVERY_ALIASES[explicit]) return DELIVERY_ALIASES[explicit];
  if (Object.prototype.hasOwnProperty.call(config ?? {}, 'wakeup')) {
    return config.wakeup === false ? 'silent' : 'wake';
  }
  return 'wake';
}

/** 会话 id 是否以给定前缀开头（用于排除不需要追踪的会话）。 */
function ignoredByPrefix(sessionId, prefixes) {
  return (prefixes || []).some((p) => String(sessionId).startsWith(p));
}

/** 记录唤醒/投递结果到 markerDir/wake.log。 */
function writeWakeLog(markerDir, deliveredTo, ok, error, extra) {
  try {
    writeFileSync(join(markerDir, 'wake.log'), JSON.stringify({
      deliveredTo, ok, error: error ?? null, at: new Date().toISOString(), ...(extra ?? {}),
    }), 'utf8');
  } catch (e) { /* ignore */ }
}

/** 手写一条用户消息对象（等价于 @deepseek-ai/dsh-llm 的 createUserMessage）。 */
function createUserMessage({ content, source }) {
  return {
    role: 'user',
    content,
    source,
    id: randomUUID(),
  };
}

/** 读 JSON 文件，缺失/损坏返回 fallback（不抛）。 */
function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 写 JSON 文件（原子性要求不高，直接覆盖；失败只 warn）。 */
function writeJson(path, doc) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(doc, null, 2));
    return true;
  } catch (err) {
    console.warn('[agint-restart] write failed:', path, err?.message ?? err);
    return false;
  }
}

/** 快照环境变量：剔除易变的 shell 噪声，其余原样传给新进程。 */
function snapshotEnv() {
  const drop = new Set(['_', 'OLDPWD', 'PWD', 'SHLVL', '__CF_USER_TEXT_ENCODING']);
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (drop.has(k)) continue;
    if (k.startsWith('npm_config_') || k.startsWith('npm_lifecycle_')) continue;
    out[k] = v;
  }
  return out;
}

/** 推断"我当初是怎么被启动的"，供 respawn 复现。 */
function snapshotLaunch(override) {
  if (override && typeof override.command === 'string' && Array.isArray(override.args)) {
    return { ...override, cwd: override.cwd || process.cwd(), env: override.env ?? snapshotEnv() };
  }
  return {
    command: process.execPath,
    // argv[0]=node 自身，argv[1]=入口 js（dsh/lib/bin.js），其后是 'web' 等参数
    args: process.argv.slice(1),
    cwd: process.cwd(),
    env: snapshotEnv(),
  };
}

/**
 * 拉起参数归一化：给 `dsh web` 补 `--no-open`。
 *
 * 为什么需要：`dsh web` 的 openBrowser 默认 true（dsh-web-app: handoffBrowser），
 * 每次由 respawn 拉起都会走一次 `openBrowser(url)`，把浏览器再弹出来一遍。
 * 重启本就是后台行为，不该每次抢焦点开一个新标签/窗口。
 *
 * 只在"确实是 web 子命令"时动手；已显式给出 --no-open / --open[=x] 的一律不碰。
 * 要保留原来的"重启也开浏览器"行为，配 openBrowserOnRestart: true。
 */
export function normalizeLaunch(launch, config = {}) {
  if (!launch || config.openBrowserOnRestart === true) return launch;
  const args = Array.isArray(launch.args) ? launch.args : [];
  if (!args.includes('web')) return launch;
  if (args.some((a) => a === '--no-open' || a === '--open' || String(a).startsWith('--open='))) return launch;
  return { ...launch, args: [...args, '--no-open'] };
}

/**
 * 判断本次启动是否由插件自己发起的重启导致（agent 调 restart_request）。
 *
 * 判据（两个都要满足）：
 *   1. 请求文件的 targetPid === 上一次启动进程的 pid（marker.pid）——那次重启是它发起的
 *   2. 请求时间晚于上一次启动时间——请求确实来自那个进程，而不是更早的残留文件
 * 缺失/损坏/不匹配 → 一律视为外部重启（保守：宁可多投一条通知，也不吞掉真正的中断）。
 */
export function detectSelfRestart(marker, requestPath) {
  if (!marker) return { self: false, requestId: null, reason: null };
  try {
    const req = JSON.parse(readFileSync(requestPath, 'utf8'));
    if (!req || typeof req !== 'object') return { self: false, requestId: null, reason: null };
    const samePid = Number(req.targetPid) === Number(marker.pid);
    const afterBoot = typeof req.requestedAt === 'string'
      && typeof marker.lastBootAt === 'string'
      && Date.parse(req.requestedAt) > Date.parse(marker.lastBootAt);
    if (samePid && afterBoot) {
      return { self: true, requestId: req.requestId ?? null, reason: req.reason ?? null };
    }
  } catch { /* 无请求文件 / JSON 损坏 → 外部重启 */ }
  return { self: false, requestId: null, reason: null };
}

function apply(ctx, cfg = {}) {
  const config = { ...DEFAULTS, ...cfg };
  const readiness = { ...DEFAULTS.readiness, ...(cfg.readiness ?? {}) };
  if (!config.enabled) return;

  const markerDir = join(resolveDshHome(), config.stateDir);
  const markerPath = join(markerDir, 'marker.json');
  const requestPath = join(markerDir, 'restart-request.json');
  const resultPath = join(markerDir, 'restart-result.json');
  const historyPath = join(markerDir, 'restart-history.json');
  const respawnScript = fileURLToPath(new URL('./respawn.js', import.meta.url));

  // 1. 读取上次 marker（容忍缺失/损坏）
  let marker = null;
  try {
    const raw = JSON.parse(readFileSync(markerPath, 'utf8'));
    if (raw && typeof raw.lastBootAt === 'string' && typeof raw.pid === 'number') {
      marker = raw;
    }
  } catch {
    marker = null; // 首次启动或损坏
  }

  const bootAt = new Date().toISOString();
  const { wasRestart, downtimeMs } = detectRestart(marker, Date.now(), process.pid);
  // v0.4.0：抖动窗口判定。wasRestart=true 且 downtimeMs < notifyDebounceMs → 跳过投递
  const debounce = shouldNotify({ wasRestart, downtimeMs }, config.notifyDebounceMs);
  const prevBootAt = marker?.lastBootAt ?? null;
  const lastSessionId = marker?.lastSessionId ?? null;
  const lastActiveAt = marker?.lastActiveAt ?? null;

  // 拉起快照：必须在插件 apply 时抓，此时 cwd/argv/env 还是启动时刻的样子
  // v0.5.0：归一化，去掉"每次重启自动弹一次浏览器"
  const launch = normalizeLaunch(snapshotLaunch(config.launch), config);
  // v0.5.0：判断本次启动是否由插件自己的重启请求导致（用于切断重启环）
  const selfRestart = detectSelfRestart(marker, requestPath);

  // 2. 活动追踪（运行期间持续记录最近活跃会话）
  let trackedActiveId = null;
  let trackedActiveAt = 0;
  const recordActivity = (agent) => {
    const sid = String(agent?.id ?? '');
    if (ignoredByPrefix(sid, config.ignoredSessionPrefixes)) return;
    trackedActiveId = sid;
    trackedActiveAt = Date.now();
  };

  // 3. 持久化状态（启动时写 marker + 优雅 dispose 时写最近活跃）
  const writeState = (extra = {}) => {
    try {
      mkdirSync(markerDir, { recursive: true });
      const doc = {
        lastBootAt: bootAt,
        pid: process.pid,
        // 优先最近追踪的活跃会话，否则保留上次的
        lastSessionId: trackedActiveId ?? marker?.lastSessionId ?? null,
        lastActiveAt: trackedActiveAt
          ? new Date(trackedActiveAt).toISOString()
          : marker?.lastActiveAt ?? null,
        ...extra,
      };
      writeFileSync(markerPath, JSON.stringify(doc, null, 2));
    } catch (err) {
      console.warn('[agint-restart] could not write marker:', err);
    }
  };
  writeState();

  // ── 重启历史 / 熔断 ────────────────────────────────────────────
  const readHistory = () => readJson(historyPath, { events: [] });
  const writeHistory = (h) => writeJson(historyPath, h);

  /** 记录一次重启，并判断是否触发熔断。 */
  const recordRestart = (requestId, reason) => {
    const h = readHistory();
    const events = Array.isArray(h.events) ? h.events : [];
    events.push({ at: new Date().toISOString(), requestId, reason: reason ?? null, pid: process.pid });
    // 只保留最近 50 条，防止文件无限增长
    const trimmed = events.slice(-50);
    writeHistory({ events: trimmed });
    return trimmed;
  };

  /** 当前是否处于熔断窗口内。 */
  const burstState = () => {
    const h = readHistory();
    const events = Array.isArray(h.events) ? h.events : [];
    const cutoff = Date.now() - config.burstWindowMs;
    const recent = events.filter((e) => Date.parse(e.at) >= cutoff);
    return { count: recent.length, tripped: recent.length >= config.burstMax, recent };
  };

  // 优雅关闭：cordis dispose 钩子（修正上游 SIGTERM 二次 kill bug）
  // 上游在 onSigterm/onSigint 里调 process.kill(process.pid, ...) 二次 kill 自己——
  // 这里只让 cordis 自己负责停机，dispose 钩子里只持久化状态。
  ctx.effect(() => () => {
    try {
      if (trackedActiveId) writeState({ when: new Date().toISOString() });
    } catch (e) { /* ignore */ }
  });

  // 4. 监听 agent 活动事件（追踪最近活跃会话）
  ctx.on('agent/session-start', ({ agent }) => {
    recordActivity(agent);
  });
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    recordActivity(agent);
    return next();
  });

  // ── 主动重启：核心 ─────────────────────────────────────────────
  let pending = null; // 同一时刻只允许一个在途请求

  /** 关掉自己，让 respawn.js 拉起的新实例能接管端口。 */
  const shutdownSelf = (delayMs) => {
    setTimeout(() => {
      try { writeState({ shuttingDownAt: new Date().toISOString() }); } catch { /* ignore */ }
      if (config.exitStrategy === 'signal') {
        try { process.kill(process.pid, 'SIGTERM'); } catch { /* ignore */ }
      }
      // signal 在 win32 上不可靠，兜底 exit；exit 策略直接 exit
      setTimeout(() => process.exit(0), 1500).unref?.();
    }, Math.max(0, delayMs)).unref?.();
  };

  /**
   * 请求重启（内部实现）。护栏顺序：enabled → mode → confirm → pending → 熔断 → cooldown。
   * ⚠️ 不要直接调用本函数——走下面的 request() 包装：它保证不抛异常，并把
   * "副作用是否已经发生"翻译成返回值（v0.4.4，见 lib/contract.js 文件头）。
   * @param {object} input
   * @param {{requestId: string|null, fileWritten: boolean, guardianStarted: boolean}} trace
   * @returns {object} 契约字段见 lib/contract.js REQUEST_FIELDS
   */
  const requestInner = (input = {}, trace = { requestId: null, fileWritten: false, guardianStarted: false }) => {
    const reason = typeof input?.reason === 'string' ? input.reason : '';
    const force = input?.force === true;
    const dryRun = input?.dryRun === true;
    const confirm = input?.confirm === true;
    const delayMs = Number.isFinite(input?.delayMs) ? input.delayMs : config.shutdownDelayMs;

    // v0.4.4：所有返回走 contract.js 的构造函数——返回字面量手写漏字段正是
    // 2026-09-10 事故的根因（accepted 分支漏 code，schema required 校验在副作用后失败）
    const deny = (code, message, extra = {}) => requestDeny(code, message, extra);

    if (config.mode === 'manual') {
      // 人工模式：只把"怎么重启"写清楚，不做任何危险动作
      const cmd = buildManualCommand(launch);
      writeJson(requestPath, {
        requestId: null, reason, requestedAt: new Date().toISOString(),
        mode: 'manual', launch, command: cmd,
      });
      return requestManual({ command: cmd, launch });
    }

    if (!confirm && !force) {
      return deny('needs-confirm', '重启会中断所有进行中的会话，需显式传 confirm:true（或 force:true 绕过）');
    }
    if (pending && Date.now() - pending.at < 120000) {
      return deny('already-pending', `已有在途重启请求 ${pending.requestId}（${new Date(pending.at).toISOString()}）`);
    }

    const burst = burstState();
    if (burst.tripped) {
      return deny('tripped', `${config.burstWindowMs / 1000}s 内已重启 ${burst.count} 次（上限 ${burst.max ?? config.burstMax}），触发熔断，拒绝继续重启`, { count: burst.count });
    }

    const h = readHistory();
    const last = Array.isArray(h.events) && h.events.length ? h.events[h.events.length - 1] : null;
    const sinceLast = last ? Date.now() - Date.parse(last.at) : Infinity;
    if (sinceLast < config.cooldownMs && !force) {
      return deny('cooldown', `距上次重启仅 ${Math.round(sinceLast / 1000)}s，冷却期 ${config.cooldownMs / 1000}s`, {
        cooldownRemainingMs: config.cooldownMs - sinceLast,
      });
    }

    const requestId = randomUUID().slice(0, 8);
    const payload = {
      requestId,
      reason,
      requestedAt: new Date().toISOString(),
      targetPid: process.pid,
      stateDir: markerDir,
      launch,
      waitExitMs: config.waitExitMs,
      forceKillAfterMs: config.forceKillAfterMs,
      portFreeTimeoutMs: config.portFreeTimeoutMs,
      readiness: {
        leasePath: readiness.leasePath ? join(resolveDshHome(), readiness.leasePath) : null,
        port: readiness.port,
        timeoutMs: readiness.timeoutMs,
      },
      logFile: config.logFile,
    };

    // dryRun：只返回将要做什么，不落盘不拉进程
    if (dryRun) {
      return requestDryRun({
        requestId,
        targetPid: payload.targetPid,
        shutdownInMs: delayMs,
        plan: {
          requestFile: requestPath,
          respawnScript,
          targetPid: payload.targetPid,
          launch: { command: launch.command, args: launch.args, cwd: launch.cwd },
          waitExitMs: payload.waitExitMs,
          forceKillAfterMs: payload.forceKillAfterMs,
          readiness: payload.readiness,
          shutdownDelayMs: delayMs,
        },
      });
    }

    if (!writeJson(requestPath, payload)) {
      return deny('write-failed', `无法写入请求文件：${requestPath}。未产生任何副作用，可安全重试`);
    }
    // 请求文件已落盘：sideEffect 的追溯起点（下面守护脚本起不来时据此如实说明）
    trace.requestId = requestId;
    trace.fileWritten = true;

    // detached 拉起守护脚本：它会在我们死后把新 dsh 拉起来
    try {
      const child = spawn(process.execPath, [respawnScript, requestPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: launch.cwd,
        env: process.env,
      });
      child.unref();
      trace.guardianStarted = true;
    } catch (err) {
      return deny('spawn-failed',
        `守护进程启动失败：${String(err?.message ?? err)}。请求文件已写入 ${requestPath}，但没有守护进程消费它，本次不会重启；协议未置位在途标记，可安全重试`);
    }

    pending = { requestId, at: Date.now() };
    recordRestart(requestId, reason);
    console.log(`[agint-restart] restart requested (${requestId}) reason=${reason || '-'} pid=${process.pid}`);

    // 延迟退出自己，让调用方先拿到返回值
    shutdownSelf(delayMs);

    return requestAccepted({
      requestId,
      targetPid: process.pid,
      shutdownInMs: delayMs,
      launch: { command: launch.command, args: launch.args, cwd: launch.cwd },
      resultFile: resultPath,
    });
  };

  /**
   * 对外入口：**绝不抛异常**（v0.4.4）。
   * 抛异常时调用方只看到 Error，而 Error 不携带"副作用是否已发生"——实测后果是
   * 看到报错就重试 → 重复重启。这里把异常翻译成一份 schema 合法、且写明副作用
   * 状态的返回（contract.js: requestInternalError）。
   */
  const request = (input = {}) => {
    const trace = { requestId: null, fileWritten: false, guardianStarted: false };
    try {
      return requestInner(input, trace);
    } catch (err) {
      console.error(`[agint-restart] request() 内部异常: ${err?.stack ?? err}`);
      return requestInternalError({
        error: err,
        requestId: trace.requestId,
        fileWritten: trace.fileWritten,
        guardianStarted: trace.guardianStarted,
        requestFile: requestPath,
      });
    }
  };

  /** 手动模式下给老板的可复制命令。 */
  function buildManualCommand(l) {
    return `cd "${l.cwd}" && "${l.command}" ${l.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
  }

  /** 只读状态：当前进程、冷却、熔断、上次重启结果。 */
  const status = () => {
    const burst = burstState();
    const h = readHistory();
    const last = Array.isArray(h.events) && h.events.length ? h.events[h.events.length - 1] : null;
    const sinceLast = last ? Date.now() - Date.parse(last.at) : Infinity;
    return {
      enabled: config.enabled,
      mode: config.mode,
      pid: process.pid,
      bootAt,
      wasRestart,
      // v0.5.0：本次启动是否由 agent 自己发起的重启导致；true 时默认不发恢复通知
      selfRestart: selfRestart.self,
      selfRestartRequestId: selfRestart.requestId,
      pending: pending ? { requestId: pending.requestId, at: new Date(pending.at).toISOString() } : null,
      cooldownRemainingMs: sinceLast < config.cooldownMs ? config.cooldownMs - sinceLast : 0,
      burst: { windowMs: config.burstWindowMs, max: config.burstMax, count: burst.count, tripped: burst.tripped },
      lastRestart: last ?? null,
      historyCount: Array.isArray(h.events) ? h.events.length : 0,
      lastResult: existsSync(resultPath) ? readJson(resultPath, null) : null,
      launch: { command: launch.command, args: launch.args, cwd: launch.cwd },
    };
  };

  /** 取消在途请求（仅在还没退出时有效）。 */
  const cancel = () => {
    if (!pending) {
      // v0.4.4：requestId 是 schema required——no-pending 分支此前漏了它（同类漂移）
      return cancelResult({ cancelled: false, code: 'no-pending', message: '没有在途的重启请求' });
    }
    const id = pending.requestId;
    pending = null;
    // 守护脚本可能已经跑起来了；写一条 cancel 标记，respawn 侧以 request 文件为准，
    // 这里主要通过删除请求文件 + 清空 pending 阻止后续重复请求
    try { writeJson(requestPath, { ...readJson(requestPath, {}), cancelledAt: new Date().toISOString() }); } catch { /* ignore */ }
    // sideEffect=true：标记清了，但守护脚本可能已经在等旧进程退出——取消不保证能叫停重启
    return cancelResult({
      cancelled: true,
      code: 'cancelled',
      message: '已清除在途标记；若守护脚本已启动，需人工确认是否有新实例被拉起',
      requestId: id,
      sideEffect: true,
    });
  };

  const detect = () => ({
    wasRestart,
    downtimeMs,
    lastSessionId,
    lastActiveAt,
    prevBootAt,
    currentBootAt: bootAt,
    pid: process.pid,
    // v0.5.0：本次启动是否由插件自己的重启请求导致（true 时默认不投恢复通知）
    selfRestart: selfRestart.self,
    selfRestartRequestId: selfRestart.requestId,
  });

  // 注册服务：整包 + 与 manifest 声明一致的 detect 别名
  ctx.provide('agint.restart', { detect, status, request, cancel });
  ctx.provide('agint.restart.detect', detect);

  // 5. 若发生重启，向主 agent 投递信息性消息
  //
  // v0.5.0：投递前过两道闸。
  //   debounce      —— 相邻启动间隔太近（连续重启验证期），不投
  //   self-restart  —— 这次重启是 agent 自己发起的，不投（否则形成
  //                    通知→唤醒 agent→干活→自己重启→又通知 的自维持环）
  const suppressed = !wasRestart
    ? null
    : (debounce.debounced
      ? 'debounce'
      : (selfRestart.self && config.resumeOnSelfRestart !== true ? 'self-restart' : null));

  if (wasRestart && suppressed === null) {
    ctx.inject(['agents'], (scope) => {
      ctx.effect(() => {
        /**
         * 找投递目标，返回 { agent, matched }。
         * matched: 'lastSession' = 重启前那个会话（带上下文，最优）
         *          'primary' | 'configured' = 回退到 target 规则
         */
        const findTarget = () => {
          try {
            const list = scope.agents.list?.() ?? [];
            const roots = scope.agents.roots?.() ?? [];
            const pool = roots.length ? roots : list;
            // 1) 优先回到重启前最近活跃的会话——只有它带着被中断的上下文
            if (config.resumeLastSession !== false && lastSessionId) {
              const hit = pool.find((a) => a && String(a.id) === String(lastSessionId))
                ?? scope.agents.get?.(lastSessionId) ?? null;
              if (hit) return { agent: hit, matched: 'lastSession' };
            }
            // 2) 回退到配置的 target 规则
            if (config.target === 'primary') {
              const t = pool[0] ?? list[0] ?? null;
              return t ? { agent: t, matched: 'primary' } : null;
            }
            const t = scope.agents.get?.(config.target) ?? null;
            return t ? { agent: t, matched: 'configured' } : null;
          } catch (err) {
            console.warn('[agint-restart] agent lookup failed:', err);
            return null;
          }
        };
        const mode = resolveDeliveryMode(config);
        const deliver = (found) => {
          const target = found.agent;
          const text = buildNotice({
            bootAt,
            prevBootAt,
            downtimeMs,
            lastSessionId,
            lastActiveAt,
            customNotice: config.notice,
          });
          const msg = createUserMessage({
            content: [{ type: 'text', text }],
            source: {
              kind: 'plugin',
              plugin: 'agint-restart',
              form: 'notice',
              summary: `agint-restart: DSH restarted at ${bootAt}`,
            },
          });
          try {
            if (mode === 'wake') {
              // followup = send(next-turn, wakeup=true) → 唤醒 driver，agent 真正开始干活
              target.followup(msg);
            } else {
              // inject = send(next-step, wakeup=false) → 只入收件箱，不唤醒（看不到回音）
              target.inject(msg);
            }
            console.log('[agint-restart] notice delivered to', String(target.id),
              'matched=' + found.matched, 'mode=' + mode);
            writeWakeLog(markerDir, String(target.id), true, null, {
              matched: found.matched, mode, lastSessionId: lastSessionId ?? null,
            });
          } catch (err) {
            console.warn('[agint-restart] deliver failed:', err);
            writeWakeLog(markerDir, String(target.id), false, String(err), {
              matched: found.matched, mode, lastSessionId: lastSessionId ?? null,
            });
          }
        };
        const MAX_WAIT_MS = 20000;
        // 是否值得为"旧会话复活"多等一会儿：只有它才带着被中断的上下文
        const wantResume = config.resumeLastSession !== false && !!lastSessionId;
        const RESUME_WAIT_MS = wantResume
          ? Math.min(config.resumeWaitMs ?? 5000, MAX_WAIT_MS)
          : 0;

        // 首次立即尝试：命中旧会话、或不指望旧会话时直接投
        let found = findTarget();
        if (found && (!wantResume || found.matched === 'lastSession')) {
          deliver(found);
          return;
        }

        // 轮询等待（最长 ~20 秒）。窗口期内若只找到回退目标，继续等旧会话出现
        let waited = 0;
        let fallback = found;
        const POLL_MS = 500;
        const timer = setInterval(() => {
          waited += POLL_MS;
          found = findTarget();
          if (found?.matched === 'lastSession') {
            clearInterval(timer);
            deliver(found);
            return;
          }
          if (found && !fallback) fallback = found;
          if (waited >= RESUME_WAIT_MS && fallback) {
            clearInterval(timer);
            deliver(fallback);
            return;
          }
          if (waited >= MAX_WAIT_MS) {
            clearInterval(timer);
            if (fallback) { deliver(fallback); return; }
            console.log('[agint-restart] no target agent found after wait, skip wake');
            writeWakeLog(markerDir, null, false, 'no target agent after wait',
              { mode, lastSessionId: lastSessionId ?? null });
          }
        }, POLL_MS);
        // 把 setInterval 也注册为 disposer（dispose 时自动 clear）
        ctx.effect(() => () => clearInterval(timer));
      });
    });
  } else {
    if (suppressed === null) {
      console.log('[agint-restart] no restart detected, boot normal');
    } else if (suppressed === 'debounce') {
      // v0.4.0：抖动窗口内命中，不投递（marker 仍然照常写新值，下次重启照常判定）
      console.log(`[agint-restart] restart detected but within debounce window (${config.notifyDebounceMs}ms), skip notice (downtime=${downtimeMs}ms)`);
    } else {
      console.log(`[agint-restart] self-initiated restart (request=${selfRestart.requestId ?? '-'}) skip resume notice — 中断是 agent 自己安排的，不再唤醒它（resumeOnSelfRestart=false）`);
    }
  }
}

export { apply, inject, name };
