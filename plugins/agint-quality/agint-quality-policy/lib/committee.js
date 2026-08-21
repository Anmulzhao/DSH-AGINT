/**
 * agint-quality-policy/lib/committee.js — 元评估委员会（Sprint 4.3）
 *
 * 四件套:
 *   1. shadow: 让"候选新策略"在同样的 results 上跑一遍,与 prod 决策对比,只记录分歧,不写 failure
 *   2. rollback: 当 prod 策略触发连续高频 REJECT 时,自动回滚到上一个 audit-passed 策略
 *   3. history: source-of-truth 决策历史(append-only),提供 query 接口
 *   4. auto-promote: shadow 连续 N=10 次与 prod 一致 → 自动晋升为新 prod
 *
 * 纯函数 + 内存 storage(测试可注入;生产由 sibling plugin 提供).
 *
 * ADJUSTABLE 阈值（policy via contract.setConfig 'committee' namespace）:
 *   - shadowAutoPromoteN: 10 默认
 *   - rollbackTriggerPct: 0.5 默认 (50% 决策为 REJECT 则触发 rollback)
 *   - rollbackMinSampleSize: 5 默认
 */

export const DEFAULT_COMMITTEE_CONFIG = {
  shadowAutoPromoteN: 10,
  rollbackTriggerPct: 0.5,
  rollbackMinSampleSize: 5,
};

/**
 * Default in-memory storage. Tests can inject a custom storage.
 * @returns {{
 *   history: Map<string, any>,
 *   shadowRuns: Map<string, any>,
 *   prodSnapshots: Map<string, any>,
 *   promotionCandidates: Map<string, any>,
 *   rollbackEvents: Map<string, any>,
 * }}
 */
export function makeCommitteeStorage() {
  return {
    history: new Map(),
    shadowRuns: new Map(),
    prodSnapshots: new Map(),
    promotionCandidates: new Map(),
    rollbackEvents: new Map(),
  };
}

/* ─────────────────────────────────────────────────────────────
 * Shadow mode (影子模式)
 * ───────────────────────────────────────────────────────────── */

/**
 * Run candidate policy on the same eval results, compare with prod.
 * Returns disagreement analysis.
 *
 * @param {object} args
 * @param {string} args.candidateId — candidate policyId (e.g. 'agint-quality-policy@0.5.0-rc')
 * @param {Array}  args.results    — EvalResult[]
 * @param {Function} args.candidateDecide — async ({results, config}) => Decision
 * @param {Function} args.prodDecide     — async ({results, config}) => Decision (the active prod)
 * @param {object} args.storage     — committee storage (see makeCommitteeStorage)
 * @returns {Promise<{
 *   candidateId: string,
 *   prodKind: string,
 *   candidateKind: string,
 *   agreed: boolean,
 *   disagreements: string[],
 *   runAt: string,
 * }>}
 */
export async function runShadowPolicy({ candidateId, results, candidateDecide, prodDecide, storage }) {
  const prodDecision = await prodDecide({ results });
  const candidateDecision = await candidateDecide({ results });

  const disagreements = [];
  if (prodDecision.kind !== candidateDecision.kind) {
    disagreements.push(`master:${prodDecision.kind}->${candidateDecision.kind}`);
  }
  // perTarget 比较
  const prodMap = new Map((prodDecision.perTarget ?? []).map((t) => [t.targetId, t.kind]));
  const candMap = new Map((candidateDecision.perTarget ?? []).map((t) => [t.targetId, t.kind]));
  for (const [targetId, prodKind] of prodMap.entries()) {
    const candKind = candMap.get(targetId);
    if (candKind && candKind !== prodKind) {
      disagreements.push(`${targetId}:${prodKind}->${candKind}`);
    }
  }

  const run = {
    candidateId,
    prodKind: prodDecision.kind,
    candidateKind: candidateDecision.kind,
    agreed: disagreements.length === 0,
    disagreements,
    runAt: new Date().toISOString(),
  };

  if (storage?.shadowRuns) {
    const id = `${candidateId}-${run.runAt}`;
    storage.shadowRuns.set(id, run);
  }

  return run;
}

/**
 * Auto-promote: shadow runs for candidateId are stored. After N consecutive
 * agreed=true runs (no disagreement), promote candidate to prod candidate.
 *
 * @returns {Promise<{
 *   candidateId: string,
 *   consecutiveAgreed: number,
 *   shouldPromote: boolean,
 *   threshold: number,
 * }>}
 */
