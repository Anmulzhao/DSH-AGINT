/**
 * agint-family-panel: HOST half (node plane, single instance).
 *
 * Serves one read-only JSON route on the web GUI's own HTTP server and nothing
 * else. The browser half (lib/client.js) is a native docked panel: it renders
 * inside the shell's own seats (`sidebar.panellist` row + root `main` keyed
 * slot), so this half owns no DOM, no overlay and no iframe — it only answers
 * what the family looks like right now.
 *
 * Design constraints this half is built around:
 *
 * - **Never lie about energization.** A source that is absent, throws, or
 *   answers in an unexpected shape is reported as `unavailable`/`error` with a
 *   short reason, never as a green zero. "Mounted" is not "running" (K-hoist:
 *   the family's own standing rule), so a row that is loaded but failed still
 *   reads FAILED here.
 * - **Never break the GUI.** Every probe is individually guarded; a failing
 *   AGINT service degrades one signal, not the panel and not the boot.
 * - **Loopback only** by default: the route carries family-internal facts
 *   (paths, row ids, failure reasons) that a LAN peer has no business reading.
 *
 * Route: GET <API_PREFIX>/status  ->  family snapshot JSON.
 *
 * Row (bundle cordis.patch.yml):
 *   - insert:
 *       - id: agint-family-panel
 *         name: ./plugins/agint-family-panel/lib/index.js
 */

import { z } from 'zod';
import { createRequire } from 'node:module';

const name = 'agint-family-panel';
const inject = ['webServer'];

const require = createRequire(import.meta.url);
/** 版本号读 package.json（v0.1.1 修复：此前硬编码字面量，永远自报 0.1.0）。 */
const PANEL_VERSION = (require('../package.json')?.version) ?? '0.0.0';

/**
 * Root-absolute prefix the host registers. The browser half strips the leading
 * slash before fetching: the shell serves index with `<base href="./">`, so a
 * root-absolute URL escapes a sub-path deployment (same trap the family
 * aggregates document for their own prefixes).
 */
const API_PREFIX = '/api/agint-family';

/** Route path served by this half. */
const STATUS_PATH = `${API_PREFIX}/status`;

const Config = z.object({
  /** Master switch. Off keeps the route answering `{ enabled: false }` so the
   *  panel can say "switched off" instead of looking unmounted. */
  enabled: z.boolean().default(true),
  /** Admit non-loopback callers. Off by default; the payload is not public. */
  allowNonLoopback: z.boolean().default(false),
});

/**
 * Family grouping. Kept as a label map, never as an allow-list: rows are
 * discovered from the live loader, and anything not named here lands in
 * `unmapped`, which the panel renders and counts. A new plugin therefore shows
 * up as "unmapped" rather than silently vanishing — the map can drift without
 * hiding anything.
 */
const FAMILY_GROUPS = [
  { id: 'preset', label: 'AGENT预设', members: ['agint-preset', 'agint-blockchain-preset', 'agint-investor-preset'] },
  { id: 'memory', label: '记忆与知识', members: ['agint-memory', 'agint-wiki', 'agint-memory-provider', 'agint-search-tools'] },
  { id: 'governance', label: '调度与治理', members: ['agint-cron', 'agint-rules', 'agint-metrics', 'agint-tool-stats'] },
  { id: 'evolution', label: '反思与进化', members: ['agint-dream', 'agint-evolve', 'agint-evolution-memory', 'agint-diagnosis', 'agint-curriculum', 'agint-evolution-driver'] },
  { id: 'quality', label: 'D-QAF 质量层', members: ['agint-quality', 'agint-quality-contract', 'agint-quality-policy', 'agint-quality-sdk', 'agint-quality-static', 'agint-quality-sandbox', 'agint-quality-eval', 'agint-quality-report'] },
  { id: 'closed-loop', label: '进化闭环引擎', members: ['agint-mutator', 'agint-population', 'agint-abtest', 'agint-mount'] },
  { id: 'execution', label: '自进化执行层', members: ['agint-skill-autocreate', 'agint-curator', 'agint-skill-graph', 'agint-trajectory', 'agint-compress-guard'] },
  { id: 'infra', label: '观测与基础设施', members: ['agint-self-model', 'agint-event-bus', 'agint-restart', 'agint-session-extract', 'agint-ov-strategy', 'agint-input-gateway', 'agint-aesthetic-oracle', 'agint-family-panel'] },
];

