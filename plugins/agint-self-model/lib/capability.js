/**
 * lib/capability.js — agint-self-model v0.7.1 能力图谱模块
 *
 * 设计稿 Sprint13 §4.4「能力图谱」+ §4.7（D7 三态 FROZEN + last_verified_at 必填）：
 *   数据源（D6 复用）：evolution-memory success_template / failure_pattern +
 *   diagnosis.annotations 按 domain 聚合。
 *   判定（每次刷新 last_verified_at）：
 *     - CAN      近期成功 ≥ SUCCESS_THRESHOLD 且根因非 ENVIRONMENT
 *     - CANNOT   反复失败 ≥ FAILURE_THRESHOLD 且根因非 ENVIRONMENT
 *     - UNCERTAIN 样本不足 / 证据冲突
 *
 * 定位：只读观察者 —— 只写 agint_self_model.capability_map，不碰任何写路径
 * Service（D2；由 self-model-isolation 静态检查强制）。
 */

import { packCapability, unpackCapability, checkLimit } from './storage.js';
import { nowIso } from './storage.js';

/** 近期成功 ≥ 此值 → 倾向 CAN */
export const SUCCESS_THRESHOLD = 3;
/** 反复失败 ≥ 此值 → 倾向 CANNOT */
export const FAILURE_THRESHOLD = 2;
/** 非环境根因占比 ≥ 此值 → 失败可信（排除 ENVIRONMENT_SHIFT / TOOL_GAP 噪音） */
export const NON_ENV_ROOT_CAUSE_RATIO = 0.5;

/**
 * 纯函数：根据聚合证据判定能力状态（FROZEN 三态）。
 * @param {{recentSuccess:number, recentFailure:number, nonEnvRootCauseRatio:number}} evidence
 * @returns {'CAN'|'CANNOT'|'UNCERTAIN'}
 */
export function classifyStatus(evidence) {
  const recentSuccess = Math.max(0, evidence?.recentSuccess ?? 0);
  const recentFailure = Math.max(0, evidence?.recentFailure ?? 0);
  const ratio = Number.isFinite(evidence?.nonEnvRootCauseRatio) ? evidence.nonEnvRootCauseRatio : 0;
  const samples = recentSuccess + recentFailure;
  if (samples < 1) return 'UNCERTAIN';
  // 反复失败且根因可信 → 不能
  if (recentFailure >= FAILURE_THRESHOLD && ratio >= NON_ENV_ROOT_CAUSE_RATIO) {
    return 'CANNOT';
  }
  // 近期成功充足 → 能
  if (recentSuccess >= SUCCESS_THRESHOLD && recentFailure < FAILURE_THRESHOLD) {
    return 'CAN';
  }
  return 'UNCERTAIN';
}

/**
 * 由聚合证据推导单条能力图谱 entry（FROZEN 7 字段）。
 * @returns {object} CapabilityEntry（业务字段，未含 storage metadata）
 */
export function buildCapabilityEntry({ domain, capability, evidence, now }) {
  const status = classifyStatus(evidence);
  const total = (evidence?.recentSuccess ?? 0) + (evidence?.recentFailure ?? 0);
  // confidence：成功占比，但 UNCERTAIN 时压低（诚实暴露不确定）
  const successRatio = total > 0 ? (evidence?.recentSuccess ?? 0) / total : 0;
  const confidence = status === 'UNCERTAIN'
    ? Math.min(0.4, successRatio)
    : Math.max(0.5, successRatio);
  const verifiedAt = now ?? nowIso();
  return {
    domain,
    capability,
    status,
    confidence: Number(confidence.toFixed(3)),
    evidenceRefs: evidence?.evidenceRefs ?? [],
    lastVerifiedAt: verifiedAt,
    updatedAt: verifiedAt,
  };
}

/**
 * 把聚合好的 domains 写入 capability_map（upsert by `${domain}:${capability}`）。
 * @param {object} store openStore 返回值
 * @param {Array<{domain:string, capability:string, evidence:object}>} aggregated
 * @param {{now?:string}} [opts]
 * @returns {Promise<string[]>} 状态发生变化的域（changedDomains，用于 A11）
 */
export async function recomputeCapabilities(store, aggregated, opts = {}) {
  const { capabilityMap } = store.tables;
  // 读旧状态用于 diff（changedDomains 判定）
  const prevById = new Map();
  for (const [, rec] of capabilityMap.entries()) {
    prevById.set(`${rec.domain}:${rec.capability}`, rec.status);
  }
  const changedDomains = [];
  const seen = new Set();
  for (const agg of aggregated) {
    const entry = buildCapabilityEntry(agg);
    const id = `${entry.domain}:${entry.capability}`;
    seen.add(id);
    const packed = packCapability(entry);
    await capabilityMap.put(id, packed);
    const prev = prevById.get(id);
    if (prev === undefined || prev !== entry.status) {
      if (!changedDomains.includes(entry.domain)) changedDomains.push(entry.domain);
    }
  }
  // 超限 warn（不抛、不 prune）
  try {
    const size = await capabilityMap.size();
    const warn = checkLimit('capability_map', size);
    if (warn) console.warn(`[agint-self-model] capability_map ${warn._warn}`);
  }
  catch { /* ignore */ }
  return changedDomains;
}

/**
 * 读取 capability_map 全量（剥回 FROZEN 业务字段）。
 */
export async function readCapabilities(store) {
  const out = [];
  for (const [, rec] of store.tables.capabilityMap.entries()) {
    out.push(unpackCapability(rec));
  }
  return out;
}
