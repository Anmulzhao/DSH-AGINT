// plugins/agint-cron/lib/evolution-reconcile-core.js —— 闭环进化取数三方对账判据（Phase -1.1）
//
// 为什么住这里（不是 bin/）：宿主 bundle 部署位没有 bin/，判据必须随 cron 插件一起
//   部署才能在常驻宿主上真跑。本文件是**判据单一源**；开发机 CLI `bin/reconcile-evolution-stats.mjs`
//   反过来 import 它（bin→plugin-lib 的先例见 bin/rebuild-ledger-history.mjs）。
//
// 解决什么问题：mutator_stats.commits 恒为空表，但 event_bus 与 population 有真实数据。
//   只按 mutator 口径读会把"跑成了"读成"没跑过"。本判据用取数优先级链交叉核对四源，
//   把「不可回滚 / 记录丢失」这类报告性差异单独列出。
//
// 取数优先级链（一个「commit 是否发生」的事实，从上往下找证据）：
//   1. event_bus   —— topic='evolution.mutation.committed'，envelope.payload.proposalId（优先）
//   2. population  —— table='variants'，行.commit_id（次选；commit_id 值 == proposalId）
//   3. 磁盘 preimage —— repoRoot/.agint-preimage/*.bak，命中 committed.payload.preimagePath（兜底）
//   4. mutator_stats —— agint_mutator.json.commits（当前不可靠，只读上报，不作真值）
//
// 差异分类：
//   · 结构差异（不计入 diff）：population 跟踪所有候选而 committed 只是子集；preimage 目录可能有孤儿 .bak。
//   · 报告性差异（计入 diff，非零即告警）：
//       R1 committed 的 proposalId 在 population 找不到 —— 事件与种群失同步。
//       R2 committed 的 preimagePath 磁盘不存在 —— 有 commit 无备份 = 不可回滚（安全红线）。
//       R3 population 有 variant 但无 committed 事件 —— 无法佐证是否落盘（软差异）。
//
// ⛔ 只读：本判据不写盘、不改 process.env，纯计算。
// ⛔ 诚实守卫：存储不可读 = 'unavailable'，绝不冒充「零差异通过」。

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

/** 存储 json 落在 $DSH_HOME/storages/（DSH_HOME 是基目录，不含 storages 段）。 */
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
 * 纯判据函数。
 * @param {object} [opts]
 * @param {string} [opts.storageDir] 生产存储目录（默认 $DSH_HOME/storages）
 * @param {string} [opts.repoRoot]   AGINT 仓根（preimage 在其下；缺则跳过第 3 源）
 * @returns {{status:'ok'|'diff'|'unavailable', reason?, counts, structural, diffs, verdict, notes, sources}}
 */
export function reconcileEvolutionStats(opts = {}) {
  const storageDir = resolve(opts.storageDir || defaultStorageDir());
  const repoRoot = opts.repoRoot ? resolve(opts.repoRoot) : null;

  // 诚实守卫：存储里既无 event_bus 也无 population = 读不到数据源，绝不 fallthrough 成 0-diff 假 PASS。
  const busReadable = existsSync(join(storageDir, 'agint_event_bus.json'));
  const popReadable = existsSync(join(storageDir, 'agint_population.json'));
  if (!busReadable && !popReadable) {
    return {
      status: 'unavailable',
      reason: `STORAGE_UNREADABLE: ${storageDir} 下无 agint_event_bus.json / agint_population.json`,
      counts: null, structural: null, diffs: null, notes: [],
      sources: { storageDir, repoRoot },
      verdict: { hardDiffs: 0, softDiffs: 0, pass: false },
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
  if (!preimageCheckable) {
    notes.push(repoRoot ? 'PREIMAGE_DIR_ABSENT: 无 .agint-preimage（R2 无法核）' : 'REPO_ROOT_UNKNOWN: 跳过 preimage 源（R2 无法核）');
  }

  for (const c of committed) {
    if (c.proposalId && !popCommitIds.has(c.proposalId)) R1.push(c);
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
    structural: { populationWithoutEvent: R3.length, orphanPreimages: orphanPreimages.length },
    diffs: {
      R1_committedNotInPopulation: R1.map((c) => c.proposalId),
      R2_committedMissingPreimage: R2.map((c) => ({ proposalId: c.proposalId, preimagePath: c.preimagePath })),
      R3_populationUncorroborated: R3.map((p) => ({ commitId: p.commitId, stage: p.stage })),
    },
    verdict: { hardDiffs, softDiffs, pass: hardDiffs === 0 },
    notes,
  };
}