/** Group id for rows the label map does not name. */
const UNMAPPED_GROUP = 'unmapped';

/** Cosmetic shortener for the loader's module specifier. */
function shortModule(specifier) {
  if (typeof specifier !== 'string' || specifier === '') return null;
  const match = /([^/\\]+)\/?$/.exec(specifier.replace(/\.js$/, ''));
  return match === null ? specifier : match[1];
}

/**
 * Map a cordis fiber lifecycle state to a panel status string.
 *
 * cordis-plugin-loader 的 entry 不带 `runtime.status`——真实状态在
 * `entry.fiber.state`（FiberState 枚举：PENDING=0/LOADING=1/ACTIVE=2/
 * FAILED=3/DISPOSED=4/UNLOADING=5）。v0.1.1 修复：改从这里取。
 * @param {number|undefined|null} state - entry.fiber?.state
 * @returns {'active'|'failed'|'disposed'|'unloading'|'loading'|'unknown'}
 */
export function fiberStateToStatus(state) {
  if (typeof state !== 'number') return 'unknown';
  switch (state) {
    case 2: return 'active';    // ACTIVE — 已加载并对外提供
    case 3: return 'failed';    // FAILED — 回调或配置抛错
    case 4: return 'disposed';  // DISPOSED — 已移除不可重启
    case 5: return 'unloading'; // UNLOADING — 正在卸载
    case 0: return 'loading';   // PENDING — 等待必需服务
    case 1: return 'loading';   // LOADING — 回调运行中
    default: return 'unknown';
  }
}

/**
 * Read the live loader table.
 *
 * `entries()` is the only authoritative roster: the patch file says what we
 * asked for, the loader says what actually got mounted. Entry shape is probed
 * defensively because only `options` is contractual; `fiber.state` is read
 * when the loader happens to expose it and otherwise degrades to `unknown`
 * (never to a confident "ok").
 * @param {object} ctx - host context (services: loader).
 * @returns {{ rows: Array<object>, error: string|null }} rows plus a reason.
 */
function readRows(ctx) {
  const rows = [];
  let error = null;
  try {
    const entries = [...ctx.loader.entries()];
    for (const entry of entries) {
      const options = entry && entry.options;
      const id = (options && options.id) ?? (entry && entry.id);
      if (typeof id !== 'string' || id === '') continue;
      const status = fiberStateToStatus(entry && entry.fiber && entry.fiber.state);
      rows.push({
        id,
        module: shortModule(options && options.name),
        disabled: entry ? entry.disabled === true : false,
        status,
      });
    }
  } catch (err) {
    // A loader that will not enumerate leaves the panel with an empty roster
    // and a stated reason, never with a fabricated one.
    error = String((err && err.message) ?? err).slice(0, 200);
    return { rows: [], error };
  }
  return { rows, error: null };
}

/**
 * Split the roster into the agint family and the rest of the host.
 * @param {Array<object>} rows - loader rows.
 * @returns {{ family: Array<object>, hostRowCount: number }} family rows + total.
 */
function splitFamily(rows) {
  const family = [];
  for (const row of rows) {
    const moduleName = row.module ?? '';
    const isFamily = row.id.startsWith('agint-')
      || /^agint[-_]/i.test(moduleName)
      || moduleName.startsWith('agint-');
    if (isFamily) family.push(row);
  }
  return { family, hostRowCount: rows.length };
}

/**
 * Group family rows by the label map.
 * @param {Array<object>} family - family rows.
 * @returns {{ groups: Array<object>, unmappedIds: string[] }} groups + leftovers.
 */
