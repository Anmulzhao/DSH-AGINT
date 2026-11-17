#!/usr/bin/env node
/**
 * bin/oracle-calibration-replay.mjs —— B2 判尺离线回放护栏（只读）
 *
 * 2026-11-07 老板选「实现功能但守住闸门」：B2 的**计算部分**（参数化扣分、
 * 候选规格回放、跨尺度分段判据）在此全部可用，但**落参数这一步永不自动发生**。
 *
 * ⛔ 只读：不写 humanVerdict / humanOverall、不改 scoring.js、
 *    不改 THRESHOLDS / DIM_WEIGHTS / SCALE_SPEC / scaleHash、不写 storages。
 *    writes 恒 0、applied 恒 false。
 * ⛔ 不自制尺：参数化扣分必须与生产 dimDeduction 在当前参数下逐值对拍
 *    （selfCheckAgainstProduction），漂移即判 DEDUCTION_DRIFT 拒绝回放。
 * ⛔ 三态纪律：0 标注是查过的真 0；无样本是 { value:null, reason }；
 *    跨 scaleHash 的分数 Δ 一律标「不可比」，绝不解读成「进化变好/变差」。
 * ⛔ 拟合门槛沿用 test/calibration.mjs 的口径：阈值 ≥4 周、权重 ≥5 周。
 *    并列最优多组时不挑一个当答案；unidentifiable 的维度不许硬拟合。
 *
 * 用法：
 *   node bin/oracle-calibration-replay.mjs --json
 *   node bin/oracle-calibration-replay.mjs --samples <weeks.json> --candidate <spec.json> --json
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SCALE_SPEC, DIM_KEYS, dimDeduction, FORMULA_VERSION, scaleHash, stableStringify,
} from '../plugins/agint-aesthetic-oracle/lib/scoring.js';
import { FIT_GATES } from './evolution-evidence.mjs';

export const REPLAY_SCHEMA = '1.0';
const PROBES = Object.freeze([0, 0.005, 0.02, 0.05, 0.1, 0.3, 0.5, 0.7, 0.9, 1, 1.5, 2.5, 4, 10]);

function tri(value, reason = '', sampleSize = null) {
  return { value, reason, sampleSize };
}

/** 判尺指纹：与生产 scaleHash 同一算法（sha1 + 稳定序列化，纯计算）。 */
export function specHash(spec) {
  return createHash('sha1').update(stableStringify(spec)).digest('hex').slice(0, 8);
}

/**
 * 参数化扣分。与 test/calibration.mjs 的 deduction() 同形，
 * 且必须与 scoring.js 的 dimDeduction() 在当前参数下逐值相等。
 */
export function paramDeduction(key, value, spec) {
  const T = spec?.thresholds;
  const W = spec?.weights;
  if (!T || !W) return null;
  switch (key) {
    case 'noise': return W.noise * Math.min(value / T.NOISE_RATIO, 1);
    case 'confidence': return W.confidence * Math.max((T.CONFIDENCE - value) / T.CONFIDENCE, 0);
    case 'redundancy': return W.redundancy * Math.min(value / T.REDUNDANCY, 1);
    case 'bloat': return W.bloat * Math.min(Math.max(0, value - 1), T.BLOAT_SATURATION);
    default: return null;
  }
}

/** 按可用维度权重归一回 100 分制（与 computeAestheticScore 同口径）。 */
export function scoreWithSpec(composites, spec) {
  let sumDed = 0;
  let sumMaxW = 0;
  for (const key of DIM_KEYS) {
    const c = composites?.[key];
    if (!c || c.na || typeof c.value !== 'number' || !Number.isFinite(c.value)) continue;
    const d = paramDeduction(key, c.value, spec);
    if (d === null || !Number.isFinite(d)) continue;
    sumDed += d;
    sumMaxW += spec.weights[key] ?? 0;
  }
  if (sumMaxW === 0) return null;
  return 100 - sumDed * (100 / sumMaxW);
}

/** ⛔ 防「自制尺校原尺」：当前参数下必须与生产纯函数逐值一致。 */
export function selfCheckAgainstProduction(currentSpec = SCALE_SPEC) {
  const mismatches = [];
  let checked = 0;
  for (const key of DIM_KEYS) {
    for (const v of PROBES) {
      const mine = paramDeduction(key, v, currentSpec);
      const prod = dimDeduction(key, v);
      checked += 1;
      if (mine === null || prod === null || Math.abs(mine - prod) > 1e-12) {
        mismatches.push({ key, value: v, mine, prod });
      }
    }
  }
  return { ok: mismatches.length === 0, checked, mismatches, scaleHashMatches: specHash(currentSpec) === scaleHash };
}

