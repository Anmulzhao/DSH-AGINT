/**
 * agint-quality-policy/lib/decide.js — 策略引擎纯函数（Sprint 3.3 占位）
 *
 * v0.3.x 只实现最小决策：safety veto → REJECT，其余 PENDING_REVIEW。
 * Sprint 4 接入完整 4 决策 + 加权逻辑（AUTO_DEPLOY / PENDING / REJECT / ABSTAIN）。
 *
 * 接口契约（contract QualityPolicyIface.methods[1]）：
 *   decide(results: EvalResult[], config: QualityConfig): Promise<Decision>
 *
 * 返回 Decision schema：
 *   {
 *     decision: 'AUTO_DEPLOY' | 'PENDING_REVIEW' | 'REJECT' | 'ABSTAIN',
 *     reason: string,
 *     perTarget: [{ targetId, decision, reason }],
 *     ts: ISO,
 *     evaluatorId: string,
 *   }
 */

/**
 * Minimal decision policy (Sprint 3.3 占位).
 * - 任一 EvalResult safety veto → REJECT
 * - 否则 → PENDING_REVIEW
 *
 * Sprint 4 替换为：trust / reliability / effectiveness / integrability 加权
 * 综合分 ≥ pendingReview → AUTO_DEPLOY；< reject → REJECT；其他 PENDING。
 * 数据不足 / 信号冲突 → ABSTAIN。
 */
export async function decidePolicy({ results, config = {} } = {}) {
  const decisionList = ['AUTO_DEPLOY', 'PENDING_REVIEW', 'REJECT', 'ABSTAIN'];
  const evaluatorId = 'agint-quality-policy@0.3.0';

  if (!Array.isArray(results) || results.length === 0) {
    return {
      decision: 'ABSTAIN',
      reason: 'policy-pending-sprint-4:empty-results',
      perTarget: [],
      ts: new Date().toISOString(),
      evaluatorId,
    };
  }

  const perTarget = [];
  let anyReject = false;
  let anyVeto = false;

  for (const r of results) {
    const safety = r.dimensions?.find((d) => d.key === 'safety');
    const veto = Boolean(safety?.veto) || safety?.score?.score === 0;
    const compositeBlocked = r.findings?.some((f) => f.severity === 'blocker');
    if (veto || compositeBlocked) {
      anyVeto = true;
      anyReject = true;
      perTarget.push({
        targetId: r.targetId,
        decision: 'REJECT',
        reason: veto ? 'safety-veto' : `blocker-finding:${compositeBlocked.message ?? 'unknown'}`,
      });
    } else {
      perTarget.push({
        targetId: r.targetId,
        decision: 'PENDING_REVIEW',
        reason: 'policy-pending-sprint-4:no-auto-deploy-yet',
      });
    }
  }

  return {
    decision: anyReject ? 'REJECT' : 'PENDING_REVIEW',
    reason: anyVeto
      ? 'policy-pending-sprint-4:safety-veto-detected'
      : 'policy-pending-sprint-4:default-pending',
    perTarget,
    ts: new Date().toISOString(),
    evaluatorId,
  };
}

/**
 * Whether the policy's decision should trigger evolution.addFailure.
 * Sprint 3.3 决策: REJECT → 触发；其余不触发。
 */
export function shouldReportToEvolution(decision) {
  // decision 是 { decision: 'REJECT', ... } 对象, 取 .decision 字段比较
  return decision?.decision === 'REJECT';
}

/**
 * Build the failure-pattern entry for a REJECT decision.
 */
export function buildRejectFailurePattern(decision) {
  return {
    pattern: `policy-reject:${decision.decision}`,
    category: 'integration',
    severity: 'high',
    evidence: JSON.stringify({
      ts: decision.ts,
      reason: decision.reason,
      rejectedTargets: decision.perTarget?.filter((t) => t.decision === 'REJECT').map((t) => t.targetId) ?? [],
    }),
  };
}
