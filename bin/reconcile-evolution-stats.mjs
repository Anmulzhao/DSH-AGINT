#!/usr/bin/env node
/**
 * bin/reconcile-evolution-stats.mjs — 闭环进化取数三方对账 CLI（Phase -1.1）
 *
 * 薄壳：真正的判据在 plugins/agint-cron/lib/evolution-reconcile-core.js（单一源，
 * 与 cron 的 evolution-reconcile job 共用）。本文件只负责解析参数 + 人读渲染 + 退出码。
 *
 * 取数优先级链：event_bus → population → 磁盘 preimage → mutator_stats（详见 core 注释）。
 *
 * 跑法：
 *   node bin/reconcile-evolution-stats.mjs
 *   node bin/reconcile-evolution-stats.mjs --json
 *   node bin/reconcile-evolution-stats.mjs --storage=... --repo-root=...
 *   node bin/reconcile-evolution-stats.mjs --strict   # R3 也算 FAIL（默认只 warn）
 * 退出码：0 = 无报告性差异；1 = 有 R1/R2（或 --strict 下含 R3 / 存储不可读）。
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { reconcileEvolutionStats, defaultStorageDir } from '../plugins/agint-cron/lib/evolution-reconcile-core.js';

function render(r, { strict }) {
  if (r.status === 'unavailable') {
    console.error(`⛔ 存储不可读，无法对账：${r.reason}`);
    return 1;
  }
  const c = r.counts;
  const fail = r.verdict.hardDiffs > 0 || (strict && r.verdict.softDiffs > 0);
  console.log('闭环进化取数三方对账（Phase -1.1）');
  console.log(`  存储: ${r.sources.storageDir}`);
  console.log(`  repoRoot: ${r.sources.repoRoot || '(未配置)'}  preimage: ${r.sources.preimageDirPresent ? '✓' : '✗'}${r.sources.preimageCheckable ? '' : '（R2 跳过）'}`);
  console.log('');
  console.log('源计数：');
  console.log(`  1 event_bus committed : ${c.eventBusCommitted}`);
  console.log(`  2 population variants : ${c.populationVariants}`);
  console.log(`  3 磁盘 preimage .bak  : ${c.diskPreimages}`);
  console.log(`  4 mutator_stats.commits: ${c.mutatorCommits}  [${c.mutatorState}]`);
  // A5：三态各有各的含义，不能压成一句「恒空，不作真值」（那句话在 driver
  // 开始记账之前是对的，现在恒假，而恒假的说明比没有说明更坏）。
  if (c.mutatorState === 'absent') {
    console.log('      ⓘ mutator 存储读不到 —— 本源不参与对账（无数据 ≠ 0 数据）');
  } else if (c.mutatorState === 'unwired') {
    console.log('      ⚠ 有 committed 事件但 commits 表为 0 —— 这批 commit 未记账，不可被 mutator.rollback 回滚');
    console.log('        （存量债：A5 的记账入口只对修复后的 commit 生效，宿主重启并产生新 commit 后自动转consistent）');
  } else if (c.mutatorState === 'gap') {
    console.log(`      ⚠ commits 表 ${c.mutatorCommits} 条 < committed 事件 ${c.eventBusCommitted} 条 —— 部分 commit 未记账`);
  }
  console.log('');
  console.log('结构差异（不计 FAIL）：');
  console.log(`  population 候选无 committed 事件 : ${r.structural.populationWithoutEvent}`);
  console.log(`  磁盘孤儿 .bak（无事件引用）      : ${r.structural.orphanPreimages}`);
  console.log('');
  console.log('报告性差异：');
  console.log(`  R1 committed 不在 population : ${r.diffs.R1_committedNotInPopulation.length}`);
  console.log(`  R2 committed 磁盘缺 preimage : ${r.diffs.R2_committedMissingPreimage.length}${r.diffs.R2_committedMissingPreimage.length ? '  ⛔ 有 commit 无备份 = 不可回滚' : ''}`);
  console.log(`  R3 population 无法佐证       : ${r.diffs.R3_populationUncorroborated.length}${strict ? '（strict → 计 FAIL）' : '（warn）'}`);
  console.log(`  R4 mutator 记账缺口          : ${r.diffs.R4_mutatorAccountingGap.length}${r.diffs.R4_mutatorAccountingGap.length ? `${strict ? '（strict → 计 FAIL）' : '（warn）'}` : ''}`);
  for (const x of r.diffs.R4_mutatorAccountingGap) console.log(`      · ${x.state}：committed=${x.committed} vs mutator.commits=${x.mutatorCommits}`);
  for (const x of r.diffs.R2_committedMissingPreimage) console.log(`      · ${x.proposalId} → ${x.preimagePath}`);
  for (const n of r.notes) console.log(`  ⓘ ${n}`);
  console.log('');
  console.log(fail ? `判定：FAIL（hard=${r.verdict.hardDiffs}${strict ? ` soft=${r.verdict.softDiffs}` : ''}）` : '判定：PASS（零报告性差异）');
  return fail ? 1 : 0;
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (k) => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : undefined;
  };
  const strict = argv.includes('--strict');
  const r = reconcileEvolutionStats({
    storageDir: arg('storage') || defaultStorageDir(),
    repoRoot: arg('repo-root') || process.env.DSH_PROJECT_ROOT || process.cwd(),
  });
  if (argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.status === 'ok' ? 0 : 1);
  }
  process.exit(render(r, { strict }));
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
