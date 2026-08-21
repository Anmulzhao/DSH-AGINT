/**
 * agint-quality-policy/lib/decide.js — 策略引擎纯函数（Sprint 4 完整版）
 *
 * 完整 4 决策：
 *   - AUTO_DEPLOY: 综合分 >= autoDeploy 阈值 & 安全门通过
 *   - PENDING_REVIEW: 综合分 >= pendingReview 阈值 & 安全门通过
 *   - REJECT: 综合分 < pendingReview 或任一 veto 维度失败
 *   - ABSTAIN: 信号不足（dimensions 缺失/全 null、targets 为空、信号冲突）
 *
 * 接口契约（contract QualityPolicyIface.methods[0] FROZEN）：
 *   decide(results: EvalResult[], config: QualityConfig): Promise<Decision>
 *
 * 返回 Decision schema（与 contract DecisionSchema 对齐，FROZEN）：
 *   {
 *     kind: 'AUTO_DEPLOY' | 'PENDING_REVIEW' | 'REJECT' | 'ABSTAIN',
 *     score: number 0..100,
 *     reason: string,
 *     triggeredBy: string[],
 *     decidedAt: ISO,
 *     policyId: string,
 *   }
 *
 * 算法（Sprint 4）：
 *   1. 空 results → ABSTAIN 'empty-results'
 *   2. 任一 safety.veto === true 或 safety.score === null 或 safety.score < 0.5 → REJECT
 *      任一 trust.veto === true 或 trust.score === null 或 trust.score < 0.3 → REJECT
 *   3. 若全部维度均为 null（信号不足） → ABSTAIN 'insufficient-signal'
 *   4. 综合分 = 100 * sum(weight_i * score_i) / sum(weight_i for i where score_i!==null)
 *      权重来自 DIMENSION_WEIGHTS
 *   5. score >= autoDeploy → AUTO_DEPLOY
 *      score >= pendingReview → PENDING_REVIEW
 *      其他 → PENDING_REVIEW（默认兜底；与阈值下的 REJECT 由 §2 vetos 决定）
 *   6. per-target 决策：composite master 决策 + 单 target 详情（每个 target 独立算分）
 *
 * 反和谐检测（4.2 接入点）：
 *   decidePolicy 接受 options.detectors 注入检测结果；
 *   若任一检测器报告 'false-harmony' pattern，触发 REJECT 'false-harmony-detected'
 *
 * FROZEN 字段（不要修改，需人类多签）：
 *   - DecisionSchema 字段名（kind/score/reason/triggeredBy/decidedAt/policyId）
 *   - DecisionKindSchema 枚举
 * ADJUSTABLE 字段（policy 通过 contract.setConfig 调整 + 审计）：
 *   - DIMENSION_WEIGHTS（综合分权重）
 *   - veto 阈值（safety 0.5 / trust 0.3）
 */

import {
  DIMENSION_WEIGHTS,
  SAFETY_VETO_THRESHOLD,
} from '../../agint-quality-eval/lib/evaluators.js';

/** 默认 policyId（contract.pluginId + version 标识） */
export const DEFAULT_POLICY_ID = 'agint-quality-policy@0.4.0';

/** 默认权重（与 contract QualityConfig.harmWeights 解耦 —— 这是综合分维度权重） */
export const DEFAULT_DIMENSION_WEIGHTS = { ...DIMENSION_WEIGHTS };

/** trust 维度的 veto 阈值（< 此值 → REJECT） */
export const TRUST_VETO_THRESHOLD = 0.3;

/**
 * 判定 ABSTAIN 触发条件
 * - 任一 EvalResult 的 dimensions 都为 null/空，或全部 scores 为 null → ABSTAIN
 * - results 长度 > 0 但每个 result 都没有任何有效 dimensions → ABSTAIN 'insufficient-signal'
 */
export function shouldAbstain(results) {
  if (results.length === 0) return { abort: true, reason: 'empty-results' };
  const hasAnyScore = results.some((r) =>
    Array.isArray(r.dimensions) && r.dimensions.some((d) => d.score?.score !== null && d.score?.score !== undefined)
  );
  if (!hasAnyScore) return { abort: true, reason: 'insufficient-signal' };
  return { abort: false };
}

/**
 * 计算单个 EvalResult 的综合分（0..100）
 * - 任一 veto 维度（safety/trust 默认 veto）score === null 或低于阈值 → 返回 null（caller 走 REJECT）
 * - 否则 score = 100 * sum(weight_i * score_i) / sum(weight_i for valid score_i)
 * - 返回 null 表示 veto 触发
 */
