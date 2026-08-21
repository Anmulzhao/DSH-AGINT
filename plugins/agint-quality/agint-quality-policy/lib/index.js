/**
 * agint-quality-policy: D-QAF Phase 4 策略引擎（v0.4 完整版）
 *
 * 实现 QualityPolicyIface（contract 定义的 seam）：
 *   decide({ results, config, options }): Promise<Decision>
 *
 * ## Sprint 4 范围
 *   - 完整 4 决策 (AUTO_DEPLOY / PENDING_REVIEW / REJECT / ABSTAIN) — 与 contract.DecisionKind 对齐
 *   - 加权综合分：trust / reliability / effectiveness / safety / integrability
 *   - thresholds 读取（autoDeploy / pendingReview）+ setThresholds 走 contract.setConfig 审计
 *   - 反和谐检测器挂钩（options.detectors）
 *   - audit: 决策历史写到 memory (type=decision) + evo.logPhase4
 *
 * ## Row
 *   - insert:
 *       - id: agint-quality-policy
 *         name: ./plugins/agint-quality/agint-quality-policy/lib/index.js
 *         config: {}
 */

import { z } from 'zod';
import {
  decidePolicy,
  shouldReportToEvolution,
  buildRejectFailurePattern,
  validateThresholds,
  DEFAULT_POLICY_ID,
} from './decide.js';
import { runHarmonyDetectors, DEFAULT_HARMONY_CONFIG } from './falseHarmonyDetector.js';

const name = 'agint-quality-policy';
const inject = ['agint.evolution'];

const Config = z.object({
  /** policy 标识（用于 Decision.policyId） */
  policyId: z.string().default(DEFAULT_POLICY_ID),
  /** 是否把决策历史写入 evolution-log（默认 true） */
  writeEvolutionLog: z.boolean().default(true),
  /** 是否在 REJECT/ABSTAIN 时自动 addFailure（默认 true） */
  autoReportRejection: z.boolean().default(true),
  /** 是否写 memory 审计（默认 true） */
  writeMemoryAudit: z.boolean().default(true),
}).optional();

function apply(ctx, config) {
  const cfg = Config.parse(config || {});
  let disposed = false;

  ctx.effect(() => () => {
    disposed = true;
  });

  /**
   * Sprint 4.2: 暴露反和谐检测器 Service（供 sibling / dream / weekly hook 调用）
   */
  async function detectFalseHarmony({ results = [], config: overrideConfig = {}, history = { byTarget: {}, regressionHistory: [] } } = {}) {
    if (disposed) throw new Error('agint-quality-policy: disposed');
    const mergedConfig = { ...cfg, ...overrideConfig };
    return await runHarmonyDetectors({ results, config: mergedConfig, history });
  }

  /**
   * Make a decision based on eval results.
   * @returns {Promise<Decision>} — shape 严格对齐 contract.DecisionSchema
   */
  async function decide({ results, config: overrideConfig, options } = {}) {
    if (disposed) throw new Error('agint-quality-policy: disposed');
    const mergedConfig = { ...cfg, ...overrideConfig };
    const decision = await decidePolicy({ results, config: mergedConfig, options });

    const evo = ctx.get('agint.evolution');
    const memory = ctx.get('agint.memory');

    // Phase 4 自动化: 每个决策写 evolution-log (PENDING_REVIEW 也写, 决策审计)
    if (cfg.writeEvolutionLog && evo && typeof evo.logPhase4 === 'function') {
      const rejected = decision.perTarget?.filter((t) => t.kind === 'REJECT') ?? [];
      try {
        await evo.logPhase4({
          targetId: `policy-batch-${decision.decidedAt}`,
          targetKind: 'composite',
          decision: decision.kind,
          scores: {
            policyKind: decision.kind,
            policyScore: decision.score,
            perTargetCount: decision.perTarget?.length ?? 0,
            rejectedCount: rejected.length,
          },
          findings: rejected.map((t) => ({
            ruleId: 'policy-reject',
            severity: 'high',
            detail: `${t.targetId}: ${t.reason}`,
          })),
          tags: ['policy-decision', `decision:${decision.kind}`],
        });
      } catch (err) {
        if (!disposed) console.error('[agint-quality-policy] evo.logPhase4 failed:', err.message);
      }
    }

    // REJECT/ABSTAIN 自动 addFailure
    if (cfg.autoReportRejection && shouldReportToEvolution(decision) && evo && typeof evo.addFailure === 'function') {
      try {
        const pattern = buildRejectFailurePattern(decision);
        await evo.addFailure({
          pattern: pattern.pattern,
          category: pattern.category,
          severity: pattern.severity,
          evidence: pattern.evidence,
        });
      } catch (err) {
        if (!disposed) console.error('[agint-quality-policy] evo.addFailure failed:', err.message);
      }
    }

    // audit: 决策历史写到 memory (Sprint 4 audit hook)
    if (cfg.writeMemoryAudit && memory && typeof memory.write === 'function') {
      try {
        await memory.write({
          type: 'decision',
          content: `[agint.qualityPolicy] ${decision.kind} score=${decision.score} policyId=${decision.policyId} reason=${decision.reason}`,
          evidence: `agint-quality-policy:decide:${decision.decidedAt}`,
        });
      } catch (err) {
        if (!disposed) console.error('[agint-quality-policy] audit memory.write failed:', err.message);
      }
    }

    return decision;
  }

  /**
   * Set thresholds via contract.setConfig (走审计链路)
   * @param {object} patch — { autoDeploy?, pendingReview? }
   * @returns {Promise<object>} updated config from contract
   */
  async function setThresholds(patch) {
    const quality = ctx.get('agint.quality');
    const validation = validateThresholds(patch);
    if (!validation.valid) {
      const err = new Error(
        `agint-quality-policy: setThresholds rejected — invalid: ${validation.issues.join(', ')}`
      );
      err.code = 'INVALID_THRESHOLDS';
      throw err;
    }
    if (!quality || typeof quality.setConfig !== 'function') {
      throw new Error('agint.quality contract service not available');
    }
    return quality.setConfig({ thresholds: patch });
  }

  function health() {
    return {
      config: cfg,
      serviceAvailable: true,
      sprintComplete: 'v0.4',
    };
  }

  ctx.provide('agint.qualityPolicy', {
    decide,
    detectFalseHarmony,
    setThresholds,
    health,
    config: cfg,
    harmonyConfig: DEFAULT_HARMONY_CONFIG,
  });
}

export { Config, apply, inject, name };
