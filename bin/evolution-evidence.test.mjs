// bin/evolution-evidence.test.mjs —— 进化证据体检的测试
//
// ⭐ 全部用例围绕一条纪律：**空数据必须说「无数据 + 原因」，绝不说 0**。
//    并且严格区分两种零：
//      · 表在、0 行 / 列在、0 条标注  ⇒ 真 0，可以报 0
//      · 表不存在 / 列不存在         ⇒ 无数据，必须报 null + reason
//    把后者报成 0，等于把「压根没采这个字段」说成「查过了、一条没有」。
//
// ⛔ 另一条重点：存储根不显式给就抛错。本机最常见的假绿是
//    DSH_HOME 为空时静默落到 ~/.dsh 的另一套副本，打印一片绿但检的不是线上对象。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ok,
  noData,
  tableExists,
  unavailable,
  isoWeek,
  weeklyDedup,
  oracleEvidence,
  growthEvidence,
  capabilityEvidence,
  curriculumEvidence,
  loopEvidence,
  anchorEvidence,
  buildEvidence,
  sectionStatus,
  renderMarkdown,
  readDomain,
  resolveStorages,
  compareEvidence,
  classifyChange,
  renderComparison,
  EVIDENCE_SCHEMA,
  FIT_GATES,
  SECTIONS,
} from './evolution-evidence.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'evolution-evidence.mjs');

const D = Object.freeze({
  agint_aesthetic_oracle: { ok: true, reason: null },
  agint_evolution: { ok: true, reason: null },
  agint_evolve: { ok: true, reason: null },
  agint_self_model: { ok: true, reason: null },
  agint_curriculum: { ok: true, reason: null },
});

/** 造一个假存储根（每个域一个 json）。 */
function makeStorages(domains) {
  const root = mkdtempSync(join(tmpdir(), 'evolution-evidence-'));
  for (const [name, tables] of Object.entries(domains)) {
    writeFileSync(join(root, `${name}.json`), JSON.stringify({ unit: { name, version: 1 }, tables }), 'utf8');
  }
  return root;
}

/** 断言某指标是「无数据」且带指定原因片段。 */
function assertEmpty(m, name, reasonFragment = null) {
  assert.equal(m.value, null, `${name} 的 value 必须是 null，不能是 0（0 会被读成「查过了，是零」）`);
  assert.ok(m.reason, `${name} 必须带 reason —— 说不清为什么没数据的报告等于没有报告`);
  if (reasonFragment) {
    assert.match(m.reason, new RegExp(reasonFragment), `${name} 的 reason 应含「${reasonFragment}」，实为：${m.reason}`);
  }
}

/** 造一条 oracle 广播。 */
function broadcast(ts, over = {}) {
  return {
    id: `b-${ts}`, kind: 'daily', ts, outcome: 'ok', score: 99.9, verdict: 'flat',
    worstKey: 'confidence', composites: { noise: 0, confidence: 0.698, redundancy: 0, bloat: 0 },
    ...over,
  };
}

/** 造一条 outcome。 */
function outcome(contractId, over = {}) {
  return {
    contractId, measuredAt: '2026-10-13T02:15:38.398Z', targetMetric: 'SUCCESS_RATE',
    actualDelta: 0, predictedDelta: 1, predictionQuality: 0.28162605983880346,
    isDeadZone: true, ...over,
  };
}

// ── 纪律 1：三态形状 ──────────────────────────────────────────────────────

test('⛔ ok() 永不产生 reason，noData() 永不产生数值 value', () => {
  const a = ok(0, 3);
  assert.equal(a.value, 0);
  assert.equal(a.reason, null);
  const b = noData('WHY');
  assert.equal(b.value, null);
  assert.match(b.reason, /WHY/);
  assert.equal(b.sampleSize, 0);
});

test('⛔ 域不可读 ⇒ 整组指标全部是「无数据 + 原因」，没有一个 0', () => {
  const m = unavailable({ agint_evolve: { reason: 'STORAGE_MISSING: /x 不存在' } }, 'agint_evolve', ['a', 'b', 'c']);
  for (const [k, v] of Object.entries(m)) assertEmpty(v, k, /DOMAIN_UNAVAILABLE\(agint_evolve\)/);
});

