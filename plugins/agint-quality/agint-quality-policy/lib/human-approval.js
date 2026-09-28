/**
 * agint-quality-policy human-approval bridge —— 行动 #4：
 * policy.decide() 四分支与宿主 dsh-user-approval 人工兜底对齐。
 *
 * ## 落地目标（对报告 §6.1-3 的实现）
 *
 * 宿主内人工兜底语义（dsh-user-approval）：审批请求可被人工 **allowed-once**
 * （唯一 grant，单次放行）、**rejected**（拒绝）、**cancelled / unavailable**
 * （未决）。本桥把 D-QAF `policy.decide()` 的四个分支显式映射到这套语义，
 * 并实现"被拒 → 人工可继续"的状态机：
 *
 * | decision.perTarget[].kind | 映射动作 | 人工 allowed-once 后 |
 * |---|---|---|
 * | AUTO_DEPLOY | skip（无需人工） | 不变（已可继续） |
 * | PENDING_REVIEW | ask（需人工确认） | 视为人工批准，可继续 |
 * | REJECT | escalate（被拒 → 人工可继续） | 升级为 PENDING_REVIEW（人工 override 放行） |
 * | ABSTAIN | escalate（人工决定） | 升级为 PENDING_REVIEW（人工 override 放行） |
 *
 * ## 边界（先读再改）
 *
 * 1. **无 turn 降级**：宿主 `approval.request()` 要求 open turn（turn-enclosed 审计）。
 *    AGINT 的 policy 决策大多发生在 cron / 无人值守（host plane，无 turn），此时
 *    request 必然抛错 → `{ channel:'deferred', outcome:'pending' }`，调用方把
 *    决策记入 memory/审计即可（不阻断、不假装审批过）。有 turn 的场景（agent
 *    会话内调用）才真正走宿主 waterfall。
 * 2. **默认行为不变**：本桥是**能力提供**（map / apply / ask 三件套），不改变
 *    decide() 的默认返回；调用方显式启用 humanFallback 才在决策后调用。
 * 3. 纯函数（map / apply）不碰 ctx，可直接单测。
 */

/** dsh-user-approval 的唯一 grant。 */
export const GRANT_OUTCOME = 'allowed-once';
/** 已知 outcome 集合（对齐宿主 OUTCOMES）。 */
export const KNOWN_OUTCOMES = new Set([GRANT_OUTCOME, 'rejected', 'cancelled', 'unavailable']);

/**
 * 映射：单条决策（decision.perTarget 的一项）→ 人工兜底动作。
 * @param {{ kind?: string, targetId?: string }} target
 * @returns {{ action: 'skip'|'ask'|'escalate', reason: string, kind: string }}
 */
export function mapDecisionToApproval(target = {}) {
  const kind = target?.kind ?? 'UNKNOWN';
  switch (kind) {
    case 'AUTO_DEPLOY':
      return { action: 'skip', reason: 'auto-deploy: no human needed', kind };
    case 'PENDING_REVIEW':
      return { action: 'ask', reason: 'pending-review: needs human confirmation to continue', kind };
    case 'REJECT':
      return { action: 'escalate', reason: 'reject: human may continue via approval override', kind };
    case 'ABSTAIN':
      return { action: 'escalate', reason: 'abstain: human decides', kind };
    default:
      return { action: 'skip', reason: `unknown kind "${kind}"`, kind };
  }
}

/**
 * 状态机：人工审批 outcome × 决策 → 可继续性（"被拒→人工可继续"核心判据）。
 *
 * - `allowed-once`：REJECT/ABSTAIN → 升级为 PENDING_REVIEW（humanOverride:true，
 *   可继续）；PENDING_REVIEW → 人工批准（humanApproved:true，可继续）；
 *   AUTO_DEPLOY → 不变。
 * - `rejected`：终态拒绝（continueAllowed:false，final:true）。
 * - `cancelled` / `unavailable` / 未知：保持原决策（pending:true，未决）。
 *
 * @param {object} target 原决策项（perTarget 的一项）
 * @param {string} outcome 人工审批结果
 * @param {object} [opts] { actor?: string, at?: number }
 * @returns {object} 变换后的决策项（原字段 + humanApproval 审计 + 状态标记）
 */
