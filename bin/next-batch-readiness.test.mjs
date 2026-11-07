/**
 * B1/B2/C2 就绪度清单单测。
 *
 * 重点钉住：
 *  ① 真实前置下必须 ALL_BLOCKED，且三项各自报出具体阻塞原因（不伪造生效）
 *  ② 三态：oracle 域不可用 ⇒ null+reason，绝不写 0
 *  ③ 五闸：即便显式打开开关，G2 仍因无外部真值拒绝（防「开个开关就绕过」）
 *  ④ 正面路径：标注周数够 + 冻结标签够 + 五闸全过时能判 READY（证明不是恒 BLOCKED）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildReadiness, renderMarkdown, READINESS_SCHEMA } from './next-batch-readiness.mjs';
import { canonicalHash } from './lib/canonical-json.mjs';

/** 域可用但 0 行广播 ⇒ oracleEvidence 判 NO_BROADCASTS（无数据，不是 0 标注）。 */
function emptyOracle() {
  return { ok: true, reason: '', tables: { oracle_broadcasts: {}, oracle_state: {}, oracle_cards: {} }, rows: {} };
}

/**
 * 麒麟机真实现状：N 个独立 ISO 周都有广播，但**没有一条人工标注**。
 * ⛔ 这与 emptyOracle() 的三态不同：这里是「查过了，确实是 0」，那里是「没测过」。
 */
function unannotatedOracle(n = 6) {
  const rows = {};
  for (let i = 0; i < n; i += 1) {
    rows[`b${i}`] = {
      id: `b${i}`, kind: 'weekly', ts: new Date(Date.UTC(2026, 8, 7 + i * 7, 8)).toISOString(),
      outcome: 'ok', score: 90,
      // 故意不写 humanVerdict / humanOverall / annotatedAt
    };
  }
  return { ok: true, reason: '', tables: { oracle_broadcasts: rows }, rows: {} };
}

/** 造一份带 N 周人工标注的 oracle 域。 */
function annotatedOracle(n, { overall = true } = {}) {
  const rows = {};
  for (let i = 0; i < n; i += 1) {
    rows[`b${i}`] = {
      id: `b${i}`, kind: 'weekly', ts: new Date(Date.UTC(2026, 8, 7 + i * 7, 8)).toISOString(),
      outcome: 'ok', score: 90,
      humanVerdict: 'noise',
      humanOverall: overall ? (i % 2 ? 'better' : 'worse') : null,
      annotatedAt: new Date(Date.UTC(2026, 8, 8 + i * 7)).toISOString(),
    };
  }
  return { ok: true, reason: '', tables: { oracle_broadcasts: rows }, rows: {} };
}

/** 造一份带 n 条 GOLD 冻结标签的 sets 目录。 */
function sealedSets(n) {
  const dir = mkdtempSync(join(tmpdir(), 'readiness-sets-'));
  const mk = (name, samples) => {
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({
      name, sealed: samples.length ? true : false,
      contentHash: samples.length ? canonicalHash(samples) : '',
      samples,
    }, null, 2));
  };
  const samples = Array.from({ length: n }, (_, i) => ({
    id: `${name()}-${i}`, layer: 'L1', label: 'PASS', labelAuthority: 'GOLD',
  }));
  mk('gold', samples);
  mk('verify', []);
  mk('heldout', []);
  return dir;
}
function name() { return 'gold'; }

/** 造空（UNSEALED）sets 目录。 */
function emptySets() {
  const dir = mkdtempSync(join(tmpdir(), 'readiness-empty-'));
  for (const n of ['gold', 'verify', 'heldout']) {
    writeFileSync(join(dir, `${n}.json`), JSON.stringify({ name: n, sealed: false, contentHash: '', samples: [] }, null, 2));
  }
  return dir;
}

