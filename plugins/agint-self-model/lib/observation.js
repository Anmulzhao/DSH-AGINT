/**
 * lib/observation.js — agint-self-model v0.7.1 推理画像 + 资源感知模块
 *
 * 设计稿 Sprint13 §4.4「推理模式画像」「资源感知」（均走 D6 复用既有 Service）：
 *   - 推理画像：diagnosis 根因分布 + REASONING_ERROR 特征计数
 *   - 资源感知：metrics snapshot + tool-stats 调用时长/token 分布（p50/p90）
 *
 * 诚实边界（设计稿 §十.2 / §十.3）：资源感知不含系统级测量，只统计工具调用
 * 时长 / token / 上下文占用；「认知偏见」首版只做频次统计，不做因果归因。
 *
 * 定位：只读观察者 —— 只写 agint_self_model 两张观测表，不碰任何写路径。
 */

import { packReasoning, packResource, unpackReasoning, unpackResource, checkLimit, nowIso } from './storage.js';

/**
 * 纯函数：由 diagnosis 根因分布推导推理画像 entries。
 * @param {Object<string, number>} distribution 7 类根因计数（缺省补 0）
 * @returns {Array<{aspect,key,count,recentEvidence}>}
 */
export function buildReasoningProfile(distribution = {}) {
  const dist = distribution && typeof distribution === 'object' ? distribution : {};
  const get = (k) => Number.isFinite(dist[k]) ? dist[k] : 0;
  const entries = [];

  // error-condition：可信 6 类根因逐一成行（自指/矛盾/consistency=false 特征复用 REASONING_ERROR）
  for (const rc of ['REASONING_ERROR', 'PLANNING_FAILURE', 'PROMPT_DEFICIENCY', 'TOOL_GAP', 'KNOWLEDGE_GAP', 'ENVIRONMENT_SHIFT']) {
    const c = get(rc);
    if (c > 0) entries.push({ aspect: 'error-condition', key: rc, count: c, recentEvidence: `rootCause=${rc} count=${c}` });
  }
  // chain-break：规划失败单独成行（断裂点模式）
  const planning = get('PLANNING_FAILURE');
  if (planning > 0) entries.push({ aspect: 'chain-break', key: 'planning-failure', count: planning, recentEvidence: 'PLANNING_FAILURE' });
  // bias：知识缺口成行（认知偏见频次统计）
  const kg = get('KNOWLEDGE_GAP');
  if (kg > 0) entries.push({ aspect: 'bias', key: 'knowledge-gap', count: kg, recentEvidence: 'KNOWLEDGE_GAP' });
  // strategy-preference：由反思闭环密度推导（annotation vs cluster 比例越高 = 越依赖结构化反思）
  const ann = get('REASONING_ERROR') + get('PLANNING_FAILURE');
  if (ann > 0) {
    entries.push({
      aspect: 'strategy-preference',
      key: 'reflection-loop',
      count: ann,
      recentEvidence: 'reasoning/planning failures → structured self-reflection',
    });
  }
  return entries;
}

/**
 * 纯函数：由 tool-stats 摘要 + metrics snapshot 推导资源基线 entries。
 * @param {Array} toolSummary tool_stats_summary 的 summary 数组（{tool, calls, avgMs, p95Ms, ...}）
 * @param {object} [metricsSnapshot] agint.metrics.snapshot() 返回值 { asOf, count, metrics[] }
 * @returns {Array<{metric,p50,p90,sampleCount,window}>}
 */
