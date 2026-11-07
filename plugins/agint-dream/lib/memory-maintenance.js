/**
 * agint-dream 记忆维护三件套（阶段 2，2026-11-07）。
 *
 * 定位：dreaming 的「写之后」阶段。现有 sweep 解决「从会话提取并提升」；
 * 本模块解决「已提升的记忆证据还成不成立、该不该进预加载、衰减池健康不健康」。
 *
 * ⛔ 三条硬边界：
 *  1. 纯函数：不写盘、不改 memory、不改注入层文件。只产出结构化报告。
 *  2. 不冒充语义真伪（K117 / K138）：只判「证据在不在、路径还存不存在」。
 *     ⛔ 不拿文本相似度当「这条记忆是错的」的证据 —— 那是假判据。
 *  3. 0 动作必须自解释（55d8eb24 的教训）：没有候选时给 reason 与「离门槛
 *     最近的一条差多少」，否则「维护跑过了」和「维护没对象」长一样。
 */

import { existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

export const MAINTENANCE_DEFAULTS = Object.freeze({
  minConfidence: 0.8,
  minRecalls: 3,
  maxPreload: 10,
  maxBrokenSamples: 10,
});

const L1 = 'L1';

// 只认**仓库根相对**路径。绝对路径（盘符开头）与通配符不参与存在性判定。
// ⛔ 刻意不含 test/ lib/ src/：记忆里的 `test/smoke.mjs` 是**插件内**相对路径
//    （plugins/agint-dream/test/smoke.mjs），从仓库根解析必然不存在。
//    2026-11-07 实测：含这三个前缀时 12 条「断链」里 8 条是这个假阳性。
//    宁可少判（记为 noPaths），也不造假警报 —— 假警报会训练人忽略这条。
const PATH_RE =
  /(?:^|[^\w/])((?:docs|bin|plugins|presets|install|eval|wiki)\/[\w./@*-]+\.(?:md|mjs|js|json|yml|yaml|sh|ts|txt))/g;

function finite(v, d = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

function levelOf(e) {
  return e?.level ?? L1;
}

/** evidence 可能是字符串、数组或对象。抽出其中的仓库相对路径（去重、去通配符）。 */
export function extractEvidencePaths(evidence) {
  if (evidence == null) return [];
  const raw = typeof evidence === 'string' ? evidence : JSON.stringify(evidence);
  const out = new Set();
  for (const m of raw.matchAll(PATH_RE)) {
    const p = m[1].replace(/[.,;:]+$/, '');
    if (p.includes('*') || p.includes('<')) continue;
    out.add(p);
  }
  return [...out];
}

/**
 * 证据审计：只判「有没有证据、证据引用的路径还在不在」。
 * 不判内容真假。断链只标记，不改写、不删除。
 *
 * @param {Array} entries  memory 行（agint.memory.list 的形状）
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]  仓库根；缺省时所有路径类证据记为 unverifiable
 * @param {(abs:string)=>boolean} [opts.exists]  注入用，默认 fs.existsSync
 */
export function auditMemoryEvidence(entries, opts = {}) {
  const {
    repoRoot = null,
    exists = existsSync,
    maxBrokenSamples = MAINTENANCE_DEFAULTS.maxBrokenSamples,
  } = opts;
  const list = Array.isArray(entries) ? entries : [];
  let noEvidence = 0;
  let noPaths = 0;
  let unverifiable = 0;
  let ok = 0;
  const broken = [];

  for (const e of list) {
    const raw = e?.evidence;
    const empty = raw == null || (typeof raw === 'string' && raw.trim() === '');
    if (empty) {
      noEvidence += 1;
      continue;
    }
    const paths = extractEvidencePaths(raw);
    if (paths.length === 0) {
      noPaths += 1;
      continue;
    }
    if (!repoRoot) {
      unverifiable += 1;
      continue;
    }
    let brokenPath = null;
    for (const p of paths) {
      const abs = isAbsolute(p) ? p : join(repoRoot, p);
      if (!exists(abs)) {
        brokenPath = p;
        break;
      }
    }
    if (brokenPath) {
      broken.push({ id: e?.id ?? null, path: brokenPath });
    } else {
      ok += 1;
    }
  }

  return {
    considered: list.length,
    noEvidence,
    noPaths,
    unverifiable,
    ok,
    brokenCount: broken.length,
    broken: broken.slice(0, maxBrokenSamples),
    reason:
      list.length === 0
        ? 'pool-empty'
        : !repoRoot
          ? 'repo-root-missing'
          : broken.length === 0
            ? 'no-broken-evidence'
            : null,
  };
}

/**
 * 预加载候选：哪些记忆值得进「每会话注入层」。
 * 门槛 = L1 + 未解决 + confidence ≥ minConfidence + recalls ≥ minRecalls。
 *
 * ⚠️ 当前生产 recalls 全为 0（2026-11-07 实测 869/869）⇒ 本函数会返回空，
 * 并带 recallsAllZero=true。那不是「没有候选」，是「召回计数没在记」。
 */
export function selectPreloadCandidates(entries, opts = {}) {
  const {
    minConfidence = MAINTENANCE_DEFAULTS.minConfidence,
    minRecalls = MAINTENANCE_DEFAULTS.minRecalls,
    maxPreload = MAINTENANCE_DEFAULTS.maxPreload,
  } = opts;
  const list = Array.isArray(entries) ? entries : [];
  const eligible = [];
  let recallsAllZero = list.length > 0;

  for (const e of list) {
    const c = finite(e?.confidence);
    const r = finite(e?.recalls);
    if (r > 0) recallsAllZero = false;
    if (e?.resolved === true) continue;
    if (levelOf(e) !== L1) continue;
    if (c < minConfidence) continue;
    if (r < minRecalls) continue;
    eligible.push({
      id: e?.id ?? null,
      kind: e?.type ?? null,
      confidence: c,
      recalls: r,
      score: +(c * 0.6 + Math.min(r / 10, 1) * 0.4).toFixed(4),
    });
  }

  eligible.sort((a, b) => b.score - a.score);
  const picked = eligible.slice(0, maxPreload);

  let nearest = null;
  if (picked.length === 0 && list.length > 0) {
    const sorted = [...list].sort((a, b) => finite(b?.confidence) - finite(a?.confidence));
    const n = sorted[0];
    nearest = {
      id: n?.id ?? null,
      confidence: finite(n?.confidence),
      recalls: finite(n?.recalls),
      missingConfidence: +Math.max(0, minConfidence - finite(n?.confidence)).toFixed(3),
      missingRecalls: Math.max(0, minRecalls - finite(n?.recalls)),
    };
  }

  return {
    considered: list.length,
    eligible: eligible.length,
    picked: picked.length,
    candidates: picked,
    nearest,
    recallsAllZero,
    reason:
      picked.length > 0
        ? null
        : recallsAllZero
          ? 'recalls-all-zero: 召回计数没在记，门槛不可能达成'
          : 'no-entry-meets-threshold',
  };
}

/** 衰减池体检：分布 + 三条红旗。不改任何行。 */
export function summarizeDecay(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const levels = {};
  const types = {};
  let resolved = 0;
  let defaultConfidence = 0;
  let recallsAllZero = list.length > 0;
  let oldestCreatedAt = null;

  for (const e of list) {
    const lv = levelOf(e);
    levels[lv] = (levels[lv] ?? 0) + 1;
    const t = e?.type ?? 'unknown';
    types[t] = (types[t] ?? 0) + 1;
    if (e?.resolved === true) resolved += 1;
    if (finite(e?.confidence, -1) === 0.5) defaultConfidence += 1;
    if (finite(e?.recalls) > 0) recallsAllZero = false;
    const c = e?.createdAt;
    if (typeof c === 'string' && (oldestCreatedAt === null || c < oldestCreatedAt)) oldestCreatedAt = c;
  }

  const total = list.length;
  return {
    total,
    levels,
    types,
    resolved,
    resolvedShare: total ? +(resolved / total).toFixed(3) : 0,
    defaultConfidence,
    defaultConfidenceShare: total ? +(defaultConfidence / total).toFixed(3) : 0,
    oldestCreatedAt,
    flags: {
      recallsAllZero,
      nothingResolved: total > 0 && resolved === 0,
      defaultConfidenceMajority: total > 0 && defaultConfidence / total > 0.5,
    },
  };
}

/**
 * 汇总报告。三项都跑，任何一项为空也返回结构（不返回 null）。
 * @param {Array} entries
 * @param {object} [opts]  repoRoot / exists / minConfidence / minRecalls / maxPreload / nowMs
 */
export function buildMaintenanceReport(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const nowMs = finite(opts.nowMs, Date.now());
  const evidence = auditMemoryEvidence(list, opts);
  const preload = selectPreloadCandidates(list, opts);
  const decay = summarizeDecay(list);
  return {
    ok: true,
    generatedAt: new Date(nowMs).toISOString(),
    considered: list.length,
    evidence,
    preload,
    decay,
  };
}

/** 把报告压成一行摘要，供 diary / lastResultSummary 使用。 */
export function summarizeMaintenance(report) {
  if (!report) return null;
  return {
    pool: report.decay?.total ?? 0,
    evidenceBroken: report.evidence?.brokenCount ?? 0,
    noEvidence: report.evidence?.noEvidence ?? 0,
    preloadPicked: report.preload?.picked ?? 0,
    preloadReason: report.preload?.reason ?? null,
    recallsAllZero: report.decay?.flags?.recallsAllZero ?? null,
  };
}
