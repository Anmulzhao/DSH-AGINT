#!/usr/bin/env node
/**
 * bin/oracle-judge-channel.mjs —— C2 独立会话 judge 通道（notes-only 契约）
 *
 * 2026-11-07 老板选「实现功能但守住闸门」：judge 信封、独立会话校验、
 * 「不进评分链路」的机器可验契约在此全部可用；但**不调 LLM、不建 preset、
 * 不写 notes** —— 独立 preset / 会话与 D1–D5 拍板仍未齐备。
 *
 * ⛔ 纯函数：零 I/O、零服务访问、零 LLM 调用、不挂 cordis、不写 storages。
 *    writes 恒 0、llmCalls 恒 0；notes 的写入须由调用方显式注入 sink。
 * ⛔ verdict 只当假设（hypothesisOnly=true）：不得进 METRIC_DEFS / 指标存储 /
 *    四维计算 / aesthetic_score / Q1·Q2 / 阈值 / 权重 / scaleHash（§9.5）。
 * ⛔ 自评不算裁判：独立 preset 与独立会话是硬前置；同一 agent 自评一律拒收。
 * ⛔ 判定权仍归外部冻结真值与授权人工，本通道不产出结论。
 *
 * 用法：
 *   node bin/oracle-judge-channel.mjs           # 只读契约与现状
 *   node bin/oracle-judge-channel.mjs --json
 */

import { fileURLToPath } from 'node:url';

export const JUDGE_SCHEMA = '1.0';
export const NOTES_ONLY_SINKS = Object.freeze(['notes']);
export const JUDGE_VERDICTS = Object.freeze(['pass', 'reject', 'abstain']);

/** 母 preset 与四个子 preset 都算「同一个 agent 自评」，不允许当 judge 会话。 */
export const SELF_PRESET_IDS = Object.freeze([
  'agint', 'agint-zgs', 'agint-blockchain', 'agint-investor', 'agint-ops',
]);

/** ⛔ 评分链路的一切落点；信封里出现任一即判越界。 */
export const FORBIDDEN_JUDGE_TARGETS = Object.freeze([
  'METRIC_DEFS', 'metricDefs', 'metricsStore', 'metrics_store', 'composites',
  'aesthetic_score', 'aestheticScore', 'score', 'scoreDelta', 'q1', 'q2', 'q3',
  'THRESHOLDS', 'DIM_WEIGHTS', 'SCALE_SPEC', 'scaleHash', 'FORMULA_VERSION',
  'thresholds', 'weights', 'noise', 'confidence', 'redundancy', 'bloat',
  'humanVerdict', 'humanOverall', 'label', 'labelAuthority',
]);

function fail(reason, extra = {}) {
  return { ok: false, reason, writes: 0, ...extra };
}

/** 递归找评分链路字段（深度 4，够覆盖信封形状）。 */
export function findScoringFields(obj, prefix = '', depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return [];
  const found = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (FORBIDDEN_JUDGE_TARGETS.includes(k)) found.push(path);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      found.push(...findScoringFields(v, path, depth + 1));
    }
  }
  return [...new Set(found)];
}

/**
 * 把一次独立 judge 的 verdict 收进 notes-only 信封。**不写任何东西**。
 * @param {{session?:object, verdict?:string, evidence?:string, asOf?:string}} input
 */
export function wrapJudgeVerdict(input = {}) {
  const bad = findScoringFields(input);
  if (bad.length) {
    return fail(`SCORING_FIELD_PRESENT: judge 输入混入评分链路字段 ${bad.join(', ')} ⇒ §9.5 越界`, { violations: bad });
  }

  const s = input.session && typeof input.session === 'object' ? input.session : {};
  if (typeof s.presetId !== 'string' || !s.presetId.trim()) return fail('PRESET_ID_MISSING');
  if (SELF_PRESET_IDS.includes(s.presetId)) {
    return fail(`PRESET_NOT_INDEPENDENT: ${s.presetId} 是被评估系统自身的 preset ⇒ 自评不能当裁判`);
  }
  if (typeof s.sessionId !== 'string' || !s.sessionId.trim()) return fail('SESSION_ID_MISSING');
  if (!JUDGE_VERDICTS.includes(input.verdict)) {
    return fail(`VERDICT_INVALID: ${JSON.stringify(input.verdict)} 不在 ${JUDGE_VERDICTS.join('/')}`);
  }
  if (typeof input.evidence !== 'string' || !input.evidence.trim()) return fail('EVIDENCE_MISSING');

  return {
    ok: true,
    reason: 'ENVELOPE_BUILT: 仅构造 notes-only 假设信封，未写入 notes、未调用 LLM',
    writes: 0,
    llmCalls: 0,
    envelope: Object.freeze({
      schemaVersion: JUDGE_SCHEMA,
      scope: 'notes-only',
      allowedSinks: NOTES_ONLY_SINKS,
      hypothesisOnly: true,
      session: Object.freeze({ presetId: s.presetId, sessionId: s.sessionId, independent: true }),
      verdict: input.verdict,
      evidence: input.evidence,
      asOf: input.asOf ?? null,
      prohibitedTargets: FORBIDDEN_JUDGE_TARGETS,
    }),
  };
}