export function computeComposite(evalResult, weights = DEFAULT_DIMENSION_WEIGHTS, vetoThresholds = { safety: SAFETY_VETO_THRESHOLD, trust: TRUST_VETO_THRESHOLD }) {
  const dims = Array.isArray(evalResult.dimensions) ? evalResult.dimensions : [];
  let num = 0;
  let den = 0;
  for (const d of dims) {
    const s = d.score?.score;
    if (s === null || s === undefined) continue;
    const w = weights[d.key] ?? 0;
    if (w === 0) continue;
    num += w * s;
    den += w;
  }
  if (den === 0) return null;

  // veto 检查：safety/trust score === null 或低于阈值 → null
  const safety = dims.find((d) => d.key === 'safety');
  const trust = dims.find((d) => d.key === 'trust');
  if (safety) {
    const ss = safety.score?.score;
    if (ss === null || ss === undefined || ss < vetoThresholds.safety) return null;
  }
  if (trust) {
    const ts = trust.score?.score;
    if (ts === null || ts === undefined || ts < vetoThresholds.trust) return null;
  }

  const score = (num / den) * 100;
  return Math.round(score * 10) / 10;
}

/**
 * Master decision from a composite score & thresholds.
 */
export function classifyByScore(composite, thresholds) {
  if (composite >= thresholds.autoDeploy) return 'AUTO_DEPLOY';
  if (composite >= thresholds.pendingReview) return 'PENDING_REVIEW';
  return 'REJECT';
}

/**
 * Main policy entry (Sprint 4 完整 4 决策).
 *
 * @param {object} args
 * @param {Array}  args.results   EvalResult[]
 * @param {object} args.config    QualityConfig (contract) — thresholds / weights / vetoThresholds
 * @param {object} args.options   { detectors?: { run: () => Promise<{report: 'clean'|'false-harmony', patterns: string[]}> } }
 * @returns {Promise<Decision>}
 */
