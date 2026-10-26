/**
 * agint-dream: LLM consolidation — 让梦境真正做 add/merge/supersede 决策。
 *
 * 设计见 AGINT/计划-agint-dream升级三方向.md P1 段 + openclaw
 * `extensions/memory-core/src/dreaming-consolidation.ts` `consolidateDreams`
 * (line 402-490)。
 *
 * 关键决策：
 * - 用 DSH 自带 subagent runtime（ctx.agents.create + ctx.subagents.startActivation，
 *   旧宿主保留 start 兼容分支）：2026-09-05 老板纠正发现 DSH 本身即 subagent runtime。
 * - outputSchema 由 DSH provider 自动 schema-validation，省掉 openclaw 的
 *   parseConsolidationPlan。
 * - 失败/超时/schema validation fail → ok:false + mode:'failed'（不抛），
 *   sweep **跳过本轮提升**（2026-10-25 无降级：⛔ 不退回启发式 added）。
 *
 * 入参：{ ctx, gated, existing, day, opts? }
 *   ctx - cordis host ctx（apply 第二参），用于 ctx.get('agents' / 'subagents')
 *   gated - score/dedupe 后的候选，每条必须有 .key + .text + .type
 *   existing - memory.list() 结果，每条 { id, type, content, lineageKey?, supersedesKey? }
 *   day - sweep 日期（diary 用）
 *   opts.provider, opts.model, opts.timeoutMs - LLM route + 超时
 *
 * 出参：
 *   { ok: true,  mode: 'llm',           operations: [...] }
 *   { ok: true,  mode: 'not-attempted', operations: null, reason: 'no gated candidates' }
 *   { ok: false, mode: 'failed',        operations: null, reason: '...' }
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

// 导出给测试引用：测试若硬编码 provider 名会随 settings.yaml 变化漂移
// （fbfd060 引入本常量时 test/consolidation.test.js 仍断言 'deepseek'，
// 该断言红到 2026-09-17 才被发现）。断言默认值一律 import 这里的常量。
export const DEFAULT_TIMEOUT_MS = 60_000;
// 默认 provider/model 从 ~/.dsh/settings.yaml agent-default-model 读（2026-09-05
// 实测：minimax-cn / MiniMax-M3）。DSH 部署真实默认是 minimax-cn，不是 deepseek。
// **绝对不能硬编码 'deepseek'/'deepseek-chat'**——DSH 把 deepseek 仅作 fallback
// adapter，host 真实可用 provider 由 settings.yaml 决定。
export const DEFAULT_PROVIDER = 'minimax-cn';
// 2026-10-25：host 注册模型已是 MiniMax-M3.1-Flash（-Preview 不可路由）。
export const DEFAULT_MODEL = 'MiniMax-M3.1-Flash';
// 2026-10-07 取证：DEFAULT_MODEL 要求的模型**强制 adaptive thinking**，
// 而 agents.create() 的 agentOptions 不传 reasoningEffort 时子代理退化成
// thinking 关闭 → MiniMax 返 400（
//   "requires adaptive thinking; thinking.type=\"disabled\" ... is not allowed (2013)"）
// → consolidation 恒失败 → promoted 恒 0 →
//   agint-ov-strategy 的 dream 投影被 `promoted <= 0` 门槛永远挡死。
// 取值对齐 settings.yaml 的 agent-default-model.reasoningEffort（high）；
// 合法档位见 llm-pi-ai.providers.minimax-cn.models[].reasoningEfforts
// （off/minimal/low/medium/high），off 不可用于本模型。
export const DEFAULT_REASONING_EFFORT = 'high';

// ⭐ 子代理「空壳会话」根因字段（2026-09-27 取证，30 个空壳换来的，见项目 KNOWLEDGE.md K114）。
// `agents.create()` 的 `meta.agentPreset` 是模型路由与 persona 的**唯一来源**：
// 不传 → child 会话 `agentPreset=null`、`modelSelection=null`、turn 的 prompt/response 全空、
// surfaceTokens=0 —— 会话照建、label 照写、**全程不报错**，但一步都跑不动，
// 最终静默落回失败（旧版为 heuristic-degraded，该回退已删除）。类型上它是可选的，对 host plane 凭空 create 的
// 临时 parent 却等于必填。
// ⛔ 别指望用 `agentOptions` 补：它只有 {provider, model, reasoningEffort, maxTokens}，没有 preset。
export const DEFAULT_AGENT_PRESET = 'agint';

const SYSTEM_PROMPT = `You are a memory consolidation agent for the 智进 (Zhijin) AI worker.
Your job: decide for each candidate whether to ADD it as new memory, MERGE it into
an existing entry that covers the same claim, or SUPERSEDE an existing entry whose
claim is now wrong.

Hard rules (the host validation gate enforces these too — violating them rejects the whole batch):
1. Each candidate gets exactly ONE operation.
2. order matters: the operations array must have the same length and ordering as the
   candidates array (1:1 by index). The host validates this against gated.length.
3. \`action\` must be one of: 'added' | 'merged' | 'superseded'.
4. \`priorEntries\` must be the EXACT content of an existing memory entry — copy the
   BODY of a \`\`\`text fenced block from the "Existing memory" list, verbatim.
   Strip the \`<!-- id=... -->\` comment line and the fence markers; never include them.
   Empty array for 'added'.
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
9. Some candidates carry a \`dedupe-suspicion\` note naming an existing entry they
   are textually close to. The host gate deliberately did NOT auto-drop them —
   wording overlap is not proof of the same claim. Judge each one on meaning:
   merge/supersede when it really is the same claim, otherwise add it. A
   suspicion note is EVIDENCE TO WEIGH, not an instruction to merge.

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
    // 2026-09-21（方案 B 分级去重，proposals/agint-dream-dedupe-lineage.md §4.2）：
    // 中相似档候选由 gate 放行并自带 `dedupeSuspicion` —— 把「文本高度相似但不确定
    // 是否同一主张」这件事**显式告诉模型**，而不是让它自己从原文里重新发现。
    // 提示归提示，判定权仍在模型（gate 已于 2026-09-21 明确不做 LLM 前置调用）。
    if (c.dedupeSuspicion) {
      const s = c.dedupeSuspicion;
      const pct = typeof s.similarity === 'number' ? `${(s.similarity * 100).toFixed(0)}%` : 'n/a';
      lines.push(`⚠️ dedupe-suspicion: ${s.kind} similarity=${pct} against existing entry id=${s.againstId ?? '?'}`);
      lines.push('   The host gate found this candidate textually close to that existing entry, but did NOT');
      lines.push('   auto-drop it — textual similarity is not proof of the same claim. Examine both and pick:');
      lines.push('   - same claim → action "merged" (or "superseded" if the existing entry is now wrong)');
      lines.push('   - different claim, merely similar wording → action "added"');
    }
    lines.push('');
  }
  lines.push('## Existing memory');
  lines.push('');
  lines.push('Each entry is given as a fenced block. When you fill `priorEntries`, copy the');
  lines.push('block body VERBATIM (the text between the fences, nothing else).');
  lines.push('Do NOT include the id/type header line, the fence markers, or any "> - " prefix.');
  lines.push('The validator compares priorEntries against the raw entry content — an extra');
  lines.push('prefix rejects the ENTIRE batch (2026-09-18 incident: 16 candidates lost).');
  lines.push('');
  for (const e of existing) {
    const lk = e.lineageKey ? ` [lineage=${e.lineageKey}]` : '';
    const sk = e.supersedesKey ? ` [supersedes=${e.supersedesKey}]` : '';
    lines.push(`<!-- id=${e.id} type=${e.type}${lk}${sk} -->`);
    lines.push('```text');
    lines.push(String(e.content ?? ''));
    lines.push('```');
    lines.push('');
  }
  lines.push('## Output');
  lines.push('');
  lines.push('Return { operations, reasoning } via structured_output tool.');
  lines.push(`Operations array length MUST equal ${gated.length}.`);
  lines.push('Each operation: { candidateKey, action, priorEntries, lineageKey? }');
  return lines.join('\n');
}

/**
 * Run LLM consolidation. Returns:
 *   { ok: true,  mode: 'llm',          operations }
 *   { ok: true,  mode: 'not-attempted', operations: null, reason }   // 0 条候选，内容闸门
 *   { ok: false, mode: 'failed',       operations: null, reason, diagnostic? }
 * 2026-10-25 无降级：LLM 失败不再返回 heuristic-degraded；sweep 必须跳过本轮提升。
 * Never throws — 失败用 ok:false 表达，避免夜间 sweep 因单个 LLM 故障直接崩溃。
 */