test('⛔ buildEvidence 在五个域全不可读时，6 组全是 NO_DATA，且 gaps 覆盖每组', () => {
  const domains = Object.fromEntries(Object.keys(D).map((k) => [k, {
    ok: false, reason: `STORAGE_MISSING: ${k}.json 不存在`, tables: {}, rows: {},
  }]));
  const r = buildEvidence({ domains, storages: '/fake', generatedAt: 'T' });
  assert.equal(r.readiness.noData, SECTIONS.length);
  assert.equal(r.readiness.complete, 0);
  assert.ok(r.gaps.length >= SECTIONS.length * 3, `缺口要逐组逐项列出，实得 ${r.gaps.length}`);
  for (const g of r.gaps) assert.ok(g.reason && g.reason.length > 0);
  const md = renderMarkdown(r);
  assert.match(md, /\*\*无数据\*\*/);
  assert.doesNotMatch(md, /- proposals：0 _\(n=/, '域不可读时不得把提案数印成 0');
});

test('⛔ sectionStatus 区分全空 / 部分空 / 全有值', () => {
  assert.equal(sectionStatus({ a: noData('x'), b: noData('y') }), 'NO_DATA');
  assert.equal(sectionStatus({ a: ok(1, 1), b: noData('x') }), 'PARTIAL');
  assert.equal(sectionStatus({ a: ok(1, 1), b: ok(0, 0) }), 'COMPLETE');
});

// ── 纪律 2：真 0 ≠ 无数据（判尺标注） ─────────────────────────────────────

test('⛔ 0 条人工标注是真 0，必须报 0 而不是「无数据」', () => {
  const tables = { oracle_broadcasts: { 1: broadcast('2026-10-06T01:00:00.000Z'), 2: broadcast('2026-10-13T01:00:00.000Z') } };
  const m = oracleEvidence(tables, D);
  assert.equal(m.annotatedVerdictWeeks.value, 0, '查过 2 个独立周、确实没人标 ⇒ 真 0');
  assert.equal(m.annotatedOverallWeeks.value, 0);
  assert.equal(m.thresholdFitReady.value, false);
  assert.equal(m.weightFitReady.value, false);
  assert.equal(m.independentWeeks.value, 2);
  assert.equal(m.versionTraceable.value.withVersion, 0, '广播行没带 formulaVersion/scaleHash 也要如实报，不替文档圆场');
});

test('⛔ oracle_broadcasts 表不存在 / 0 行 ⇒ 才是「无数据」，不能报 0 条广播', () => {
  assertEmpty(oracleEvidence({}, D).broadcasts, 'broadcasts', /NO_BROADCAST_TABLE/);
  assertEmpty(oracleEvidence({ oracle_broadcasts: {} }, D).broadcasts, 'broadcasts', /NO_BROADCASTS/);
});

test('✅ ISO 周去重与 calibration.mjs 同口径（同周 daily 只算 1 个独立样本）', () => {
  assert.equal(isoWeek('2026-10-06T01:00:00.000Z'), '2026-W41');
  assert.equal(isoWeek('2026-10-07T09:00:00.000Z'), '2026-W41');
  assert.equal(isoWeek('2026-10-13T01:00:00.000Z'), '2026-W42');
  assert.equal(isoWeek('not-a-date'), '');
  const w = weeklyDedup([
    broadcast('2026-10-06T01:00:00.000Z'),
    broadcast('2026-10-07T01:00:00.000Z'),
    broadcast('2026-10-13T01:00:00.000Z'),
  ]);
  assert.equal(w.length, 2);
  assert.equal(w[0].week, '2026-W41');
  assert.equal(w[0].ts, '2026-10-07T01:00:00.000Z', '取该周最后一条');
});

test('⛔ humanOverall=flat 不算方向样本（与 calibration.mjs:167 对齐）', () => {
  const tables = { oracle_broadcasts: {
    1: broadcast('2026-10-06T01:00:00.000Z', { humanVerdict: 'noise', humanOverall: 'flat' }),
    2: broadcast('2026-10-13T01:00:00.000Z', { humanVerdict: 'bloat', humanOverall: 'better' }),
  } };
  const m = oracleEvidence(tables, D);
  assert.equal(m.annotatedVerdictWeeks.value, 2);
  assert.equal(m.annotatedOverallWeeks.value, 1, 'flat 不进方向样本');
  assert.equal(FIT_GATES.thresholds, 4);
  assert.equal(FIT_GATES.weights, 5);
});

// ── 纪律 3：字段缺失 ≠ 真 0（外部锚定） ───────────────────────────────────

test('⛔ labelAuthority 列压根不存在 ⇒ 「无数据」，绝不当「0 条外部锚定」', () => {
  const tables = {
    prediction_outcomes: { 1: outcome('c-1'), 2: outcome('c-2') },
    evolution_ledger: { 1: { seq: 1, contractId: 'c-1', anchorStatus: 'PENDING' } },
    benchmark_frozen_set: {},
  };
  const m = anchorEvidence(tables, D);
  assertEmpty(m.externalLabelAuthority, 'externalLabelAuthority', /NO_LABEL_AUTHORITY_FIELD/);
  assert.match(m.externalLabelAuthority.reason, /不当「0 条锚定」/);
  assert.equal(m.frozenSets.value, 0, '表在、0 行是真 0，可以报 0');
  assertEmpty(m.latestFrozenCount, 'latestFrozenCount', /NO_FROZEN_SET/);
});

test('✅ labelAuthority 列存在且全 UNSET ⇒ 真 0（查过且确实没有锚定）', () => {
  const tables = {
    prediction_outcomes: {
      1: outcome('c-1', { labelAuthority: 'UNSET' }),
      2: outcome('c-2', { labelAuthority: 'UNSET' }),
    },
    evolution_ledger: {}, benchmark_frozen_set: {},
  };
  const m = anchorEvidence(tables, D);
  assert.equal(m.externalLabelAuthority.value.anchored, 0);
  assert.equal(m.externalLabelAuthority.value.unset, 2);
  assert.equal(m.externalLabelAuthority.value.total, 2);
});

test('✅ 只有 GOLD / HELDOUT 算外部锚定（枚举对齐 scenario-tier.mjs）', () => {
  const tables = {
    prediction_outcomes: {
      1: outcome('c-1', { labelAuthority: 'GOLD' }),
      2: outcome('c-2', { labelAuthority: 'HELDOUT' }),
      3: outcome('c-3', { labelAuthority: 'UNSET' }),
    },
    evolution_ledger: {}, benchmark_frozen_set: {},
  };
  const v = anchorEvidence(tables, D).externalLabelAuthority.value;
  assert.equal(v.anchored, 2);
  assert.equal(v.unset, 1);
  assert.deepEqual(v.externalAuthorities, ['GOLD', 'HELDOUT']);
});

test('⛔ SILVER（系统自评）绝不算外部锚定 —— 防「选手当裁判」', () => {
  const tables = {
    prediction_outcomes: {
      1: outcome('c-1', { labelAuthority: 'SILVER' }),
      2: outcome('c-2', { labelAuthority: 'SILVER' }),
    },
    evolution_ledger: {}, benchmark_frozen_set: {},
  };
  const v = anchorEvidence(tables, D).externalLabelAuthority.value;
  assert.equal(v.anchored, 0, '自评标签一律不进 anchored');
  assert.equal(v.selfLabeled, 2);
  assert.equal(v.total, 2);
});

test('⛔ 非法枚举值单独计 unknown，不静默丢弃', () => {
  const tables = {
    prediction_outcomes: { 1: outcome('c-1', { labelAuthority: 'HUMAN_FROZEN' }) },
    evolution_ledger: {}, benchmark_frozen_set: {},
  };
  const v = anchorEvidence(tables, D).externalLabelAuthority.value;
  assert.equal(v.unknown, 1);
  assert.equal(v.anchored, 0);
});

test('⛔ prediction_outcomes 0 行 ⇒ 无数据，不是「无锚定」', () => {
  const m = anchorEvidence({ prediction_outcomes: {}, evolution_ledger: {}, benchmark_frozen_set: {} }, D);
  assertEmpty(m.externalLabelAuthority, 'externalLabelAuthority', /NO_OUTCOMES/);
});

// ── 纪律 4：预测↔实测复用 growth-report，不重算 ───────────────────────────

test('⛔ growth 组直接透传 buildGrowthReport 的现成 PQ，不二次实现', () => {
  const tables = {
    evolution_ledger: { 1: { seq: 1, contractId: 'c-1', timestamp: '2026-09-01T00:00:00.000Z', summary: { decision: 'AUTO_DEPLOY' } } },
    prediction_outcomes: { 1: outcome('c-1') },
  };
  const m = growthEvidence(tables, D, 'T');
  assert.equal(m.predictionAccuracy.value.meanPQ, 0.28162605983880346,
    '现成 PQ 是权威值；若被本地重算覆盖，体检与 driver 的分就会不一致');
  assert.equal(m.outcomes.value, 1);
  assert.equal(m.linkage.value.linked, 1);
  assert.equal(m.growthHasData.value, true,
    '⛔ 不得把「没传 mountTables」造成的 rollbacks 缺口算进来 —— 那是脚本自造的假缺口');
  assert.equal(m.growthGapCount.value, 0);
  assert.ok(m._caveats.some((c) => c.metric === 'growthHasData' && /不是同一个量/.test(c.text)),
    '口径差异必须写进 caveat，否则会有人拿它和 growth-report --json 的 hasData 对拍');
});

test('⛔ outcomes 0 行 ⇒ predictionAccuracy 是「无数据」，不得出现 0.000', () => {
  const m = growthEvidence({ evolution_ledger: { 1: { seq: 1, contractId: 'c-1' } }, prediction_outcomes: {} }, D, 'T');
  assertEmpty(m.predictionAccuracy, 'predictionAccuracy', /NO_OUTCOMES/);
  assertEmpty(m.outcomes, 'outcomes', /NO_OUTCOMES/);
});

// ── 纪律 5：其余三组的正常路径与空表 ──────────────────────────────────────

test('✅ 能力图谱：三态分布、已验证、有证据的行数都能读出', () => {
  const tables = { capability_map: {
    1: { status: 'CANNOT', confidence: 0.5, evidenceRefs: ['policy-abstain'], lastVerifiedAt: '2026-11-06T14:51:22.613Z' },
    2: { status: 'UNCERTAIN', confidence: 0, evidenceRefs: [], lastVerifiedAt: '' },
  } };
  const m = capabilityEvidence(tables, D);
  assert.equal(m.capabilities.value, 2);
  assert.equal(m.statusBreakdown.value.CANNOT, 1);
  assert.equal(m.statusBreakdown.value.UNCERTAIN, 1, 'UNCERTAIN 是独立一态，不许读成「能力为零」');
  assert.equal(m.verifiedRows.value, 1);
  assert.equal(m.evidenceBackedRows.value, 1);
});

test('⛔ 能力图谱表不存在 / 0 行 ⇒ 无数据，不是「0 个能力」', () => {
  assertEmpty(capabilityEvidence({}, D).capabilities, 'capabilities', /NO_CAPABILITY_TABLE/);
  assertEmpty(capabilityEvidence({ capability_map: {} }, D).capabilities, 'capabilities', /NO_CAPABILITIES/);
});

test('✅ 课程：有 attempt 的挑战数按 challengeId 关联，题目去重单独报', () => {
  const tables = {
    challenges: {
      1: { id: 'c1', prompt: '题目甲', status: 'passed', level: 'D1', attemptCount: 1 },
      2: { id: 'c2', prompt: '题目甲', status: 'open', level: 'D1', attemptCount: 0 },
      3: { id: 'c3', prompt: '题目乙', status: 'open', level: 'D2', attemptCount: 0 },
    },
    attempts: { 1: { challengeId: 'c1', result: 'pass' } },
  };
  const m = curriculumEvidence(tables, D);
  assert.equal(m.challenges.value, 3);
  assert.equal(m.attempts.value, 1);
  assert.equal(m.challengesWithAttempt.value, 1);
  assert.equal(m.uniquePrompts.value, 2, '重复题目只报数，不替人下「课程没跑起来」的结论');
  assert.equal(m.openChallenges.value, 2);
  assert.equal(m.levelBreakdown.value.D2, 1);
});

test('⛔ 课程表全缺 ⇒ 整组无数据', () => {
  const m = curriculumEvidence({}, D);
  for (const [k, v] of Object.entries(m)) assertEmpty(v, k, /NO_CURRICULUM_TABLES|NO_CHALLENGES/);
});

test('✅ 闭环：成功判据是 state=succeeded && ok=true，oracle 提案单独计数', () => {
  const tables = {
    proposal: {
      1: { id: 'p1', source: 'agint-aesthetic-oracle', status: 'applied' },
      2: { id: 'p2', source: 'other', status: 'proposed' },
    },
    execution: {
      1: { proposalId: 'p1', state: 'succeeded', ok: true },
      2: { proposalId: 'p2', state: 'failed', ok: false },
      3: { proposalId: 'p1', state: 'succeeded', ok: false },
    },
  };
  const m = loopEvidence(tables, D);
  assert.equal(m.proposals.value, 2);
  assert.equal(m.succeededExecutions.value, 1, 'ok=false 的 succeeded 不算成功（周额度口径）');
  assert.equal(m.oracleProposals.value, 1);
  assert.equal(m.oracleSucceeded.value, 1);
});

test('⛔ proposal 表 0 行 ⇒ 无数据，不是「0 条提案」', () => {
  assertEmpty(loopEvidence({ proposal: {}, execution: {} }, D).proposals, 'proposals', /NO_PROPOSALS/);
});

test('⛔ tableExists 认 dict 与 array 两种形状（Array.isArray 单判会漏真数据）', () => {
  assert.equal(tableExists({ t: { 1: {} } }, 't'), true);
  assert.equal(tableExists({ t: [] }, 't'), true);
  assert.equal(tableExists({}, 't'), false);
});

// ── 纪律 6：存储根绝不 fallback ───────────────────────────────────────────

test('⛔ 无 --storages 且无 DSH_HOME/AGINT_DATA_HOME ⇒ 抛错，拒绝落到 ~/.dsh', () => {
  assert.throws(() => resolveStorages(null, {}), /NO_STORAGE_ROOT/);
  assert.throws(() => resolveStorages(null, { HOME: '/home/x' }), /NO_STORAGE_ROOT/);
});

test('✅ 显式 --storages 优先；否则从 DSH_HOME / AGINT_DATA_HOME 推导', () => {
  assert.equal(resolveStorages('/explicit', { DSH_HOME: '/env' }), '/explicit');
  assert.equal(resolveStorages(null, { DSH_HOME: '/env' }), join('/env', 'storages'));
  assert.equal(resolveStorages(null, { AGINT_DATA_HOME: '/env2' }), join('/env2', 'storages'));
});

test('⛔ 端到端：没给存储根时 exit 1（不是打印一片绿的假成功）', () => {
  const r = spawnSyncSafe([SCRIPT, '--json'], {});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /NO_STORAGE_ROOT/);
});

