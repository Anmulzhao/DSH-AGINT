/**
 * frozen-anchor job 的入参计算（宿主内跑，读仓库侧清单）
 *
 * ## 为什么这个模块自带算法，而不 import `bin/lib/scenario-tier.mjs`
 *
 * ⛔ **部署位没有 `eval/`**（实测：`~/.dsh/.agint-bundle/` 与 `~/.dsh/profiles/web/`
 * 向上都找不到 `eval/` 目录）。job 跑在宿主里，宿主加载的是**部署位那份字节**，
 * 跨层 `import '../../../bin/lib/scenario-tier.mjs'` 会
 *   ① 在部署位解析失败（路径不存在）→ 插件加载失败 → 整棵 preset 报
 *      `agent-preset/invalid: … waiting for …`；
 *   ② 即使解析成功，也把 eval 侧脚本变成插件的**运行时依赖**，
 *      而 eval/ 是「会被重跑生成器整体重写」的目录 ⇒ 插件跟着一起漂。
 *
 * 与 `agint-evolution-memory/lib/index.js` 接线 `frozen-set.js` 时同款纪律：
 * **插件不 import eval 侧脚本，聚合 hash 由 caller 算好传进来**。
 *
 * ## 那为什么这里又要算一遍
 *
 * 因为 cron job 就是 caller。这个模块是**唯一同时在宿主内运行、又必须读仓库**的位置。
 * 为避免「两套算法算出不同 hash」（那会让防篡改基线失效），本模块**只做一件事**：
 * 读清单里已算好的 `tierBaseline`，把它转成 `recordFrozenSet` 的入参。
 * **hash 一律取清单里的 `frozenAggregateHash`，绝不自己重算** ——
 * 清单由 `bin/build-scenario-inventory.mjs` 用 `scenario-tier.mjs` 生成，
 * 那是唯一算法真源。本模块重算 = 引入第二套口径 = 基线失效。
 *
 * ## 失败一律显式抛错
 *
 * 「读不到」/「格式不对」/「Frozen 为 0」都**抛错**，不返回空对象 ——
 * 返回空对象会让 job 报成功，而生产表仍是 0 行 ⇒ 入账看着做了实则没做。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 读仓库侧清单，算出 `recordFrozenSet` 的入参。
 *
 * @param {{repoRoot: string}} args
 * @returns {Promise<{
 *   tieringVersion: string, frozenCount: number, frozenUnitIds: string[],
 *   frozenAggregateHash: string, inventoryTotalUnits: number, failCount: number,
 *   h1EvolutionMinFail: number, h3FrozenFailProbeCap: number,
 * }>}
 * @throws 清单读不到 / 结构非法 / Frozen 为 0（都不静默）
 */
