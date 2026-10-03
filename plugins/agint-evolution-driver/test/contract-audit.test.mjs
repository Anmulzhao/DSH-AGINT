/**
 * agint-evolution-driver: contract-audit.js —— §2.4.2 归档校验的调用点
 *
 * `verifyHypothesisLock` 这个纯函数早就有、也早有单测，缺的是**没人调它**。
 * 没人调 = 那把锁只防"改 predictedDelta 数值"这一种动作，不防：
 *   · 改完 hypothesis 的其它成分（targetMetric / changedPlugins / lockedAt）；
 *   · 直接把 `contract_locks` 的行删掉（链上却还写着 predictedDelta）。
 * 本文件把三向都钉住：正向（真锁必须验得过）+ 三种篡改/缺失各一条 + 一条"删行"反向。
 *
 * 夹具纪律：锁一律用 `computeHypothesisLock` **真算**出来。
 * 写死一个 hash 的夹具会让每一条都判红 —— 那是 mock 失真，不是被测对象有问题
 * （教训同 `bus.publish` 的 envelopeId：mock 必须复刻真实形状）。
 *
 * Run: node --test plugins/agint-evolution-driver/test/contract-audit.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createContractAuditor, auditOne, hypothesisFromEntry, AUDIT_STATUS } from '../lib/contract-audit.js';
import { computeHypothesisLock } from '../lib/predictor.js';
import { buildLockHypothesis } from '../lib/prediction-locker.js';

const LOCKED_AT = '2026-10-03T07:59:00.000Z';

function entryOver(over = {}) {
  return {
    seq: 3,
    contractId: 'EVO-A1',
    timestamp: '2026-10-03T08:00:00.000Z',
    summary: {
      mutationType: 'PROMPT_MUTATION',
      changedPlugins: ['agint-demo'],
      targetMetric: 'SUCCESS_RATE',
      predictedDelta: 3.0,
      predictionSource: 'DEFAULT_RULE',
      decision: 'AUTO_DEPLOY',
    },
    ...over,
  };
}

/** 与 lockPrediction 同一配方：条目字段复原 hypothesis + lockedAt ⇒ 同一个 hash。 */
function lockFromEntry(entry, over = {}) {
  const s = entry.summary;
  const hypothesis = {
    ...buildLockHypothesis({
      mutationType: s.mutationType,
      targetMetric: s.targetMetric,
      changedComponents: s.changedPlugins,
    }),
    predictedDelta: s.predictedDelta,
    predictionSource: s.predictionSource,
  };
  return {
    contractId: entry.contractId,
    hypothesisLock: computeHypothesisLock({ hypothesis, contractId: entry.contractId, createdAt: over.lockedAt ?? LOCKED_AT }),
    lockedAt: over.lockedAt ?? LOCKED_AT,
    predictionSource: s.predictionSource,
    ...over,
  };
}

function makeEvo({ locks = [], entries = [], failWith = null } = {}) {
  return {
    listContractLocks: async () => { if (failWith) throw new Error(failWith); return locks; },
    getContractLock: async (id) => locks.find((l) => l.contractId === id) ?? null,
    ledger: {
      list: async () => { if (failWith) throw new Error(failWith); return entries; },
      findByContractId: async (id) => entries.find((e) => e.contractId === id) ?? null,
    },
  };
}

function boot(evo) {
  const warns = [];
  const auditor = createContractAuditor({ get: (n) => (n === 'agint.evolution' ? evo : null) }, { warn: (m, e) => warns.push([m, e]) });
  return { auditor, warns };
}

// ── hypothesis 复原 ────────────────────────────────────────────────────

test('A1: 条目字段复原出的 hypothesis 与锁定时同形（changedPlugins 字符串 → [{pluginName}]）', () => {
  const built = hypothesisFromEntry(entryOver());
  assert.equal(built.ok, true);
  assert.deepEqual(built.hypothesis, {
    mutationType: 'PROMPT_MUTATION',
    targetMetric: 'SUCCESS_RATE',
    changedComponents: [{ pluginName: 'agint-demo' }],
    predictedDelta: 3.0,
    predictionSource: 'DEFAULT_RULE',
  });
});