export async function checkShadowAutoPromotion({
  candidateId,
  storage,
  threshold = DEFAULT_COMMITTEE_CONFIG.shadowAutoPromoteN,
} = {}) {
  if (!storage?.shadowRuns) throw new Error('checkShadowAutoPromotion: storage required');
  const runs = [...storage.shadowRuns.values()]
    .filter((r) => r.candidateId === candidateId)
    .sort((a, b) => a.runAt.localeCompare(b.runAt));

  // Count trailing consecutive agreed=true runs
  let consecutiveAgreed = 0;
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].agreed) consecutiveAgreed++;
    else break;
  }

  return {
    candidateId,
    consecutiveAgreed,
    shouldPromote: consecutiveAgreed >= threshold,
    threshold,
    totalRuns: runs.length,
  };
}

/* ─────────────────────────────────────────────────────────────
 * Rollback (回滚)
 * ───────────────────────────────────────────────────────────── */

/**
 * Compute whether recent decisions are too many REJECTs (>= rollbackTriggerPct).
 *
 * @param {object} args
 * @param {Array} args.recentDecisions — chronological order [{kind, ts}]
 * @param {number} args.minSample — minimum sample size before rollback triggers
 * @param {number} args.triggerPct — 0..1
 */
export function shouldRollback({
  recentDecisions = [],
  minSample = DEFAULT_COMMITTEE_CONFIG.rollbackMinSampleSize,
  triggerPct = DEFAULT_COMMITTEE_CONFIG.rollbackTriggerPct,
} = {}) {
  if (!Array.isArray(recentDecisions) || recentDecisions.length < minSample) {
    return { shouldRollback: false, reason: 'insufficient-sample', sampleSize: recentDecisions.length };
  }
  const rejects = recentDecisions.filter((d) => d.kind === 'REJECT').length;
  const pct = rejects / recentDecisions.length;
  if (pct >= triggerPct) {
    return {
      shouldRollback: true,
      reason: 'reject-rate-exceeded',
      rejectCount: rejects,
      total: recentDecisions.length,
      pct,
      threshold: triggerPct,
    };
  }
  return {
    shouldRollback: false,
    reason: 'within-threshold',
    rejectCount: rejects,
    total: recentDecisions.length,
    pct,
    threshold: triggerPct,
  };
}

/**
 * Mark rollback event: who rolled back from which to which, and persist.
 *
 * @returns {Promise<{
 *   rolledBackFrom: string,
 *   rolledBackTo: string,
 *   reason: string,
 *   ts: string,
 * }>}
 */
export async function recordRollback({
  rolledBackFrom,
  rolledBackTo,
  reason,
  storage,
} = {}) {
  if (!storage?.rollbackEvents) throw new Error('recordRollback: storage required');
  const event = {
    rolledBackFrom,
    rolledBackTo,
    reason,
    ts: new Date().toISOString(),
  };
  storage.rollbackEvents.set(`${event.ts}-${rolledBackFrom}`, event);
  return event;
}

/* ─────────────────────────────────────────────────────────────
 * History (source-of-truth)
 * ───────────────────────────────────────────────────────────── */

/**
 * Append a decision to history. Source-of-truth, append-only.
 */
export async function appendHistory({
  decision,
  policyId,
  storage,
  source = 'prod',
} = {}) {
  if (!storage?.history) throw new Error('appendHistory: storage required');
  const entry = {
    ts: decision.decidedAt ?? new Date().toISOString(),
    kind: decision.kind,
    score: decision.score,
    reason: decision.reason,
    policyId,
    source,
    triggeredBy: decision.triggeredBy ?? [],
  };
  storage.history.set(entry.ts, entry);
  return entry;
}

/**
 * Query history. Linear scan + filter; ok for v0.4 in-memory.
 *
 * @param {object} args
 * @param {object} args.storage
 * @param {string} [args.policyId] — filter by policyId
 * @param {string} [args.kind]     — filter by decision kind
 * @param {number} [args.limit=50] — max results
 * @returns {Array<HistoryEntry>}
 */
export function queryHistory({ storage, policyId, kind, limit = 50 } = {}) {
  if (!storage?.history) return [];
  let items = [...storage.history.values()];
  if (policyId) items = items.filter((e) => e.policyId === policyId);
  if (kind) items = items.filter((e) => e.kind === kind);
  return items
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, limit);
}

/**
 * Take a snapshot of the current prod strategy.
 */
export async function saveProdSnapshot({ policyId, config, storage }) {
  if (!storage?.prodSnapshots) throw new Error('saveProdSnapshot: storage required');
  const snap = { policyId, config: config ?? {}, ts: new Date().toISOString() };
  storage.prodSnapshots.set(policyId, snap);
  return snap;
}

/**
 * Resolve "previous audit-passed policy" for rollback target.
 * Returns most recent prodSnapshots entry whose policyId !== currentPolicyId.
 */
export function pickRollbackTarget({ currentPolicyId, storage }) {
  if (!storage?.prodSnapshots) return null;
  const snaps = [...storage.prodSnapshots.values()].sort((a, b) => b.ts.localeCompare(a.ts));
  for (const s of snaps) {
    if (s.policyId !== currentPolicyId) return s;
  }
  return null;
}
