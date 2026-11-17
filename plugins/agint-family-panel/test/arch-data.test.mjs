/**
 * arch-data.js 单测：三态纪律 / 计数自洽 / 断点动态 / 无绝对路径泄漏。
 *
 * ⛔ 为什么用临时 fixture 而不是真 storages：真数据会变（今天 21 节点，明天
 * 可能加一域），断言就变成对快照的复述。这里钉的是**判据**：
 *  - 域不存在 → 值 '—'、missingFiles 记名，不是 0
 *  - 五类边之和 = 边数
 *  - 队列判据与 KPI 同源（课程 status==='open'）
 *  - 断点边在数据恢复后自动变 live（不留永久红叉）
 *  - 输出的任何文字都不含 storages 绝对路径（机器私有事实不入库）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { collectArchData } from '../lib/arch-data.js';

function makeFixture({ withAbtest = false } = {}) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'agint-arch-'));
  const w = (name, tables) => fs.writeFileSync(join(dir, name), JSON.stringify({ tables }), 'utf8');
  w('agint_evolution.json', {
    evolution_log: { e1: { createdAt: '2026-11-10T00:00:00Z', decision: 'L1', resolved: false, recalls: 0 } },
    evolution_ledger: { l1: {} },
    failure_pattern: { f1: {} },
    prediction_outcomes: { o1: { measuredAt: '2026-11-09T00:00:00Z', predictedDelta: 1 } },
    benchmark_frozen_set: {},
  });
  w('agint_evolve.json', { proposal: { p1: { status: 'proposed', createdAt: '2026-11-01T00:00:00Z' } } });
  w('agint_metrics.json', {
    metric: {
      m1: { key: 'memory.total', value: 10, ts: '2026-11-10T00:00:00Z' },
      m2: { key: 'memory.avgConfidence', value: 0.5, ts: '2026-11-10T00:00:00Z' },
      m3: { key: 'rules.adherencePct', value: 100, ts: '2026-11-10T00:00:00Z' },
      m4: { key: 'rules.hits', value: 0, ts: '2026-11-10T00:00:00Z' },
    },
  });
  w('agint_cron.json', { cron_state: { job1: { lastResult: 'ok' } } });
  w('agint_curator.json', { skill_states: {}, reports: {}, audit_log: {} });
  w('agint_trajectory.json', { trajectories: {} });
  w('agint_skill_autocreate.json', { task_patterns: { t1: {} }, candidates: {}, proposals: {}, releases: {} });
  w('agint_rules.json', { rule: {}, rule_audit: {} });
  w('agint_curriculum.json', { challenges: { c1: { status: 'open' }, c2: { status: 'passed' } }, attempts: {}, audit_log: {} });
  if (withAbtest) w('agint_abtest.json', { abtests: { a1: {} }, samples: { s1: {}, s2: {} } });
  return dir;
}

test('域不存在 → — 且记名，不折成 0', () => {
  const dir = makeFixture();
  try {
    const m = collectArchData({ storagesDir: dir });
    assert.ok(m.missingFiles.includes('agint_abtest.json'), 'missingFiles 应记 agint_abtest.json');
    const observe = m.nodes.find((n) => n.id === 'observe');
    assert.equal(observe.value, '—');
    assert.equal(observe.tone, 'idle');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('节点与边计数自洽，五类边之和等于边数', () => {
  const dir = makeFixture();
  try {
    const m = collectArchData({ storagesDir: dir });
    assert.equal(m.counts.nodes, 21);
    assert.equal(m.counts.edges, 26);
    const sum = m.counts.live + m.counts.break + m.counts.feedback + m.counts.frozen + m.counts.human;
    assert.equal(sum, m.counts.edges, '五类边之和必须等于边数');
    assert.equal(new Set(m.nodes.map((n) => n.id)).size, m.nodes.length, '节点 id 不得重复');
    assert.ok(m.edges.every((e) => !!e.basis), '每条边都要有依据');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('课程待做判据与队列同源（status===open）', () => {
  const dir = makeFixture();
  try {
    const m = collectArchData({ storagesDir: dir });
    const q = m.queues.find((x) => x.key === 'curriculum-challenge');
    const kpi = m.kpis.find((k) => k[0] === '课程待做');
    assert.equal(q.pending, 1);
    assert.equal(Number(kpi[1]), 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('断点在数据恢复后自动变 live，不留永久红叉', () => {
  const dir = makeFixture({ withAbtest: true });
  try {
    const m = collectArchData({ storagesDir: dir });
    const e = m.edges.find((x) => x.from === 'skillAc' && x.to === 'observe');
    assert.equal(e.declaredKind, 'break');
    assert.equal(e.kind, 'live', 'abtest 有数据后该边应恢复 live');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('输出的任何文字都不含 storages 绝对路径', () => {
  const dir = makeFixture();
  try {
    const m = collectArchData({ storagesDir: dir });
    const blob = JSON.stringify(m);
    assert.ok(!blob.includes(dir), '不得把机器私有绝对路径写进模型');
    assert.ok(!blob.includes(os.tmpdir().replace(/\/$/, '') + '/agint-arch-'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('队列缺失时 state=unavailable、pending=null（不是 0）', () => {
  const dir = makeFixture();
  try {
    // 删掉 curator 域，它的队列必须变成 unavailable —— 而不是「0 条待办」。
    fs.rmSync(join(dir, 'agint_curator.json'));
    const m = collectArchData({ storagesDir: dir });
    assert.equal(m.queues.length, 9);
    const q = m.queues.find((x) => x.key === 'curator-overlap');
    assert.ok(q, '应有 curator-overlap 队列');
    assert.equal(q.state, 'unavailable');
    assert.equal(q.pending, null, '域不存在时 pending 必须是 null，不能折成 0');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
