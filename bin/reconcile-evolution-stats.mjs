#!/usr/bin/env node
/**
 * bin/reconcile-evolution-stats.mjs — 闭环进化「取数口径」三方对账（Phase -1.1）
 *
 * 解决什么问题：
 *   mutator_stats.commits 恒为空表，但 event_bus 与 population 有真实数据。
 *   只按 mutator 口径读，会把「跑成了」读成「没跑过」。本脚本用取数优先级链
 *   交叉核对四个源，把不可回滚、记录丢失这类**报告性差异**单独列出。
 *
 * 取数优先级链（一个「commit 是否发生」的事实，从上往下找证据）：
 *   1. event_bus   —— topic='evolution.mutation.committed'，envelope.payload.proposalId（优先）
 *   2. population  —— table='variants'，行.commit_id（次选；commit_id 值 == proposalId）
 *   3. 磁盘 preimage —— repoRoot/.agint-preimage/*.bak，命中 committed.payload.preimagePath（兜底）
 *   4. mutator_stats —— agint_mutator.json.commits（当前不可靠，只读上报，不作真值）
 *
 * 差异分两类，避免误报：
 *   · 结构差异（不计入 diff，仅信息）：population 跟踪所有候选，committed 事件只是子集；
 *     preimage 目录可能有孤儿 .bak（改盘但事件被裁剪）。
 *   · 报告性差异（计入 diff，非零即告警）：
 *       R1 committed 事件的 proposalId 在 population 找不到对应 variant —— 事件与种群失同步。
 *       R2 committed 事件的 preimagePath 在磁盘不存在 —— **有 commit 无备份 = 不可回滚**（安全红线）。
 *       R3 population 有 variant 但无 committed 事件 —— 无法佐证是否真落盘（软差异）。
 *
 * 判据单一源：cron 的 evolution-reconcile job 经 lib/evolution-reconcile-audit.js 动态
 *   import 本文件的 reconcileEvolutionStats()，不自造第二份（两份校验器必然分叉）。
 *
 * 跑法：
 *   node bin/reconcile-evolution-stats.mjs
 *   node bin/reconcile-evolution-stats.mjs --json
 *   node bin/reconcile-evolution-stats.mjs --storage=... --repo-root=...
 *   node bin/reconcile-evolution-stats.mjs --strict   # R3 也算 FAIL（默认只 warn）
 *
 * 退出码：0 = 无报告性差异；1 = 存在 R1/R2（或 --strict 下含 R3）。
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

// ── 存储 json 落在 $DSH_HOME/storages/（DSH_HOME 是基目录，不含 storages 段）──
export function defaultStorageDir() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages');
}

function readJson(dir, file) {
  const p = join(dir, file);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function rowsOf(table) {
  if (!table) return [];
  if (Array.isArray(table)) return table;
  if (table.rows && typeof table.rows === 'object') return Object.values(table.rows);
  return Object.values(table);
}

function tableOf(store, name) {
  if (!store?.tables) return [];
  return rowsOf(store.tables[name]);
}

// ── 四个源各读一遍 ──────────────────────────────────────────────────────────
function readCommitted(dir) {
  const store = readJson(dir, 'agint_event_bus.json');
  const out = [];
  if (!store?.tables) return out;
  for (const key of Object.keys(store.tables)) {
    for (const row of rowsOf(store.tables[key])) {
      const env = row?.envelope ?? row;
      if (!env || env.topic !== 'evolution.mutation.committed') continue;
      const pl = env.payload ?? {};
      out.push({
        proposalId: pl.proposalId ?? null,
        candidateId: pl.candidateId ?? null,
        path: pl.path ?? null,
        preimagePath: pl.preimagePath ?? null,
        occurredAt: env.occurredAt ?? null,
      });
    }
  }
  return out;
}

function readPopulation(dir) {
  const store = readJson(dir, 'agint_population.json');
  return tableOf(store, 'variants')
    .map((v) => ({ commitId: v.commit_id ?? null, variantId: v.variant_id ?? null, stage: v.stage ?? null }))
    .filter((v) => v.commitId);
}

function readPreimageDir(repoRoot) {
  if (!repoRoot) return { dir: null, present: false, files: new Set() };
  const dir = join(repoRoot, '.agint-preimage');
  if (!existsSync(dir)) return { dir, present: false, files: new Set() };
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.bak')); } catch { files = []; }
  return { dir, present: true, files: new Set(files) };
}

function readMutator(dir) {
  const store = readJson(dir, 'agint_mutator.json');
  return tableOf(store, 'commits').length;
}

/**
 * 纯判据函数：给定存储目录与仓库根，返回结构化对账结果。
 * @param {object} [opts]
 * @param {string} [opts.storageDir] 生产存储目录（默认 $DSH_HOME/storages）
 * @param {string} [opts.repoRoot]   AGINT 仓根（preimage 在其下；缺则跳过 preimage 源）
 * @returns {{status:'ok'|'diff'|'unavailable', counts, structural, diffs, verdict, notes}}
 *   status：'unavailable' = 存储不可读（既不 fallthrough 成 0-diff 的假 PASS）。
 */
