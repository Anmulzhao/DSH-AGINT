/**
 * agint-diagnosis / cluster-aggregator.js
 * 子任务 #5 — substring 聚类（设计稿 §二.5 + 偏差 #5）。
 * aggregateClusters({ failurePatterns, evolution, maxClusters? }) → Cluster[]
 * 性质：纯函数（async），不调真 LLM，不写表，不写 failure_pattern。
 */

import { LIMITS } from './schema.js';

const SUBSTRING_MIN_LEN = 3;
const QUERY_LIMIT = 20;
const DEFAULT_MAX_CLUSTERS = LIMITS.CLUSTERS;
const SAMPLE_MAX = 5;

function tokenizeSubstrings(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) return [];
  return pattern.split(/[\s,;\uFF0C\uFF1B]+/).filter((t) => t.length >= SUBSTRING_MIN_LEN);
}

function sampleIds(failureIds) {
  if (!Array.isArray(failureIds)) return [];
  const seen = new Set();
  const out = [];
  for (const id of failureIds) {
    if (typeof id !== 'string' || id.length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= SAMPLE_MAX) break;
  }
  return out;
}

function idsKey(ids) {
  return [...ids].sort().join('\u0001');
}

async function aggregateClusters({ failurePatterns, evolution, maxClusters } = {}) {
  const cap = (typeof maxClusters === 'number' && maxClusters > 0)
    ? Math.min(Math.floor(maxClusters), DEFAULT_MAX_CLUSTERS)
    : DEFAULT_MAX_CLUSTERS;

  if (!Array.isArray(failurePatterns) || failurePatterns.length === 0) return [];
  if (!evolution || typeof evolution.queryFailures !== 'function') {
    throw new Error('aggregateClusters: evolution service (agint.evolution.queryFailures) 不可用');
  }

  // 1) 候选 substring 集合（去重）
  const substringSet = new Set();
  for (const rec of failurePatterns) {
    if (!rec || typeof rec.pattern !== 'string') continue;
    for (const tok of tokenizeSubstrings(rec.pattern)) substringSet.add(tok);
  }

  // 2) 对每个 substring 反查 → 按"命中 ids 集合"分组（合并去重）
  const groupByKey = new Map();
  for (const substring of substringSet) {
    let matches;
    try { matches = await evolution.queryFailures({ query: substring, limit: QUERY_LIMIT }); }
    catch (_e) { continue; }
    if (!Array.isArray(matches) || matches.length === 0) continue;
    const ids = new Set();
    for (const m of matches) if (m && typeof m.id === 'string') ids.add(m.id);
    if (ids.size === 0) continue;
    const key = idsKey(ids);
    if (!groupByKey.has(key)) groupByKey.set(key, { ids, substrings: [] });
    groupByKey.get(key).substrings.push(substring);
  }

  // 3) 转 FROZEN ClusterSchema：pattern = 最长 substring（并列取字典序前）
  return [...groupByKey.values()]
    .map((g) => ({
      pattern: g.substrings.slice().sort((a, b) => b.length - a.length || a.localeCompare(b))[0],
      count: g.ids.size,
      sampleFailureIds: sampleIds([...g.ids]),
    }))
    .sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern))
    .slice(0, cap);
}

async function collectFailureIdsFromAnnotations(t_annotations) {
  const seen = new Set();
  for (const [, entry] of t_annotations.entries()) {
    if (entry && typeof entry.failureId === 'string' && entry.failureId.length > 0) {
      seen.add(entry.failureId);
    }
  }
  return seen;
}

export {
  aggregateClusters,
  collectFailureIdsFromAnnotations,
  tokenizeSubstrings,
  sampleIds,
  idsKey,
  SUBSTRING_MIN_LEN,
  QUERY_LIMIT,
  DEFAULT_MAX_CLUSTERS,
  SAMPLE_MAX,
};