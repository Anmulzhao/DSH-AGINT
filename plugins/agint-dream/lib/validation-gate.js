/**
 * agint-dream: validation gate + loss fraction budget
 *
 * 设计见 AGINT/计划-agint-dream升级三方向.md P0 段 + openclaw
 * `extensions/memory-core/src/dreaming-consolidation.ts` `validateConsolidationPlan`
 * (line 211-289) + `applyMemoryConsolidationPlan` (line 291-400)。
 *
 * 关键约束（openclaw 对齐 + 老板 2026-09-05 验证发现的洞）：
 * - merged 的 priorEntries 必须是已存在 memory entry（不能是另一个 candidate key）
 * - superseded 必须带 matching lineageKey
 * - 1 candidate → 1 operation（不能 A 互为 B 的 priorEntry）
 * - loss fraction ≤ 0.25（默认，可配）
 * - 任何校验失败 → reject 整批；sweep 标 degraded，事件 dream.rejected
 *
 * 输入 gated candidates（已经过 score/recall/sessions/dedupe 门槛）+ existing memory list
 * 输出 validatedOperations（按 candidateKey 索引）或 { reason } 拒因
 */

// 复用 sweep.js 的 normalize 逻辑，但 sweep.js 的 normalizeForCompare 不是 export，
// 这里独立维护一份（保持行为一致：lowercase + 去标点 + 4096 截断）。
function normalizeForCompare(text) {
  return String(text || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '').slice(0, 4096);
}

const DEFAULT_MAX_PRIOR_ENTRY_LOSS_FRACTION = 0.25;
const DEFAULT_MAX_PROMOTED_SNIPPET_CHARS = 640; // 160 tokens * 4 chars/token

/**
 * @param {Object} params
 * @param {Array} params.gated - 通过 score/dedupe 门槛的候选
 * @param {Array} params.existing - agint.memory.list() 结果
 * @param {Object} [params.operations] - 可选：来自 P1 LLM consolidation 的 operations；
 *        若提供则按 operations 走；否则走"全部 added"的退化路径。
 * @param {number} [params.maxPriorEntryLossFraction=0.25]
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   plan?: Array<{candidateKey, action, lineageKey?, resultEntry, priorEntries}>,
 *   stats?: {added, merged, superseded, lossFraction}
 * }}
 */
export function validateAndApply({
  gated,
  existing = [],
  operations = null,
  maxPriorEntryLossFraction = DEFAULT_MAX_PRIOR_ENTRY_LOSS_FRACTION,
  maxPromotedSnippetChars = DEFAULT_MAX_PROMOTED_SNIPPET_CHARS,
} = {}) {
  if (!Array.isArray(gated) || gated.length === 0) {
    return { ok: true, plan: [], stats: emptyStats() };
  }

  // candidateByKey + existingByContent
  const candidateByKey = new Map(gated.map((c) => [c.key, c]));
  const existingByKey = new Map(existing.map((e) => [e.id, e]));
  const existingByContent = new Map();
  for (const e of existing) {
    const norm = normalizeForCompare(e.content);
    if (norm) existingByContent.set(norm, e);
  }

  // 1. operations 校验（如有）
  let resolvedOps;
  if (operations) {
    const opCheck = checkOperations({ operations, gated, existingByKey, existingByContent, candidateByKey });
    if (!opCheck.ok) return { ok: false, reason: opCheck.reason };
    resolvedOps = opCheck.plan;
  } else {
    // 退化路径：全部当 added 处理（启发式 push 仍然能工作）
    resolvedOps = gated.map((c) => ({
      candidateKey: c.key,
      action: 'added',
      priorEntries: [],
      lineageKey: null,
    }));
  }

  // 2. loss fraction 校验
  // 注意：同一 priorEntry 文本被多个 candidate 引用只能算 1 次 removed（去重）。
  // openclaw applyMemoryConsolidationPlan 是按 priorEntry 文本逐行 splice 的，
  // 同文本被 splice 多次也只删一次。
  const currentEntries = existing.filter((e) => !e.resolved).length;
  const removedEntryTexts = new Set();
  for (const op of resolvedOps) {
    for (const pe of op.priorEntries || []) removedEntryTexts.add(pe);
  }
  const removedEntryCount = removedEntryTexts.size;
  const lossFraction = currentEntries === 0 ? 0 : removedEntryCount / currentEntries;
  if (lossFraction > maxPriorEntryLossFraction) {
    return {
      ok: false,
      reason: `loss fraction ${lossFraction.toFixed(3)} exceeds budget ${maxPriorEntryLossFraction}`,
      stats: { ...emptyStats(), lossFraction },
    };
  }

  // 3. 拼 resultEntry（按 action 模板）
  const plan = resolvedOps.map((op) => {
    const candidate = candidateByKey.get(op.candidateKey);
    if (!candidate) {
      // 防御：checkOperations 已保证 1:1，这里再兜一次
      throw new Error(`validateAndApply: missing candidate ${op.candidateKey}`);
    }
    const resultEntry = buildResultEntry(candidate, op, maxPromotedSnippetChars);
    return { ...op, resultEntry };
  });

  // 4. 统计
  const stats = {
    added: plan.filter((p) => p.action === 'added').length,
    merged: plan.filter((p) => p.action === 'merged').length,
    superseded: plan.filter((p) => p.action === 'superseded').length,
    lossFraction,
  };
  return { ok: true, plan, stats };
}

