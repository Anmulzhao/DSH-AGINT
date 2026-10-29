/**
 * v2-data: /v2/data 的聚合层。L0.5（源码扫描）+ L1（storages 三源）+ manifest 声明消费
 * （consumes ∪ optionalInject；声明同时作为 v2-scan 补边的白名单）。
 *
 * 纪律（设计稿 §2/D4）：
 *  - 每源独立降级：一源挂 → 该字段 {state:'error',reason}，其余照常，不装绿。
 *  - TTL 30s + mtime 签名缓存；刷新走 force 或缓存过期。
 *  - observedAt = 对应文件 mtime 的 ISO；前端展示龄期。
 *  - latencyMs 字段不聚合（U2 未查清，延迟不进面板）。
 *  - 机器私有路径不写死：DSH_HOME/AGINT_HOME 环境变量优先，缺省从自身路径推导。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { scanPlugins, codeRoots, isTmpLeftover } from './v2-scan.js';
// 档案层（v0.4.0）：读插件自己写下的东西（manifest 契约 / package / CHANGELOG / 代码体量）。
// 与聚合层分开的理由见 v2-dossier.js 头注释：运行时事实与「插件自述」的失败模式不同。
import { collectDossiers } from './v2-dossier.js';
// 归因表（工具前缀 / cron / 宿主键）的单一事实源，随 payload 下发（v0.4.0）。
// 抽出来的理由见 v2-owners.js 头注释：档案页与整页视图各抄一份必然漂移。
import { ownersPayload } from './v2-owners.js';
// profile 名解析口径复用 agint-mount 的实现（单一事实源，防三处口径漂移）。
// 跨插件相对 import 在仓库位 / bundle 位 / 兼容镜像位三种布局下都能解析：
//   仓库位   plugins/agint-family-panel/lib → ../../agint-mount/lib/paths.js
//   bundle 位 .agint-bundle/plugins/agint-family-panel/lib → 同上相对关系
//   镜像位   profiles/<p>/plugins/agint-family-panel/lib → 同上
import { resolveProfileName } from '../../agint-mount/lib/paths.js';

const require = createRequire(import.meta.url);
const PANEL_VERSION = (require('../package.json')?.version) ?? '0.0.0';

const TTL_MS = 30_000;
const WINDOW_DAYS = 30;
const DAILY_DAYS = 7;
const DAY_MS = 86_400_000;

const moduleCache = new Map();
export function clearV2Cache() { moduleCache.clear(); }

/**
 * Is `dir` the AGINT repo root?
 *
 * Marker is deliberate and narrow: a repo root has ALL THREE of `plugins/`,
 * `cordis.patch.yml`, and `.git`.
 *
 * ⛔ Why not just `plugins/`: the **deploy** layout also has
 * `<...>/profiles/web/plugins`, so `web/` would pass a `plugins/`-only test and
 * the panel would read the deploy dir as the "repo" dir — the exact
 * deploy-vs-repo confusion this fallback exists to fix (regression caught by
 * test/v2-data.test.mjs, which runs against a fixture home shaped like deploy).
 *
 * ⛔ Why `.git` on top of the other two (2026-10-18): the **bundle** and
 * **host-package** deploy layouts (`<DSH_HOME>/.agint-bundle`,
 * `<profile>/node_modules/@agint/host`) hold BOTH `plugins/` and
 * `cordis.patch.yml` — they are the mounted entity, not a checkout. Measured on
 * this machine: `isRepoRoot('.agint-bundle')` and
 * `isRepoRoot('.../@agint/host')` both returned true under the two-marker rule,
 * so the live panel reported `repoDirsSource=self-path` with 117 entries (78 of
 * them `*.tmp` leftovers) and lost the real repo's wiring exemptions. `.git`
 * separates "a checkout" from "a deployed copy" in one stat call.
 *
 * `.git` may be a **file** (git worktree / submodule), so this uses existsSync,
 * not isDirectory.
 *
 * @param {string} dir
 * @returns {boolean}
 */
export function isRepoRoot(dir) {
  try {
    return statSync(join(dir, 'plugins')).isDirectory()
      && statSync(join(dir, 'cordis.patch.yml')).isFile()
      && existsSync(join(dir, '.git'));
  } catch {
    return false;
  }
}

/**
 * 事件总线里**不是插件**的 source 名单：一次性人工探针与手工验证标签。
 *
 * 为什么需要这张表：面板按 `source.startsWith('agint-')` 判定「运行态不在仓库」
 * （panel-v2.html 的名册差集）。探针为了模仿真插件曾把 source 写成
 * `agint-evolution-memory-probe`，于是被误报成「插件在运行、仓库里没有它」。
 * 实测：生产 `agint_event_bus.json` 里该 source 仅 1 条、payload 带
 * `origin:'manual-test'`（2026-09-04T15:35:00Z），仓库 git 全历史 0 次新增该目录。
 *
 * 单一事实源是 `plugins/agint-event-bus/lib/schemas.js` 的 KNOWN_EVENT_SOURCES
 * 末段「历史一次性探针」。此处**不 import** 那份文件：它顶层 import zod，
 * 面板不该为一张名单拉进别人的依赖。test/v2-probe-sources.test.mjs 双向比对
 * 两张表，任一侧漂移就变红。
 */
export const PROBE_EVENT_SOURCES = Object.freeze([
  'agint-evolution-memory-probe',
  'verify-after-fix',
  'verify-final',
]);

/**
 * 自身路径 → 部署位 plugins 目录候选（<pluginsDir>/agint-family-panel/lib/ 上溯两级）。
 *
 * selfUrl 可能不可用（测试传哨兵值、非常规加载器），此时返回 null 而不是抛——
 * 目录解析是聚合层的前置步骤，为「顺带算个路径」抛异常会连带打掉全部六个源，
 * 面板从「六源可读」退化成「整页 500」。
 *
 * @param {string} selfUrl
 * @returns {string|null}
 */
function selfPluginsCandidate(selfUrl) {
  try {
    return resolve(dirname(fileURLToPath(selfUrl)), '..', '..');
  } catch {
    return null;
  }
}

/**
 * 自身路径 →仓库根候选（<repo>/plugins/<plugin>/lib/ 里上溯两级）。
 *
 * @param {string} selfUrl
 * @returns {string|null}
 */
function selfRepoCandidate(selfUrl) {
  try {
    const pluginRoot = resolve(dirname(fileURLToPath(selfUrl)), '..');
    return resolve(pluginRoot, '..', '..');
  } catch {
    return null;
  }
}

/**
 * Is `dir` a dsh home root — i.e. does it hold a `storages/` directory?
 *
 * Marker is `storages/` (not `profiles/`): every dsh home has it regardless of
 * whether the bundle entity lives under `profiles/web/plugins` or
 * `.agint-bundle/plugins`, which is exactly the ambiguity that broke the old
 * fixed-depth walk (see resolveStoragesHome).
 *
 * @param {string} dir
 * @returns {boolean}
 */
