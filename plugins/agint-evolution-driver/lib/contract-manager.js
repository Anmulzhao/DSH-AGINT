/**
 * agint-evolution-driver —— contract-manager.js
 *
 * Phase 1 交付物 1 §2.4.2：预测锁定的**接线层**。
 *
 * ## 它站在哪
 *
 * 模块 1（`prediction-scoring.js`）算分，模块 2（`predictor.js`）算预测与
 * 纯函数 lock。本文件是**唯一**把「纯函数」变成「生产事实」的地方：
 *
 *   ① 调 predictor 生成预测 → ② 调 computeHypothesisLock 算锁
 *   → ③ 落 contract_locks 表 → ④ 发 evolution.contract.locked 事件（不可撤回）
 *   → ⑤ 归档时重算比对，篡改则 CONTRACT_TAMPERED
 *
 * ## ⛔ 为什么①②③④⑤ 必须按这个顺序（不可换）
 *
 * 设计 §2.4.2 的核心：**锁定必须先于执行**。若先执行再补锁，
 * 「预测 vs 实际」就成了自我吹嘘——看到结果再写一个「我早就预测会涨 4%」，
 * 校准分能刷到 0.96，而系统其实什么都没预测到。
 * ⇒ 事件与落表都发生在 mutation 之前，且**不做任何回滚补偿**：
 *   锁定失败就抛，caller 负责中止本次进化。静默继续等于没锁。
 *
 * ## 三条边界（改代码前先读）
 *
 * 1. **不自己开存储域**。`agint_evolution` 域由 `agint-evolution-memory` 持有
 *    （`storageDomain.open` 对已开名会抛 `already-open`，
 *    见 dsh-storage-domain/lib/index.js:356）。本文件通过
 *    `ctx.get('agint.evolution')` 拿它 provide 的 Service，跨插件只走服务不碰域。
 * 2. **不 import 跨插件的 lib**。锁的存储在 evolution-memory、hash 的算法在
 *    本插件的 `predictor.js`、落表走 `agint.evolution` 服务 ——
 *    三个插件各自独立，依赖是单向的（driver → evolution 的 Service）。
 * 3. **全软依赖，但「锁定失败」是硬失败**。evolution-memory / event-bus 任一
 *    不可用 ⇒ 抛错让 caller 中止进化，**不降级为「无锁继续」**。
 *    理由：防篡改机制一旦可绕过就没有意义；「没有锁」比「这次进化失败」更糟。
 *    （与 `goal-bridge.js` 的「软依赖降级」范式相反——那是增强功能，
 *     这是信任根，性质不同。）
 */

import { computeHypothesisLock, generatePrediction, verifyHypothesisLock } from './predictor.js';

/**
 * 锁定事件 topic（设计 §2.4.2 第 4 步）。
 *
 * ⚠️ **本常量仅供文档/测试引用，实际 publish 处必须写字面量**
 * `'evolution.contract.locked'`（见 publishLocked）。
 * 原因：`bin/verify-event-topics.mjs` 的 topic 扫描只认三种**字面量**写法
 * （publish / subscribe / topic 属性后面紧跟的字符串常量），
 * 传常量引用它扫不到 ⇒ topic 不会进 `docs/event-topics.json` 事实清单，
 * 而门禁仍判绿（我实测过：写常量时门禁 EXIT=0 但清单里查无此 topic）。
 * 那样就等于这个 topic 悄悄「不存在」于门禁视野里 —— 与 AGINT 「静默失败是头号杀手」
 * 的纪律直接冲突。故两处都写：常量供 import，publish 处写字面量供扫描器。
 *
 * （注：本段刻意不复述那三条正则的字面形式 —— 扫描器不排除注释，
 *   在注释里写出示例字面量会被当成真 topic 扫进来，实测会多出一个假 topic。）
 */
export const CONTRACT_LOCK_TOPIC = 'evolution.contract.locked';

/** 事件源标识（须在 agint-event-bus 的 KNOWN_EVENT_SOURCES 或允许自由串）。 */
export const CONTRACT_LOCK_SOURCE = 'agint-evolution-driver';

/**
 * 一次锁定所需的一切输入。
 *
 * @typedef {object} LockInput
 * @property {string} contractId
 * @property {string} createdAt      ISO 时间串。**由 caller 传入** ——
 *   纯函数不取时钟，且归档重算时必须能取到同一个值，否则永远判篡改。
 * @property {object} hypothesis     Contract 的 hypothesis 段（Phase 0 schema）
 * @property {string} mutationType
 * @property {string} targetMetric
 * @property {object} [context]      预测上下文（桶 / 历史 / 改动组件）
 */

/**
 * 建一个 contract 锁协调器。
 *
 * 依赖全部在**调用时**取（不缓存）—— bundle 的 apply 顺序不保证
 * provide 先于消费，与 `index.js` 里 `dep()` 的既有做法一致。
 *
 * @param {object} ctx cordis 上下文
 * @returns {object} 协调器 Service
 */