export function validateCandidateSpec(spec) {
  if (!spec || typeof spec !== 'object') return '候选规格不是对象';
  if (!spec.thresholds || !spec.weights) return '缺 thresholds / weights';
  for (const k of DIM_KEYS) {
    if (!Number.isFinite(spec.weights[k]) || spec.weights[k] <= 0) return `weights.${k} 非法`;
  }
  for (const k of ['NOISE_RATIO', 'CONFIDENCE', 'REDUNDANCY', 'BLOAT_SATURATION']) {
    if (!Number.isFinite(spec.thresholds[k]) || spec.thresholds[k] <= 0) return `thresholds.${k} 非法`;
  }
  return null;
}

/** 从周样本派生标注读数；无样本时三态返回「没测过」，不拿 0 冒充。 */
export function deriveAnnotation(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    const r = 'NO_SAMPLES: 未注入周样本 ⇒ 不能说「0 标注」，只能说没测过';
    return {
      independentWeeks: tri(null, r),
      annotatedVerdictWeeks: tri(null, r),
      annotatedOverallWeeks: tri(null, r),
      seenDimensions: tri(null, r),
    };
  }
  const weeks = new Set(samples.map((s) => s?.week).filter(Boolean));
  const vWeeks = new Set(samples.filter((s) => s?.humanVerdict !== null && s?.humanVerdict !== undefined
    && s?.humanVerdict !== '').map((s) => s.week).filter(Boolean));
  const oWeeks = new Set(samples.filter((s) => s?.humanOverall === 'better' || s?.humanOverall === 'worse')
    .map((s) => s.week).filter(Boolean));
  const seen = [...new Set(samples.map((s) => s?.humanVerdict)
    .filter((d) => DIM_KEYS.includes(d)))];
  return {
    independentWeeks: tri(weeks.size, '', samples.length),
    annotatedVerdictWeeks: tri(vWeeks.size, '', weeks.size),
    annotatedOverallWeeks: tri(oWeeks.size, '', weeks.size),
    seenDimensions: tri(seen, '', samples.length),
  };
}

/**
 * 主入口：离线回放一份候选判尺，**绝不落参数**。
 * @param {{samples?:Array, candidateSpec?:object|null, currentSpec?:object,
 *          annotation?:object}} input
 */
