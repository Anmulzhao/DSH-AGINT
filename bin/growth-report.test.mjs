// bin/growth-report.test.mjs —— Growth Report 生成器的测试
//
// ⭐ 全部用例围绕一条纪律：**空数据必须说「无数据」，绝不说 0**。
//
//   为什么把它当唯一重点：`0` 与「没测过」在报告里长得一模一样，
//   而它们的意思相反。0% 成功率会让人以为系统在破坏东西、去查不存在的回归；
//   0.00 的平均 PQ 会让人以为预测能力为零、去废掉整个预测模块。
//   两个错误结论都比「不知道」贵得多。
//
// ⛔ 每个用例都断言**具体原因码**，不只是 value === null。
//   只断言 null 的话，把 reason 写成空串也能过 —— 而一份说不出
//   「为什么没数据」的报告等于没有报告。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildGrowthReport,
  renderMarkdown,
  readDomainTables,
  tableRows,
  selectEntries,
  generationRange,
  decisionBreakdown,
  rollbackCount,
  provenanceSplit,
  computeDeployRateTrend,
  predictionAccuracy,
  linkageCheck,
  collectGaps,
  EMPTY_REASONS,
} from './growth-report.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'growth-report.mjs');

// ── 夹具 ──────────────────────────────────────────────────────────────────

/** 造一条最小 ledger 条目。 */
function entry(seq, over = {}) {
  return {
    seq,
    contractId: `c-${seq}`,
    generation: 'GEN-000',
    summary: {
      mutationType: 'PROMPT_MUTATION',
      changedPlugins: [],
      targetMetric: 'SUCCESS_RATE',
      hypothesisDigest: 'd',
      predictedDelta: null,
      actualDelta: null,
      predictionQuality: null,
      predictionSource: null,
      decision: 'AUTO_DEPLOY',
    },
    chain: { entryHash: `sha256:${'0'.repeat(63)}${seq}`, parentHash: `sha256:${'0'.repeat(64)}`, batchRoot: `sha256:${'0'.repeat(64)}`, merkleRoot: `sha256:${'0'.repeat(64)}` },
    references: {},
    timestamp: `2026-09-${String(seq).padStart(2, '0')}T00:00:00.000Z`,
    anchorStatus: 'PENDING',
    anchorSeq: null,
    integrity: 'OK',
    reconstructed: false,
    evidenceCompleteness: null,
    ...over,
  };
}

/** 造一条最小 outcome 条目。 */
function outcome(contractId, over = {}) {
  return {
    contractId,
    measuredAt: '2026-09-30T00:00:00.000Z',
    method: 'TEST_CORPUS_PAIR_RUN',
    targetMetric: 'SUCCESS_RATE',
    changedPath: 'a.js',
    testFiles: ['a.test.mjs'],
    baseline: { passed: 10, failed: 1, total: 11, passRate: 10 / 11 },
    candidate: { passed: 11, failed: 0, total: 11, passRate: 1 },
    actualDelta: 9.1,
    predictedDelta: 5.0,
    predictionQuality: 0.8,
    isDeadZone: false,
    restoreVerified: true,
    ...over,
  };
}

/** 造一个假存储根目录。 */
function makeStorages(domains) {
  const root = mkdtempSync(join(tmpdir(), 'growth-report-'));
  for (const [name, doc] of Object.entries(domains)) {
    writeFileSync(join(root, `${name}.json`), JSON.stringify(doc), 'utf8');
  }
  return root;
}

function storagesWithLedger(entries, extra = {}) {
  return makeStorages({
    agint_evolution: { unit: { name: 'agint_evolution', version: 1 }, tables: { evolution_ledger: entries, ...extra } },
    agint_mount: { unit: { name: 'agint_mount', version: 1 }, tables: { rollback_log: {} } },
  });
}

/** 断言某指标是「无数据」且带指定原因。 */
function assertEmpty(metric, name, reasonFragment) {
  assert.equal(metric.value, null, `${name} 的 value 必须是 null，不能是 0（0 会被读成「效果为零」）`);
  assert.ok(metric.reason, `${name} 必须带 reason —— 说不清为什么没数据的报告等于没有报告`);
  if (reasonFragment) {
    assert.match(metric.reason, new RegExp(reasonFragment),
      `${name} 的 reason 应含「${reasonFragment}」，实为：${metric.reason}`);
  }
}

