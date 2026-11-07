// bin/score-vs-evidence.test.mjs —— 「分数能不能当判断标准」对照脚本的测试
//
// ⭐ 全部用例围绕一条纪律：**不可对照就明说不可对照，绝不在空数据上编相关系数**。
//    以及：某一周「能力事件 0 条」是没采到证据，不等于「能力为零」。
//
// ⛔ 判定权在外部冻结基准与人；本脚本产出的方向一致率只是假设生成器，
//    任何用例都不得把它写成「进化结论」。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildScoreVsEvidence,
  directionalAgreement,
  eventsByWeek,
  renderMarkdown,
  DOMAIN_NAMES,
  MIN_COMPARABLE_WEEKS,
} from './score-vs-evidence.mjs';
import { isoWeek } from './evolution-evidence.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'score-vs-evidence.mjs');

// 与 calibration.mjs / evolution-evidence.mjs 同口径的真实周一时间戳
const WEEKS = [
  '2026-10-04T11:35:11.949Z', // W40
  '2026-10-11T01:00:29.451Z', // W41
  '2026-10-18T01:00:48.785Z', // W42
  '2026-10-25T01:00:10.352Z', // W43
  '2026-11-01T01:00:06.229Z', // W44
  '2026-11-06T14:57:05.294Z', // W45
];
const SCORES = [80.3, 97.8, 97.6, 97.5, 99.3, 99.9];

function bc(ts, score) {
  return { kind: 'daily', outcome: 'ok', ts, score, worstKey: 'confidence' };
}

function domainsWith(over = {}) {
  const base = {
    agint_aesthetic_oracle: { ok: true, reason: null, rows: {}, tables: { oracle_broadcasts: {} } },
    agint_self_model: { ok: true, reason: null, rows: {}, tables: { capability_map: {} } },
    agint_curriculum: { ok: true, reason: null, rows: {}, tables: { attempts: {} } },
    agint_evolution: { ok: true, reason: null, rows: {}, tables: { prediction_outcomes: {} } },
    agint_evolve: { ok: true, reason: null, rows: {}, tables: { execution: {} } },
  };
  for (const [k, v] of Object.entries(over)) {
    base[k] = { ...base[k], ...v };
  }
  return base;
}

function dict(rows) {
  return Object.fromEntries(rows.map((r, i) => [String(i + 1), r]));
}

function scoreSeries() {
  return { tables: { oracle_broadcasts: dict(WEEKS.map((ts, i) => bc(ts, SCORES[i]))) } };
}

function execs(countsPerWeek) {
  const rows = [];
  countsPerWeek.forEach((n, wi) => {
    for (let i = 0; i < n; i++) {
      rows.push({ state: 'succeeded', ok: true, finishedAt: WEEKS[wi] });
    }
  });
  return { tables: { execution: dict(rows) } };
}

function capRows(weeks, status = 'CAN') {
  return { tables: { capability_map: dict(weeks.map((ts, i) => ({ status, lastVerifiedAt: ts, id: `cap-${i}` }))) } };
}

function run(args, env = {}) {
  return execFileSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: '', AGINT_DATA_HOME: '', ...env },
  });
}

function makeStorages(domains) {
  const root = mkdtempSync(join(tmpdir(), 'score-vs-evidence-'));
  for (const [name, tables] of Object.entries(domains)) {
    writeFileSync(join(root, `${name}.json`), JSON.stringify({ unit: { name, version: 1 }, tables }), 'utf8');
  }
  return root;
}

function fingerprint(dir) {
  return readdirSync(dir).sort().map((f) => `${f}:${createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')}`).join('|');
}

// ── 纪律 1：不可对照就明说 ────────────────────────────────────────────────

test('⛔ 左侧无分数序列 ⇒ NO_SCORE_SERIES，不得给方向一致率', () => {
  const r = buildScoreVsEvidence({ domains: domainsWith() });
  assert.equal(r.verdict, 'NO_SCORE_SERIES');
  assert.equal(r.weeks.length, 0);
  assert.equal(r.directional.value, null);
  assert.ok(r.directional.reason);
  assert.equal(r.scoreSeries.first, null);
});

test('⛔ 能力图谱只覆盖 1 个 ISO 周 ⇒ NOT_COMPARABLE（事件流 ≠ 状态序列）', () => {
  const r = buildScoreVsEvidence({
    domains: domainsWith({
      agint_aesthetic_oracle: scoreSeries(),
      agint_self_model: capRows([WEEKS[5]]),
      agint_evolve: execs([1, 1, 1, 1, 1, 1]),
    }),
  });
  assert.equal(r.verdict, 'NOT_COMPARABLE');
  assert.match(r.verdictReason, /事件流/);
  assert.equal(r.directional.value, null);
  assert.equal(r.capabilitySnapshotWeeks.length, 1);
});

