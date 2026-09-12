/**
 * agint-skill-graph: 查询层（P2-2 §4.1 FROZEN Service 的纯函数内核 + §六 recommend）。
 *
 * 不变量（§4.3）：
 *   3. 不进决策 —— 本模块只读，输出不修改 policy / HARM / evolution 任何路径。
 *   6. 零数据必须"响" —— `edges === 0` 或 `coverage === 0` 时 health 必须 `EMPTY`，
 *      recommend 必须 `INSUFFICIENT_DATA`；**禁止**用兜底/合成数据让图谱"看起来有内容"。
 */

import { tokenize } from '../../agint-curator/lib/dedup.js';
import {
  DEFAULT_WEIGHTS,
  INSUFFICIENT_COVERAGE_RATIO,
  STALE_AFTER_DAYS,
  normalizeWeights,
} from './schema.js';

const DAY_MS = 86_400_000;

// ── coverage / health ────────────────────────────────────────────────────

/**
 * §3.1 coverage + §12.5 开放问题 6：同时暴露 `nodesWithEdges` 与 `nodesWithUsage`
 * 两个分母（"全收 11 节点"是有意选择，故两个分母都要看得见）。
 */
export function computeCoverage(usageList, edges, nodeCount) {
  const nodes = nodeCount ?? usageList?.length ?? 0;
  const withEdges = new Set();
  for (const e of edges ?? []) { withEdges.add(e.src); withEdges.add(e.dst); }
  const nodesWithEdges = [...withEdges].filter((n) => n).length;
  const nodesWithUsage = (usageList ?? []).filter((u) => (u.calls ?? 0) > 0).length;
  return {
    nodes,
    nodesWithEdges,
    nodesWithUsage,
    ratio: nodes ? +(nodesWithEdges / nodes).toFixed(4) : 0,
    usageRatio: nodes ? +(nodesWithUsage / nodes).toFixed(4) : 0,
  };
}

/** §4.1 status 语义 + §九「零数据诚实」 */
export function computeHealth(edges, coverage) {
  const edgesCount = (edges ?? []).length;
  if (edgesCount === 0 || (coverage?.ratio ?? 0) === 0) return 'EMPTY';
  if ((coverage?.ratio ?? 0) < INSUFFICIENT_COVERAGE_RATIO) return 'SPARSE';
  return 'OK';
}

/** §六 降级链 3：图数据 14 天未刷新 → stale 警告 */
export function isStale(lastFullScanAt, nowMs = Date.now()) {
  if (!lastFullScanAt) return true;
  const t = Date.parse(lastFullScanAt);
  if (!Number.isFinite(t)) return true;
  return nowMs - t > STALE_AFTER_DAYS * DAY_MS;
}

// ── neighbors ────────────────────────────────────────────────────────────

/**
 * @returns {Array} 邻居边（按 weight 降序）
 */
export function neighbors(edges, skillName, opts = {}) {
  if (!skillName) return [];
  const { type, minWeight = 0, types } = opts;
  const want = types ? new Set(types) : (type ? new Set([type]) : null);
  return (edges ?? [])
    .filter((e) => (e.src === skillName || e.dst === skillName))
    .filter((e) => (want ? want.has(e.type) : true))
    .filter((e) => (e.weight ?? 0) >= minWeight)
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || String(a.edgeId).localeCompare(String(b.edgeId)));
}

// ── clusters（连通分量，内存并查集）──────────────────────────────────────

/**
 * ⚠️ 与 Hermes 的偏离（§〇ter 第 6 条已登记）：Hermes 的 `clusters` 只是
 * `Counter(node.category)`（按分类计数），**不是连通分量**。P2-2 保留连通分量
 * 是有意的——`related` 声明边天然构成"该一起看"的技能簇，对整合候选有直接价值。
 *
 * @param {string} opts.type  ⚠️ FROZEN 默认 `'overlap'`；但 v0.3 起 `related` 才是首选边，
 *   故实际取"真实关系簇"时应显式传 `type:'related'`（或用 `types:['related','overlap']`）。
 */
export function clusters(edges, opts = {}) {
  const type = opts.type ?? 'overlap';
  const minSize = opts.minSize ?? 2;
  const want = opts.types ? new Set(opts.types) : new Set([type]);
  const subset = (edges ?? []).filter((e) => want.has(e.type));

  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const nx = parent.get(x); parent.set(x, r); x = nx; }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const e of subset) union(e.src, e.dst);

  const groups = new Map();
  for (const e of subset) {
    const root = find(e.src);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(e);
  }

  const out = [];
  for (const [root, groupEdges] of groups) {
    const members = [...new Set(groupEdges.flatMap((e) => [e.src, e.dst]))].sort();
    if (members.length < minSize) continue;
    out.push({
      clusterId: `cluster_${want.has('overlap') ? type : [...want].sort().join('+')}_${root}`,
      members,
      // §九 M4：结果必须带证据 → 簇的证据 = 簇内每条边的证据（可审计）
      evidence: groupEdges
        .sort((a, b) => String(a.edgeId).localeCompare(String(b.edgeId)))
        .map((e) => ({ edgeId: e.edgeId, type: e.type, weight: e.weight, evidence: e.evidence })),
    });
  }
  return out.sort((a, b) => b.members.length - a.members.length || String(a.clusterId).localeCompare(String(b.clusterId)));
}

