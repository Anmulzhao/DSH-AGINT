#!/usr/bin/env node
/**
 * bin/oracle-live-tick.test.mjs —— 运行态心跳器单测
 *
 * 钉住四件事：① 五闸逐闸诚实（无信封时 G4 明文 fail，不拿占位 0 冒充预测）；
 * ② --switch on 只在进程内生效、默认仍 OFF；③ 四个恒定零；
 * ④ 审计台账绝不落进生产 storages，且滚动上限可验。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  LIVE_SCHEMA, LEDGER_MAX_LINES,
  defaultLedgerPath, assertLedgerOutsideProduction, buildLiveGateInput,
  buildLiveReport, ledgerRecord, appendLedger, readLedgerTail, deriveHeartbeat,
} from './oracle-live-tick.mjs';
import { AUTONOMOUS_WRITE_SWITCH_ENV } from './autonomous-write-gate.mjs';
import { buildRuntimePlan } from './oracle-runtime.mjs';

const PROD = resolve('/home/kylin/projects/DSH/AGINT-data/storages');

function fakeSources(overrides = {}) {
  return {
    storagesRoot: PROD,
    productionStorages: PROD,
    switch: { envVar: AUTONOMOUS_WRITE_SWITCH_ENV, on: false, detail: '默认关闭' },
    oracle: {
      domainOk: true,
      domainReason: '',
      broadcasts: 51,
      weeklyCount: 7,
      weeklyProposalCount: 7,
      prescriptionCandidates: { value: 0, reason: 'NO_ELIGIBLE_PRESCRIPTION', sampleSize: null },
      historical: { total: 7, eligible: 0, missingFields: ['predictedDelta', 'predictedDeltaSource'] },
    },
    anchor: {
      labelAuthority: 'UNSET',
      frozenLabels: { value: 0, reason: '', sampleSize: null },
      verifiedBy: 'capability-baseline',
      evidenceRef: 'capability-baseline:sets@NO_FROZEN_LABELS',
    },
    annotations: { samples: [], independentWeeks: 0 },
    ...overrides,
  };
}

function tmpLedger() {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'oracle-live-'));
  return join(dir, 'live-ledger.jsonl');
}

test('defaultLedgerPath：有 DSH_HOME 时落数据目录旁，绝不进 storages 或仓库', () => {
  const home = '/home/kylin/projects/DSH/AGINT-data';
  const p = defaultLedgerPath({ DSH_HOME: home, AGINT_DATA_HOME: home });
  assert.equal(p, join(home, '.oracle-live', 'live-ledger.jsonl'));
  assert.ok(!p.startsWith(`${PROD}/`));
  assert.ok(!p.includes('DSH-AGINT'));
  // 无 DSH_HOME 时回落到仓库内，但仍不在 storages 内
  const fallback = defaultLedgerPath({});
  assert.ok(!fallback.startsWith(`${PROD}/`));
});

test('assertLedgerOutsideProduction：生产 storages 内一律拒绝，兄弟目录放行', () => {
  assert.throws(
    () => assertLedgerOutsideProduction(join(PROD, 'live-ledger.jsonl'), PROD),
    /LEDGER_IN_PRODUCTION_STORAGES/,
  );
  assert.throws(
    () => assertLedgerOutsideProduction(join(PROD, 'sub', 'x.jsonl'), PROD),
    /LEDGER_IN_PRODUCTION_STORAGES/,
  );
  assert.equal(assertLedgerOutsideProduction('/home/kylin/projects/DSH/AGINT-data/.oracle-live/l.jsonl', PROD).ok, true);
  assert.equal(assertLedgerOutsideProduction('/tmp/x.jsonl', null).ok, true);
});

test('buildLiveGateInput：无合法信封 ⇒ G4 输入为空，绝不拿 0 冒充预测', () => {
  const plan = { envelopeResult: { ok: false, reason: 'ANCHOR_NOT_EXTERNAL' }, envelope: null, anchor: { labelAuthority: 'UNSET' } };
  const input = buildLiveGateInput(plan);
  assert.equal(input.predictedDelta, null);
  assert.equal(input.predictedDeltaSource, '');
  assert.equal(input.labelAuthority, 'UNSET');
  assert.equal(input.target, 'proposal_queue');
});

test('buildLiveGateInput：有真实可证伪预测 ⇒ G4 输入是真实 Δ，不再绑死在信封上', () => {
  const plan = buildRuntimePlan(fakeSources(), { env: {}, switchOn: true });
  const input = buildLiveGateInput(plan);
  assert.equal(input.predictedDelta, 1);
  assert.match(input.predictedDeltaSource, /真实读数/);
  assert.match(input.predictedDeltaSource, /对拍口径/);
  assert.equal(input.labelAuthority, 'UNSET', '⛔ G4 点亮绝不顺带把 G2 点亮');
});

test('⛔ 阴性对照：oracle 域不可用 ⇒ 无真实处方 ⇒ G4 明文 fail，绝不拿占位 0 冒充', async () => {
  const noDomain = fakeSources({
    oracle: {
      domainOk: false, domainReason: 'DOMAIN_MISSING', broadcasts: 0, weeklyCount: 0,
      weeklyProposalCount: 0,
      prescriptionCandidates: { value: null, reason: 'DOMAIN_MISSING' },
      historical: { total: 0, eligible: 0, missingFields: [] },
    },
  });
  const r = await buildLiveReport(noDomain, { switchOn: true, env: {} });
  assert.ok(r.gates.failedIds.includes('G4_falsifiable_prediction'));
  assert.equal(r.delivery.status, 'NO_ENVELOPE');
  assert.equal(r.writesToProduction, 0);
});

test('心跳（G1 OFF）：G1/G2 两闸未过，G4 已被真实预测点亮，逐闸明细长度 5', async () => {
  const r = await buildLiveReport(fakeSources(), { switchOn: false, env: {} });
  assert.equal(r.schemaVersion, LIVE_SCHEMA);
  assert.equal(r.wiring, 'CONNECTED');
  assert.equal(r.powered, false);
  assert.equal(r.runtimeDefault, 'OFF');
  assert.equal(r.gates.checks.length, 5);
  assert.equal(r.gates.status, 'DEFAULT_DENY');
  assert.deepEqual(r.gates.failedIds, ['G1_switch', 'G2_external_anchor']);
  assert.equal(r.gates.passed, 3); // G3 白名单 / G4 真实可证伪预测 / G5 撤销窗口
  assert.equal(r.chain.find((s) => s.id === 'five_gates').status, 'DEFAULT_DENY');
});

test('心跳（G1 显式 ON）：只在本进程通电，默认仍 OFF；**只剩 G2 一盏未亮**', async () => {
  const env = {};
  const r = await buildLiveReport(fakeSources(), { switchOn: true, env });
  assert.equal(r.powered, true);
  assert.equal(r.switch.scope, 'PROCESS_ONLY');
  assert.equal(r.runtimeDefault, 'OFF');
  assert.ok(!r.gates.failedIds.includes('G1_switch'));
  assert.deepEqual(r.gates.failedIds, ['G2_external_anchor']);
  assert.equal(r.gates.passed, 4);
  // ⛔ 不写环境变量：进程外读开关仍是关闭
  assert.equal(env[AUTONOMOUS_WRITE_SWITCH_ENV], undefined);
  assert.equal(process.env[AUTONOMOUS_WRITE_SWITCH_ENV], undefined);
});

test('⛔ 0 条冻结标签恒 UNSET：GOLD 只能来自真值，绝不伪造', async () => {
  const r = await buildLiveReport(fakeSources(), { switchOn: true, env: {} });
  assert.equal(r.sources.labelAuthority, 'UNSET');
  assert.equal(r.sources.frozenLabels.value, 0);
  const g2 = r.gates.checks.find((c) => c.id === 'G2_external_anchor');
  assert.equal(g2.passed, false);
  assert.match(g2.detail, /不是 GOLD\/HELDOUT/);
});

test('⛔ 四个恒定零 + 零投递：dry-run 不碰任何生产对象', async () => {
  const r = await buildLiveReport(fakeSources(), { switchOn: true, env: {} });
  assert.equal(r.delivery.writes, 0);
  assert.equal(r.delivery.status, 'NO_ENVELOPE');
  assert.equal(r.writesToProduction, 0);
  assert.equal(r.frozenSetsWritten, 0);
  assert.equal(r.scoringConstantsWritten, 0);
  assert.equal(r.humanAnnotationsWritten, 0);
  assert.equal(r.llmCalls, 0);
  assert.ok(r.blockers.length >= 4);
});

test('ledgerRecord 只存精简字段，不把整份报告滚进台账', async () => {
  const r = await buildLiveReport(fakeSources(), { switchOn: true, env: {} });
  const rec = ledgerRecord(r);
  assert.equal(rec.writesToProduction, 0);
  assert.equal(rec.labelAuthority, 'UNSET');
  assert.ok(!('chain' in rec));
  assert.ok(!('checks' in rec));
});

test('appendLedger：追加可回读、超上限滚动、内容合法 JSONL', async () => {
  const path = tmpLedger();
  const r = await buildLiveReport(fakeSources(), { switchOn: true, env: {} });
  const a = appendLedger(r, { ledgerPath: path, productionStorages: PROD, maxLines: LEDGER_MAX_LINES });
  assert.equal(a.appended, true);
  assert.equal(a.totalLines, 1);
  assert.equal(existsSync(path), true);
  appendLedger(r, { ledgerPath: path, productionStorages: PROD, maxLines: LEDGER_MAX_LINES });
  const b = appendLedger(r, { ledgerPath: path, productionStorages: PROD, maxLines: 2 });
  assert.equal(b.totalLines, 2);
  assert.equal(b.dropped, 1);
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  for (const l of lines) assert.equal(JSON.parse(l).schema, LIVE_SCHEMA);
  assert.equal(readLedgerTail(path, 5).length, 2);
});

test('appendLedger：生产 storages 内路径直接抛错，不产生任何文件', async () => {
  const r = await buildLiveReport(fakeSources(), { switchOn: true, env: {} });
  assert.throws(
    () => appendLedger(r, { ledgerPath: join(PROD, 'must-not-exist.jsonl'), productionStorages: PROD }),
    /LEDGER_IN_PRODUCTION_STORAGES/,
  );
  assert.equal(existsSync(join(PROD, 'must-not-exist.jsonl')), false);
});

test('deriveHeartbeat：没跑过绝不假报活性；2h 内 LIVE，逾时 STALE', () => {
  assert.equal(deriveHeartbeat([]).status, 'NEVER_RUN');
  assert.equal(deriveHeartbeat(null).status, 'NEVER_RUN');
  const now = new Date('2026-11-07T22:00:00Z');
  const tail = [{ ts: '2026-11-07T21:30:00Z', gate: 'DEFAULT_DENY' }];
  assert.equal(deriveHeartbeat(tail, now).status, 'LIVE');
  assert.equal(deriveHeartbeat(tail, now).ticks, 1);
  const old = [{ ts: '2026-11-07T19:00:00Z', gate: 'DEFAULT_DENY' }];
  assert.equal(deriveHeartbeat(old, now).status, 'STALE');
  assert.equal(deriveHeartbeat(old, now).ageHours, 3);
  assert.equal(deriveHeartbeat([{ ts: 'not-a-date' }], now).status, 'UNKNOWN');
});
