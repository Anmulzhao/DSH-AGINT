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
import { scanPlugins, codeRoots } from './v2-scan.js';
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
 * Marker is deliberate and narrow: a repo root has BOTH `plugins/` and
 * `cordis.patch.yml` (every mount path in it is written relative to that file).
 *
 * ⛔ Why not just `plugins/`: the **deploy** layout also has
 * `<...>/profiles/web/plugins`, so `web/` would pass a `plugins/`-only test and
 * the panel would read the deploy dir as the "repo" dir — the exact
 * deploy-vs-repo confusion this fallback exists to fix (regression caught by
 * test/v2-data.test.mjs, which runs against a fixture home shaped like deploy).
 *
 * @param {string} dir
 * @returns {boolean}
 */
export function isRepoRoot(dir) {
  try {
    return statSync(join(dir, 'plugins')).isDirectory()
      && statSync(join(dir, 'cordis.patch.yml')).isFile();
  } catch {
    return false;
  }
}

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
 * 积压队列的声明表。加一行队列 = 加一条 spec，不改聚合逻辑。
 *
 * kind 的两个值不是分类学，是**给用户的两种不同动作**：
 *  - `action` —— 攒着等人处理（挑战没人做、提案没人批）。人能直接动手。
 *  - `supply` —— 上游供给不足（失败样本攒不够）。人能做的只是去产生真实失败，
 *    没有「直接处理」这个动作；混进待办列表会诱导出「点一下就好」的错觉。
 */
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
    select: () => true,
    item: (r) => ({ id: r.id ?? null, title: r.title ?? null }),
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
    key: 'curator-overlap',
    label: 'curator 重叠候选',
    kind: 'action',
    file: 'agint_curator.json',
    table: 'overlap_candidates',
    select: () => true,
    item: (r) => ({ id: r.id ?? null }),
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
    .filter((d) => d.startsWith('agint-') && !d.includes('.bak-'))
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
    .filter((d) => d.startsWith('agint-') && !d.includes('.bak-'))
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

/** mtime 签名：三个 storages 文件 + 各插件 lib 目录 mtime。 */
function signature(dirs) {
  const sig = [];
  for (const f of ['agint_tool_stats.jsonl', 'agint_cron.json', 'agint_event_bus.json']) {
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
  try {
    const classified = classifyPluginsWithMount(dirs.pluginsDir);
    payload.pluginKinds = classified.kinds;
    payload.mountState = { source: classified.mountSource, mountedCount: classified.mounted === null ? null : classified.mounted.size };
  } catch { payload.pluginKinds = {}; payload.mountState = { source: 'error', mountedCount: null }; }
  if (dirs.repoPluginsDir) {
    try {
      payload.repoDirs = readdirSync(dirs.repoPluginsDir)
        .filter((d) => d.startsWith('agint-') && !d.includes('.bak-'))
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
  cache.set('v2', { builtAt: now, sig, value: payload });
  return payload;
}
