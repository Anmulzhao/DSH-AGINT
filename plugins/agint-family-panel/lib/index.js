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
import { collectV2Data, resolveV2Dirs, classifySubscriptions, normalizeOracle, readOracleFile } from './v2-data.js';
import { collectProposals } from './v2-proposals.js';

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
const optionalInject = ['agint.eventBus', 'agint.evolve'];

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
/**
 * 提案审批写入口（0.5.0，2026-10-23）。
 *
 * ⛔ 全插件唯一的写通道。它以 `agint.evolve.setStatus()` 为唯一出口，
 *    **不直接改 `agint_evolve.json`** —— 存储域的原子写、版本号、后续
 *    迁移都归 domain 管；面板绕过它写文件，等于在别人家的账本上手抄。
 */
const DECISION_PATH = `${API_PREFIX}/proposal/decision`;
/** 面板能写的状态。`proposed` 用于「撤销改判」，其余四档是人工决定。 */
const DECISION_STATUSES = new Set(['approved', 'applied', 'rejected', 'wontfix', 'proposed']);
/**
 * 必须写理由的三档。
 *
 * `rejected` / `wontfix` 不写理由，三个月后没人知道当时为什么；
 * `applied` 更硬 —— 全表 applied 行的 note 都是**落地证据**（改了哪些文件）。
 * 允许「点了标记已落地但不写证据」，等于亲手把那张表变成不可信。
 */
const REASON_REQUIRED = new Set(['rejected', 'wontfix', 'applied']);
/**
 * 批准时可选的执行方式（2026-10-27）。
 *
 * ⛔ 这是「批准即执行」的入口：选了 immediate / scheduled，`agint.evolve.setStatus`
 *    会落执行计划并把提案放进 `agint_evolve.execution` 队列，由 `agint-executor`
 *    自动跑 —— 不再生成一张催办工作单让老板自己动手。
 *    `manual` = 只批准、不自动执行（老提案的语义，也是默认值）。
 */
const DECISION_EXEC_MODES = new Set(['manual', 'immediate', 'scheduled']);
const DECISION_BODY_MAX = 4096;
const DECISION_NOTE_MAX = 1000;
const PANEL_NOTE_MARK = '人工审批（家族面板）';
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
  /**
   * 仓库正本绝对路径（v2 面板的仓库位根，候选 ⓪，优先级高于 AGINT_HOME / 自身路径）。
   *
   * 2026-10-18 补：buildV2Payload 从 L613 起一直读 config.repoRoot，但 schema 里
   * 没有这个字段 —— cordis 按 schema 剥未知键，配了也到不了代码。实测症状：
   * 面板落回自身路径回退，把 `.agint-bundle`（同有 plugins/ 与 cordis.patch.yml）
   * 认成仓库根 ⇒ repoDirsSource=self-path、repoDirs 117 项、wiringExemptions
   * unavailable。空串视同未配（buildV2Payload 已 trim 后判空）。
   */
  repoRoot: z.string().optional(),
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

/**
 * 外部 bundle 可能贡献的 preset 行。
 *
 * 2026-10-26：三个子 preset（blockchain / investor / ops）迁出到独立私有仓
 * agint-presets，本仓不再产出它们。这里仍然列出 id，是因为面板要按「实际
 * 挂载的行」分组 —— 装了那个仓时它们归属 AGENT预设 组，没装时这几条在
 * roster 里根本不存在，也就不会显示（FAMILY_GROUPS 是 label map，不是
 * allow-list，多写几个不存在的 id 不会让面板凭空多出行）。
 *
 * ⛔ 不要改成「按 -preset 后缀匹配」：那会把宿主官方的 preset 行一并拖进来。
 *   要加新的一行，就在下面显式加一个 id（可审计）。
 */
const EXTERNAL_PRESET_IDS = ['agint-blockchain-preset', 'agint-investor-preset', 'agint-ops-preset'];

const FAMILY_GROUPS = [
  { id: 'preset', label: 'AGENT预设', members: ['agint-preset', ...EXTERNAL_PRESET_IDS] },
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
 * 读请求体，硬上限 DECISION_BODY_MAX。
 *
 * 超限直接销毁连接并返回 null —— 面板只发几十字节的 JSON，4KB 足够；
 * 没有上限的 body 读取就是一个本地面板给局域网/恶意页面开的洞。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} max
 * @returns {Promise<string|null>}
 */
function readBody(req, max) {
  return new Promise((resolvePromise) => {
    let size = 0;
    const chunks = [];
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolvePromise(value); } };
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { req.destroy(); finish(null); return; }
      chunks.push(c);
    });
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => finish(null));
  });
}

