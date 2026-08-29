/**
 * agint-quality-policy/lib/policyEvents.js — Sprint 12 / A5 (T1 影子期)
 *
 * 把 decide() 末尾的 policy.deployed / policy.rolledback publish 抽出成独立模块：
 *   - 减少 index.js 体积（红线：单文件 ≤ 200 行）
 *   - 单元可测（不用启真 plugin apply() 也能验 publish 行为）
 *   - 后续 v2 schema 演进仅动本文件
 *
 * 单 service 接口（不伞键！伞键在 A3 已确认 bug —— 上游业务插件调伞键 publish 时
 * envelope.route 字段会被中间层覆盖，违背 envelope immutability；走 'agint.eventBus.publish'
 * 直调是当前唯一可靠路径）。
 *
 * 软降级：event-bus 不可用 → log 不抛，原直连路径完全保留。
 *
 * Schema：
 *   - v1 不冻结（影子期；字段允许扩展）：见 schemas/policy-deployed.schema.yaml +
 *     schemas/policy-rolledback.schema.yaml
 *   - 破坏性变更走 L0 治理（major version + 7 天影子 + 双签）
 */

import { shouldRollback, recordRollback, pickRollbackTarget } from './committee.js';

/**
 * Build the payload object for policy.deployed (v1 schema).
 * @param {object} t — perTarget entry { targetId, score, reason, ... }
 * @param {object} decision — full decide() result
 * @returns {object} — payload object
 */
function buildDeployedPayload(t, decision) {
  return {
    targetId: t?.targetId,
    decision: 'AUTO_DEPLOY',
    score: typeof t?.score === 'number' ? t.score : decision.score,
    reason: t?.reason ?? decision.reason ?? '',
  };
}

/**
 * Build the payload object for policy.rolledback (v1 schema).
 * @param {object} t — perTarget entry
 * @param {object} decision — full decide() result
 * @param {string|null} rollbackTarget — policyId or null
 * @param {string} rollbackReason — committee.shouldRollback reason
 * @returns {object} — payload object
 */
function buildRolledbackPayload(t, decision, rollbackTarget, rollbackReason) {
  const reason = `rollback:${rollbackReason ?? 'reject-rate-exceeded'} | ${t?.reason ?? decision.reason ?? ''}`.slice(0, 500);
  return {
    targetId: t?.targetId,
    decision: 'REJECT',
    score: typeof t?.score === 'number' ? t.score : decision.score,
    reason,
    rollbackTarget,
  };
}

/**
 * Determine whether current decide() result should trigger rollback.
 * Reads recent decisions from committee storage (history map) + checks
 * committee.shouldRollback threshold (default 50% reject rate, min 5 samples).
 *
 * @param {object} args
 * @param {object} args.decision — decide() result
 * @param {object} args.committeeStorage — makeCommitteeStorage() handle
 * @returns {{shouldRollback: boolean, reason?: string, rollbackTarget?: string|null}}
 */
function evaluateRollback({ decision, committeeStorage }) {
  if (!committeeStorage?.history) return { shouldRollback: false };
  const recent = [...committeeStorage.history.values()]
    .map((h) => ({ kind: h.kind, ts: h.ts }))
    .sort((a, b) => a.ts.localeCompare(b.ts));
  const rb = shouldRollback({ recentDecisions: recent });
  if (!rb?.shouldRollback) return { shouldRollback: false };
  const target = pickRollbackTarget({
    currentPolicyId: decision.policyId,
    storage: committeeStorage,
  });
  return {
    shouldRollback: true,
    reason: rb.reason,
    rollbackTarget: target?.policyId ?? null,
  };
}

/**
 * Main entry: publish policy.deployed / policy.rolledback events for a decide() result.
 *
 * Behavior:
 *   - decision.kind === 'AUTO_DEPLOY' → 1 publish per AUTO_DEPLOY target
 *   - decision.kind === 'REJECT' + rollback triggered → 1 publish per REJECT target
 *   - everything else → no-op (PENDING_REVIEW / ABSTAIN / already-rolled-back)
 *   - event-bus unavailable → silent skip (log if not disposed)
 *   - publish error → log not throw (do not break decide() return)
 *
 * @param {object} args
 * @param {object} args.ctx — Cordis ctx (only ctx.get('agint.eventBus.publish') used)
 * @param {object} args.decision — decide() result
 * @param {object} args.committeeStorage — makeCommitteeStorage() handle (for rollback check + recordRollback)
 * @param {boolean} args.disposed — whether plugin is disposed (suppress logs after dispose)
 * @returns {Promise<{published: number, deployedCount: number, rolledbackCount: number, rollbackTarget: string|null}>}
 */
export async function publishPolicyEvents({ ctx, decision, committeeStorage, disposed = false } = {}) {
  const result = { published: 0, deployedCount: 0, rolledbackCount: 0, rollbackTarget: null };
  if (!decision || (decision.kind !== 'AUTO_DEPLOY' && decision.kind !== 'REJECT')) {
    return result;
  }

  const _publishBus = typeof ctx.get === 'function' ? ctx.get('agint.eventBus.publish') : null;
  if (!_publishBus || typeof _publishBus !== 'function') return result;

  try {
    if (decision.kind === 'AUTO_DEPLOY') {
      // ── policy.deployed ──
      for (const t of decision.perTarget ?? []) {
        if (t?.kind !== 'AUTO_DEPLOY') continue;
        await _publishBus({
          topic: 'policy.deployed',
          version: 1,
          source: 'agint-quality-policy',
          payload: buildDeployedPayload(t, decision),
        });
        result.published += 1;
        result.deployedCount += 1;
      }
    } else if (decision.kind === 'REJECT') {
      // ── policy.rolledback（需先评估 rollback 触发条件）──
      const rbEval = evaluateRollback({ decision, committeeStorage });
      if (!rbEval.shouldRollback) return result;
      result.rollbackTarget = rbEval.rollbackTarget;
      for (const t of decision.perTarget ?? []) {
        if (t?.kind !== 'REJECT') continue;
        await _publishBus({
          topic: 'policy.rolledback',
          version: 1,
          source: 'agint-quality-policy',
          payload: buildRolledbackPayload(t, decision, rbEval.rollbackTarget, rbEval.reason),
        });
        result.published += 1;
        result.rolledbackCount += 1;
      }
      // 同步 recordRollback 到 committee storage（与原 committee API 路径一致）
      try {
        await recordRollback({
          rolledBackFrom: decision.policyId,
          rolledBackTo: rbEval.rollbackTarget ?? 'unknown',
          reason: rbEval.reason ?? 'reject-rate-exceeded',
          storage: committeeStorage,
        });
      } catch { /* recordRollback 失败不阻断 publish */ }
    }
  } catch (err) {
    if (!disposed) console.error('[agint-quality-policy] eventBus.publish failed:', err?.message ?? err);
  }

  return result;
}