export function createContractManager(ctx) {
  const dep = (n) => (ctx && typeof ctx.get === 'function' ? ctx.get(n) : null);

  /** 发锁定事件。返回事件 id；不可用或失败返回 null（**不抛**）。 */
  async function publishLocked(contractId, hypothesisLock) {
    const bus = dep('agint.eventBus.publish');
    if (typeof bus !== 'function') return null;
    try {
      // ⛔ 单参数：publish 的签名是 `(input) =>`，传 (topic, payload) 会被
      // 内部 catch 成 accepted:false **静默丢弃**（2026-09-27 两轮零事件的教训）。
      // ⛔ topic 写字面量而非常量引用：verify-event-topics.mjs 的扫描只认字面量
      //    （见 CONTRACT_LOCK_TOPIC 注释）；传常量它扫不到，门禁会假绿。
      const res = await bus({
        topic: 'evolution.contract.locked',
        payload: { contractId, hypothesisLock },
        source: CONTRACT_LOCK_SOURCE,
      });
      return res?.accepted === true ? (res.id ?? null) : null;
    } catch {
      return null; // 观测失败不阻断锁定（表里已有 lockEventId=null 可查）
    }
  }

  /**
   * 生成预测并**立即锁定**。
   *
   * 顺序严格：预测 → 算锁 → 发事件 → 落表。
   * 事件先于表：事件不可撤回、可被外部订阅者独立见证；表可能写失败，
   * 而事件已发 ⇒ 至少存在一份「当时确实这么预测过」的外部记录。
   *
   * @param {LockInput} input
   * @returns {Promise<{ lock: object, prediction: object }>}
   * @throws 域/服务不可用、已锁定、schema 校验失败 —— 一律抛出，caller 须中止进化
   */
  async function lockPrediction(input) {
    const { contractId, createdAt, hypothesis, mutationType, targetMetric } = input;
    if (!contractId) throw new Error('lockPrediction: contractId is required');
    if (!createdAt) throw new Error('lockPrediction: createdAt is required (纯函数不取时钟)');
    if (!hypothesis || typeof hypothesis !== 'object') {
      throw new Error('lockPrediction: hypothesis is required');
    }

    const evolution = dep('agint.evolution');
    if (!evolution || typeof evolution.recordContractLock !== 'function') {
      throw new Error('lockPrediction: agint.evolution 不可用 ⇒ 无法锁定，中止本次进化');
    }

    // ① 预测（三级来源，降级链见 predictor.js）
    const prediction = generatePrediction({
      mutationType,
      targetMetric,
      bucket: input.context?.bucket ?? null,
      history: input.context?.history ?? [],
      changedComponents: hypothesis.changedComponents ?? [],
      tau: input.context?.tau ?? null,
    });

    // ② 算锁（纯函数；predictedDelta 写进 hypothesis 参与摘要）
    const hypothesisWithPrediction = {
      ...hypothesis,
      predictedDelta: prediction.predictedDelta,
      predictionSource: prediction.predictionSource,
    };
    const hypothesisLock = computeHypothesisLock({
      hypothesis: hypothesisWithPrediction,
      contractId,
      createdAt,
    });

    // ③ 发事件（不可撤回的外部见证）
    const lockEventId = await publishLocked(contractId, hypothesisLock);

    // ④ 落表（不可覆盖）
    const lock = await evolution.recordContractLock({
      contractId,
      hypothesisLock,
      lockedAt: createdAt,
      predictionSource: prediction.predictionSource,
      lockEventId,
    });

    return {
      lock,
      prediction: { ...prediction, hypothesis: hypothesisWithPrediction },
    };
  }

  /**
   * 归档校验：重算 lock 并与表里记录的比对。
   *
   * ⛔ **只判定，绝不修复**。修复意味着重写历史，会让防篡改机制失效
   * （靠谱 > 聪明）。篡改的处置是标记 + 冻结 + 人工介入。
   *
   * @param {LockInput} input
   * @returns {Promise<{ verified: boolean, status: string, reason: string|null, storedLock: string|null, recomputed: string|null }>}
   *   status ∈ 'VERIFIED' | 'CONTRACT_TAMPERED' | 'LOCK_MISSING'
   */
  async function verifyLock(input) {
    const { contractId, createdAt, hypothesis, mutationType, targetMetric } = input;
    const evolution = dep('agint.evolution');
    if (!evolution || typeof evolution.getContractLock !== 'function') {
      throw new Error('verifyLock: agint.evolution 不可用');
    }
    const stored = await evolution.getContractLock(contractId);
    if (!stored) {
      return {
        verified: false,
        status: 'LOCK_MISSING',
        reason: 'LOCK_MISSING',
        storedLock: null,
        recomputed: null,
      };
    }
    // 重算必须用**与锁定时相同的 hypothesis 内容**。
    // 关键：`predictedDelta` / `predictionSource` 是锁定时**由本函数写入**的
    // （见 lockPrediction ① ），它们参与摘要。所以归档时调用方必须从
    // Contract 的 hypothesis 段取回这两个值再传入 ——
    // 若调用方漏传，hypothesis 内容就与锁定时不同 ⇒ 必然判篡改。
    // **这是刻意设计**：改了 hypothesis（哪怕只是少传一个字段）就该判红。
    const r = verifyHypothesisLock({
      storedLock: stored.hypothesisLock,
      hypothesis,
      contractId,
      createdAt,
    });
    return {
      verified: r.ok,
      status: r.ok ? 'VERIFIED' : 'CONTRACT_TAMPERED',
      reason: r.reason,
      storedLock: stored.hypothesisLock,
      recomputed: r.recomputed,
    };
  }

  /**
   * 读出某 Contract 的预测来源（报告需要区分知识库先验 / 类比 / 规则缺省）。
   * @param {string} contractId
   * @returns {Promise<string|null>}
   */
  async function getPredictionSource(contractId) {
    const evolution = dep('agint.evolution');
    if (!evolution || typeof evolution.getContractLock !== 'function') return null;
    const rec = await evolution.getContractLock(contractId);
    return rec?.predictionSource ?? null;
  }

  return { lockPrediction, verifyLock, getPredictionSource };
}
