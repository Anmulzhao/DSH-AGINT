/**
 * lib/evaluator.js — Sprint 15 T3 评估层编排（设计稿 §5.2/§5.3，A 路径分流）
 *
 * A 路径（新候选）：Phase 1 静态准入 → Phase 2 沙箱门 → Phase 3 硬门 + 排序。
 * 复用 D-QAF 执行层（quality-static / quality-sandbox / quality-eval），但
 * **不复用综合分决策**（§3 语义错配：新候选 composite 恒 71.4 < pendingReview 75
 * → 若按综合分决策必然全 REJECT，与质量无关）。
 *
 *   Phase 1  qualityStatic.checkPlugin(pluginDir=staging, profile=skill-candidate,
 *            familyEnabled=SKILL_FAMILY_ENABLED)  → 任一 blocker ⇒ REJECTED_STATIC
 *   Phase 2  staging 有 scripts/ 可执行物 ⇒ qualitySandbox.runSmoke({target:{path}})
 *            通过 ⇒ E1；无可执行物 ⇒ skipped（**不标 pass**，E0，Q2 拍板放行）
 *            实跑失败 ⇒ REJECTED_SANDBOX
 *   Phase 3  硬门 = Phase1 无 blocker ∧ Phase2 未失败；通过 ⇒ PHASE3_PASS
 *            (provisional, compositeTrusted:false)；evaluate 异常 ⇒ REJECTED_EVAL
 *
 * 终态写入 evolution（T7）：targetKind 'skill' + decision 'PENDING_REVIEW'
 * （evolutionLogEntrySchema 枚举限制） + tags ['phase3-provisional', 'candidate:<id>']
 * ——P0-2 跨域读取该 tag 识别"待观察"技能。
 */

import { createStaging, stagingRootFor, assertSafeCandidateId } from './staging.js';
import { SKILL_FAMILY_ENABLED } from '../../agint-quality-static/lib/static-profile.js';

// ── rankingScore（设计稿 §7.2 例 0.62）：预估收益 0.5 + 模式频次 0.3 + 安全 0.2 ──
export function computeRankingScore(candidate, pattern = {}) {
  const b = candidate?.estimatedBenefit ?? {};
  const benefitAvg = ((b.successRateImprovement ?? 0) + (b.timeSavingsPct ?? 0) + (b.tokenSavingsPct ?? 0)) / 3;
  const freq = Math.min(1, (pattern.occurrenceCount ?? 0) / 10);
  const safety = 1 - (b.harmIncrementEstimate ?? 0);
  return Math.round((0.5 * benefitAvg + 0.3 * freq + 0.2 * safety) * 1000) / 1000;
}

/**
 * A 路径三阶段评估。
 * @param {object} args
 * @param {object} args.candidate      已入库候选（含 id / skillDraft / estimatedBenefit / sourcePatternId）
 * @param {object} args.pattern        关联 task_pattern（occurrenceCount 供 rankingScore）
 * @param {object} args.services       { qualityStatic, qualitySandbox, qualityEvaluator, evolution }
 * @param {object} args.cfg            effectiveConfig（dangerous_tools_blocklist）
 * @param {string} args.dshHome        $DSH_HOME
 * @returns {Promise<{ finalStatus, evalResults, rankingScore, evidenceLevel, provisional, staged }>}
 */
