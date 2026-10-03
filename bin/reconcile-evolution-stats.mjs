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
 *       R3 population 有 variant 但既无 committed 事件、磁盘也无其 preimage —— 无法佐证是否真落盘。
 *
 * 跑法：
 *   node bin/reconcile-evolution-stats.mjs
 *   node bin/reconcile-evolution-stats.mjs --json
 *   node bin/reconcile-evolution-stats.mjs --storage=C:/Users/Administrator/.dsh/storages --repo-root=D:/DSH/project源码/DSH-AGINT
 *   node bin/reconcile-evolution-stats.mjs --strict   # R3 也算 FAIL（默认只 warn）
 *
 * 退出码：0 = 无报告性差异；1 = 存在 R1/R2（或 --strict 下含 R3）。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (k, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : dflt;
};
const has = (k) => argv.includes(`--${k}`);

const AS_JSON = has('json');
const STRICT = has('strict');
const DEFAULT_HOME = join(homedir(), '.dsh');
// 存储 json 落在 $DSH_HOME/storages/（DSH_HOME 是基目录，不含 storages 段）。
const STORAGE = resolve(arg('storage', join(process.env.DSH_HOME || DEFAULT_HOME, 'storages')));
// repoRoot = preimage 目录所在。committed.payload.preimagePath 是相对 repoRoot 的路径。
const REPO_ROOT = resolve(arg('repo-root', process.env.DSH_PROJECT_ROOT || process.cwd()));

// ── 读取工具（与 bin/t2-reconcile.mjs 同约定）───────────────────────────────
function readJson(file) {
  const p = join(STORAGE, file);
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

// ── 源 1：event_bus committed ───────────────────────────────────────────────
function readCommitted() {
  const store = readJson('agint_event_bus.json');
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

// ── 源 2：population variants（commit_id == proposalId）─────────────────────
function readPopulation() {
  const store = readJson('agint_population.json');
  return tableOf(store, 'variants')
    .map((v) => ({ commitId: v.commit_id ?? null, variantId: v.variant_id ?? null, stage: v.stage ?? null }))
    .filter((v) => v.commitId);
}

// ── 源 3：磁盘 preimage 目录清单 ────────────────────────────────────────────
function readPreimageDir() {
  const dir = join(REPO_ROOT, '.agint-preimage');
  if (!existsSync(dir)) return { dir, present: false, files: new Set() };
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.bak')); } catch { files = []; }
  return { dir, present: true, files: new Set(files) };
}

function preimageOnDisk(relPath) {
  if (!relPath) return false;
  const abs = isAbsolute(relPath) ? relPath : join(REPO_ROOT, relPath);
  return existsSync(abs);
}

// ── 源 4：mutator_stats.commits（已知不可靠，只上报）────────────────────────
function readMutator() {
  const store = readJson('agint_mutator.json');
  return tableOf(store, 'commits').length;
}

// ── 对账 ────────────────────────────────────────────────────────────────────
const committed = readCommitted();
const population = readPopulation();
const preimage = readPreimageDir();
const mutatorCommits = readMutator();

const popCommitIds = new Set(population.map((p) => p.commitId));
const committedIds = new Set(committed.map((c) => c.proposalId).filter(Boolean));

const R1 = []; // committed 事件在 population 找不到
const R2 = []; // committed 事件磁盘无 preimage（不可回滚）
for (const c of committed) {
  if (c.proposalId && !popCommitIds.has(c.proposalId)) R1.push(c);
  if (!preimageOnDisk(c.preimagePath)) R2.push(c);
}

// population 有但 committed 事件没有的 variant —— 无法用事件佐证其落盘，记软差异（warn）。
// 结构上多是「已 propose 未 commit」的候选，故默认不判 FAIL；--strict 时收紧。
const R3 = population.filter((p) => !committedIds.has(p.commitId));

// 磁盘孤儿 .bak（无 committed 事件引用）——纯信息项。
const referencedPreimages = new Set(committed.map((c) => c.preimagePath).filter(Boolean).map((p) => p.split(/[\\/]/).pop()));
const orphanPreimages = preimage.present
  ? [...preimage.files].filter((f) => !referencedPreimages.has(f))
  : [];

// 判定：R1 + R2 恒为报告性差异；R3 在 --strict 下才算 FAIL。
const hardDiffs = R1.length + R2.length;
const softDiffs = R3.length;
const fail = hardDiffs > 0 || (STRICT && softDiffs > 0);

// ── 输出 ────────────────────────────────────────────────────────────────────
const report = {
  generatedAt: new Date().toISOString(),
  sources: { storage: STORAGE, repoRoot: REPO_ROOT, preimageDir: preimage.dir, preimageDirPresent: preimage.present },
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
  verdict: { hardDiffs, softDiffs, strict: STRICT, pass: !fail },
};

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const c = report.counts;
  console.log('闭环进化取数三方对账（Phase -1.1）');
  console.log(`  存储: ${STORAGE}`);
  console.log(`  repoRoot: ${REPO_ROOT}`);
  console.log('');
  console.log('源计数：');
  console.log(`  1 event_bus committed : ${c.eventBusCommitted}`);
  console.log(`  2 population variants : ${c.populationVariants}`);
  console.log(`  3 磁盘 preimage .bak  : ${c.diskPreimages}${report.sources.preimageDirPresent ? '' : '（目录不存在）'}`);
  console.log(`  4 mutator_stats.commits: ${c.mutatorCommits}${c.mutatorDegraded ? '  ⚠ 恒空，不作真值' : ''}`);
  console.log('');
  console.log('结构差异（不计 FAIL）：');
  console.log(`  population 候选无 committed 事件 : ${report.structural.populationWithoutEvent}`);
  console.log(`  磁盘孤儿 .bak（无事件引用）      : ${report.structural.orphanPreimages}`);
  console.log('');
  console.log('报告性差异：');
  console.log(`  R1 committed 不在 population : ${R1.length}`);
  console.log(`  R2 committed 磁盘缺 preimage : ${R2.length}${R2.length ? '  ⛔ 有 commit 无备份 = 不可回滚' : ''}`);
  console.log(`  R3 population 无法佐证       : ${R3.length}${STRICT ? '（strict → 计 FAIL）' : '（warn）'}`);
  for (const r of R2) console.log(`      · ${r.proposalId} → ${r.preimagePath}`);
  console.log('');
  console.log(fail ? `判定：FAIL（hard=${hardDiffs}${STRICT ? ` soft=${softDiffs}` : ''}）` : '判定：PASS（零报告性差异）');
}

process.exit(fail ? 1 : 0);
