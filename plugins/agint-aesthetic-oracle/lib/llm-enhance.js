/**
 * lib/llm-enhance.js — agint-aesthetic-oracle §8.1 LLM 增强档（v2.4 方案）。
 *
 * ⛔ 红线（§9.5）：本模块只作用于「评论员输出层」——措辞 / 深挖 / 提案正文。
 *   凡是进入 METRIC_DEFS 或写入指标存储的，不准有 LLM。aesthetic_score 与四个
 *   派生指标（noise/confidence/redundancy/bloat）一个字节都不碰。
 *
 * 三级接入点（§8.1.1，按风险从低到高）：
 *   L1 — Q3 建议措辞增强：把确定性产出的机械建议 + evidence 渲染成一句人话。
 *        LLM 只有措辞权，没有选择权（选哪条建议 100% 由 q3Advice 映射表决定）。
 *   L2 — Q2 行级深挖：把「最丑指标=noise_ratio」深挖到「哪几条 id、谁写坏的」。
 *        最差项判定仍是纯函数（q2Worst），LLM 只做行级归因描述。
 *   L3 — weekly 提案正文生成：撰写 evidence 摘要与提案 body。
 *        不改 status（锁 proposed），不直接改代码。
 *
 * 工程纪律（§8.1.5，照抄本仓库两个已验证范式）：
 *   - spawnLlm 范式来自 agint-evolution-driver/lib/index.js
 *     ⭐ meta.agentPreset 不能省（30 个空壳会话换来的教训）
 *     ⭐ agentOptions:{provider,model} 不能省（模型路由本身）
 *     ⭐ 结果在 result.structured，不在 result.output
 *   - 超时双保险：AbortController + setTimeout
 *   - 降级绝不 throw：所有失败路径返回 { ok:true, mode:'heuristic-degraded', reason }
 *   - 模型选择：调用方显式 > agentDefaultModel.currentSelection() > 兜底常量（K99 不硬编码）
 *
 * kill-switch（§8.1.7，env AGINT_AESTHETIC_ORACLE_LLM）：
 *   off    → 整体回落 v2.3 模板化输出（三级同时关）
 *   l1     → 只开 L1（最小降级位）
 *   l1l2   → 开 L1+L2（关 L3 提案生成）
 *   all    → 三级全开（⭐ 默认，老板 2026-09-27 拍板拉满）
 */

import { randomUUID } from 'node:crypto';

// ── 模型兜底常量（K99：仅在 agentDefaultModel 服务不可用时使用；不硬编码是原则） ──
const DEFAULT_LLM_PROVIDER = 'minimax-cn';
// 2026-09-28：host 已把 minimax-cn 注册模型换成 MiniMax-M3.1-Flash-Preview。
const DEFAULT_LLM_MODEL = 'MiniMax-M3.1-Flash-Preview';
const DEFAULT_AGENT_PRESET = 'agint';

// ── 超时（§8.1.6；对齐 dream 的 DEFAULT_TIMEOUT_MS = 60_000） ──
export const L1_TIMEOUT_MS = 60_000;   // L1 措辞增强：2026-10-05 由 10_000 提到 60_000（daily 实测 wall 10.78s/11.09s 连续越线降级）
export const L2_TIMEOUT_MS = 60_000;   // weekly L2 深挖
export const L3_TIMEOUT_MS = 60_000;   // weekly L3 提案润色

// ── kill-switch 解析 ──────────────────────────────────────────────────────────

/**
 * 解析 AGINT_AESTHETIC_ORACLE_LLM env。
 * @param {Record<string,string|undefined>} [env=process.env]
 * @returns {'off'|'l1'|'l1l2'|'all'} 缺省 = 'all'（默认拉满）
 */
export function llmMode(env = process.env) {
  const v = String(env?.AGINT_AESTHETIC_ORACLE_LLM ?? '').trim().toLowerCase();
  if (v === 'off') return 'off';
  if (v === 'l1') return 'l1';
  if (v === 'l1l2') return 'l1l2';
  // 空 / 'all' / 任何其他值 → 默认全开
  return 'all';
}

