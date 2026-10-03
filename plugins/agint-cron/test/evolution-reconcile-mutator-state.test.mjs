// plugins/agint-cron/test/evolution-reconcile-mutator-state.test.mjs
// —— A5：mutator 记账源三态判据单测
//
// 为什么单独一个文件而不并进 evolution-reconcile-core.test.mjs：
// A5 改的是**第 4 源的可信度**（从「只读上报，不作真值」升为「可核对源」），
// 核心风险不是四源对账算错，而是「把读不到 / 没记账 印成 0 / 印成健康」。
// 这类风险需要独立的可失败断言，混进既有文件会被既有用例的通过掩盖。
//
// fixture 根可注入（tmp），不依赖生产存储。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  reconcileEvolutionStats, defaultStorageDir, judgeMutatorSource,
} from '../lib/evolution-reconcile-core.js';

const PID = 'c663cb3a-602e-4223-aad2-103b634857f9';
const PREIMAGE_REL = '.agint-preimage/presets__agint__skills__demo__SKILL.md__x.bak';

/**
 * @param {object} opts
 * @param {Array}  opts.committedcommitted 事件数组
 * @param {Array}  opts.commitIds     population variants 的 commit_id
 * @param {Array}  opts.preimageFiles 磁盘 preimage 文件名
 * @param {number|null} opts.mutatorCommits mutator.commits 行数；null = **不写该文件**
 * @param {string} opts.mutatorRaw    直接给 agint_mutator.json 原文（测 JSON 损坏）
 */
