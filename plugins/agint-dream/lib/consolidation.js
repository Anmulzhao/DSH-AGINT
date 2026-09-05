/**
 * agint-dream: LLM consolidation — 让梦境真正做 add/merge/supersede 决策。
 *
 * 设计见 AGINT/计划-agint-dream升级三方向.md P1 段 + openclaw
 * `extensions/memory-core/src/dreaming-consolidation.ts` `consolidateDreams`
 * (line 402-490)。
 *
 * 关键决策：
 * - 用 DSH 自带 subagent runtime（ctx.agents.create + ctx.subagents.start）
 *   而不是新建插件：2026-09-05 老板纠正发现 DSH 本身即 subagent runtime。
 * - outputSchema 由 DSH provider 自动 schema-validation，省掉 openclaw 的
 *   parseConsolidationPlan。
 * - toolFilter: {restrict: [...]} 禁止子 agent 用任何工具，只让模型做决策。
 * - 失败/超时/schema validation fail → 返回 null（不抛），让 sweep 走
 *   启发式 added 退化路径，sweep 标 consolidationMode: 'heuristic-degraded'。
 *
 * 入参：{ ctx, gated, existing, day, opts? }
 *   ctx - cordis host ctx（apply 第二参），用于 ctx.get('agents' / 'subagents')
 *   gated - score/dedupe 后的候选，每条必须有 .key + .text + .type
 *   existing - memory.list() 结果，每条 { id, type, content, lineageKey?, supersedesKey? }
 *   day - sweep 日期（diary 用）
 *   opts.provider, opts.model, opts.timeoutMs - LLM route + 超时
 *
 * 出参：
 *   { ok: true, mode: 'llm', operations: [...] }
 *   { ok: true, mode: 'heuristic-degraded', operations: null, reason: '...' }
 *   { ok: false, reason: '...' }    // 任何 hard failure（不会发生，目前都走 degraded）
 */

import { randomUUID } from 'node:crypto';

// OpenClaw 用 Zod schema；DSH ObjectJsonSchema 是受限子集（type/properties/
// required/additionalProperties/items/enum/const/oneOf）。
// 我们的 operations schema 要严格匹配 validation-gate.js checkOperations 的入参：
// { candidateKey: string, action: 'added'|'merged'|'superseded',
//   priorEntries: string[], lineageKey?: string }
export const CONSOLIDATION_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    operations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          candidateKey: { type: 'string' },
          action: { type: 'string', enum: ['added', 'merged', 'superseded'] },
          priorEntries: { type: 'array', items: { type: 'string' } },
          lineageKey: { type: 'string' },
        },
        required: ['candidateKey', 'action', 'priorEntries'],
        additionalProperties: false,
      },
    },
    reasoning: { type: 'string' },
  },
  required: ['operations'],
  additionalProperties: false,
};

const DEFAULT_TIMEOUT_MS = 60_000;
// 默认 provider/model 从 ~/.dsh/settings.yaml agent-default-model 读（2026-09-05
// 实测：minimax-cn / MiniMax-M3）。DSH 部署真实默认是 minimax-cn，不是 deepseek。
// **绝对不能硬编码 'deepseek'/'deepseek-chat'**——DSH 把 deepseek 仅作 fallback
// adapter，host 真实可用 provider 由 settings.yaml 决定。
const DEFAULT_PROVIDER = 'minimax-cn';
const DEFAULT_MODEL = 'MiniMax-M3';

const SYSTEM_PROMPT = `You are a memory consolidation agent for the 智进 (Zhijin) AI worker.
Your job: decide for each candidate whether to ADD it as new memory, MERGE it into
an existing entry that covers the same claim, or SUPERSEDE an existing entry whose
claim is now wrong.

Hard rules (the host validation gate enforces these too — violating them rejects the whole batch):
1. Each candidate gets exactly ONE operation.
2. order matters: the operations array must have the same length and ordering as the
   candidates array (1:1 by index). The host validates this against gated.length.
3. \`action\` must be one of: 'added' | 'merged' | 'superseded'.
4. \`priorEntries\` must be the EXACT content of an existing memory entry (copy from
   the "Existing memory" list). Empty array for 'added'.
5. NEVER reference a candidate key in \`priorEntries\` — priorEntries points at
   existing memory entries, NOT other candidates.
6. For 'merged': 1-2 priorEntries that cover the same claim, plus a lineageKey
   shared across the merge group (e.g. "identity/boss", "safety/rm-rf").
7. For 'superseded': exactly one priorEntry being replaced, plus a lineageKey
   matching the prior entry's lineageKey (so host can verify lineage consistency).
   Use only when the candidate CONTRADICTS or REPLACES an existing entry.
8. Be conservative: when in doubt, prefer 'added' over 'merged' or 'superseded'.
   False merges pollute memory. Host's loss fraction budget (25% default) will
   reject the batch if you over-merge.

Output: call the structured_output tool with { operations, reasoning }.
The reasoning field (≤ 200 chars) summarizes your overall decision strategy.`;