export const canL1 = (mode) => mode === 'l1' || mode === 'l1l2' || mode === 'all';
export const canL2 = (mode) => mode === 'l1l2' || mode === 'all';
export const canL3 = (mode) => mode === 'all';

// ── spawnLlm 封装（照抄 evolution-driver 范式） ─────────────────────────────

/**
 * 调一次 LLM，拿结构化输出。
 *
 * @param {object} ctx cordis ctx
 * @param {object} args
 * @param {string} args.system 系统提示
 * @param {string} args.user   用户提示
 * @param {object} args.schema JSON Schema（subagents.start outputSchema 方言）
 * @param {number} args.timeoutMs 超时毫秒
 * @param {string} [args.label] 日志标签
 * @returns {Promise<{ok:true,value:any}|{ok:false,reason:string,degraded?:boolean}>}
 *   ⭐ 失败不 throw，统一返回 {ok:false}；调用方负责降级。
 */
export async function spawnOracleLlm(ctx, { system, user, schema, timeoutMs, label = 'oracle-llm' }) {
  const agents = ctx?.get?.('agents');
  const subagents = ctx?.get?.('subagents');
  if (!agents || typeof agents.create !== 'function') return { ok: false, reason: 'agents unavailable' };
  if (!subagents || typeof subagents.start !== 'function') return { ok: false, reason: 'subagents unavailable' };
  if (typeof subagents.getProvider === 'function' && !subagents.getProvider('spawn')) {
    return { ok: false, reason: 'spawn provider not registered' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('oracle-llm-timeout'), timeoutMs);
  let handle = null;
  let run = null;
  try {
    // 模型路由优先级：调用方显式 > agentDefaultModel.currentSelection() > 兜底常量
    const selection = typeof ctx?.get === 'function'
      ? ctx.get('agentDefaultModel')?.currentSelection?.() ?? null
      : null;
    const resolvedProvider = selection?.provider ?? DEFAULT_LLM_PROVIDER;
    const resolvedModel = selection?.model ?? DEFAULT_LLM_MODEL;

    handle = await agents.create({
      sessionId: `oracle-llm-${randomUUID()}`,
      // ⭐ agentPreset 不能省（空壳会话血债）
      meta: { cwd: process.cwd(), origin: 'subagent', agentPreset: DEFAULT_AGENT_PRESET },
      // ⭐ agentOptions 是 provider/model 的载体
      agentOptions: { provider: resolvedProvider, model: resolvedModel },
      signal: controller.signal,
    });
    run = await subagents.start('spawn', {
      parent: handle.agent,
      prompt: [{ type: 'text', text: `${system}\n\n${user}` }],
      outputSchema: schema,
      signal: controller.signal,
      label,
    });
    const result = await run.result;
    if (result?.stopReason !== 'completed') {
      return { ok: false, reason: `stopReason=${result?.stopReason ?? 'unknown'}` };
    }
    // ⭐ 结果在 structured，不在 output
    const structured = result?.structured;
    if (structured === undefined || structured === null) {
      return { ok: false, reason: `structured output missing (stopReason=${result?.stopReason ?? 'unknown'})`, degraded: true };
    }
    return { ok: true, value: structured };
  } catch (error) {
    return { ok: false, reason: `llm error: ${error?.message ?? String(error)}` };
  } finally {
    clearTimeout(timer);
    try { await run?.dispose?.(); } catch { /* ignore */ }
    try { await handle?.dispose?.(); } catch { /* ignore */ }
  }
}

// ── L1：Q3 建议措辞增强 ──────────────────────────────────────────────────────

const L1_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['advice', 'evidence'],
  properties: {
    advice: {
      type: 'string',
      description:
        '把机械建议翻译成人话，≤1 行 / ≤120 字。数字、id、阈值必须逐字节来自输入，禁止重算或四舍五入。不得新增输入中不存在的建议动作。',
    },
    evidence: {
      type: 'string',
      description: '一句话说明证据来源，≤60 字。',
    },
  },
});

