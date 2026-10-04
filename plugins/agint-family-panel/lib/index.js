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
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectV2Data, resolveV2Dirs } from './v2-data.js';

const name = 'agint-family-panel';
const inject = ['webServer'];
/**
 * eventBus 是**软依赖**（v0.3.0，2026-10-04）。
 *
 * 为什么要它：家族面板 v2 的「订阅 → 投递对差」判据需要运行态订阅表，而订阅表
 * 只存在于event-bus 进程内（模块级 Map，deliveries 只进内存 ring），**不落
 * agint_event_bus.json** ⇒ 面板自己读文件永远给不出这个数。event-bus v0.7.1 起
 * 提供 agint.eventBus.subscriptions 只读出口，面板经 ctx.get 取。
 *
 * ⛔ 不进 inject：event-bus 未挂载 / 旧版本（无该服务）时面板必须照常出数，
 *   只把该判据降级为 unknown（见 collectSubscriptions 的 catch）。
 */
const optionalInject = ['agint.eventBus'];

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

/** v2 整页与其实时数据端点（0.2.0）。 */
const V2_PAGE_PATH = `${API_PREFIX}/v2`;
const V2_DATA_PATH = `${API_PREFIX}/v2/data`;
const HERE = dirname(fileURLToPath(import.meta.url));
const V2_HTML_PATH = resolve(HERE, '..', 'assets', 'panel-v2.html');

/** HTML 资产按 mtime 缓存；文件丢失时回降级页而不是 500 裸文本。 */
const htmlCache = { mtimeMs: 0, text: null };
function readV2Html() {
  try {
    const st = statSync(V2_HTML_PATH);
    if (htmlCache.text === null || htmlCache.mtimeMs !== st.mtimeMs) {
      htmlCache.mtimeMs = st.mtimeMs;
      htmlCache.text = readFileSync(V2_HTML_PATH, 'utf8');
    }
    return htmlCache.text;
  } catch {
    return '<!DOCTYPE html><meta charset="utf-8"><p>panel-v2.html 资产缺失（部署不完整）。</p>';
  }
}

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
/**
 * 家族外部成员：不在 `agint-*` 命名空间，但确实是智进家族的组成部分。
 *
 * 收录理由：终止开关是**给智进这台宿主当急停用的**，bundle 只是它的封装
 * 形式，名字叫 dsh- 不改变归属。其余 agint 之外的 host 插件不在此表内 ——
 * 判据是 Set 精确匹配，机制上只有 module 名逐字符等于表内字符串的行会命中，
 * 想多收一行必须在这里显式加一行（可审计）。
 *
 * 判据按 **module 名精确匹配**，不是 id 前缀，两个原因：
 *   1. loader 会给 patch 插入行加 `include:` 前缀（dsh-kill-switch 实机
 *      entry id = `include:dsh-kill-switch`），按 id 前缀写会漏；
 *   2. 按前缀放宽会把 200+ 条 host 官方行全拖进家族。
 *
 * ⚠️ 未做过的核对：全量运行时 roster 的逐行复算。Config inspect provider 的
 * 分页参数在本机 bridge 过不去（`limit` 恒报 must be a number），拿不到 239 行
 * 明细。替代证据是面板全量计数对比——改动前后 `counts.total` 的增量必须
 * 恰好等于 1，见 test/smoke.mjs 用例 14 与实机验收记录（CHANGELOG v0.1.3）。
 */
const EXTERNAL_FAMILY_MEMBERS = new Set([
  // 终止开关：两步确认，终止宿主整棵进程树。独立 bundle
  //（bundles/dsh-kill-switch，包名 @local/dsh-kill-switch），按 bundle
  // 规范不落在 plugins/agint-* 命名空间下，但它是家族的一等公民。
  'dsh-kill-switch',
]);

