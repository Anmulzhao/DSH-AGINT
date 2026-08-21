/**
 * agint-quality-policy/lib/falseHarmonyDetector.js — 反和谐检测器（Sprint 4.2）
 *
 * 精确定义 3 类"反和谐"模式。每类是纯函数 (data) => DetectorResult:
 *   {
 *     detected: boolean,
 *     pattern: string,            // 用于 evo.addFailure
 *     evidence: any,              // 用于审计
 *   }
 *
 * ## 模式 1: rejection-uniformity（重复提案 / 决策一致无差异）
 * 同一 target 在最近 K 次评估中,决策枚举完全不变（无 variance）。
 * 暗示：评估器对现实的"判断"完全定型 —— 可能是评估器过拟合 / 过保守。
 * 触发条件: K >= 5 且 unique(decision).length === 1
 *
 * ## 模式 2: false-consensus（伪共识 / 全部放水）
 * 同一批 N 个 target 同时被评,全部为 AUTO_DEPLOY 且 score >= 99。
 * 暗示：评估器可能"放水"（cohort bootstrapping 假阳性）。
 * 触发条件: N >= 3 且 all(decision === 'AUTO_DEPLOY') 且 min(score) >= 99
 *
 * ## 模式 3: regression-underreporting（劣化漏报）
 * 最近 K 次 evaluate history 中出现 regression:high 级别,但 history 当前的
 * 最近一条 regression:high 被压成 regression:warn（或更轻）。
 * 暗示：报告层有"隐瞒退化"行为。
 * 触发条件: K >= 5 且 (regression history 中 max severity = 'high') 且 (latest severity < 'high')
 *
 * Sprint 4.2 范围: 纯函数 + 默认 detectors runner + 单元可用。
 * Sprint 4.5 接入 weekly hook（已在 quality-eval weeklyTask 跑）。
 *
 * ADJUSTABLE 阈值（policy via contract.setConfig 'harmonyDetector' namespace）：
 *   - rejectionUniformityK: 5  默认
 *   - falseConsensusN:      3  默认
 *   - falseConsensusMinScore: 99 默认
 *   - regressionUnderreportK: 5 默认
 */

export const DEFAULT_HARMONY_CONFIG = {
  rejectionUniformityK: 5,
  falseConsensusN: 3,
  falseConsensusMinScore: 99,
  regressionUnderreportK: 5,
};

/**
 * Detector 1: rejection-uniformity
 * @param {object} args
 * @param {Array} args.history — recent decisions for the SAME target, chronological order [{ decision, score, ts }]
 * @param {number} args.k — window size (default 5)
 * @returns {DetectorResult}
 */
export function detectRejectionUniformity({ history = [], k = DEFAULT_HARMONY_CONFIG.rejectionUniformityK } = {}) {
  if (!Array.isArray(history) || history.length < k) {
    return { detected: false, pattern: 'rejection-uniformity', evidence: { k, length: history.length } };
  }
  const window = history.slice(-k);
  const uniq = new Set(window.map((h) => h.decision));
  if (uniq.size === 1) {
    return {
      detected: true,
      pattern: 'rejection-uniformity',
      evidence: {
        k,
        uniqueDecisions: [...uniq],
        window: window.map((h) => ({ decision: h.decision, score: h.score, ts: h.ts })),
      },
    };
  }
  return { detected: false, pattern: 'rejection-uniformity', evidence: { k, uniqueDecisions: [...uniq] } };
}

/**
 * Detector 2: false-consensus
 * @param {object} args
 * @param {Array} args.batch — [{ targetId, decision, score }]
 * @param {number} args.n — minimum batch size (default 3)
 * @param {number} args.minScore — minimum per-target score (default 99)
 */
export function detectFalseConsensus({
  batch = [],
  n = DEFAULT_HARMONY_CONFIG.falseConsensusN,
  minScore = DEFAULT_HARMONY_CONFIG.falseConsensusMinScore,
} = {}) {
  if (!Array.isArray(batch) || batch.length < n) {
    return { detected: false, pattern: 'false-consensus', evidence: { n, length: batch.length } };
  }
  const allAutoDeploy = batch.every((b) => b.decision === 'AUTO_DEPLOY');
  if (!allAutoDeploy) {
    return {
      detected: false,
      pattern: 'false-consensus',
      evidence: { n, allAutoDeploy: false, length: batch.length },
    };
  }
  const minFoundScore = Math.min(...batch.map((b) => b.score ?? 0));
  if (minFoundScore < minScore) {
    return {
      detected: false,
      pattern: 'false-consensus',
      evidence: { n, minScore, minFoundScore, length: batch.length },
    };
  }
  return {
    detected: true,
    pattern: 'false-consensus',
    evidence: {
      n,
      minScore,
      minFoundScore,
      all: batch.map((b) => ({ targetId: b.targetId, decision: b.decision, score: b.score })),
    },
  };
}