/** 机器可验的「不进评分链路」断言：任何一条不满足即判越界。 */
export function assertNotesOnly(envelope) {
  const violations = [];
  if (!envelope || typeof envelope !== 'object') return { ok: false, violations: ['ENVELOPE_MISSING'] };
  if (envelope.scope !== 'notes-only') violations.push(`scope=${JSON.stringify(envelope.scope)}`);
  if (envelope.hypothesisOnly !== true) violations.push('hypothesisOnly !== true');
  if (!Array.isArray(envelope.allowedSinks)
    || envelope.allowedSinks.length !== 1
    || envelope.allowedSinks[0] !== NOTES_ONLY_SINKS[0]) {
    violations.push(`allowedSinks=${JSON.stringify(envelope.allowedSinks)}`);
  }
  violations.push(...findScoringFields({
    session: envelope.session,
    verdict: envelope.verdict,
    evidence: envelope.evidence,
    asOf: envelope.asOf,
  }));
  return { ok: violations.length === 0, violations: [...new Set(violations)] };
}

/**
 * 通道就绪度（只读）：现状四项硬前置全不满足 ⇒ BLOCKED 是设计结果。
 * @param {{frozenLabels?:number|null, d1d5Approved?:boolean,
 *          independentPresetReady?:boolean, notesOnlyContractWired?:boolean}} status
 */
export function evaluateJudgeChannel(status = {}) {
  const s = status && typeof status === 'object' ? status : {};
  const blockers = [];
  if (s.frozenLabels === null || s.frozenLabels === undefined) {
    blockers.push('EXTERNAL_TRUTH_UNKNOWN: 冻结标签读数缺失，不能当成「有真值」也不能当成 0');
  } else if (s.frozenLabels <= 0) {
    blockers.push('NO_FROZEN_LABELS: 0 条外部冻结真值 ⇒ judge 没有可对照的金标，自评只能当假设生成器');
  }
  if (s.d1d5Approved !== true) blockers.push('D1_D5_NOT_APPROVED: C1 阶段 2/3 的 D1–D5 尚未拍板');
  if (s.independentPresetReady !== true) blockers.push('NO_INDEPENDENT_PRESET: 独立 preset / 独立会话尚未建立');
  if (s.notesOnlyContractWired !== true) blockers.push('NOTES_ONLY_NOT_WIRED: notes-only 写入契约尚未接线');

  return {
    schemaVersion: JUDGE_SCHEMA,
    ready: blockers.length === 0,
    status: blockers.length === 0 ? 'READY' : 'BLOCKED',
    blockers,
    writes: 0,
    llmCalls: 0,
    verdictScope: 'notes-only',
    disclaimer: '即使通道 READY，verdict 也只当假设，不得进评分链路；最终判定归外部冻结真值与授权人工。'
      + ' BLOCKED 是设计结果，不是故障。',
  };
}

function main() {
  const json = process.argv.slice(2).includes('--json');
  const channel = evaluateJudgeChannel({ frozenLabels: 0 });
  const sample = wrapJudgeVerdict({
    session: { presetId: 'judge-independent-example', sessionId: 'contract-probe' },
    verdict: 'abstain',
    evidence: '契约探针，不是真实 judge 输出',
  });
  const out = {
    ...channel,
    envelopeContract: sample.ok ? assertNotesOnly(sample.envelope) : { ok: false, violations: [sample.reason] },
    note: '⛔ 本 CLI 不调用 LLM、不建 preset、不写 notes；示例信封只用于验证契约。',
  };
  if (json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  else {
    process.stdout.write('C2 独立会话 judge 通道 · 只读契约\n');
    process.stdout.write(`  通道：${channel.status} ｜ 写入 ${channel.writes} 条 ｜ LLM 调用 ${channel.llmCalls} 次\n`);
    for (const b of channel.blockers) process.stdout.write(`  x ${b}\n`);
    process.stdout.write(`  信封契约自检：${out.envelopeContract.ok ? 'OK（notes-only / hypothesisOnly / 零评分字段）' : `FAIL ${out.envelopeContract.violations.join(', ')}`}\n`);
    process.stdout.write(`  ${out.note}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
