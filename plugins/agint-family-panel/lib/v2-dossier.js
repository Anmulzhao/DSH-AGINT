/**
 * v2-dossier: 单插件档案（Plugin Dossier）数据层。
 *
 * 为什么单独一个文件：档案要读的东西和「面板聚合」不是一类。
 * 面板聚合读的是**运行时事实**（storages / loader / 代码边）；档案读的是
 * **插件自己写下的东西**（manifest 契约、package 版本、CHANGELOG 变更史、
 * README 存不存在、代码体量）。两类数据的失败模式也不同：storages 可能没开，
 * 而 manifest 可能根本不存在。混在一起写，降级逻辑会互相污染。
 *
 * ── 一个插件可能有**两个物理位置**（本仓真实存在，不是假设） ──
 *
 * 部署位实测：`plugins/agint-quality-eval/manifest.json`（0.3.3，**没有 lib/**）
 * 与 `plugins/agint-quality/agint-quality-eval/`（0.3.5，**有 lib/**，真挂载点）
 * 同时存在。只取一个位置就会说谎：
 *   - 只取顶层壳 → 档案显示「0 行代码」；
 *   - 只取嵌套真身 → 契约面丢失（壳那份 manifest 才是被 patch 看见的）。
 * 所以档案的模型是**汇拢**：每个 id 收全部位置，主位置（有代码者优先）出体量，
 * manifest 从任一位置取并**注明来源**；两处版本不同则进 drift。
 *
 * 三级身份降级（照实标注，不假装完整）：
 *   ① `manifest.json` —— 完整契约面（inject / provides / consumes / permissions / serviceDocs）。
 *   ② `package.json`  —— 只有身份（name / version / description / main）。
 *   ③ 目录本身        —— 只有 id 与代码（agint-session-source 连 package.json 都没有）。
 *
 * 判据纪律（与面板其余部分同一条）：
 * - 读不到就是 `unknown` / `unavailable` + 原因，**不填 0 装绿**。
 * - `drift` 只收**可核对的差异**（版本号不等、文件缺失、声明了没自述、契约与代码分家）。
 *   不做「这个插件写得不好」这类判断 —— 那是神谕层的活，不是档案的活。
 * - 仓库位与部署位的版本对差只在两边都读到 manifest 时才报，且**不判谁对**。
 *
 * @module v2-dossier
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, basename, relative, sep } from 'node:path';
import { codeRoots } from './v2-scan.js';

/** 描述上限：实测最长 2396 字，留一倍余量防未来长文，避免 payload 无界。 */
const DESC_LIMIT = 4000;
/** 变更史取最近几条。 */
const RECENT_CL = 6;
/** 代码体量只列最大的几个文件。 */
const BIG_FILES = 5;
/** 代码遍历深度上限：lib/ 下正常不超过 3 层，超了当异常跳过，不无限递归。 */
const MAX_DEPTH = 4;

const SKIP_SUBDIR = new Set(['node_modules', '.git', '.cache']);

function clip(s, n = 200) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * 读 JSON，区分「文件不存在」与「文件坏了」。
 * ⛔ 两者不能合并：不存在可能是合法的仓库结构（嵌套子包没有 manifest），坏了才是缺陷。
 * @returns {{state:'ok'|'missing'|'broken', value?:object, reason?:string}}
 */
function readJson(p) {
  if (!existsSync(p)) return { state: 'missing' };
  try {
    return { state: 'ok', value: JSON.parse(readFileSync(p, 'utf8')) };
  } catch (e) {
    return { state: 'broken', reason: clip((e && e.message) ?? e, 120) };
  }
}

/**
 * CHANGELOG 版本条目解析。实测本仓的三种标题写法都要能吃：
 *   `## 0.3.0 — 2026-10-22`                        版本 + 破折号 + 日期（日期不是标题）
 *   `## 0.6.7 (2026-09-29) — diffStrategy 从死字段…` 版本 + 括号日期 + 破折号 + 标题
 *   `## 1.0.0 稳定`                                  版本 + 空格 + 标题（无日期）
 * 非版本号的二级标题（`## 变更`）跳过，不伪装成版本。
 * @returns {Array<{version:string,date:string|null,title:string}>}
 */
