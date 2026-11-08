/**
 * bin/oracle-prescription-delivery.test.mjs —— B1 受控投递通道的阴性对照
 *
 * ⛔ 核心判据：默认路径零写入；开关 on 但缺外部锚定仍零写入；
 *    五闸全过但没有显式注入 sink 仍零写入。任何分数/标注字段混入即拒。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DELIVERY_SCHEMA, ENVELOPE_FIELDS, FORBIDDEN_PRESCRIPTION_FIELDS,
  findForbiddenFields, buildPrescriptionEnvelope, evaluateDelivery, probeGates,
} from './oracle-prescription-delivery.mjs';

const OFF = {};
const ON = { AGINT_ORACLE_AUTONOMOUS_WRITE: 'on' };

function goodPrescription(extra = {}) {
  return {
    id: 'rx-001',
    body: '建议复核 confidence 证据链',
    target: 'proposal_queue',
    predictedDelta: 0.05,
    predictedDeltaSource: '离线回放 2026-W45',
    ...extra,
  };
}

function goodAnchor(extra = {}) {
  return {
    labelAuthority: 'GOLD',
    frozenLabelCount: 3,
    verifiedBy: 'capability-baseline',
    evidenceRef: 'eval/capability-baseline/sets/gold.json',
    ...extra,
  };
}

test('⛔ 默认路径：开关未设 + UNSET ⇒ DEFAULT_DENY，零写入', () => {
  const r = probeGates({ env: OFF });
  assert.equal(r.status, 'DEFAULT_DENY');
  assert.equal(r.writes, 0);
  assert.equal(r.delivered, false);
  assert.equal(r.defaultDeny, true);
  assert.equal(r.schemaVersion, DELIVERY_SCHEMA);
  assert.ok(r.gate.checks.find((c) => c.id === 'G1_switch').passed === false);
  assert.ok(r.gate.checks.find((c) => c.id === 'G2_external_anchor').passed === false);
});

test('⛔ 开关拨到 on 但缺 GOLD/HELDOUT ⇒ G2 仍拒，零写入', () => {
  const r = probeGates({ env: ON, labelAuthority: 'UNSET' });
  assert.equal(r.gate.checks.find((c) => c.id === 'G1_switch').passed, true);
  assert.equal(r.gate.allowed, false);
  assert.equal(r.writes, 0);
  assert.match(r.reason, /G2_external_anchor/);
});

test('⛔ SILVER 自评不算外部锚定 ⇒ 拒', () => {
  const r = probeGates({ env: ON, labelAuthority: 'SILVER' });
  assert.equal(r.gate.allowed, false);
  assert.equal(r.writes, 0);
});

test('✅ 合法处方 + GOLD 锚 ⇒ 只造信封，状态恒 proposed', () => {
  const b = buildPrescriptionEnvelope(goodPrescription(), goodAnchor());
  assert.equal(b.ok, true, b.reason);
  assert.equal(b.writes, 0);
  assert.equal(b.envelope.status, 'proposed');
  assert.equal(Object.isFrozen(b.envelope), true, '信封须冻结，sink 不得回改状态');
  assert.deepEqual(Object.keys(b.envelope).sort(), [...ENVELOPE_FIELDS].sort());
});

test('⛔ 处方混入 aesthetic_score ⇒ SCORE_FIELD_PRESENT', () => {
  const b = buildPrescriptionEnvelope(goodPrescription({ aesthetic_score: 99.9 }), goodAnchor());
  assert.equal(b.ok, false);
  assert.equal(b.writes, 0);
  assert.match(b.reason, /SCORE_FIELD_PRESENT/);
});

test('⛔ 处方混入人工标注字段 ⇒ 同样拒收', () => {
  const b = buildPrescriptionEnvelope(goodPrescription({ humanVerdict: 'confidence' }), goodAnchor());
  assert.equal(b.ok, false);
  assert.match(b.reason, /SCORE_FIELD_PRESENT/);
  assert.deepEqual(findForbiddenFields({ nested: { DIM_WEIGHTS: 1 } }), ['nested.DIM_WEIGHTS']);
  assert.ok(FORBIDDEN_PRESCRIPTION_FIELDS.includes('scaleHash'));
});

test('⛔ 0 条冻结标签 ⇒ 造不出合法锚', () => {
  const b = buildPrescriptionEnvelope(goodPrescription(), goodAnchor({ frozenLabelCount: 0 }));
  assert.equal(b.ok, false);
  assert.match(b.reason, /NO_FROZEN_LABELS/);
});

test('⛔ SILVER 锚 / 未经校验的锚 ⇒ 拒', () => {
  assert.match(buildPrescriptionEnvelope(goodPrescription(), goodAnchor({ labelAuthority: 'SILVER' })).reason, /ANCHOR_NOT_EXTERNAL/);
  assert.match(buildPrescriptionEnvelope(goodPrescription(), goodAnchor({ verifiedBy: 'self' })).reason, /ANCHOR_UNVERIFIED/);
});

test('⛔ 目标不在白名单 / 无可证伪预测 ⇒ 拒', () => {
  assert.match(buildPrescriptionEnvelope(goodPrescription({ target: 'storages' }), goodAnchor()).reason, /TARGET_NOT_ALLOWED/);
  assert.match(buildPrescriptionEnvelope(goodPrescription({ predictedDelta: NaN }), goodAnchor()).reason, /PREDICTED_DELTA_INVALID/);
  assert.match(buildPrescriptionEnvelope(goodPrescription({ predictedDeltaSource: '' }), goodAnchor()).reason, /PREDICTED_DELTA_SOURCE_MISSING/);
});

test('⛔ 五闸全过但没注入 sink ⇒ WOULD_DELIVER_NO_SINK，仍是零写入', () => {
  const b = buildPrescriptionEnvelope(goodPrescription(), goodAnchor());
  const r = evaluateDelivery(b.envelope, { switchOn: true, sink: null });
  assert.equal(r.gate.allowed, true, r.reason);
  assert.equal(r.status, 'WOULD_DELIVER_NO_SINK');
  assert.equal(r.writes, 0);
  assert.equal(r.sinkInvoked, false);
  assert.equal(r.delivered, false);
});

test('✅ 正面路径：五闸全过 + 显式注入 sink ⇒ writes=1（证明不是恒拒）', () => {
  const b = buildPrescriptionEnvelope(goodPrescription(), goodAnchor());
  const seen = [];
  const r = evaluateDelivery(b.envelope, {
    switchOn: true,
    sink: (e) => seen.push(e),
  });
  assert.equal(r.delivered, true);
  assert.equal(r.writes, 1);
  assert.equal(r.sinkInvoked, true);
  assert.equal(r.status, 'DELIVERED_PROPOSED');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].status, 'proposed', '投递的只能是候选，不是批准/执行');
});

test('⛔ 人工否决 / 急停 / 无撤销窗口 ⇒ G5 拒，零写入', () => {
  const b = buildPrescriptionEnvelope(goodPrescription(), goodAnchor());
  for (const opts of [{ humanVeto: true }, { emergencyStop: true }, { vetoWindowHours: 0 }]) {
    const r = evaluateDelivery(b.envelope, { switchOn: true, sink: () => { throw new Error('不应写入'); }, ...opts });
    assert.equal(r.writes, 0, JSON.stringify(opts));
    assert.equal(r.status, 'DEFAULT_DENY');
    assert.ok(r.gate.checks.find((c) => c.id === 'G5_human_veto').passed === false);
  }
});

test('⛔ 信封状态不是 proposed ⇒ 零写入', () => {
  const r = evaluateDelivery({ status: 'approved' }, { switchOn: true, sink: () => { throw new Error('不应写入'); } });
  assert.equal(r.status, 'NO_ENVELOPE');
  assert.equal(r.writes, 0);
});