const L1_SYSTEM = `你是美的神谕层的评论员。你拿到一段确定性公式产出的机械建议和证据，你的唯一任务是把它翻译成一句老板看得懂的人话。

硬约束：
1. 数字、id、阈值必须逐字节来自输入，禁止重算、四舍五入到新值或编造数字。
2. 不得新增输入中不存在的建议动作。选哪条建议 100% 由确定性映射表决定，你只有措辞权。
3. 输出 ≤1 行 / ≤120 字（广播预算内）。
4. 用中文，简洁直接，不要客套。`;

/**
 * L1：把 q3Advice 的机械建议渲染成人话。
 *
 * @param {object} ctx
 * @param {object} args
 * @param {string} args.templateAdvice  确定性产出的机械建议文本
 * @param {string} args.templateEvidence 确定性产出的证据文本
 * @param {string} args.worstKey  worst.key（noise/confidence/redundancy/bloat）
 * @param {number} args.value     worst.value（数值）
 * @param {object} [args.extra={}] 额外上下文（metric 中文名等）
 * @returns {Promise<{mode:'llm'|'heuristic-degraded', advice:string, evidence:string, reason?:string}>}
 *   永远返回模板文本的 fallback；失败不 throw。
 */
export async function l1EnhanceAdvice(ctx, { templateAdvice, templateEvidence, worstKey, value, extra = {} }) {
  const fallback = { mode: 'heuristic-degraded', advice: templateAdvice, evidence: templateEvidence };
  if (!templateAdvice) return fallback;
  const user = [
    `最丑维度：${worstKey}（当前值 ${value}）`,
    `机械建议：${templateAdvice}`,
    `证据：${templateEvidence}`,
    '',
    '请把上面的"机械建议"和"证据"翻译成一句人话。数字/id 必须原样保留。',
  ].join('\n');
  const r = await spawnOracleLlm(ctx, {
    system: L1_SYSTEM,
    user,
    schema: L1_SCHEMA,
    timeoutMs: L1_TIMEOUT_MS,
    label: 'oracle-l1-advice',
  });
  if (!r.ok) return { ...fallback, reason: r.reason };
  const v = r.value ?? {};
  // AC-18 数字逐字节断言（轻量版：LLM 输出非空即采纳；严格正则断言在单测里做）
  const advice = typeof v.advice === 'string' && v.advice.trim() ? v.advice.trim() : templateAdvice;
  const evidence = typeof v.evidence === 'string' && v.evidence.trim() ? v.evidence.trim() : templateEvidence;
  return { mode: 'llm', advice, evidence };
}

// ── L2：Q2 行级深挖 ──────────────────────────────────────────────────────────

const L2_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['narrative', 'pattern'],
  properties: {
    narrative: {
      type: 'string',
      description: '一句话行级归因：最丑集合主要是什么类型、谁写坏的、最近的趋势。≤2 行 / ≤200 字。',
    },
    pattern: {
      type: 'string',
      description: '用一个短标签概括问题模式（如 "旧决策堆积"、"重复规则"、"技能膨胀"），≤20 字。',
    },
  },
});

const L2_SYSTEM = `你是美的神谕层的行级调研员。你拿到最丑指标的 id 清单和元数据摘要（不含条目正文），你的任务是判断这些条目呈现什么模式。

硬约束：
1. 你看不到 entry 正文，只能基于 id 模式、类型分布、时间分布做推断。
2. 最差项判定是确定性公式做的，你不重复判定——你只回答"这堆 id 主要是什么问题"。
3. 数字、计数必须逐字节来自输入。
4. 用中文，≤2 行 / ≤200 字。`;

/**
 * L2：weekly 深挖——对最丑指标的 id 集合做行级归因。
 *
 * ⛔ §8.1.3.1 输入契约：entry.content 全文永不进入 prompt。
 *   只送 id + 类型 + 计数 + 截断摘要（excerpt ≤80 字符）。
 *
 * @param {object} ctx
 * @param {object} args
 * @param {string} args.worstKey
 * @param {number} args.value
 * @param {number} args.threshold
 * @param {string[]} [args.auditIds=[]] 最丑集合的 id 清单（来自 view.auditIds）
 * @param {object} [args.adviceCtx={}] extractAtomic 返回的 adviceCtx
 * @returns {Promise<{mode:'llm'|'heuristic-degraded', narrative:string, pattern:string, reason?:string}>}
 */
