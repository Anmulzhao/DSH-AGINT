/**
 * agint-evolution-driver —— expected-effect.js
 *
 * 1b 前置修正：`expectedEffect` 按**目标类型**声明，不再对所有变异写同一句谎话。
 *
 * ## 治的是哪个谎
 *
 * 改动前：driver 给每一个变异硬写 `'baseline 通过率 >= 95% 在 7 天'`（原 `index.js:605`）。
 * 两个缺陷：
 *   1. **不分目标**：改一个 SKILL.md 也声称"通过率"会涨，而技能类改动今天没有任何测量手段
 *      （实测：abtest 0 行、population fitness_history/traffic_log 0 行、
 *      trajectory 的 token/durationMs 无生产者）。
 *   2. **借词**：`metric-resolver.js` 会照词面把它解析成 SUCCESS_RATE ⇒ 锁一条
 *      永远没人测的预测。锁本身是真的（时序合法），但**它承诺的是一个拿不到的数**，
 *      攒出来的校准分会是"预测 vs 无证据"的混合物，正是 Phase 1 要防的形状。
 *
 * ## 判据：只声明有仪器能兑现的期望
 *
 * - 代码类目标（repo 文件）⇒ 声明**场景集**通过率。仪器就是
 *   `eval/scenarios/driver.js`（离线、确定性、零 LLM）+ `agint-quality-eval` 的
 *   `computePassRate` / `baselineDelta`，即 1b 方案里的 R1。
 * - 技能/preset 类目标 ⇒ 声明"质量评分"。这个词**刻意不进** `METRIC_KEYWORDS`，
 *   所以解析结果是 `METRIC_UNSTATED` ⇒ 外壳不落锁 ⇒ 链上 `predictedDelta` 留 null。
 *   等 R2（技能评估集）建好并登记指标后，这条才变成可测承诺。
 *
 * ⚠️ 这不是"给技能类少写点东西"的敷衍：mutator 的 FROZEN 契约**必须**收到一个
 * 可证伪串（`agint-mutator/lib/index.js:369` 的 `VALIDATE_EXPECTED_RE`，
 * 形状 `<指标> >= <数> 在 <N> 天`），不给就 validate 失败。所以这里给的是
 * **这次改动真实想改善的量**，而不是一个恰好能过正则、又恰好会被解析成有仪器的指标。
 *
 * ⛔ 本模块不复制 mutator 的正则做二次校验：契约校验的唯一主人是 mutator.validate
 * （driver 主循环本来就走 `mutator.validate({ proposal })`）。这里再抄一份就是第二个真相源。
 */

/** 代码类目标：仪器 = 离线场景集（1b 方案 R1）。 */
export const EXPECTED_EFFECT_CODE = '场景集通过率 >= 95% 在 7 天';

/**
 * 技能/preset 类目标：声明真实想改善的量，但它今天没有仪器。
 * 措辞避开 `METRIC_KEYWORDS` 里的每一个词 —— 由
 * `test/expected-effect.test.mjs` 钉住"这条不得被解析成指标"。
 */
export const EXPECTED_EFFECT_SKILL = '技能输出质量评分 >= 90% 在 7 天';

/**
 * 按目标类型取期望串。
 *
 * @param {object} input
 * @param {'skill'|'repo'} input.targetType  driver 的目标类型（`resolveTargetAsset` 的产物）
 * @returns {string} 满足 mutator FROZEN 形状的可证伪串
 */
export function expectedEffectForTarget({ targetType } = {}) {
  return targetType === 'skill' ? EXPECTED_EFFECT_SKILL : EXPECTED_EFFECT_CODE;
}

export default { expectedEffectForTarget, EXPECTED_EFFECT_CODE, EXPECTED_EFFECT_SKILL };
