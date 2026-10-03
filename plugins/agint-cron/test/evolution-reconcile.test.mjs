// plugins/agint-cron/test/evolution-reconcile.test.mjs —— cron 对账封装决策（Phase -1.1）
//
// 封装只做映射：core 的 ok/diff 直传，unavailable → skipped（读不到 ≠ 通过）。
// repoRoot 未知不再整体 skip —— 那是 ② 下沉后的关键收益：3 个存储源照常对账，
// 只是跳过 preimage 第 3 源。判据本身的三种差异结局由 evolution-reconcile-core.test.mjs 覆盖。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { auditEvolutionReconcile } from '../lib/evolution-reconcile-audit.js';

const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
function makeStorage(committed, commitIds) {
  const root = mkdtempSync(join(tmpdir(), 'recon-wrap-'));
  const storageDir = join(root, 'storages');
  mkdirSync(storageDir, { recursive: true });
  writeFileSync(join(storageDir, 'agint_event_bus.json'), JSON.stringify({
    tables: { events: { rows: committed.map((id) => ({ envelope: { topic: 'evolution.mutation.committed', payload: { proposalId: id } } })) } },
  }));
  writeFileSync(join(storageDir, 'agint_population.json'), JSON.stringify({
    tables: { variants: { rows: commitIds.map((id) => ({ commit_id: id, variant_id: 'v', stage: 'PENDING_REVIEW' })) } },
  }));
  writeFileSync(join(storageDir, 'agint_mutator.json'), JSON.stringify({ tables: { commits: { rows: [] } } }));
  return { storageDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('存储不可读 → skipped（防假防线）', async () => {
  const r = await auditEvolutionReconcile({ storageDir: join(tmpdir(), 'nope-' + Date.now()) });
  assert.equal(r.status, 'skipped');
  assert.match(r.reason, /STORAGE_UNREADABLE/);
});

test('repoRoot 未知但存储可读 → 照常对账（② 的收益：宿主无需 bin/repoRoot 也能跑）', async () => {
  const f = makeStorage([PID], [PID]);
  try {
    const r = await auditEvolutionReconcile({ storageDir: f.storageDir }); // 不传 repoRoot
    assert.equal(r.status, 'ok');
    assert.equal(r.result.counts.eventBusCommitted, 1);
    assert.equal(r.result.sources.preimageCheckable, false);
  } finally { f.cleanup(); }
});

test('committed 不在 population → diff（job 据此抛错出声）', async () => {
  const f = makeStorage([PID], ['other']);
  try {
    const r = await auditEvolutionReconcile({ storageDir: f.storageDir });
    assert.equal(r.status, 'diff');
    assert.equal(r.result.verdict.hardDiffs, 1);
  } finally { f.cleanup(); }
});