function groupFamily(family) {
  const byId = new Map();
  for (const row of family) byId.set(row.id, row);
  const groups = [];
  const claimed = new Set();
  for (const group of FAMILY_GROUPS) {
    const members = [];
    for (const memberId of group.members) {
      const row = byId.get(memberId);
      if (row === undefined) continue;
      claimed.add(memberId);
      members.push({
        id: row.id,
        status: row.status,
        disabled: row.disabled,
        declared: true,
      });
    }
    groups.push({ id: group.id, label: group.label, members });
  }
  const unmappedIds = [];
  const leftovers = [];
  for (const row of family) {
    if (claimed.has(row.id)) continue;
    unmappedIds.push(row.id);
    leftovers.push({ id: row.id, status: row.status, disabled: row.disabled, declared: false });
  }
  if (leftovers.length > 0) {
    groups.push({ id: UNMAPPED_GROUP, label: '未归类（分组表待补）', members: leftovers });
  }
  return { groups, unmappedIds };
}

/**
 * Probe one AGINT service and reduce its answer to one panel signal.
 *
 * The reduction is explicit per source: a blind dump of an unknown shape would
 * either break the renderer or imply we understood it. Anything unanticipated
 * is reported as `unavailable`/`error` with the reason kept.
 * @param {object} ctx - host context.
 * @param {object} spec - probe spec (key, label, service, method, reduce).
 * @returns {Promise<object>} one signal.
 */
async function probeSignal(ctx, spec) {
  const base = { key: spec.key, label: spec.label, state: 'unavailable', reason: null, value: null, note: null };
  let service;
  try {
    service = ctx.get(spec.service);
  } catch (err) {
    return { ...base, reason: `inject 未声明或服务未就绪：${String((err && err.message) ?? err).slice(0, 120)}` };
  }
  if (service === null || service === undefined) {
    return { ...base, reason: '服务未挂载' };
  }
  const method = service[spec.method];
  if (typeof method !== 'function') {
    return { ...base, reason: `${spec.method}() 不存在` };
  }
  try {
    const raw = await method.call(service);
    return { ...base, ...spec.reduce(raw) };
  } catch (err) {
    return { ...base, state: 'error', reason: String((err && err.message) ?? err).slice(0, 160) };
  }
}

/** Count cron jobs and how many have never run. */
function reduceCron(raw) {
  const jobs = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.jobs) ? raw.jobs : null);
  if (jobs === null) return { state: 'unavailable', reason: 'list() 返回结构未知' };
  const stale = jobs.filter((job) => job && (job.lastRunAt === null || job.lastRunAt === undefined)).length;
  return { state: 'ok', value: jobs.length, note: `${stale} 个尚未跑过` };
}

/** Reduce the metrics summary to its latest record count plus meta presence. */
function reduceMetrics(raw) {
  const body = raw && typeof raw === 'object' ? raw : null;
  if (body === null) return { state: 'unavailable', reason: 'summary() 返回空' };
  const metrics = Array.isArray(body.metrics) ? body.metrics : null;
  const meta = body.meta !== undefined && body.meta !== null;
  if (metrics === null) {
    // A summary without a metrics list is still a real answer; report what is
    // there instead of inventing a count.
    return { state: meta ? 'ok' : 'unavailable', value: null, note: meta ? '有 meta，无 metrics 列表' : 'summary() 结构未知' };
  }
  return { state: 'ok', value: metrics.length, note: meta ? 'meta 就位' : '⚠ meta 缺失' };
}

/** Reduce self-model stats to whatever scalar it exposes. */
function reduceSelfModel(raw) {
  if (raw === null || raw === undefined) return { state: 'unavailable', reason: 'stats() 返回空' };
  if (typeof raw === 'number') return { state: 'ok', value: raw };
  if (typeof raw !== 'object') return { state: 'ok', note: String(raw).slice(0, 80) };
  const keys = Object.keys(raw).filter((key) => typeof raw[key] === 'number');
  if (keys.length === 0) return { state: 'ok', note: '无数值字段' };
  const first = keys[0];
  return { state: 'ok', value: raw[first], note: `${first}（共 ${keys.length} 个数值字段）` };
}

