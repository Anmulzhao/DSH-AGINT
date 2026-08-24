/**
 * agint-diagnosis / report-aggregator.js
 * 子任务 #5 — window-based DiagnosisReport 聚合（设计稿 §二.5 + 验收 §三）。
 * aggregateReport({ annotations, evolution?, windowDays, maxClusters? }) → DiagnosisReport
 * 性质：纯函数（async），不调真 LLM，不写表。
 */

import { LIMITS, ROOT_CAUSE_KINDS, emptyRootCauseDistribution } from './schema.js';
import { aggregateClusters } from './cluster-aggregator.js';

function nowIso() { return new Date().toISOString(); }

/** windowDays 边界：1..365（FROZEN schema.windowDays）。 */
export function isValidWindowDays(windowDays) {
  return Number.isInteger(windowDays) && windowDays >= 1 && windowDays <= 365;
}

/** 按 createdAt 过滤 annotations 到 [now - windowDays, now] 窗口内。 */
function filterByWindow(annotations, windowDays) {
  if (!Array.isArray(annotations)) return [];
  const cutoffMs = Date.now() - windowDays * 86400_000;
  const out = [];
  for (const a of annotations) {
    if (!a || typeof a.createdAt !== 'string') continue;
    const t = Date.parse(a.createdAt);
    if (Number.isNaN(t)) continue;
    if (t >= cutoffMs) out.push(a);
  }
  return out;
}

/** window 内 annotations → 7-key 根因分布。 */
function buildRootCauseDistribution(annotations) {
  const dist = emptyRootCauseDistribution();
  if (!Array.isArray(annotations)) return dist;
  for (const a of annotations) {
    if (!a) continue;
    const k = a.rootCause;
    if (ROOT_CAUSE_KINDS.includes(k)) dist[k] += 1;
  }
  return dist;
}

async function aggregateReport({ annotations, evolution, windowDays, maxClusters } = {}) {
  if (!isValidWindowDays(windowDays)) {
    throw new Error(`aggregateReport: windowDays 必须在 1..365，得到 ${JSON.stringify(windowDays)}`);
  }

  const inWindow = filterByWindow(annotations, windowDays);
  const annotationCount = inWindow.length;
  const rootCauseDistribution = buildRootCauseDistribution(inWindow);

  // cluster 在 report 时聚合（设计稿 §二.5）—— ids 取自 window 内 annotations
  let clusterCount = 0;
  if (evolution && typeof evolution.queryFailures === 'function') {
    const idSet = new Set();
    for (const a of inWindow) {
      if (a && typeof a.failureId === 'string' && !idSet.has(a.failureId)) idSet.add(a.failureId);
    }
    let failurePatterns;
    try { failurePatterns = await evolution.queryFailures({ limit: 1000 }); }
    catch (_e) { failurePatterns = []; }
    const filtered = Array.isArray(failurePatterns)
      ? failurePatterns.filter((rec) => rec && idSet.has(rec.id))
      : [];
    const clusters = await aggregateClusters({ failurePatterns: filtered, evolution, maxClusters });
    clusterCount = clusters.length;
  }

  return {
    windowDays,
    generatedAt: nowIso(),
    annotationCount,
    clusterCount,
    rootCauseDistribution,
  };
}

export {
  aggregateReport,
  filterByWindow,
  buildRootCauseDistribution,
};