test('⛔ 可比周 < 门槛 ⇒ INSUFFICIENT，拒绝出相关系数', () => {
  const r = buildScoreVsEvidence({
    domains: domainsWith({
      agint_aesthetic_oracle: scoreSeries(),
      agint_self_model: capRows([WEEKS[0], WEEKS[5]], 'CANNOT'),
      agint_evolve: execs([1, 0, 0, 0, 0, 1]),
    }),
  });
  assert.equal(r.verdict, 'INSUFFICIENT');
  assert.match(r.verdictReason, /拒绝出方向一致率/);
  assert.equal(r.comparableWeeks, 2);
  assert.equal(r.directional.value, null);
  assert.equal(MIN_COMPARABLE_WEEKS, 4);
});

test('✅ 可比周够 + 两侧都有变化 ⇒ OBSERVATIONAL，但只给观测一致率', () => {
  const r = buildScoreVsEvidence({
    domains: domainsWith({
      agint_aesthetic_oracle: scoreSeries(),
      agint_self_model: capRows([WEEKS[0], WEEKS[3]], 'CANNOT'),
      agint_evolve: execs([1, 2, 3, 4, 5, 6]),
    }),
  });
  assert.equal(r.verdict, 'OBSERVATIONAL');
  assert.match(r.verdictReason, /不构成/);
  assert.equal(r.comparableWeeks, 6);
  assert.equal(r.directional.value.rate, 1, '分数与证据事件数同向递增 ⇒ 一致率 1');
  assert.equal(r.directional.value.total, 3, 'W41→W42 / W42→W43 分数几乎持平（|Δ|<0.5）⇒ 这两对无区分力，必须跳过');
});

// ── 纪律 2：0 ≠ 能力为零 ──────────────────────────────────────────────────

test('⛔ 某周 0 条能力事件是真 0（数字），不是 null / 无数据', () => {
  const r = buildScoreVsEvidence({
    domains: domainsWith({
      agint_aesthetic_oracle: scoreSeries(),
      agint_evolve: execs([1, 0, 0, 0, 0, 0]),
    }),
  });
  const w = r.weeks[3];
  assert.equal(w.evidenceTotal, 0);
  assert.equal(w.evidence.succeededExecutions, 0);
  assert.equal(w.comparable, false);
  assert.equal(typeof w.evidence.capabilityCAN, 'number');
  const md = renderMarkdown(r);
  assert.match(md, /不等于「能力为零」/);
  assert.match(md, /事件流 ≠ 状态序列/);
});

test('⛔ 报告必须写明「不判定进化」「自评只能当假设生成器」', () => {
  const md = renderMarkdown(buildScoreVsEvidence({ domains: domainsWith() }));
  assert.match(md, /不判定「AGINT 有没有在进化」/);
  assert.match(md, /自评只能当假设生成器/);
  assert.match(md, /外部冻结基准/);
  assert.match(md, /不是能力分数/);
});

// ── 纪律 3：方向一致率的边界 ──────────────────────────────────────────────

test('✅ 分数涨、证据降 ⇒ 一致率 0（不是「分数涨就是进化」）', () => {
  const r = buildScoreVsEvidence({
    domains: domainsWith({
      agint_aesthetic_oracle: scoreSeries(),
      agint_self_model: capRows([WEEKS[0], WEEKS[3]], 'CANNOT'),
      agint_evolve: execs([6, 5, 4, 3, 2, 1]),
    }),
  });
  assert.equal(r.verdict, 'OBSERVATIONAL');
  assert.equal(r.directional.value.rate, 0);
});

test('⛔ 证据事件数恒定 ⇒ 无可区分周对，方向一致率是「无数据」而非 100%', () => {
  const r = buildScoreVsEvidence({
    domains: domainsWith({
      agint_aesthetic_oracle: scoreSeries(),
      agint_self_model: capRows([WEEKS[0], WEEKS[3]], 'CANNOT'),
      agint_evolve: execs([1, 1, 1, 1, 1, 1]),
    }),
  });
  assert.equal(r.verdict, 'OBSERVATIONAL');
  assert.equal(r.directional.value, null);
  assert.match(r.directional.reason, /NO_DIRECTION_PAIRS/);
});

test('⛔ directionalAgreement 跳过分数持平 / 证据不变的周对', () => {
  const weeks = [
    { week: 'A', score: 90, evidenceTotal: 1, comparable: true },
    { week: 'B', score: 90.1, evidenceTotal: 2, comparable: true }, // |Δscore| < 0.5 ⇒ 跳过
    { week: 'C', score: 95, evidenceTotal: 2, comparable: true }, // Δevidence = 0 ⇒ 跳过
  ];
  assert.equal(directionalAgreement(weeks).value, null);
});