export function isDshHome(dir) {
  try {
    return statSync(join(dir, 'storages')).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 探测 dsh home 根目录 —— 根治「上溯固定级数」假设。
 *
 * ⛔ 2026-10-04 bug（部署位 v2 面板三源全 ENOENT，`/home/kylin/storages` 少一层 `.dsh`）：
 * 旧实现是 `resolve(pluginsDir, '..', '..', '..')` —— 写死「pluginsDir 在
 * `profiles/web/plugins` 下，故三级正好到 home」。但 bundle 实体自 2026-10-01
 * 修「AGINT 自毁」起挪到了 `<home>/.agint-bundle/plugins`，同样三级只到
 * `<home>` 的**同级** ⇒ storagesDir 落到 home 之外 ⇒ 三个源各自 try/catch
 * 降级成 `state:error`，面板挂「⚠ 数据源降级」横幅。
 *
 * 修法：**不猜级数，改为认标**。从 pluginsDir 逐级上溯，每级都验「有没有
 * storages/」，第一个命中的即 home。这样 home 相对 pluginsDir 的深度是几都无所谓
 * （profiles/web/plugins → 3 级、.agint-bundle/plugins → 2 级），也不再依赖
 * 启动时有没有注入 DSH_HOME。
 *
 * 顺序刻意「就近优先」：先查 pluginsDir 的各级祖先（含自身），保证嵌套安装
 * （测试 fixture 里 home 套在另一个目录下）取最近的那层，而不是文件系统根附近
 * 某个同名 `storages/`。设上限 `maxUp` 防御病态自引用导致的死循环。
 *
 * @param {string} pluginsDir
 * @param {{maxUp?: number}} [opts]
 * @returns {string|null} home 根；找不到返回 null
 */
function resolveStoragesHome(pluginsDir, { maxUp = 12 } = {}) {
  let cur = resolve(pluginsDir);
  for (let i = 0; i <= maxUp; i++) {
    if (isDshHome(cur)) return cur;
    const up = dirname(cur);
    if (up === cur) break; // 触到文件系统根仍未命中
    cur = up;
  }
  return null;
}

/**
 * 解析 v2 需要的三个目录。
 *
 * storagesDir 口径（v0.3.1，2026-10-04 修「三源全 ENOENT」）：
 *  ① DSH_HOME 环境变量（显式注入，最高优先级）
 *  ② 从自身 pluginsDir 逐级上溯，取第一个确有 `storages/` 的祖先（认标不猜级数，
 *     对 `.agint-bundle/plugins` 与 `profiles/web/plugins` 两种布局都成立）
 * ③ 仍推不出 → 给出必不存在的绝对路径：每个源各自 try/catch 降级成
 *     `{state:'error',reason}`，面板显示「源降级」横幅；绝不因推导失败整页崩。
 *
 * repoPluginsDir 口径（v0.3.0，2026-10-04 修「运行态不在仓库」判据长期unknown）：
 * 四级回退，**除 config 外全部来自环境变量或自身路径推导，不写死任何机器绝对路径** ——
 *  ⓪ config.repoRoot（cordis.patch.yml 的插件 config 段，由 apply 的第二参数传入）
 *     排最高：本机已用同一套 HOME override 给 agint-cron / agint-evolution-driver /
 *     agint-evolution-memory 配仓根（各机各配、不入库）。env 在**进程内 restart** 链上
 *     不可靠——respawn 继承的是老进程启动那一刻的环境，setx 之后不重启到终端链就读不到；
 *     config 由宿主加载时求值，没这个问题。
 *  ① AGINT_HOME —— ⚠️ 双语义：install.sh 当源码根，插件侧当**数据根**（bundle
 *     cordis.patch.yml 的 dreams/reviews root 就是它）。所以它**不是**配本项的正确变量，
 *     只是历史兼容位；要配仓根请用 ⓪ 或 ②。
 *  ② AGINT_REPO_ROOT（patch 里 cron 那行显式读它，是官方的仓根逃生口）
 *  ③ 自身路径：<repo>/plugins/agint-family-panel/lib/ → 上溯到 <repo>，
 *     仅当该候选目录下确有 plugins/ 时才认（部署位 plugins 的父目录没有 plugins/，
 *     所以部署态不会把自己误认成仓库位）。
 *
 * @param {Record<string,string|undefined>} env
 * @param {string} selfUrl - 调用方 import.meta.url
 * @param {string|null} [configRepoRoot] - cordis 注入的 config.repoRoot（候选 ⓪）
 * @param {string|null} [profileName] - 生效 profile 名（2026-10-08 新增）。
 *     由调用方从 `ctx.get('profileContext')?.name` 传入 —— 那是插件进程里唯一拿得到的
 *     权威源（DSH_PROFILE 只喂 shell 子进程）。传 null 时 resolveProfileName 自行回落：
 *     env.DSH_PROFILE → 探测 profiles/*\/plugins 含 agint-* 者 → 'web'。
 */
export function resolveV2Dirs(env = process.env, selfUrl = import.meta.url, configRepoRoot = null, profileName = null) {
  let pluginsDir;
  if (env.DSH_HOME) {
    const profile = resolveProfileName({ env, dshHome: env.DSH_HOME, profile: profileName ?? undefined });
    pluginsDir = join(env.DSH_HOME, 'profiles', profile, 'plugins');
  } else {
    // 部署位兜底：本文件就在 <pluginsDir>/agint-family-panel/lib/ 下
    const derived = selfPluginsCandidate(selfUrl);
    // 推导不出时给一个必不存在的绝对路径：后续每个源各自 try/catch 降级成
    // {state:'error',reason}，面板显示「源降级」横幅；绝不因路径推导失败整页崩。
    pluginsDir = derived ?? resolve(process.cwd(), '__unresolved_plugins__');
  }
  // 认标探测，替代旧的 resolve(pluginsDir,'..','..','..') 固定三级。
  // 探测失败（无 DSH_HOME 且自路径推不出 home）时保留旧行为：拼一个大概率不存在的
  // 路径，让三源各自降级成 state:error —— 与「整页崩」相比这是更可取的失败形态。
  const probedHome = env.DSH_HOME ?? resolveStoragesHome(pluginsDir);
  const dshHome = probedHome ?? resolve(pluginsDir, '..', '..', '..');
  const selfRepoGuess = selfRepoCandidate(selfUrl);
  const cfgRoot = typeof configRepoRoot === 'string' && configRepoRoot.trim() !== '' ? configRepoRoot.trim() : null;
  const candidates = [
    cfgRoot !== null ? { source: 'config', path: join(cfgRoot, 'plugins') } : null,
    env.AGINT_HOME ? { source: 'AGINT_HOME', path: join(env.AGINT_HOME, 'plugins') } : null,
    env.AGINT_REPO_ROOT ? { source: 'AGINT_REPO_ROOT', path: join(env.AGINT_REPO_ROOT, 'plugins') } : null,
    selfRepoGuess !== null && isRepoRoot(selfRepoGuess)
      ? { source: 'self-path', path: join(selfRepoGuess, 'plugins') }
      : null,
  ].filter(Boolean);
  const chosen = candidates.find((c) => { try { return statSync(c.path).isDirectory(); } catch { return false; } }) ?? null;
  return {
    pluginsDir,
    storagesDir: join(dshHome, 'storages'),
    dshHomeSource: env.DSH_HOME ? 'DSH_HOME' : (probedHome ? 'self-probe' : 'fallback'),
    repoPluginsDir: chosen === null ? null : chosen.path,
    repoPluginsSource: chosen === null ? 'unresolved' : chosen.source,
  };
}

const errOf = (e) => ({ state: 'error', reason: String((e && e.message) ?? e).slice(0, 200) });
const mtimeIso = (p) => { try { return statSync(p).mtime.toISOString(); } catch { return null; } };

const startOfDay = (ts) => { const x = new Date(ts); x.setHours(0, 0, 0, 0); return x.getTime(); };
/** ts 落在 [今天-6, 今天] 的日桶（索引 6=六天前 … 0=今天），越界返回 null。 */
function dayIndex(ts, now) {
  const d = Math.floor((startOfDay(now) - startOfDay(ts)) / DAY_MS);
  return d >= 0 && d < DAILY_DAYS ? DAILY_DAYS - 1 - d : null;
}

function aggTools(storagesDir, now) {
  const file = join(storagesDir, 'agint_tool_stats.jsonl');
  const text = readFileSync(file, 'utf8');
  const cutoff = now - WINDOW_DAYS * DAY_MS;
  const byTool = new Map();
  const daily = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; } // 坏行跳过，不整源报废
    if (typeof r.ts !== 'number' || r.ts < cutoff || typeof r.tool !== 'string') continue;
    const a = byTool.get(r.tool) ?? { t: r.tool, n: 0, f: 0, last: 0 };
    a.n += 1;
    if (r.ok !== true) a.f += 1;
    if (r.ts > a.last) a.last = r.ts;
    byTool.set(r.tool, a);
    const i = dayIndex(r.ts, now);
    if (i !== null) {
      const arr = daily.get(r.tool) ?? new Array(DAILY_DAYS).fill(0);
      arr[i] += 1;
      daily.set(r.tool, arr);
    }
  }
  const rows = [...byTool.values()].sort((x, y) => y.n - x.n || x.t.localeCompare(y.t));
  return {
    rows,
    daily: Object.fromEntries(daily),
    total: rows.reduce((s, r) => s + r.n, 0),
    windowDays: WINDOW_DAYS,
    observedAt: mtimeIso(file),
  };
}

function aggCron(storagesDir) {
  const file = join(storagesDir, 'agint_cron.json');
  const body = JSON.parse(readFileSync(file, 'utf8'));
  const cs = body?.tables?.cron_state;
  if (!cs || typeof cs !== 'object') return { state: 'error', reason: 'cron_state 表缺失或形态未知' };
  const jobs = Object.entries(cs)
    .map(([j, v]) => ({ j, last: v?.lastRunAt ?? null, res: v?.lastResult ?? '?', err: v?.lastError ?? null }))
    .sort((a, b) => String(b.last ?? '').localeCompare(String(a.last ?? '')));
  return { jobs, count: jobs.length, observedAt: mtimeIso(file) };
}

function aggBus(storagesDir, now) {
  const file = join(storagesDir, 'agint_event_bus.json');
  const body = JSON.parse(readFileSync(file, 'utf8'));
  const events = body?.tables?.events;
  if (!events || typeof events !== 'object') return { state: 'error', reason: 'events 表缺失或形态未知' };
  const topics = new Map();
  const topicLast = new Map();
  const sources = new Map();
  const daily = new Map();
  let total = 0;
  let first = null;
  let last = null;
  for (const v of Object.values(events)) {
    const e = v?.envelope;
    if (!e) continue;
    total += 1;
    if (e.topic) {
      topics.set(e.topic, (topics.get(e.topic) ?? 0) + 1);
      if (e.occurredAt && (!topicLast.get(e.topic) || e.occurredAt > topicLast.get(e.topic))) {
        topicLast.set(e.topic, e.occurredAt);
      }
    }
    if (e.source) sources.set(e.source, (sources.get(e.source) ?? 0) + 1);
    const ts = Date.parse(e.occurredAt ?? '');
    if (Number.isFinite(ts)) {
      if (!first || e.occurredAt < first) first = e.occurredAt;
      if (!last || e.occurredAt > last) last = e.occurredAt;
      const i = dayIndex(ts, now);
      if (i !== null && e.source) {
        const arr = daily.get(e.source) ?? new Array(DAILY_DAYS).fill(0);
        arr[i] += 1;
        daily.set(e.source, arr);
      }
    }
  }
  const dl = body?.tables?.deadletter;
  const sortDesc = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    total,
    deadletter: dl && typeof dl === 'object' ? Object.keys(dl).length : 0,
    topics: sortDesc(topics),
    /** topic → 全历史最后一次发布的 occurredAt。订阅投递分层要用：投递计数随进程重启
     *  清零，而「这个主题到底有没有人发过」只有全历史能回答。 */
    topicLast: Object.fromEntries(topicLast),
    sources: sortDesc(sources),
    daily: Object.fromEntries(daily),
    range: [first, last],
    observedAt: mtimeIso(file),
  };
}

