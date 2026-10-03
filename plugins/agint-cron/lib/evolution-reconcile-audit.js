// plugins/agint-cron/lib/evolution-reconcile-audit.js —— cron 对账 job 的决策封装（Phase -1.1）
//
// cron 的 evolution-reconcile job 每周在 evolution-cycle 之后跑，回答：
//   「这期闭环跑成了没有？四源对得上吗？」
//
// ⛔ **只读出声，不写盘**：发现差异由 job 抛错进 cron 健康记录，修复（补 preimage /
//   修 mutator 口径 / 重跑）由人做。
//
// 判据来自同插件的 ./evolution-reconcile-core.js（静态 import，随 bundle 部署）——
//   所以**宿主 bundle 上本 job 能真跑**，不再像早期版本那样依赖 bin/（部署位无 bin/）。
//   repoRoot 未知只降级为「跳过 preimage 第 3 源」，3 个存储源照常对账；
//   仅当存储也读不到才 skipped（读不到 ≠ 零差异通过）。

import { reconcileEvolutionStats } from './evolution-reconcile-core.js';

/**
 * @param {object} opts
 * @param {string|null} [opts.repoRoot]   AGINT 仓根（cron config.repoRoot；null = 跳过 preimage 源）
 * @param {string} [opts.storageDir]      生产存储目录，透传 core（默认按 DSH_HOME 推）
 * @returns {Promise<{status:'ok'|'diff'|'skipped', reason?, result?}>}
 */
export async function auditEvolutionReconcile({ repoRoot, storageDir } = {}) {
  const r = reconcileEvolutionStats({ storageDir, repoRoot });
  if (r.status === 'unavailable') {
    return { status: 'skipped', reason: r.reason };
  }
  return { status: r.verdict && r.verdict.hardDiffs > 0 ? 'diff' : 'ok', result: r };
}