function emptyStats() {
  return { added: 0, merged: 0, superseded: 0, lossFraction: 0 };
}

function buildResultEntry(candidate, op, maxChars) {
  const text = String(candidate.text || '').replace(/^[-*+]\s+/u, '').replace(/\s+/gu, ' ').trim();
  const trimmed = text.length > maxChars ? text.slice(0, maxChars) : text;
  const sourceRef = candidate.path
    ? `Source: ${candidate.path}#L${candidate.startLine}-L${candidate.endLine}`
    : null;
  const parts = [`- ${trimmed}`];
  if (sourceRef) parts.push(sourceRef);
  if (op.lineageKey) parts.push(`<!-- agint-memory-lineage:${op.lineageKey} -->`);
  return parts.join(' ');
}

/**
 * 强校验 operations（参考 openclaw validateConsolidationPlan）。
 * 返回 {ok:true, plan} 或 {ok:false, reason}
 */
function checkOperations({ operations, gated, existingByKey, existingByContent, candidateByKey }) {
  if (!Array.isArray(operations) || operations.length !== gated.length) {
    return { ok: false, reason: `operation count ${operations?.length || 0} != candidate count ${gated.length}` };
  }
  const seen = new Set();
  const plan = [];
  for (const op of operations) {
    if (!op || typeof op !== 'object') {
      return { ok: false, reason: 'operation is not an object' };
    }
    const { candidateKey, action, priorEntries, lineageKey } = op;
    if (typeof candidateKey !== 'string' || !candidateKey) {
      return { ok: false, reason: 'operation missing candidateKey' };
    }
    if (seen.has(candidateKey)) {
      return { ok: false, reason: `duplicate operation for ${candidateKey}` };
    }
    seen.add(candidateKey);
    if (!['added', 'merged', 'superseded'].includes(action)) {
      return { ok: false, reason: `invalid action "${action}" for ${candidateKey}` };
    }
    if (!Array.isArray(priorEntries)) {
      return { ok: false, reason: `priorEntries not array for ${candidateKey}` };
    }
    if (action === 'added' && priorEntries.length > 0) {
      return { ok: false, reason: `added action with priorEntries for ${candidateKey}` };
    }
    if (action !== 'added' && priorEntries.length === 0) {
      return { ok: false, reason: `${action} action without priorEntries for ${candidateKey}` };
    }
    // 关键：priorEntries 必须是"现有 memory entry"，不是 candidate key
    for (const prior of priorEntries) {
      if (typeof prior !== 'string') {
        return { ok: false, reason: `priorEntries entry not string for ${candidateKey}` };
      }
      if (candidateByKey.has(prior)) {
        return { ok: false, reason: `priorEntry "${prior}" is a candidate key, not existing memory (for ${candidateKey})` };
      }
      if (!existingByContent.has(normalizeForCompare(prior))) {
        return { ok: false, reason: `priorEntry "${prior}" not found in existing memory (for ${candidateKey})` };
      }
    }
    if (action === 'superseded' && !lineageKey) {
      return { ok: false, reason: `superseded action without lineageKey for ${candidateKey}` };
    }
    if (lineageKey) {
      // 同一 lineage 内的 priorEntries lineage 必须一致
      for (const prior of priorEntries) {
        const norm = normalizeForCompare(prior);
        const e = existingByContent.get(norm);
        if (e && e.lineageKey && e.lineageKey !== lineageKey) {
          return { ok: false, reason: `priorEntry lineageKey mismatch for ${candidateKey}` };
        }
      }
    }
    plan.push({ candidateKey, action, priorEntries, lineageKey: lineageKey || null, candidateType: candidateByKey.get(candidateKey)?.type || 'lesson' });
  }
  // 1:1 覆盖
  if (seen.size !== gated.length) {
    return { ok: false, reason: 'not all candidates have an operation' };
  }
  return { ok: true, plan };
}

/** 给 host plane 用：把 plan 翻译成 agint.memory.write 调用的描述。 */
export function planToWriteCalls(plan) {
  return plan.map((p) => ({
    candidateKey: p.candidateKey,
    action: p.action,
    write: (memory, evidence) => {
      if (p.action === 'added') {
        return memory.write({
          type: p.candidateType || 'lesson',
          content: stripEntryPrefix(p.resultEntry),
          evidence: evidence || `agint-dream validation-gate added`,
          lineageKey: p.lineageKey,
          supersedesKey: null,
        });
      }
      if (p.action === 'merged') {
        return memory.write({
          type: p.candidateType || 'lesson',
          content: stripEntryPrefix(p.resultEntry),
          evidence: evidence || `agint-dream validation-gate merged`,
          lineageKey: p.lineageKey || `agint-merge-${p.candidateKey}`,
          supersedesKey: null,
        });
      }
      if (p.action === 'superseded') {
        return memory.write({
          type: p.candidateType || 'lesson',
          content: stripEntryPrefix(p.resultEntry),
          evidence: evidence || `agint-dream validation-gate superseded`,
          lineageKey: p.lineageKey,
          supersedesKey: p.priorEntries?.[0] ?? null,
        });
      }
      throw new Error(`unknown action: ${p.action}`);
    },
  }));
}

function stripEntryPrefix(entry) {
  return String(entry || '').replace(/^-\s+/u, '').replace(/\s*Source:.*$/u, '').trim();
}
