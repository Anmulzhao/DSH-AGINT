/**
 * agint-evolution-driver —— contract-audit.js
 *
 * 设计 §2.4.2 第 6 步「归档校验」的**调用点**。
 * 校验本体早就写好了（`predictor.js:verifyHypothesisLock`，纯函数，单测覆盖），
 * 但**全仓没有一个调用方** ⇒ 那把锁只防"改预测值"这一种动作，不防"改完 hypothesis
 * 让摘要对不上"，更不防"直接把 `contract_locks` 的行删掉"。本文件把它接上。
 *
 * ## 为什么不是直接调 `contract-manager.verifyLock`
 *
 * `verifyLock(input)` 要 caller 传 `hypothesis` —— 因为设计里校验发生在
 * **Contract 正文还在的归档时刻**，从正文取 hypothesis。但本链路的实时路径
 * **不产 Contract 对象**（Phase 0 的 contracts 表未接入，`references.contractHash`
 * 至今为 null）。所以这里的 hypothesis **从 Ledger 条目复原**：
 * `summary.{mutationType,targetMetric,changedPlugins,predictedDelta,predictionSource}`
 * + `contract_locks.lockedAt`。这条复原路径由 `test/smoke.mjs` T25f 逐字节钉住
 * （"只用条目字段重算的 hash == 表里的 hash"），本模块用的就是同一个配方。
 *
 * ## 三个方向都要查，缺一个就是后门
 *
 * 1. **表里每行都重算**：对不上 ⇒ `CONTRACT_TAMPERED`（改了内容还留着锁）。
 * 2. **条目里每个预测都要有锁行**：链上写了 `predictedDelta` 却没有锁行
 *    ⇒ `LOCK_ROW_MISSING`。这是"删行抹证据"那条路 —— `contract_locks` 既不可覆盖
 *    也不可删除，删一行等于给那段历史开后门（同 §4.3.4 的条目永不删除纪律）。
 * 3. **复原不出来就如实说**：条目字段缺任一摘要成分 ⇒ `UNEVIDENCED_HYPOTHESIS`，
 *    ⛔ 不猜、不当通过（缺失 ≠ 验证过）。
 *
 * ## 只判定，绝不修复
 *
 * 与 `verifyLock` 同一条纪律：修复意味着重写历史。篡改的处置是
 * **标记 + 不计入统计 + 出声**（`prediction_outcomes` 侧由 outcome-measurer 拒写，
 * 报告侧由 cron `outcome-measure` 抛错）。
 *
 * ## 外壳
 *
 * 与 `prediction-locker.js` 同：永不抛。跑在 cron 里，抛一次带走整轮对账。
 */

import { verifyHypothesisLock } from './predictor.js';
import { buildLockHypothesis } from './prediction-locker.js';

export const AUDIT_STATUS = Object.freeze({
  VERIFIED: 'VERIFIED',                       // 重算 == 表里，且字段齐
  CONTRACT_TAMPERED: 'CONTRACT_TAMPERED',      // 重算 != 表里
  LOCK_ROW_MISSING: 'LOCK_ROW_MISSING',        // 链上带 predictedDelta，表里却没锁行（删行）
  UNEVIDENCED_HYPOTHESIS: 'UNEVIDENCED_HYPOTHESIS', // 条目缺摘要成分，复原不出来
  LEDGER_ENTRY_MISSING: 'LEDGER_ENTRY_MISSING',     // 有锁行、链上没条目（锁先于入链就断了）
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  AUDIT_FAILED: 'AUDIT_FAILED',               // 意外异常（外壳吞掉后如实上报）
});

const PREDICTION_SOURCES = new Set(['KNOWLEDGE_BASE', 'ANALOGY', 'DEFAULT_RULE']);

/**
 * 从一条 Ledger 条目复原"锁定时那份 hypothesis"。
 *
 * ⛔ 少任何一个摘要成分就返回 ok:false。少字段直接重算会得到**另一个 hash**，
 * 于是把一条没被改过的锁判成篡改 —— 假警报比不查更坏（它会让整个判据失去可信度）。
 *
 * @param {object} entry Ledger 条目（已带 summary）
 * @returns {{ok: true, hypothesis: object} | {ok: false, reason: string, missing: string[]}}
 */
export function hypothesisFromEntry(entry) {
  const s = entry?.summary;
  const missing = [];
  if (typeof s?.mutationType !== 'string' || s.mutationType === '') missing.push('mutationType');
  if (typeof s?.targetMetric !== 'string' || s.targetMetric === '') missing.push('targetMetric');
  if (!Array.isArray(s?.changedPlugins)) missing.push('changedPlugins');
  if (!Number.isFinite(s?.predictedDelta)) missing.push('predictedDelta');
  if (!PREDICTION_SOURCES.has(s?.predictionSource)) missing.push('predictionSource');
  if (missing.length > 0) return { ok: false, reason: 'UNEVIDENCED_HYPOTHESIS', missing };
  return {
    ok: true,
    hypothesis: {
      ...buildLockHypothesis({
        mutationType: s.mutationType,
        targetMetric: s.targetMetric,
        changedComponents: s.changedPlugins,
      }),
      predictedDelta: s.predictedDelta,
      predictionSource: s.predictionSource,
    },
  };
}

/**
 * 判定一条锁（纯计算，不碰存储）—— 给 sweep 与 outcome-measurer 共用同一个配方。
 *
 * @param {object} input { entry, lockRow }
 * @returns {{status: string, reason: string|null, recomputed: string|null, storedLock: string|null}}
 */