test('⛔ 现状：6 周广播但 0 标注（真 0）+ 0 冻结标签 + 开关默认关 ⇒ ALL_BLOCKED，三项都有具体阻塞', () => {
  const dir = emptySets();
  try {
    const r = buildReadiness({ oracle: unannotatedOracle(), setsDir: dir, env: {} });
    assert.equal(r.overall, 'ALL_BLOCKED');
    assert.equal(r.readyCount, 0);
    assert.equal(r.blockedCount, 3);
    assert.equal(r.schemaVersion, READINESS_SCHEMA);
    const [b1, b2, c2] = r.items;
    assert.equal(b1.status, 'BLOCKED');
    assert.ok(b1.blockers.some((x) => x.includes('NO_FROZEN_LABELS')));
    assert.ok(b1.blockers.some((x) => x.includes('G1_switch')));
    assert.ok(b1.blockers.some((x) => x.includes('G2_external_anchor')));
    assert.equal(b2.status, 'BLOCKED');
    assert.ok(b2.blockers.some((x) => x.includes('≥4')));
    assert.ok(b2.blockers.some((x) => x.includes('≥5')));
    assert.equal(c2.status, 'BLOCKED');
    assert.ok(c2.blockers.some((x) => x.includes('D1–D5')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ 回归：6 周广播 0 标注必须读成真 0（差 4/5 周），不能被降级成 ANNOTATION_UNKNOWN', () => {
  const dir = emptySets();
  try {
    const b2 = buildReadiness({ oracle: unannotatedOracle(), setsDir: dir, env: {} }).items[1];
    assert.equal(b2.metrics.annotatedVerdictWeeks.value, 0);
    assert.equal(b2.metrics.annotatedOverallWeeks.value, 0);
    assert.equal(b2.metrics.independentWeeks.value, 6);
    assert.ok(!b2.blockers.some((x) => x.includes('ANNOTATION_UNKNOWN')));
    assert.ok(b2.blockers.some((x) => x.includes('差 4')));
    assert.ok(b2.blockers.some((x) => x.includes('差 5')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ 对照：0 行广播（判尺从未出读数）才是 ANNOTATION_UNKNOWN，与上面真 0 不同', () => {
  const dir = emptySets();
  try {
    const b2 = buildReadiness({ oracle: emptyOracle(), setsDir: dir, env: {} }).items[1];
    assert.equal(b2.metrics.annotatedVerdictWeeks.value, null);
    assert.ok(b2.blockers.some((x) => x.includes('ANNOTATION_UNKNOWN')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ 冻结标签 0 是真 0，不是「没测过」', () => {
  const dir = emptySets();
  try {
    const r = buildReadiness({ oracle: emptyOracle(), setsDir: dir, env: {} });
    assert.equal(r.items[0].metrics.frozenLabels.value, 0);
    assert.equal(r.items[0].metrics.frozenLabels.reason, '');
    assert.equal(r.items[2].metrics.externalTruthAvailable.value, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ oracle 域不可用 ⇒ 标注周数 null+reason，绝不写 0', () => {
  const dir = emptySets();
  try {
    const r = buildReadiness({ oracle: { ok: false, reason: '文件不存在', tables: {} }, setsDir: dir, env: {} });
    const b2 = r.items[1];
    assert.equal(b2.metrics.annotatedVerdictWeeks.value, null);
    assert.match(b2.metrics.annotatedVerdictWeeks.reason, /ORACLE_DOMAIN_UNAVAILABLE/);
    assert.ok(b2.blockers.some((x) => x.includes('ANNOTATION_UNKNOWN')));
    assert.equal(b2.status, 'BLOCKED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ 显式打开 G1 也不能绕过 G2：无外部真值仍拒绝', () => {
  const dir = emptySets();
  try {
    const r = buildReadiness({ oracle: emptyOracle(), setsDir: dir, env: {}, switchOn: true });
    const b1 = r.items[0];
    assert.equal(b1.metrics.switchOn.value, true);
    assert.equal(b1.metrics.gateAllowed.value, false, '开关打开但 G2 缺 GOLD/HELDOUT ⇒ 仍拒绝');
    assert.ok(b1.blockers.some((x) => x.includes('G2_external_anchor')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ sets 损坏/缺失 ⇒ 冻结标签 null+reason，B1 报不可读而不是 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'readiness-missing-'));
  try {
    const r = buildReadiness({ oracle: emptyOracle(), setsDir: dir, env: {} });
    assert.equal(r.items[0].metrics.frozenLabels.value, null);
    assert.ok(r.items[0].blockers.some((x) => x.includes('FROZEN_SETS_UNREADABLE')));
    assert.equal(r.items[2].metrics.externalTruthAvailable.value, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('✅ 正面路径（注入充分前置）：五闸全过 ⇒ B1 READY，证明不是恒 BLOCKED', () => {
  const dir = sealedSets(1);
  try {
    const r = buildReadiness({ oracle: emptyOracle(), setsDir: dir, env: {}, switchOn: true });
    const b1 = r.items[0];
    // 探针把 candidateLabel 设成 GOLD，G1 显式开，其余参数合法 ⇒ 五闸全过
    assert.equal(b1.metrics.gateAllowed.value, true, b1.metrics.gateReason.value);
    assert.equal(b1.status, 'READY');
    assert.equal(r.overall, 'PARTIAL', 'B2/C2 仍被标注周数与 C1 阶段 2 挡着');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ 标注周数够了但冻结标签仍为 0 ⇒ B2 的门槛闸解除，但整体仍 BLOCKED（真值缺）', () => {
  const dir = emptySets();
  try {
    const r = buildReadiness({ oracle: annotatedOracle(6), setsDir: dir, env: {} });
    const b2 = r.items[1];
    assert.ok(b2.metrics.annotatedVerdictWeeks.value >= 4);
    assert.ok(b2.metrics.annotatedOverallWeeks.value >= 5);
    assert.equal(b2.metrics.thresholdsGate.value, true);
    assert.equal(b2.metrics.weightsGate.value, true);
    assert.equal(b2.status, 'BLOCKED', 'unidentifiable 维与 scaleHash 分段护栏仍在 ⇒ 不能自动落参数');
    assert.equal(r.overall, 'ALL_BLOCKED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('✅ markdown 渲染含三态说明与「BLOCKED 是设计结果」', () => {
  const dir = emptySets();
  try {
    const md = renderMarkdown(buildReadiness({ oracle: emptyOracle(), setsDir: dir, env: {} }));
    assert.match(md, /ALL_BLOCKED/);
    assert.match(md, /BLOCKED 是设计结果，不是故障/);
    assert.match(md, /下一批开工判据/);
    assert.match(md, /B1 ·/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ 功能实现就位不得改变 READY 判定 ⇒ 仍 ALL_BLOCKED', () => {
  const dir = emptySets();
  try {
    const r = buildReadiness({ oracle: unannotatedOracle(6), setsDir: dir, env: {} });
    assert.equal(r.implementation.available, true);
    assert.equal(r.implementation.runtimeDefault, 'OFF');
    assert.equal(r.implementation.writesByDefault, 0);
    assert.equal(r.implementation.modules.B1, 'bin/oracle-prescription-delivery.mjs');
    assert.equal(r.overall, 'ALL_BLOCKED', '代码存在 ≠ 前置齐备');
    assert.equal(r.readyCount, 0);
    assert.match(r.disclaimer, /默认零写入/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