export function reconcileEvolutionStats(opts = {}) {
  const storageDir = resolve(opts.storageDir || defaultStorageDir());
  const repoRoot = opts.repoRoot ? resolve(opts.repoRoot) : null;

  // 诚实守卫：存储里既无 event_bus 也无 population 文件 = 读不到数据源。
  // 绝不能把「读不到」当成「零差异通过」——那正是本工具要治的病的翻版。
  const busReadable = existsSync(join(storageDir, 'agint_event_bus.json'));
  const popReadable = existsSync(join(storageDir, 'agint_population.json'));
  if (!busReadable && !popReadable) {
    return {
      status: 'unavailable',
      reason: `STORAGE_UNREADABLE: ${storageDir} 下无 agint_event_bus.json / agint_population.json`,
      counts: null, structural: null, diffs: null, verdict: { hardDiffs: 0, softDiffs: 0, pass: false }, notes: [],
    };
  }

  const committed = readCommitted(storageDir);
  const population = readPopulation(storageDir);
  const preimage = readPreimageDir(repoRoot);
  const mutatorCommits = readMutator(storageDir);

  const committedIds = new Set(committed.map((c) => c.proposalId).filter(Boolean));
  const popCommitIds = new Set(population.map((p) => p.commitId));

  const notes = [];
  const R1 = [];
  const R2 = [];
  const preimageCheckable = preimage.present;
  if (!preimageCheckable) notes.push(repoRoot ? 'PREIMAGE_DIR_ABSENT: 无 .agint-preimage（R2 无法核）' : 'REPO_ROOT_UNKNOWN: 跳过 preimage 源（R2 无法核）');

  for (const c of committed) {
    if (c.proposalId && !popCommitIds.has(c.proposalId)) R1.push(c);
    // 只有能查 preimage 时才判 R2；查不了不等于「缺失」，不得虚报不可回滚。
    if (preimageCheckable) {
      const rel = c.preimagePath;
      const abs = !rel ? null : (isAbsolute(rel) ? rel : join(repoRoot, rel));
      const ok = abs && existsSync(abs) && statSync(abs).isFile();
      if (!ok) R2.push(c);
    }
  }

  const R3 = population.filter((p) => !committedIds.has(p.commitId));

  const referencedPreimages = new Set(committed.map((c) => c.preimagePath).filter(Boolean).map((p) => p.split(/[\\/]/).pop()));
  const orphanPreimages = preimage.present ? [...preimage.files].filter((f) => !referencedPreimages.has(f)) : [];

  const hardDiffs = R1.length + R2.length;
  const softDiffs = R3.length;

  return {
    status: hardDiffs > 0 ? 'diff' : 'ok',
    generatedAt: new Date().toISOString(),
    sources: { storageDir, repoRoot, preimageDir: preimage.dir, preimageDirPresent: preimage.present, preimageCheckable },
    counts: {
      eventBusCommitted: committed.length,
      populationVariants: population.length,
      diskPreimages: preimage.present ? preimage.files.size : 0,
      mutatorCommits,
      mutatorDegraded: mutatorCommits === 0 && committed.length > 0,
    },
    structural: {
      populationWithoutEvent: R3.length,
      orphanPreimages: orphanPreimages.length,
    },
    diffs: {
      R1_committedNotInPopulation: R1.map((c) => c.proposalId),
      R2_committedMissingPreimage: R2.map((c) => ({ proposalId: c.proposalId, preimagePath: c.preimagePath })),
      R3_populationUncorroborated: R3.map((p) => ({ commitId: p.commitId, stage: p.stage })),
    },
    verdict: { hardDiffs, softDiffs, pass: hardDiffs === 0 },
    notes,
  };
}

// ── CLI 渲染（仅直接运行时执行，import 时不触发）─────────────────────────────
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
  console.log(`  4 mutator_stats.commits: ${c.mutatorCommits}${c.mutatorDegraded ? '  ⚠ 恒空，不作真值' : ''}`);
  console.log('');
  console.log('结构差异（不计 FAIL）：');
  console.log(`  population 候选无 committed 事件 : ${r.structural.populationWithoutEvent}`);
  console.log(`  磁盘孤儿 .bak（无事件引用）      : ${r.structural.orphanPreimages}`);
  console.log('');
  console.log('报告性差异：');
  console.log(`  R1 committed 不在 population : ${r.diffs.R1_committedNotInPopulation.length}`);
  console.log(`  R2 committed 磁盘缺 preimage : ${r.diffs.R2_committedMissingPreimage.length}${r.diffs.R2_committedMissingPreimage.length ? '  ⛔ 有 commit 无备份 = 不可回滚' : ''}`);
  console.log(`  R3 population 无法佐证       : ${r.diffs.R3_populationUncorroborated.length}${strict ? '（strict → 计 FAIL）' : '（warn）'}`);
  for (const x of r.diffs.R2_committedMissingPreimage) console.log(`      · ${x.proposalId} → ${x.preimagePath}`);
  for (const n of r.notes) console.log(`  ⓘ ${n}`);
  console.log('');
  console.log(fail ? `判定：FAIL（hard=${r.verdict.hardDiffs}${strict ? ` soft=${r.verdict.softDiffs}` : ''}）` : '判定：PASS（零报告性差异）');
  return fail ? 1 : 0;
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (k, dflt) => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : dflt;
  };
  const has = (k) => argv.includes(`--${k}`);
  const strict = has('strict');
  const opts = {
    storageDir: arg('storage') || defaultStorageDir(),
    repoRoot: arg('repo-root') || process.env.DSH_PROJECT_ROOT || process.cwd(),
  };
  const r = reconcileEvolutionStats(opts);
  if (has('json')) { console.log(JSON.stringify(r, null, 2)); process.exit(r.status === 'diff' ? 1 : r.status === 'unavailable' ? 1 : 0); }
  process.exit(render(r, { strict }));
}

// 仅当被直接执行时跑 CLI；被 import（cron 审计）时不触发。
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