export async function consolidate({
  ctx,
  gated,
  existing,
  day,
  provider = DEFAULT_PROVIDER,
  model = DEFAULT_MODEL,
  reasoningEffort = DEFAULT_REASONING_EFFORT,
  agentPreset = DEFAULT_AGENT_PRESET,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = null,
}) {
  const log = (msg, extra) => {
    if (typeof logger?.info === 'function') {
      logger.info(`agint-dream.consolidation: ${msg}`, extra);
    }
  };

  // 0. 边界保护：0 条候选 = 内容闸门（LLM 没触发），不是失败
  if (!Array.isArray(gated) || gated.length === 0) {
    return { ok: true, mode: 'not-attempted', operations: null, reason: 'no gated candidates' };
  }
  if (!ctx || typeof ctx.get !== 'function') {
    return { ok: false, mode: 'failed', operations: null, reason: 'ctx unavailable' };
  }

  // 1. 服务可解析性检查（失败即 failed，不再回退启发式）
  const agents = ctx.get('agents');
  const subagents = ctx.get('subagents');
  if (!agents || typeof agents.create !== 'function') {
    log('agents service unavailable');
    return { ok: false, mode: 'failed', operations: null, reason: 'agents service unavailable' };
  }
  if (!subagents) {
    log('subagents service unavailable');
    return { ok: false, mode: 'failed', operations: null, reason: 'subagents service unavailable' };
  }
  const hasActivation = typeof subagents.startActivation === 'function';
  const hasLegacyStart = typeof subagents.start === 'function';
  if (!hasActivation && !hasLegacyStart) {
    log('subagents method missing');
    return {
      ok: false,
      mode: 'failed',
      operations: null,
      reason: `subagents method missing (startActivation=${hasActivation}, start=${hasLegacyStart})`,
    };
  }
  let providerExists = null;
  if (typeof subagents.getProvider === 'function') {
    try {
      providerExists = subagents.getProvider('spawn');
    } catch (error) {
      return { ok: false, mode: 'failed', operations: null, reason: `getProvider('spawn') failed: ${error?.message ?? error}` };
    }
    if (!providerExists) {
      log('spawn subagent provider not registered');
      return { ok: false, mode: 'failed', operations: null, reason: 'spawn provider not registered' };
    }
  }

  // 2. 建临时 parent agent（路径 Y — host plane 无现成 agent）
  //    在 try/finally 里严格 dispose，避免泄漏 child session。
  const abortController = new AbortController();
  // 超时双保险：① abort 信号让子 agent 自行收敛；② timeoutGuard 让本函数
  // 无论如何都能返回。缺 ② 时，若 provider 不认 signal（挂死的 HTTP、卡住的
  // 适配器），`await run.result` 会永久 pending —— 夜间 sweep 随之卡死、
  // cron job 再也不结束（test/consolidation.test.js「timeout 时 dispose 仍跑」
  // 就是这个契约，fbfd060 起一直红）。Promise.race 会在 run.result 先落地时
  // 忽略 timeoutGuard 的后续 reject，不会产生 unhandled rejection。
  let rejectOnTimeout = null;
  const timeoutGuard = new Promise((_, reject) => { rejectOnTimeout = reject; });
  const timer = setTimeout(() => {
    abortController.abort('consolidation-timeout');
    rejectOnTimeout?.(new Error(`consolidation timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  let consolidationHandle = null;
  let activation = null;
  let cancelled = false;
  const disposeLate = (resource) => {
    try { Promise.resolve(resource?.dispose?.()).catch(() => { /* ignore */ }); } catch { /* ignore */ }
  };
  try {
    const createPromise = agents.create({
      sessionId: `dream-consolidation-${day}-${randomUUID()}`,
      // 给临时 agent 一个 cwd —— 否则 child session inherit 的 deployment
      // persona section 用 {{cwd}} 找不到值会 throw，agent 启动后第一轮 turn
      // 就 error（2026-09-05 实测）。
      // ⭐ agentPreset：模型路由的唯一来源。缺失 ⇒ child 是空壳（见 DEFAULT_AGENT_PRESET 注释）。
      meta: { cwd: process.cwd(), origin: 'subagent', agentPreset },
      agentOptions: { provider, model, reasoningEffort },
      signal: abortController.signal,
    }).then((h) => {
      if (cancelled) disposeLate(h);
      return h;
    });
    consolidationHandle = await Promise.race([createPromise, timeoutGuard]);
    const prompt = buildConsolidationPrompt(gated, existing, day);
    // 2026-10-07：start 自身挂死也必须被超时兜住。
    // 2026-10-25：新宿主只有 startActivation；旧 start 保留兼容分支。
    const startPromise = (hasActivation
      ? Promise.resolve().then(() => subagents.startActivation({
        provider: 'spawn',
        label: `agint-dream consolidation ${day}`,
        request: {
          parent: consolidationHandle.agent,
          prompt: [{ type: 'text', text: `${SYSTEM_PROMPT}\n\n${prompt}` }],
          agentPreset,
          agentOptions: { provider, model, reasoningEffort },
          outputSchema: CONSOLIDATION_OUTPUT_SCHEMA,
        },
        signal: abortController.signal,
        delivery: 'caller',
      }))
      : Promise.resolve().then(() => subagents.start('spawn', {
        parent: consolidationHandle.agent,
        prompt: [{ type: 'text', text: `${SYSTEM_PROMPT}\n\n${prompt}` }],
        outputSchema: CONSOLIDATION_OUTPUT_SCHEMA,
        signal: abortController.signal,
        label: `agint-dream consolidation ${day}`,
      }))).then((act) => {
      if (cancelled) disposeLate(act);
      return act;
    });
    startPromise.catch(() => { /* 超时胜出后 start 仍会晚到落地，吞掉它的 rejection */ });
    activation = await Promise.race([startPromise, timeoutGuard]);
    const result = await Promise.race([activation.result, timeoutGuard]);
    if (result.stopReason !== 'completed') {
      const out = Array.isArray(result.output) ? result.output : [];
      const outStr = JSON.stringify(out).slice(0, 500);
      const diag = result.diagnostic ?? outStr ?? null;
      log(`LLM did not complete: stopReason=${result.stopReason} diag=${diag?.slice(0, 300) ?? '(none)'}`);
      return {
        ok: false,
        mode: 'failed',
        operations: null,
        reason: `LLM stopReason=${result.stopReason}`,
        diagnostic: diag,
      };
    }
    const structured = result.structured;
    if (!structured || !Array.isArray(structured.operations)) {
      log('structured output missing or invalid', { structured });
      return { ok: false, mode: 'failed', operations: null, reason: 'structured output invalid' };
    }
    if (structured.operations.length !== gated.length) {
      log(`operations length ${structured.operations.length} != gated ${gated.length}`);
      return {
        ok: false,
        mode: 'failed',
        operations: null,
        reason: `operations length mismatch (${structured.operations.length} vs ${gated.length})`,
      };
    }
    log(`LLM consolidation succeeded: ${structured.operations.length} operations`);
    return { ok: true, mode: 'llm', operations: structured.operations, reasoning: structured.reasoning ?? null };
  } catch (err) {
    // 超时路径统一措辞：比裸的 AbortError/timeout 更好定位（reason 会进梦境日记）。
    const timedOut = abortController.signal.aborted;
    const reason = timedOut
      ? `consolidation timeout (${timeoutMs}ms)`
      : `consolidation error: ${err?.message ?? String(err)}`;
    log(`consolidation failed: ${reason}`);
    return { ok: false, mode: 'failed', operations: null, reason };
  } finally {
    cancelled = true;
    if (activation && typeof activation.dispose === 'function') {
      try { await activation.dispose(); } catch { /* swallow — already settled */ }
    }
    if (consolidationHandle && typeof consolidationHandle.dispose === 'function') {
      try { await consolidationHandle.dispose(); } catch { /* swallow */ }
    }
    clearTimeout(timer);
  }
}

// ── 分批整合（2026-10-07）─────────────────────────────────────────────
// 起因（实测）：单批把 43 条候选塞给子代理，prompt 体量让 LLM 在
// DEFAULT_TIMEOUT_MS(60s) 内跑不完 → `consolidation timeout (60000ms)`
// → 整批落 heuristic-degraded → sweep 退回「见一条推一条」→ 当晚 76 条里
// 33 条是重复/元标注碎片（占 43%）。**LLM 整合是质量闸门，它一超时就等于
// 闸门敞开** —— 所以要治的是批大小，不是单纯把超时调大。
//
// 为什么是 all-or-nothing：sweep 的校验门要求 operations 与 gated 严格 1:1
// （见 consolidate() 的 length mismatch 分支）。部分批次成功无法表达成合法
// 形状，与其返回一个下游必拒的半成品，不如整批降级并如实报是哪一批出的问题。
//
// 为什么串行：sync 订阅配额 ≤3 是门禁边（见 wireBusSubscriptions 注释），
// 并行 N 个 LLM 调用既抢配额也让失败归因变难。
export const DEFAULT_BATCH_SIZE = 8;

export async function consolidateBatched(opts = {}) {
  const { gated, batchSize = DEFAULT_BATCH_SIZE, logger = null } = opts;
  if (!Array.isArray(gated) || gated.length === 0) {
    return { ok: true, mode: 'not-attempted', operations: null, reason: 'no gated candidates' };
  }
  const size = Math.max(1, Math.floor(batchSize) || DEFAULT_BATCH_SIZE);
  if (gated.length <= size) {
    // 没超批量 ⇒ 走原单批路径，行为与加批之前逐字节一致
    return consolidate(opts);
  }

  const total = Math.ceil(gated.length / size);
  const operations = [];
  const reasonings = [];
  for (let i = 0; i < total; i += 1) {
    const slice = gated.slice(i * size, (i + 1) * size);
    const res = await consolidate({ ...opts, gated: slice });
    if (res?.ok !== true || res?.mode !== 'llm' || !Array.isArray(res.operations)) {
      if (logger?.info) {
        logger.info('agint-dream.consolidation: batch failed', {
          batch: `${i + 1}/${total}`, size: slice.length, reason: res?.reason ?? null,
        });
      }
      return {
        ok: false,
        mode: 'failed',
        operations: null,
        reason: `batch ${i + 1}/${total} failed: ${res?.reason ?? 'unknown'}`,
        diagnostics: res?.diagnostic ? [res.diagnostic] : undefined,
      };
    }
    if (res.operations.length !== slice.length) {
      return {
        ok: false,
        mode: 'failed',
        operations: null,
        reason: `batch ${i + 1}/${total} operations length ${res.operations.length} != ${slice.length}`,
      };
    }
    operations.push(...res.operations);
    if (res.reasoning) reasonings.push(res.reasoning);
  }
  return {
    ok: true,
    mode: 'llm',
    operations,
    reasoning: reasonings.join(' | ').slice(0, 200) || null,
    batches: total,
  };
}
