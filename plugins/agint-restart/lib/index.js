/**
 * agint-restart v0.2.0 — Cordis 入口
 *
 * 两件事：
 *   A. 重启检测 + 信息性消息投递（v0.1.0 能力，保留）
 *      —— DSH 重启后向主 agent 投递**纯状态**消息「DSH 已重启。」（v0.7.1 断环：
 *         不投任何行动指令；中断时长/会话 id 等细节留 restart_status、wake.log、restart-history.json）。
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
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildNotice, detectRestart, shouldNotify } from './detect.js';
import { codeFingerprint, fingerprintChanged } from './fingerprint.js';
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
  // v0.6.1：300000 → 60000。5 分钟的窗口会把"老板重启后 1-3 分钟内又重启"这类
  //   正常场景一并吞掉（实测 downtime=100131ms 被误挡），恢复通知发不出去 = 会话不接续。
  //   60s 只够挡住"刚起来又被拉起"的抖动；真正的重启环由 restart_request 的
  //   burst 熔断（burstWindowMs 内 burstMax 次）兜底，不靠这个窗口断环。
  // 仅作用于"是否投递"分支；marker / status / 主动重启链路不受影响。<=0 表示关闭
  notifyDebounceMs: 60000,

  // ── v0.5.0：防弹窗 + 断环 ─────────────────────────────────────
  // 拉起新实例时，是否允许它自动打开浏览器。
  // 默认 false → 给 launch 参数补 `--no-open`。
  // 原因：`dsh web` 的 openBrowser 默认 true，插件每次拉起都会弹一次浏览器
  //      （2026-09-10 实测：16 次重启 = 16 次 "opening the default browser"）。
  // 入口页 URL/token 仍会打印在新实例日志里，需要时可手动打开。
  openBrowserOnRestart: false,
  // 自触发重启（经插件协议发起，含 agent 自己调 restart_request）是否也投递"恢复"通知。
  // v0.6.1：false → true。原设计把"自触发"当成"不需要恢复"，但 detectSelfRestart 判的是
  //   "这次启动是不是留下了请求文件"——**凡走插件协议的重启都算自触发**（agent 调工具、
  //   外部按协议发起都算），于是恢复通知几乎永远发不出去：老板让 agent 重启并要求
  //   "重启完向我问好"，这条消息会被自己的触发器吞掉，会话彻底不接续。
  //   正确做法是"照常投递 + 在通知里明示无需再次重启"，断环交给 burst 熔断。
  // 置 false 可退回旧行为（自触发重启不投恢复通知）。
  resumeOnSelfRestart: true,

  notice: '',

  // ── v0.7.0：待投通知（parked notice）────────────────────────────
  // 重启后若内存里没有活 agent（会话还没被任何客户端打开），把恢复通知
  // 落盘到 pending-notice.json，等之后任一会话起来再补投。
  //   关闭它 = 退回 v0.6.x 行为：等 5~20 秒找不到目标就彻底丢弃通知。
  parkNoticeOnNoTarget: true,
  // true  = 只把待投通知投给"重启前那个会话"（它可能永远不被打开）
  // false = 任一会话起来就补投（默认，保证老板一打开 UI 就能看到）
  pendingOnlyLastSession: false,

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

  // v0.8.0：运行中代码指纹 —— apply 时算一次，写进 marker 与 status()。
  // 目的：把"跑的是哪版代码 / 要不要重启"从推断变成事实（改完插件后 `status().codeStale` 一句回答）。
  // 测试钩子：AGINT_RESTART_CODE_DIR 可指向别处的同名 lib 目录（smoke 用它模拟"磁盘被改过"）。
  const codeDir = process.env.AGINT_RESTART_CODE_DIR
    || fileURLToPath(new URL('.', import.meta.url));
  const appliedFingerprint = codeFingerprint(codeDir);
  let staleLogged = false; // codeStale 只在首次观察到时打日志，避免刷屏

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
        // v0.8.0：本次 apply 加载的代码指纹（下次启动对比它就知道"是否加载了新代码"）
        codeFingerprint: appliedFingerprint,
        ...extra,
      };
      writeFileSync(markerPath, JSON.stringify(doc, null, 2));
    } catch (err) {
      console.warn('[agint-restart] could not write marker:', err);
    }
  };
  writeState();

  // v0.8.0：把"这次加载的代码是不是新的"直接打出来（替代原来靠 marker 时间戳反推 HMR 的做法）
  const prevFingerprint = typeof marker?.codeFingerprint === 'string' ? marker.codeFingerprint : null;
  if (appliedFingerprint) {
    console.log(fingerprintChanged(prevFingerprint, appliedFingerprint)
      ? `[agint-restart] code fingerprint ${appliedFingerprint}（上一版 ${prevFingerprint ?? '未知'}）— 本次加载了新代码`
      : `[agint-restart] code fingerprint ${appliedFingerprint}（与上一版相同）`);
  } else {
    console.warn(`[agint-restart] could not compute code fingerprint (codeDir=${codeDir})`);
  }

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

  // ── 3.5 恢复通知的落盘与投递（v0.7.0）─────────────────────────
  //
  // 为什么必须"落盘待投"：dsh 的 agents 注册表只装**内存里活着的 agent**
  // （dsh-agent/lib: get/list/roots 读的都是运行时 store），而会话只有被客户端
  // （UI/API）打开时才 announce 进注册表（dsh-agent-loop 的 publish），
  // dsh 并没有"启动时自动恢复上次会话"的机制。
  //   → 重启那一刻若老板还没用新 token 的 URL 连上来，内存池就是空的，
  //     findTarget() 必然落空，通知被直接丢弃（实测 2026-09-10 19:47 那次）。
  // 做法：重启后先把通知**落盘**，投递成功才删；之后任一会话被打开时补投。
  //   这样无论老板隔多久才打开 UI，恢复通知都不会丢。
  const pendingPath = join(markerDir, 'pending-notice.json');
  const mode = resolveDeliveryMode(config);

  const buildPendingDoc = (reason) => ({
    createdAt: new Date().toISOString(),
    bootAt,
    prevBootAt: prevBootAt ?? null,
    downtimeMs: downtimeMs ?? 0,
    lastSessionId: lastSessionId ?? null,
    lastActiveAt: lastActiveAt ?? null,
    selfRestart: selfRestart.self,
    customNotice: config.notice ?? '',
    reason: reason ?? null,
  });

  /** 把恢复通知落盘，等之后有会话起来再投。 */
  const writePending = (reason) => {
    if (config.parkNoticeOnNoTarget === false) return false;
    try {
      mkdirSync(markerDir, { recursive: true });
      writeFileSync(pendingPath, JSON.stringify(buildPendingDoc(reason), null, 2));
      console.log('[agint-restart] no live agent yet — notice parked at', pendingPath);
      return true;
    } catch (err) {
      console.warn('[agint-restart] could not park notice:', err?.message ?? err);
      return false;
    }
  };

  const readPending = () => {
    const doc = readJson(pendingPath, null);
    return doc && typeof doc === 'object' && typeof doc.bootAt === 'string' ? doc : null;
  };

  const clearPending = () => {
    try { rmSync(pendingPath, { force: true }); return true; } catch { return false; }
  };

  const noticeMessageFrom = (doc) => createUserMessage({
    content: [{
      type: 'text',
      text: buildNotice({
        bootAt: doc.bootAt,
        prevBootAt: doc.prevBootAt,
        downtimeMs: doc.downtimeMs,
        lastSessionId: doc.lastSessionId,
        lastActiveAt: doc.lastActiveAt,
        selfRestart: doc.selfRestart,
        customNotice: doc.customNotice,
      }),
    }],
    source: {
      kind: 'plugin',
      plugin: 'agint-restart',
      form: 'notice',
      summary: `agint-restart: DSH restarted at ${doc.bootAt}`,
    },
  });

  // ── v0.7.2：同一次 boot 只允许投递一次 ───────────────────────────
  // 事故（2026-09-11 实测，一次重启两条通知）：同一个 boot 上存在两条投递路径——
  //   ① `agent/session-start` → tryFlushPending() 补投落盘通知并 clearPending()；
  //   ② `ctx.inject(['agents'])` 回调里的 boot 轮询随后又 deliver() 一次，
  //      此时 clearPending() 已成空操作，于是同一会话收到第二条。
  // 危害：老板界面出现重复通知；更糟的是"双唤醒"——被唤醒两次的会话执行的还是同一批
  // 上下文指令，等于把重启环的暴露面翻倍（见 restart-loop-incident-20260910.md）。
  // 只做"投递成功才置位"，所以窗口内投递失败仍然可以重试，不会把通知卡死。
  let deliveredForBoot = false;

  /**
   * 向指定 agent 投递恢复通知。
   * @param {object} target 目标 agent（需有 followup/inject）
   * @param {string} matched 'lastSession' | 'primary' | 'configured' | 'pending'
   * @param {object} [doc] 通知内容快照；省略则用当前启动信息现算
   * @returns {boolean} 是否投递成功（失败已写 wake.log，不向外抛）
   */
  const deliverTo = (target, matched, doc) => {
    if (deliveredForBoot) return false;
    const payload = doc ?? buildPendingDoc('live');
    const id = String(target?.id ?? '');
    try {
      const msg = noticeMessageFrom(payload);
      if (mode === 'wake') {
        // followup = send(next-turn, wakeup=true) → 唤醒 driver，agent 真正开始干活
        target.followup(msg);
      } else {
        // inject = send(next-step, wakeup=false) → 只入收件箱，不唤醒（看不到回音）
        target.inject(msg);
      }
      // 消息已经发出去了：无论后面记日志是否出错，这个 boot 都算投过了（防重复）
      deliveredForBoot = true;
      console.log('[agint-restart] notice delivered to', id, 'matched=' + matched, 'mode=' + mode);
      writeWakeLog(markerDir, id, true, null, { matched, mode, lastSessionId: lastSessionId ?? null });
      return true;
    } catch (err) {
      console.warn('[agint-restart] deliver failed:', err);
      writeWakeLog(markerDir, id, false, String(err), { matched, mode, lastSessionId: lastSessionId ?? null });
      return false;
    }
  };

  /**
   * 有会话起来了：若还压着没送出去的恢复通知，现在补投并删除。
   * 默认投给第一个起来的会话；pendingOnlyLastSession=true 时只认重启前那个。
   */
  const tryFlushPending = (agent) => {
    const doc = readPending();
    if (!doc) return false;
    const sid = String(agent?.id ?? '');
    if (!sid) return false;
    if (config.pendingOnlyLastSession === true
      && doc.lastSessionId && sid !== String(doc.lastSessionId)) {
      return false;
    }
    if (deliverTo(agent, 'pending', doc)) {
      clearPending();
      console.log('[agint-restart] parked notice flushed to', sid);
      return true;
    }
    return false;
  };

  // 4. 监听 agent 活动事件（追踪最近活跃会话 + 补投落盘通知）
  ctx.on('agent/session-start', ({ agent }) => {
    recordActivity(agent);
    tryFlushPending(agent);
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

  /** 只读状态：当前进程、冷却、熔断、上次重启结果、运行中代码指纹。 */
  const status = () => {
    const burst = burstState();
    const h = readHistory();
    const last = Array.isArray(h.events) && h.events.length ? h.events[h.events.length - 1] : null;
    const sinceLast = last ? Date.now() - Date.parse(last.at) : Infinity;
    // v0.8.0：磁盘上的代码是否已与"运行中这份"不同（= 改过插件但还没生效）
    const currentFingerprint = codeFingerprint(codeDir);
    const codeStale = fingerprintChanged(appliedFingerprint, currentFingerprint);
    if (codeStale && !staleLogged) {
      staleLogged = true;
      console.log(`[agint-restart] host code changed since apply (${appliedFingerprint ?? '未知'} → ${currentFingerprint ?? '未知'}) — 进程里仍是旧代码，需重启（或等 HMR）才生效`);
    }
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
      // v0.7.0：还压着没送出去的恢复通知（null = 没有待投）
      parkedNotice: existsSync(pendingPath) ? readJson(pendingPath, null) : null,
      // v0.8.0：运行中代码指纹 + 是否已陈旧（true = 磁盘改过、进程里还是旧的，需重启/等 HMR）
      codeFingerprint: appliedFingerprint,
      codeStale,
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
        // v0.7.0：先把通知落盘，投递成功才删。
        // 即便本次找不到活 agent（甚至 agents 服务压根没就绪、本回调不执行），
        // 通知也已经安全躺在磁盘上，等之后任一会话被打开时补投（tryFlushPending）。
        writePending('boot');

        /** 投出去，并在成功后清除落盘副本。 */
        const deliver = (found) => {
          if (deliverTo(found.agent, found.matched)) clearPending();
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
            // v0.7.0：不再"丢弃"——通知已在 writePending 落盘，等会话起来补投
            console.log('[agint-restart] no target agent found after wait — notice parked, will flush on next session start');
            writeWakeLog(markerDir, null, false, 'no target agent after wait (parked)',
              { mode, lastSessionId: lastSessionId ?? null, parked: true });
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
      console.log(`[agint-restart] self-initiated restart (request=${selfRestart.requestId ?? '-'}) skip resume notice — resumeOnSelfRestart 被显式设为 false`);
    }
  }
}

export { apply, inject, name };