/**
 * 技能候选里**还在等人处理**的状态（白名单，不是排除法）。
 *
 * 为什么必须过滤（2026-10-18 老板令「已经审过了，就不要挂在那里了」）：
 * 本行原来是 `select: () => true` —— 把整张 candidates 表都算待办，连终态也算。
 * 实测生产存储（`storages/agint_skill_autocreate.json`，2026-10-18 21:5x 读）：
 * 42 条候选 = 37 条 REJECTED + 5 条 ROLLED_BACK，**待审 0 条**，面板却报「42 待审」。
 *
 * 状态机口径见 `agint-skill-autocreate/lib/schema.js:39` 的 CANDIDATE_STATUSES：
 *  - 终态，永不再需要人动手：REJECTED / REJECTED_STATIC / REJECTED_SANDBOX /
 *    REJECTED_EVAL / ROLLED_BACK / STABLE。
 *  - 中间态，由 cron 自己推进，人无事可做：RELEASED（等观察期滚动转 STABLE）。
 *  - 白名单只留「停在这里就是在等人」的六个：评估待跑（PENDING_EVAL / PHASE*_PASS）
 *    与发布待点头（QUEUED_FOR_RELEASE / BUDGET_WAIT，对应 autocreate_release 入口）。
 *
 * ⛔ 用白名单而不是黑名单：新增状态时默认**不进待办**，宁可漏报也不谎报积压。
 */
const CANDIDATE_OPEN_STATUSES = Object.freeze([
  'PENDING_EVAL',
  'PHASE1_PASS', 'PHASE2_PASS', 'PHASE3_PASS',
  'QUEUED_FOR_RELEASE', 'BUDGET_WAIT',
]);

/**
 * 积压队列的声明表。加一行队列 = 加一条 spec，不改聚合逻辑。
 *
 * kind 的两个值不是分类学，是**给用户的两种不同动作**：
 *  - `action` —— 攒着等人处理（挑战没人做、提案没人批）。人能直接动手。
 *  - `supply` —— 上游供给不足（失败样本攒不够）。人能做的只是去产生真实失败，
 *    没有「直接处理」这个动作；混进待办列表会诱导出「点一下就好」的错觉。
 */
/**
 * 提案行有没有标阻塞。
 *
 * 判据的单一事实源在 agint-evolve（`proposalBlocked()`），但两个插件之间没有
 * import 关系（面板只读存储文件），所以这里保留一份等价实现。等价性由测试钉住
 * （v2-pending.test.mjs 的 blocker 用例 + agint-evolve smoke）。
 * ⛔ 字段缺席（加字段前的历史行）与空串都算「没卡住」—— 缺字段不等于原因未知。
 */
const hasBlocker = (r) => typeof r?.blocker === 'string' && r.blocker.trim() !== '';
/**
 * 这条提案是不是正被自动执行管道处理（排队 / 在跑 / 顺延）。
 *
 * 判据的单一事实源在 agint-evolve（execution.js / claimDueExecutions 的 CLAIMABLE），
 * 面板读的是落盘文件、不 import 那个插件，所以保留一份等价实现 ——
 * 与 hasBlocker 同一处理方式，等价性由 v2-pending 用例钉住。
 * ⛔ 字段缺席（2026-10-27 之前批准的行）算「不在执行中」：它们本来就没有执行计划。
 */
const isExecActive = (r) => ['queued', 'running', 'deferred'].includes(r?.execState);


const PENDING_SPECS = Object.freeze([
  {
    key: 'curriculum-challenge',
    label: '课程挑战（出队待做）',
    kind: 'action',
    file: 'agint_curriculum.json',
    table: 'challenges',
    select: (r) => r.status === 'open',
    item: (r) => ({ id: r.id ?? null, domain: r.domain ?? null, level: r.level ?? null, attemptCount: r.attemptCount ?? 0, createdAt: r.createdAt ?? null }),
    note: (t) => `attempts=${Object.keys(t.attempts ?? {}).length}`,
  },
  {
    key: 'skill-candidate',
    label: '技能候选（待审）',
    kind: 'action',
    file: 'agint_skill_autocreate.json',
    table: 'candidates',
    supplyTable: 'task_patterns',
    supplyLabel: '上游 pattern',
    select: (r) => CANDIDATE_OPEN_STATUSES.includes(r.status),
    item: (r) => ({ id: r.id ?? null, title: r.skillDraft?.name ?? r.title ?? null, status: r.status ?? null }),
  },
  {
    key: 'evolve-proposal',
    label: '进化提案（待批）',
    kind: 'action',
    file: 'agint_evolve.json',
    table: 'proposal',
    select: (r) => r.status === 'proposed',
    item: (r) => ({ id: r.id ?? null, title: r.title ?? null }),
  },
  {
    // 2026-10-23：agint-evolve v0.8.0 补了 `approved`（人工批准、尚未执行）。
    // 没有这一行时，批准 = 从待办里消失 —— 决定做完了却没人去做，比不批更糟。
    // 这一行把「已批准」变成看得见的工作单。⚠️ 只统计，不自动执行：
    // 落地仍要人（或会话里的 AI）真的动手，落地后标 applied。
    //
    // 2026-10-27 收窄：只收**没有 blocker** 的。批准的是方向、前置没到位的那批
    // （a85ef850 就是：批了"权重真标定"，但周报冻结权重常量等 8-12 周样本）
    // 归到下面那一行 —— 它们是「等人动手」吗？不是，是「等条件」。混在一起
    // 就是拿工作单催人去撞自家门禁。
    // 2026-10-27 第三次收窄（批准即执行）：`execMode=immediate|scheduled` 的提案
    // 批准后自己进队列、由 agint-executor 动手 —— 它们不再是"人要做的事"。
    // 放进工作单就是拿催办单去催一个已经在跑的东西。
    // 于是本档只剩「已批准、但明确选了手动执行」的那批（唯一真正的工作单）。
    key: 'evolve-approved',
    label: '已批准·等手动执行（工作单）',
    kind: 'action',
    file: 'agint_evolve.json',
    table: 'proposal',
    // 2026-10-29：原来这里把 `autoExecutable===false` 的提案也塞进本档（等人做）。
    // 语义闸撤掉之后这个分支没有意义了：现在它们会照常入队，
    // 落进「自动执行中」或「自动执行失败」—— 都是机器的处境，不是人的工作单。
    select: (r) => r.status === 'approved' && !hasBlocker(r)
      && !isExecActive(r) && r.execState !== 'failed',
    item: (r) => ({ id: r.id ?? null, title: r.title ?? null }),
    note: () => '人工已批准且未交给自动执行；落地后标 applied',
  },
  {
    // 2026-10-27：批准即执行之后，「排队中 / 执行中 / 已顺延」是人**不用动手**的状态。
    // kind='supply' 与 blocker 那档同型：此刻人能做的只有等（或去撤销）。
    // ⛔ 不隐藏：隐藏掉的话，「批准之后到底有没有人在跑」就变成黑箱 ——
    //    而这次改动的全部目的，就是让「批完就没人管」不再发生。
    key: 'evolve-exec-active',
    label: '自动执行中（排队 / 在跑 / 顺延）',
    kind: 'supply',
    file: 'agint_evolve.json',
    table: 'proposal',
    select: (r) => r.status === 'approved' && isExecActive(r),
    item: (r) => ({
      id: r.id ?? null,
      title: r.title ?? null,
      state: r.execState ?? null,
      execMode: r.execMode ?? null,
      dueAt: r.execAt ?? '',
      attempts: r.execAttempts ?? 0,
      error: r.execError ?? '',
    }),
    note: () => '由 agint-executor 自动执行；成功会把提案标 applied，失败会留原因',
  },
  {
    // 2026-10-27：自动执行失败且重试额度用尽 —— 这是**必须人看**的一档。
    // 与「排队中」分开的理由：一个会自己好，一个不会。
    key: 'evolve-exec-failed',
    label: '自动执行失败（待处理）',
    kind: 'action',
    file: 'agint_evolve.json',
    table: 'proposal',
    // 2026-10-29：不再按 autoExecutable 排除 —— 那一档已不存在（批准即入队）。
    select: (r) => r.status === 'approved' && r.execState === 'failed',
    item: (r) => ({
      id: r.id ?? null,
      title: r.title ?? null,
      error: r.execError ?? '',
      attempts: r.execAttempts ?? 0,
    }),
    // 2026-10-27 修：note 收到的是**整份域的表**（`spec.note(r.tables)`），
    // 而 attempts 在每一行上 —— 取 `t.attempts` 恒 undefined，
    // 于是这条文案永远印「0 次尝试后仍失败」（实测那条是第 1 次就失败）。
    // 改为从 proposal 表里真正失败的行取最大值；一条都没有就不编数字。
    // ⛔ 用 Object.values 而不是 buildPending 内部那个 rowsOf()：作用域不同，
    //    回调里够不到它（运行期 ReferenceError，面板整节降级）。
    note: (t) => {
      const tbl = t && typeof t === 'object' ? t.proposal : null;
      const rows = tbl && typeof tbl === 'object' ? Object.values(tbl) : [];
      const max = rows.reduce((m, r) => (
        r && r.status === 'approved' && r.execState === 'failed'
          ? Math.max(m, Number(r.execAttempts) || 0)
          : m
      ), 0);
      return max > 0
        ? `失败前最多试过 ${max} 次（这类失败不会自己好）；改方案后重新批准，或 evolve_executions run 手动重跑`
        : '失败不会自己好；改方案后重新批准，或 evolve_executions run 手动重跑';
    },
  },
  {
    // 2026-10-27 新增：「批准了但动不了手」这一档。
    //
    // kind='supply' 不是偷懒复用：按本文件顶上的判据，`action` = 人能直接动手，
    // `supply` = 人能做的只是等上游/条件成熟。阻塞中的提案此刻唯一能做的事就是
    // 等（等样本攒够、等依赖落地），放进 action 表会诱导「点一下就好」的错觉。
    // 但不许隐藏：卡在哪、等什么必须一眼看得见，否则又退回「批了就没下文」。
    key: 'evolve-approved-blocked',
    label: '已批准·阻塞中（等前置）',
    kind: 'supply',
    file: 'agint_evolve.json',
    table: 'proposal',
    select: (r) => r.status === 'approved' && hasBlocker(r),
    item: (r) => ({
      id: r.id ?? null,
      title: r.title ?? null,
      blocker: r.blocker ?? '',
      unblockCondition: r.unblockCondition ?? '',
    }),
    note: () => '批准的是方向，不是「现在动手」；解锁条件满足后清 blocker 回到工作单',
  },
  {
    key: 'curator-overlap',
    label: 'curator 重叠候选',
    kind: 'action',
    file: 'agint_curator.json',
    table: 'overlap_candidates',
    // 同一类病的第二处（2026-10-18，与 skill-candidate 一起修）：这里原来也是
    // `() => true`。overlap_candidates 的状态机是 proposed / acknowledged / resolved
    // （agint-curator/lib/schema.js:212），后两个已经是人处理过的。
    // 本机此刻是 0 行，所以现场没有症状——但判据写错了，一有数据就会重演「已审的还挂着」。
    select: (r) => r.status === 'proposed',
    item: (r) => ({ id: r.id ?? null, title: r.skillA && r.skillB ? `${r.skillA} ↔ ${r.skillB}` : (r.id ?? null) }),
  },
  {
    key: 'failure-supply',
    label: '失败样本供给（上游）',
    kind: 'supply',
    file: 'agint_evolution.json',
    table: 'failure_pattern',
    select: () => true,
    item: () => ({}),
    // COLD_START_MIN（agint-diagnosis/lib/index.js:56）：低于它 annotate 的冷启动
    // 守门直接 throw，整条 diagnosis 链产不出东西。这不是配置，是代码里的常量。
    threshold: 10,
  },
]);