export function auditOne({ entry = null, lockRow = null } = {}) {
  if (!lockRow) return { status: AUDIT_STATUS.LOCK_ROW_MISSING, reason: 'LOCK_ROW_MISSING', recomputed: null, storedLock: null };
  if (!entry) return { status: AUDIT_STATUS.LEDGER_ENTRY_MISSING, reason: 'LEDGER_ENTRY_MISSING', recomputed: null, storedLock: lockRow.hypothesisLock ?? null };
  const built = hypothesisFromEntry(entry);
  if (!built.ok) {
    return { status: AUDIT_STATUS.UNEVIDENCED_HYPOTHESIS, reason: built.reason, missing: built.missing, recomputed: null, storedLock: lockRow.hypothesisLock ?? null };
  }
  const r = verifyHypothesisLock({
    storedLock: lockRow.hypothesisLock,
    hypothesis: built.hypothesis,
    contractId: entry.contractId,
    // createdAt 用**表里的 lockedAt**：lockPrediction 落表时写的就是它，
    // 用条目时间戳会得另一个 hash ⇒ 假篡改。
    createdAt: lockRow.lockedAt,
  });
  return {
    status: r.ok ? AUDIT_STATUS.VERIFIED : AUDIT_STATUS.CONTRACT_TAMPERED,
    reason: r.reason,
    recomputed: r.recomputed,
    storedLock: lockRow.hypothesisLock ?? null,
  };
}

/**
 * @param {object} ctx  cordis 上下文（`ctx.get('agint.evolution')`，调用时取）
 * @param {object} [opts] { warn }
 */
export function createContractAuditor(ctx, { warn = () => {} } = {}) {
  const dep = (n) => (ctx && typeof ctx.get === 'function' ? ctx.get(n) : null);

  /**
   * 全表扫一遍：`contract_locks` 每行重算 + 链上每个预测都要有锁行。
   * 永不抛。
   *
   * @returns {Promise<object>} { ok, status, checked, counts, verdicts, orphanPredictions, unverifiable }
   */
  async function sweep() {
    const evo = dep('agint.evolution');
    if (typeof evo?.listContractLocks !== 'function' || typeof evo?.ledger?.list !== 'function') {
      // 不可用 ≠ 通过。如实报，caller 不许把它读成"没有篡改"。
      return { ok: false, status: AUDIT_STATUS.SERVICE_UNAVAILABLE, checked: 0, counts: {}, verdicts: [], orphanPredictions: [], reason: 'agint.evolution 未提供 listContractLocks / ledger.list' };
    }
    try {
      const [locks, entries] = await Promise.all([evo.listContractLocks(), evo.ledger.list()]);
      const byContract = new Map(entries.filter((e) => e?.contractId).map((e) => [e.contractId, e]));
      const verdicts = [];
      const counts = {};
      for (const lockRow of locks) {
        if (!lockRow?.contractId) continue;
        const v = auditOne({ entry: byContract.get(lockRow.contractId) ?? null, lockRow });
        counts[v.status] = (counts[v.status] ?? 0) + 1;
        verdicts.push({ contractId: lockRow.contractId, ...v });
        byContract.delete(lockRow.contractId);
      }
      // 反向：剩下的条目里，凡是链上写了 predictedDelta 的，都必须有锁行。
      const orphanPredictions = [];
      for (const entry of byContract.values()) {
        if (Number.isFinite(entry?.summary?.predictedDelta)) {
          orphanPredictions.push({ contractId: entry.contractId, seq: entry.seq ?? null, predictedDelta: entry.summary.predictedDelta });
          counts[AUDIT_STATUS.LOCK_ROW_MISSING] = (counts[AUDIT_STATUS.LOCK_ROW_MISSING] ?? 0) + 1;
        }
      }
      const tampered = verdicts.filter((v) => v.status === AUDIT_STATUS.CONTRACT_TAMPERED);
      const unverifiable = verdicts.filter((v) => v.status !== AUDIT_STATUS.VERIFIED && v.status !== AUDIT_STATUS.CONTRACT_TAMPERED);
      return {
        ok: true,
        status: 'AUDITED',
        checked: verdicts.length,
        counts,
        verdicts,
        tampered,
        orphanPredictions,
        unverifiable,
      };
    } catch (error) {
      const msg = error?.message ?? String(error);
      warn('contract-audit: 扫描异常（未降级、未兜底）', { error: msg });
      return { ok: false, status: AUDIT_STATUS.AUDIT_FAILED, checked: 0, counts: {}, verdicts: [], orphanPredictions: [], reason: msg };
    }
  }

  /**
   * 只判一条（测量前用：链上这条的锁还成不成立）。永不抛。
   * @param {string} contractId
   */
  async function verifyContract(contractId) {
    const evo = dep('agint.evolution');
    if (!contractId || typeof evo?.getContractLock !== 'function' || typeof evo?.ledger?.findByContractId !== 'function') {
      return { status: AUDIT_STATUS.SERVICE_UNAVAILABLE, contractId: contractId ?? null };
    }
    try {
      const [lockRow, entry] = await Promise.all([evo.getContractLock(contractId), evo.ledger.findByContractId(contractId)]);
      return { contractId, ...auditOne({ entry, lockRow }) };
    } catch (error) {
      const msg = error?.message ?? String(error);
      warn('contract-audit: 单条校验异常', { contractId, error: msg });
      return { status: AUDIT_STATUS.AUDIT_FAILED, contractId, reason: msg };
    }
  }

  return { sweep, verifyContract };
}

export default { createContractAuditor, auditOne, hypothesisFromEntry, AUDIT_STATUS };