function makeFixture({ committed = [], commitIds = [], preimageFiles = [], mutatorCommits = 0, mutatorRaw = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'recon-mut-'));
  const storageDir = join(root, 'storages');
  mkdirSync(storageDir, { recursive: true });
  writeFileSync(join(storageDir, 'agint_event_bus.json'), JSON.stringify({
    tables: { events: { rows: committed.map((c) => ({
      envelope: { topic: 'evolution.mutation.committed', occurredAt: '2026-09-27T10:30:07.089Z', payload: c },
    })) } },
  }));
  writeFileSync(join(storageDir, 'agint_population.json'), JSON.stringify({
    tables: { variants: { rows: commitIds.map((id, i) => ({ commit_id: id, variant_id: `v-${i}`, stage: 'PENDING_REVIEW' })) } },
  }));
  if (mutatorRaw !== null) {
    writeFileSync(join(storageDir, 'agint_mutator.json'), mutatorRaw);
  } else if (mutatorCommits !== null) {
    writeFileSync(join(storageDir, 'agint_mutator.json'), JSON.stringify({
      tables: {
        commits: { rows: Array.from({ length: mutatorCommits }, (_, i) => ({ id: `cm-${i}` })) },
        proposals: { rows: [] },
      },
    }));
  }
  const repoRoot = join(root, 'repo');
  mkdirSync(join(repoRoot, '.agint-preimage'), { recursive: true });
  for (const f of preimageFiles) writeFileSync(join(repoRoot, f), 'x');
  return { root, storageDir, repoRoot, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// ── judgeMutatorSource：纯函数，四态 ──────────────────────────────────

test('judgeMutatorSource: 存储读不到 → absent（不是 unwired）', () => {
  assert.equal(judgeMutatorSource({ readable: false, count: 0 }, 5), 'absent');
});

test('judgeMutatorSource: 读得到且行数 ≥ 事件数 → consistent', () => {
  assert.equal(judgeMutatorSource({ readable: true, count: 4 }, 4), 'consistent');
  assert.equal(judgeMutatorSource({ readable: true, count: 9 }, 4), 'consistent', '超额记账不算 gap');
});

test('judgeMutatorSource: 读得到、为 0、有事件 → unwired', () => {
  assert.equal(judgeMutatorSource({ readable: true, count: 0 }, 4), 'unwired');
});

test('judgeMutatorSource: 读得到、为 0、无事件 → consistent（确实没commit 过）', () => {
  assert.equal(judgeMutatorSource({ readable: true, count: 0 }, 0), 'consistent',
    '没有 commit 就没有记账缺口 —— 这才是 0 的正当含义');
});

test('judgeMutatorSource: 读得到、部分行 → gap', () => {
  assert.equal(judgeMutatorSource({ readable: true, count: 2 }, 4), 'gap');
});

// ── 三态在端到端里的落点 ────────────────────────────────────────────

test('端到端: 有 committed 事件 + commits 表 0 行 → unwired + R4 命中', () => {
  const f = makeFixture({
    committed: [{ proposalId: PID, path: 'presets/agint/skills/demo/SKILL.md', preimagePath: PREIMAGE_REL }],
    commitIds: [PID], preimageFiles: [PREIMAGE_REL], mutatorCommits: 0,
  });
  try {
    const r = reconcileEvolutionStats({ storageDir: f.storageDir, repoRoot: f.repoRoot });
    assert.equal(r.counts.mutatorState, 'unwired');
    assert.equal(r.counts.mutatorSourceReadable, true, '表存在 ⇒ 读得到');
    assert.equal(r.counts.mutatorDegraded, true, '真有缺口才告警');
    assert.equal(r.diffs.R4_mutatorAccountingGap.length, 1);
    assert.equal(r.diffs.R4_mutatorAccountingGap[0].state, 'unwired');
    assert.equal(r.diffs.R4_mutatorAccountingGap[0].committed, 1);
    assert.equal(r.diffs.R4_mutatorAccountingGap[0].mutatorCommits, 0);
  } finally { f.cleanup(); }
});

test('端到端: 记账数追平事件数 → consistent + R4 清零 + 不告警', () => {
  const f = makeFixture({
    committed: [{ proposalId: PID, path: 'p/SKILL.md', preimagePath: PREIMAGE_REL }],
    commitIds: [PID], preimageFiles: [PREIMAGE_REL], mutatorCommits: 1,
  });
  try {
    const r = reconcileEvolutionStats({ storageDir: f.storageDir, repoRoot: f.repoRoot });
    assert.equal(r.counts.mutatorState, 'consistent');
    assert.equal(r.counts.mutatorCommits, 1);
    assert.equal(r.counts.mutatorDegraded, false);
    assert.equal(r.diffs.R4_mutatorAccountingGap.length, 0);
  } finally { f.cleanup(); }
});

test('端到端: 只记了一半 → gap', () => {
  const f = makeFixture({
    committed: [
      { proposalId: PID, preimagePath: PREIMAGE_REL },
      { proposalId: 'p2', preimagePath: PREIMAGE_REL },
    ],
    commitIds: [PID, 'p2'], preimageFiles: [PREIMAGE_REL], mutatorCommits: 1,
  });
  try {
    const r = reconcileEvolutionStats({ storageDir: f.storageDir, repoRoot: f.repoRoot });
    assert.equal(r.counts.mutatorState, 'gap');
    assert.equal(r.diffs.R4_mutatorAccountingGap[0].state, 'gap');
    assert.equal(r.diffs.R4_mutatorAccountingGap[0].mutatorCommits, 1);
  } finally { f.cleanup(); }
});

// ── 「读不到」必须与「读到 0」严格分开 ───────────────────────────────

test('端到端: 无 agint_mutator.json → absent，且**不**报 R4', () => {
  const f = makeFixture({
    committed: [{ proposalId: PID, preimagePath: PREIMAGE_REL }],
    commitIds: [PID], preimageFiles: [PREIMAGE_REL], mutatorCommits: null,
  });
  try {
    const r = reconcileEvolutionStats({ storageDir: f.storageDir, repoRoot: f.repoRoot });
    assert.equal(r.counts.mutatorState, 'absent');
    assert.equal(r.counts.mutatorSourceReadable, false);
    assert.equal(r.diffs.R4_mutatorAccountingGap.length, 0, '没这个源 ≠ 这个源报 0');
    assert.equal(r.counts.mutatorDegraded, false, '没装 mutator 不该告警（这正是 A5 前的病根）');
  } finally { f.cleanup(); }
});

test('端到端: agint_mutator.json 是坏 JSON → 仍判 absent，不冒充 0 行', () => {
  const f = makeFixture({
    committed: [{ proposalId: PID, preimagePath: PREIMAGE_REL }],
    commitIds: [PID], preimageFiles: [PREIMAGE_REL], mutatorRaw: '{ this is not json',
  });
  try {
    const r = reconcileEvolutionStats({ storageDir: f.storageDir, repoRoot: f.repoRoot });
    assert.equal(r.counts.mutatorState, 'absent', '读不到就是读不到，不能读成 0 行');
    assert.equal(r.diffs.R4_mutatorAccountingGap.length, 0);
  } finally { f.cleanup(); }
});

// ── R4 是软差异，不拉红 verdict（与 R3 同级） ──────────────────────────

test('R4 只进 softDiffs，不动 hardDiffs / verdict.pass', () => {
  const f = makeFixture({
    committed: [{ proposalId: PID, preimagePath: PREIMAGE_REL }],
    commitIds: [PID], preimageFiles: [PREIMAGE_REL], mutatorCommits: 0,
  });
  try {
    const r = reconcileEvolutionStats({ storageDir: f.storageDir, repoRoot: f.repoRoot });
    assert.equal(r.verdict.hardDiffs, 0);
    assert.equal(r.verdict.pass, true);
    assert.equal(r.verdict.softDiffs, 1, 'R4 计入 softDiffs');
  } finally { f.cleanup(); }
});

test('无 committed 事件 + commits 表空 → consistent，零差异（干净的空态）', () => {
  const f = makeFixture({ committed: [], commitIds: [], mutatorCommits: 0 });
  try {
    const r = reconcileEvolutionStats({ storageDir: f.storageDir, repoRoot: f.repoRoot });
    assert.equal(r.counts.mutatorState, 'consistent');
    assert.equal(r.diffs.R4_mutatorAccountingGap.length, 0);
    assert.equal(r.verdict.softDiffs, 0);
  } finally { f.cleanup(); }
});

// ── 纪律：字典形态的表也必须读出行数（dsh 磁盘上是 dict 不是 array） ──

test('端到端: commits 表是 dict 形态 → 行数照样读出（不是恒 0）', () => {
  const f = makeFixture({
    // committed 给 3 条，与 dict 里的 2 行形成真实缺口 —— 否则 2 >= 3 不成立，
    // 断言会把「consistent」当成读错（第一版就是这么写错的：committed 只给 1 条，
    // 2 >= 1 恒成立，gap 分支永远走不到）。
    committed: [
      { proposalId: PID, preimagePath: PREIMAGE_REL },
      { proposalId: 'p2', preimagePath: PREIMAGE_REL },
      { proposalId: 'p3', preimagePath: PREIMAGE_REL },
    ],
    commitIds: [PID, 'p2', 'p3'], preimageFiles: [PREIMAGE_REL],
    mutatorRaw: JSON.stringify({ tables: { commits: { '1': { id: 'a' }, '2': { id: 'b' } }, proposals: {} } }),
  });
  try {
    const r = reconcileEvolutionStats({ storageDir: f.storageDir, repoRoot: f.repoRoot });
    assert.equal(r.counts.mutatorCommits, 2, 'dict 形态不能读成 0 —— 那会让记账看着像没生效');
    assert.equal(r.counts.mutatorState, 'gap');
  } finally { f.cleanup(); }
});

// ── 导出契约 ────────────────────────────────────────────────────────

test('导出契约: judgeMutatorSource 已导出且是函数', () => {
  assert.equal(typeof judgeMutatorSource, 'function');
  assert.equal(typeof defaultStorageDir, 'function');
});

test('counts 带 mutatorState（脱离 numbers 的裸读数才有意义）', () => {
  const f = makeFixture({ committed: [], commitIds: [], mutatorCommits: 0 });
  try {
    const r = reconcileEvolutionStats({ storageDir: f.storageDir, repoRoot: f.repoRoot });
    for (const k of ['mutatorCommits', 'mutatorDegraded', 'mutatorState', 'mutatorSourceReadable']) {
      assert.ok(k in r.counts, `counts 缺 ${k} —— 读数没有状态就退化成裸数字`);
    }
  } finally { f.cleanup(); }
});