/**
 * 积压待办队列：把「攒着等人处理」的几张表汇成一节。
 *
 * 为什么要有这节：面板原有 Q1/Q2/Q3 答的是「谁依赖谁 / 谁在干活 / 哪里在腐化」，
 * 答的都是**结构与故障**；没有任何一处回答「**现在有什么等着人处理**」。
 * 缺了它，队列积压只能靠翻 storages 才发现 —— 于是每一条积压都会各自
 * 变成一份 known-limitations，而不是被看见的待办。
 *
 * 纪律（同本文件其余各源）：
 *  - 一域坏只降级那一行，其余照常，绝不装绿。
 *  - 域缺失 → state='unavailable' 且 pending=null，**不是 0**：「本机没开这个域」
 *    与「这个域确实是空的」是两件事，只有后者才是真的没事。
 *
 * @param {string} storagesDir
 * @returns {{queues: Array<object>, observedAt: string|null}}
 */
export function aggPending(storagesDir) {
  const cache = new Map();
  const readTables = (file) => {
    if (cache.has(file)) return cache.get(file);
    const p = join(storagesDir, file);
    let out;
    if (!existsSync(p)) out = { missing: true };
    else {
      try {
        const t = JSON.parse(readFileSync(p, 'utf8'))?.tables;
        out = (t && typeof t === 'object') ? { tables: t, mtime: mtimeIso(p) } : { missing: true };
      } catch (e) {
        out = { error: String((e && e.message) ?? e).slice(0, 200) };
      }
    }
    cache.set(file, out);
    return out;
  };

  const rowsOf = (t) => (t && typeof t === 'object' ? Object.values(t) : []);
  const queues = [];
  let observedAt = null;

  for (const spec of PENDING_SPECS) {
    const base = { key: spec.key, label: spec.label, kind: spec.kind, items: [] };
    const r = readTables(spec.file);

    if (r.missing) {
      queues.push({ ...base, state: 'unavailable', reason: '域不存在', pending: null });
      continue;
    }
    if (r.error) {
      queues.push({ ...base, state: 'error', reason: r.error, pending: null });
      continue;
    }
    const tbl = r.tables[spec.table];
    if (!tbl || typeof tbl !== 'object') {
      queues.push({ ...base, state: 'error', reason: `${spec.table} 表缺失或形态未知`, pending: null });
      continue;
    }

    const all = rowsOf(tbl);
    const hits = all.filter((x) => x && typeof x === 'object' && spec.select(x));
    const q = {
      ...base,
      state: 'ok',
      pending: hits.length,
      total: all.length,
      items: hits.slice(0, 20).map(spec.item),
      observedAt: r.mtime,
    };
    if (spec.threshold !== undefined) q.threshold = spec.threshold;
    if (spec.supplyTable) {
      q.supply = rowsOf(r.tables[spec.supplyTable]).length;
      q.supplyLabel = spec.supplyLabel;
    }
    if (spec.note) q.note = spec.note(r.tables);
    queues.push(q);
    observedAt = observedAt ?? r.mtime;
  }

  return { queues, observedAt };
}

// ═══ 神谕层（agint-aesthetic-oracle）═══════════════════════════════════════

/**
 * 神谕层输出的归一化（纯函数）：宿主半取数与单测共用一份口径。
 *
 * 为什么需要归一化而不是直接透传：oracle 的三个出口形状各不相同 ——
 *  `cards()` 给 {topic, envelopeId, occurredAt, receivedAt, payload}，
 *  `history()` 给广播行（id/kind/ts/score/verdict/worstKey/outcome…），
 *  `getState()` 给单行状态（paused/silenceMode/quota/baseline/lastGood）。
 * 面板要在一页里并列展示这三者，就必须先摊平成同一个口径；否则前端各自
 * 猜字段名，是「三处口径漂移」那一族坑（本插件 v0.2.x 已因同源问题返工三次）。
 *
 * 纪律（与本文件其余各源一致）：
 *  - 三段（卡片 / 广播史 / 状态行）各自可缺，缺的那段给 null 或空数组，
 *    绝不用 0 或「无」冒充「确实没有」。整段全缺才 state='unavailable'。
 *  - Δ vs 基线**只在口径可比时给数**。生产 state 行的 baseline 没有
 *    formulaVersion 字段（建基于 2026-10-04，评分公式 r3 于 2026-10-09 落地），
 *    所以跨版本 Δ 不可直接比 —— 此时 delta 照算但 comparable=false，
 *    并附 reason。这是「不藏风险」，不是多此一举。
 *
 * @param {{cards?: Array, broadcasts?: Array, state?: object|null, runtime?: object|null,
 *          source?: string, notes?: string[], observedAt?: string|null, limit?: number}} raw
 * @returns {object} payload.oracle
 */
