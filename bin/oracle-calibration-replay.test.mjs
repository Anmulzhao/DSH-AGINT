/**
 * bin/oracle-calibration-replay.test.mjs —— B2 离线回放护栏的阴性对照
 *
 * ⛔ 核心判据：无论回放结果多「好看」，applied 恒 false、writes 恒 0；
 *    三态不拿 0 冒充没测过；跨 scaleHash 的 Δ 恒标不可比；
 *    参数化扣分必须与生产纯函数逐值一致，漂移即拒绝回放。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCALE_SPEC, scaleHash, computeAestheticScore,
} from '../plugins/agint-aesthetic-oracle/lib/scoring.js';
import {
  REPLAY_SCHEMA, specHash, paramDeduction, scoreWithSpec,
  selfCheckAgainstProduction, validateCandidateSpec, deriveAnnotation, buildReplay,
} from './oracle-calibration-replay.mjs';

function composites() {
  return {
    noise: { value: 0.12 },
    confidence: { value: 0.82 },
    redundancy: { value: 0.02 },
    bloat: { value: 1.10 },
  };
}

/** 满足全部拟合门槛的合成样本（仅供阳性对照，不是生产数据）。 */
function fullSamples(verdictDims = ['noise', 'confidence', 'redundancy', 'bloat']) {
  return Array.from({ length: 6 }, (_, i) => ({
    week: `2026-W${40 + i}`,
    composites: composites(),
    humanVerdict: verdictDims[i % verdictDims.length],
    humanOverall: i % 2 ? 'better' : 'worse',
  }));
}

function candidateSpec() {
  return { ...SCALE_SPEC, weights: { ...SCALE_SPEC.weights, noise: 35 } };
}

test('✅ 公式自检：56 组参数化扣分与生产纯函数逐值一致，且指纹相同', () => {
  const s = selfCheckAgainstProduction();
  assert.equal(s.ok, true, JSON.stringify(s.mismatches));
  assert.equal(s.checked, 56);
  assert.equal(s.scaleHashMatches, true);
  assert.equal(specHash(SCALE_SPEC), scaleHash);
  assert.equal(scaleHash, 'f4f5c879');
});

test('✅ scoreWithSpec 与 computeAestheticScore 同口径', () => {
  const c = composites();
  assert.equal(scoreWithSpec(c, SCALE_SPEC), computeAestheticScore(c).score);
  assert.equal(scoreWithSpec({ noise: { value: 0.3 } }, SCALE_SPEC), computeAestheticScore({ noise: { value: 0.3 } }).score);
  assert.equal(scoreWithSpec({}, SCALE_SPEC), null, '全维缺失 ⇒ null，不编 0');
  assert.equal(paramDeduction('unknown', 1, SCALE_SPEC), null);
});

test('⛔ 默认路径：零写入、不落参数、必须人工复核', () => {
  const r = buildReplay();
  assert.equal(r.schemaVersion, REPLAY_SCHEMA);
  assert.equal(r.writes, 0);
  assert.equal(r.applied, false);
  assert.deepEqual(r.parametersWritten, []);
  assert.equal(r.requiresHumanReview, true);
  assert.equal(r.noAutoApply, true);
  assert.equal(r.verdict, 'ANNOTATION_UNKNOWN');
});

test('⛔ 无样本 ⇒ 三态 null，绝不说「0 标注」', () => {
  const ann = deriveAnnotation([]);
  assert.equal(ann.annotatedVerdictWeeks.value, null);
  assert.match(ann.annotatedVerdictWeeks.reason, /NO_SAMPLES/);
  const r = buildReplay({ samples: [] });
  assert.equal(r.verdict, 'ANNOTATION_UNKNOWN');
  assert.equal(r.replay.value, null);
  assert.match(r.replay.reason, /NO_SAMPLES|NO_CANDIDATE_SPEC/);
});

test('⛔ 6 周 0 标注是查过的真 0 ⇒ INSUFFICIENT_ANNOTATIONS', () => {
  const samples = fullSamples().map((s) => ({ ...s, humanVerdict: null, humanOverall: null }));
  const r = buildReplay({ samples });
  assert.equal(r.annotation.independentWeeks.value, 6);
  assert.equal(r.annotation.annotatedVerdictWeeks.value, 0);
  assert.equal(r.annotation.annotatedOverallWeeks.value, 0);
  assert.equal(r.annotation.annotatedVerdictWeeks.reason, '');
  assert.equal(r.gates.thresholdsGate.value, false);
  assert.equal(r.verdict, 'INSUFFICIENT_ANNOTATIONS');
  assert.equal(r.writes, 0);
});

test('⛔ 门槛够但 redundancy/bloat 从未被人工判过 ⇒ UNIDENTIFIABLE_DIMENSIONS', () => {
  const samples = fullSamples(['noise', 'confidence']);
  const r = buildReplay({ samples, candidateSpec: candidateSpec() });
  assert.equal(r.gates.thresholdsGate.value, true);
  assert.equal(r.gates.weightsGate.value, true);
  assert.deepEqual(r.unidentifiable.value, ['redundancy', 'bloat']);
  assert.equal(r.verdict, 'UNIDENTIFIABLE_DIMENSIONS');
  assert.equal(r.applied, false);
});

test('✅ 注入候选规格可回放，但跨尺度 Δ 恒标不可比', () => {
  const r = buildReplay({ samples: fullSamples(), candidateSpec: candidateSpec() });
  assert.equal(r.selfCheck.ok, true);
  assert.notEqual(r.candidateSpecHash.value, r.currentSpecHash);
  assert.equal(r.comparable.value, false);
  assert.match(r.comparable.reason, /历史分数必须分段/);
  assert.equal(r.replay.value.length, 6);
  for (const row of r.replay.value) {
    assert.equal(row.comparable, false);
    assert.equal(typeof row.before, 'number');
    assert.equal(typeof row.after, 'number');
  }
});

test('⛔ 即使回放 READY_FOR_HUMAN_REVIEW，也绝不自动落参数', () => {
  const r = buildReplay({ samples: fullSamples(), candidateSpec: candidateSpec() });
  assert.equal(r.verdict, 'REPLAY_READY_FOR_HUMAN_REVIEW');
  assert.equal(r.applied, false);
  assert.equal(r.writes, 0);
  assert.equal(r.requiresHumanReview, true, '人工复核是唯一放行口');
});

test('⛔ 参数化扣分漂移 ⇒ DEDUCTION_DRIFT，拒绝回放', () => {
  const drifted = { ...SCALE_SPEC, weights: { ...SCALE_SPEC.weights, noise: 999 } };
  const r = buildReplay({ samples: fullSamples(), candidateSpec: candidateSpec(), currentSpec: drifted });
  assert.equal(r.selfCheck.ok, false);
  assert.equal(r.verdict, 'DEDUCTION_DRIFT');
  assert.equal(r.replay.value, null);
  assert.equal(r.writes, 0);
});

test('⛔ 候选规格非法 ⇒ 不回放、不出指纹', () => {
  assert.match(validateCandidateSpec(null), /不是对象/);
  assert.match(validateCandidateSpec({ weights: SCALE_SPEC.weights }), /缺 thresholds/);
  const bad = { ...SCALE_SPEC, weights: { ...SCALE_SPEC.weights, bloat: 0 } };
  assert.match(validateCandidateSpec(bad), /weights\.bloat/);
  const r = buildReplay({ samples: fullSamples(), candidateSpec: bad });
  assert.equal(r.candidateSpecHash.value, null);
  assert.equal(r.applied, false);
});
