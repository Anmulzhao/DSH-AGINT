/**
 * agint-evolution-driver —— prediction-locker.js
 *
 * Phase 1.1 支点 1a：把「预测锁定」接进进化主循环，并给它一层**软失败外壳**。
 *
 * ## 它补的是哪个洞
 *
 * `contract-manager.js`（Sprint 21）实现了锁定，但 driver 主循环**零引用** ——
 * 于是 `contract_locks` 生产 0 行，Ledger 的 `predictedDelta` 永远 null，
 * 「预测 vs 实际」这条校准回路根本没有源头数据。本文件是唯一接线点。
 *
 * ## 为什么外面要套一层软失败（而不是直接调 lockPrediction）
 *
 * `contract-manager.js` 的红线 #3 写得很清楚：锁定失败**必须抛**，caller 中止进化。
 * 那是信任根的正确设计 —— 但主循环当前没有「中止进化」这条通道：
 * 抛上去会被 commit 的 `catch` 吞掉，变成「commit threw」并触发一次回滚，
 * 等于让「预测没锁上」这个观测缺陷去毁掉一次真实的仓库改动。
 * 所以本外壳把抛错收回来，按 `ledger-writer.js` 的同一套纪律做成**可见的跳过**：
 *
 *   warn + 计数器 + `cycle.summary` 带出 status ⇒ 主流程照走，predictedDelta 留 null。
 *
 * ⛔ 「留 null」是诚实，不是降级成功：跳过一定会在 summary 里留下
 * `prediction.status`，事后能区分「没锁上」与「锁了且预测为 0」。
 *
 * ## 顺序铁律（§2.4.2）
 *
 * 锁定必须**早于执行与评估**。调用点因此放在 `commitToRepo` 之前，
 * 而不是放在写 Ledger 的时候（那里已经看完 policy 结果，锁进去就是事后编造）。
 * 这条时序由 `test/smoke.mjs` 的断言锁死（recordContractLock 必须排在
 * verifyTargetFile / policy.decide 之前）。
 *
 * ## 无预测可用 ⇒ 不落锁
 *
 * `generatePrediction` 三级降级链的最后一级是静态规则表，按
 * `mutationType × targetMetric` 取条目。生产现状（2026-10-03 实测）：
 * `proposal.expectedEffect` 是 mutator 要求的**字符串**，而 population 只认
 * **对象**（`agint-population/lib/index.js:173`），于是恒落兜底
 * `{ metric: 'unspecified' }` ⇒ 规则表查不到 ⇒ 无预测 ⇒ 本函数返回
 * `NO_PREDICTION_AVAILABLE`，不往 `contract_locks` 写空锁。
 * 理由：锁里存的是 hash，一条「预测为空」的锁占一行却证明不了任何预测，
 * 反而让表看起来「有覆盖」。缺就是缺。
 *
 * ## hypothesisLock 的可复原性（防篡改能不能真跑起来）
 *
 * 归档校验（1b）要拿**锁定时同一份 hypothesis** 重算 hash，而
 * `contract_locks` 表只存 hash、不存内容（`schema.js:160` 的单一真相源纪律）。
 * 因此本文件把 hypothesis 限定成**三个字段**，且全部可从同一条 Ledger 条目复原：
 *
 *   mutationType      ← summary.mutationType
 *   targetMetric      ← summary.targetMetric
 *   changedComponents ← summary.changedPlugins.map(p => ({ pluginName: p }))
 *   predictedDelta    ← summary.predictedDelta   （lockPrediction 注入后参与摘要）
 *   predictionSource  ← summary.predictionSource （同上）
 *   contractId        ← 条目 contractId
 *   createdAt        ← contract_locks.lockedAt
 *
 * ⇒ 加字段前先问「复原得回来吗」；复现不了就等于一把永远无法校验的锁。
 */

import { generatePrediction } from './predictor.js';
import { createContractManager } from './contract-manager.js';