export function normalizeOracle(raw = {}) {
  const limit = Number.isInteger(raw.limit) && raw.limit > 0 ? raw.limit : 20;
  const notes = Array.isArray(raw.notes) ? raw.notes.filter(Boolean).map((s) => String(s).slice(0, 240)) : [];
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v) => (typeof v === 'string' && v !== '' ? v : null);

  /** 卡片 payload → 展示口径。payload 是 unknown 形，逐字段挑，不整块透传。 */
  const pickCard = (c) => {
    const p = c && typeof c.payload === 'object' && c.payload !== null ? c.payload : {};
    return {
      topic: str(c && c.topic) ?? '',
      envelopeId: str(c && c.envelopeId),
      occurredAt: str(c && c.occurredAt),
      receivedAt: str(c && c.receivedAt),
      kind: str(p.kind),
      asOf: str(p.asOf),
      score: num(p.score),
      verdict: str(p.verdict),
      worstKey: str(p.worstKey),
      lines: Array.isArray(p.lines) ? p.lines.map(String).slice(0, 12) : [],
      text: str(p.text),
      mode: str(p.mode),
      formulaVersion: str(p.formulaVersion),
      scaleHash: str(p.scaleHash),
      staleDays: num(p.staleDays),
      // oracle.alert 的双形态：内部告警带 reason/error，程序化警报带 text
      alertReason: str(p.reason),
      alertError: str(p.error),
    };
  };

  /** 同一 topic 只留最新一张（cards 表按 topic 存一行，服务面理论上也是；双保险）。 */
  const byTopic = new Map();
  for (const c of Array.isArray(raw.cards) ? raw.cards : []) {
    const card = pickCard(c);
    if (!card.topic) continue;
    const prev = byTopic.get(card.topic);
    if (!prev || String(card.occurredAt ?? '') > String(prev.occurredAt ?? '')) byTopic.set(card.topic, card);
  }
  const cards = [...byTopic.values()].sort((a, b) => a.topic.localeCompare(b.topic));

  const stateRow = raw.state && typeof raw.state === 'object' ? raw.state : null;
  const baseline = stateRow && typeof stateRow.baseline === 'object' && stateRow.baseline !== null ? stateRow.baseline : null;
  const baseScore = baseline ? num(baseline.score) : null;
  const baseFormula = baseline ? str(baseline.formulaVersion) : null;

  /**
   * 口径可比性判据（单一事实源，前端只读这个标志，不自己算）。
   *  ⛔ 不可比时说不可比，不把跨版本差值当趋势。
   *  ⛔ baseline 缺 formulaVersion（生产现状）= 未知口径 ⇒ 不可比，不能当成「一致」。
   */
  const comparableOf = (formulaVersion) => {
    if (baseScore === null) return { comparable: false, reason: '基线未建立（state.baseline.score 为空）' };
    if (baseFormula === null) {
      return { comparable: false, reason: '基线无 formulaVersion（建基于评分公式换版之前），Δ 跨口径，不可当趋势读' };
    }
    /** 本轮无标记也要判不可比：广播行 schema 里没有 formulaVersion 字段，
     *  缺席 ≠ 一致。把它当成一致就是「拿未知当已知」。 */
    if (!formulaVersion) {
      return { comparable: false, reason: '本轮无 formulaVersion 标记（旧发布方或广播行 schema 不含该字段），口径未知' };
    }
    if (formulaVersion !== baseFormula) {
      return { comparable: false, reason: `基线口径 ${baseFormula} ≠ 本轮 ${formulaVersion}，不可直接比` };
    }
    return { comparable: true, reason: null };
  };

  const pickBroadcast = (r) => {
    const score = num(r && r.score);
    const cmp = comparableOf(str(r && r.formulaVersion));
    return {
      id: str(r && r.id),
      kind: str(r && r.kind),
      ts: str(r && r.ts),
      asOf: str(r && r.asOf),
      score,
      verdict: str(r && r.verdict),
      worstKey: str(r && r.worstKey),
      lines: num(r && r.lines),
      bytes: num(r && r.bytes),
      published: r ? r.published === true : false,
      outcome: str(r && r.outcome) ?? 'unknown',
      detail: str(r && r.detail),
      proposals: num(r && r.proposals),
      formulaVersion: str(r && r.formulaVersion),
      delta: score !== null && baseScore !== null ? Math.round((score - baseScore) * 10) / 10 : null,
      deltaComparable: cmp.comparable,
      deltaReason: cmp.reason,
    };
  };
  const history = (Array.isArray(raw.broadcasts) ? raw.broadcasts : [])
    .map(pickBroadcast)
    .sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')))
    .slice(0, limit);

  /** 判词 = 最新一张 daily；没有 daily 才退到 weekly → monthly → alert。 */
  const latest = cards.find((c) => c.topic === 'oracle.daily')
    ?? cards.find((c) => c.topic === 'oracle.weekly')
    ?? cards.find((c) => c.topic === 'oracle.monthly')
    ?? cards.find((c) => c.topic === 'oracle.alert')
    ?? null;
  const latestCmp = comparableOf(latest ? latest.formulaVersion : null);
  const latestDelta = latest && latest.score !== null && baseScore !== null
    ? Math.round((latest.score - baseScore) * 10) / 10
    : null;

  const out = {
    state: 'ok',
    source: str(raw.source) ?? 'unknown',
    notes,
    observedAt: str(raw.observedAt),
    cards,
    latest: latest === null ? null : { ...latest, delta: latestDelta, deltaComparable: latestCmp.comparable, deltaReason: latestCmp.reason },
    history,
    runtime: raw.runtime && typeof raw.runtime === 'object' ? {
      enabled: raw.runtime.enabled !== false,
      envOff: raw.runtime.envOff === true,
      memoryStore: raw.runtime.memoryStore === true,
      disposed: raw.runtime.disposed === true,
      metricsAvailable: raw.runtime.metricsAvailable === true,
      evolutionAvailable: raw.runtime.evolutionAvailable === true,
      busAvailable: raw.runtime.busAvailable === true,
    } : null,
    stateRow: stateRow === null ? null : {
      paused: stateRow.paused === true,
      pausedReason: str(stateRow.pausedReason),
      pausedAt: str(stateRow.pausedAt),
      silenceActive: !!(stateRow.silenceMode && stateRow.silenceMode.active),
      silenceSince: str(stateRow.silenceMode && stateRow.silenceMode.since),
      silenceReason: str(stateRow.silenceMode && stateRow.silenceMode.reason),
      consecutiveFailures: num(stateRow.consecutiveFailures) ?? 0,
      updatedAt: str(stateRow.updatedAt),
      baseline: baseline === null ? null : {
        establishedAt: str(baseline.establishedAt),
        score: baseScore,
        composites: baseline.composites && typeof baseline.composites === 'object' ? baseline.composites : {},
        method: str(baseline.method),
        rebaselinedAt: str(baseline.rebaselinedAt),
        sampleCounts: baseline.sampleCounts && typeof baseline.sampleCounts === 'object' ? baseline.sampleCounts : {},
        windowDays: num(baseline.windowDays),
        formulaVersion: baseFormula,
      },
      lastGood: stateRow.lastGood && typeof stateRow.lastGood === 'object' ? {
        asOf: str(stateRow.lastGood.asOf),
        savedAt: str(stateRow.lastGood.savedAt),
      } : null,
      quota: stateRow.quota && typeof stateRow.quota === 'object' ? {
        date: str(stateRow.quota.date),
        daily: num(stateRow.quota.daily) ?? 0,
        weekly: num(stateRow.quota.weekly) ?? 0,
        monthly: num(stateRow.quota.monthly) ?? 0,
        bytes: num(stateRow.quota.bytes) ?? 0,
        violations: num(stateRow.quota.violations) ?? 0,
        alerts: num(stateRow.quota.alerts) ?? 0,
      } : null,
    },
    /** 历史行里可比的占比：一眼看出「Δ 那一列有多少行是能读的」。 */
    historyComparable: history.filter((r) => r.deltaComparable).length,
  };
  if (cards.length === 0 && history.length === 0 && out.stateRow === null) {
    out.state = 'unavailable';
    out.reason = notes.length ? notes.join('；') : '神谕层三段（卡片 / 广播史 / 状态行）全缺';
  }
  return out;
}

/**
 * 落盘口径的**原始三段**（不归一）：给需要跨源合并的调用方用。
 *
 * 为什么要拆开：宿主半要把「服务面」与「落盘」两路合并后再归一一次
 * （cards 可能服务面为空而文件里有 —— 订阅未回写的常见形态），
 * 若只能拿到归一结果，合并就得在已摊平的字段上逆向重建，等于二次口径漂移。
 *
 * @param {string} storagesDir
 * @returns {{ok: boolean, reason?: string, cards?: Array, broadcasts?: Array, state?: object|null, observedAt?: string|null}}
 */
export function readOracleFile(storagesDir) {
  const file = join(storagesDir, 'agint_aesthetic_oracle.json');
  if (!existsSync(file)) {
    return { ok: false, reason: '神谕层存储域不存在（agint_aesthetic_oracle.json 不在 storages/）', observedAt: null };
  }
  let body;
  try { body = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    return { ok: false, reason: `存储域解析失败：${String((e && e.message) ?? e).slice(0, 160)}`, observedAt: null };
  }
  const t = body && typeof body.tables === 'object' && body.tables !== null ? body.tables : null;
  if (t === null) return { ok: false, reason: 'tables 缺失或形态未知', observedAt: null };
  const vals = (tbl) => (tbl && typeof tbl === 'object' ? Object.values(tbl) : []);
  return {
    ok: true,
    cards: vals(t.oracle_cards),
    broadcasts: vals(t.oracle_broadcasts),
    state: t.oracle_state && typeof t.oracle_state === 'object' ? (t.oracle_state.latest ?? null) : null,
    observedAt: mtimeIso(file),
  };
}

/**
 * 上游判读（`agint_upstream_watch` 域）落盘口径。
 *
 * ⛔ 这一节与其它各节的失败模式不同，必须分开处理：
 *    **「文件不存在」= 本机没启用这个插件**，不是「判读结果为空」。
 *    前者显示为灰色不可用，后者才是真的 0（与待办节的「域不存在 ≠ 0」同一条纪律）。
 *
 * ⛔ `baselineOnly` 这一段是**刻意**的：频道首次运行只建基线、不产信号，
 *    上线当天如果面板显示「0 条判读」，读的人会以为坏了。
 *    判据：`releases` 有记录而 `digests` 为空 ⇒ 明确写出「已建基线，等新版本」。
 *
 * @param {string} storagesDir
 * @returns {object}
 */
