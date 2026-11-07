#!/usr/bin/env node
/**
 * bin/oracle-runtime.test.mjs —— 受控链路接线的阴性对照
 *
 * ⛔ 核心要钉死的是「大胆接线 ≠ 放开写入」：
 *    默认 dry-run 零写入、演练域不得指向生产、合成真值不落冻结集、
 *    生产 storages / 冻结集 / 评分常量 / 人工标注 / LLM 五个计数恒 0。
 * ⛔ 顶层 import 必须放在 test() 之前（项目硬规则，撞 TDZ）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isoWeekKey, rowsOf, readDomainTables, readHistoricalPrescriptions,
  deriveAnchorAuthority, readRuntimeSources } from './oracle-runtime-sources.mjs';
import { assertRehearsalRoot, makeDryRunSink, describeSinks } from './oracle-runtime-sinks.mjs';
import { buildRuntimePlan, executeRuntimePlan, runRehearsal,
  SYNTHETIC_ANCHOR, SYNTHETIC_PRESCRIPTION } from './oracle-runtime.mjs';
import { DEFAULT_SETS_DIR, verifyBaseline } from './capability-baseline.mjs';
import { evaluateDeliveryAsync } from './oracle-prescription-delivery.mjs';

const TMP_BASE = process.env.TMPDIR || tmpdir();

function hashFile(p) {
  return existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : null;
}

/** 造一份隔离的 storages fixture（不碰线上对象）。 */
function fixture() {
  const dir = mkdtempSync(join(TMP_BASE, 'oracle-runtime-'));
  const storages = join(dir, 'storages');
  mkdirSync(storages);
  const broadcasts = {
    'w1': { kind: 'weekly', ts: '2026-10-05T02:00:00.000Z', proposals: 1, composites: { noise: { value: 0.1 } } },
    'w2': { kind: 'weekly', ts: '2026-10-12T02:00:00.000Z', proposals: 2, composites: { noise: { value: 0.2 } } },
    'd1': { kind: 'daily', ts: '2026-10-06T02:00:00.000Z', score: 90 },
  };
  writeFileSync(join(storages, 'agint_aesthetic_oracle.json'), `${JSON.stringify({
    unit: { name: 'agint_aesthetic_oracle', version: 1 }, tables: { oracle_broadcasts: broadcasts },
  }, null, 1)}\n`);
  const proposals = {
    'p1': { id: 'p1', title: '美谕提案：噪声比', source: 'agint-aesthetic-oracle', status: 'applied', body: '正文' },
    'p2': { id: 'p2', title: '人工提案', source: 'human', status: 'proposed', body: '正文' },
  };
  writeFileSync(join(storages, 'agint_evolve.json'), `${JSON.stringify({
    unit: { name: 'agint_evolve', version: 1 }, tables: { proposal: proposals },
  }, null, 1)}\n`);
  // ⛔ 2026-11-08：真实仓库已由委托机械真值填充（GOLD / READY）。
  //    给「0 标签 ⇒ UNSET」这类语义测试一份隔离空集，避免测试随仓库数据漂移。
  const setsEmpty = join(dir, 'sets-empty');
  mkdirSync(setsEmpty);
  for (const n of ['gold', 'verify', 'heldout']) {
    writeFileSync(join(setsEmpty, `${n}.json`), `${JSON.stringify({
      setName: n, setVersion: '1.0',
      authority: n === 'verify' ? 'VERIFY' : n.toUpperCase(),
      contentHash: '', samples: [],
    }, null, 2)}\n`);
  }
  return { dir, storages, setsEmpty };
}

function sourcesOf(f, setsDir = DEFAULT_SETS_DIR) {
  return readRuntimeSources({ storages: f.storages, setsDir, env: { DSH_HOME: f.dir } });
}

// ── 数据源层 ──────────────────────────────────────────────────────────────