/** 锁定结果状态。`ok:true` 只可能是 LOCKED；其余都是「本次没有预测」。 */
export const PREDICTION_LOCK_STATUS = Object.freeze({
  LOCKED: 'LOCKED',
  NO_CONTRACT_ID: 'NO_CONTRACT_ID',
  NO_PREDICTION: 'NO_PREDICTION_AVAILABLE',
  UNAVAILABLE: 'LOCK_UNAVAILABLE',
  ALREADY_LOCKED: 'ALREADY_LOCKED',
  FAILED: 'LOCK_FAILED',
});

/** Ledger summary 接受的预测来源（与 `schema.js` 的 enum 同一份清单）。 */
const LOCKABLE_SOURCES = new Set(['KNOWLEDGE_BASE', 'ANALOGY', 'DEFAULT_RULE']);

/**
 * 锁定用的 hypothesis（参与 hash 的内容）。
 *
 * ⛔ 只放这三个字段 —— 见文件头「可复原性」。多放一个复原不回来的字段，
 *    1b 的归档校验就必然判红（假篡改），而判红的处置是冻结，代价更大。
 *
 * @param {object} input
 * @param {string} input.mutationType
 * @param {string} input.targetMetric
 * @param {Array<{pluginName?: string}>} [input.changedComponents]
 * @returns {object}
 */
export function buildLockHypothesis({ mutationType, targetMetric, changedComponents = [] }) {
  return {
    mutationType: typeof mutationType === 'string' ? mutationType : null,
    targetMetric: typeof targetMetric === 'string' ? targetMetric : null,
    changedComponents: (Array.isArray(changedComponents) ? changedComponents : [])
      .map((c) => (typeof c === 'string' ? { pluginName: c } : { pluginName: c?.pluginName ?? null }))
      .filter((c) => c.pluginName),
  };
}

/**
 * 建一个软失败外壳。
 *
 * @param {object} ctx cordis 上下文（依赖**调用时**取，与 index.js 同一红线）
 * @param {object} [deps]
 * @param {(msg: string, extra?: object) => void} [deps.warn]
 * @param {() => string} [deps.now] ISO 时间源（注入以便测试复现同一个 createdAt）
 */