// ── 纪律 1：空 ledger ─────────────────────────────────────────────────────

test('⛔ ledger 空 ⇒ 每个指标都是「无数据 + 原因」，没有一个是 0', () => {
  const r = buildGrowthReport({ entries: [], outcomes: [], generatedAt: 'T' });
  for (const [k, m] of Object.entries(r.metrics)) {
    assertEmpty(m, k, null);
  }
  assert.ok(r.gaps.length >= 5, `缺口清单要覆盖全部指标，实得 ${r.gaps.length}`);
  assert.equal(r.hasData, false);
});

test('⛔ ledger 空的报告里不得出现「0%」「0.00」「0 次」这类数字结论', () => {
  const r = buildGrowthReport({ entries: [], outcomes: [], generatedAt: 'T' });
  const md = renderMarkdown(r);
  // 「无数据」行里带 n=0 是允许的（那是样本数，不是结论）；
  // 禁的是把 0 当成指标值印出来。
  assert.doesNotMatch(md, /决策总数：0 条/);
  assert.doesNotMatch(md, /部署率：0\.0%/);
  assert.doesNotMatch(md, /平均 PQ：\*\*0\.000\*\*/);
  assert.match(md, /\*\*无数据\*\*/, '必须显式印「无数据」');
});

test('⛔ 每个 EMPTY_REASONS 码都对应一个真实可达的空指标（不许有死码）', () => {
  const cases = [
    [EMPTY_REASONS.NO_LEDGER, buildGrowthReport({ entries: [], outcomes: [] })],
    [EMPTY_REASONS.NO_OUTCOMES, buildGrowthReport({ entries: [entry(1)], outcomes: [] })],
    [EMPTY_REASONS.FILTERED_OUT, buildGrowthReport({ entries: [entry(1)], outcomes: [], filter: { generation: 'GEN-999' } })],
  ];
  for (const [code, r] of cases) {
    const all = [...r.gaps.map((g) => g.reason)];
    assert.ok(all.includes(code), `原因码 ${code.slice(0, 40)} 没有任何指标会产生它 ⇒ 它是死码`);
  }
});

// ── 纪律 2：表不存在 ≠ 表 0 行 ───────────────────────────────────────────

