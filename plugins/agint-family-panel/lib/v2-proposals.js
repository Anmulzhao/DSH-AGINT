/**
 * agint-family-panel: 提案台数据层（v0.5.0，2026-10-23）。
 *
 * 出发点是一个实测数字：2026-10-23 抽查 20 条标 `proposed` 的提案，
 * **10 条状态与代码事实不符**。整张表 94 行里 51 条挂 proposed，最老的 44 天。
 * 于是「人工审批」这件事有两个真问题，不是排版问题：
 *
 *  1. 待批队列没有出口。状态机缺「已批准待执行」这一档（已由 agint-evolve
 *     v0.8.0 补 `approved`），人能做的只有「看完什么都不记」。
 *  2. 批准之前无法判断这条提案是不是早就做完了。正文里的路径、符号是可核对的，
 *     但没人愿意一条条去 grep。
 *
 * 本模块只回答第 2 个问题的一半：**把可核对的事实摆出来**。
 * 它不下「已落地」这种判定 —— 符号命中只能算线索。判定是人做的。
 *
 * 三条纪律（与本插件其余各源一致）：
 *  - 取不到就说取不到：服务面 / 存储面都失败时 `state` 是 `unavailable` 或
 *    `error`，绝不返回一个 total=0 的空表冒充「没有提案」。
 *  - 只收可核对的差异：路径存在与否、符号在文件里能不能命中、正文有几节。
 *    判断「这条提案写得好不好、值不值得做」不在这里。
 *  - 仓库位不可得时，证据栏标 `unavailable` 并说明原因，不静默留空。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** 正文单个分节的长度上限。传全文给浏览器没有意义，面板只做摘录展示。 */
const SECTION_MAX = 2400;
/** 单条提案正文上限。超出部分截断并标 truncated，不静默吞掉。 */
const BODY_MAX = 8000;
/** 证据核对上限：宁可少报，也不让一次展开扫全仓。 */
const MAX_PATHS = 6;
const MAX_SYMBOLS = 12;
const MAX_PROBE_FILES = 4;
const FILE_READ_MAX = 512 * 1024;

const DAY_MS = 86_400_000;

/** 正文分节：标题命中关键词即归入该节。顺序即展示顺序，也即「从动机到后果」。 */
const SECTION_SPECS = [
  ['problem', /(现状问题|当前问题|问题描述|背景|动机|痛点)/],
  ['plan', /(改动方案|实施方案|方案|做法|改法|落地形态|步骤)/],
  ['benefit', /(预期收益|收益|价值|意义|影响|好处)/],
  ['risk', /(风险|边界|前置条件|代价|副作用)/],
  ['links', /(关联|引用|相关提案|依赖)/],
];

const ROOT_FILE_RE = /^(README|AGENTS|VERSION|CHANGELOG|SOUL|package)(\.[a-z]+)?$/i;
// 扩展名顺序：长的在前，否则 `package.json` 会被 `js` 抢走尾巴，变成
// `package.js`（不存在）—— 实测误报，2026-10-23 修。末尾用 `(?![a-z0-9])`
// 兜底，防止 `x.mdx` 被当成 `x.md`。
const PATH_RE = /(?:[A-Za-z]:)?[\\/]?(?:[\w.\-()（）\u4e00-\u9fa5]+[\\/])*[\w.\-()（）\u4e00-\u9fa5]+\.(?:mjs|cjs|tsx|json|yaml|html|css|yml|sh|py|ts|md|js)(?![a-z0-9])/g;

const trimTo = (s, n) => (s.length > n ? `${s.slice(0, n)}\n…（截断，原 ${s.length} 字符）` : s);

/**
 * 正文 → 五节。
 *
 * 提案正文不是结构化字段，是 markdown。95 条里 49 条有「改动方案」标题、
 * 61 条有「预期收益」，也就是说**分节是多数派但远非全部**。所以这里返回的
 * 每一节都可能是 null —— 缺节就显示缺节，不用正文首段去凑「目的」。
 *
 * @param {string} body
 * @returns {{sections: Record<string,string|null>, matched: number, lines: number}}
 */