export function applyHumanOutcome(target = {}, outcome, opts = {}) {
  const actor = opts.actor ?? 'human';
  const at = opts.at ?? Date.now();
  const base = { ...target, humanApproval: { actor, outcome, at } };
  const kind = target?.kind;
  if (outcome === GRANT_OUTCOME) {
    if (kind === 'REJECT' || kind === 'ABSTAIN') {
      // 被拒 → 人工批准 → 升级为 PENDING_REVIEW，可继续（人工 override 放行）。
      return {
        ...base,
        kind: 'PENDING_REVIEW',
        humanOverride: true,
        continueAllowed: true,
        reason: 'human approved continuation after rejection',
      };
    }
    if (kind === 'PENDING_REVIEW') {
      return { ...base, humanApproved: true, continueAllowed: true, reason: 'human approved pending review' };
    }
    return { ...base, continueAllowed: kind === 'AUTO_DEPLOY' };
  }
  if (outcome === 'rejected') {
    return { ...base, continueAllowed: false, final: true, reason: 'human rejected continuation' };
  }
  // cancelled / unavailable / 未知 → 未决，保持原决策（调用方自行决定是否再问）。
  return { ...base, continueAllowed: false, pending: true, reason: `approval outcome "${outcome}" leaves decision pending` };
}

/**
 * 软依赖桥：把一条"需要人工兜底"的决策项交给宿主 dsh-user-approval。
 *
 * 返回：
 * - `{ channel:'skip', outcome:'none' }` —— AUTO_DEPLOY/未知，无需人工；
 * - `{ channel:'approval', outcome }` —— 宿主 request 成功（需 open turn）；
 * - `{ channel:'deferred', outcome:'pending', reason }` —— 服务不可用 / 无 turn /
 *   抛错（降级，不阻断调用方）。
 *
 * @param {object} args
 * @param {object} args.target 决策项（perTarget 的一项）
 * @param {object} [args.deps] { getApproval?: () => object|null }
 * @param {object} [args.opts] { requestArgs?: object, agent?: object } —— requestArgs 透传
 *   给宿主 request（如 { toolName, message }）；agent 供 request 定位 session。
 * @returns {Promise<{ channel: 'skip'|'approval'|'deferred', outcome: string, mapped: object, result?: object, reason?: string }>}
 */
export async function askHuman({ target = {}, deps = {}, opts = {} }) {
  const mapped = mapDecisionToApproval(target);
  if (mapped.action === 'skip') {
    return { channel: 'skip', outcome: 'none', mapped };
  }
  const approval = typeof deps.getApproval === 'function' ? deps.getApproval() : null;
  if (!approval || typeof approval.request !== 'function') {
    return { channel: 'deferred', outcome: 'pending', reason: 'approval service unavailable', mapped };
  }
  try {
    const requestArgs = {
      ...(opts.requestArgs ?? {}),
      ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    };
    const result = await approval.request(requestArgs);
    const outcome = KNOWN_OUTCOMES.has(result) ? result : 'unavailable';
    return { channel: 'approval', outcome, mapped, result };
  } catch (error) {
    // 宿主 request 在无 open turn 时抛错（turn-enclosed 审计要求）→ 降级 deferred。
    return { channel: 'deferred', outcome: 'pending', reason: `approval request failed: ${error?.message ?? String(error)}`, mapped };
  }
}

/**
 * 便捷组合：askHuman + applyHumanOutcome 一步到位。
 * @returns {Promise<{ mapped, ask, decision: object }>}
 */
export async function decideWithHumanFallback({ target = {}, deps = {}, opts = {} }) {
  const mapped = mapDecisionToApproval(target);
  if (mapped.action === 'skip') {
    return { mapped, ask: { channel: 'skip', outcome: 'none' }, decision: applyHumanOutcome(target, 'none', opts) };
  }
  const ask = await askHuman({ target, deps, opts });
  const decision = applyHumanOutcome(target, ask.outcome === 'none' ? 'pending' : ask.outcome, opts);
  return { mapped, ask, decision };
}