test('⛔ prediction_outcomes 表整表缺失 ⇒ 理由说「无表」且标注不确定，不说「0 条」', () => {
  const dir = storagesWithLedger([entry(1), entry(2)]);
  try {
    const out = execFileSync(process.execPath, [SCRIPT, '--storages', dir, '--json'], { encoding: 'utf8' });
    const r = JSON.parse(out);
    assert.match(r.metrics.outcomes.reason, /OUTCOMES_TABLE_ABSENT/);
    assert.match(r.metrics.outcomes.reason, /不确定/,
      '宿主是否懒建这张表当前不确定，报告不能替它下「表不存在」的定论');
    assert.doesNotMatch(r.metrics.outcomes.reason, /0 条/,
      '「表不存在」与「表 0 行」是两件事，不能混着说');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('✅ outcomes 表存在且 0 行 ⇒ 说 NO_OUTCOMES（这次是真的「有表没数据」）', () => {
  const dir = storagesWithLedger([entry(1)], { prediction_outcomes: {} });
  try {
    const r = JSON.parse(execFileSync(process.execPath, [SCRIPT, '--storages', dir, '--json'], { encoding: 'utf8' }));
    assert.match(r.metrics.outcomes.reason, /NO_OUTCOMES/);
    assert.doesNotMatch(r.metrics.outcomes.reason, /TABLE_ABSENT/,
      '「有表 0 行」与「表不存在」必须能区分开');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 纪律 3：回滚数的真假 0 ───────────────────────────────────────────────

test('⛔ rollback_log 表不存在 ⇒ 回滚数是「无数据」，不是 0（别把「不知道」说成「没回滚过」）', () => {
  const m = rollbackCount({});
  assertEmpty(m, 'rollbacks', /NO_ROLLBACK_TABLE/);
});

test('✅ rollback_log 表存在且 0 行 ⇒ 回滚数是真 0，且这属 notes 不属 gaps', () => {
  const m = rollbackCount({ rollback_log: {} });
  assert.equal(m.value, 0, '表在、0 行是真 0，可以报 0');
  assert.match(m.caveat, /真 0/);
  const r = buildGrowthReport({ entries: [entry(1), entry(2)], outcomes: [], mountTables: { rollback_log: {} } });
  assert.ok(!r.gaps.some((g) => g.metric === 'rollbacks'),
    '真 0 不是缺口，不该出现在「不能回答什么」里');
  assert.ok(r.notes.some((n) => n.metric === 'rollbacks'),
    '真 0 需要 caveat，应落在「读报告时必须知道的事」里');
});

// ── 纪律 4：部署率的分母 ─────────────────────────────────────────────────

test('⛔ 部署率分母是全部决策，ABSTAIN 不得从分母剔除（否则部署率虚高）', () => {
  const m = decisionBreakdown([
    entry(1, { summary: { ...entry(1).summary, decision: 'AUTO_DEPLOY' } }),
    entry(2, { summary: { ...entry(2).summary, decision: 'ABSTAIN' } }),
    entry(3, { summary: { ...entry(3).summary, decision: 'ABSTAIN' } }),
    entry(4, { summary: { ...entry(4).summary, decision: 'ABSTAIN' } }),
  ]);
  assert.equal(m.value.total, 4);
  assert.equal(m.value.deployRate, 0.25, '1/4 而非 1/1');
});

test('⛔ 单条目不得算趋势（单点的「趋势」是编的）', () => {
  const m = computeDeployRateTrend([entry(1)]);
  assertEmpty(m, 'successRateTrend', /TREND_NEEDS_2/);
});

// ── 纪律 5：历史重建条目不能被读成「系统在变好」───────────────────────────

test('⛔ 全部条目 reconstructed ⇒ 趋势与来源都必须打「这不是学习曲线」的标记', () => {
  const entries = [entry(1, { reconstructed: true }), entry(2, { reconstructed: true })];
  const r = buildGrowthReport({ entries, outcomes: [] });
  assert.match(r.metrics.successRateTrend.caveat, /不是.*学习曲线/);
  assert.match(r.metrics.provenance.caveat, /reconstructed/);
  assert.ok(r.notes.some((n) => n.metric === 'successRateTrend'));
});

test('✅ 有实时条目 ⇒ 不加「不是学习曲线」的警告', () => {
  const entries = [entry(1, { reconstructed: true }), entry(2, { reconstructed: false })];
  const r = buildGrowthReport({ entries, outcomes: [] });
  assert.equal(r.metrics.successRateTrend.caveat, null);
  assert.equal(r.metrics.provenance.value.live, 1);
});

// ── 纪律 6：代际 ─────────────────────────────────────────────────────────

test('⛔ generation 缺失 ⇒ 代际区间是「无数据」，不是「GEN-000」', () => {
  const m = generationRange([entry(1, { generation: '' }), entry(2, { generation: undefined })]);
  assertEmpty(m, 'generationRange', /GENERATION_UNKNOWN/);
});

test('✅ 单一代际 ⇒ 报告印「仅 1 个取值，无代际跨度」而不是区间', () => {
  const r = buildGrowthReport({ entries: [entry(1), entry(2)], outcomes: [] });
  const md = renderMarkdown(r);
  assert.match(md, /GEN-000（仅 1 个取值，无代际跨度）/);
  assert.doesNotMatch(md, /GEN-000 … GEN-000/);
});

// ── 纪律 7：预测准确度不得凭空造分 ───────────────────────────────────────

test('⛔ outcome 有行但 predicted/actual 缺失 ⇒ 不得给 PQ，标 NO_SCORABLE_OUTCOME', () => {
  const m = predictionAccuracy([outcome('c-1', { predictedDelta: null, actualDelta: null, predictionQuality: null })]);
  assertEmpty(m, 'predictionAccuracy', /NO_SCORABLE_OUTCOME/);
  assert.equal(m.totalOutcomes, 1, '要说清「有 1 行但一行都评分不了」');
});

test('⛔ predictedDelta 缺失 ⇒ ⛔ 不用 0 冒充（没预测就没有校准可言）', () => {
  const m = predictionAccuracy([outcome('c-1', { predictedDelta: null, actualDelta: 5, predictionQuality: null })]);
  assertEmpty(m, 'predictionAccuracy', null);
  assert.ok(!Number.isFinite(m.value), 'PQ 不得是任何数字');
});

test('✅ outcome 缺 PQ 但有 pred/actual ⇒ 现场调 scorePrediction 补算（同一份公式）', () => {
  const m = predictionAccuracy([outcome('c-1', { predictedDelta: 5.0, actualDelta: 9.1, predictionQuality: null })]);
  assert.ok(typeof m.value.meanPQ === 'number', '缺 PQ 时应现场算，而不是丢数据');
  assert.ok(m.value.meanPQ > 0);
  assert.equal(m.sampleSize, 1);
  assert.match(m.coldStartWarning, /CALIBRATING/,
    'n<5 的桶按设计不得作为对外结论，报告必须说出来');
});

test('✅ outcome 带现成 PQ ⇒ 直接采用，不重算（driver 写进去的就是权威值）', () => {
  const m = predictionAccuracy([outcome('c-1', { predictionQuality: 0.42, predictedDelta: 99, actualDelta: -99 })]);
  assert.equal(m.value.meanPQ, 0.42,
    '现成 PQ 是权威值 —— 若被本地重算覆盖，报告与 driver 的分就会不一致');
});

test('✅ n≥5 ⇒ 不出冷启动警告', () => {
  const m = predictionAccuracy(Array.from({ length: 6 }, (_, i) => outcome(`c-${i}`, { predictionQuality: 0.5 })));
  assert.equal(m.coldStartWarning, null);
  assert.equal(m.value.confidence, 'PROVISIONAL');
});

// ── 纪律 8：挂链 ─────────────────────────────────────────────────────────

test('⛔ outcome 全挂不上 ledger ⇒ NO_OUTCOME_LINKED（两侧断链要说得出来）', () => {
  const m = linkageCheck([entry(1, { contractId: 'x' })], [outcome('y')]);
  assertEmpty(m, 'linkage', /NO_OUTCOME_LINKED/);
});

test('✅ 部分挂上 ⇒ 孤儿数必须报出来（挂链率不是 100% 就是有问题）', () => {
  const m = linkageCheck([entry(1, { contractId: 'x' })], [outcome('x'), outcome('y')]);
  assert.equal(m.value.linked, 1);
  assert.equal(m.value.orphanOutcomes, 1);
});

// ── 纪律 9：过滤 ─────────────────────────────────────────────────────────

test('⛔ 过滤条件排除了全部条目 ⇒ FILTERED_OUT，不是「期间内无进化」', () => {
  const r = buildGrowthReport({ entries: [entry(1), entry(2)], outcomes: [], filter: { generation: 'GEN-777' } });
  assertEmpty(r.metrics.decisions, 'decisions', /FILTERED_OUT/);
  assert.equal(r.sourceCounts.ledgerEntriesSelected, 0);
  assert.equal(r.sourceCounts.ledgerEntries, 2, '总数与选中数必须分别报，否则看不出是过滤掉的');
});

test('✅ --since 只留时间戳 >= since 的条目', () => {
  const sel = selectEntries([entry(1), entry(2), entry(3)], { since: '2026-09-02' });
  assert.equal(sel.entries.length, 2);
  assert.equal(sel.allFilteredOut, false);
});

test('⛔ --since 无法解析 ⇒ 抛错（不静默当作无过滤）', () => {
  assert.throws(() => selectEntries([entry(1)], { since: 'not-a-date' }), /无法解析/);
});

// ── 纪律 10：存储读取 ────────────────────────────────────────────────────

test('⛔ 表是 dict 形状时必须读出行（Array.isArray 判据会判 0 条）', () => {
  const tables = { evolution_ledger: { 1: entry(1), 2: entry(2), 3: entry(3) } };
  assert.equal(tableRows(tables, 'evolution_ledger').length, 3);
  assert.equal(tableRows({ t: [entry(1)] }, 't').length, 1, 'array 形状也要认');
  assert.equal(tableRows({}, 'nope').length, 0);
});

test('⛔ 存储文件不存在 ⇒ 报 STORAGE_MISSING 而不是抛异常（报告不存在 ≠ 系统坏了）', () => {
  const r = readDomainTables(join(tmpdir(), 'definitely-not-here-xyz'), 'agint_evolution');
  assert.equal(r.ok, false);
  assert.match(r.reason, /STORAGE_MISSING/);
});

test('⛔ 存储文件坏 JSON ⇒ 报 STORAGE_UNPARSEABLE，仍不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'growth-bad-'));
  try {
    writeFileSync(join(dir, 'agint_evolution.json'), '{ broken', 'utf8');
    const r = readDomainTables(dir, 'agint_evolution');
    assert.equal(r.ok, false);
    assert.match(r.reason, /UNPARSEABLE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('✅ 顶层形态的存储（无 tables 包装）也能读到表', () => {
  const dir = mkdtempSync(join(tmpdir(), 'growth-flat-'));
  try {
    writeFileSync(join(dir, 'agint_evolution.json'), JSON.stringify({
      unit: { name: 'agint_evolution' },
      evolution_ledger: { 1: entry(1) },
    }), 'utf8');
    const r = readDomainTables(dir, 'agint_evolution');
    assert.equal(r.ok, true);
    assert.equal(tableRows(r.tables, 'evolution_ledger').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 纪律 11：端到端 ──────────────────────────────────────────────────────

test('⛔ 端到端：无 --out 时只打印，不落盘；退出码恒 0（「无数据」不是失败）', () => {
  const dir = storagesWithLedger([]);
  try {
    const out = execFileSync(process.execPath, [SCRIPT, '--storages', dir], { encoding: 'utf8' });
    assert.match(out, /# AGINT Growth Report/);
    assert.match(out, /\*\*无数据\*\*/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⛔ 端到端：--out 落盘的内容与 stdout 渲染一致', () => {
  const dir = storagesWithLedger([entry(1), entry(2, { reconstructed: true })]);
  const outPath = join(dir, 'nested', 'report.md');
  try {
    execFileSync(process.execPath, [SCRIPT, '--storages', dir, '--out', outPath], { encoding: 'utf8' });
    const json = JSON.parse(execFileSync(process.execPath, [SCRIPT, '--storages', dir, '--json'], { encoding: 'utf8' }));
    // 时间戳是唯一允许两次渲染不同的东西（不注入时钟就没法比），
    // 其余必须逐字节一致 —— 否则「写到文件的那份」和「看到的那份」是两个东西。
    const strip = (s) => s.replace(/生成时间：[^\n]*/, '生成时间：X');
    const written = strip(readFileSync(outPath, 'utf8'));
    const printed = strip(execFileSync(process.execPath, [SCRIPT, '--storages', dir], { encoding: 'utf8' }));
    assert.equal(written, printed, '--out 写的必须是同一份渲染结果');
    assert.equal(json.metrics.decisions.value.total, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⛔ 端到端：报告必须自带「不表示效果为零」的读法声明', () => {
  const dir = storagesWithLedger([]);
  try {
    const out = execFileSync(process.execPath, [SCRIPT, '--storages', dir], { encoding: 'utf8' });
    assert.match(out, /不表示「效果为零」/);
    assert.match(out, /从不把缺数据渲染成 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('✅ collectGaps 把 gaps 与 notes 分开（两类性质不同，混列会误导）', () => {
  const metrics = {
    a: { value: null, reason: 'NO_DATA', sampleSize: 0 },
    b: { value: 0, caveat: '这是真 0', sampleSize: 0 },
    c: { value: 0.5, coldStartWarning: '样本太少', sampleSize: 1 },
  };
  const { gaps, notes } = collectGaps(metrics);
  assert.deepEqual(gaps.map((g) => g.metric), ['a']);
  assert.deepEqual(notes.map((n) => n.metric).sort(), ['b', 'c']);
});