export function parseChangelog(text) {
  const out = [];
  const re = /^##\s+(.+)$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].trim();
    const head = raw.match(/^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)\s*(.*)$/);
    if (!head) continue;
    const version = head[1];
    let rest = head[2].trim();
    let date = null;
    // ① 括号日期：(2026-09-29) 或 （2026-09-29）
    const br = rest.match(/^[(（]\s*([^)）]+?)\s*[)）]\s*(?:[—–-]{1,2}\s*)?(.*)$/);
    if (br) {
      date = br[1].trim();
      rest = br[2].trim();
    } else {
      // ② 破折号后是纯日期 → 那是日期，不是标题
      const dashDate = rest.match(/^[—–-]{1,2}\s*(\d{4}-\d{2}-\d{2})\s*$/);
      if (dashDate) {
        date = dashDate[1];
        rest = '';
      } else {
        rest = rest.replace(/^[—–-]{1,2}\s*/, '').trim();
      }
    }
    out.push({ version, date, title: rest });
  }
  return out;
}

/** 代码体量：lib/ 下 .js/.mjs 的文件数、总行数、最大几个文件。 */
export function codeStat(libDir) {
  const res = { files: 0, lines: 0, big: [], state: 'ok' };
  if (!existsSync(libDir)) {
    res.state = 'missing';
    return res;
  }
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_SUBDIR.has(e.name)) walk(p, depth + 1);
        continue;
      }
      if (!/\.(js|mjs)$/.test(e.name)) continue;
      let n = 0;
      try { n = readFileSync(p, 'utf8').split('\n').length; } catch { continue; }
      res.files += 1;
      res.lines += n;
      res.big.push({ file: relative(libDir, p).split(sep).join('/'), lines: n });
    }
  };
  walk(libDir, 0);
  res.big.sort((a, b) => b.lines - a.lines);
  res.big = res.big.slice(0, BIG_FILES);
  return res;
}

/**
 * 仓库位同名插件目录的 manifest 版本索引。
 * 键按**相对路径**对齐（嵌套布局两边一致），再用 id 兜底。
 * @returns {Record<string,string>|null} null = 仓库位不可用（不报，不猜）
 */
