// plugins/agint-cron/lib/evolution-reconcile-audit.js —— 闭环进化取数对账的 cron 封装
//
// 用途：cron 的 evolution-reconcile job 每周在 evolution-cycle 之后跑一次，回答——
//   「这一期闭环到底跑成了没有？四条取数源互相对得上吗？」（Phase -1.1 收口）
//
// ⛔ **只读，不写盘**：对账是「发现差异并出声」，修复（补 preimage / 修 mutator 口径 /
//   重跑）由人做。cron 在宿主进程里跑，宿主不是仓库工作副本，不在那里落审计报告。
//
// ⛔ **判据单一源**：真正的四源对账逻辑在 `bin/reconcile-evolution-stats.mjs` 的
//   `reconcileEvolutionStats()`，本文件动态 import 它、不复制第二份（两份校验器必然
//   分叉，与 spec-index-audit.js 复用 build-spec-index 同源）。
//
// ⛔ **部署位没有 bin/**（实测）：bundle 部署位只有 plugins/，无 bin/ 无 docs/。
//   ⇒ 常驻宿主上本 job 大概率 soft-skip。这不是 bug，是「能力不在这一层」（K134）；
//   所以 skip 必须写清缺哪一项，绝不把「读不到」当成「零差异通过」（防假防线）。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 对账判据脚本相对仓库根的位置。 */
export const RECONCILE_REL = join('bin', 'reconcile-evolution-stats.mjs');

/**
 * @param {object} opts
 * @param {string|null} opts.repoRoot  AGINT 仓根（cron config repoRoot；null = 未知）
 * @param {string} [opts.storageDir]   生产存储目录，透传给判据（默认由判据按 DSH_HOME 推）
 * @returns {Promise<{status:'ok'|'diff'|'skipped', reason?:string, result?:object}>}
 *   · 'skipped' = 判据不可用（仓根未知 / bin 缺失 / 存储不可读），绝不冒充 ok。
 *   · 'diff'    = 有报告性差异（R1/R2），job 应抛错出声。
 *   · 'ok'      = 零报告性差异。
 */
export async function auditEvolutionReconcile({ repoRoot, storageDir } = {}) {
  if (!repoRoot) {
    return { status: 'skipped', reason: 'REPO_ROOT_UNKNOWN: cron config.repoRoot 未配，无法定位 bin 判据与 preimage 源' };
  }
  const cliPath = join(repoRoot, RECONCILE_REL);
  if (!existsSync(cliPath)) {
    return { status: 'skipped', reason: `RECONCILE_CLI_MISSING: ${RECONCILE_REL} 不在 ${repoRoot}（部署位无 bin/ ⇒ 预期 soft-skip）` };
  }
  let mod;
  try {
    mod = await import(pathToFileURL(cliPath).href);
  } catch (error) {
    return { status: 'skipped', reason: `RECONCILE_CLI_UNLOADABLE: ${error.message}` };
  }
  if (typeof mod.reconcileEvolutionStats !== 'function') {
    return { status: 'skipped', reason: 'RECONCILE_NO_EXPORT: reconcileEvolutionStats 未导出，判据不可用' };
  }

  const r = mod.reconcileEvolutionStats({ storageDir, repoRoot });
  if (r.status === 'unavailable') {
    return { status: 'skipped', reason: r.reason };
  }
  return { status: r.verdict && r.verdict.hardDiffs > 0 ? 'diff' : 'ok', result: r };
}