export function createPredictionLocker(ctx, { warn = () => {}, now = () => new Date().toISOString() } = {}) {
  const dep = (n) => (ctx && typeof ctx.get === 'function' ? ctx.get(n) : null);
  const manager = createContractManager(ctx);

  /**
   * 锁定主体。内部已收回 `lockPrediction` 的抛错；
   * 纯函数那一段（generatePrediction / buildLockHypothesis）由外层 `lock` 兜住。
   *
   * @returns {Promise<object>} 见 `lock`
   */
  async function doLock({ contractId, mutationType, targetMetric, changedComponents = [] } = {}) {
    if (typeof contractId !== 'string' || contractId === '') {
      // 与 ledger-writer 同判据：没有幂等键就无处可锁。
      return { ok: false, status: PREDICTION_LOCK_STATUS.NO_CONTRACT_ID, reason: 'contractId 缺失' };
    }

    const evolution = dep('agint.evolution');
    if (!evolution || typeof evolution.recordContractLock !== 'function') {
      const reason = 'agint.evolution.recordContractLock 不可用（memory 未部署或未 provide）';
      warn('prediction-lock: 跳过锁定（通道不可用），predictedDelta 留 null', { contractId, reason });
      return { ok: false, status: PREDICTION_LOCK_STATUS.UNAVAILABLE, contractId, reason };
    }

    // ① 先问「有没有预测可锁」。generatePrediction 是纯函数（不读时钟/存储），
    //    与 lockPrediction 内部那一次调用输入相同 ⇒ 结果必然相同；
    //    这里多算一次换来的是「无预测时根本不写锁行」。
    const probe = generatePrediction({ mutationType, targetMetric, changedComponents });
    if (!Number.isFinite(probe?.predictedDelta) || !LOCKABLE_SOURCES.has(probe?.predictionSource)) {
      return {
        ok: false,
        status: PREDICTION_LOCK_STATUS.NO_PREDICTION,
        contractId,
        reason: probe?.reason ?? 'NO_PREDICTION_AVAILABLE',
        detail: {
          mutationType: mutationType ?? null,
          targetMetric: targetMetric ?? null,
          attempts: (probe?.attempts ?? []).map((a) => `${a.source}:${a.reason ?? 'ok'}`),
        },
      };
    }

    const createdAt = now();
    try {
      const { lock: row } = await manager.lockPrediction({
        contractId,
        createdAt,
        mutationType,
        targetMetric,
        hypothesis: buildLockHypothesis({ mutationType, targetMetric, changedComponents }),
      });
      return {
        ok: true,
        status: PREDICTION_LOCK_STATUS.LOCKED,
        // `locked:true` 是**入库成功的凭证**，不是状态别名：Ledger 写入侧
        // （ledger-writer.js 的 lockedPredictionOf）只认带这个标记的预测入链。
        // 其余所有返回分支都没有它 ⇒ 无锁的预测永远不会变成链上证据。
        locked: true,
        contractId,
        createdAt,
        hypothesisLock: row?.hypothesisLock ?? null,
        lockEventId: row?.lockEventId ?? null,
        predictedDelta: probe.predictedDelta,
        predictionSource: probe.predictionSource,
        confidence: probe.confidence,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('contract-lock-already-exists')) {
        // 重放形状（cron 重跑 / 进程重启补跑同一条 proposal）：不是事故，
        // 但本次不重复入链 —— Ledger 侧同 contractId 也会走幂等返回。
        warn('prediction-lock: 该 contractId 已锁过，本次不重复锁定', { contractId });
        return {
          ok: false,
          status: PREDICTION_LOCK_STATUS.ALREADY_LOCKED,
          contractId,
          reason: 'contract-lock-already-exists',
        };
      }
      warn('prediction-lock: 锁定失败（已收回抛错，未阻断进化）', { contractId, error: msg });
      return { ok: false, status: PREDICTION_LOCK_STATUS.FAILED, contractId, reason: msg };
    }
  }

  /**
   * 锁定这次进化的预测。**永不抛** —— 这是它相对 `contract-manager.lockPrediction`
   * 唯一新增的保证，也是主循环敢把它放在 commit 之前的前提。
   *
   * @param {object} input
   * @param {string} input.contractId          实时路径用 proposal.id 顶替 Contract ID
   * @param {string} input.mutationType
   * @param {string|null} input.targetMetric
   * @param {Array<string|{pluginName?: string}>} [input.changedComponents]
   * @returns {Promise<{
   *   ok: boolean, locked?: true, status: string, reason?: string,
   *   contractId?: string, createdAt?: string, hypothesisLock?: string|null,
   *   lockEventId?: string|null, predictedDelta?: number|null,
   *   predictionSource?: string|null, confidence?: number|null,
   * }>}
   */
  async function lock(input = {}) {
    try {
      return await doLock(input);
    } catch (error) {
      // 兜底：纯函数段（预测生成 / hypothesis 组装）意外抛错时同样收回来，
      // 绝不让「预测没锁上」毁掉一次真实的仓库改动（文件头「为什么套外壳」）。
      const msg = error instanceof Error ? error.message : String(error);
      warn('prediction-lock: 锁定流程意外抛错（外壳已收回，未阻断进化）', {
        contractId: input?.contractId ?? null, error: msg,
      });
      return {
        ok: false, status: PREDICTION_LOCK_STATUS.FAILED,
        contractId: input?.contractId ?? null, reason: msg,
      };
    }
  }

  return { lock };
}

export default { createPredictionLocker, buildLockHypothesis, PREDICTION_LOCK_STATUS };