export function parseSections(body) {
  const text = typeof body === 'string' ? body : '';
  const out = {};
  for (const [key] of SECTION_SPECS) out[key] = null;
  if (text === '') return { sections: out, matched: 0, lines: 0 };

  const lines = text.split(/\r?\n/);
  let cursor = null;
  let buf = [];
  const flush = () => {
    if (cursor !== null && buf.length > 0) {
      const joined = buf.join('\n').trim();
      if (joined !== '' && out[cursor] === null) out[cursor] = trimTo(joined, SECTION_MAX);
    }
    buf = [];
  };

  for (const line of lines) {
    const m = /^\s*#{2,4}\s+(.*)$/.exec(line);
    if (m !== null) {
      flush();
      const title = m[1];
      const hit = SECTION_SPECS.find(([, re]) => re.test(title));
      cursor = hit === undefined ? null : hit[0];
      continue;
    }
    if (cursor !== null) buf.push(line);
  }
  flush();

  const matched = Object.values(out).filter((v) => v !== null).length;
  return { sections: out, matched, lines: lines.length };
}

/**
 * 正文 → 可核对的引用。
 *
 * 路径：形如 `plugins/x/lib/index.js`、`README.md:85`、`D:\...\AGENTS.md`。
 * 符号：反引号里的标识符，形如 `evolve_set_status`、`CANDIDATE_OPEN_STATUSES`。
 * 只收这两类 —— 它们是能拿文件系统直接验证的东西。散文里的名词不收。
 *
 * @param {string} body
 * @returns {{paths: Array<object>, symbols: string[]}}
 */
