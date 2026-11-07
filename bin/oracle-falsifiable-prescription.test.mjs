#!/usr/bin/env node
/**
 * bin/oracle-falsifiable-prescription.test.mjs —— G4 真实可证伪预测的阴性对照
 *
 * 钉住：① 预测来自真实读数且可被证伪（不是占位 0）；② 不含任何分数字段；
 * ③ oracle 域不可用 ⇒ null（三态，不拿 0 冒充）；④ G4 与 G2 互不代理。
 * ⛔ 顶层 import 放在 test() 之前（项目硬规则，撞 TDZ）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FP_SCHEMA, FP_METRIC, FP_PROMISED_INCREMENT, FP_TARGET,
  buildFalsifiablePrescription, inspectFalsifiablePrescription,
} from './oracle-falsifiable-prescription.mjs';

const NOW = new Date('2026-11-07T12:00:00.000Z');

function fakeSources({ oracle = {}, anchor = {}, ...rest } = {}) {
  return {
    oracle: {
      domainOk: true,
      weeklyProposalCount: 7,
      weeklyCount: 7,
      crossCheck: { consistent: true },
      historical: { total: 7, eligible: 0, withPredictedDeltaSource: 0 },
      ...oracle,
    },
    anchor: { labelAuthority: 'UNSET', frozenLabels: { value: 0 }, ...anchor },
    ...rest,
  };
}

test('真实读数构造出处方：Δ 由基线推出、来源指向真实读数与对拍口径', () => {
  const p = buildFalsifiablePrescription(fakeSources(), { now: NOW });
  assert.ok(p);
  assert.equal(p.schemaVersion, FP_SCHEMA);
  assert.equal(p.target, FP_TARGET);
  assert.equal(p.metric, FP_METRIC);
  assert.equal(p.baseline, 0, '麒麟机真实基线：7 条 oracle 提案里带 predictedDeltaSource 的 0 条');
  assert.equal(p.predictedDelta, FP_PROMISED_INCREMENT);
  assert.equal(p.predictedValue, 1);
  assert.equal(p.synthetic, false);
  assert.match(p.predictedDeltaSource, /真实读数/);
  assert.match(p.predictedDeltaSource, /对拍口径/);
  assert.match(p.predictedDeltaSource, /oracle 源 7 条/);
  assert.match(p.falsification, /prediction_outcomes/);
  assert.match(p.id, /^oracle-fp-2026-W45-[0-9a-f]{12}$/);
});

test('inspectFalsifiablePrescription 判 REAL_FALSIFIABLE_PREDICTION', () => {
  const p = buildFalsifiablePrescription(fakeSources(), { now: NOW });
  const r = inspectFalsifiablePrescription(p);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.reason, 'REAL_FALSIFIABLE_PREDICTION');
  assert.deepEqual(r.forbidden, []);
  assert.equal(r.predictedDelta, 1);
});

test('⛔ 域不可用 ⇒ null，绝不拿 0 冒充「没测过」', () => {
  const p = buildFalsifiablePrescription(fakeSources({ oracle: { domainOk: false } }), { now: NOW });
  assert.equal(p, null);
  const r = inspectFalsifiablePrescription(p);
  assert.equal(r.ok, false);
  assert.match(r.reason, /NO_PRESCRIPTION/);
});

test('⛔ 占位预测被拒：来源不含真实读数 / 对拍口径一律判 fail', () => {
  const p = buildFalsifiablePrescription(fakeSources(), { now: NOW });
  assert.equal(inspectFalsifiablePrescription({ ...p, predictedDeltaSource: '占位' }).ok, false);
  assert.equal(inspectFalsifiablePrescription({ ...p, predictedDelta: null }).ok, false);
  assert.equal(inspectFalsifiablePrescription({ ...p, predictedDelta: 0 }).ok, true,
    '0 是合法预测值（只要来源真实且可对拍），本批真实值是 1 不是 0');
  assert.equal(inspectFalsifiablePrescription({ ...p, synthetic: true }).ok, false);
});

test('⛔ 混入任何分数字段 ⇒ 拒收（Goodhart / 纲领 §8 例二）', () => {
  const p = buildFalsifiablePrescription(fakeSources(), { now: NOW });
  const r = inspectFalsifiablePrescription({ ...p, aesthetic_score: 99.9 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /SCORE_FIELD_PRESENT/);
  assert.ok(r.forbidden.includes('aesthetic_score'));
  assert.equal(inspectFalsifiablePrescription({ ...p, humanVerdict: 'good' }).ok, false);
});

test('基线随真实读数变化：已带预测的提案数会抬高基线，不是硬编码 0', () => {
  const p = buildFalsifiablePrescription(fakeSources({
    oracle: { historical: { total: 9, withPredictedDeltaSource: 2 } },
  }), { now: NOW });
  assert.equal(p.baseline, 2);
  assert.equal(p.predictedValue, 3);
  assert.match(p.predictedDeltaSource, /oracle 源 9 条/);
});

test('id 对同一真实读数确定性，且不随锚变化（G4 与 G2 互不代理）', () => {
  const a = buildFalsifiablePrescription(fakeSources(), { now: NOW });
  const b = buildFalsifiablePrescription(fakeSources({
    anchor: { labelAuthority: 'GOLD', frozenLabels: { value: 20 } },
  }), { now: NOW });
  assert.equal(a.id, b.id);
  assert.deepEqual(a.predictedDelta, b.predictedDelta);
});
