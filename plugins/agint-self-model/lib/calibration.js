/**
 * lib/calibration.js — agint-self-model v0.7.1 校准误差护栏模块
 *
 * 设计稿 Sprint13 §4.6（校准误差护栏 ≤10%）：
 *   - 公式：按能力域聚合 error = |mean(predicted) − mean(actual)|，滚动窗口默认 28 天
 *   - cold-start 守门：域内样本 < 10 → 该域 UNCERTAIN，不计误差（对齐 diagnosis counterfactual）
 *   - 任一域误差 > 10% → ① 写 failure_pattern（tag=self-model-miscalibration）
 *                         ② 周复盘告警 ③ 触发该域能力图谱全量重评估
 *   - 校准结果同步导出指标 selfModel.calibrationError（A10 模式延续）
 *
 * 定位：只读观察者 —— 只写 agint_self_model.calibration_log；miscalibration
 * 告警写 evolution.failure_pattern 是「只读标注」，不改 HARM 权重（D2）。
 */

import { packCalibration, checkLimit, nowIso } from './storage.js';
import { CALIBRATION_ERROR_THRESHOLD, COLD_START_SAMPLES } from './schema.js';

/**
 * 纯函数：由每域 {domain, predicted, actual, samples} 计算校准结果。
 * @param {Array<{domain:string, predicted:number, actual:number, samples:number}>} domains
 * @returns {Array<{domain,predicted,actual,error,samples,_coldStart,_miscalibrated}>}
 */
export function computeCalibration(domains = []) {
  return (Array.isArray(domains) ? domains : []).map((d) => {
    const predicted = Number.isFinite(d.predicted) ? d.predicted : 0;
    const actual = Number.isFinite(d.actual) ? d.actual : 0;
    const error = Math.abs(predicted - actual);
    const samples = Number.isFinite(d.samples) ? d.samples : 0;
    const coldStart = samples < COLD_START_SAMPLES;
    const miscalibrated = !coldStart && error > CALIBRATION_ERROR_THRESHOLD;
    return {
      domain: d.domain,
      predicted,
      actual,
      error: Number(error.toFixed(4)),
      samples,
      _coldStart: coldStart,
      _miscalibrated: miscalibrated,
    };
  });
}

/**
 * 跑一次全量校准（编排）：
 *   - getDomains() 返回每域实测 {domain, actual, samples}
 *   - getPriorPredicted(domain) 返回历史预测（缺省从 calibration_log 取最新）
 *   - writeFailure(domain, error) 可选，miscalibration 时写 evolution 标注
 *
 * @returns {Promise<{results: Array<CalibrationResult>, miscalibrated: string[]}>}
 */
export async function runCalibration({ store, getDomains, getPriorPredicted, writeFailure, now } = {}) {
  const nowVal = now ?? nowIso();
  const domains = (typeof getDomains === 'function') ? await getDomains() : [];
  // 历史预测（calibration_log 最新一条 per domain）
  const prior = new Map();
  try {
    for (const [, rec] of store.tables.calibrationLog.entries()) {
      prior.set(rec.domain, rec.predicted); // entries 顺序：后写覆盖
    }
  }
  catch { /* ignore */ }
  const inputs = (Array.isArray(domains) ? domains : []).map((d) => {
    const priorPredicted = (typeof getPriorPredicted === 'function')
      ? (getPriorPredicted(d.domain) ?? prior.get(d.domain) ?? 0)
      : (prior.get(d.domain) ?? 0);
    return { domain: d.domain, predicted: priorPredicted, actual: d.actual ?? 0, samples: d.samples ?? 0 };
  });
  const computed = computeCalibration(inputs);
  const miscalibrated = [];
  for (const c of computed) {
    const packed = packCalibration({
      calibratedAt: nowVal,
      trigger: 'weekly',
      domain: c.domain,
      predicted: c.predicted,
      actual: c.actual,
      error: c.error,
      samples: c.samples,
    });
    try { await store.tables.calibrationLog.put(packed.id, packed); } catch { /* ignore */ }
    if (c._miscalibrated) {
      miscalibrated.push(c.domain);
      try { await writeFailure?.(c.domain, c.error); } catch { /* ignore */ }
    }
  }
  // 超限 warn（不抛、不 prune）
  try {
    const size = await store.tables.calibrationLog.size();
    const warn = checkLimit('calibration_log', size);
    if (warn) console.warn(`[agint-self-model] calibration_log ${warn._warn}`);
  }
  catch { /* ignore */ }
  const results = computed.map(({ _coldStart, _miscalibrated, ...rest }) => rest);
  return { results, miscalibrated };
}

/**
 * 从 calibration_log 汇总校准摘要（供 SelfModelSnapshot.calibrationSummary）。
 * @returns {Promise<{domains:number, maxError:number, miscalibrated:string[]}>}
 */
export async function summarizeCalibration(store) {
  const latest = new Map();
  try {
    for (const [, rec] of store.tables.calibrationLog.entries()) {
      const cur = latest.get(rec.domain);
      if (!cur || rec.calibratedAt > cur.calibratedAt) latest.set(rec.domain, rec);
    }
  }
  catch { /* ignore */ }
  const miscalibrated = [];
  let maxError = 0;
  for (const rec of latest.values()) {
    const coldStart = rec.samples < COLD_START_SAMPLES;
    if (!coldStart && rec.error > maxError) maxError = rec.error;
    if (!coldStart && rec.error > CALIBRATION_ERROR_THRESHOLD) miscalibrated.push(rec.domain);
  }
  return { domains: latest.size, maxError: Number(maxError.toFixed(4)), miscalibrated };
}

/** 读取 calibration_log 全量（剥回业务字段） */
export async function readCalibrationLog(store) {
  const out = [];
  for (const [, rec] of store.tables.calibrationLog.entries()) {
    out.push({
      domain: rec.domain, predicted: rec.predicted, actual: rec.actual,
      error: rec.error, samples: rec.samples, calibratedAt: rec.calibratedAt,
    });
  }
  return out;
}
