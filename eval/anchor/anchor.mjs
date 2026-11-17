#!/usr/bin/env node
/**
 * eval/anchor/anchor.mjs —— external-anchor 阶段 1 零风险子集
 *
 * `proposals/agint-external-anchor-eval.md` §8 指定的「首个最小动作」：
 *   「只写 anchor.js 纯函数（computeConsistency / groupByKind / splitFalsePosNeg）
 *     + 单测，不挂载、不建域、零运行时影响。可随时丢弃。」
 *
 * ⛔ 本模块零 I/O、零服务访问、零 LLM、不 import 任何插件代码。
 * ⛔ 唯一外部依赖是 `bin/lib/scenario-tier.mjs` 的**纯常量** LABEL_AUTHORITY_VALUES
 *    —— 枚举单一真源，不另造第二套。
 *
 * 三态纪律（与 bin/growth-report.mjs、bin/evolution-evidence.mjs 同口径）：
 *   - 有可用样本  → rate = { value: <数>, ... }
 *   - 无可用样本  → rate = { value: null, reason: '<为什么没有>' }
 *   ⛔ 绝不拿 0 冒充「一致率为零」，也绝不把「字段没采」说成「查过了没有」。
 *
 * 判定纪律（提案 §3.2 不变量 2/3/4）：
 *   只有 GOLD / HELDOUT 且带合法 frozenLabel 的样本能进分母。
 *   SILVER（系统自评）与 UNSET 一律排除 ⇒ 选手不能当裁判，无外部证据记 fail。
 */

import { LABEL_AUTHORITY_VALUES } from '../../bin/lib/scenario-tier.mjs';

/** 可被认定为「外部冻结真值」的标签权限。 */
export const EXTERNAL_LABEL_AUTHORITIES = Object.freeze(['GOLD', 'HELDOUT']);
/** 系统自评标签：可作假设，永不作真值。 */
export const SELF_LABEL_AUTHORITY = 'SILVER';
/** 沿用 regression.js 的口径：一致率下降超 2% 告警。 */
export const REGRESSION_DELTA_THRESHOLD = -0.02;
/** 分组报告的最小样本量，低于此值该组不出一致率。 */
export const DEFAULT_MIN_GROUP_SAMPLES = 3;

/** 该样本能否进入一致率分母。 */
export function isExternalFrozen(sample) {
  if (!sample || typeof sample !== 'object') return false;
  const a = sample.labelAuthority;
  if (!EXTERNAL_LABEL_AUTHORITIES.includes(a)) return false;
  return sample.frozenLabel === 'PASS' || sample.frozenLabel === 'REJECT';
}

/**
 * 提案 §3.3：decision(s) = compositeScore(evaluate(s)) === null ? REJECT : PASS
 * undefined / NaN 同样判 REJECT（安全侧），0 是合法有限分数判 PASS。
 */
export function decisionOf(evaluation) {
  const s = evaluation?.compositeScore;
  if (s === null || s === undefined || (typeof s === 'number' && Number.isNaN(s))) return 'REJECT';
  return 'PASS';
}

/** 按 kind 分组；缺 kind 归入 UNSPECIFIED，不静默丢弃。 */
export function groupByKind(samples) {
  const out = Object.create(null);
  for (const s of samples ?? []) {
    const k = typeof s?.kind === 'string' && s.kind ? s.kind : 'UNSPECIFIED';
    (out[k] ??= []).push(s);
  }
  return out;
}

/**
 * 以 PASS 为正类，把误放与误杀分开统计（提案 §3.3：后果不对称，不许合并）。
 * 只统计可用样本；被排除的样本不构成假阴假阳。
 */
export function splitFalsePosNeg(samples) {
  const usable = (samples ?? []).filter(isExternalFrozen);
  const falsePositive = []; // 判 PASS，真值 REJECT ⇒ 误放
  const falseNegative = []; // 判 REJECT，真值 PASS ⇒ 误杀
  for (const s of usable) {
    const d = decisionOf(s);
    if (d === 'PASS' && s.frozenLabel === 'REJECT') falsePositive.push(s);
    if (d === 'REJECT' && s.frozenLabel === 'PASS') falseNegative.push(s);
  }
  return { falsePositive, falseNegative };
}