export function readRepoVersions(repoPluginsDir) {
  if (typeof repoPluginsDir !== 'string' || repoPluginsDir === '') return null;
  const map = Object.create(null);
  const readOne = (abs, key) => {
    const r = readJson(join(abs, 'manifest.json'));
    if (r.state === 'ok' && typeof r.value?.version === 'string') {
      if (key) map[key] = r.value.version;
      const id = basename(abs);
      if (!(id in map)) map[id] = r.value.version;
    }
  };
  try {
    for (const d of readdirSync(repoPluginsDir)) {
      const abs = join(repoPluginsDir, d);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (!st.isDirectory() || d.startsWith('.')) continue;
      readOne(abs, d);
      let subs = [];
      try {
        subs = readdirSync(abs, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
          .map((e) => e.name);
      } catch { /* 权限或竞态：跳过这一层的嵌套 */ }
      for (const s of subs) readOne(join(abs, s), `${d}/${s}`);
    }
    return map;
  } catch {
    return null;
  }
}

/** 单个物理位置的事实（不做判断）。 */
function probeLocation(root, rel) {
  const mRes = readJson(join(root, 'manifest.json'));
  const pRes = readJson(join(root, 'package.json'));
  const hasLib = existsSync(join(root, 'lib'));
  return {
    root, rel, hasLib,
    mRes, pRes,
    m: mRes.state === 'ok' ? mRes.value : null,
    pj: pRes.state === 'ok' ? pRes.value : null,
  };
}

/**
 * 主位置评分：代码真身 > 只有契约的壳 > 只有身份的目录。
 * 同级时 rel 更短者胜（顶层是 patch 的挂载单位，优先）。
 */
function locationScore(L) {
  return (L.hasLib ? 4 : 0) + (L.m ? 2 : 0) + (L.pj ? 1 : 0);
}

/**
 * 采集全部插件档案。
 * @param {object} dirs - resolveV2Dirs 的返回值（用 pluginsDir / repoPluginsDir）
 * @param {object} [opts]
 * @param {Record<string,object>} [opts.kinds] - classifyPlugins 结果（形态 / main / 嵌套子目录）
 * @param {Set<string>|null} [opts.mounted] - patch 里可见的挂载 id；null = 读不到
 * @returns {{state:'ok'|'unavailable', byId:Record<string,object>, order:string[], observedAt:string, reason?:string}}
 */
export function collectDossiers(dirs, opts = {}) {
  const pluginsDir = dirs?.pluginsDir;
  const kinds = opts.kinds ?? {};
  const mounted = opts.mounted ?? null;
  const observedAt = new Date().toISOString();
  if (typeof pluginsDir !== 'string' || !existsSync(pluginsDir)) {
    return { state: 'unavailable', byId: {}, order: [], observedAt, reason: 'pluginsDir 不可解析' };
  }
  const repoVersions = readRepoVersions(dirs.repoPluginsDir) ?? null;

  let topDirs = [];
  try {
    topDirs = readdirSync(pluginsDir)
      .filter((d) => d.startsWith('agint-') && !d.includes('.bak-') && !d.startsWith('.tmp'))
      .filter((d) => { try { return statSync(join(pluginsDir, d)).isDirectory(); } catch { return false; } })
      .sort();
  } catch (e) {
    return { state: 'unavailable', byId: {}, order: [], observedAt, reason: clip((e && e.message) ?? e, 160) };
  }

  // ── ① 枚举全部物理位置，按 id 归组 ────────────────────────────────
  /** @type {Map<string, Array<object>>} */
  const byIdLocs = new Map();
  const addLoc = (id, root) => {
    const rel = relative(pluginsDir, root).split(sep).join('/');
    const list = byIdLocs.get(id) ?? byIdLocs.set(id, []).get(id);
    if (list.some((l) => l.rel === rel)) return; // 同一目录在两条候选链上出现（顶层有 lib 时）
    list.push(probeLocation(root, rel));
  };
  for (const top of topDirs) {
    const topRoot = join(pluginsDir, top);
    addLoc(top, topRoot);                       // 顶层总是候选：它可能是挂载单位 / 聚合容器
    for (const u of codeRoots(topRoot)) addLoc(u.id, u.root); // 嵌套真身（含顶层自身，已去重）
  }

  // ── ② 每 id 出档案 ────────────────────────────────────────────────
  const byId = Object.create(null);
  const order = [];
  for (const [id, locs] of byIdLocs) {
    const sorted = locs.slice().sort((a, b) => locationScore(b) - locationScore(a) || a.rel.length - b.rel.length);
    const primary = sorted[0];
    // 契约来源：主位置优先；主位置没有 manifest 时取其他位置（壳的 manifest 也是事实）。
    const contractLoc = primary.m ? primary : sorted.find((l) => l.m) ?? null;
    const m = contractLoc ? contractLoc.m : null;
    const pkgLoc = primary.pj ? primary : sorted.find((l) => l.pj) ?? null;
    const pj = pkgLoc ? pkgLoc.pj : null;
    const cordis = m?.spec?.cordis ?? m?.cordis ?? {};
    const spec = m?.spec ?? {};
    const layer = m ? 'manifest' : pj ? 'package' : 'dir';
    const root = primary.root;

    const clPath = join(root, 'CHANGELOG.md');
    let cl = { present: false, versions: 0, recent: [] };
    if (existsSync(clPath)) {
      let text = '';
      try { text = readFileSync(clPath, 'utf8'); } catch { text = ''; }
      const items = parseChangelog(text);
      cl = { present: true, versions: items.length, recent: items.slice(0, RECENT_CL) };
    }
    const readmePath = join(root, 'README.md');
    let readme = { present: false, bytes: 0 };
    if (existsSync(readmePath)) {
      let bytes = 0;
      try { bytes = statSync(readmePath).size; } catch { bytes = 0; }
      readme = { present: true, bytes };
    }

    const serviceDocs = m?.spec?.docs?.serviceDocs ?? {};
    const provides = Array.isArray(cordis.provides) ? cordis.provides : [];
    const code = codeStat(join(root, 'lib'));
    const version = (typeof m?.version === 'string' && m.version)
      || (typeof pj?.version === 'string' && pj.version)
      || null;
    const pkgVersion = typeof pj?.version === 'string' && pj.version ? pj.version : null;
    const repoVersion = repoVersions ? (repoVersions[primary.rel] ?? repoVersions[id] ?? null) : null;

    /** 债：只收可核对的差异。level: err / warn / info */
    const drift = [];
    if (!m && !pj) {
      drift.push({ code: 'no-identity', level: 'err', text: '既无 manifest.json 也无 package.json —— 身份与契约为零，只剩代码' });
    } else if (!m) {
      drift.push({ code: 'no-manifest', level: 'warn', text: '无 manifest.json —— 契约面（inject / provides / consumes / permissions）不可得，档案只能列身份与代码' });
    } else if (contractLoc.mRes.state === 'broken') {
      drift.push({ code: 'manifest-broken', level: 'err', text: `manifest.json 解析失败：${contractLoc.mRes.reason}` });
    }
    if (pkgLoc && pkgLoc.pRes.state === 'broken') {
      drift.push({ code: 'package-broken', level: 'err', text: `package.json 解析失败：${pkgLoc.pRes.reason}` });
    }
    if (m && pkgVersion && m.version && m.version !== pkgVersion) {
      drift.push({ code: 'version-split', level: 'warn', text: `manifest ${m.version} ≠ package.json ${pkgVersion}（同一插件两个版本号，谁生效取决于读取方）` });
    }
    if (repoVersion && version && repoVersion !== version) {
      drift.push({ code: 'repo-drift', level: 'warn', text: `仓库位 ${repoVersion} ≠ 部署位 ${version}（只报差异，不判谁对）` });
    }
    // 多位置：同一 id 出现在两个目录
    if (sorted.length > 1) {
      const rels = sorted.map((l) => `${l.rel}${l.m?.version ? `@${l.m.version}` : l.pj?.version ? `@${l.pj.version}` : ''}`);
      const versions = new Set(sorted.map((l) => l.m?.version ?? l.pj?.version).filter(Boolean));
      drift.push({
        code: versions.size > 1 ? 'dup-stale' : 'dup-location',
        level: versions.size > 1 ? 'warn' : 'info',
        text: versions.size > 1
          ? `同一插件有 ${sorted.length} 个物理位置且版本不同：${rels.join(' · ')} —— 读哪份取决于挂载行`
          : `同一插件有 ${sorted.length} 个物理位置：${rels.join(' · ')}`,
      });
    }
    if (contractLoc && contractLoc !== primary) {
      drift.push({ code: 'split-location', level: 'warn', text: `契约（manifest）在 ${contractLoc.rel}，代码在 ${primary.rel} —— 两层不在同一目录` });
    }
    if (!cl.present) drift.push({ code: 'no-changelog', level: 'info', text: '无 CHANGELOG.md —— 变更史不可考' });
    else if (cl.versions === 0) drift.push({ code: 'changelog-empty', level: 'warn', text: 'CHANGELOG.md 存在但没有可解析的版本条目（`## <版本号>` 一行都没有）' });
    if (!readme.present) drift.push({ code: 'no-readme', level: 'info', text: '无 README.md' });
    if (provides.length > 0 && Object.keys(serviceDocs).length === 0) {
      drift.push({ code: 'no-service-docs', level: 'warn', text: `提供 ${provides.length} 个服务，但 manifest 里一条 serviceDocs 都没有 —— 服务名靠读代码才知其意` });
    }
    if (!primary.hasLib) drift.push({ code: 'no-lib', level: 'info', text: '主位置没有 lib/ —— 聚合容器或门面，不是代码单元' });

    byId[id] = {
      id,
      dir: primary.rel.split('/')[0],
      rel: primary.rel,
      nested: primary.rel.includes('/'),
      locations: sorted.map((l) => ({
        rel: l.rel, hasLib: l.hasLib,
        manifestVersion: l.m?.version ?? null,
        pkgVersion: l.pj?.version ?? null,
        role: l === primary ? 'primary' : 'secondary',
      })),
      layer,
      contractSource: contractLoc ? (contractLoc === primary ? 'self' : contractLoc.rel) : null,
      kind: kinds?.[id]?.kind ?? null,
      mounted: mounted === null ? null : mounted.has(id),
      meta: {
        name: m?.name ?? pj?.name ?? id,
        version,
        versionSource: m?.version ? 'manifest' : pkgVersion ? 'package' : null,
        description: clip(m?.description ?? pj?.description ?? '', DESC_LIMIT),
        agintKind: m?.agint?.kind ?? null,
        tier: Number.isInteger(m?.agint?.tier) ? m.agint.tier : null,
        stability: m?.agint?.stability ?? null,
        owner: m?.agint?.owner ?? null,
        compatSince: spec.compatSince ?? null,
        mountOrder: Number.isInteger(spec.mountOrder) ? spec.mountOrder : null,
      },
      contract: m
        ? {
          main: m.main ?? null,
          inject: Array.isArray(cordis.inject) ? cordis.inject : [],
          optionalInject: Array.isArray(cordis.optionalInject) ? cordis.optionalInject : [],
          provides: provides.slice(),
          consumes: Array.isArray(cordis.consumes) ? cordis.consumes : [],
          events: Array.isArray(cordis.events) ? cordis.events : [],
          tools: Array.isArray(cordis.tools) ? cordis.tools : [],
          storageDomains: Array.isArray(spec.storage?.domains) ? spec.storage.domains : [],
          storageSchemaVersion: spec.storage?.schemaVersion ?? null,
          dependencies: spec.dependencies ?? {},
          permissions: spec.permissions ?? null,
          lifecycle: spec.lifecycle ?? null,
          tests: spec.tests ?? null,
          serviceDocs,
          changelogRef: spec.changelog ?? null,
        }
        : null,
      pkg: pj ? { name: pj.name ?? null, version: pkgVersion, main: pj.main ?? null, dependencies: pj.dependencies ?? null } : null,
      code,
      doc: { changelog: cl, readme },
      drift,
    };
    order.push(id);
  }
  order.sort();
  return { state: 'ok', byId, order, observedAt, repoVersions: repoVersions ? Object.keys(repoVersions).length : 0 };
}