// ── 纪律 7：端到端 / 只读 / 渲染 ──────────────────────────────────────────

/** 不带任何 DSH_HOME 等变量跑子进程（env 完全替换为给定对象）。 */
function spawnSyncSafe(args, env) {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', env });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function run(args, env = {}) {
  return execFileSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: '', AGINT_DATA_HOME: '', ...env },
  });
}

/** 临时目录内容指纹，用来证明「脚本没写过存储」。 */
function fingerprint(dir) {
  return readdirSync(dir).sort().map((f) => `${f}:${createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')}`).join('|');
}

test('⛔ 端到端：--json 输出 6 组，且跑完存储目录逐字节不变（只读）', () => {
  const dir = makeStorages({
    agint_aesthetic_oracle: { oracle_broadcasts: { 1: broadcast('2026-10-06T01:00:00.000Z') } },
    agint_evolution: {
      evolution_ledger: { 1: { seq: 1, contractId: 'c-1', anchorStatus: 'PENDING' } },
      prediction_outcomes: { 1: outcome('c-1') },
      benchmark_frozen_set: {},
    },
    agint_evolve: { proposal: { 1: { id: 'p1', source: 'agint-aesthetic-oracle', status: 'applied' } }, execution: {} },
    agint_self_model: { capability_map: { 1: { status: 'CANNOT', evidenceRefs: [], lastVerifiedAt: '' } } },
    agint_curriculum: { challenges: { 1: { id: 'c1', prompt: 'p', status: 'open', level: 'D1' } }, attempts: {} },
  });
  try {
    const before = fingerprint(dir);
    const r = JSON.parse(run([SCRIPT, '--storages', dir, '--json']));
    assert.equal(fingerprint(dir), before, '⛔ 体检脚本不许写任何存储文件');
    assert.equal(Object.keys(r.sections).length, 6);
    assert.equal(r.source.storages, dir);
    assert.equal(r.source.domains.agint_evolution.rows.prediction_outcomes, 1);
    assert.equal(r.sections.oracle.metrics.annotatedVerdictWeeks.value, 0);
    assert.equal(r.sections.anchor.metrics.externalLabelAuthority.value, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⛔ 端到端：--out 落盘内容与 stdout 渲染一致（只差注入时间戳）', () => {
  const dir = makeStorages({ agint_evolution: { evolution_ledger: {}, prediction_outcomes: {} } });
  try {
    const outPath = join(dir, 'nested', 'evidence.md');
    run([SCRIPT, '--storages', dir, '--out', outPath]);
    const written = readFileSync(outPath, 'utf8');
    const printed = run([SCRIPT, '--storages', dir]);
    const strip = (s) => s.replace(/生成时间：[^\n]*/, '生成时间：X');
    assert.equal(strip(written), strip(printed), '写到文件的必须是同一份渲染结果');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⛔ 端到端：报告自带「不回答有没有在进化」与「不把缺数据渲染成 0」声明', () => {
  const dir = makeStorages({});
  try {
    const md = run([SCRIPT, '--storages', dir]);
    assert.match(md, /不回答「AGINT 有没有在进化」/);
    assert.match(md, /\*\*无数据\*\*/);
    assert.match(md, /不表示「效果为零」/);
    assert.match(md, /从不把缺数据渲染成 0/);
    assert.match(md, /判据就绪度：/);
    assert.match(md, /数据源（跨机器对拍用）/);
    // 所有 5 个域文件都不存在 ⇒ 数据源段必须逐个说「不可读」
    assert.match(md, /不可读/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⛔ 端到端：全部域文件缺失仍是合法报告，exit 0（「无数据」不是失败）', () => {
  const dir = makeStorages({});
  try {
    const r = JSON.parse(run([SCRIPT, '--storages', dir, '--json']));
    assert.equal(r.readiness.noData, 6);
    assert.equal(r.readiness.complete, 0);
    assert.ok(r.gaps.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⛔ 端到端：坏 JSON 的存储域 ⇒ 该组无数据，脚本不崩', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evolution-evidence-bad-'));
  try {
    writeFileSync(join(dir, 'agint_evolution.json'), '{ broken', 'utf8');
    const r = JSON.parse(run([SCRIPT, '--storages', dir, '--json']));
    assert.equal(r.sections.growth.status, 'NO_DATA');
    assert.match(r.gaps.find((g) => g.section === 'growth').reason, /UNPARSEABLE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⛔ readDomain 的行数元信息要能用于跨机器对拍', () => {
  const dir = makeStorages({
    agint_curriculum: { challenges: { 1: { id: 'c1' }, 2: { id: 'c2' } }, attempts: {} },
  });
  try {
    const d = readDomain(dir, 'agint_curriculum');
    assert.equal(d.ok, true);
    assert.equal(d.rows.challenges, 2);
    assert.equal(d.rows.attempts, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 纪律 8：时间序列对拍（--compare） ────────────────────────────────────

/** 造一份六组齐全的假体检报告。 */
function allSections(mutate = () => ({})) {
  return Object.fromEntries(SECTIONS.map((s) => [s.key, {
    title: s.title, status: 'COMPLETE', metrics: { x: ok(1, 1), y: ok(0, 0), ...mutate(s.key) },
  }]));
}

function fakeReport(over = {}) {
  return {
    schemaVersion: over.schemaVersion ?? EVIDENCE_SCHEMA,
    generatedAt: over.generatedAt ?? 'T0',
    source: { storages: '/fake', domains: {} },
    sections: over.sections ?? allSections(),
    gaps: over.gaps ?? [],
    notes: [],
    readiness: over.readiness ?? { complete: 6, partial: 0, noData: 0, total: 6 },
  };
}

test('⛔ classifyChange：只有两侧都是有限数字才给 Δ，其余恒 null', () => {
  assert.equal(classifyChange(ok(1, 1), ok(3, 1)).delta, 2);
  assert.equal(classifyChange(ok(3, 1), ok(1, 1)).delta, -2);
  assert.equal(classifyChange(ok(2, 1), ok(2, 1)).kind, 'NUMERIC_FLAT');
  assert.equal(classifyChange(noData('x'), ok(0, 0)).delta, null);
  assert.equal(classifyChange(ok(1, 1), noData('x')).delta, null);
  assert.equal(classifyChange(ok(false, 1), ok(true, 1)).delta, null);
  assert.equal(classifyChange(ok({ a: 1 }, 1), ok({ a: 2 }, 1)).delta, null);
});

test('⛔ null→0 只能算「采集覆盖变好」，绝不算数值上涨 / 能力变化', () => {
  const c = classifyChange(noData('没采'), ok(0, 0));
  assert.equal(c.kind, 'APPEARED');
  assert.equal(c.delta, null, '⛔ 不许虚构一个 Δ=0');
  assert.match(c.note, /不是数值上涨/);
  assert.match(c.note, /null→0/);
});

test('⛔ 有值→无数据是覆盖退化，不是归零', () => {
  const c = classifyChange(ok(7, 1), noData('读不到了'));
  assert.equal(c.kind, 'DISAPPEARED');
  assert.equal(c.delta, null);
  assert.match(c.note, /不是数值归零/);
});

test('⛔ 两侧类型不同 ⇒ TYPE_CHANGED，不得当涨跌', () => {
  const c = classifyChange(ok(1, 1), ok('1', 1));
  assert.equal(c.kind, 'TYPE_CHANGED');
  assert.match(c.note, /不得当作涨跌/);
});

test('✅ classifyChange 覆盖其余分类（布尔 / 对象子字段 / 两侧仍无数据）', () => {
  assert.equal(classifyChange(ok(false, 1), ok(true, 1)).kind, 'BOOLEAN_CHANGED');
  const obj = classifyChange(ok({ a: 1 }, 1), ok({ a: 2, b: 3 }, 1));
  assert.equal(obj.kind, 'OBJECT_CHANGED');
  assert.deepEqual(obj.fields.map((f) => f.key), ['a', 'b']);
  assert.equal(classifyChange(noData('x'), noData('y')).kind, 'STILL_NO_DATA');
  assert.equal(classifyChange(ok('a', 1), ok('a', 1)).kind, 'UNCHANGED');
});

test('✅ compareEvidence：完全相同的两份基线 ⇒ 0 项变化', () => {
  const r = compareEvidence(fakeReport({ generatedAt: 'T0' }), fakeReport({ generatedAt: 'T1' }));
  assert.equal(r.summary.changed, 0);
  assert.equal(r.summary.totalMetrics, 12, '6 组 × 2 指标');
  assert.equal(r.summary.unchanged, 12);
  assert.equal(r.baselineGeneratedAt, 'T0');
  assert.equal(r.currentGeneratedAt, 'T1');
});

test('✅ compareEvidence：数值上涨、覆盖变好、缺口消解都要分开计数', () => {
  const b = fakeReport({
    generatedAt: 'T0',
    sections: allSections((k) => (k === 'oracle' ? { x: ok(1, 1), y: noData('没采') } : {})),
    gaps: [{ section: 'oracle', metric: 'y', reason: '没采', sampleSize: 0 }],
    readiness: { complete: 5, partial: 1, noData: 0, total: 6 },
  });
  const c = fakeReport({
    generatedAt: 'T1',
    sections: allSections((k) => (k === 'oracle' ? { x: ok(3, 1), y: ok(0, 0) } : {})),
    readiness: { complete: 6, partial: 0, noData: 0, total: 6 },
  });
  const r = compareEvidence(b, c);
  assert.equal(r.summary.numericUp, 1);
  assert.equal(r.summary.coverageImproved, 1);
  assert.equal(r.summary.coverageRegressed, 0);
  assert.deepEqual(r.gaps.resolved, ['oracle.y']);
  assert.deepEqual(r.gaps.introduced, []);
  assert.equal(r.readiness.before.complete, 5);
  assert.equal(r.readiness.after.complete, 6);
  const up = r.changes.find((x) => x.section === 'oracle' && x.metric === 'x');
  assert.equal(up.delta, 2);
  const appeared = r.changes.find((x) => x.section === 'oracle' && x.metric === 'y');
  assert.equal(appeared.kind, 'APPEARED');
  assert.equal(appeared.delta, null);
});

test('⛔ compareEvidence：跨 schema / 非体检报告 ⇒ 抛错，不静默对拍', () => {
  assert.throws(() => compareEvidence(fakeReport({ schemaVersion: '0.9' }), fakeReport()), /COMPARE_SCHEMA_MISMATCH/);
  assert.throws(() => compareEvidence({}, fakeReport()), /COMPARE_NOT_EVIDENCE/);
  assert.throws(() => compareEvidence({ sections: {}, gaps: [] }, fakeReport()), /COMPARE_SCHEMA_MISMATCH/);
});

test('⛔ compareEvidence：基线缺整组 ⇒ 标 MISSING_IN_BASELINE，不当作「变好」', () => {
  const sec = allSections();
  delete sec.anchor;
  const r = compareEvidence(fakeReport({ sections: sec }), fakeReport());
  assert.ok(r.summary.schemaDrift >= 1);
  assert.ok(r.changes.some((c) => c.kind === 'MISSING_IN_BASELINE' && c.section === 'anchor'));
});

test('⛔ renderComparison 明确写着「不判进化变好/变差」，且列出 kind', () => {
  const r = compareEvidence(
    fakeReport({ sections: allSections((k) => (k === 'loop' ? { x: ok(1, 1) } : {})) }),
    fakeReport({ sections: allSections((k) => (k === 'loop' ? { x: ok(9, 1) } : {})) }),
  );
  const md = renderComparison(r).join('\n');
  assert.match(md, /不判「进化变好 \/ 变差」/);
  assert.match(md, /采集覆盖变好，不是数值上涨/);
  assert.match(md, /loop\.x/);
  assert.match(md, /NUMERIC_UP/);
  assert.match(md, /Δ=\+8/);
});

test('⛔ 端到端：--compare 在 md 与 json 里都带对拍段，且 exit 0', () => {
  const dir = makeStorages({ agint_evolution: { evolution_ledger: {}, prediction_outcomes: {} } });
  try {
    const baseline = join(dir, 'baseline.json');
    const cur = JSON.parse(run([SCRIPT, '--storages', dir, '--json']));
    writeFileSync(baseline, JSON.stringify(cur), 'utf8');
    const withCmp = JSON.parse(run([SCRIPT, '--storages', dir, '--json', '--compare', baseline]));
    assert.ok(withCmp.comparison);
    assert.equal(withCmp.comparison.summary.changed, 0, '同一份存储连跑两次 ⇒ 读数不该变');
    assert.match(run([SCRIPT, '--storages', dir, '--compare', baseline]), /与基线对拍（时间序列）/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⛔ 端到端：--compare 输入坏 / schema 不符 ⇒ exit 1，不打印假绿', () => {
  const dir = makeStorages({ agint_evolution: { evolution_ledger: {}, prediction_outcomes: {} } });
  try {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ broken', 'utf8');
    const r1 = spawnSyncSafe([SCRIPT, '--storages', dir, '--json', '--compare', bad], { PATH: process.env.PATH });
    assert.equal(r1.status, 1);
    assert.match(r1.stderr, /COMPARE_UNREADABLE/);

    const wrong = join(dir, 'wrong.json');
    writeFileSync(wrong, JSON.stringify({ schemaVersion: '0.1', sections: {}, gaps: [] }), 'utf8');
    const r2 = spawnSyncSafe([SCRIPT, '--storages', dir, '--json', '--compare', wrong], { PATH: process.env.PATH });
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /COMPARE_SCHEMA_MISMATCH/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