/**
 * 同源校验：浏览器带来的 Origin 必须与本次请求的 Host 一致。
 *
 * 为什么需要它：路由只放行回环，但**回环上任何网页都能发 POST**。
 * 加自定义头 `x-agint-panel` 已经能让跨站请求走预检（该服务不答 CORS 预检），
 * Origin 校验是第二道锁 —— 两道都过才算同源页面。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function isSameOrigin(req) {
  const origin = req.headers?.origin;
  if (origin === undefined || origin === '') return true; // 非浏览器（curl）无 Origin
  try {
    return new URL(origin).host === String(req.headers?.host ?? '');
  } catch {
    return false;
  }
}

/**
 * 拼审批记录。
 *
 * 为什么不是简单覆盖：`note` 在 applied 行里是**落地证据**，在 proposed 行里可能是
 * 上游留下的说明。人工决定要能追溯，但不能把别人的证据冲掉。
 * 上一版已是面板写的记录时不再叠加（连续改判会让 note 无限膨胀）。
 *
 * @param {{status:string, reason:string, prevNote:string, at:string}} input
 * @returns {string}
 */
function composeDecisionNote({ status, reason, prevNote, at }) {
  const head = `${PANEL_NOTE_MARK} · ${at} · ${status}${reason === '' ? '' : ` · ${reason}`}`;
  const keep = String(prevNote ?? '').trim();
  const preserved = keep === '' || keep.startsWith(PANEL_NOTE_MARK) ? '' : ` ｜ 原记录：${keep}`;
  const text = `${head}${preserved}`;
  return text.length > DECISION_NOTE_MAX ? `${text.slice(0, DECISION_NOTE_MAX)}…` : text;
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
 * topic → 投递聚合（2026-10-05 补；配 event-bus 的 `agint.eventBus.deliveryByTopic`）。
 *
 * 为什么需要这一层：事件链表一行一个 topic，「投递」列此前一律标 unknown。
 * 根因是两条路径口径不通 —— events 表按 topic 聚合但不带 deliveries，
 * deliveries 只在内存ring 里；而 `subscriptions()` 出的是 per-subscriber 计数，
 * 面板拿不到「这个 topic 投递了几次」。
 *
 * 口径（面板措辞必须照此，否则就是把猜测当测量）：
 *   - 只覆盖**ring 窗口**：本进程生命周期 + 最近 2000 条发布（`ring.full` /`ring.oldestOccurredAt` 可读）
 *   - 重启清零
 *   - `published` 是窗口内发布数，与 events 表的全历史发布数**不是同一口径**，两者不可相加
 *
 * Never throws:出口缺失或结构不认识时只降级这一块（state/ reason），不影响其他判据。
 * @param {object} ctx - host context.
 * @returns {object}
 */
function collectDeliveryByTopic(ctx) {
  const bootAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  try {
    const bus = ctx.get('agint.eventBus');
    if (bus === null || bus === undefined) {
      return { state: 'unavailable', reason: 'event-bus 未挂载（面板未拿到 agint.eventBus）', bootAt };
    }
    const read = typeof bus.deliveryByTopic === 'function' ? bus.deliveryByTopic : null;
    if (typeof read !== 'function') {
      return { state: 'unavailable', reason: 'event-bus 版本过旧：无 deliveryByTopic() 出口', bootAt };
    }
    const raw = read.call(bus);
    if (raw === null || raw === undefined || typeof raw !== 'object' || !Array.isArray(raw.topics)) {
      return { state: 'unavailable', reason: 'deliveryByTopic() 返回结构未知', bootAt };
    }
    const num = (v) => (Number.isFinite(v) ? v : 0);
    const topics = raw.topics.map((r) => ({
      topic: String((r && r.topic) ?? ''),
      published: num(r && r.published),
      delivered: num(r && r.delivered),
      deadLettered: num(r && r.deadLettered),
      pending: num(r && r.pending),
      failed: num(r && r.failed),
      other: num(r && r.other),
      deliveryAttempts: num(r && r.deliveryAttempts),
      subscribers: Array.isArray(r && r.subscribers) ? r.subscribers.map(String) : [],
      lastOccurredAt: (r && r.lastOccurredAt) ?? null,
    }));
    return {
      state: 'ok',
      bootAt,
      generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : new Date().toISOString(),
      ring: {
        size: num(raw.ring && raw.ring.size),
        capacity: num(raw.ring && raw.ring.capacity),
        full: Boolean(raw.ring && raw.ring.full),
        oldestOccurredAt: (raw.ring && raw.ring.oldestOccurredAt) ?? null,
        newestOccurredAt: (raw.ring && raw.ring.newestOccurredAt) ?? null,
      },
      totals: raw.totals && typeof raw.totals === 'object' ? raw.totals : {},
      topics,
      orphanPublished: Array.isArray(raw.orphanPublished) ? raw.orphanPublished.map(String) : [],
      orphanSubscriptions: Array.isArray(raw.orphanSubscriptions)
        ? raw.orphanSubscriptions.map((s) => ({
          subscriber: String((s && s.subscriber) ?? '?'),
          mode: (s && s.mode) ?? '?',
          topics: Array.isArray(s && s.topics) ? s.topics.map(String) : [],
        }))
        : [],
    };
  } catch (err) {
    return { state: 'error', reason: String((err && err.message) ?? err).slice(0, 160), bootAt };
  }
}

/**
 * 跨重启口径的 topic → 投递聚合（2026-10-05 补；配 event-bus 的
 * `agint.eventBus.deliveryHistory`）。与 collectDeliveryByTopic 读的不是同一份数据：
 *   - collectDeliveryByTopic  读内存 ring ⇒ 本进程 + 最近 2000 条，但分类全
 *   - collectDeliveryHistory  读 events 表 ⇒ 全历史跨重启，但给不出订阅侧孤岛
 * 事件链表同时用两者：投递列取「全历史口径优先，partial 标下界，legacyOnly 标 unknown」。
 *
 * ⚠️ coverage 是可信度标记，不是装饰：2026-10-05 之前的存量行没有 deliveries 字段，
 * 永远补不回。legacyOnly 的 topic 投递数必须显示 unknown，**不能显示 0**。
 *
 * Never throws: 与 collectDeliveryByTopic 同契约（出口缺失/结构不认识只降级自己）。
 * @param {object} ctx - host context.
 * @returns {Promise<object>}
 */
async function collectDeliveryHistory(ctx) {
    const bootAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
    try {
        const bus = ctx.get('agint.eventBus');
        if (bus === null || bus === undefined) {
            return { state: 'unavailable', reason: 'event-bus 未挂载（面板未拿到 agint.eventBus）', bootAt };
        }
        const read = typeof bus.deliveryHistory === 'function' ? bus.deliveryHistory : null;
        if (typeof read !== 'function') {
            return { state: 'unavailable', reason: 'event-bus 版本过旧：无 deliveryHistory() 出口', bootAt };
        }
        const raw = await read.call(bus);
        if (raw === null || raw === undefined || typeof raw !== 'object' || !Array.isArray(raw.topics)) {
            return { state: 'unavailable', reason: 'deliveryHistory() 返回结构未知', bootAt };
        }
        // event-bus 侧软降级已把读失败包成 state:'error' + 零值；此处照原样透出，
        // 不把 error 悄悄显示成「全 0」——那是把读失败说成没有投递。
        if (raw.state === 'error') {
            return { state: 'error', reason: String(raw.reason ?? '未知读失败').slice(0, 160), bootAt };
        }
        const num = (v) => (Number.isFinite(v) ? v : 0);
        const topics = raw.topics.map((r) => ({
            topic: String((r && r.topic) ?? ''),
            coverage: ['full', 'partial', 'legacyOnly'].includes(r && r.coverage) ? r.coverage : 'legacyOnly',
            rows: num(r && r.rows),
            rowsWithDeliveries: num(r && r.rowsWithDeliveries),
            delivered: num(r && r.delivered),
            deadLettered: num(r && r.deadLettered),
            deliveryAttempts: num(r && r.deliveryAttempts),
            subscribers: Array.isArray(r && r.subscribers) ? r.subscribers.map(String) : [],
        }));
        return {
            state: 'ok',
            bootAt,
            generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : new Date().toISOString(),
            scope: 'events-table',
            scanned: num(raw.scanned),
            withDeliveries: num(raw.withDeliveries),
            legacyRows: num(raw.legacyRows),
            totals: raw.totals && typeof raw.totals === 'object' ? raw.totals : {},
            topics,
            unknownDeliveryTopics: Array.isArray(raw.unknownDeliveryTopics)
                ? raw.unknownDeliveryTopics.map(String)
                : topics.filter((t) => t.coverage === 'legacyOnly').map((t) => t.topic),
        };
    } catch (err) {
        return { state: 'error', reason: String((err && err.message) ?? err).slice(0, 160), bootAt };
    }
}

/**
 * 神谕层（agint-aesthetic-oracle）的取数与按段合并（2026-10-22）。
 *
 * 为什么要服务面 + 落盘两路：神谕层的三个出口权威性不同。
 *  - `status()` 是**唯一**带运行态开关的出口（enabled / envOff / memoryStore /
 *    metricsAvailable / busAvailable）。这些事实只活在进程内，落盘文件里没有。
 *  - `cards()` 读的是 `oracle_cards` 表，但**只有 dashboard 订阅回写过才有行**。
 *    event-bus 未挂载 / 订阅被拒 → cards() 返回空数组，而落盘里上一轮的卡片还在。
 *    只读服务面就会把「订阅掉了」显示成「神谕从没开过口」——两件事。
 *  - `history()` 与 `getState()` 是纯表读，与落盘同源，正常情况一致。
 *
 * 合并口径：逐段取服务面，某段为空则用落盘同段补齐，并在 `notes` 里写明
 * **为什么补**。补齐不是装绿：notes 会原样渲染到面板上。
 *
 * Never throws：服务面全挂时回落落盘；两者都空才 unavailable，理由留在 reason/notes。
 *
 * @param {object} ctx - host context（可能没有 agint.aestheticOracle）。
 * @param {string} storagesDir - $DSH_HOME/storages
 * @returns {Promise<object>} payload.oracle
 */
async function collectOracle(ctx, storagesDir) {
  const notes = [];
  const file = readOracleFile(storagesDir);
  const fileOk = file.ok === true;
  if (!fileOk && file.reason) notes.push(`落盘口径不可用：${file.reason}`);

  let svc = null;
  let svcReason = null;
  try {
    svc = ctx.get('agint.aestheticOracle');
  } catch (err) {
    svcReason = `服务未注入：${String((err && err.message) ?? err).slice(0, 120)}`;
  }
  if (svcReason === null && (svc === null || svc === undefined)) {
    svcReason = '神谕层未挂载（agint.aestheticOracle 不可得）';
  }

  let svcCards = [];
  let svcHistory = [];
  let svcState = null;
  let runtime = null;

  if (svcReason === null) {
    const call = async (method, ...args) => {
      if (typeof svc[method] !== 'function') { notes.push(`服务面无 ${method}() 出口`); return null; }
      try { return await svc[method](...args); } catch (err) {
        notes.push(`${method}() 失败：${String((err && err.message) ?? err).slice(0, 140)}`);
        return null;
      }
    };
    const c = await call('cards');
    if (Array.isArray(c)) svcCards = c;
    const h = await call('history', 24);
    if (Array.isArray(h)) svcHistory = h;
    const st = await call('getState');
    if (st !== null && typeof st === 'object') svcState = st;
    if (typeof svc.status === 'function') {
      try { runtime = svc.status(); } catch (err) {
        notes.push(`status() 失败：${String((err && err.message) ?? err).slice(0, 140)}`);
      }
    } else {
      notes.push('服务面无 status() 出口（运行态开关未知，不猜）');
    }
  } else {
    notes.push(svcReason);
  }

  // 按段合并（服务面优先，落盘补齐）
  let cards = svcCards;
  if (cards.length === 0 && fileOk && Array.isArray(file.cards) && file.cards.length > 0) {
    cards = file.cards;
    notes.push(svcReason === null
      ? '卡片取自落盘：服务面 cards() 为空（dashboard 订阅未回写，常见于 event-bus 未挂载或订阅被拒）'
      : '卡片取自落盘：服务面不可得');
  }
  let broadcasts = svcHistory;
  if (broadcasts.length === 0 && fileOk && Array.isArray(file.broadcasts) && file.broadcasts.length > 0) {
    broadcasts = file.broadcasts;
    notes.push('广播史取自落盘：服务面 history() 为空或不可得');
  }
  const stateRow = svcState !== null ? svcState : (fileOk ? (file.state ?? null) : null);
  if (svcState === null && stateRow !== null) notes.push('状态行取自落盘：服务面 getState() 为空或不可得');

  /** source 记录的是**数据实际来自哪里**，不是「服务面在不在」。
   *  ⛔ 服务面存在但三个出口全缺（旧版 oracle）时数据 100% 来自落盘，
   *     此时写 'service+storages' 会让人以为服务面供了数。 */
  const svcGaveCards = cards === svcCards && svcCards.length > 0;
  const svcGaveHistory = broadcasts === svcHistory && svcHistory.length > 0;
  const svcGaveState = svcState !== null;
  const anyFromService = svcGaveCards || svcGaveHistory || svcGaveState;
  const allFromService = svcGaveCards && svcGaveHistory && svcGaveState;
  const out = normalizeOracle({
    cards,
    broadcasts,
    state: stateRow,
    runtime,
    source: allFromService ? 'service' : (anyFromService ? 'service+storages' : 'storages'),
    notes,
    observedAt: fileOk ? file.observedAt : null,
    limit: 20,
  });
  out.serviceAvailable = svcReason === null;
  out.serviceReason = svcReason;
  return out;
}

/**
 * 上游判读分区的运行态补丁（v0.6.0）。
 *
 * 落盘口径（`aggUpstream`）能给出「判过哪些版本、结论是什么」，但给不出这三样：
 *   - **lag**（本机落后几个版本）：需要「本机 dsh 版本 + 上游最新 tag + 版本语义比较」，
 *     版本语义的实现只在上游判读器里有一份，面板抄一份必然漂移。
 *   - **calibration**（判读准不准，v0.3）：需要把「预测」与「实际升级结果」对齐，
 *     那两份数据都在判读器的存储里。
 *   - **serviceOk**：「插件装着但一次都没跑过」与「插件没装」是两种不同的灰，
 *     光看文件在不在分不开。
 *
 * ⛔ 服务面拿不到时**不伪造**：lag / calibration 均给 null 并写 notes，
 *    由面板显示「运行态不可得」。给 0 会被读成「已是最新 / 准确率 0」。
 *
 * @param {object} ctx
 * @param {object} base - `aggUpstream()` 的落盘结果（就地补，返回同一对象形状）
 */
async function collectUpstream(ctx, base) {
  const out = { ...base };
  const notes = [];

  let svc = null;
  let svcReason = null;
  try {
    svc = ctx.get('agint.upstreamWatch');
  } catch (err) {
    svcReason = `服务未注入：${String((err && err.message) ?? err).slice(0, 120)}`;
  }
  if (svcReason === null && (svc === null || svc === undefined)) {
    svcReason = '上游判读器未挂载（agint.upstreamWatch 不可得）';
  }

  out.serviceAvailable = svcReason === null;
  out.serviceReason = svcReason;
  out.lag = null;
  out.calibration = base.calibration ?? null;
  out.stats = null;

  if (svcReason !== null) {
    notes.push(svcReason);
    out.notes = notes;
    return out;
  }

  const call = async (method, ...args) => {
    if (typeof svc[method] !== 'function') { notes.push(`服务面无 ${method}() 出口`); return null; }
    try { return await svc[method](...args); } catch (err) {
      notes.push(`${method}() 失败：${String((err && err.message) ?? err).slice(0, 140)}`);
      return null;
    }
  };

  const st = await call('status');
  if (st && typeof st === 'object') {
    out.lag = st.lag && typeof st.lag === 'object' ? st.lag : null;
    out.stats = st.stats && typeof st.stats === 'object' ? st.stats : null;
    out.config = st.config && typeof st.config === 'object' ? st.config : null;
    // 服务面 recent 更新的那一条可能还没落盘刷新；只在落盘为空时用它兜底，
    // 免得面板出现「同一 tag 两份不同时刻的结论」。
    if ((out.digests ?? []).length === 0 && Array.isArray(st.recent) && st.recent.length > 0) {
      notes.push('判读列表取自服务面 recent（落盘口径为空，可能是刚判完还没刷盘）');
    }
  }

  // calibration 是 v0.3 才有的出口。旧版没有时**静默跳过**，不写 note ——
  // 面板上不该出现「服务面无 calibration() 出口」这种只有开发者看得懂的噪音。
  if (typeof svc.calibration === 'function') {
    const cal = await call('calibration');
    if (cal && typeof cal === 'object') out.calibration = cal;
  }

  // 「插件在、但从未判读过」要能看出来 —— 否则面板会显示成「一切正常，0 条」
  if ((out.digests ?? []).length === 0 && out.baselineOnly !== true) {
    notes.push('尚无判读记录：等频道拉到新版本，或用 upstream_digest 手动跑一次');
  }

  out.notes = notes;
  return out;
}

/**
 * v2 快照 + 运行态订阅表 + 零投递分层。路由与服务出口共用这一份，防两处口径漂。
 *
 * 分层为什么放服务端：投递计数只活在本进程，浏览器半拿不到豁免表也读不到全历史，
 * 在浏览器里再判一次就会把已归档的断链重报成新问题（见 v2-data classifySubscriptions）。
 * @param {object} ctx - host context.
 * @param {object} [config] - cordis 注入的插件配置；只用到 repoRoot（仓库位根，候选 ⓪）。
 * @returns {Promise<object>} payload —— 异步：deliveryHistory 读存储域。
 */
async function buildV2Payload(ctx, config = {}) {
    const repoRoot = typeof config?.repoRoot === 'string' && config.repoRoot.trim() !== ''
        ? config.repoRoot.trim()
        : null;
    const dirs = resolveV2Dirs(
        process.env,
        import.meta.url,
        repoRoot,
        // 2026-10-08：profile 名权威源是 cordis ctx，不是 process.env（见 v2-data.js 注释）
        (typeof ctx?.get === 'function' ? ctx.get('profileContext')?.name : null) ?? null,
    );
    const payload = collectV2Data(dirs);
    payload.subscriptions = collectSubscriptions(ctx);
    payload.deliveryByTopic = collectDeliveryByTopic(ctx);
    payload.deliveryHistory = collectDeliveryHistory(ctx);
    payload.subscriptionAudit = classifySubscriptions(payload.subscriptions, payload.bus, payload.wiringExemptions);
    // 神谕层：collectV2Data 里已给落盘口径（payload.oracle），这里用服务面覆盖/补齐。
    // ⛔ 必须 await：cards()/history()/getState() 都是异步表读。
    payload.oracle = await collectOracle(ctx, dirs.storagesDir);
    // 提案台（0.5.0）：服务面优先、存储面兜底。同样必须 await。
    payload.proposals = await collectProposals(ctx, dirs);
    // 上游判读（0.6.0）：落盘 base 已由 collectV2Data 给出，这里只补运行态三样。
    payload.upstream = await collectUpstream(ctx, payload.upstream ?? { state: 'unavailable', digests: [] });
    return payload;
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
        const payload = await buildV2Payload(ctx, config);
        writeJson(res, 200, { ...payload, enabled: true });
      } catch (err) {
        writeJson(res, 500, { ok: false, error: String((err && err.message) ?? err).slice(0, 300) });
      }
    },
  });

  /**
   * 提案审批。这是本插件唯一的写路由（0.5.0）。
   *
   * 四道门，缺一不可：回环 → 自定义头 + 同源 → JSON + 体积上限 → 状态白名单。
   * 过了门才碰服务。服务缺席时返回 503 并给出原因 —— 面板据此把按钮置灰，
   * 而不是让人点了没反应。
   */
  ctx.webServer.register({
    kind: 'exact',
    path: DECISION_PATH,
    handler: async (req, res) => {
      try {
        if (!enabled) {
          writeJson(res, 200, { ok: true, enabled: false, note: '面板已被 kill-switch 关闭，写通道同时关闭' });
          return;
        }
        if (!allowNonLoopback && !isLoopback(req)) {
          writeJson(res, 403, { ok: false, error: 'loopback-only' });
          return;
        }
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST');
          writeJson(res, 405, { ok: false, error: 'method-not-allowed' });
          return;
        }
        if (req.headers['x-agint-panel'] !== '1') {
          writeJson(res, 403, { ok: false, error: 'missing x-agint-panel header' });
          return;
        }
        if (!isSameOrigin(req)) {
          writeJson(res, 403, { ok: false, error: 'cross-origin rejected' });
          return;
        }
        if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
          writeJson(res, 415, { ok: false, error: 'content-type must be application/json' });
          return;
        }
        const raw = await readBody(req, DECISION_BODY_MAX);
        if (raw === null) {
          writeJson(res, 413, { ok: false, error: `body 超过 ${DECISION_BODY_MAX} 字节` });
          return;
        }
        let input;
        try {
          input = JSON.parse(raw);
        } catch {
          writeJson(res, 400, { ok: false, error: 'body 不是合法 JSON' });
          return;
        }
        const id = typeof input?.id === 'string' ? input.id.trim() : '';
        const status = typeof input?.status === 'string' ? input.status.trim() : '';
        const reason = typeof input?.note === 'string' ? input.note.trim() : '';
        // 2026-10-27：批准时可选带上「为什么还不能动手」。省略（undefined）= 不动原值；
        // 传空串 = 明确解除阻塞。两种语义必须能区分，所以这里不做 `?? ''` 兜底。
        const blocker = typeof input?.blocker === 'string' ? input.blocker.trim() : undefined;
        const unblockCondition = typeof input?.unblockCondition === 'string' ? input.unblockCondition.trim() : undefined;
        // 2026-10-27：批准后怎么执行。省略 = 不动原计划（冻结语义，与 blocker 一致）。
        // ⛔ 不在这里兜底成 'manual'：那会把一条已定好定时的提案，被人补一句理由
        //    就静默降级成「只批准」。
        const execMode = typeof input?.execMode === 'string' ? input.execMode.trim() : undefined;
        const execAt = typeof input?.execAt === 'string' ? input.execAt.trim() : undefined;
        // 2026-10-27：这条提案能不能自动执行。省略 = 不动原值（冻结语义）。
        // ⛔ 只认布尔：传字符串/数字一律 400，不猜 —— 「猜错」的代价是把一条
        //    能跑的提案永久钉死，或把复核类提案放出去白跑一次。
        let autoExecutable;
        if (input?.autoExecutable !== undefined && input?.autoExecutable !== null) {
          if (typeof input.autoExecutable !== 'boolean') {
            writeJson(res, 400, { ok: false, error: 'autoExecutable 必须是布尔值（true / false）' });
            return;
          }
          autoExecutable = input.autoExecutable;
        }
        if (id === '') {
          writeJson(res, 400, { ok: false, error: '缺 id' });
          return;
        }
        if (blocker !== undefined && blocker.length > 200) {
          writeJson(res, 400, { ok: false, error: '阻塞原因上限 200 字' });
          return;
        }
        if (unblockCondition !== undefined && unblockCondition.length > 200) {
          writeJson(res, 400, { ok: false, error: '解锁条件上限 200 字' });
          return;
        }
        if (execMode !== undefined && !DECISION_EXEC_MODES.has(execMode)) {
          writeJson(res, 400, { ok: false, error: `execMode 不在白名单：${execMode === '' ? '（空）' : execMode}` });
          return;
        }
        if (execMode === 'scheduled') {
          if (!execAt) {
            writeJson(res, 400, { ok: false, error: 'execMode=scheduled 必须给 execAt（ISO 时间）' });
            return;
          }
          if (!Number.isFinite(Date.parse(execAt))) {
            writeJson(res, 400, { ok: false, error: `execAt 不是合法时间：${execAt}` });
            return;
          }
        }
        // 自动执行只对「批准」有意义：拒绝/撤销时带 execMode 属于误操作，
        // 直接忽略比报错友好，但要把计划一起清掉 —— 否则一条被拒绝的提案
        // 还挂着「定时 10-28 09:00」的字段，日后读的人会以为它还会跑。
        const wantsAutoExec = status === 'approved' && execMode !== undefined && execMode !== 'manual';
        if (!DECISION_STATUSES.has(status)) {
          writeJson(res, 400, { ok: false, error: `状态不在白名单：${status === '' ? '（空）' : status}` });
          return;
        }
        if (REASON_REQUIRED.has(status) && reason.length < 2) {
          const why = status === 'applied'
            ? 'applied 必须写落地证据（改了哪些文件 / 哪一行）—— 全表 applied 行的 note 都是证据'
            : `${status} 必须写理由（至少 2 个字符）—— 三个月后没人知道当时为什么`;
          writeJson(res, 400, { ok: false, error: why });
          return;
        }
        if (reason.length > 400) {
          writeJson(res, 400, { ok: false, error: '理由上限 400 字' });
          return;
        }
        const evolve = typeof ctx.get === 'function' ? ctx.get('agint.evolve') : null;
        if (!evolve || typeof evolve.setStatus !== 'function') {
          writeJson(res, 503, {
            ok: false,
            error: evolve ? 'agint.evolve 版本过旧：无 setStatus() 出口' : 'agint.evolve 未挂载 —— 提案写不了',
          });
          return;
        }
        const prev = typeof evolve.getProposal === 'function' ? await evolve.getProposal(id) : null;
        if (prev === null || prev === undefined) {
          writeJson(res, 404, { ok: false, error: `未找到提案 ${id}` });
          return;
        }
        // 2026-10-29：这里原有一道「声明不可自动执行 ⇒ 400 拒排」的语义闸，已撤。
        // 老板裁定：批准后就要自动执行，不许停下来等人，也不许把提案标成
        // 「不可自动执行」—— 那等于把「跑不动」伪装成「不该跑」。
        // 2026-10-27：状态没变但阻塞信息变了，也是一次真实变更 —— 否则「给已批准的
        // 提案补一句为什么不能动手」这种写会被幂等短路掉，永远存不进去。
        const blockerChanged = blocker !== undefined && blocker !== (prev.blocker ?? '');
        const unblockChanged = unblockCondition !== undefined && unblockCondition !== (prev.unblockCondition ?? '');
        const execChanged = (execMode !== undefined && execMode !== (prev.execMode ?? 'manual'))
          || (execMode === 'scheduled' && execAt !== undefined && execAt !== (prev.execAt ?? ''));
        // 2026-10-27：改「能不能自动执行」也是一次真实变更 —— 否则「把这条标成
        // 不可自动执行」这种写会被幂等短路掉，永远存不进去。
        const autoExecChanged = autoExecutable !== undefined && autoExecutable !== (prev.autoExecutable !== false);
        if (prev.status === status && !blockerChanged && !unblockChanged && !execChanged && !autoExecChanged) {
          // 幂等：目标态与现状相同就不写，避免 updatedAt 被无意义地刷。
          writeJson(res, 200, { ok: true, changed: false, previousStatus: prev.status, proposal: prev, at: new Date().toISOString() });
          return;
        }
        const at = new Date().toISOString();
        // 只改阻塞信息（状态不变）时不拼「批准/拒绝」抬头 —— 那会把一条注释伪装成
        // 一次决定，而 decisions 的 note 抬头是给「谁在什么时候判了什么」留证的。
        const note = prev.status === status
          ? String(prev.note ?? '')
          : composeDecisionNote({ status, reason, prevNote: prev.note, at });
        const opts = { blocker, unblockCondition };
        if (execMode !== undefined) opts.execMode = execMode;
        if (execMode === 'scheduled' && execAt !== undefined) opts.execAt = execAt;
        // 2026-10-29：仍接受 autoExecutable 入参（老调用方/工具在用），但它是
        // **惰性历史标记** —— 只落库，不拦执行、不再把执行计划归位 manual。
        if (autoExecutable !== undefined) opts.autoExecutable = autoExecutable;
        // 非批准的判定：把执行计划顺手清回 manual，别留下"还会跑"的错觉。
        if (status !== 'approved' && execMode === undefined && (prev.execMode ?? 'manual') !== 'manual') {
          opts.execMode = 'manual';
        }
        let rec;
        try {
          rec = await evolve.setStatus(id, status, note, opts);
        } catch (error) {
          // setStatus 抛的是校验类错误（execAt 在过去 / 超过一年等），按 400 回，
          // 让人知道是"参数不对"而不是"服务坏了"。
          writeJson(res, 400, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
          return;
        }
        if (rec === null || rec === undefined) {
          writeJson(res, 500, { ok: false, error: 'setStatus() 返回空 —— 写入未生效' });
          return;
        }
        writeJson(res, 200, {
          ok: true,
          changed: true,
          previousStatus: prev.status,
          proposal: rec,
          at,
          // 面板据此在 toast 里说明「已进入自动执行队列」还是「只是批准」。
          execution: {
            mode: rec.execMode ?? 'manual',
            at: rec.execAt ?? '',
            state: rec.execState ?? 'idle',
            // ⛔ auto 必须与「真的进了队列」一致：标了不可执行、或有 blocker，
            //    都不能报 true（面板 toast 会照它说「已入执行队列」）。
            auto: wantsAutoExec && !(rec.blocker ?? '')
              && (rec.execState === 'queued' || rec.execState === 'running'),
            // 2026-10-29：置灰逻辑已撤；字段留着只为兼容旧面板缓存。
            autoExecutable: rec.autoExecutable !== false,
          },
        });
      } catch (err) {
        writeJson(res, 500, { ok: false, error: String((err && err.message) ?? err).slice(0, 300) });
      }
    },
  });

  ctx.provide('agint.familyPanel', {
    /** Current snapshot; the route and any in-process consumer share this. */
    status: () => buildStatus(ctx),
    /**
     * v2 聚合快照；与 /v2/data 路由同源同缓存（含运行态订阅表与零投递分层）。
     * ⛔ 返回 Promise：deliveryHistory 要读 events 表存储域（2026-10-05 方案 A）。
     * 消费方必须 await —— 把它当同步对象用会拿到未 resolve 的半截payload。
     */
    v2Data: () => buildV2Payload(ctx, config),
    /** The prefix the browser half fetches (root-absolute). */
    apiPrefix: API_PREFIX,
    /** Kill-switch: off keeps the route alive but empty. */
    setEnabled: (next) => { enabled = next === true; return enabled; },
    isEnabled: () => enabled,
  });
}

export {
  Config,
  apply,
  inject,
  name,
  optionalInject,
  collectSubscriptions,
  collectDeliveryByTopic,
  collectDeliveryHistory,
  collectOracle,
  collectProposals,
  collectUpstream,
};
