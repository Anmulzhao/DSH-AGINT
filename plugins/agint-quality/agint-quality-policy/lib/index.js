/**
 * agint-quality-policy: D-QAF Phase 4 策略引擎（v0.3.x 占位骨架）
 *
 * 实现 QualityPolicyIface.decide()（contract 定义的 seam）：
 *   decide({ results, config }) → Promise<Decision>
 *
 * ## Sprint 3.3 范围（当前）
 *   - Service 接口完整：decide + config + health + history
 *   - 最小策略：safety veto → REJECT，其余 PENDING_REVIEW
 *   - REJECT 决策触发 evo.addFailure(pattern='policy-reject:...', category=integration)
 *   - 决策历史写入 agint_evolution.evolution_log (Phase 4 自动写入)
 *
 * ## Sprint 4 接入
 *   - 完整 4 决策 (AUTO_DEPLOY / PENDING_REVIEW / REJECT / ABSTAIN)
 *   - 加权综合分：trust / reliability / effectiveness / integrability
 *   - 阈值配置 (QualityConfig.pendingReview / reject)
 *   - 反和谐检测器
 *
 * Row (profile cordis.patch.yml):
 *   - insert:
 *       - id: agint-quality-policy
 *         name: ./plugins/agint-quality/agint-quality-policy/lib/index.js
 *         config: {}
 */

import { z } from 'zod';
import { decidePolicy, shouldReportToEvolution, buildRejectFailurePattern } from './decide.js';

const name = 'agint-quality-policy';
const inject = ['agint.evolution'];

const Config = z.object({
  /** policy 标识（用于 decision.evaluatorId 拼接） */
  evaluatorId: z.string().default('agint-quality-policy@0.3.0'),
  /** 是否把决策历史写入 evolution-log（默认 true） */
  writeEvolutionLog: z.boolean().default(true),
  /** 是否在 REJECT 时自动 addFailure（默认 true） */
  autoReportRejection: z.boolean().default(true),
}).optional();

const DecisionSchema = z.object({
  decision: z.enum(['AUTO_DEPLOY', 'PENDING_REVIEW', 'REJECT', 'ABSTAIN']),
  reason: z.string(),
  perTarget: z.array(z.object({
    targetId: z.string(),
    decision: z.enum(['AUTO_DEPLOY', 'PENDING_REVIEW', 'REJECT', 'ABSTAIN']),
    reason: z.string(),
  })).default([]),
  ts: z.string(),
  evaluatorId: z.string(),
});

function apply(ctx, config) {
  const cfg = Config.parse(config || {});
  let disposed = false;

  ctx.effect(() => () => {
    disposed = true;
  });

  /**
   * Make a decision based on eval results.
   * Returns Decision. Side effects:
   *   - REJECT → evo.addFailure (if autoReportRejection)
   *   - any decision → evo.logPhase4 (if writeEvolutionLog)
   */
  async function decide({ results, config: overrideConfig } = {}) {
    if (disposed) throw new Error('agint-quality-policy: disposed');
    const mergedConfig = { ...cfg, ...overrideConfig };
    const decision = await decidePolicy({ results, config: mergedConfig });
    DecisionSchema.parse(decision);

    const evo = ctx.get('agint.evolution');

    // Phase 4 自动化：每个决策写 evolution-log
    if (cfg.writeEvolutionLog && evo && typeof evo.logPhase4 === 'function') {
      const rejected = decision.perTarget?.filter((t) => t.decision === 'REJECT') ?? [];
      try {
        await evo.logPhase4({
          targetId: `policy-batch-${decision.ts}`,
          targetKind: 'composite',
          decision: decision.decision,
          scores: {
            policyDecision: decision.decision,
            perTargetCount: decision.perTarget.length,
            rejectedCount: rejected.length,
          },
          findings: rejected.map((t) => ({
            ruleId: 'policy-reject',
            severity: 'high',
            detail: `${t.targetId}: ${t.reason}`,
          })),
          tags: ['policy-decision', `decision:${decision.decision}`],
        });
      } catch (err) {
        if (!disposed) console.error('[agint-quality-policy] evo.logPhase4 failed:', err.message);
      }
    }

    // REJECT 自动 addFailure
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

    return decision;
  }

  function health() {
    return {
      config: cfg,
      serviceAvailable: true,
      pendingSprint4: true,
    };
  }

  ctx.provide('agint.qualityPolicy', {
    decide,
    health,
    config: cfg,
  });
}

export { Config, apply, inject, name };
