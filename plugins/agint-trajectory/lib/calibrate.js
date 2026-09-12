/**
 * agint-trajectory/lib/calibrate.js — 标定期（§7bis / 不变量 #5 的切档凭证）。
 *
 * 为什么必须有这一段（老板评审意见 1 + 不变量 #5）：
 *   实测单条轨迹 P95 = 65~224KB，是 tool-stats 单条（954B）的 25~235 倍，
 *   **项目内不存在任何可外推轨迹体积的历史数据**。不标定就开 live 落盘 =
 *   盲记，代价（域膨胀 / prune 误删 / 截断率未知）在写入后才可见。
 *
 * count-only 模式的价值就在这一段：写入路径不执行，但**计数与体积估算照跑**，
 * 于是能产出 P50/P95/日均/截断率四项，作为 setRecordMode('live') 的硬门禁。
 */

import { CalibrationStateSchema, DEFAULTS, computeBudget, dayKey } from './schema.js';

export function createCalibrationState(day = dayKey()) {
  return CalibrationStateSchema.parse({ startedDay: day, byDay: {}, sampleBytes: [], lastReport: null });
}

/** 分位数（线性插值，输入不必排序） */
export function percentile(values, p) {
  const arr = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (arr.length === 0) return 0;
  const idx = (arr.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return arr[lo];
  return Math.round(arr[lo] + (arr[hi] - arr[lo]) * (idx - lo));
}

/**
 * 记一次样本（落盘或 count-only 估算都要调）。
 * @param {Object} state
 * @param {{day?:string, bytes:number}} sample
 * @returns {Object} 新 state（原地改 + 返回，便于持久化）
 */
export function noteSample(state, sample = { bytes: 0, day: dayKey(), truncated: false }) {
  const s = state ?? createCalibrationState();
  const day = sample.day ?? dayKey();
  s.byDay[day] = (s.byDay[day] ?? 0) + 1;
  s.sampleBytes.push(Math.max(0, Math.round(sample.bytes ?? 0)));
  if (sample.truncated === true) s.truncatedSamples = (s.truncatedSamples ?? 0) + 1;
  const cap = DEFAULTS.CALIBRATION_SAMPLES;
  if (s.sampleBytes.length > cap) s.sampleBytes.splice(0, s.sampleBytes.length - cap);
  return s;
}

/**
 * 产出标定期报告。
 * @param {Object} args
 * @param {Object} args.state 标定状态
 * @param {Object} args.counters Counters（提供 total / truncatedCount）
 * @param {number} [args.retentionDays]
 * @param {number} [args.safetyFactor]
 * @param {Date} [args.now]
 * @returns {Object} CalibrationReport（含 ready / missing / suggested）
 */
export function buildReport(args = {}) {
  const state = args.state ?? createCalibrationState();
  const counters = args.counters ?? {};
  const retentionDays = args.retentionDays ?? DEFAULTS.RETENTION_DAYS;
  const safetyFactor = args.safetyFactor ?? DEFAULTS.SAFETY_FACTOR;
  const now = args.now ?? new Date();

  const days = Object.keys(state.byDay ?? {}).length;
  const totalCount = Object.values(state.byDay ?? {}).reduce((a, b) => a + b, 0);
  const perDay = days > 0 ? totalCount / days : 0;
  const samples = (state.sampleBytes ?? []).length;
  const p50 = percentile(state.sampleBytes ?? [], 0.5);
  const p95 = percentile(state.sampleBytes ?? [], 0.95);
  const max = Math.max(0, ...(state.sampleBytes ?? []));
  const total = counters.total ?? 0;
  // 截断率：标定期用估算样本（无真实落盘记录），live 后用真实计数
  const truncated = samples > 0 ? (state.truncatedSamples ?? 0) / samples : (total > 0 ? (counters.truncatedCount ?? 0) / total : 0);
  const truncateRate = Math.round(truncated * 10000) / 10000;

  const missing = [];
  if (!(perDay > 0)) missing.push('perDay(日均落盘条数)');
  if (!(p50 > 0)) missing.push('p50Bytes(单条 P50 体积)');
  if (!(p95 > 0)) missing.push('p95Bytes(单条 P95 体积)');
  if (!(samples > 0)) missing.push('truncateRate(需至少 1 条标定样本)');

  const suggested = computeBudget({ perDay, p95Bytes: p95 }, { retentionDays, safetyFactor });
  const estimatedRetentionBytes = suggested.maxBytes;

  return {
    generatedAt: now.toISOString(),
    fromDay: Object.keys(state.byDay ?? {}).sort()[0] ?? '',
    toDay: Object.keys(state.byDay ?? {}).sort().slice(-1)[0] ?? '',
    days,
    samples,
    perDay: Math.round(perDay * 100) / 100,
    p50Bytes: p50,
    p95Bytes: p95,
    maxBytes: Number.isFinite(max) ? max : 0,
    truncateRate: Math.round(truncateRate * 10000) / 10000,
    estimatedRetentionBytes,
    ready: missing.length === 0 && estimatedRetentionBytes > 0,
    missing,
    suggested,
  };
}
