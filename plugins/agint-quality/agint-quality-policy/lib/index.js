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
import {
  makeCommitteeStorage,
  runShadowPolicy,
  checkShadowAutoPromotion,
  shouldRollback,
  recordRollback,
  appendHistory,
  queryHistory,
  saveProdSnapshot,
  pickRollbackTarget,
  DEFAULT_COMMITTEE_CONFIG,
} from './committee.js';
import { publishPolicyEvents } from './policyEvents.js';

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

  // Sprint 4.3: 元评估委员会的内存 storage (sibling 可注入以持久化)
  const committeeStorage = makeCommitteeStorage();

  ctx.effect(() => () => {
    disposed = true;
    // Sprint 12 / A2: dispose 时退订 evolution.evaluated（如已挂）
    try {
      if (typeof _evaluationBusUnsubscribe === 'function') _evaluationBusUnsubscribe();
    } catch { /* ignore */ }
  });

  /**
   * Sprint 12 / A2 — T1 影子期：订阅 evolution.evaluated 边事件
   *
   * mode=sync + reason 非空（per Sprint12 设计稿 §A3）— 唯一 sync 门禁边。
   * 语义：门禁决策必须等评分确定后才推进 mount/sandbox 流水线。
   *
   * reason 必须非空（schema + bus.ts 双 belt-and-suspenders）：
   *   - schema.ts SubscriptionSchema.superRefine：mode=sync 时 reason.trim() 长度 > 0
   *   - bus.ts subscribe()：validateSubscription 已通过则 reason 一定非空
   *
   * 5s 超时降级走直连，不抛错（保留原直连路径；事件路径失败不阻断 policy 决策）。
   */
  let _evaluationBusUnsubscribe = null;
  let _lastEvaluationPayload = null;

  async function applyEvaluation(payload) {
    // T1 影子期：仅缓存 payload 以便 inspect / 测试断言，不改变 decide 行为
    _lastEvaluationPayload = payload ?? null;
  }

  const _subscribeBus = typeof ctx.get === 'function' ? ctx.get('agint.eventBus.subscribe') : null;
  if (_subscribeBus && typeof _subscribeBus === 'function') {
    try {
      _evaluationBusUnsubscribe = _subscribeBus(
        {
          subscriber: 'agint-quality-policy',
          topics: ['evolution.evaluated'],
          mode: 'sync',
          reason: 'policy gate edge: 门禁决策必须等评分确定后才推进 mount/sandbox 流水线（A2，唯一 sync 边，per Sprint12 设计稿 §A3）',
          timeoutMs: 5000,
        },
        async (env) => {
          try {
            await applyEvaluation(env?.payload ?? null);
          } catch (err) {
            if (!disposed) console.error('[agint-quality-policy] applyEvaluation failed:', err?.message ?? err);
          }
        },
      );
    } catch (err) {
      // sync 上限超 / schema 校验失败 → 走直连
      if (!disposed) console.error('[agint-quality-policy] eventBus.subscribe failed:', err?.message ?? err);
      _evaluationBusUnsubscribe = null;
    }

    // ── Sprint 12 / A3 — T1 影子期：async 订阅 sandbox.passed / sandbox.failed ──
    // 走 audit 通道（写 memory[type=decision]）；不进 decide 决策路径。
    // 软降级：subscribe 抛错 → log 不抛，原直连路径不受影响。
    try {
      _subscribeBus(
        {
          subscriber: 'agint-quality-policy',
          topics: ['sandbox.passed', 'sandbox.failed'],
          mode: 'async',
          timeoutMs: 5000,
        },
        async (env) => {
          try {
            await recordSandboxObservation(env);
          } catch (err) {
            if (!disposed) console.error('[agint-quality-policy] sandbox audit failed:', err?.message ?? err);
          }
        },
      );
    } catch (err) {
      if (!disposed) console.error('[agint-quality-policy] eventBus.subscribe(sandbox.*) failed:', err?.message ?? err);
    }
  }

  /**
   * Sprint 12 / A3 — T1 影子期：sandbox 事件观测行（不进入 decide 决策路径）
   * 走 audit 通道：memory.write({type: 'decision', content: ..., evidence: ...})
   * 直连路径（decide / detectFalseHarmony）行为不变 — 事件路径是观察层。
   */
  async function recordSandboxObservation(envelope) {
    const topic = envelope?.topic;
    const payload = envelope?.payload ?? {};
    const mem = ctx.get('agint.memory');
    if (!mem || typeof mem.write !== 'function') return; // memory 不可用 → 静默跳过
    const kind = topic === 'sandbox.passed' ? 'PASS' : 'FAIL';
    const targetPath = String(payload?.target?.path ?? '');
    const reason = payload?.reason ?? '';
    const checksCount = Array.isArray(payload?.checks) ? payload.checks.length : 0;
    const failedCount = Array.isArray(payload?.failedChecks) ? payload.failedChecks.length : 0;
    const content = `[agint.qualityPolicy.observe] sandbox.${kind.toLowerCase()} target=${targetPath} mode=${payload?.mode ?? '?'} durationMs=${payload?.durationMs ?? 0} checks=${checksCount} failed=${failedCount}${reason ? ` reason=${reason}` : ''}`;
    await mem.write({
      type: 'decision',
      content,
      evidence: `agint-quality-policy:sandbox-observe:${envelope?.id ?? '?'}`,
    });
  }

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

    // Sprint 4.3: history source-of-truth (in-memory storage for prod is sibling-managed;
    // 我们在自己 ctx 也 append 一份作 backup)
    try {
      await appendHistory({
        decision,
        policyId: decision.policyId,
        storage: committeeStorage,
        source: 'prod',
      });
    } catch {
      // Append 是 best-effort;失败不抛
    }

    // ── Sprint 12 / A5 — T1 影子期：policy.deployed / policy.rolledback 双 topic 事件化
    // 抽出到 lib/policyEvents.js（独立模块便于测试 + 控制本文件 ≤ 200 行）
    try {
      await publishPolicyEvents({ ctx, decision, committeeStorage, disposed });
    } catch (err) {
      if (!disposed) console.error('[agint-quality-policy] publishPolicyEvents failed:', err?.message ?? err);
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
    // ── Sprint 4.3: 元评估委员会（shadow / rollback / history） ──
    committee: {
      runShadowPolicy: (args) => runShadowPolicy({ ...args, storage: committeeStorage }),
      checkShadowAutoPromotion: (args) => checkShadowAutoPromotion({ ...args, storage: committeeStorage }),
      shouldRollback: (args) => shouldRollback(args),
      recordRollback: (args) => recordRollback({ ...args, storage: committeeStorage }),
      appendHistory: (args) => appendHistory({ ...args, storage: committeeStorage }),
      queryHistory: (args) => queryHistory({ storage: committeeStorage, ...args }),
      saveProdSnapshot: (args) => saveProdSnapshot({ ...args, storage: committeeStorage }),
      pickRollbackTarget: () => pickRollbackTarget({ currentPolicyId: cfg.policyId, storage: committeeStorage }),
      committeeConfig: DEFAULT_COMMITTEE_CONFIG,
      storage: committeeStorage,
    },
  });
}

export { Config, apply, inject, name };