test('✅ eventsByWeek 按谓词过滤，无效时间戳不落任何周', () => {
  const m = eventsByWeek([
    { t: WEEKS[0], ok: true }, { t: WEEKS[0], ok: false }, { t: 'bad', ok: true },
  ], 't', (r) => r.ok === true);
  assert.equal(m.get(isoWeek(WEEKS[0])), 1);
  assert.equal(m.size, 1);
});

// ── 纪律 4：分数序列读数 ──────────────────────────────────────────────────

test('✅ 分数序列如实报首末（80.3→99.9），按周口径饱和度不误报', () => {
  const r = buildScoreVsEvidence({ domains: domainsWith({ agint_aesthetic_oracle: scoreSeries() }) });
  assert.equal(r.scoreSeries.weeklyPoints, 6);
  assert.equal(r.scoreSeries.first.score, 80.3);
  assert.equal(r.scoreSeries.last.score, 99.9);
  assert.ok(Math.abs(r.scoreSeries.delta - 19.6) < 1e-9);
  // 末 3 个**周**代表值是 97.5 / 99.3 / 99.9 ⇒ 并非全 ≥99，不该报饱和。
  // 「最后几天恒 99.9」是日级现象，别拿周级数据硬凑。
  assert.equal(r.scoreSeries.saturated, false);
});

test('✅ 真的连续 ≥99 时才标饱和（分数已无区分力）', () => {
  const flat = { tables: { oracle_broadcasts: dict(WEEKS.map((ts) => bc(ts, 99.9))) } };
  const r = buildScoreVsEvidence({ domains: domainsWith({ agint_aesthetic_oracle: flat }) });
  assert.equal(r.scoreSeries.saturated, true);
  assert.equal(r.scoreSeries.delta, 0);
});

test('⛔ 域不可读 ⇒ 元数据里如实标不可读，不假装查过', () => {
  const d = domainsWith({ agint_aesthetic_oracle: scoreSeries() });
  d.agint_self_model = { ok: false, reason: 'STORAGE_MISSING: /x 不存在', tables: {}, rows: {} };
  const r = buildScoreVsEvidence({ domains: d });
  assert.equal(r.source.domains.agint_self_model.ok, false);
  const md = renderMarkdown(r);
  assert.match(md, /不可读/);
});

// ── 纪律 5：端到端 / 只读 / 不 fallback ───────────────────────────────────

test('⛔ 端到端：不给存储根 ⇒ exit 1，不落到 ~/.dsh 假绿', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /NO_STORAGE_ROOT/);
});

test('⛔ 端到端：--json 出 6 周，且跑完存储目录逐字节不变（只读）', () => {
  const dir = makeStorages({
    agint_aesthetic_oracle: { oracle_broadcasts: dict(WEEKS.map((ts, i) => bc(ts, SCORES[i]))) },
    agint_self_model: { capability_map: dict([{ status: 'CANNOT', lastVerifiedAt: WEEKS[5] }]) },
    agint_curriculum: { attempts: {} },
    agint_evolution: { prediction_outcomes: {} },
    agint_evolve: { execution: {} },
  });
  try {
    const before = fingerprint(dir);
    const r = JSON.parse(run([SCRIPT, '--storages', dir, '--json']));
    assert.equal(fingerprint(dir), before, '⛔ 对照脚本不许写任何存储文件');
    assert.equal(r.weeks.length, 6);
    assert.equal(r.verdict, 'NOT_COMPARABLE');
    assert.equal(r.source.storages, dir);
    assert.equal(Object.keys(r.source.domains).length, DOMAIN_NAMES.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⛔ 端到端：--out 落盘内容与 stdout 渲染一致（只差注入时间戳）', () => {
  const dir = makeStorages({
    agint_aesthetic_oracle: { oracle_broadcasts: dict(WEEKS.map((ts, i) => bc(ts, SCORES[i]))) },
  });
  try {
    const outPath = join(dir, 'nested', 'compare.md');
    run([SCRIPT, '--storages', dir, '--out', outPath]);
    const written = readFileSync(outPath, 'utf8');
    const printed = run([SCRIPT, '--storages', dir]);
    const strip = (s) => s.replace(/生成时间：[^\n]*/, '生成时间：X');
    assert.equal(strip(written), strip(printed));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⛔ 端到端：全部域文件缺失仍是合法报告，exit 0', () => {
  const dir = makeStorages({});
  try {
    const r = JSON.parse(run([SCRIPT, '--storages', dir, '--json']));
    assert.equal(r.verdict, 'NO_SCORE_SERIES');
    assert.equal(r.directional.value, null);
    for (const d of Object.values(r.source.domains)) assert.equal(d.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