export async function computeFrozenEntry({ repoRoot } = {}) {
  if (!repoRoot || typeof repoRoot !== 'string') {
    throw new Error('computeFrozenEntry: 缺 repoRoot');
  }
  // ⛔ 路径基准：config 里的值是**字面量**（K83：insert 行的 name: 锚 patch 所在目录，
  //    但 config 值恒字面量）⇒ 这里自己 join，不依赖任何相对基准。
  const invPath = join(repoRoot, 'eval', 'scenarios', 'inventory.json');
  if (!existsSync(invPath)) {
    throw new Error(`computeFrozenEntry: 清单读不到 ${invPath} —— repoRoot 配错？`);
  }

  let inv;
  try {
    inv = JSON.parse(readFileSync(invPath, 'utf8'));
  } catch (e) {
    throw new Error(`computeFrozenEntry: 清单不是合法 JSON ${invPath} —— ${e.message}`);
  }

  // tierBaseline 是分层快照的落点（K146：sidecar → 清单的同步由生成器负责，
  // 这里只读清单，不读 sidecar —— 两个真源会漂）。
  const tb = inv?.tierBaseline;
  if (!tb) {
    throw new Error(`computeFrozenEntry: 清单里没有 tierBaseline（${invPath}）`
      + ' —— 跑 node bin/build-scenario-inventory.mjs 重新生成');
  }

  // ⛔ tierBaseline 里**没有** tierCounts 字段（实测其键集为
  //    criteriaErrors / criteriaOk / criteriaSkipped / failCount /
  //    frozenAggregateHash / frozenCount / frozenUnitIds / h1EvolutionMinFail /
  //    h3FrozenFailProbeCap / note / statusKnown / tieringFile / tieringVersion）
  //    ⇒ 计数只从 frozenCount 取，别去读不存在的 tierCounts。
  const frozenCount = Number(tb.frozenCount ?? 0);
  const hash = tb.frozenAggregateHash;

  // ⛔ 判据没过的清单不许入账 —— 记一份「判据红着的冻结集」等于给不健康的基线发通行证。
  if (tb.criteriaOk !== true) {
    throw new Error('computeFrozenEntry: 清单的 criteriaOk 不是 true'
      + `（criteriaErrors=${JSON.stringify(tb.criteriaErrors ?? [])}）`
      + ' —— 判据没过就不该锚定，先修判据');
  }

  // ⛔ Frozen 为 0 时**显式拒绝入账**：记一条「冻结集为空」的快照会让
  //   `benchmark_frozen_set` 从 0 行变 1 行，看起来「已锚定」实则什么也没冻结。
  if (frozenCount <= 0) {
    throw new Error('computeFrozenEntry: 清单里 Frozen 层为 0 —— 无可入账内容。'
      + ' 若确实该有，请先改 eval/tiers/agint-tiering.json 再重跑生成器');
  }
  if (typeof hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`computeFrozenEntry: 清单里 frozenAggregateHash 非法（${hash}）`
      + ' —— 期望 sha256:<64 hex>');
  }

  const units = Array.isArray(inv.units) ? inv.units : [];
  const failCount = units.filter((u) => u?.lastKnownStatus === 'FAIL').length;
  const totalUnits = Number(tb.inventoryTotalUnits ?? units.length);

  // H1/H3 由 failCount 现算，不读清单里的快照值 ——
  // fail 数变了但 H 下限没跟着变 = 判据失效（K139：采纳前先过全局占位）。
  const h1 = Math.ceil(0.6 * failCount);
  const h3 = Math.max(0, failCount - h1);

  // 名单：清单单元按 unitId 排序后取 visibility==='FROZEN'。
  // ⚠️ 清单是**生成物**，它可能还没带上新 tierBaseline（K146）⇒ 这里读 units 上的
  // visibility 字段读不到就**不猜**，改用 tierBaseline 里的名单（若清单提供）。
  const idsFromUnits = units
    .filter((u) => u?.visibility === 'FROZEN')
    .map((u) => u.unitId)
    .filter(Boolean)
    .sort();
  const idsFromBaseline = Array.isArray(tb.frozenUnitIds)
    ? [...tb.frozenUnitIds].filter(Boolean).sort()
    : [];
  const frozenUnitIds = idsFromBaseline.length > 0 ? idsFromBaseline : idsFromUnits;

  if (frozenUnitIds.length !== frozenCount) {
    // 不是致命错误（清单可能没存名单，只存了计数），但要出声 —— 不声的话
    // 「记了 4 个」与「实际列了 0 个」会一起进表，防篡改基线就废了。
    return {
      tieringVersion: String(tb.tieringVersion ?? ''),
      frozenCount,
      frozenUnitIds,
      frozenAggregateHash: hash,
      inventoryTotalUnits: totalUnits,
      failCount,
      h1EvolutionMinFail: h1,
      h3FrozenFailProbeCap: h3,
      __warning: `FROZEN 名单条数(${frozenUnitIds.length}) 与计数(${frozenCount}) 不一致`,
    };
  }

  return {
    tieringVersion: String(tb.tieringVersion ?? ''),
    frozenCount,
    frozenUnitIds,
    frozenAggregateHash: hash,
    inventoryTotalUnits: totalUnits,
    failCount,
    h1EvolutionMinFail: h1,
    h3FrozenFailProbeCap: h3,
  };
}