export function buildReplay({
  samples = [],
  candidateSpec = null,
  currentSpec = SCALE_SPEC,
  annotation = null,
} = {}) {
  const ann = annotation ?? deriveAnnotation(samples);
  const selfCheck = selfCheckAgainstProduction(currentSpec);
  const hashBefore = specHash(currentSpec);
  const candidateErr = candidateSpec ? validateCandidateSpec(candidateSpec) : 'NO_CANDIDATE_SPEC: 未注入候选规格';
  const hashAfter = candidateSpec && !candidateErr ? specHash(candidateSpec) : null;

  const unidentifiable = ann.seenDimensions.value === null
    ? tri(null, ann.seenDimensions.reason)
    : tri(DIM_KEYS.filter((d) => !ann.seenDimensions.value.includes(d)), '', DIM_KEYS.length);

  // 回放：只在候选规格合法、公式自检通过、且有周样本时才出数。
  let replay;
  if (!selfCheck.ok) replay = tri(null, 'DEDUCTION_DRIFT: 参数化扣分与生产纯函数漂移，禁止回放');
  else if (candidateErr) replay = tri(null, candidateErr);
  else if (!Array.isArray(samples) || samples.length === 0) replay = tri(null, 'NO_SAMPLES: 无周样本可回放');
  else {
    replay = tri(samples.map((s) => {
      const before = scoreWithSpec(s.composites, currentSpec);
      const after = scoreWithSpec(s.composites, candidateSpec);
      return {
        week: s.week,
        before,
        after,
        delta: before === null || after === null ? null : after - before,
        // ⛔ 跨尺度恒不可比：delta 只是「同一份原子值用两把尺算出来差多少」，
        //    不是「系统变好/变差」，更不是能力结论。
        comparable: false,
      };
    }), '', samples.length);
  }

  const comparable = tri(false,
    hashAfter === null
      ? 'NO_CANDIDATE_SPEC: 无候选规格 ⇒ 无跨尺度可比性可言'
      : hashAfter === hashBefore
        ? '同指纹（参数未变）；Δ 仍只反映口径差异，不构成进化判定'
        : `跨尺度：${hashBefore} → ${hashAfter} ⇒ 历史分数必须分段，Δ 不得解读为进化方向`,
    hashAfter === null ? null : 2);

  const gates = {
    thresholdsGate: ann.annotatedVerdictWeeks.value === null
      ? tri(null, ann.annotatedVerdictWeeks.reason)
      : tri(ann.annotatedVerdictWeeks.value >= FIT_GATES.thresholds, '', ann.annotatedVerdictWeeks.value),
    weightsGate: ann.annotatedOverallWeeks.value === null
      ? tri(null, ann.annotatedOverallWeeks.reason)
      : tri(ann.annotatedOverallWeeks.value >= FIT_GATES.weights, '', ann.annotatedOverallWeeks.value),
  };

  let verdict;
  if (!selfCheck.ok) verdict = 'DEDUCTION_DRIFT';
  else if (gates.thresholdsGate.value === null || gates.weightsGate.value === null) verdict = 'ANNOTATION_UNKNOWN';
  else if (!gates.thresholdsGate.value || !gates.weightsGate.value) verdict = 'INSUFFICIENT_ANNOTATIONS';
  else if (unidentifiable.value === null || unidentifiable.value.length > 0) verdict = 'UNIDENTIFIABLE_DIMENSIONS';
  else if (candidateErr) verdict = 'REPLAY_ONLY_NO_CANDIDATE';
  else verdict = 'REPLAY_READY_FOR_HUMAN_REVIEW';

  return {
    schemaVersion: REPLAY_SCHEMA,
    formulaVersion: FORMULA_VERSION,
    annotation: ann,
    gates,
    fitGates: { thresholds: FIT_GATES.thresholds, weights: FIT_GATES.weights },
    unidentifiable,
    selfCheck,
    currentSpecHash: hashBefore,
    candidateSpecHash: hashAfter === null ? tri(null, candidateErr) : tri(hashAfter, '', 1),
    comparable,
    replay,
    verdict,
    // ⛔ 恒定值：这一层永远不落参数，人类复核是唯一放行口。
    writes: 0,
    applied: false,
    parametersWritten: [],
    requiresHumanReview: true,
    noAutoApply: true,
    disclaimer: '本模块只做离线回放与完整性自检，不拟合结论、不写人工标注、不改任何评分常量；'
      + '跨 scaleHash 的分数不可直接比较，Δ 不是进化判定。落参数须人工复核后另行决定。',
  };
}

function parseArgs(argv) {
  const o = { json: false, samples: null, candidate: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') o.json = true;
    else if (argv[i] === '--samples') o.samples = argv[++i] ?? null;
    else if (argv[i] === '--candidate') o.candidate = argv[++i] ?? null;
    else throw new Error(`未知参数：${argv[i]}`);
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const samples = o.samples ? JSON.parse(readFileSync(o.samples, 'utf8')) : [];
  const candidateSpec = o.candidate ? JSON.parse(readFileSync(o.candidate, 'utf8')) : null;
  const r = buildReplay({ samples, candidateSpec });
  if (o.json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else {
    process.stdout.write('B2 判尺离线回放护栏 · 只读\n');
    process.stdout.write(`  判词：${r.verdict} ｜ 写入 ${r.writes} 条 ｜ applied=${r.applied}\n`);
    process.stdout.write(`  公式自检：${r.selfCheck.ok ? 'OK' : 'DRIFT'}（${r.selfCheck.checked} 组对拍，指纹一致=${r.selfCheck.scaleHashMatches}）\n`);
    process.stdout.write(`  判尺指纹：${r.currentSpecHash} → ${r.candidateSpecHash.value ?? '无数据'} ｜ 可比=${r.comparable.value}\n`);
    process.stdout.write(`  标注：verdict=${r.annotation.annotatedVerdictWeeks.value ?? '无数据'} 周 / overall=${r.annotation.annotatedOverallWeeks.value ?? '无数据'} 周（门槛 ${r.fitGates.thresholds}/${r.fitGates.weights}）\n`);
    process.stdout.write(`  回放：${r.replay.value === null ? `无数据 — ${r.replay.reason}` : `${r.replay.value.length} 周`}\n`);
    process.stdout.write(`  ⛔ ${r.disclaimer}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