const FAMILY_GROUPS = [
  { id: 'preset', label: 'AGENT预设', members: ['agint-preset', 'agint-blockchain-preset', 'agint-investor-preset', 'agint-ops-preset'] },
  { id: 'memory', label: '记忆与知识', members: ['agint-memory', 'agint-wiki', 'agint-memory-provider', 'agint-search-tools'] },
  { id: 'governance', label: '调度与治理', members: ['agint-cron', 'agint-rules', 'agint-metrics', 'agint-tool-stats'] },
  { id: 'evolution', label: '反思与进化', members: ['agint-dream', 'agint-evolve', 'agint-evolution-memory', 'agint-diagnosis', 'agint-curriculum', 'agint-evolution-driver'] },
  { id: 'quality', label: 'D-QAF 质量层', members: ['agint-quality', 'agint-quality-contract', 'agint-quality-policy', 'agint-quality-sdk', 'agint-quality-static', 'agint-quality-sandbox', 'agint-quality-eval', 'agint-quality-report'] },
  { id: 'closed-loop', label: '进化闭环引擎', members: ['agint-mutator', 'agint-population', 'agint-abtest', 'agint-mount'] },
  { id: 'execution', label: '自进化执行层', members: ['agint-skill-autocreate', 'agint-curator', 'agint-skill-graph', 'agint-trajectory', 'agint-compress-guard'] },
  { id: 'infra', label: '观测与基础设施', members: ['agint-self-model', 'agint-event-bus', 'agint-session-extract', 'agint-ov-strategy', 'agint-input-gateway', 'agint-aesthetic-oracle', 'agint-family-panel'] },
  // 宿主生命周期：重启与终止是同一件事的两头，并排放才看得出对偶。
  { id: 'host-lifecycle', label: '宿主生命周期', members: ['agint-restart', 'dsh-kill-switch'] },
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
 *
 * Membership is namespace-driven (`agint-*`) plus the explicit
 * `EXTERNAL_FAMILY_MEMBERS` allow-list. It is deliberately NOT "everything that
 * isn't a known host plugin": the live host roster measured 239 rows against 39
 * family rows (2026-10-01), so a widened test would promote the large majority
 * of the host into the family panel.
 * @param {Array<object>} rows - loader rows.
 * @returns {{ family: Array<object>, hostRowCount: number }} family rows + total.
 */
function splitFamily(rows) {
  const family = [];
  for (const row of rows) {
    const moduleName = row.module ?? '';
    const isFamily = row.id.startsWith('agint-')
      || /^agint[-_]/i.test(moduleName)
      || moduleName.startsWith('agint-')
      || EXTERNAL_FAMILY_MEMBERS.has(moduleName);
    if (isFamily) family.push(row);
  }
  return { family, hostRowCount: rows.length };
}

/**
 * Group family rows by the label map.
 *
 * Members are matched against two keys: the loader entry id first, then the
 * module short name. Both spellings resolve to the same row for `agint-*`
 * plugins (their module name equals their id), so the second lookup is a no-op
 * there. It exists for external bundles, whose entry id carries dsh's
 * composition-only `include:` marker (dsh's own plugin-inventory UI strips it
 * before display too — see dsh-client-ui-settings-plugin-inventory/lib/client.js).
 * Writing that marker into the label map would bake a loader bookkeeping detail
 * into this table; matching the module name keeps the table readable and stable.
 * @param {Array<object>} family - family rows.
 * @returns {{ groups: Array<object>, unmappedIds: string[] }} groups + leftovers.
 */
function groupFamily(family) {
  const byId = new Map();
  const byModule = new Map();
  for (const row of family) {
    byId.set(row.id, row);
    if (typeof row.module === 'string' && row.module !== '') byModule.set(row.module, row);
  }
  const groups = [];
  const claimed = new Set();
  for (const group of FAMILY_GROUPS) {
    const members = [];
    for (const memberId of group.members) {
      const row = byId.get(memberId) ?? byModule.get(memberId);
      if (row === undefined) continue;
      claimed.add(row.id);
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
 * Read the event-bus subscription table through its read-only outlet.
 *
 * Why in-process: the subscription table is a module-level `Map` in event-bus and
 * `deliveries` only lands in the in-memory ring — neither reaches
 * `agint_event_bus.json`, so no amount of file reading can answer
 * "subscribed but never delivered". event-bus v0.7.1 exposes it as
 * `agint.eventBus.subscriptions`; that is the only channel.
 *
 * Never throws: a missing/older event-bus, or a service shape we do not
 * understand, degrades this one verdict to `unknown` with the reason kept. The
 * panel must not lose the other six verdicts over it.
 *
 * `bootAt` is this process's start time — delivery counters reset on restart, so
 * "0 deliveries" is only ever "0 since boot", never "never".
 * @param {object} ctx - host context.
 */
function collectSubscriptions(ctx) {
  const bootAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  try {
    const bus = ctx.get('agint.eventBus');
    if (bus === null || bus === undefined) {
      return { state: 'unavailable', reason: 'event-bus 未挂载（面板未拿到 agint.eventBus）', bootAt };
    }
    const read = typeof bus.subscriptions === 'function'
      ? bus.subscriptions
      : (typeof bus === 'function' ? bus : null);
    if (typeof read !== 'function') {
      return { state: 'unavailable', reason: 'event-bus 版本过旧：无 subscriptions() 出口', bootAt };
    }
    const raw = read.call(bus);
    if (raw === null || raw === undefined || typeof raw !== 'object' || !Array.isArray(raw.entries)) {
      return { state: 'unavailable', reason: 'subscriptions() 返回结构未知', bootAt };
    }
    const entries = raw.entries.map((e) => ({
      subscriber: String((e && e.subscriber) ?? '?'),
      mode: (e && e.mode) ?? '?',
      topics: Array.isArray(e && e.topics) ? e.topics : [],
      createdAt: (e && e.createdAt) ?? null,
      deliveries: Number.isFinite(e && e.deliveries) ? e.deliveries : 0,
      outcomes: (e && typeof e.outcomes === 'object' && e.outcomes !== null) ? e.outcomes : {},
    }));
    return {
      state: 'ok',
      bootAt,
      generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : new Date().toISOString(),
      total: entries.length,
      syncCount: Number.isFinite(raw.syncCount) ? raw.syncCount : 0,
      syncGlobalLimit: Number.isFinite(raw.syncGlobalLimit) ? raw.syncGlobalLimit : null,
      entries,
    };
  } catch (err) {
    return { state: 'error', reason: String((err && err.message) ?? err).slice(0, 160), bootAt };
  }
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

  ctx.webServer.register({
    kind: 'exact',
    path: V2_PAGE_PATH,
    handler: (req, res) => {
      if (!enabled) { writeJson(res, 200, { ok: true, enabled: false, note: '面板已被 kill-switch 关闭' }); return; }
      if (!allowNonLoopback && !isLoopback(req)) { writeJson(res, 403, { ok: false, error: 'loopback-only' }); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
      res.end(readV2Html());
    },
  });

  ctx.webServer.register({
    kind: 'exact',
    path: V2_DATA_PATH,
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
        const payload = collectV2Data(resolveV2Dirs());
        payload.subscriptions = collectSubscriptions(ctx);
        writeJson(res, 200, { ...payload, enabled: true });
      } catch (err) {
        writeJson(res, 500, { ok: false, error: String((err && err.message) ?? err).slice(0, 300) });
      }
    },
  });

  ctx.provide('agint.familyPanel', {
    /** Current snapshot; the route and any in-process consumer share this. */
    status: () => buildStatus(ctx),
    /** v2 聚合快照；与 /v2/data 路由同源同缓存（含运行态订阅表）。 */
    v2Data: () => ({ ...collectV2Data(resolveV2Dirs()), subscriptions: collectSubscriptions(ctx) }),
    /** The prefix the browser half fetches (root-absolute). */
    apiPrefix: API_PREFIX,
    /** Kill-switch: off keeps the route alive but empty. */
    setEnabled: (next) => { enabled = next === true; return enabled; },
    isEnabled: () => enabled,
  });
}

export { Config, apply, inject, name, optionalInject };