test('A2: 缺哪个摘要成分就点名哪个（少字段直接重算会得到另一个 hash ⇒ 假篡改）', () => {
  const cases = [
    ['无预测', { predictedDelta: null }, ['predictedDelta']],
    [
      '指标 unspecified',
      { targetMetric: 'unspecified', predictedDelta: null, predictionSource: null },
      ['predictedDelta', 'predictionSource'],
    ],
    ['changedPlugins 缺失', { changedPlugins: undefined }, ['changedPlugins']],
    ['predictionSource 不在 enum', { predictionSource: 'GUESS' }, ['predictionSource']],
  ];
  for (const [label, patch, want] of cases) {
    const built = hypothesisFromEntry(entryOver({ summary: { ...entryOver().summary, ...patch } }));
    assert.equal(built.ok, false, `${label} 应复原不出来`);
    assert.equal(built.reason, 'UNEVIDENCED_HYPOTHESIS');
    assert.deepEqual(built.missing, want, label);
  }
});

test('A3: targetMetric 空串也算复原不出来（不是"指标叫空串"）', () => {
  const built = hypothesisFromEntry(entryOver({ summary: { ...entryOver().summary, targetMetric: '' } }));
  assert.deepEqual(built.missing, ['targetMetric']);
});

// ── auditOne 判定 ──────────────────────────────────────────────────────

test('B1: 正向 —— 真锁 + 原条目 ⇒ VERIFIED（这条证明判据不是恒红机器）', () => {
  const e = entryOver();
  const r = auditOne({ entry: e, lockRow: lockFromEntry(e) });
  assert.equal(r.status, AUDIT_STATUS.VERIFIED);
  assert.equal(r.reason, null);
  assert.match(r.recomputed, /^sha256:[0-9a-f]{64}$/);
  assert.equal(r.recomputed, r.storedLock);
});

test('B2: 篡改 predictedDelta ⇒ CONTRACT_TAMPERED', () => {
  const e = entryOver();
  const lock = lockFromEntry(e);
  const tampered = entryOver({ summary: { ...e.summary, predictedDelta: 9.9 } });
  const r = auditOne({ entry: tampered, lockRow: lock });
  assert.equal(r.status, AUDIT_STATUS.CONTRACT_TAMPERED);
  assert.notEqual(r.recomputed, r.storedLock);
});

test('B3: 篡改 targetMetric / changedPlugins 同样判红（改内容也是改预测）', () => {
  const e = entryOver();
  const lock = lockFromEntry(e);
  for (const patch of [
    { targetMetric: 'LATENCY' },
    { changedPlugins: ['agint-other'] },
    { changedPlugins: [] },
    { predictionSource: 'ANALOGY' },
  ]) {
    const r = auditOne({ entry: entryOver({ summary: { ...e.summary, ...patch } }), lockRow: lock });
    assert.equal(r.status, AUDIT_STATUS.CONTRACT_TAMPERED, JSON.stringify(patch));
  }
});

test('B4: lockedAt 是摘要成分 —— 改了时间戳 ⇒ 判红（时间不在摘要里就能事后换时间刷 hash）', () => {
  const e = entryOver();
  const lock = lockFromEntry(e);
  const r = auditOne({ entry: e, lockRow: { ...lock, lockedAt: '2027-01-01T00:00:00.000Z' } });
  assert.equal(r.status, AUDIT_STATUS.CONTRACT_TAMPERED);
});

test('B5: 缺行类判定 —— 没锁行 / 没条目 各归各因', () => {
  const e = entryOver();
  const a = auditOne({ entry: e, lockRow: null });
  assert.equal(a.status, AUDIT_STATUS.LOCK_ROW_MISSING);
  const b = auditOne({ entry: null, lockRow: lockFromEntry(e) });
  assert.equal(b.status, AUDIT_STATUS.LEDGER_ENTRY_MISSING);
  assert.equal(b.storedLock, lockFromEntry(e).hypothesisLock, '条目没了也要把表里的锁带出来给人查');
});

test('B6: 复原不出来时不硬判篡改，而是点名 UNEVIDENCED_HYPOTHESIS', () => {
  const e = entryOver({ summary: { ...entryOver().summary, predictionSource: null } });
  const r = auditOne({ entry: e, lockRow: lockFromEntry(entryOver()) });
  assert.equal(r.status, AUDIT_STATUS.UNEVIDENCED_HYPOTHESIS);
  assert.deepEqual(r.missing, ['predictionSource']);
});

// ── sweep ──────────────────────────────────────────────────────────────