export function aggUpstream(storagesDir) {
  const file = join(storagesDir, 'agint_upstream_watch.json');
  if (!existsSync(file)) {
    return {
      state: 'unavailable',
      source: 'storages',
      reason: '上游判读存储域不存在（agint_upstream_watch.json 不在 storages/）—— 本机未启用 agint-upstream-watch，或尚未跑过第一次',
      observedAt: null,
      digests: [],
      counts: { digests: 0, judged: 0, failed: 0, blockers: 0, semanticWarn: 0 },
      latest: null,
      releases: null,
      baselineOnly: false,
      calibration: null,
    };
  }

  let body;
  try { body = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    return {
      state: 'error', source: 'storages',
      reason: `存储域解析失败：${String((e && e.message) ?? e).slice(0, 160)}`,
      observedAt: null, digests: [], counts: { digests: 0, judged: 0, failed: 0, blockers: 0, semanticWarn: 0 },
      latest: null, releases: null, baselineOnly: false, calibration: null,
    };
  }

  const t = body && typeof body.tables === 'object' && body.tables !== null ? body.tables : null;
  if (t === null) {
    return {
      state: 'error', source: 'storages', reason: 'tables 缺失或形态未知',
      observedAt: null, digests: [], counts: { digests: 0, judged: 0, failed: 0, blockers: 0, semanticWarn: 0 },
      latest: null, releases: null, baselineOnly: false, calibration: null,
    };
  }

  const vals = (tbl) => (tbl && typeof tbl === 'object' ? Object.values(tbl) : []);
  const s = (v) => (typeof v === 'string' && v !== '' ? v : null);
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  const releases = vals(t.releases);
  const rawDigests = vals(t.digests);

  // 最新发行 = 按发布时间（缺失则按 tag）取最大的一条
  const latestRow = [...releases]
    .sort((a, b) => String(b.publishedAt ?? b.tag ?? '').localeCompare(String(a.publishedAt ?? a.tag ?? '')))[0] ?? null;

  const digests = rawDigests
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    .slice(0, 20)
    .map((d) => {
      const facts = d.facts && typeof d.facts === 'object' ? d.facts : {};
      const impact = d.impactSummary ?? facts.impactSummary ?? null;
      const sem = d.semanticSummary ?? facts.semanticSummary ?? null;
      const host = d.hostFace ?? facts.hostFace ?? null;
      return {
        tag: s(d.tag),
        targetVersion: s(d.targetVersion),
        level: s(d.level),
        preStageChange: s(d.preStageChange),
        llmStatus: s(d.llmStatus) ?? 'unknown',
        verdict: s(d.verdict),
        confidence: n(d.confidence),
        headline: s(d.headline),
        factsSummary: s(d.factsSummary),
        proposalCount: Array.isArray(d.proposalIds) ? d.proposalIds.length : 0,
        // 语义面：面板要能一眼分开「签名破了」和「引擎抬了」
        impact: impact && typeof impact === 'object' ? {
          blocking: n(impact.blocking) ?? 0,
          breaking: n(impact.breaking) ?? 0,
          elsewhere: n(impact.elsewhere) ?? 0,
          additive: n(impact.additive) ?? 0,
          unknown: n(impact.unknown) ?? 0,
        } : null,
        semantic: sem && typeof sem === 'object' ? {
          blocker: n(sem.blocker) ?? 0, warn: n(sem.warn) ?? 0, info: n(sem.info) ?? 0,
        } : null,
        host: host && typeof host === 'object' ? {
          from: s(host.from), to: s(host.to),
          semanticImpact: s(host.semanticImpact),
          deltas: Array.isArray(host.semanticDeltas)
            ? host.semanticDeltas.slice(0, 6).map((x) => ({
              kind: s(x.kind), symbol: s(x.symbol), severity: s(x.severity), note: s(x.note),
              before: s(x.before), after: s(x.after),
            }))
            : [],
        } : null,
        updatedAt: s(d.updatedAt) ?? s(d.createdAt),
      };
    });

  const judged = digests.filter((d) => d.llmStatus === 'judged').length;
  const failed = digests.filter((d) => d.llmStatus === 'failed').length;
  const blockers = digests.reduce((a, d) => a + (d.impact?.blocking ?? 0) + (d.semantic?.blocker ?? 0), 0);
  const semanticWarn = digests.reduce((a, d) => a + (d.semantic?.warn ?? 0), 0);

  return {
    state: 'ok',
    source: 'storages',
    observedAt: mtimeIso(file),
    digests,
    counts: { digests: rawDigests.length, judged, failed, blockers, semanticWarn },
    latest: latestRow ? {
      tag: s(latestRow.tag),
      publishedAt: s(latestRow.publishedAt),
      prerelease: latestRow.prerelease === true,
      entryCount: n(latestRow.entryCount),
      breakingHits: n(latestRow.breakingHits),
    } : null,
    releases: {
      total: releases.length,
      fetchedAt: s(latestRow?.fetchedAt),
    },
    // 有发行记录、没有判读 ⇒ 首跑只建了基线（不是坏了）
    baselineOnly: releases.length > 0 && rawDigests.length === 0,
    calibration: null, // 宿主半用服务面覆盖（v0.3）
  };
}

/**
 * 落盘口径的神谕层聚合：读 `storages/agint_aesthetic_oracle.json` 三表并归一。
 *
 * 为什么读文件而不是只读服务面：面板其余各源都是落盘口径，且服务面依赖
 * 宿主进程内的 event-bus 订阅（cards 只有订阅活着才回写）。两条路都留：
 *  - 服务面（lib/index.js collectOracle）优先 —— 带运行态开关（envOff / busAvailable）
 *  - 落盘（本函数）兜底 —— 订阅没回写时卡片仍在文件里，不至于整页空白
 * 合并规则在 collectOracle，本函数只负责「把文件读成归一输出」。
 *
 * @param {string} storagesDir
 * @returns {object} normalizeOracle 的输出（失败为 {state:'error'|'unavailable'}）
 */
export function aggOracle(storagesDir) {
  const raw = readOracleFile(storagesDir);
  if (!raw.ok) {
    return { state: existsSync(join(storagesDir, 'agint_aesthetic_oracle.json')) ? 'error' : 'unavailable', source: 'storages', reason: raw.reason, notes: [], observedAt: null };
  }
  return normalizeOracle({
    cards: raw.cards,
    broadcasts: raw.broadcasts,
    state: raw.state,
    runtime: null,
    source: 'storages',
    observedAt: raw.observedAt,
  });
}

/**
 * 插件身份表（**单一事实源**）：产出**代码身份**—— 一个目录当且仅当**有 lib/** 才算。
 *
 * ⛔ 为什么不按「顶层目录名」占位：quality 家族在仓库位有**门面目录**
 *   （plugins/agint-quality-eval/ 只有 manifest.json + test，main 指向
 *   ../agint-quality/agint-quality-eval/lib/index.js，是 plugin-check 入口），
 *   真身住在嵌套目录。门面既没有 lib/（不产生代码），其 manifest 也可能不含
 *   全部consumes（实测门面 consumes=0、真身=10）。按顶层名占位会让契约读进门面
 *   ⇒「manifest 漏写」把已补齐的 quality-eval 误报一次（2026-10-04 实测）。
 *
 * ⚠️ 身份表**只含有 lib 的**。聚合容器（plugins/agint-quality：顶层无 lib、
 *   子目录才是插件）与纯门面因此**不在**本表里——它们没有代码、没有契约。
 *   它们仍需被形态分类（判成 container / facade 以豁免僵尸候选），
 *   由 classifyPlugins 单独遍历顶层目录补上，两处职责不混。
 *
 * 判据与 v2-scan 的 codeRoots() 一致（那边叫「代码根」）：有 lib/ 才是身份。
 *
 * @param {string} pluginsDir
 * @returns {Array<{id:string, root:string, top:boolean}>} 身份（顶层优先、嵌套补位）
 */
export function pluginIdentities(pluginsDir) {
  let dirs = [];
  try { dirs = readdirSync(pluginsDir); } catch { return []; }
  const topDirs = dirs
    .filter((d) => d.startsWith('agint-') && !d.includes('.bak-') && !isTmpLeftover(d))
    .filter((d) => { try { return statSync(join(pluginsDir, d)).isDirectory(); } catch { return false; } })
    .sort();
  const units = [];
  const taken = new Set();
  const pending = [];
  for (const d of topDirs) {
    for (const r of codeRoots(join(pluginsDir, d))) {
      const rec = { id: r.id, root: r.root, top: r.top };
      if (r.top) { taken.add(r.id); units.push(rec); } else pending.push(rec);
    }
  }
  for (const rec of pending) {
    if (taken.has(rec.id)) continue;
    taken.add(rec.id);
    units.push(rec);
  }
  return units;
}

/**
 * 列出**全部顶层 agint-* 目录**（含无 lib 的聚合容器与门面），供 classifyPlugins 用。
 * @param {string} pluginsDir
 * @returns {string[]}
 */
export function topLevelPluginDirs(pluginsDir) {
  let dirs = [];
  try { dirs = readdirSync(pluginsDir); } catch { return []; }
  return dirs
    .filter((d) => d.startsWith('agint-') && !d.includes('.bak-') && !isTmpLeftover(d))
    .filter((d) => { try { return statSync(join(pluginsDir, d)).isDirectory(); } catch { return false; } })
    .sort();
}

/**
 * 三形态 manifest 解析（spec.cordis / 顶层 cordis / 无 manifest 跳过），只收非空声明。
 *
 * 口径（2026-10-05 改）：声明消费 = `consumes` ∪ `optionalInject`（去重、保序）。
 *  - 为什么并 optionalInject：两者都是「本插件要读别的服务」的契约，只是缺失时
 *    一个报错一个降级。此前只读 consumes，导致把消费全写在 optionalInject 的
 *    插件（agint-family-panel 三条）被算成「未声明」，判定层因此报它「从未接线」。
 *  - 为什么**不并 inject**：inject 是宿主 DI 注入名（webServer / timer /
 *    storageDomain），不写在 ctx.get 调用位。并进来实测多 2 条假腐化
 *    （agint-quality-policy→storageDomain；agint-dream→agint.metrics 走注入参数），
 *    2026-10-05 两口径对照同一冻结判据跑过。
 *
 * 身份口径见 pluginIdentities()：门面目录不产生身份，契约从真身读。
 *
 * @param {string} pluginsDir
 * @returns {Record<string,string[]>} 插件身份 → 声明消费的服务键列表
 */
function readManifestConsumes(pluginsDir) {
  const out = {};
  for (const u of pluginIdentities(pluginsDir)) {
    const file = join(u.root, 'manifest.json');
    if (!existsSync(file)) continue;
    try {
      const m = JSON.parse(readFileSync(file, 'utf8'));
      const c = m?.spec?.cordis ?? m?.cordis ?? {};
      const pick = (k) => (Array.isArray(c[k]) ? c[k] : []);
      const decl = [...new Set([...pick('consumes'), ...pick('optionalInject')])].filter(Boolean);
      if (decl.length > 0) out[u.id] = decl;
    } catch { /* 坏 manifest 单插件跳过 */ }
  }
  return out;
}

