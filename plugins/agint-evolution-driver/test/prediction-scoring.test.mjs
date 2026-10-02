/**
 * prediction-scoring 测试（Phase 1 交付物 1 §2.3 / Sprint 21）。
 *
 * 覆盖：四值计算 + 死区 + 防刷分专项 + 桶聚合。
 * 设计 §7.1 要求 ≥20 case 且必须含边界：除零、负 baseline、actual≈0、predicted=0。
 *
 * ★ 期望值一律以**设计 §2.3.3 公式**为准，不以附录 A 速查表为准 ——
 * 速查表本身有两行算术错误（见 KNOWN_DESIGN_DEVIATIONS），照它写测试
 * 等于把笔误固化成契约。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizedDelta,
  tauFor,
  deadZoneThreshold,
  isDeadZone,
  directionalAccuracy,
  magnitudeCalibration,
  informativeness,
  scorePrediction,
  bucketConfidence,
  aggregateBucket,
  TAU_METRIC,
  BINARY_METRICS,
  MUTATION_TYPES,
  ZERO_INFO_PQ,
  ZERO_INFO_EPSILON,
  PQ_WEIGHTS,
} from '../lib/prediction-scoring.js';

const SR = 'SUCCESS_RATE'; // τ=3.0, τ_deadzone=1.5
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

// ─────────────────────────────────────────────────────────────────────
// 设计文档的已知偏差（2026-10-02 大鱼拍板：以公式为准）
// ─────────────────────────────────────────────────────────────────────

const KNOWN_DESIGN_DEVIATIONS = [
  {
    predicted: 0, actual: 0.1, metric: SR, designTable: 0.19, formula: 0,
    why: '附录A行4 写 0.5×0.388=0.194，但 0.388=0.4×0.97（MC 权重 0.6 被误写成 0.4）。'
       + '按公式应为 0.5×(0.6×0.967+0.4×0)=0.290；再叠加 IF=0⇒PQ=0 决议，最终为 0。',
  },
  {
    predicted: 4, actual: 0.2, metric: SR, designTable: 0.47, formula: 0.2845,
    why: '附录A行6 写 0.47，按其自列的 DA=0.5/MC=0.28/IF=1.0 应为 0.5×(0.6×0.28+0.4×1)=0.284。',
  },
];

// ─────────────────────────────────────────────────────────────────────
// §2.3.1 指标标准化
// ─────────────────────────────────────────────────────────────────────

test('normalizedDelta: 常规百分比变化', () => {
  near(normalizedDelta(100, 105), 5);
  near(normalizedDelta(50, 45), -10);
  near(normalizedDelta(0.8, 1.0), 25);
});

test('normalizedDelta: baseline=0 返回 null（不用 0 冒充，交给上层标 NO_EVIDENCE）', () => {
  assert.equal(normalizedDelta(0, 0), null);
  assert.equal(normalizedDelta(0, 5), null, 'baseline=0 但 candidate≠0 时相对量无意义');
});

test('normalizedDelta: 负 baseline 仍按 |baseline| 取分母（epsilon 语义）', () => {
  // 分母 = max(|-2|, |-2|*0.01) = 2 ⇒ (0-(-2))/2*100 = +100
  near(normalizedDelta(-2, 0), 100);
  // baseline 极小时 epsilon 接管：|0.001|*0.01=1e-5 ⇒ (0.002-0.001)/1e-5*100 = 100
  near(normalizedDelta(0.001, 0.002), 100);
});

test('normalizedDelta: 非有限输入返回 null', () => {
  assert.equal(normalizedDelta(NaN, 1), null);
  assert.equal(normalizedDelta(1, Infinity), null);
});

// ─────────────────────────────────────────────────────────────────────
// §2.3.2 维度 2/3
// ─────────────────────────────────────────────────────────────────────

test('tauFor: 附录B 缺省表 + 未知/二值指标返回 null', () => {
  near(tauFor(SR), 3.0);
  near(tauFor('TOKEN_EFFICIENCY'), 8.0);
  near(tauFor('LATENCY'), 15.0);
  near(tauFor('REGRESSION'), 0.5);
  assert.equal(tauFor('SAFETY'), null, '二值指标不适用 PQ');
  assert.equal(tauFor('NOPE'), null);
});

test('magnitudeCalibration: 误差=τ 时 ≈0.37，误差=0 时 =1', () => {
  near(magnitudeCalibration(0, 3, SR), Math.exp(-1), 1e-9);
  near(magnitudeCalibration(5, 5, SR), 1);
  near(magnitudeCalibration(4, 3.8, SR), 0.9355, 1e-3);
});

test('magnitudeCalibration: τ 未知或输入非有限返回 null', () => {
  assert.equal(magnitudeCalibration(1, 1, 'SAFETY'), null);
  assert.equal(magnitudeCalibration(NaN, 1, SR), null);
});

test('informativeness: 预测0⇒0，|预测|≥τ⇒1（防保守刷分维度）', () => {
  assert.equal(informativeness(0, SR), 0);
  near(informativeness(-0.0001, SR), 1 / 30000, 1e-12); // 负号取绝对值，极小非零
  near(informativeness(1.5, SR), 0.5);
  assert.equal(informativeness(3, SR), 1);
  assert.equal(informativeness(999, SR), 1, '封顶不外溢');
  assert.equal(informativeness(1, 'SAFETY'), null);
});

// ─────────────────────────────────────────────────────────────────────
// §2.3.2 维度 1：方向正确性（含死区与一票否决的优先级）
// ─────────────────────────────────────────────────────────────────────

test('directionalAccuracy: 方向一致=1，一致为负也对（预测退化且准确）', () => {
  assert.equal(directionalAccuracy(4, 3.8, false), 1);
  assert.equal(directionalAccuracy(-3, -2.8, false), 1);
});

test('directionalAccuracy: 死区（方向不可判定）=0.5', () => {
  assert.equal(directionalAccuracy(4, 0.2, true), 0.5);
  assert.equal(directionalAccuracy(0, 0.1, true), 0.5);
});

test('directionalAccuracy: 实际恰为 0 ⇒ 0.5（方向不可判定）', () => {
  assert.equal(directionalAccuracy(5, 0, false), 0.5);
});

test('directionalAccuracy: 预测 0 而实际有方向 ⇒ 0（没押中方向）', () => {
  assert.equal(directionalAccuracy(0, 4, false), 0);
});

test('directionalAccuracy: ⛔ 方向冲突优先于死区（拍板决议）', () => {
  // 关键回归：|actual|=1.0 < τ_deadzone=1.5，纯按死区会判 0.5；
  // 但设计附录A行3 与验收#3 要求 DA=0。
  assert.equal(directionalAccuracy(4, -1, true), 0);
  assert.equal(directionalAccuracy(4, -0.3, true), 0, '死区内方向相反也是 0');
  assert.equal(directionalAccuracy(-3, 2.5, false), 0);
});

// ─────────────────────────────────────────────────────────────────────
// §2.4.3 死区
// ─────────────────────────────────────────────────────────────────────

test('deadZoneThreshold: 默认 0.5×τ，噪声更大时改用噪声值', () => {
  near(deadZoneThreshold(SR).threshold, 1.5);
  assert.equal(deadZoneThreshold(SR).basis, 'TAU_FACTOR');
  // 噪声 2.0 > 1.5 ⇒ 取噪声
  near(deadZoneThreshold(SR, 2.0).threshold, 2.0);
  assert.equal(deadZoneThreshold(SR, 2.0).basis, 'NOISE_STD');
  // 噪声更小则不收紧（只放宽不收紧，附录B 重标定规则）
  near(deadZoneThreshold(SR, 0.5).threshold, 1.5);
});

test('deadZoneThreshold: 二值/未知指标 threshold=null 且 basis 可辨', () => {
  assert.equal(deadZoneThreshold('SAFETY').threshold, null);
  assert.equal(deadZoneThreshold('SAFETY').basis, 'BINARY_METRIC');
  assert.equal(deadZoneThreshold('NOPE').basis, 'UNKNOWN_METRIC');
});

test('isDeadZone: 边界值（严格小于，|actual|=τ 不算死区）', () => {
  assert.equal(isDeadZone(1.4, SR).isDeadZone, true);
  assert.equal(isDeadZone(1.5, SR).isDeadZone, false, 'τ_deadzone 本身不算死区');
  assert.equal(isDeadZone(1.6, SR).isDeadZone, false);
  assert.equal(isDeadZone(-0.9, SR).isDeadZone, true, '负向同样计入');
});

// ─────────────────────────────────────────────────────────────────────
// §2.3.3 综合评分 PQ
// ─────────────────────────────────────────────────────────────────────

test('scorePrediction: 理想预测（方向对、幅度准、够大胆）', () => {
  const r = scorePrediction({ predictedDelta: 4, actualDelta: 3.8, targetMetric: SR });
  assert.equal(r.DA, 1);
  near(r.MC, 0.9355, 1e-3);
  assert.equal(r.IF, 1);
  near(r.pq, 0.961, 1e-3);
});

test('scorePrediction: 过度激进（方向对但幅度离谱）仍给分但不高', () => {
  const r = scorePrediction({ predictedDelta: 15, actualDelta: 3.8, targetMetric: SR });
  assert.equal(r.DA, 1);
  near(r.pq, 0.414, 1e-3);
  assert.ok(r.pq > 0.3 && r.pq < 0.5, `期望 0.3~0.5，实际 ${r.pq}`);
});

test('scorePrediction: 落入死区 ⇒ DA 减半（但不被 IF 归零，因为预测很大胆）', () => {
  const r = scorePrediction({ predictedDelta: 4, actualDelta: 0.2, targetMetric: SR });
  assert.equal(r.isDeadZone, true);
  assert.equal(r.DA, 0.5);
  assert.equal(r.IF, 1, '预测 4.0 信息量充足');
  near(r.pq, 0.2845, 1e-3);
});

// ── 验收标准 #2：防保守刷分专项 ──────────────────────────────────────

test('验收#2: 预测 Δ=0 时 PQ 必须 < 0.25（防「永远预测 0」退化策略）', () => {
  for (const actual of [0, 0.1, -0.1, 0.4, -0.4]) {
    const r = scorePrediction({ predictedDelta: 0, actualDelta: actual, targetMetric: SR });
    assert.equal(r.IF, 0);
    assert.equal(r.isZeroInformation, true);
    assert.equal(r.pq, ZERO_INFO_PQ, `预测0/实际${actual} 应判 0，实际 ${r.pq}`);
    assert.ok(r.pq < 0.25, `预测0/实际${actual} 的 PQ=${r.pq} 超标`);
  }
});

test('验收#2: 零信息量归零不影响真实预测的分数', () => {
  const bold = scorePrediction({ predictedDelta: 4, actualDelta: 3.8, targetMetric: SR });
  assert.ok(bold.pq > 0.9, '真实预测仍应拿高分');
  assert.ok(bold.pq > scorePrediction({ predictedDelta: 0, actualDelta: 0, targetMetric: SR }).pq * 10);
});

test('验收#2: 极微小的非零预测也被判零信息量（epsilon 防绕过）', () => {
  // ⛔ 回归：曾只判 IF === 0，退化策略预测 0.0001 即可拿 PQ≈0.30 绕过归零。
  for (const p of [1e-9, 0.0001, 0.001, 0.029]) {
    const r = scorePrediction({ predictedDelta: p, actualDelta: p, targetMetric: SR });
    assert.ok(r.IF < ZERO_INFO_EPSILON, `IF=${r.IF} 应低于 epsilon`);
    assert.equal(r.pq, ZERO_INFO_PQ, `预测${p} 应判零信息量，实际 PQ=${r.pq}`);
  }
  // 但真正的保守预测不受影响
  const real = scorePrediction({ predictedDelta: 0.5, actualDelta: 0.5, targetMetric: SR });
  assert.ok(real.IF > ZERO_INFO_EPSILON);
  assert.ok(real.pq > 0, `保守但真实的预测应得分，实际 ${real.pq}`);
});

test('ZERO_INFO_EPSILON 取 0.01（τ 的 1%）并被导出供审查', () => {
  assert.equal(ZERO_INFO_EPSILON, 0.01);
  // τ=3.0 ⇒ 阈值对应预测幅度 0.03pp
  near(ZERO_INFO_EPSILON * TAU_METRIC[SR], 0.03, 1e-12);
});

// ── 验收标准 #3：方向错一票否决 ──────────────────────────────────────

test('验收#3: 方向不符时 PQ == 0，无论 MC 多高', () => {
  for (const [p, a] of [[4, -1], [4, -0.3], [4, -10], [-3, 2.5], [0.5, -8]]) {
    const r = scorePrediction({ predictedDelta: p, actualDelta: a, targetMetric: SR });
    assert.equal(r.DA, 0, `预测${p}/实际${a} 方向错应 DA=0`);
    assert.equal(r.pq, 0, `预测${p}/实际${a} 方向错应 PQ=0，实际 ${r.pq}`);
  }
});

test('验收#3: MC 再高也救不了方向错（幅度与方向解耦的证明）', () => {
  // 只有「双方都近零、方向相反」才能同时出现高 MC 与 DA=0 ——
  // 大幅反向时 |误差| 必然大、MC 必然低（这是公式的必然，不是巧合）。
  const r = scorePrediction({ predictedDelta: 0.1, actualDelta: -0.1, targetMetric: SR });
  assert.ok(r.MC > 0.9, `MC 应很高，实际 ${r.MC}`);
  assert.equal(r.DA, 0, '方向错');
  assert.equal(r.pq, 0, 'MC 再高也归零');
  // 反向大幅时 MC 也很低 —— 两条路径都到不了高分
  const big = scorePrediction({ predictedDelta: 3, actualDelta: -2.9, targetMetric: SR });
  assert.ok(big.MC < 0.2, `大幅反向 MC 应低，实际 ${big.MC}`);
  assert.equal(big.pq, 0);
});

// ── 边界与降级 ───────────────────────────────────────────────────────

test('scorePrediction: 未预测（null）⇒ pq=null + NOT_PREDICTED（不用 0 冒充）', () => {
  const r = scorePrediction({ predictedDelta: null, actualDelta: 3, targetMetric: SR });
  assert.equal(r.pq, null);
  assert.equal(r.reason, 'NOT_PREDICTED');
});

test('scorePrediction: 二值指标 SAFETY 不评分（附录B）', () => {
  const r = scorePrediction({ predictedDelta: 1, actualDelta: 1, targetMetric: 'SAFETY' });
  assert.equal(r.pq, null);
  assert.equal(r.reason, 'BINARY_METRIC_NOT_SCORED');
  assert.equal(r.deadZoneBasis, 'BINARY_METRIC');
});

test('scorePrediction: 未知指标 ⇒ pq=null + UNKNOWN_METRIC，不静默当 0', () => {
  const r = scorePrediction({ predictedDelta: 1, actualDelta: 1, targetMetric: 'MYSTERY' });
  assert.equal(r.pq, null);
  assert.equal(r.reason, 'UNKNOWN_METRIC');
});

test('scorePrediction: 返回值带 tau 与死区依据，便于报告溯源', () => {
  const r = scorePrediction({ predictedDelta: 4, actualDelta: 3.8, targetMetric: SR });
  assert.equal(r.tau, 3.0);
  assert.equal(r.deadZoneThreshold, 1.5);
  assert.equal(r.deadZoneBasis, 'TAU_FACTOR');
});

// ── 与设计附录 A 的已知偏差（显式记录，防后人"修"测试去迁就笔误）──────

test('与设计附录A 的两行已知偏差（以公式为准，理由见 KNOWN_DESIGN_DEVIATIONS）', () => {
  const [d1, d2] = KNOWN_DESIGN_DEVIATIONS;
  const r1 = scorePrediction({ predictedDelta: d1.predicted, actualDelta: d1.actual, targetMetric: d1.metric });
  near(r1.pq, d1.formula, 1e-6);
  assert.notEqual(r1.pq, d1.designTable, '设计速查表此行算术有误，实现不迁就');

  const r2 = scorePrediction({ predictedDelta: d2.predicted, actualDelta: d2.actual, targetMetric: d2.metric });
  near(r2.pq, d2.formula, 1e-3);
  assert.notEqual(r2.pq, d2.designTable);
  assert.ok(d1.why && d2.why, '偏差必须带理由');
});

test('PQ 权重与设计 §2.3.3 一致（0.6 MC / 0.4 IF）', () => {
  assert.equal(PQ_WEIGHTS.MC, 0.6);
  assert.equal(PQ_WEIGHTS.IF, 0.4);
  const r = scorePrediction({ predictedDelta: 4, actualDelta: 3.8, targetMetric: SR });
  near(r.pq, r.DA * (0.6 * r.MC + 0.4 * r.IF), 1e-12);
});

// ── §2.3.4 桶置信度 ──────────────────────────────────────────────────

test('bucketConfidence: 三级门槛（n≥10 STABLE / n≥5 PROVISIONAL / 其余 CALIBRATING）', () => {
  assert.equal(bucketConfidence(0), 'CALIBRATING');
  assert.equal(bucketConfidence(4), 'CALIBRATING');
  assert.equal(bucketConfidence(5), 'PROVISIONAL');
  assert.equal(bucketConfidence(9), 'PROVISIONAL');
  assert.equal(bucketConfidence(10), 'STABLE');
  assert.equal(bucketConfidence(1000), 'STABLE');
  assert.equal(bucketConfidence(NaN), 'CALIBRATING', '非法样本量不乐观升级');
});

// ── §2.5.1 桶聚合 ────────────────────────────────────────────────────

test('aggregateBucket: 空桶统计量为 null（不用 0 冒充「效果为零」）', () => {
  const b = aggregateBucket({ mutationType: 'TOOL_SYNTHESIS', targetMetric: SR, records: [] });
  assert.equal(b.bucketKey, 'TOOL_SYNTHESIS::SUCCESS_RATE');
  assert.equal(b.sampleSize, 0);
  assert.equal(b.confidence, 'CALIBRATING');
  for (const k of ['meanPQ', 'medianActualDelta', 'iqrActualDelta', 'successRate', 'directionalAccuracy', 'deadZoneRate']) {
    assert.equal(b[k], null, `${k} 应为 null`);
  }
});

test('aggregateBucket: 统计量与手算一致', () => {
  const records = [
    { pq: 0.9, actualDelta: 2, DA: 1, isDeadZone: false },
    { pq: 0.7, actualDelta: 4, DA: 1, isDeadZone: false },
    { pq: 0.5, actualDelta: 6, DA: 0, isDeadZone: false },
    { pq: 0.3, actualDelta: 8, DA: 0, isDeadZone: true },
  ];
  const b = aggregateBucket({ mutationType: 'PROMPT_MUTATION', targetMetric: SR, records });
  assert.equal(b.sampleSize, 4);
  assert.equal(b.confidence, 'CALIBRATING');
  near(b.meanPQ, 0.6, 1e-9);
  near(b.medianActualDelta, 5, 1e-9, );
  near(b.successRate, 0.5, 1e-9, );
  near(b.directionalAccuracy, 0.5, 1e-9);
  near(b.deadZoneRate, 0.25, 1e-9);
});

test('aggregateBucket: successRate 按 PQ≥0.6 计（设计 §2.5.1 注释）', () => {
  const b = aggregateBucket({
    mutationType: 'STRATEGY_REWRITE',
    targetMetric: SR,
    records: [
      { pq: 0.6, actualDelta: 1, DA: 1, isDeadZone: false },
      { pq: 0.59, actualDelta: 1, DA: 1, isDeadZone: false },
    ],
  });
  near(b.successRate, 0.5, 1e-9, '0.60 计入、0.59 不计');
});

test('aggregateBucket: 桶 key 用生产 mutationType 枚举', () => {
  for (const mt of MUTATION_TYPES) {
    const b = aggregateBucket({ mutationType: mt, targetMetric: 'LATENCY', records: [] });
    assert.equal(b.bucketKey, `${mt}::LATENCY`);
  }
  assert.deepEqual([...MUTATION_TYPES], ['PROMPT_MUTATION', 'TOOL_SYNTHESIS', 'STRATEGY_REWRITE']);
});

test('aggregateBucket: lastUpdated 留空由写入方填（纯函数不取时钟）', () => {
  const b = aggregateBucket({
    mutationType: 'TOOL_SYNTHESIS', targetMetric: SR,
    records: [{ pq: 0.5, actualDelta: 1, DA: 1, isDeadZone: false }],
  });
  assert.equal(b.lastUpdated, null);
});

test('τ 表与二值指标清单符合设计附录 B', () => {
  assert.deepEqual({ ...TAU_METRIC }, { SUCCESS_RATE: 3.0, TOKEN_EFFICIENCY: 8.0, LATENCY: 15.0, REGRESSION: 0.5 });
  assert.deepEqual([...BINARY_METRICS], ['SAFETY']);
});