/**
 * Build the user-facing prompt for the consolidation LLM.
 * Pure function — exported for testing.
 */
export function buildConsolidationPrompt(gated, existing, day) {
  const lines = [];
  lines.push(`# Memory consolidation — day ${day}`);
  lines.push('');
  lines.push(`You have ${gated.length} candidate(s) and ${existing.length} existing memory entries.`);
  lines.push('Decide add / merge / supersede for each candidate.');
  lines.push('');
  lines.push('## Candidates (order MUST match operations order)');
  lines.push('');
  for (let i = 0; i < gated.length; i += 1) {
    const c = gated[i];
    lines.push(`### Candidate ${i + 1} [key: ${c.key}] type=${c.type} score=${(c.score ?? 0).toFixed(2)}`);
    lines.push(`> ${c.text}`);
    if (c.sessionKey) lines.push(`session: ${c.sessionKey}`);
    if (c.signalCount) lines.push(`signals: ${c.signalCount} across ${c.uniqueDays ?? '?'} day(s)`);
    lines.push('');
  }
  lines.push('## Existing memory');
  lines.push('');
  for (const e of existing) {
    const lk = e.lineageKey ? ` [lineage=${e.lineageKey}]` : '';
    const sk = e.supersedesKey ? ` [supersedes=${e.supersedesKey}]` : '';
    lines.push(`- (id=${e.id}, type=${e.type}${lk}${sk}) ${e.content}`);
  }
  lines.push('');
  lines.push('## Output');
  lines.push('');
  lines.push('Return { operations, reasoning } via structured_output tool.');
  lines.push(`Operations array length MUST equal ${gated.length}.`);
  lines.push('Each operation: { candidateKey, action, priorEntries, lineageKey? }');
  return lines.join('\n');
}

/**
 * Run LLM consolidation. Returns:
 *   { ok: true, mode: 'llm', operations }
 *   { ok: true, mode: 'heuristic-degraded', operations: null, reason }
 * Never throws — all errors are caught and turned into a degraded result.
 */