// ── recommend（§六：主方案返回列表不打分；备选纯 intentMatch 排序）──────

function intentTokens(intent) {
  const t = typeof intent === 'string' ? intent : (Array.isArray(intent) ? intent.join(' ') : '');
  return tokenize(t);
}

/** intent 与技能（name + description + triggers）的词法命中率 */
export function intentMatch(intent, node) {
  const want = intentTokens(intent);
  if (want.size === 0) return 0;
  const have = tokenize(`${node?.skillName ?? ''} ${node?.description ?? ''} ${(node?.triggers ?? []).join(' ')}`);
  let hit = 0;
  for (const t of want) if (have.has(t)) hit++;
  return +(hit / want.size).toFixed(4);
}

function recencyBoost(lastUsedAt, halfLifeDays, nowMs) {
  if (!lastUsedAt) return 0;
  const t = Date.parse(lastUsedAt);
  if (!Number.isFinite(t)) return 0;
  const ageDays = Math.max(0, (nowMs - t) / DAY_MS);
  return +Math.pow(0.5, ageDays / halfLifeDays).toFixed(4);
}

/**
 * @param {object} args { intent, context: { usedSkills?: string[] } }
 * @param {object} data { nodes, usageList, edges, weights, lastFullScanAt, mode, nowMs, halfLifeDays }
 */
export function recommend(args = {}, data = {}) {
  const { nodes = [], usageList = [], edges = [], lastFullScanAt = null, nowMs = Date.now() } = data;
  const weightsInput = data.weights ?? DEFAULT_WEIGHTS;
  const { weights, fallback } = normalizeWeights(weightsInput);
  const halfLifeDays = Number(data.halfLifeDays) > 0 ? Number(data.halfLifeDays) : 14;

  const usageByName = new Map((usageList ?? []).map((u) => [u.skillName, u]));
  const coverage = computeCoverage(usageList, edges, nodes.length);
  const health = computeHealth(edges, coverage);
  // §4.1：INSUFFICIENT_DATA = nodesWithEdges/nodes < 0.3 **或** edges === 0
  const insufficient = (edges ?? []).length === 0 || coverage.ratio < INSUFFICIENT_COVERAGE_RATIO;
  const stale = isStale(lastFullScanAt, nowMs);

  const usedReady = new Set(args?.context?.usedSkills ?? []);
  const unavailable = [];
  if ((edges ?? []).length === 0) unavailable.push('neighborBoost(edges=0)');
  if (!(usageList ?? []).some((u) => u.successRate != null)) unavailable.push('successRate(no-data)');

  const items = [];
  for (const node of nodes) {
    const match = intentMatch(args?.intent, node);
    const usage = usageByName.get(node.skillName) ?? null;
    let neighbor = 0;
    if (usedReady.size) {
      for (const e of neighbors(edges, node.skillName, { types: ['related', 'overlap', 'co_use'] })) {
        const other = e.src === node.skillName ? e.dst : e.src;
        if (usedReady.has(other)) neighbor = Math.max(neighbor, e.weight ?? 0);
      }
    }
    const sr = usage?.successRate ?? null;
    const srTerm = sr == null ? 0 : sr;
    const recency = recencyBoost(usage?.lastUsedAt ?? null, halfLifeDays, nowMs);
    const score = +(weights.intentMatch * match
      + weights.neighborBoost * neighbor
      + weights.successRate * srTerm
      + weights.recency * recency).toFixed(4);

    items.push({
      skillName: node.skillName,
      description: node.description ?? '',
      score,
      // reason 必须可解释（§3.1「每条边都要能回答你为什么」的推荐侧同源要求）
      reason: `intent=${match.toFixed(2)} neighbor=${neighbor.toFixed(2)} `
        + `successRate=${sr == null ? 'null(数据不足)' : sr.toFixed(2)} recency=${recency.toFixed(2)}`,
      terms: { intentMatch: match, neighborBoost: neighbor, successRate: sr, recency },
      related: neighbors(edges, node.skillName, { types: ['related'] }).map((e) => (e.src === node.skillName ? e.dst : e.src)),
    });
  }

  // §六主方案：`recommendMode='list'`（默认）返回列表不打分，排序/选择交给调用方
  const mode = data.mode ?? 'list';
  if (mode === 'list') {
    items.sort((a, b) => (b.terms.intentMatch - a.terms.intentMatch) || a.skillName.localeCompare(b.skillName));
    for (const it of items) delete it.score;
  } else {
    items.sort((a, b) => b.score - a.score || a.skillName.localeCompare(b.skillName));
  }

  return {
    items,
    status: insufficient ? 'INSUFFICIENT_DATA' : 'OK',
    degraded: insufficient,                      // §4.1：该状态下 items 仍返回纯 intentMatch 降级列表
    degradedReason: insufficient
      ? `edges=${(edges ?? []).length} coverage=${coverage.ratio}`
      : null,
    health,
    stale,
    weights,
    weightFallback: fallback,
    unavailableTerms: unavailable,
    coverage,
  };
}