/**
 * Detector 3: regression-underreporting
 * @param {object} args
 * @param {Array} args.history — recent regression signals [{ severity: 'warn'|'high'|'blocker', ts }]
 * @param {number} args.k — window size
 */
export function detectRegressionUnderreporting({
  history = [],
  k = DEFAULT_HARMONY_CONFIG.regressionUnderreportK,
} = {}) {
  if (!Array.isArray(history) || history.length < k) {
    return { detected: false, pattern: 'regression-underreporting', evidence: { k, length: history.length } };
  }
  const SEVERITY_RANK = { warn: 1, high: 2, blocker: 3 };
  const window = history.slice(-k);
  const maxSeverity = window.reduce((m, r) => Math.max(m, SEVERITY_RANK[r.severity] ?? 0), 0);
  const latest = window[window.length - 1];
  const latestRank = SEVERITY_RANK[latest?.severity] ?? 0;

  if (maxSeverity >= SEVERITY_RANK.high && latestRank < SEVERITY_RANK.high) {
    return {
      detected: true,
      pattern: 'regression-underreporting',
      evidence: {
        k,
        maxSeverity,
        latestSeverity: latest.severity,
        window: window.map((r) => ({ severity: r.severity, ts: r.ts })),
      },
    };
  }
  return {
    detected: false,
    pattern: 'regression-underreporting',
    evidence: { k, maxSeverityRank: maxSeverity, latestSeverity: latest?.severity },
  };
}

/**
 * Default detectors runner: 跑全部 3 个检测器,合并 verdict。
 * @param {object} args
 * @param {Array} args.results — current EvalResult[]
 * @param {object} args.config — QualityConfig (contract)
 * @param {object} args.history  — 供给所有 3 个 detector 的历史数据:
 *    {
 *      byTarget: { [targetId]: [{decision, score, ts}] },
 *      regressionHistory: [{severity, ts}],
 *    }
 * @returns {Promise<{ report: 'clean'|'false-harmony', patterns: string[] }>}
 */
export async function runHarmonyDetectors({ results = [], config = {}, history = { byTarget: {}, regressionHistory: [] } } = {}) {
  const hc = { ...DEFAULT_HARMONY_CONFIG, ...(config.harmonyDetector ?? {}) };
  const patterns = [];

  // Pattern 1 + 2: per-target history & same-batch coherence
  const perTargetChecks = [];
  for (const targetId of Object.keys(history.byTarget ?? {})) {
    const r = detectRejectionUniformity({ history: history.byTarget[targetId], k: hc.rejectionUniformityK });
    if (r.detected) {
      patterns.push(r.pattern);
      perTargetChecks.push({ targetId, pattern: r.pattern });
    }
  }
  if (Array.isArray(results) && results.length > 0) {
    // batch coherence 用当前 results 自身（每个 result 有 dimensions/composite → score）
    const batch = results.map((r) => ({
      targetId: r.targetId,
      decision: r._decision ?? 'UNKNOWN',
      score: r._composite ?? null,
    }));
    const fc = detectFalseConsensus({ batch, n: hc.falseConsensusN, minScore: hc.falseConsensusMinScore });
    if (fc.detected) patterns.push(fc.pattern);
  }

  // Pattern 3: regression history
  const ru = detectRegressionUnderreporting({ history: history.regressionHistory ?? [], k: hc.regressionUnderreportK });
  if (ru.detected) patterns.push(ru.pattern);

  if (patterns.length === 0) {
    return { report: 'clean', patterns: [] };
  }
  return { report: 'false-harmony', patterns };
}

/**
 * Convenience: 把检测器汇总写一条 failure-pattern 到 evo (供 weekly hook 调用)
 */
export async function reportDetectorsToEvo({ detectorsResult, evo }) {
  if (!evo || typeof evo.addFailure !== 'function') return null;
  if (detectorsResult.report !== 'false-harmony') return null;
  const written = [];
  for (const pattern of detectorsResult.patterns) {
    const r = await evo.addFailure({
      pattern: `harmony:${pattern}`,
      category: 'harmony',
      severity: 'medium',
      evidence: JSON.stringify({ pattern, detectedAt: new Date().toISOString() }),
    });
    written.push(r);
  }
  return written;
}