export function extractRefs(body) {
  const text = typeof body === 'string' ? body : '';
  const paths = [];
  const seen = new Set();
  for (const m of text.matchAll(PATH_RE)) {
    const raw = m[0].replace(/[\\/]+$/, '');
    if (raw === '' || seen.has(raw)) continue;
    // 单纯的文件名（`index.js`）不收：无法定位，验了也是噪声。
    if (!/[\\/]/.test(raw) && !ROOT_FILE_RE.test(raw)) continue;
    if (/node_modules/.test(raw)) continue;
    seen.add(raw);
    paths.push({ raw });
    if (paths.length >= MAX_PATHS) break;
  }
  // `README.md:85` 这类行号后缀：从原文里补回来，方便人直接跳。
  const withLines = paths.map((p) => {
    const re = new RegExp(`${escapeRe(p.raw)}:(\\d+)`);
    const hit = re.exec(text);
    return hit === null ? p : { raw: p.raw, line: Number(hit[1]) };
  });

  const symbols = [];
  const seenSym = new Set();
  for (const m of text.matchAll(/`([^`\n]{2,80})`/g)) {
    const tok = m[1].trim().replace(/\(\)$/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(tok)) continue;
    // 文件名与路径不是符号：`index.js`、`package.json` 已由路径通道处理。
    // 早前这里取 last segment，把 `index.js` 变成符号 `js`、`arr.length`
    // 变成 `length` —— 全仓命中，线索全废。2026-10-23 修。
    if (/\.(mjs|cjs|tsx|json|yaml|html|css|yml|sh|py|ts|md|js)$/i.test(tok)) continue;
    const parts = tok.includes('.') ? [tok, tok.split('.').pop()] : [tok];
    for (const cand of parts) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cand)) continue;
      // 收的条件：带下划线 / 驼峰且够长 / 纯标识符够长（≥10）。
      // `status`、`note`、`plugin`、`VERSION`、`HARM`、`length` 这类通用词被挡在外面 ——
      // 它们全仓都命中，命中率 100% 的线索等于没有线索。
      const meaningful = /_/.test(cand) || /[a-z][A-Z]/.test(cand) || cand.length >= 10;
      if (!meaningful || seenSym.has(cand)) continue;
      seenSym.add(cand);
      symbols.push(cand);
      if (symbols.length >= MAX_SYMBOLS) break;
    }
    if (symbols.length >= MAX_SYMBOLS) break;
  }

  return { paths: withLines, symbols };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 把提案里的路径归一化到仓库相对路径。
 *
 * 历史提案里的写法五花八门：`plugins/agint-evolve/lib/index.js`、
 * `project\DSH-AGINT\README.md:85`、`D:\DSH\project源码\DSH-AGINT\AGENTS.md`。
 * 全都认「DSH-AGINT/ 之后的部分」这一条锚 —— 它跨机器稳定，也不依赖本机盘符。
 *
 * @param {string} raw
 * @returns {{rel: string|null, absolute: string|null}}
 */
export function normalizeRefPath(raw) {
  const norm = String(raw ?? '').replace(/\\/g, '/').replace(/:\d+$/, '');
  const marker = '/DSH-AGINT/';
  const at = norm.indexOf(marker);
  if (at !== -1) return { rel: norm.slice(at + marker.length), absolute: null };
  if (/^[A-Za-z]:\//.test(norm)) return { rel: null, absolute: norm };
  return { rel: norm.replace(/^\.\//, '').replace(/^\/+/, ''), absolute: null };
}

/**
 * 证据核对：路径存不存在、符号在不在引用文件里。
 *
 * ⛔ 只出「事实」，不出「判定」。`hint.level` 的三档是 `stale`（引用路径全没了）、
 * `maybe-done`（符号在引用文件里命中）、`neutral`（路径在、符号没命中）。
 * 没有一档叫「已落地」—— 符号命中可能是同名残留，也可能是别处定义。
 *
 * @param {{paths: Array<object>, symbols: string[]}} refs
 * @param {string|null} repoRoot
 * @returns {object}
 */
export function probeEvidence(refs, repoRoot) {
  const pathRows = [];
  const seenRel = new Set();
  for (const p of refs?.paths ?? []) {
    const { rel, absolute } = normalizeRefPath(p.raw);
    // 同一文件多种写法（`project\DSH-AGINT\README.md` 与 `README.md`）只算一次，
    // 否则「6 条路径现存 3 条」会被同一份 README 灌水。
    if (rel !== null) {
      if (seenRel.has(rel)) continue;
      seenRel.add(rel);
    }
    const wiki = rel !== null && (rel.startsWith('.wiki/') || /(^|\/)DSH-AGINT\.wiki\//.test(rel) || /^AGINT\.wiki\//.test(rel));
    // wiki 仓是**另一个 git 仓**，本仓核对不了。标 null（不可核）而不是 false（不存在）——
    // 把「我没法看」说成「它不在」，就是这行最常犯的那种假证据。
    if (wiki || rel === null && absolute === null) {
      pathRows.push({ raw: p.raw, rel, exists: null, line: p.line ?? null, unverifiable: wiki ? 'wiki 仓不在本仓，无法核对' : '路径无法归一化' });
      continue;
    }
    if (repoRoot === null) {
      pathRows.push({ raw: p.raw, rel, exists: null, line: p.line ?? null });
      continue;
    }
    if (rel !== null && (rel.startsWith('../') || rel === '..')) {
      pathRows.push({ raw: p.raw, rel, exists: null, line: p.line ?? null, unverifiable: '指向仓库之外' });
      continue;
    }
    const target = absolute !== null ? absolute : join(repoRoot, rel);
    let exists = false;
    let mtime = null;
    try {
      exists = statSync(target).isFile();
      if (exists) mtime = statSync(target).mtime.toISOString();
    } catch { exists = false; }
    pathRows.push({ raw: p.raw, rel, exists, mtime, line: p.line ?? null });
  }

  const existFiles = pathRows.filter((r) => r.exists === true && r.rel !== null).map((r) => r.rel);
  const cache = new Map();
  const readCached = (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    let text = null;
    try {
      const p = join(repoRoot, rel);
      const st = statSync(p);
      if (st.isFile() && st.size <= FILE_READ_MAX) text = readFileSync(p, 'utf8');
    } catch { text = null; }
    cache.set(rel, text);
    return text;
  };

  const symRows = [];
  if (repoRoot !== null) {
    const probeFiles = existFiles.slice(0, MAX_PROBE_FILES);
    for (const name of (refs?.symbols ?? [])) {
      const hits = [];
      for (const rel of probeFiles) {
        const text = readCached(rel);
        if (text !== null && text.includes(name)) hits.push(rel);
      }
      // 同一个名字在 2 个以上被引用文件里都出现 ⇒ 它是框架 API 或通用词
      // （`defineDomain`、`lastError` 这类），命中它说明不了任何事。
      // 单独标 generic，不计进 symFound —— 线索宁可少，不可假。
      const generic = hits.length >= 2;
      symRows.push({ name, found: hits.length > 0, generic, where: hits[0] ?? null, hits: hits.length });
    }
  } else {
    for (const name of (refs?.symbols ?? [])) symRows.push({ name, found: null, generic: false, where: null, hits: 0 });
  }

  const pathTotal = pathRows.length;
  const pathChecked = pathRows.filter((r) => r.exists !== null).length;
  const pathExists = pathRows.filter((r) => r.exists === true).length;
  const symTotal = symRows.length;
  const symFound = symRows.filter((r) => r.found === true && r.generic !== true).length;
  const symGeneric = symRows.filter((r) => r.generic === true).length;

  let hint = null;
  if (repoRoot === null) {
    hint = { level: 'unknown', text: '仓库位不可得，证据未核对' };
  } else if (pathChecked > 0 && pathExists === 0) {
    hint = { level: 'stale', text: `正文引用的 ${pathChecked} 条路径全部不存在 —— 描述的文件布局已过期` };
  } else if (symFound > 0) {
    hint = { level: 'maybe-done', text: `${symFound} 个符号已在引用文件命中 —— 可能已落地，需人工确认` };
  } else if (pathChecked > 0 && symTotal === 0) {
    hint = { level: 'neutral', text: '引用路径存在；正文没有可核对的符号' };
  } else if (pathChecked > 0) {
    hint = { level: 'neutral', text: '引用路径存在，符号未命中' };
  } else {
    hint = { level: 'unknown', text: '正文没有可核对的路径或符号' };
  }

  return {
    state: repoRoot === null ? 'unavailable' : 'ok',
    reason: repoRoot === null ? '仓库位解析失败（repoPluginsDir 为 null）' : null,
    paths: pathRows,
    symbols: symRows,
    summary: { pathTotal, pathChecked, pathExists, symTotal, symFound, symGeneric, unverifiable: pathTotal - pathChecked },
    hint,
  };
}

/** 中位数（空集返回 null，不返回 0）。 */
function median(nums) {
  if (!Array.isArray(nums) || nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[mid - 1] + s[mid]) / 2) : s[mid];
}

const ageDaysOf = (iso, now) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now - t) / DAY_MS));
};

/** 统计块：状态分布、分类分布、来源聚类、年龄。只对 proposed 算「队列」口径。 */
export function summarizeProposals(items, now = Date.now()) {
  const byStatus = {};
  const byCategoryAll = {};
  const queue = [];
  for (const it of items) {
    byStatus[it.status] = (byStatus[it.status] ?? 0) + 1;
    byCategoryAll[it.category] = (byCategoryAll[it.category] ?? 0) + 1;
    if (it.status === 'proposed') queue.push(it);
  }
  const byCategory = {};
  const bySource = new Map();
  const ages = [];
  let buckets = { le7: 0, d8to30: 0, gt30: 0 };
  for (const it of queue) {
    byCategory[it.category] = (byCategory[it.category] ?? 0) + 1;
    const src = String(it.source ?? '').trim() === '' ? '（无来源）' : String(it.source).trim();
    bySource.set(src, (bySource.get(src) ?? 0) + 1);
    if (it.ageDays !== null) {
      ages.push(it.ageDays);
      if (it.ageDays <= 7) buckets.le7 += 1;
      else if (it.ageDays <= 30) buckets.d8to30 += 1;
      else buckets.gt30 += 1;
    }
  }
  const sources = [...bySource.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));

  return {
    total: items.length,
    byStatus,
    queueCount: queue.length,
    byCategory,
    byCategoryAll,
    sources: sources.slice(0, 10),
    sourceKinds: sources.length,
    aging: {
      oldestDays: ages.length === 0 ? null : Math.max(...ages),
      medianDays: median(ages),
      buckets,
    },
  };
}

/**
 * 从存储文件读（服务面缺席时的兜底）。
 *
 * 这里读的是 `agint_evolve.json` 的 `tables.proposal`，与 aggPending 同一套
 * 读法。区分三种失败：文件不存在（`unavailable`，本机没开这个域）、
 * 解析失败（`error`）、表为空（`ok` + 0 条 —— 这才是真的没有提案）。
 */
function readFromStorage(storagesDir) {
  const p = join(storagesDir, 'agint_evolve.json');
  if (!existsSync(p)) return { state: 'unavailable', reason: `未找到 ${p}`, rows: [] };
  let raw;
  try {
    raw = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    return { state: 'error', reason: `agint_evolve.json 解析失败：${String((e && e.message) ?? e).slice(0, 160)}`, rows: [] };
  }
  const table = raw?.tables?.proposal;
  if (table === null || typeof table !== 'object') {
    return { state: 'unavailable', reason: 'agint_evolve.json 无 tables.proposal', rows: [] };
  }
  let mtime = null;
  try { mtime = statSync(p).mtime.toISOString(); } catch { mtime = null; }
  return { state: 'ok', reason: null, rows: Object.values(table), mtime };
}

/**
 * 汇拢提案台所需的全部数据。永不抛出 —— 每一层降级都写进返回值。
 *
 * 取数优先级：服务面 `agint.evolve.listProposals()` 优先。
 * 理由：面板的写路由走同一个服务，服务面读到的就是刚写完的那一版；
 * 存储面还要等原子落盘，且看不到进程内的写入顺序。服务面缺席时回落存储面。
 *
 * @param {object} ctx cordis host context
 * @param {{storagesDir?: string, repoPluginsDir?: string|null}} dirs
 * @returns {Promise<object>}
 */
export async function collectProposals(ctx, dirs = {}, now = Date.now()) {
  const observedAt = new Date(now).toISOString();
  const storagesDir = typeof dirs.storagesDir === 'string' ? dirs.storagesDir : null;
  const repoPluginsDir = typeof dirs.repoPluginsDir === 'string' ? dirs.repoPluginsDir : null;
  const repoRoot = repoPluginsDir === null ? null : dirname(resolve(repoPluginsDir));

  let rows = [];
  let source = 'none';
  let state = 'unavailable';
  let reason = '既没有 agint.evolve 服务，也没有可读的 agint_evolve.json';
  let watcher = null;

  // ① 服务面
  try {
    const evolve = typeof ctx?.get === 'function' ? ctx.get('agint.evolve') : null;
    if (evolve && typeof evolve.listProposals === 'function') {
      const list = await evolve.listProposals({});
      if (Array.isArray(list)) {
        rows = list;
        source = 'service';
        state = 'ok';
        reason = null;
      } else {
        reason = 'agint.evolve.listProposals() 返回非数组';
      }
      if (typeof evolve.stats === 'function') {
        try { watcher = await evolve.stats(); } catch { watcher = null; }
      }
    } else if (evolve) {
      reason = 'agint.evolve 版本过旧：无 listProposals() 出口';
    }
  } catch (e) {
    reason = `agint.evolve.listProposals() 失败：${String((e && e.message) ?? e).slice(0, 160)}`;
  }

  // ② 存储面兜底
  if (state !== 'ok' && storagesDir !== null) {
    const fb = readFromStorage(storagesDir);
    if (fb.state === 'ok') {
      rows = fb.rows;
      source = 'storage';
      state = 'ok';
      reason = null;
      watcher = { mtime: fb.mtime ?? null };
    } else {
      state = fb.state;
      reason = `${reason}；兜底：${fb.reason}`;
    }
  }

  if (state !== 'ok') {
    return {
      state,
      reason,
      source,
      observedAt,
      repoRoot,
      items: [],
      counts: null,
    };
  }

  // 来源聚类：先按来源数一遍，逐条挂上「同源还有几条」。
  const sourceCount = new Map();
  for (const r of rows) {
    const s = String(r?.source ?? '').trim();
    sourceCount.set(s, (sourceCount.get(s) ?? 0) + 1);
  }

  const items = rows.map((r) => {
    const body = typeof r?.body === 'string' ? r.body : '';
    const truncated = body.length > BODY_MAX;
    const { sections, matched } = parseSections(body);
    const refs = extractRefs(body);
    const evidence = probeEvidence(refs, repoRoot);
    const src = String(r?.source ?? '').trim();
    return {
      id: String(r?.id ?? ''),
      title: String(r?.title ?? '（无标题）'),
      category: String(r?.category ?? 'other'),
      status: String(r?.status ?? 'proposed'),
      source: src,
      note: String(r?.note ?? ''),
      createdAt: r?.createdAt ?? null,
      updatedAt: r?.updatedAt ?? null,
      ageDays: ageDaysOf(r?.createdAt, now),
      body: truncated ? body.slice(0, BODY_MAX) : body,
      bodyTruncated: truncated,
      bodyChars: body.length,
      sections,
      sectionMatched: matched,
      evidence,
      sameSourceCount: sourceCount.get(src) ?? 1,
    };
  });

  // 默认序：待批在前、老的在前。队列腐化的第一信号就是「最老的那条多少天」。
  items.sort((a, b) => {
    const rank = (s) => ({ proposed: 0, approved: 1, applied: 2, rejected: 3, wontfix: 4 }[s] ?? 9);
    return rank(a.status) - rank(b.status)
      || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''));
  });

  return {
    state: 'ok',
    reason: null,
    source,
    observedAt,
    storage: watcher,
    repoRoot,
    items,
    counts: summarizeProposals(items, now),
  };
}