/**
 * Collect every signal the panel shows.
 * @param {object} ctx - host context.
 * @returns {Promise<Array<object>>} signals in a stable order.
 */
async function readSignals(ctx) {
  return [
    await probeSignal(ctx, { key: 'cron', label: '定时任务', service: 'agint.cron', method: 'list', reduce: reduceCron }),
    await probeSignal(ctx, { key: 'metrics', label: '进化指标', service: 'agint.metrics', method: 'summary', reduce: reduceMetrics }),
    await probeSignal(ctx, { key: 'selfModel', label: '自我模型', service: 'agint.selfModel', method: 'stats', reduce: reduceSelfModel }),
  ];
}

/**
 * Build the full snapshot the browser half renders.
 * @param {object} ctx - host context.
 * @returns {Promise<object>} the status payload.
 */
async function buildStatus(ctx) {
  const { rows, error: rowsError } = readRows(ctx);
  const { family, hostRowCount } = splitFamily(rows);
  const { groups, unmappedIds } = groupFamily(family);
  const counts = { total: family.length, active: 0, failed: 0, disabled: 0, unknown: 0 };
  for (const row of family) {
    if (row.disabled) counts.disabled += 1;
    else if (row.status === 'active' || row.status === 'loaded') counts.active += 1;
    else if (row.status === 'failed' || row.status === 'error') counts.failed += 1;
    else counts.unknown += 1;
  }
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    panelVersion: PANEL_VERSION,
    apiPrefix: API_PREFIX,
    counts,
    hostRowCount,
    groups,
    unmappedIds,
    rosterError: rowsError,
    signals: await readSignals(ctx),
  };
}

/** Loopback test for one request. */
function isLoopback(req) {
  const address = (req && req.socket && req.socket.remoteAddress) || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address === '';
}

/** Write one JSON response; nothing else touches the socket. */
function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

/**
 * Mount the panel's host half.
 *
 * ⛔ cordis 契约：config 是 apply 的**第二参数**（不是 ctx.config——那需要
 * inject 声明 config，宿主不会给）。v0.1.0 曾写成 `ctx.config`，导致
 * 「cannot get property config without inject」、条目激活失败。
 * @param {object} ctx - host context (services: webServer).
 * @param {object} [config] - cordis 注入的插件配置（cordis.patch.yml 的 config 段）。
 */
function apply(ctx, config = {}) {
  const allowNonLoopback = config.allowNonLoopback === true;
  let enabled = config.enabled !== false;

  ctx.webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: async (req, res) => {
      try {
        if (!enabled) {
          writeJson(res, 200, { ok: true, enabled: false, apiPrefix: API_PREFIX, note: '面板已被 kill-switch 关闭（host 半仍在，可即时 reopen）' });
          return;
        }
        if (!allowNonLoopback && !isLoopback(req)) {
          writeJson(res, 403, { ok: false, error: 'loopback-only' });
          return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          writeJson(res, 405, { ok: false, error: 'method-not-allowed' });
          return;
        }
        const status = await buildStatus(ctx);
        writeJson(res, 200, { ...status, enabled: true });
      } catch (err) {
        // The route never throws into the server: one bad probe is a 500 with a
        // reason, which the panel renders as a degraded signal row.
        writeJson(res, 500, { ok: false, error: String((err && err.message) ?? err).slice(0, 300) });
      }
    },
  });

  ctx.provide('agint.familyPanel', {
    /** Current snapshot; the route and any in-process consumer share this. */
    status: () => buildStatus(ctx),
    /** The prefix the browser half fetches (root-absolute). */
    apiPrefix: API_PREFIX,
    /** Kill-switch: off keeps the route alive but empty. */
    setEnabled: (next) => { enabled = next === true; return enabled; },
    isEnabled: () => enabled,
  });
}

export { Config, apply, inject, name };