test('isoWeekKey 用标准 ISO 周，跨年不串', () => {
  assert.equal(isoWeekKey('2026-11-07T00:00:00Z'), '2026-W45');
  assert.equal(isoWeekKey('2026-01-01T00:00:00Z'), '2026-W01');
  assert.equal(isoWeekKey('not-a-date'), null);
});

test('rowsOf 只收对象行，⛔ 不把元组迭代器当数组', () => {
  assert.deepEqual(rowsOf({ a: { x: 1 }, b: null, c: 3, d: { y: 2 } }),
    [{ id: 'a', x: 1 }, { id: 'd', y: 2 }]);
});

test('⛔ 无 --storages 且无 DSH_HOME ⇒ 抛错，拒绝 fallback 到 ~/.dsh', () => {
  assert.throws(() => readRuntimeSources({ env: {} }), /NO_STORAGE_ROOT/);
});

test('⛔ 域缺失记 unavailable（三态 null），不拿 0 冒充', () => {
  const f = fixture();
  try {
    const r = readDomainTables(f.storages, 'does_not_exist');
    assert.equal(r.ok, false);
    assert.match(r.reason, /DOMAIN_MISSING/);
    assert.deepEqual(r.tables, {});
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('⛔ 真 0 与「没测过」分开：0 冻结标签是真 0，标注周数也是真 0', () => {
  const f = fixture();
  try {
    const s = sourcesOf(f, f.setsEmpty);
    assert.equal(s.anchor.frozenLabels.value, 0, s.anchor.frozenLabels.reason);
    assert.equal(s.anchor.labelAuthority, 'UNSET', '0 标签绝不伪造 GOLD');
    assert.equal(s.anchor.available, false);
    assert.equal(s.annotations.independentWeeks, 2);
    assert.equal(s.oracle.weeklyCount, 2);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('⛔ 历史处方接真实 evolve.proposal：oracle 源 1 条、缺契约字段 ⇒ eligible=0', () => {
  const f = fixture();
  try {
    const h = readHistoricalPrescriptions(f.storages, { anchorAvailable: false });
    assert.equal(h.ok, true);
    assert.equal(h.total, 1);
    assert.equal(h.eligible, 0);
    assert.ok(h.missingFields.includes('predictedDelta'));
    assert.ok(h.missingFields.includes('predictedDeltaSource'));
    const s = sourcesOf(f);
    assert.equal(s.oracle.crossCheck.broadcastWeeklyProposalCount, 3);
    assert.equal(s.oracle.crossCheck.evolveOracleProposals, 1);
    assert.equal(s.oracle.crossCheck.consistent, false, 'fixture 故意让两域不一致，交叉对拍应判不一致');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('⛔ deriveAnchorAuthority：0 标签恒 UNSET；读不到合法 authority 也不猜 GOLD', () => {
  const f = fixture();
  try {
    assert.equal(deriveAnchorAuthority(f.setsEmpty, verifyBaseline(f.setsEmpty)), 'UNSET');
    assert.equal(deriveAnchorAuthority('/definitely/not/exist', { usableFrozenLabels: { value: 3 } }), 'UNSET');
    // 真实仓库当前是委托机械真值（GOLD）⇒ 只钉「返回合法外部枚举」，不钉具体状态。
    const real = deriveAnchorAuthority(DEFAULT_SETS_DIR, verifyBaseline(DEFAULT_SETS_DIR));
    assert.ok(['UNSET', 'GOLD', 'HELDOUT'].includes(real), `real=${real}`);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('⛔ 处方来源若带上 anchorAvailable=true 仍缺字段 ⇒ 还是 0 条可用', () => {
  const f = fixture();
  try {
    const h = readHistoricalPrescriptions(f.storages, { anchorAvailable: true });
    assert.equal(h.eligible, 0, '锚齐备也不能替代 predictedDelta 契约字段');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

// ── sink 安全闸 ───────────────────────────────────────────────────────────

test('⛔ 演练域等于生产 storages ⇒ 未 approve 一律拒绝', () => {
  const f = fixture();
  try {
    const r = assertRehearsalRoot(f.storages, f.storages, { approve: false });
    assert.equal(r.ok, false);
    assert.match(r.reason, /SINK_ROOT_IS_PRODUCTION/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('⛔ 演练域是生产 storages 的子目录也拒绝（不能钻空子）', () => {
  const f = fixture();
  try {
    const child = join(f.storages, 'rehearsal');
    mkdirSync(child);
    assert.equal(assertRehearsalRoot(child, f.storages, { approve: false }).ok, false);
    assert.equal(assertRehearsalRoot(child, f.storages, { approve: true }).ok, true);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('⛔ 目录不存在时拒绝构造 sink（不自动创建，避免误写）', () => {
  const f = fixture();
  try {
    const r = assertRehearsalRoot(join(f.dir, 'nope'), null, { approve: false });
    assert.equal(r.ok, false);
    assert.match(r.reason, /SINK_ROOT_NOT_EXISTS/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('makeDryRunSink 只记录载荷、零写入；describeSinks 列出两个真 sink', () => {
  const d = makeDryRunSink();
  const r = d.sink({ id: 'x', target: 'proposal_queue' });
  assert.equal(r.writes, 0);
  assert.equal(d.recorded.length, 1);
  assert.equal(d.writes, 0);
  assert.equal(describeSinks().available.length, 2);
});

// ── 编排器 ────────────────────────────────────────────────────────────────

test('⛔ 真实模式（空集锚）：无合格处方 ⇒ 信封拒、G1/G2 必拒、五个计数恒 0', () => {
  const f = fixture();
  try {
    const s = sourcesOf(f, f.setsEmpty);
    const plan = buildRuntimePlan(s, { env: {} });
    assert.equal(plan.synthetic, false);
    assert.equal(plan.envelope, null);
    assert.equal(plan.envelopeResult.ok, false);
    assert.equal(plan.gateProbe.allowed, false);
    assert.ok(plan.blockers.some((b) => b.startsWith('G1_SWITCH_OFF')));
    assert.ok(plan.blockers.some((b) => b.startsWith('G2_NO_EXTERNAL_TRUTH')));
    assert.equal(plan.writesToProduction, 0);
    assert.equal(plan.frozenSetsWritten, 0);
    assert.equal(plan.llmCalls, 0);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('⛔ 锚到位（真实委托机械真值）但 G1 关 ⇒ 信封可造，五闸仍拒、写入恒 0', () => {
  const f = fixture();
  try {
    const s = sourcesOf(f, DEFAULT_SETS_DIR);
    const plan = buildRuntimePlan(s, { env: {} });
    assert.equal(plan.synthetic, false);
    assert.equal(plan.gateProbe.allowed, false, '⛔ 真值到位 ≠ 放行：G1 未开仍拒');
    assert.ok(plan.blockers.some((b) => b.startsWith('G1_SWITCH_OFF')));
    assert.equal(plan.writesToProduction, 0);
    assert.equal(plan.frozenSetsWritten, 0);
    assert.equal(plan.llmCalls, 0);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('✅ 演练模式：合成真值 + 开关 on ⇒ 信封 BUILT、五闸 ALLOWED（证明不是恒拒）', () => {
  const f = fixture();
  try {
    const s = sourcesOf(f);
    const plan = buildRuntimePlan(s, { synthetic: true, switchOn: true, env: {} });
    assert.equal(plan.synthetic, true);
    assert.equal(plan.envelopeResult.ok, true);
    assert.equal(plan.envelope.status, 'proposed');
    assert.equal(plan.gateProbe.allowed, true, plan.gateProbe.reason);
    assert.equal(plan.anchor.labelAuthority, 'GOLD');
    assert.equal(SYNTHETIC_ANCHOR.synthetic, true);
    assert.equal(SYNTHETIC_PRESCRIPTION.synthetic, true);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('⛔ 默认执行（dry-run）零写入；合成真值也不自动落参数', async () => {
  const f = fixture();
  try {
    const s = sourcesOf(f);
    const plan = buildRuntimePlan(s, { synthetic: true, switchOn: true });
    const r = await executeRuntimePlan(plan, { env: {} });
    assert.equal(r.sinkKind, 'dry-run');
    assert.equal(r.writes, 0);
    assert.equal(r.writesToProduction, 0);
    assert.equal(r.delivery.delivered, true, '五闸过了也只是记录信封，不是投递到生产');
    assert.equal(r.recordedEnvelopes, 1);
    assert.equal(plan.replay.applied, false);
    assert.equal(plan.replay.writes, 0);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('⛔ G5 人类否决：即便五闸其它全过，veto 立即拒绝投递', async () => {
  const f = fixture();
  try {
    const s = sourcesOf(f);
    const plan = buildRuntimePlan(s, { synthetic: true, switchOn: true, humanVeto: true });
    assert.equal(plan.gateProbe.allowed, false);
    const r = await executeRuntimePlan(plan, { env: {} });
    assert.equal(r.delivery.status, 'DEFAULT_DENY');
    assert.equal(r.writes, 0);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('⛔ 异步 sink 抛错 ⇒ SINK_ERROR、writes=0，绝不假装成功', async () => {
  const envelope = {
    status: 'proposed', id: 'x', target: 'proposal_queue', predictedDelta: 0,
    predictedDeltaSource: 'test', labelAuthority: 'GOLD', evidenceRef: 'test',
    frozenLabelCount: 1, body: 'test', asOf: null, schemaVersion: '1.0',
  };
  const r = await evaluateDeliveryAsync(envelope, {
    switchOn: true,
    sink: async () => { throw new Error('boom'); },
  });
  assert.equal(r.status, 'SINK_ERROR');
  assert.equal(r.writes, 0);
  assert.equal(r.delivered, false);
});

test('⛔ 端到端演练：隔离域真写入 + 生产域与冻结集逐字节不变', async () => {
  const f = fixture();
  const before = {
    evolve: hashFile(join(f.storages, 'agint_evolve.json')),
    oracle: hashFile(join(f.storages, 'agint_aesthetic_oracle.json')),
    sets: ['gold', 'verify', 'heldout'].map((n) => hashFile(join(DEFAULT_SETS_DIR, `${n}.json`))),
  };
  try {
    const s = sourcesOf(f);
    const root = join(f.dir, 'rehearsal', 'storages');
    const r = await runRehearsal(s, { rehearsalRoot: root });
    assert.equal(r.sinkGuard.ok, true, r.sinkGuard.reason);
    assert.equal(r.ok, true, `链路未跑通：${r.delivery.reason}`);
    assert.equal(r.delivery.status, 'DELIVERED_PROPOSED');
    assert.ok(r.rehearsal.persistedRecords >= 1, '隔离域回读必须至少有 1 条记录');
    assert.equal(r.writesToProduction, 0);
    assert.equal(r.frozenSetsWritten, 0);
    assert.equal(r.scoringConstantsWritten, 0);
    assert.equal(r.humanAnnotationsWritten, 0);
    assert.equal(r.llmCalls, 0);
    assert.equal(r.synthetic, true);
    assert.equal(hashFile(join(f.storages, 'agint_evolve.json')), before.evolve, '⛔ 生产提案域被改了');
    assert.equal(hashFile(join(f.storages, 'agint_aesthetic_oracle.json')), before.oracle, '⛔ 生产 oracle 域被改了');
    assert.deepEqual(['gold', 'verify', 'heldout'].map((n) => hashFile(join(DEFAULT_SETS_DIR, `${n}.json`))),
      before.sets, '⛔ 冻结集被合成真值污染了');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