export async function consolidate({
  ctx,
  gated,
  existing,
  day,
  provider = DEFAULT_PROVIDER,
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = null,
}) {
  const log = (msg, extra) => {
    if (typeof logger?.info === 'function') {
      logger.info(`agint-dream.consolidation: ${msg}`, extra);
    }
  };

  // 0. 边界保护
  if (!Array.isArray(gated) || gated.length === 0) {
    return { ok: true, mode: 'heuristic-degraded', operations: null, reason: 'no gated candidates' };
  }
  if (!ctx || typeof ctx.get !== 'function') {
    return { ok: true, mode: 'heuristic-degraded', operations: null, reason: 'ctx unavailable' };
  }

  // 1. 服务可解析性检查
  const agents = ctx.get('agents');
  const subagents = ctx.get('subagents');
  if (!agents || typeof agents.create !== 'function') {
    log('agents service unavailable, degraded to heuristic');
    return { ok: true, mode: 'heuristic-degraded', operations: null, reason: 'agents service unavailable' };
  }
  if (!subagents || typeof subagents.start !== 'function') {
    log('subagents service unavailable, degraded to heuristic');
    return { ok: true, mode: 'heuristic-degraded', operations: null, reason: 'subagents service unavailable' };
  }
  const providerExists = typeof subagents.getProvider === 'function' ? subagents.getProvider('spawn') : null;
  if (!providerExists) {
    log('spawn subagent provider not registered, degraded to heuristic');
    return { ok: true, mode: 'heuristic-degraded', operations: null, reason: 'spawn provider not registered' };
  }

  // 2. 建临时 parent agent（路径 Y — host plane 无现成 agent）
  //    在 try/finally 里严格 dispose，避免泄漏 child session。
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort('consolidation-timeout'), timeoutMs);
  let consolidationHandle = null;
  let run = null;
  try {
    consolidationHandle = await agents.create({
      sessionId: `dream-consolidation-${day}-${randomUUID()}`,
      // 给临时 agent 一个 cwd —— 否则 child session inherit 的 deployment
      // persona section 用 {{cwd}} 找不到值会 throw，agent 启动后第一轮 turn
      // 就 error（2026-09-05 实测）。
      meta: { cwd: process.cwd(), origin: 'subagent' },
      agentOptions: { provider, model },
      signal: abortController.signal,
    });
    const prompt = buildConsolidationPrompt(gated, existing, day);
    run = await subagents.start('spawn', {
      parent: consolidationHandle.agent,
      prompt: [{ type: 'text', text: `${SYSTEM_PROMPT}\n\n${prompt}` }],
      outputSchema: CONSOLIDATION_OUTPUT_SCHEMA,
      signal: abortController.signal,
      // toolFilter: 不传。
      // child 通过 applyChildComposition join parent preset —— 但 parent 是 host
      // plane 临时 agent，ctx 上无 agentPresets 服务，所以 child 不会 join preset，
      // 默认工具集为空；provider 在 child scope 自动注册唯一的 structured_output
      // 工具，模型只能调它结束回合。这是 DSH 比 openclaw 干净的地方 —— openclaw
      // 要靠 toolFilter: {deny: ['*']} 强制禁止工具，但 * 不是 known global tool
      // 名会抛错；DSH 利用 child scope 的"无 join 即无工具"自然实现隔离。
      label: `agint-dream consolidation ${day}`,
    });
    // B 方案诊断：订阅 child agent 的 agent/error 事件，捕获真实失败原因。
    // 事件是 agent-scoped dispatch（@deepseek-ai/dsh-scope），必须在 child ctx 上订阅。
    const childErrors = [];
    if (run.localAgent?.ctx?.on) {
      try {
        run.localAgent.ctx.on('agent/error', (payload) => {
          const err = payload?.error;
          const errStr = err instanceof Error
            ? `${err.name}: ${err.message}${err.stack ? '\n' + err.stack.split('\n').slice(0, 8).join('\n') : ''}`
            : JSON.stringify(err).slice(0, 500);
          childErrors.push({ turn: payload?.turn, step: payload?.step, error: errStr });
        });
      } catch (e) { /* 订阅失败不阻断主流程 */ }
    }
    const result = await run.result;
    if (result.stopReason !== 'completed') {
      // 把 stopReason + output + agent/error 收集的 error 全带回
      const out = Array.isArray(result.output) ? result.output : [];
      const outStr = JSON.stringify(out).slice(0, 500);
      const childErrStr = childErrors.length > 0
        ? childErrors.map((e) => `[turn=${e.turn} step=${e.step}] ${e.error}`).join(' | ').slice(0, 1500)
        : null;
      const diag = (result.diagnostic ?? outStr ?? null) || childErrStr || null;
      log(`LLM did not complete: stopReason=${result.stopReason} diag=${diag?.slice(0, 300) ?? '(none)'}`);
      return {
        ok: true,
        mode: 'heuristic-degraded',
        operations: null,
        reason: `LLM stopReason=${result.stopReason}`,
        diagnostic: diag,
        childErrors: childErrors.length > 0 ? childErrors : null,
      };
    }
    const structured = result.structured;
    if (!structured || !Array.isArray(structured.operations)) {
      log('structured output missing or invalid', { structured });
      return {
        ok: true,
        mode: 'heuristic-degraded',
        operations: null,
        reason: 'structured output invalid',
      };
    }
    if (structured.operations.length !== gated.length) {
      log(`operations length ${structured.operations.length} != gated ${gated.length}`);
      return {
        ok: true,
        mode: 'heuristic-degraded',
        operations: null,
        reason: `operations length mismatch (${structured.operations.length} vs ${gated.length})`,
      };
    }
    log(`LLM consolidation succeeded: ${structured.operations.length} operations`);
    return { ok: true, mode: 'llm', operations: structured.operations, reasoning: structured.reasoning ?? null };
  } catch (err) {
    log(`consolidation failed: ${err?.message ?? String(err)}`);
    return {
      ok: true,
      mode: 'heuristic-degraded',
      operations: null,
      reason: `consolidation error: ${err?.message ?? String(err)}`,
    };
  } finally {
    if (run && typeof run.dispose === 'function') {
      try { await run.dispose(); } catch { /* swallow — already settled */ }
    }
    if (consolidationHandle && typeof consolidationHandle.dispose === 'function') {
      try { await consolidationHandle.dispose(); } catch { /* swallow */ }
    }
    clearTimeout(timer);
  }
}