/** 三态读数构造器。 */
function rateOrNoData(consistent, usable, reason) {
  return usable > 0
    ? { value: consistent / usable, consistent, usable }
    : { value: null, reason, consistent: 0, usable: 0 };
}

/**
 * 锚定一致率主入口。
 *
 * @param {Array<object>} samples 判定样本
 * @param {{previousRate?: number|null, minGroupSamples?: number}} [options]
 * @returns {{
 *   total: number, usable: number, excluded: object,
 *   rate: {value: number|null, reason?: string, consistent: number, usable: number},
 *   byKind: object, falsePositive: number, falseNegative: number,
 *   regression: {value: boolean|null, reason?: string, delta: number|null},
 *   authorityEnum: readonly string[], verdict: string
 * }}
 */
export function computeConsistency(samples, options = {}) {
  const all = Array.isArray(samples) ? samples : [];
  const minGroup = Number.isFinite(options.minGroupSamples)
    ? options.minGroupSamples : DEFAULT_MIN_GROUP_SAMPLES;

  const excluded = {
    missingObject: 0,
    noAuthorityField: 0,
    unset: 0,
    silver: 0,
    unknownAuthority: 0,
    invalidFrozenLabel: 0,
  };

  const usableSamples = [];
  for (const s of all) {
    if (!s || typeof s !== 'object') { excluded.missingObject++; continue; }
    if (!Object.prototype.hasOwnProperty.call(s, 'labelAuthority')) { excluded.noAuthorityField++; continue; }
    const a = s.labelAuthority;
    if (a === 'UNSET' || a === null || a === undefined || a === '') { excluded.unset++; continue; }
    if (a === SELF_LABEL_AUTHORITY) { excluded.silver++; continue; }
    if (!LABEL_AUTHORITY_VALUES.includes(a)) { excluded.unknownAuthority++; continue; }
    if (!EXTERNAL_LABEL_AUTHORITIES.includes(a)) { excluded.unknownAuthority++; continue; }
    if (s.frozenLabel !== 'PASS' && s.frozenLabel !== 'REJECT') { excluded.invalidFrozenLabel++; continue; }
    usableSamples.push(s);
  }

  const consistent = usableSamples.filter((s) => decisionOf(s) === s.frozenLabel).length;
  const rate = rateOrNoData(
    consistent,
    usableSamples.length,
    'NO_EXTERNAL_FROZEN_LABELS: 无 GOLD/HELDOUT 且带合法 frozenLabel 的样本 ⇒ 一致率无数据（⛔ 不是 0，也不是「判定质量为零」）',
  );

  // 分组：样本不足的组不出一致率，避免用一个样本报 100%。
  const byKind = Object.create(null);
  for (const [kind, rows] of Object.entries(groupByKind(usableSamples))) {
    const c = rows.filter((s) => decisionOf(s) === s.frozenLabel).length;
    byKind[kind] = rows.length < minGroup
      ? { value: null, reason: `INSUFFICIENT_GROUP_SAMPLES: ${kind} 仅 ${rows.length} 条 < ${minGroup} 条，不出组一致率`, consistent: c, usable: rows.length }
      : { value: c / rows.length, consistent: c, usable: rows.length };
  }

  const { falsePositive, falseNegative } = splitFalsePosNeg(usableSamples);

  // 回归探测：只有本期与参照期都有真实读数才可判。
  const prev = options.previousRate;
  let regression;
  if (rate.value === null || prev === null || prev === undefined || !Number.isFinite(prev)) {
    regression = { value: null, reason: 'NO_COMPARABLE_RATE: 本期或参照期一致率无数据 ⇒ 不判回归', delta: null };
  } else {
    const delta = rate.value - prev;
    regression = { value: delta < REGRESSION_DELTA_THRESHOLD, reason: '', delta };
  }

  return {
    total: all.length,
    usable: usableSamples.length,
    excluded,
    rate,
    byKind,
    falsePositive: falsePositive.length,
    falseNegative: falseNegative.length,
    regression,
    authorityEnum: LABEL_AUTHORITY_VALUES,
    verdict: usableSamples.length === 0 ? 'NOT_EVALUATED' : 'EVALUATED',
  };
}
