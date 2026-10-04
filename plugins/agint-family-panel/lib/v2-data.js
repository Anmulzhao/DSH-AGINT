/**
 * v2-data: /v2/data 的聚合层。L0.5（源码扫描）+ L1（storages 三源）+ manifest consumes。
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
 * 解析 v2 需要的三个目录。
 *
 * repoPluginsDir 口径（v0.3.0，2026-10-04 修「运行态不在仓库」判据长期unknown）：
 * 三级回退，**全部来自环境变量或自身路径推导，不写死任何机器绝对路径** ——
 *  ① AGINT_HOME（cron config.repoRoot 用的就是它）
 *  ② AGINT_REPO_ROOT（patch 里 cron 那行显式读它）
 *  ③ 自身路径：<repo>/plugins/agint-family-panel/lib/ → 上溯到 <repo>，
 *     仅当该候选目录下确有 plugins/ 时才认（部署位 plugins 的父目录没有 plugins/，
 *     所以部署态不会把自己误认成仓库位）。
 *
 * @param {Record<string,string|undefined>} env
 * @param {string} selfUrl - 调用方 import.meta.url
 */
export function resolveV2Dirs(env = process.env, selfUrl = import.meta.url) {
  let pluginsDir;
  if (env.DSH_HOME) {
    pluginsDir = join(env.DSH_HOME, 'profiles', 'web', 'plugins');
  } else {
    // 部署位兜底：本文件就在 <pluginsDir>/agint-family-panel/lib/ 下
    const derived = selfPluginsCandidate(selfUrl);
    // 推导不出时给一个必不存在的绝对路径：后续每个源各自 try/catch 降级成
    // {state:'error',reason}，面板显示「源降级」横幅；绝不因路径推导失败整页崩。
    pluginsDir = derived ?? resolve(process.cwd(), '__unresolved_plugins__');
  }
  const dshHome = env.DSH_HOME ?? resolve(pluginsDir, '..', '..', '..');
  const selfRepoGuess = selfRepoCandidate(selfUrl);
  const candidates = [
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
  const sources = new Map();
  const daily = new Map();
  let total = 0;
  let first = null;
  let last = null;
  for (const v of Object.values(events)) {
    const e = v?.envelope;
    if (!e) continue;
    total += 1;
    if (e.topic) topics.set(e.topic, (topics.get(e.topic) ?? 0) + 1);
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
    sources: sortDesc(sources),
    daily: Object.fromEntries(daily),
    range: [first, last],
    observedAt: mtimeIso(file),
  };
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
 * 三形态 manifest 解析（spec.cordis / 顶层 cordis / 无 manifest 跳过），只收非空 consumes。
 *
 * 身份口径见 pluginIdentities()：门面目录不产生身份，契约从真身读。
 *
 * @param {string} pluginsDir
 * @returns {Record<string,string[]>} 插件身份 → consumes 列表
 */
function readManifestConsumes(pluginsDir) {
  const out = {};
  for (const u of pluginIdentities(pluginsDir)) {
    const file = join(u.root, 'manifest.json');
    if (!existsSync(file)) continue;
    try {
      const m = JSON.parse(readFileSync(file, 'utf8'));
      const consumes = m?.spec?.cordis?.consumes ?? m?.cordis?.consumes ?? null;
      if (Array.isArray(consumes) && consumes.length > 0) out[u.id] = consumes;
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
  try {
    const r = scanPlugins(dirs.pluginsDir);
    payload.scan = { hits: r.hits, provided: r.provided, familyDirs: r.familyDirs, units: r.units ?? [], scannedAt: r.scannedAt, errors: r.errors };
  } catch (e) { payload.scan = errOf(e); }
  try { payload.tools = aggTools(dirs.storagesDir, now); } catch (e) { payload.tools = errOf(e); }
  try { payload.cron = aggCron(dirs.storagesDir); } catch (e) { payload.cron = errOf(e); }
  try { payload.bus = aggBus(dirs.storagesDir, now); } catch (e) { payload.bus = errOf(e); }
  try { payload.manifestConsumes = readManifestConsumes(dirs.pluginsDir); } catch { payload.manifestConsumes = {}; }
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