export async function evaluateCandidate(args) {
  const { candidate, pattern = {}, services, cfg = {}, dshHome } = args;
  assertSafeCandidateId(candidate.id);

  // T1：物化（幂等）
  const staged = await createStaging(candidate, { dshHome });
  const hasScripts = (candidate.skillDraft?.scripts ?? []).length > 0;

  const evalResults = {
    phase1: null,
    phase2: null,
    phase3: null,
  };

  // ── Phase 1：静态准入（blocker 即拒）────────────────────────────────────
  const staticResult = await services.qualityStatic.checkPlugin({
    pluginDir: staged.dir,
    profile: 'skill-candidate',
    profileOverrides: {
      familyEnabled: SKILL_FAMILY_ENABLED,
      dangerousBlocklist: cfg.dangerous_tools_blocklist,
    },
  });
  const staticFindings = Array.isArray(staticResult) ? staticResult : (staticResult?.findings ?? []);
  const blockers = staticFindings.filter((f) => f.severity === 'blocker');
  evalResults.phase1 = {
    status: blockers.length ? 'reject' : 'pass',
    families: [...new Set(staticFindings.map((f) => f.family))],
    findings: staticFindings,
  };
  if (blockers.length) {
    return {
      finalStatus: 'REJECTED_STATIC',
      evalResults,
      rankingScore: null,
      evidenceLevel: null,
      provisional: false,
      staged,
      blockers,
    };
  }

  // ── Phase 2：沙箱门（无可执行物 → skipped，不标 pass）──────────────────
  let sandboxResult = null;
  if (hasScripts) {
    sandboxResult = await services.qualitySandbox.runSmoke({
      target: { path: staged.dir },
      opts: { timeoutMs: cfg.sandbox_timeout_ms },
    });
    const ok = sandboxResult && sandboxResult.exitCode === 0;
    evalResults.phase2 = {
      status: ok ? 'pass' : 'reject',
      exitCode: sandboxResult?.exitCode ?? null,
      detail: ok ? null : (sandboxResult?.stderr ?? '').slice(0, 400),
    };
    if (!ok) {
      return {
        finalStatus: 'REJECTED_SANDBOX',
        evalResults,
        rankingScore: null,
        evidenceLevel: null,
        provisional: false,
        staged,
        sandboxResult,
      };
    }
  } else {
    evalResults.phase2 = { status: 'skipped', reason: 'no executable (scripts absent)' };
  }

  // ── Phase 3：硬门 + 排序（综合分只记录、不决策）────────────────────────
  const tags = ['skill-candidate', `candidate:${candidate.id}`, `pattern:${candidate.sourcePatternId ?? ''}`].filter(Boolean);
  let evalOut;
  try {
    evalOut = await services.qualityEvaluator.evaluate({
      id: candidate.id,
      kind: 'skill',
      version: '0.0.0',
      path: staged.dir,
      tags,
    });
  } catch (e) {
    evalResults.phase3 = {
      status: 'reject',
      reason: `evaluator error: ${e?.message ?? e}`,
      compositeTrusted: false,
      provisional: true,
    };
    return {
      finalStatus: 'REJECTED_EVAL',
      evalResults,
      rankingScore: null,
      evidenceLevel: null,
      provisional: true,
      staged,
      error: e,
    };
  }

  const composite = Number(evalOut?.scores?.composite ?? evalOut?.composite ?? 0);
  const hardGatePassed = true; // 走到此处 = Phase1 无 blocker ∧ Phase2 未失败
  const rankingScore = computeRankingScore(candidate, pattern);
  const evidenceLevel = evalResults.phase2.status === 'pass' ? 'E1' : 'E0';

  evalResults.phase3 = {
    status: 'pass',
    composite,
    compositeTrusted: false,          // 新候选综合分恒 71.4，与质量无关（设计稿 §3）
    hardGatePassed,
    rankingScore,
    provisional: true,
    evidenceLevel,
    decision: 'PENDING_REVIEW',       // Sprint 16 观察期后转正/驳回
  };

  // T7：往 evolution-log 追加 phase3-provisional 记录（P0-2 跨域读取）
  try {
    await services.evolution.logPhase4({
      targetId: candidate.id,
      targetKind: 'skill',
      decision: 'PENDING_REVIEW',
      scores: { composite, rankingScore },
      findings: staticFindings.map((f) => ({
        ruleId: f.code ?? `${f.family}:${f.message?.slice(0, 40) ?? ''}`,
        severity: f.severity === 'blocker' ? 'high' : f.severity === 'warn' ? 'low' : 'medium',
        detail: f.message,
      })),
      tags: ['phase3-provisional', `candidate:${candidate.id}`],
    });
  } catch (e) {
    // evolution 写入失败不阻断评估（降级：audit 由调用方记录）
    evalResults.phase3.evolutionWrite = { ok: false, reason: e?.message ?? String(e) };
  }

  return {
    finalStatus: 'PHASE3_PASS',
    evalResults,
    rankingScore,
    evidenceLevel,
    provisional: true,
    staged,
    evalOut,
  };
}

export { stagingRootFor };
