// plugins/agint-cron/test/evolution-reconcile.test.mjs —— cron 对账封装决策（Phase -1.1）
//
// 封装只做三件事：定位并 import bin 判据、把结果映射成 ok/diff/skipped、
// 绝不把「判据不可用」冒充成「通过」。真正的对账逻辑由 bin 自己的测试覆盖。
// 这里用 stub bin（写进 tmp repoRoot）注入 canned 结果，隔离被测层。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { auditEvolutionReconcile, RECONCILE_REL } from '../lib/evolution-reconcile-audit.js';

/** 造一个假仓根，内含指定的 bin/reconcile-evolution-stats.mjs 源码。 */
function makeRepoWithStubBin(source) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'recon-root-'));
  const binDir = join(repoRoot, 'bin');
  mkdirSync(binDir, { recursive: true });
  if (source !== null) writeFileSync(join(repoRoot, RECONCILE_REL), source, 'utf8');
  return { repoRoot, cleanup: () => rmSync(repoRoot, { recursive: true, force: true }) };
}

const STUB_DIFF = `export function reconcileEvolutionStats(){ return { status:'diff', verdict:{hardDiffs:2}, counts:{eventBusCommitted:2}, diffs:{R1_committedNotInPopulation:[],R2_committedMissingPreimage:[]} }; }`;
const STUB_OK = `export function reconcileEvolutionStats(){ return { status:'ok', verdict:{hardDiffs:0}, counts:{eventBusCommitted:1} }; }`;
const STUB_UNAVAILABLE = `export function reconcileEvolutionStats(){ return { status:'unavailable', reason:'STORAGE_UNREADABLE: /x' }; }`;
const STUB_NO_EXPORT = `export const somethingElse = 1;`;

test('repoRoot 未知 → skipped（不猜目录，避免审另一份仓库报假差异）', async () => {
  const r = await auditEvolutionReconcile({ repoRoot: null });
  assert.equal(r.status, 'skipped');
  assert.match(r.reason, /REPO_ROOT_UNKNOWN/);
});

test('bin 判据脚本缺失（部署位无 bin/）→ skipped', async () => {
  const f = makeRepoWithStubBin(null);
  try {
    const r = await auditEvolutionReconcile({ repoRoot: f.repoRoot });
    assert.equal(r.status, 'skipped');
    assert.match(r.reason, /RECONCILE_CLI_MISSING/);
  } finally { f.cleanup(); }
});

test('bin 未导出判据函数 → skipped（判据不可用 ≠ 通过）', async () => {
  const f = makeRepoWithStubBin(STUB_NO_EXPORT);
  try {
    const r = await auditEvolutionReconcile({ repoRoot: f.repoRoot });
    assert.equal(r.status, 'skipped');
    assert.match(r.reason, /RECONCILE_NO_EXPORT/);
  } finally { f.cleanup(); }
});

test('判据返回 unavailable → skipped（透传缺因，绝不冒充 ok）', async () => {
  const f = makeRepoWithStubBin(STUB_UNAVAILABLE);
  try {
    const r = await auditEvolutionReconcile({ repoRoot: f.repoRoot });
    assert.equal(r.status, 'skipped');
    assert.match(r.reason, /STORAGE_UNREADABLE/);
  } finally { f.cleanup(); }
});

test('判据有硬差异 → diff，带 result 供 job 抛错', async () => {
  const f = makeRepoWithStubBin(STUB_DIFF);
  try {
    const r = await auditEvolutionReconcile({ repoRoot: f.repoRoot });
    assert.equal(r.status, 'diff');
    assert.equal(r.result.verdict.hardDiffs, 2);
  } finally { f.cleanup(); }
});

test('判据零差异 → ok', async () => {
  const f = makeRepoWithStubBin(STUB_OK);
  try {
    const r = await auditEvolutionReconcile({ repoRoot: f.repoRoot });
    assert.equal(r.status, 'ok');
    assert.equal(r.result.counts.eventBusCommitted, 1);
  } finally { f.cleanup(); }
});
