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
import { scanPlugins } from './v2-scan.js';

const require = createRequire(import.meta.url);
const PANEL_VERSION = (require('../package.json')?.version) ?? '0.0.0';

const TTL_MS = 30_000;
const WINDOW_DAYS = 30;
const DAILY_DAYS = 7;
const DAY_MS = 86_400_000;

const moduleCache = new Map();
export function clearV2Cache() { moduleCache.clear(); }

/**
 * 解析 v2 需要的三个目录。
 * @param {Record<string,string|undefined>} env
 * @param {string} selfUrl - 调用方 import.meta.url
 */
export function resolveV2Dirs(env = process.env, selfUrl = import.meta.url) {
  let pluginsDir;
  if (env.DSH_HOME) {
    pluginsDir = join(env.DSH_HOME, 'profiles', 'web', 'plugins');
  } else {
    // 部署位兜底：本文件就在 <pluginsDir>/agint-family-panel/lib/ 下
    const pluginRoot = resolve(dirname(fileURLToPath(selfUrl)), '..');
    pluginsDir = resolve(pluginRoot, '..');
  }
  const dshHome = env.DSH_HOME ?? resolve(pluginsDir, '..', '..', '..');
  return {
    pluginsDir,
    storagesDir: join(dshHome, 'storages'),
    repoPluginsDir: env.AGINT_HOME ? join(env.AGINT_HOME, 'plugins') : null,
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

/** 三形态 manifest 解析（spec.cordis / 顶层 cordis / 无 manifest 跳过），只收非空 consumes。 */
function readManifestConsumes(pluginsDir) {
  const out = {};
  let dirs = [];
  try { dirs = readdirSync(pluginsDir); } catch { return out; }
  for (const d of dirs) {
    if (!d.startsWith('agint-') || d.includes('.bak-')) continue;
    const p = join(pluginsDir, d, 'manifest.json');
    if (!existsSync(p)) continue;
    try {
      const m = JSON.parse(readFileSync(p, 'utf8'));
      const consumes = m?.spec?.cordis?.consumes ?? m?.cordis?.consumes ?? null;
      if (Array.isArray(consumes) && consumes.length > 0) out[d] = consumes;
    } catch { /* 坏 manifest 单插件跳过 */ }
  }
  return out;
}

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
    payload.scan = { hits: r.hits, provided: r.provided, familyDirs: r.familyDirs, scannedAt: r.scannedAt, errors: r.errors };
  } catch (e) { payload.scan = errOf(e); }
  try { payload.tools = aggTools(dirs.storagesDir, now); } catch (e) { payload.tools = errOf(e); }
  try { payload.cron = aggCron(dirs.storagesDir); } catch (e) { payload.cron = errOf(e); }
  try { payload.bus = aggBus(dirs.storagesDir, now); } catch (e) { payload.bus = errOf(e); }
  try { payload.manifestConsumes = readManifestConsumes(dirs.pluginsDir); } catch { payload.manifestConsumes = {}; }
  if (dirs.repoPluginsDir) {
    try {
      payload.repoDirs = readdirSync(dirs.repoPluginsDir)
        .filter((d) => d.startsWith('agint-') && !d.includes('.bak-'))
        .sort();
    } catch (e) {
      payload.repoDirs = { state: 'unavailable', reason: String((e && e.message) ?? e).slice(0, 200) };
    }
  } else {
    payload.repoDirs = { state: 'unavailable', reason: 'AGINT_HOME 未设置' };
  }
  cache.set('v2', { builtAt: now, sig, value: payload });
  return payload;
}