/**
 * 从 cordis.patch.yml 读出**实际挂载**的插件 id集合。
 *
 * 为什么必须读文件、不能靠猜：「REMOVED」在 patch 里的表示是**把整行注释掉**
 * （agint-quality-report 的 id 行与 name 行都在注释里，见 cordis.patch.yml:136-137）。
 * 目录还在、manifest 还在、代码还在 —— 只有 patch 知道它没挂。
 * 于是判据是：patch 里出现 `- id: <name>` **且该行不在注释里**。
 *
 * ⚠️ 口径边界（照实说）：本函数读的是**文本**，不解析 YAML。
 *   - 路径：先找 <pluginsDir>/../../cordis.patch.yml（部署位），
 *     再找 <pluginsDir>/../../../cordis.patch.yml（仓库位 plugins/ 的上一级）。
 *   - 只认 `- id: ` 前缀的行；`# - id: ` 视为注释（REMOVED）。
 *   - 读不到 ⇒ 返回 null（挂载态未知），面板据此标 amber，不猜。
 *
 * @param {string} pluginsDir
 * @returns {Set<string>|null} 已挂载 id 集合；null = 读不到，挂载态未知
 */
export function readMountedFromPatch(pluginsDir) {
  // 向上逐级找 cordis.patch.yml（最多 5 级）。
  // ⛔ 不写死层级：仓库位在 plugins/ 的上一级，部署位实测在
  //    <DSH_HOME>/.agint-bundle/cordis.patch.yml（离 plugins/ 三级），
  //    另有 <DSH_HOME>/profiles/web/plugins/@agint/host/cordis.patch.yml 这一份
  //    是**加载位**（AGENT 记忆：bundle 位才是加载位）。写死任何单一相对路径
  //    都会在另一种布局下读不到 ⇒静默退化成「挂载态未知」。
  let dir = resolve(pluginsDir);
  for (let i = 0; i < 5; i += 1) {
    const file = join(dir, 'cordis.patch.yml');
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { text = null; }
    if (text !== null) {
      const ids = new Set();
      for (const line of text.split('\n')) {
        // 注释行跳过（REMOVED 的表示方式）。
        // 两道防线的分工（各自都被变异测试咬过，别删任何一道）：
        //  ① 本句：行首 # 直接跳过。
        //  ② 下面那条 id 正则以 `-` 锚定开头，`# - id: x` 天然不命中。
        // 变异实测：只放宽 ② → 本句兜住、测试仍绿；① ② 同时失效 → 测试变红。
        if (line.trimStart().startsWith('#')) continue;
        const m = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line);
        if (m) ids.add(m[1]);
      }
      return ids;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 插件形态分类（供僵尸候选豁免用）。
 *
 * 判据全部来自**可核的结构事实**，不来自人工名单：
 *  - checker    存在 lib/checkers/ 目录 ⇒ 静态检查器。它扫**别的插件源码里的字面量
 *               token**，自己ctx.get 为 0 是职责不是断线（判据优先于其余全部）
 *  - container  顶层目录无 lib/ 但有子插件目录 ⇒ 聚合容器（本身不产出）
 *  - tool-only  main 指向 lib/tools.js ⇒ 纯工具集（工具名不属 agint.* 前缀 ⇒ tool_stats 归属推断不到）
 *  - library    main 是 index.js ⇒ 纯函数库（被 import，不挂载）
 *  - sdk        tools 为空且 provides 非空 ⇒ 服务库（产出体现为被消费方调用）
 *  - unmounted  上表判到 host 但传入了 mounted Set 而该名不在其中（REMOVED）
 *  - host       其余
 *
 * ⛔ 覆盖范围必须含**嵌套身份**（顶层优先、嵌套补位，与 codeRoots 同规则）：
 *    只分类顶层会让 quality-contract 这类嵌套服务库查不到形态，
 *    于是它落进「真僵尸候选」——而它正被 quality-policy 消费，不是死代码。
 *
 * unmounted 判不进来时返回 null（不猜）：面板据此把该行标 amber「挂载态未知」。
 * @param {string} pluginsDir
 * @param {Set<string>|null} [mounted] - 已挂载插件 id 集合；null = 挂载态未知
 * @returns {Record<string,{kind:string,main:string|null,tools:number,provides:number,nested:string[],checker:boolean}>}
 */
export function classifyPlugins(pluginsDir, mounted = null) {
  const out = {};
  // 分类对象 = 有 lib 的身份（pluginIdentities）+ 全部顶层目录（topLevelPluginDirs，
  // 补进聚合容器与门面 —— 它们没有代码，但必须有形态，否则僵尸候选豁免失效）。
  // 同名时身份优先（门面的形态信息不如真身准）。
  const units = [];
  const seen = new Set();
  for (const u of pluginIdentities(pluginsDir)) {
    units.push({ id: u.id, root: u.root, top: u.top });
    seen.add(u.id);
  }
  for (const d of topLevelPluginDirs(pluginsDir)) {
    if (seen.has(d)) continue;
    units.push({ id: d, root: join(pluginsDir, d), top: true });
  }
  for (const u of units) {
    const root = u.root;
    const nested = u.top
      ? readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !SKIP_FOR_KIND.has(e.name) && !e.name.includes('.bak-')
          && !isTmpLeftover(e.name)
          && existsSync(join(root, e.name, 'manifest.json')))
        .map((e) => e.name)
      : [];
    const hasLib = existsSync(join(root, 'lib'));
    let main = null;
    let tools = 0;
    let provides = 0;
    const mPath = join(root, 'manifest.json');
    if (existsSync(mPath)) {
      try {
        const m = JSON.parse(readFileSync(mPath, 'utf8'));
        main = typeof m.main === 'string' ? m.main : null;
        const c = m?.spec?.cordis ?? m?.cordis ?? {};
        tools = Array.isArray(c.tools) ? c.tools.length : 0;
        provides = Array.isArray(c.provides) ? c.provides.length : 0;
      } catch { /* 坏 manifest：形态按 host 但 main 未知 */ }
    } else {
      try {
        const pj = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
        main = typeof pj.main === 'string' ? pj.main : null;
      } catch { /* 无 package.json：main 未知 */ }
    }
    let kind;
    const isChecker = existsSync(join(root, 'lib', 'checkers'));
    if (isChecker) kind = 'checker';
    else if (nested.length > 0 && !hasLib) kind = 'container';
    else if (main !== null && /(^|\/)lib\/tools(\.js)?$/.test(main)) kind = 'tool-only';
    else if (main === 'index.js' || main === './index.js') kind = 'library';
    else if (tools === 0 && provides > 0) kind = 'sdk';
    else kind = 'host';
    if (kind === 'host' && mounted instanceof Set && !mounted.has(u.id)) kind = 'unmounted';
    out[u.id] = { kind, main, tools, provides, nested, checker: isChecker };
  }
  return out;
}

/**
 * classifyPlugins + patch 挂载态的组合入口（生产用）。
 *
 * 挂载态来自 readMountedFromPatch：REMOVED 的插件（agint-quality-report）目录、
 * manifest、代码全在，只是 patch 行被注释掉 —— 不读 patch 就只能猜，而猜错的后果
 * 是把已下线插件继续当在役组件（或反之）。
 *
 * @param {string} pluginsDir
 * @returns {{ kinds: Record<string,object>, mounted: Set<string>|null, mountSource: string }}
 */
export function classifyPluginsWithMount(pluginsDir) {
  const mounted = readMountedFromPatch(pluginsDir);
  return {
    kinds: classifyPlugins(pluginsDir, mounted),
    mounted,
    mountSource: mounted === null ? 'unavailable' : 'cordis.patch.yml',
  };
}

/** 形态分类里不当「子插件」的目录名。 */
const SKIP_FOR_KIND = new Set(['node_modules', 'test', 'tests', 'fixtures', 'schemas', 'bin', 'examples', 'assets', 'docs', 'lib']);

/** mtime 签名：三个 storages 文件 + 神谕层存储域 + 各插件 lib 目录 mtime。
 *  ⛔ 神谕层文件必须进签名：它不在原三源之列，漏了就只能靠 30s TTL 兜，
 *     09:00 广播刚落地时面板会显示上一轮判词（看起来像「神谕没跑」）。 */
function signature(dirs) {
  const sig = [];
  for (const f of ['agint_tool_stats.jsonl', 'agint_cron.json', 'agint_event_bus.json', 'agint_aesthetic_oracle.json']) {
    sig.push(mtimeIso(join(dirs.storagesDir, f)));
  }
  try {
    for (const d of readdirSync(dirs.pluginsDir)) {
      const lib = join(dirs.pluginsDir, d, 'lib');
      if (existsSync(lib)) sig.push(d, String(statSync(lib).mtimeMs));
    }
  } catch { /* 目录级失败由源级降级兜住 */ }
  return sig.join('|');
}

/**
 * 读接线豁免表 `docs/wiring-exemptions.json`（bin/check-wiring.mjs 消费的同一份档案）。
 *
 * 为什么要读它而不是面板自己判：豁免表是「有订阅方、暂无发布方」这类断链的**权威出处**，
 * 每条带 reason / evidence / since（2026-10-05 实测：evoorch.* 两条自 2026-09-24 就归档为
 * 「P2-3 未实施，订阅方已就位等发布方」）。面板此前把已归档的断链当成新问题重报一遍，
 * 属 playbook §3.28 那一族坑（自己造发现逻辑，不认上游注册处）。
 *
 * 只在**仓库位**读：部署位 `.agint-bundle/` 下没有 docs/（2026-10-05 实测），
 * 读不到就照实降级，不猜、不把已豁免的重新变成待判。
 *
 * @param {string|null} repoPluginsDir - 仓库位 plugins/ 目录
 * @returns {{state:string, file?:string, count?:number, byTopic?:Record<string,{reason:string,since:string|null,evidence:string|null}>, reason?:string, observedAt?:string}}
 */
export function readWiringExemptions(repoPluginsDir) {
  if (!repoPluginsDir) {
    return { state: 'unavailable', byTopic: {}, count: 0, reason: '仓库位未解析：豁免表只存仓库位 docs/，部署位无 docs/' };
  }
  const file = join(repoPluginsDir, '..', 'docs', 'wiring-exemptions.json');
  if (!existsSync(file)) return { state: 'unavailable', byTopic: {}, count: 0, file, reason: `豁免表文件不存在：${file}` };
  try {
    const body = JSON.parse(readFileSync(file, 'utf8'));
    const byTopic = {};
    for (const t of Array.isArray(body?.topics) ? body.topics : []) {
      if (!t || !t.topic) continue;
      byTopic[t.topic] = {
        reason: String(t.reason ?? '').slice(0, 240),
        since: t.since ?? null,
        evidence: t.evidence ? String(t.evidence).slice(0, 160) : null,
      };
    }
    return { state: 'ok', file, count: Object.keys(byTopic).length, byTopic, observedAt: mtimeIso(file) };
  } catch (err) {
    return { state: 'error', byTopic: {}, count: 0, file, reason: String((err && err.message) ?? err).slice(0, 200) };
  }
}

/**
 * 零投递订阅分层（纯函数，面板与 q3 回放共用同一实现）。
 *
 * 背景：`agint.eventBus.subscriptions` 的投递计数**随宿主进程重启清零**
 * （lib/index.js 的 bootAt 注释已写明「0 since boot ≠ never」），所以「零投递」
 * 必须再分一层，否则每次重启后面板都报一批假异常：
 *  - exempted       主题全在豁免表在册 → 已归档断链，不再当待判。
 *  - lowFrequency   主题在全历史里发布过 → 只是本窗口没触发；给次数与最后一次。
 *  - neverPublished 既无豁免、全历史又从未发布 → 这才是真缺口，需要人工判。
 *
 * @param {object|null} sub - collectSubscriptions() 的返回
 * @param {object|null} bus - aggBus() 的返回（要 topics 计数与 topicLast）
 * @param {object|null} exempt - readWiringExemptions() 的返回
 * @returns {object} { state, buckets:{exempted,lowFrequency,neverPublished}, ... }
 */
export function classifySubscriptions(sub, bus, exempt) {
  if (!sub || sub.state !== 'ok') {
    return { state: 'unavailable', reason: (sub && sub.reason) ? String(sub.reason).slice(0, 200) : '订阅表未接入（agint.eventBus.subscriptions 不可得）' };
  }
  const entries = Array.isArray(sub.entries) ? sub.entries : [];
  const busOk = !!bus && !bus.state;
  const counts = new Map((busOk && Array.isArray(bus.topics) ? bus.topics : []).map(([t, n]) => [t, n]));
  const lastMap = (busOk && bus.topicLast) || {};
  const byTopic = (exempt && exempt.state === 'ok') ? exempt.byTopic : {};
  const out = {
    state: 'ok',
    bootAt: sub.bootAt ?? null,
    total: entries.length,
    zero: 0,
    syncCount: sub.syncCount ?? null,
    syncGlobalLimit: sub.syncGlobalLimit ?? null,
    busOk,
    exemptionState: exempt ? exempt.state : 'unavailable',
    exemptionCount: exempt && exempt.state === 'ok' ? exempt.count : 0,
    buckets: { exempted: [], lowFrequency: [], neverPublished: [] },
  };
  for (const e of entries) {
    if (e.deliveries !== 0) continue;
    out.zero += 1;
    const raw = Array.isArray(e.topics) ? e.topics.filter(Boolean) : [];
    const wildcard = raw.length === 0 || raw.includes('*');
    const topics = wildcard ? ['*'] : raw;
    const row = { subscriber: e.subscriber ?? '?', topics };
    const hits = topics.map((t) => byTopic[t]).filter(Boolean);
    if (!wildcard && hits.length === topics.length) {
      out.buckets.exempted.push({ ...row, since: hits[0].since ?? null, exemptReason: hits[0].reason ?? null });
      continue;
    }
    if (!busOk) {
      // 全历史不可读 ⇒ 分不清「低频」还是「从未发布」，照实并进待判层并说明缺哪项证据。
      out.buckets.neverPublished.push({ ...row, undetermined: true, note: '总线全历史不可读，无法区分低频与从未发布' });
      continue;
    }
    const history = topics
      .map((t) => ({ topic: t, published: counts.get(t) ?? 0, last: lastMap[t] ?? null }))
      .filter((h) => h.published > 0);
    if (wildcard) {
      out.buckets.lowFrequency.push({ ...row, wildcard: true, busTotal: bus.total ?? 0, note: '通配订阅：本进程窗口内零投递；总线已有全历史，属低频而非断链' });
      continue;
    }
    if (history.length > 0) { out.buckets.lowFrequency.push({ ...row, history }); continue; }
    out.buckets.neverPublished.push(row);
  }
  return out;
}

/**
 * 组装 /v2/data payload。opts 仅供测试注入（now/force/独立 cache）。
 * @param {{pluginsDir:string, storagesDir:string, repoPluginsDir:string|null}} dirs
 * @param {{now?:number, force?:boolean, cache?:Map}} [opts]
 */
export function collectV2Data(dirs, opts = {}) {
  const now = opts.now ?? Date.now();
  const cache = opts.cache ?? moduleCache;
  const sig = signature(dirs);
  const hit = cache.get('v2');
  if (!opts.force && hit && now - hit.builtAt < TTL_MS && hit.sig === sig) return hit.value;

  const payload = { ok: true, generatedAt: new Date(now).toISOString(), panelVersion: PANEL_VERSION };
  // 契约先读：scanPlugins 的第二参要用它补边（v2-scan LITERAL_RE）。
  try { payload.manifestConsumes = readManifestConsumes(dirs.pluginsDir); } catch { payload.manifestConsumes = {}; }
  try { payload.wiringExemptions = readWiringExemptions(dirs.repoPluginsDir ?? null); } catch (e) { payload.wiringExemptions = { state: 'error', byTopic: {}, count: 0, reason: String((e && e.message) ?? e).slice(0, 200) }; }
  try {
    const r = scanPlugins(dirs.pluginsDir, payload.manifestConsumes);
    payload.scan = { hits: r.hits, provided: r.provided, familyDirs: r.familyDirs, units: r.units ?? [], scannedAt: r.scannedAt, errors: r.errors };
  } catch (e) { payload.scan = errOf(e); }
  try { payload.tools = aggTools(dirs.storagesDir, now); } catch (e) { payload.tools = errOf(e); }
  try { payload.cron = aggCron(dirs.storagesDir); } catch (e) { payload.cron = errOf(e); }
  try { payload.bus = aggBus(dirs.storagesDir, now); } catch (e) { payload.bus = errOf(e); }
  try { payload.pending = aggPending(dirs.storagesDir); } catch (e) { payload.pending = errOf(e); }
  // 神谕层：落盘口径先兜底（文件在就有数）。服务面在 lib/index.js 的
  // collectOracle 里覆盖，因为只有宿主进程内拿得到运行态开关与内存订阅回写。
  try { payload.oracle = aggOracle(dirs.storagesDir); } catch (e) { payload.oracle = errOf(e); }
  // 上游判读（v0.6.0）：落盘口径兜底，宿主半用服务面覆盖（lag / calibration 只有服务端算得出）。
  try { payload.upstream = aggUpstream(dirs.storagesDir); } catch (e) { payload.upstream = errOf(e); }
  try {
    const classified = classifyPluginsWithMount(dirs.pluginsDir);
    payload.pluginKinds = classified.kinds;
    payload.mountState = { source: classified.mountSource, mountedCount: classified.mounted === null ? null : classified.mounted.size };
    /**
     * 档案层（v0.4.0）。单独 try：档案读失败不能打掉 pluginKinds —— 形态列还有用。
     * 挂载态用 classified.mounted（patch 里可见的行），与 pluginKinds 同一口径。
     */
    try {
      payload.dossiers = collectDossiers(dirs, { kinds: classified.kinds, mounted: classified.mounted });
    } catch (e) {
      payload.dossiers = { state: 'error', byId: {}, order: [], reason: String((e && e.message) ?? e).slice(0, 200) };
    }
  } catch {
    payload.pluginKinds = {};
    payload.mountState = { source: 'error', mountedCount: null };
    payload.dossiers = { state: 'error', byId: {}, order: [], reason: '形态分类失败，档案未采集' };
  }
  if (dirs.repoPluginsDir) {
    try {
      payload.repoDirs = readdirSync(dirs.repoPluginsDir)
        .filter((d) => d.startsWith('agint-') && !d.includes('.bak-'))
        // `.tmp` / `.tmp-<stamp>` 是宿主换版时的中转目录残留（实测 bundle 槽 78 个）。
        // 它们不是插件，进名册只会让差集判据把真插件挤出去，故与 .bak- 同等待遇。
        .filter((d) => !isTmpLeftover(d))
        .sort();
      payload.repoDirsSource = dirs.repoPluginsSource ?? 'unknown';
    } catch (e) {
      payload.repoDirs = { state: 'unavailable', reason: String((e && e.message) ?? e).slice(0, 200) };
    }
  } else {
    payload.repoDirs = {
      state: 'unavailable',
      reason: '仓库位未解析：设 AGINT_HOME 或 AGINT_REPO_ROOT 指向仓库根，或从仓库位 plugins/ 启动本面板',
    };
  }
  // 探针 source 名单随 payload 下发：前端不硬编码第二份（漂移会被 test 抓到）。
  payload.probeEventSources = [...PROBE_EVENT_SOURCES];
  /**
   * 归因表随 payload 下发（v0.4.0）。前端两个消费方（整页视图 + 停靠面板的档案页）
   * 都从这里取，不再各写一份常量表。⛔ 不要在前端留「兜底副本」——那等于留两份。
   */
  try { payload.owners = ownersPayload(); } catch { payload.owners = null; }
  cache.set('v2', { builtAt: now, sig, value: payload });
  return payload;
}