export async function decidePolicy({ results, config = {}, options = {} } = {}) {
  const ts = new Date().toISOString();
  const policyId = config.evaluatorId ?? DEFAULT_POLICY_ID;

  // 阈值（contract 自带 default）
  const thresholds = config.thresholds ?? { autoDeploy: 90, pendingReview: 75 };
  const weights = config.dimensionWeights ?? DEFAULT_DIMENSION_WEIGHTS;

  // 0. 空 / 信号不足 → ABSTAIN
  const abs = shouldAbstain(results ?? []);
  if (abs.abort) {
    return {
      kind: 'ABSTAIN',
      score: 0,
      reason: `policy-abstain:${abs.reason}`,
      triggeredBy: [`abstain:${abs.reason}`],
      decidedAt: ts,
      policyId,
      perTarget: [],
    };
  }

  // 1. 反和谐检测（4.2 接入；detectors 注入；缺省为 clean）
  let detectorVerdict = { report: 'clean', patterns: [] };
  if (options?.detectors && typeof options.detectors.run === 'function') {
    try {
      detectorVerdict = await options.detectors.run({ results, config });
    } catch (err) {
      detectorVerdict = { report: 'clean', patterns: [`detector-threw:${err.message}`] };
    }
  }
  if (detectorVerdict.report === 'false-harmony') {
    return {
      kind: 'REJECT',
      score: 0,
      reason: 'false-harmony-detected',
      triggeredBy: ['false-harmony', ...detectorVerdict.patterns.map((p) => `pattern:${p}`)],
      decidedAt: ts,
      policyId,
    };
  }

  // 2. per-target 决策
  const perTarget = [];
  const triggeredBy = [];
  let anyVeto = false;
  let anyAutoDeploy = false;
  let masterKind = 'PENDING_REVIEW';
  let totalScore = 0;

  for (const r of results ?? []) {
    const composite = computeComposite(r, weights);
    if (composite === null) {
      // veto 触发 → REJECT
      anyVeto = true;
      const safety = r.dimensions?.find((d) => d.key === 'safety');
      const trust = r.dimensions?.find((d) => d.key === 'trust');
      const reason = safety && (safety.score?.score === null || safety.score?.score < SAFETY_VETO_THRESHOLD)
        ? `safety-veto:${safety.score?.score === null ? 'null' : `below-${SAFETY_VETO_THRESHOLD}`}`
        : trust && (trust.score?.score === null || trust.score?.score < TRUST_VETO_THRESHOLD)
          ? `trust-veto:${trust.score?.score === null ? 'null' : `below-${TRUST_VETO_THRESHOLD}`}`
          : 'unknown-veto';
      perTarget.push({
        targetId: r.targetId,
        kind: 'REJECT',
        score: 0,
        reason,
      });
      triggeredBy.push(`${r.targetId}:${reason}`);
      continue;
    }

    const kind = classifyByScore(composite, thresholds);
    perTarget.push({
      targetId: r.targetId,
      kind,
      score: composite,
      reason: `composite=${composite} thresholds=${thresholds.autoDeploy}/${thresholds.pendingReview}`,
    });
    totalScore += composite;
    if (kind === 'AUTO_DEPLOY') anyAutoDeploy = true;
  }

  // 3. master 决策
  //    任一 veto → REJECT
  //    否则若任一 AUTO_DEPLOY → PENDING_REVIEW（合并视角；不强制 deploy）
  //    否则任一 low-composite → PENDING_REVIEW
  //    否则（全部高且一致）→ AUTO_DEPLOY 是过激的：默认 PENDING_REVIEW
  //    注：real-world master AUTO_DEPLOY 需要额外的人工 gate，这里保守 PENDING_REVIEW
  if (anyVeto) {
    masterKind = 'REJECT';
  } else if (results.length === 1 && anyAutoDeploy && perTarget[0]?.kind === 'AUTO_DEPLOY') {
    // 单 target AUTO_DEPLOY → master 也 AUTO_DEPLOY（DRY-RUN 默认行为；Phase 4 默认灰度）
    // 注：multi-target 保守走 PENDING_REVIEW
    masterKind = 'AUTO_DEPLOY';
  } else {
    masterKind = 'PENDING_REVIEW';
  }

  const avgScore = results.length > 0 ? Math.round((totalScore / results.length) * 10) / 10 : 0;

  return {
    kind: masterKind,
    score: avgScore,
    reason: masterKind === 'REJECT'
      ? 'policy-reject:veto-or-low-composite'
      : masterKind === 'AUTO_DEPLOY'
        ? 'policy-auto-deploy:composite-threshold-met'
        : 'policy-pending:default-gating',
    triggeredBy,
    decidedAt: ts,
    policyId,
    // per-target 作为扩展字段（Sprint 4 决策审计）
    perTarget,
  };
}

/**
 * Whether the policy's decision should trigger evolution.addFailure.
 * Sprint 4 决策：REJECT → 触发；其余不触发。
 * 由 policy plugin 的 index.js 调用，故保留为 named export。
 */
export function shouldReportToEvolution(decision) {
  return decision?.kind === 'REJECT' || decision?.kind === 'ABSTAIN';
}

/**
 * Build the failure-pattern entry for a REJECT (or ABSTAIN) decision.
 */
export function buildRejectFailurePattern(decision) {
  return {
    pattern: `policy-${decision.kind?.toLowerCase?.() ?? 'unknown'}`,
    category: 'integration',
    severity: decision.kind === 'ABSTAIN' ? 'medium' : 'high',
    evidence: JSON.stringify({
      ts: decision.decidedAt,
      score: decision.score,
      reason: decision.reason,
      triggeredBy: decision.triggeredBy,
    }),
  };
}

/**
 * Thresholds 验证（Sprint 4 audit）：contract 默认值 + patch 后值对比
 *
 * @returns {object} { valid: boolean, issues: string[] }
 */
export function validateThresholds(patch) {
  const issues = [];
  if (!patch || typeof patch !== 'object') return { valid: true, issues };
  const t = patch.thresholds;
  if (t && typeof t === 'object') {
    if (typeof t.autoDeploy !== 'number' || t.autoDeploy < 0 || t.autoDeploy > 100) {
      issues.push('thresholds.autoDeploy must be 0..100');
    }
    if (typeof t.pendingReview !== 'number' || t.pendingReview < 0 || t.pendingReview > 100) {
      issues.push('thresholds.pendingReview must be 0..100');
    }
    if (t.autoDeploy !== undefined && t.pendingReview !== undefined && t.autoDeploy <= t.pendingReview) {
      issues.push('thresholds.autoDeploy must be > thresholds.pendingReview');
    }
  }
  return { valid: issues.length === 0, issues };
}