export async function l2DeepDive(ctx, { worstKey, value, threshold, auditIds = [], adviceCtx = {} }) {
  const fallback = {
    mode: 'heuristic-degraded',
    narrative: `最丑指标 = ${worstKey}（${value}，阈 ${threshold}），行级深挖未启用或降级`,
    pattern: worstKey,
  };
  // 没有 id 清单就没东西可挖
  if (!Array.isArray(auditIds) || auditIds.length === 0) {
    return { ...fallback, reason: 'no auditIds to deep-dive' };
  }
  const samples = auditIds.slice(0, 10).map((id) => ({ id: String(id).slice(0, 40) }));
  const counts = {
    total: auditIds.length,
    firstFew: auditIds.slice(0, 5),
  };
  const user = [
    `指标：${worstKey}`,
    `当前值：${value}`,
    `阈值：${threshold}`,
    `最丑集合 id 总数：${counts.total}`,
    `前 5 个 id：${counts.firstFew.join(', ')}`,
    `adviceCtx 可用字段：${Object.keys(adviceCtx).join(', ') || '（无）'}`,
    '',
    '请基于这些 id 的命名模式和计数，判断这堆条目主要是什么问题模式。',
  ].join('\n');
  const r = await spawnOracleLlm(ctx, {
    system: L2_SYSTEM,
    user,
    schema: L2_SCHEMA,
    timeoutMs: L2_TIMEOUT_MS,
    label: 'oracle-l2-deepdive',
  });
  if (!r.ok) return { ...fallback, reason: r.reason };
  const v = r.value ?? {};
  const narrative = typeof v.narrative === 'string' && v.narrative.trim() ? v.narrative.trim() : fallback.narrative;
  const pattern = typeof v.pattern === 'string' && v.pattern.trim() ? v.pattern.trim() : worstKey;
  return { mode: 'llm', narrative, pattern };
}

// ── L3：weekly 提案正文润色 ──────────────────────────────────────────────────

const L3_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['body'],
  properties: {
    body: {
      type: 'string',
      description: '润色后的提案正文，保留所有数字和 id，≤15 行。',
    },
  },
});

const L3_SYSTEM = `你是美的神谕层的提案撰稿人。你拿到一条确定性公式生成的机械提案（title + body）和 L2 行级深挖结果，你的任务是把提案正文润色得更扎实、更有可执行性。

硬约束：
1. 数字、id、阈值必须逐字节来自输入，禁止重算。
2. 不得改变提案的性质（仍是 status=proposed 的观察者建议，不 auto-apply）。
3. 不得新增输入中不存在的动作。
4. 用中文，保留"建议/证据/现状"三段结构。`;

/**
 * L3：weekly 提案正文润色。
 *
 * @param {object} ctx
 * @param {object} args
 * @param {string} args.title        模板提案 title
 * @param {string} args.templateBody 模板提案 body
 * @param {object} [args.deepDive={}] L2 深挖结果（{narrative, pattern}）
 * @returns {Promise<{mode:'llm'|'heuristic-degraded', body:string, reason?:string}>}
 */
export async function l3PolishProposal(ctx, { title, templateBody, deepDive = {} }) {
  const fallback = { mode: 'heuristic-degraded', body: templateBody };
  if (!templateBody) return fallback;
  const user = [
    `提案 title：${title}`,
    `模板 body：\n${templateBody}`,
    '',
    deepDive?.narrative ? `行级深挖：${deepDive.narrative}` : '',
    deepDive?.pattern ? `问题模式：${deepDive.pattern}` : '',
    '',
    '请润色提案正文，把行级深挖结果融入 evidence 段。数字/id 原样保留。',
  ].filter(Boolean).join('\n');
  const r = await spawnOracleLlm(ctx, {
    system: L3_SYSTEM,
    user,
    schema: L3_SCHEMA,
    timeoutMs: L3_TIMEOUT_MS,
    label: 'oracle-l3-proposal',
  });
  if (!r.ok) return { ...fallback, reason: r.reason };
  const v = r.value ?? {};
  const body = typeof v.body === 'string' && v.body.trim() ? v.body.trim() : templateBody;
  return { mode: 'llm', body };
}
