#!/usr/bin/env node
/**
 * bin/oracle-production-delivery.test.mjs —— 生产投递分支的 fail-closed 阴性对照
 *
 * 钉住：① 无 --approve / 无停机窗口确认 / 无金标一律拒；② 代码齐备不构成放行；
 * ③ 当前 0 条冻结标签时 writesToProduction 恒 0；④ 审计台账禁入生产 storages，
 * 且被拒绝的尝试也留痕；⑤ 模拟域真写入不冒充生产写入。
 * ⛔ 顶层 import 放在 test() 之前（项目硬规则，撞 TDZ）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildRuntimePlan, evaluateProductionPrerequisites, runProductionDelivery,
  appendDeliveryAudit, defaultDeliveryAuditPath, assertAuditOutsideProduction,
  DELIVERY_AUDIT_NAME,
} from './oracle-runtime.mjs';
import { AUTONOMOUS_WRITE_SWITCH_ENV } from './autonomous-write-gate.mjs';

const ON_ENV = { [AUTONOMOUS_WRITE_SWITCH_ENV]: 'on' };
const NOW = new Date('2026-11-07T12:00:00.000Z');
const TMP_BASE = process.env.TMPDIR || tmpdir();

function readySources(productionStorages, overrides = {}) {
  return {
    storagesRoot: productionStorages,
    productionStorages,
    oracle: {
      domainOk: true, domainReason: '', broadcasts: 51, weeklyCount: 7,
      weeklyProposalCount: 7, lastWeekly: null,
      prescriptionCandidates: { value: 0, reason: '' },
      historical: {
        total: 7, eligible: 0, missingFields: [], withPredictedDeltaSource: 0,
        statusDistribution: { applied: 7 },
      },
      crossCheck: { consistent: true },
    },
    anchor: {
      available: true, baselineVerdict: 'READY',
      frozenLabels: { value: 3, reason: '', sampleSize: 3 },
      labelAuthority: 'GOLD', verifiedBy: 'capability-baseline',
      evidenceRef: 'capability-baseline:sets@READY',
    },
    annotations: { samples: [], independentWeeks: 0 },
    switch: { envVar: AUTONOMOUS_WRITE_SWITCH_ENV, on: true },
    ...overrides,
  };
}

function sandbox() {
  const base = mkdtempSync(join(TMP_BASE, 'oracle-delivery-'));
  const prod = join(base, 'storages');
  mkdirSync(prod);
  const targetRoot = join(base, 'delivery-root');
  mkdirSync(targetRoot);
  return { base, prod, targetRoot, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('⛔ 默认调用（无 approve / 无 ack / 开关 off / 0 金标）⇒ 全前置拒绝', async () => {
  const t = sandbox();
  try {
    const sources = readySources(t.prod, {
      anchor: { available: false, baselineVerdict: 'NO_FROZEN_LABELS',
        frozenLabels: { value: 0 }, labelAuthority: 'UNSET',
        verifiedBy: 'capability-baseline', evidenceRef: 'capability-baseline:sets@NO_FROZEN_LABELS' },
    });
    const r = await runProductionDelivery(sources, { env: {}, now: NOW });
    assert.equal(r.status, 'PREREQUISITES_NOT_MET');
    assert.equal(r.writesToProduction, 0);
    assert.equal(r.frozenSetsWritten, 0);
    assert.equal(r.scoringConstantsWritten, 0);
    assert.equal(r.humanAnnotationsWritten, 0);
    assert.equal(r.llmCalls, 0);
    assert.ok(r.failed.includes('approve_explicit'));
    assert.ok(r.failed.includes('service_window_ack'));
    assert.ok(r.failed.includes('G1_production_switch'));
    assert.ok(r.failed.includes('G2_external_truth'));
    assert.ok(r.auditRecord.writes === 0);
  } finally { t.cleanup(); }
});

test('⛔ 即便显式 --approve，0 条 GOLD/HELDOUT 金标仍硬拒（不代填、不拿 SILVER 顶替）', async () => {
  const t = sandbox();
  try {
    const sources = readySources(t.prod, {
      anchor: { available: false, baselineVerdict: 'NO_FROZEN_LABELS',
        frozenLabels: { value: 0 }, labelAuthority: 'UNSET',
        verifiedBy: 'capability-baseline', evidenceRef: 'capability-baseline:sets@NO_FROZEN_LABELS' },
    });
    const r = await runProductionDelivery(sources, {
      approve: true, serviceWindowAck: true, env: ON_ENV, now: NOW,
    });
    assert.equal(r.status, 'PREREQUISITES_NOT_MET');
    assert.equal(r.writesToProduction, 0);
    assert.ok(r.failed.includes('baseline_ready'));
    assert.ok(r.failed.includes('G2_external_truth'));
    assert.ok(r.failed.includes('B1_envelope'));
    assert.ok(r.failed.includes('five_gates'));
    assert.equal(existsSync(join(t.prod, 'agint_evolve.json')), false, '⛔ 拒绝时绝不创建生产域文件');
  } finally { t.cleanup(); }
});

test('⛔ 代码齐备 + 五闸全过，但缺停机窗口确认 ⇒ 仍拒（服务在跑时禁止外部直写）', () => {
  const t = sandbox();
  try {
    const sources = readySources(t.prod);
    const plan = buildRuntimePlan(sources, { env: ON_ENV });
    assert.equal(plan.envelopeResult.ok, true, '全绿 fixture 应能造出信封');
    assert.equal(plan.gateProbe.allowed, true, plan.gateProbe.reason);
    const r = evaluateProductionPrerequisites(sources, plan, {
      approve: true, serviceWindowAck: false, env: ON_ENV,
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.failed, ['service_window_ack']);
  } finally { t.cleanup(); }
});

test('✅ 全前置齐备时模拟域真写入 1 条，⛔ 但 writesToProduction 仍为 0', async () => {
  const t = sandbox();
  try {
    const sources = readySources(t.prod);
    const r = await runProductionDelivery(sources, {
      approve: true, serviceWindowAck: true, env: ON_ENV,
      storages: t.targetRoot, now: NOW,
    });
    assert.equal(r.status, 'DELIVERED_PROPOSED', r.reason);
    assert.equal(r.simulated, true, '写入目标是隔离模拟域，不是生产 storages');
    assert.equal(r.writesToProduction, 0, '⛔ 模拟域写入绝不冒充生产写入');
    assert.equal(r.delivery.delivered, true);
    assert.ok(r.persisted >= 1, '真 sink 写入后必须回读到记录');
    assert.equal(r.frozenSetsWritten, 0);
    assert.equal(r.scoringConstantsWritten, 0);
    assert.equal(r.humanAnnotationsWritten, 0);
    assert.equal(r.llmCalls, 0);
    assert.equal(r.auditRecord.writesToProduction, 0);
  } finally { t.cleanup(); }
});

test('审计台账：追加可回读，⛔ 生产 storages 内路径直接抛错且不产生文件', () => {
  const t = sandbox();
  try {
    const p = join(t.base, '.oracle-live', DELIVERY_AUDIT_NAME);
    const a = appendDeliveryAudit({ ts: NOW.toISOString(), action: 'test', status: 'REJECTED' },
      { auditPath: p, productionStorages: t.prod });
    assert.equal(a.appended, true);
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).status, 'REJECTED');
    const blocked = join(t.prod, 'must-not-exist.jsonl');
    assert.throws(
      () => appendDeliveryAudit({ ts: NOW.toISOString() }, { auditPath: blocked, productionStorages: t.prod }),
      /AUDIT_IN_PRODUCTION_STORAGES/,
    );
    assert.equal(existsSync(blocked), false);
    assert.equal(assertAuditOutsideProduction(p, t.prod).ok, true);
  } finally { t.cleanup(); }
});

test('defaultDeliveryAuditPath：落 DSH_HOME 旁，绝不进生产 storages 或仓库', () => {
  const home = '/home/kylin/projects/DSH/AGINT-data';
  const p = defaultDeliveryAuditPath({ DSH_HOME: home });
  assert.equal(p, join(home, '.oracle-live', DELIVERY_AUDIT_NAME));
  assert.ok(!p.startsWith(`${join(home, 'storages')}/`));
  assert.ok(!p.includes('DSH-AGINT'));
  assert.equal(defaultDeliveryAuditPath({}), null);
});