test('C1: sweep 双向清点 —— 每行重算 + 链上带预测却没锁行的算缺失', async () => {
  const ok1 = entryOver({ contractId: 'EVO-1', seq: 1 });
  const ok2 = entryOver({ contractId: 'EVO-2', seq: 2 });
  const bad = entryOver({ contractId: 'EVO-3', seq: 3 });
  const orphan = entryOver({ contractId: 'EVO-4', seq: 4 });
  const locks = [lockFromEntry(ok1), lockFromEntry(ok2), lockFromEntry(bad)];
  locks[2] = { ...locks[2], hypothesisLock: `sha256:${'f'.repeat(64)}` }; // EVO-3 的锁与内容对不上
  const entries = [ok1, ok2, bad, orphan];
  const { auditor, warns } = boot(makeEvo({ locks, entries }));

  const r = await auditor.sweep();
  assert.equal(r.ok, true);
  assert.equal(r.checked, 3, '按锁表逐行重算');
  assert.equal(r.counts[AUDIT_STATUS.VERIFIED], 2);
  assert.equal(r.counts[AUDIT_STATUS.CONTRACT_TAMPERED], 1);
  assert.deepEqual(r.tampered.map((v) => v.contractId), ['EVO-3']);
  assert.deepEqual(r.orphanPredictions, [{ contractId: 'EVO-4', seq: 4, predictedDelta: 3.0 }]);
  assert.equal(r.counts[AUDIT_STATUS.LOCK_ROW_MISSING], 1, '删行也要计入 counts');
  assert.equal(warns.length, 0, 'sweep 只出数据，出声由 caller（cron）负责');
});

test('C2: 有锁行、链上没条目 ⇒ LEDGER_ENTRY_MISSING 进 unverifiable，不当通过', async () => {
  const e = entryOver({ contractId: 'EVO-9' });
  const { auditor } = boot(makeEvo({ locks: [lockFromEntry(e)], entries: [] }));
  const r = await auditor.sweep();
  assert.equal(r.checked, 1);
  assert.equal(r.counts[AUDIT_STATUS.LEDGER_ENTRY_MISSING], 1);
  assert.equal(r.unverifiable.length, 1);
  assert.deepEqual(r.tampered, []);
});

test('C3: 服务不可用 ⇒ ok:false + 理由（⛔ 缺失 ≠ "没有篡改"）', async () => {
  const { auditor } = boot(null);
  const r = await auditor.sweep();
  assert.equal(r.ok, false);
  assert.equal(r.status, AUDIT_STATUS.SERVICE_UNAVAILABLE);
  assert.equal(r.checked, 0);
  assert.match(r.reason, /listContractLocks/);

  const legacy = { ledger: { list: async () => [] } }; // 旧版服务：有 ledger，没 listContractLocks
  const r2 = await boot(legacy).auditor.sweep();
  assert.equal(r2.status, AUDIT_STATUS.SERVICE_UNAVAILABLE);
  assert.match(r2.reason, /listContractLocks/);
});

test('C4: 表里抛错也不抛（外壳）—— 返回 AUDIT_FAILED + warn 留痕', async () => {
  const { auditor, warns } = boot(makeEvo({ failWith: 'storage boom' }));
  const r = await auditor.sweep();
  assert.equal(r.ok, false);
  assert.equal(r.status, AUDIT_STATUS.AUDIT_FAILED);
  assert.match(r.reason, /storage boom/);
  assert.ok(warns.some(([m]) => /扫描异常/.test(m)));
});

test('C5: verifyContract 单条判定走同一配方（测量前那道门用的就是它）', async () => {
  const e = entryOver();
  const { auditor } = boot(makeEvo({ locks: [lockFromEntry(e)], entries: [e] }));
  const v = await auditor.verifyContract('EVO-A1');
  assert.equal(v.status, AUDIT_STATUS.VERIFIED, JSON.stringify(v));
  assert.equal(v.contractId, 'EVO-A1');
  const miss = await auditor.verifyContract('EVO-NONE');
  assert.equal(miss.status, AUDIT_STATUS.LOCK_ROW_MISSING, '表和链都没有 ⇒ 缺证据，不是通过');
  assert.equal(miss.recomputed, null);
});

test('C6: 空表 ⇒ checked 0、不报错（今天生产 contract_locks 就是 0 行）', async () => {
  const { auditor } = boot(makeEvo({ locks: [], entries: [] }));
  const r = await auditor.sweep();
  assert.equal(r.ok, true);
  assert.equal(r.checked, 0);
  assert.deepEqual(r.tampered, []);
  assert.deepEqual(r.counts, {});
});