export function buildResourceBaseline(toolSummary = [], metricsSnapshot = null) {
  const out = [];
  const arr = Array.isArray(toolSummary) ? toolSummary : [];
  // tool-cost-ms / tool-cost-token：聚合所有工具调用
  const totalCalls = arr.reduce((s, t) => s + (t?.calls ?? 0), 0);
  if (totalCalls > 0) {
    // 以加权平均近似 p50/p90（诚实：首版无完整分布，用 avg/p95 近似）
    let wSumMs = 0, wSumP95 = 0;
    for (const t of arr) {
      const w = t?.calls ?? 0;
      wSumMs += (t?.avgMs ?? 0) * w;
      wSumP95 += (t?.p95Ms ?? 0) * w;
    }
    const p50 = Number((wSumMs / totalCalls).toFixed(1));
    const p90 = Number((wSumP95 / totalCalls).toFixed(1));
    out.push({ metric: 'tool-cost-ms', p50, p90, sampleCount: totalCalls, window: '7d' });
  }
  // latency-ms：来自 metrics snapshot 中匹配 latency 的 key（软降级→0）
  try {
    const metrics = metricsSnapshot?.metrics ?? [];
    const lat = metrics.find((m) => typeof m?.key === 'string' && /latency/i.test(m.key));
    if (lat && typeof lat.value === 'number') {
      out.push({ metric: 'latency-ms', p50: lat.value, p90: lat.value, sampleCount: 1, window: '7d' });
    }
  }
  catch { /* ignore */ }
  // knowledge-cutoff：静态标注（诚实暴露，非测量）
  out.push({ metric: 'knowledge-cutoff', p50: 0, p90: 0, sampleCount: 0, window: 'static' });
  return out;
}

/**
 * 重算推理画像 + 资源基线，写入 store（观测表 upsert；先清后写，observer 语义）。
 * @param {object} store openStore 返回值
 * @param {object} deps 数据来源访问器（见 lib/index.js buildDeps）
 * @param {{now?:string}} [opts]
 * @returns {Promise<{reasoningCount:number, resourceCount:number}>}
 */
export async function recomputeObservation(store, deps, opts = {}) {
  const now = opts.now ?? nowIso();

  // 1) 推理画像（diagnosis 根因分布，软降级）
  let distribution = {};
  try {
    const diagnosis = deps.get('agint.diagnosis');
    if (diagnosis && typeof diagnosis.report === 'function') {
      const rep = await diagnosis.report({ windowDays: 28 });
      distribution = rep?.rootCauseDistribution ?? {};
    }
  }
  catch { distribution = {}; }
  const reasoning = buildReasoningProfile(distribution);

  // 2) 资源基线（tool-stats + metrics，软降级）
  let toolSummary = [];
  let metricsSnapshot = null;
  try {
    const ts = deps.get('agint.toolStats');
    if (ts && typeof ts.summary === 'function') toolSummary = (await ts.summary({ since: '7d' }))?.summary ?? [];
  }
  catch { toolSummary = []; }
  try {
    const metrics = deps.get('agint.metrics');
    if (metrics && typeof metrics.snapshot === 'function') metricsSnapshot = await metrics.snapshot();
  }
  catch { metricsSnapshot = null; }
  const resource = buildResourceBaseline(toolSummary, metricsSnapshot);

  // 3) 写入（观测表先清后写）
  const { reasoningProfile, resourceBaseline } = store.tables;
  try { await reasoningProfile.clear(); } catch { /* ignore */ }
  try { await resourceBaseline.clear(); } catch { /* ignore */ }
  for (const r of reasoning) await reasoningProfile.put(`${r.aspect}:${r.key}`, packReasoning({ ...r, createdAt: now }));
  for (const r of resource) await resourceBaseline.put(r.metric, packResource({ ...r, createdAt: now }));

  // 超限 warn（不抛、不 prune）
  try {
    const wr = checkLimit('reasoning_profile', reasoning.length);
    if (wr) console.warn(`[agint-self-model] reasoning_profile ${wr._warn}`);
    const ws = checkLimit('resource_baseline', resource.length);
    if (ws) console.warn(`[agint-self-model] resource_baseline ${ws._warn}`);
  }
  catch { /* ignore */ }

  return { reasoningCount: reasoning.length, resourceCount: resource.length };
}

/** 读取 reasoning_profile（剥回业务字段） */
export async function readReasoningProfile(store) {
  const out = [];
  for (const [, rec] of store.tables.reasoningProfile.entries()) out.push(unpackReasoning(rec));
  return out;
}

/** 读取 resource_baseline（剥回业务字段） */
export async function readResourceBaseline(store) {
  const out = [];
  for (const [, rec] of store.tables.resourceBaseline.entries()) out.push(unpackResource(rec));
  return out;
}
