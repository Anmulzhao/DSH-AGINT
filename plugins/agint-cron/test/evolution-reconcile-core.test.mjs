// plugins/agint-cron/test/evolution-reconcile-core.test.mjs —— 对账判据单测（Phase -1.1）
//
// 判据住在 cron 插件 lib（随 bundle 部署，宿主可跑），这里是它的单一测试面。
// 关注点：四源交叉对账的结局必须可区分，且绝不把「读不到 / 查不了」冒充成「零差异通过」。
// fixture 根可注入（tmp），不依赖生产存储。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { reconcileEvolutionStats, defaultStorageDir } from '../lib/evolution-reconcile-core.js';

const PID = 'c663cb3a-602e-4223-aad2-103b634857f9';
const PREIMAGE_REL = '.agint-preimage/presets__agint__skills__demo__SKILL.md__x.bak';

function busStore(committed) {
  return { tables: { events: { rows: committed.map((c) => ({
    envelope: { topic: 'evolution.mutation.committed', occurredAt: '2026-09-27T10:30:07.089Z', payload: c },
  })) } } };
}
function popStore(commitIds) {
  return { tables: { variants: { rows: commitIds.map((id, i) => ({ commit_id: id, variant_id: `v-${i}`, stage: 'PENDING_REVIEW' })) } } };
}
const MUTATOR_EMPTY = { tables: { commits: { rows: [] }, proposals: { rows: [] } } };

function makeFixture({ committed = [], commitIds = [], preimageFiles = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'recon-'));
  const storageDir = join(root, 'storages');
  mkdirSync(storageDir, { recursive: true });
  writeFileSync(join(storageDir, 'agint_event_bus.json'), JSON.stringify(busStore(committed)));
  writeFileSync(join(storageDir, 'agint_population.json'), JSON.stringify(popStore(commitIds)));
  writeFileSync(join(storageDir, 'agint_mutator.json'), JSON.stringify(MUTATOR_EMPTY));
  const repoRoot = join(root, 'repo');
  mkdirSync(join(repoRoot, '.agint-preimage'), { recursive: true });
  for (const f of preimageFiles) writeFileSync(join(repoRoot, f), 'x');
  return { root, storageDir, repoRoot, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('A 四源自洽 → ok，mutator 标降级', () => {
  const f = makeFixture({
    committed: [{ proposalId: PID, path: 'presets/agint/skills/demo/SKILL.md', preimagePath: PREIMAGE_REL }],
    commitIds: [PID], preimageFiles: [PREIMAGE_REL],
  });
  try {
    const r = reconcileEvolutionStats({ storageDir: f.storageDir, repoRoot: f.repoRoot });
    assert.equal(r.status, 'ok');
    assert.equal(r.counts.eventBusCommitted, 1);
    assert.equal(r.counts.mutatorDegraded, true);
    assert.equal(r.verdict.hardDiffs, 0);
  } finally { f.cleanup(); }
});

test('B committed 磁盘缺 preimage → diff，R2 命中（不可回滚红线）', () => {
  const f = makeFixture({ committed: [{ proposalId: PID, preimagePath: PREIMAGE_REL }], commitIds: [PID], preimageFiles: [] });
  try {
    const r = reconcileEvolutionStats({ storageDir: f.storageDir, repoRoot: f.repoRoot });
    assert.equal(r.status, 'diff');
    assert.equal(r.diffs.R2_committedMissingPreimage.length, 1);
    assert.equal(r.verdict.hardDiffs, 1);
  } finally { f.cleanup(); }
});

test('C committed 不在 population → R1 命中', () => {
  const f = makeFixture({ committed: [{ proposalId: PID, preimagePath: PREIMAGE_REL }], commitIds: ['unrelated'], preimageFiles: [PREIMAGE_REL] });
  try {
    const r = reconcileEvolutionStats({ storageDir: f.storageDir, repoRoot: f.repoRoot });
    assert.equal(r.status, 'diff');
    assert.deepEqual(r.diffs.R1_committedNotInPopulation, [PID]);
  } finally { f.cleanup(); }
});

test('D repoRoot 未知 → 跳过 preimage 源，不虚报 R2（查不了 ≠ 缺失）', () => {
  const f = makeFixture({ committed: [{ proposalId: PID, preimagePath: PREIMAGE_REL }], commitIds: [PID], preimageFiles: [] });
  try {
    const r = reconcileEvolutionStats({ storageDir: f.storageDir });
    assert.equal(r.status, 'ok', 'preimage 不可核时不得判 diff');
    assert.equal(r.diffs.R2_committedMissingPreimage.length, 0);
    assert.ok(r.notes.some((n) => n.includes('REPO_ROOT_UNKNOWN')));
    assert.equal(r.sources.preimageCheckable, false);
  } finally { f.cleanup(); }
});

test('E 存储不可读 → unavailable（绝不冒充 ok / 零差异）', () => {
  const r = reconcileEvolutionStats({ storageDir: join(tmpdir(), 'definitely-not-here-' + Date.now()) });
  assert.equal(r.status, 'unavailable');
  assert.match(r.reason, /STORAGE_UNREADABLE/);
  assert.equal(r.counts, null);
});

test('F population 候选无 committed 事件 → 结构差异（R3 软项，不计 FAIL）', () => {
  const f = makeFixture({ committed: [], commitIds: ['x1', 'x2'] });
  try {
    const r = reconcileEvolutionStats({ storageDir: f.storageDir, repoRoot: f.repoRoot });
    assert.equal(r.status, 'ok');
    assert.equal(r.diffs.R3_populationUncorroborated.length, 2);
    assert.equal(r.verdict.hardDiffs, 0);
    assert.equal(r.structural.populationWithoutEvent, 2);
  } finally { f.cleanup(); }
});

test('导出契约：reconcileEvolutionStats / defaultStorageDir 是函数', () => {
  assert.equal(typeof reconcileEvolutionStats, 'function');
  assert.equal(typeof defaultStorageDir, 'function');
});
