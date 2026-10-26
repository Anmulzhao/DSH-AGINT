/**
 * lib/llm-enhance.js — agint-aesthetic-oracle §8.1 LLM 增强档（v3 无降级）。
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
 * ⭐ 无降级政策（2026-10-25 老板令）：
 *   - 输出层一律走 LLM。L1/L2/L3 任一失败 = 本次广播失败，**不回落模板**。
 *   - 失败抛 OracleLlmError，由 index.js 落 error 痕 + 发 oracle.alert + 调度重试。
 *   - 没有 off/l1/l1l2 分档开关；整插件 kill-switch 仍是 AGINT_AESTHETIC_ORACLE=off。
 *   - 内容闸门（NO_ADVICE / 无 auditIds / 无新提案）不是降级：没有内容就不调用，
 *     也不让模型编造。
 *
 * 宿主契约（2026-10-23 根因，2026-10-25 修复）：
 *   现宿主只有 `subagents.startActivation({ provider, label, request, signal, delivery })`，
 *   **没有 `subagents.start`**。旧代码用 `start` 导致四个插件的 LLM 通路全部恒失败，
 *   并谎报 "subagents unavailable"。本模块按新契约调用；旧宿主保留 start 分支。
 *
 * 工程纪律：
 *   - meta.agentPreset 不能省（30 个空壳会话换来的教训）
 *   - agentOptions:{provider,model,reasoningEffort} 不能省（MiniMax 缺 reasoningEffort 会 400）
 *   - 结果在 result.structured，不在 result.output
 *   - 超时双保险：AbortController + Promise.race（provider 不认 signal 时也能返回）
 *   - 模型选择：agentDefaultModel.currentSelection() > 兜底常量（K99 不硬编码）
 */

import { randomUUID } from 'node:crypto';

// ── 模型兜底常量（K99：仅在 agentDefaultModel 服务不可用时使用；不硬编码是原则） ──
const DEFAULT_LLM_PROVIDER = 'minimax-cn';
// 2026-10-25：host 注册模型已是 MiniMax-M3.1-Flash；旧值 -Preview 不可路由。
const DEFAULT_LLM_MODEL = 'MiniMax-M3.1-Flash';
// MiniMax-M3.1-Flash 强制 adaptive thinking；不传档位会退化成 thinking disabled → 400。
const DEFAULT_REASONING_EFFORT = 'high';
const DEFAULT_AGENT_PRESET = 'agint';

// ── 超时（§8.1.6；对齐 dream 的 DEFAULT_TIMEOUT_MS = 60_000） ──
export const L1_TIMEOUT_MS = 60_000;   // L1 措辞增强：2026-10-05 由 10_000 提到 60_000（daily 实测 wall 10.78s/11.09s 连续越线降级）
export const L2_TIMEOUT_MS = 60_000;   // weekly L2 深挖
export const L3_TIMEOUT_MS = 60_000;   // weekly L3 提案润色

/** LLM 通路不可用（服务/方法/provider/调用/超时/结构化输出失败）。
 *  index.js 用 code 识别它，落 error 痕、发告警、交调度重试；**绝不降级**。 */
export class OracleLlmError extends Error {
  constructor(message, { stage = null, cause } = {}) {
    super(stage ? `${stage}: ${message}` : message, { cause });
    this.name = 'OracleLlmError';
    this.code = 'ORACLE_LLM_UNAVAILABLE';
    this.stage = stage;
  }
}

// ── spawnLlm 封装（新宿主 startActivation 契约） ───────────────────────────

/**
 * 调一次 LLM，拿结构化输出。
 *
 * @param {object} ctx cordis ctx
 * @param {object} args
 * @param {string} args.system 系统提示
 * @param {string} args.user   用户提示
 * @param {object} args.schema JSON Schema（subagent outputSchema 方言）
 * @param {number} args.timeoutMs 超时毫秒
 * @param {string} [args.label] 日志标签
 * @returns {Promise<{ok:true,value:any}|{ok:false,reason:string}>}
 *   失败不 throw；调用方（L1/L2/L3）负责抛 OracleLlmError。
 */
export async function spawnOracleLlm(ctx, { system, user, schema, timeoutMs, label = 'oracle-llm' }) {
  const agents = ctx?.get?.('agents');
  const subagents = ctx?.get?.('subagents');
  if (!agents || typeof agents.create !== 'function') {
    return { ok: false, reason: 'agents service missing (create() not callable)' };
  }
  if (!subagents) {
    return { ok: false, reason: 'subagents service missing' };
  }
  const hasActivation = typeof subagents.startActivation === 'function';
  const hasLegacyStart = typeof subagents.start === 'function';
  if (!hasActivation && !hasLegacyStart) {
    return {
      ok: false,
      reason: `subagents method missing (startActivation=${hasActivation}, start=${hasLegacyStart})`,
    };
  }
  if (typeof subagents.getProvider === 'function') {
    let provider = null;
    try {
      provider = subagents.getProvider('spawn');
    } catch (error) {
      return { ok: false, reason: `getProvider('spawn') failed: ${error?.message ?? String(error)}` };
    }
    if (!provider) return { ok: false, reason: 'spawn provider not registered' };
  }

  // 模型路由优先级：agentDefaultModel.currentSelection() > 兜底常量
  let selection = null;
  try {
    selection = typeof ctx?.get === 'function'
      ? ctx.get('agentDefaultModel')?.currentSelection?.() ?? null
      : null;
  } catch { selection = null; }
  const agentOptions = {
    provider: selection?.provider ?? DEFAULT_LLM_PROVIDER,
    model: selection?.model ?? DEFAULT_LLM_MODEL,
    reasoningEffort: selection?.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
  };

  const controller = new AbortController();
  let rejectOnTimeout = null;
  const timeoutGuard = new Promise((_, reject) => { rejectOnTimeout = reject; });
  const timer = setTimeout(() => {
    controller.abort('oracle-llm-timeout');
    rejectOnTimeout?.(new Error(`timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  let handle = null;
  let activation = null;
  let cancelled = false;
  const disposeLate = (resource) => {
    try { Promise.resolve(resource?.dispose?.()).catch(() => { /* ignore */ }); } catch { /* ignore */ }
  };
  try {
    const createPromise = agents.create({
      sessionId: `oracle-llm-${randomUUID()}`,
      // ⭐ agentPreset 不能省（空壳会话血债）
      meta: { cwd: process.cwd(), origin: 'subagent', agentPreset: DEFAULT_AGENT_PRESET },
      // ⭐ agentOptions 是 provider/model/reasoningEffort 的载体
      agentOptions,
      signal: controller.signal,
    }).then((h) => {
      // 超时胜出后 create 仍可能晚到落地 → 由这里补 dispose，避免会话泄漏
      if (cancelled) disposeLate(h);
      return h;
    });
    handle = await Promise.race([createPromise, timeoutGuard]);
    const prompt = [{ type: 'text', text: `${system}\n\n${user}` }];
    const startPromise = (hasActivation
      ? Promise.resolve().then(() => subagents.startActivation({
        provider: 'spawn',
        label,
        request: {
          parent: handle.agent,
          prompt,
          // 子级独立 preset：与 parent 相同，但显式传给 request（新契约）
          agentPreset: DEFAULT_AGENT_PRESET,
          agentOptions,
          outputSchema: schema,
        },
        signal: controller.signal,
        // caller：只回结果，不向父 agent 发完成通知（后台广播不该污染会话）
        delivery: 'caller',
      }))
      : Promise.resolve().then(() => subagents.start('spawn', {
        parent: handle.agent,
        prompt,
        outputSchema: schema,
        signal: controller.signal,
        label,
      }))).then((act) => {
      // 同上：超时胜出后 activation 晚到落地也要 dispose
      if (cancelled) disposeLate(act);
      return act;
    });
    // 超时胜出后 start 仍可能晚到 reject；吞掉它，避免 unhandledRejection。
    startPromise.catch(() => { /* handled by race */ });
    activation = await Promise.race([startPromise, timeoutGuard]);
    const result = await Promise.race([activation.result, timeoutGuard]);
    if (result?.stopReason !== 'completed') {
      const diagnostic = result?.diagnostic ? ` (${result.diagnostic})` : '';
      return { ok: false, reason: `stopReason=${result?.stopReason ?? 'unknown'}${diagnostic}` };
    }
    // ⭐ 结果在 structured，不在 output
    const structured = result?.structured;
    if (structured === undefined || structured === null) {
      return {
        ok: false,
        reason: `structured output missing (stopReason=${result?.stopReason ?? 'unknown'})`,
      };
    }
    return { ok: true, value: structured };
  } catch (error) {
    return { ok: false, reason: `llm error: ${error?.message ?? String(error)}` };
  } finally {
    cancelled = true;
    clearTimeout(timer);
    try { await activation?.dispose?.(); } catch { /* ignore */ }
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
 * 失败抛 OracleLlmError（无降级）。
 *
 * @param {object} ctx
 * @param {object} args
 * @param {string} args.templateAdvice  确定性产出的机械建议文本
 * @param {string} args.templateEvidence 确定性产出的证据文本
 * @param {string} args.worstKey  worst.key（noise/confidence/redundancy/bloat）
 * @param {number} args.value     worst.value（数值）
 * @param {object} [args.extra={}] 额外上下文（metric 中文名等）
 * @returns {Promise<{mode:'llm'|'skipped', advice:string, evidence:string, reason?:string}>}
 *   没有可润色内容时返回 skipped；LLM 失败抛错。
 */
export async function l1EnhanceAdvice(ctx, { templateAdvice, templateEvidence, worstKey, value, extra = {} }) {
  if (!templateAdvice) return { mode: 'skipped', advice: '', evidence: '', reason: 'no advice to enhance' };
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
  if (!r.ok) throw new OracleLlmError(r.reason, { stage: 'L1' });
  const advice = typeof r.value?.advice === 'string' ? r.value.advice.trim() : '';
  const evidence = typeof r.value?.evidence === 'string' ? r.value.evidence.trim() : '';
  if (!advice || !evidence) {
    throw new OracleLlmError('structured output has empty advice/evidence', { stage: 'L1' });
  }
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
 * 没有 auditIds 时返回 skipped（内容闸门，不是降级）；LLM 失败抛错。
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
 * @returns {Promise<{mode:'llm'|'skipped', narrative:string, pattern:string, reason?:string}>}
 */
export async function l2DeepDive(ctx, { worstKey, value, threshold, auditIds = [], adviceCtx = {} }) {
  // 没有 id 清单就没东西可挖——不调用 LLM，也不编造
  if (!Array.isArray(auditIds) || auditIds.length === 0) {
    return { mode: 'skipped', narrative: '', pattern: '', reason: 'no auditIds to deep-dive' };
  }
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
  if (!r.ok) throw new OracleLlmError(r.reason, { stage: 'L2' });
  const narrative = typeof r.value?.narrative === 'string' ? r.value.narrative.trim() : '';
  const pattern = typeof r.value?.pattern === 'string' ? r.value.pattern.trim() : '';
  if (!narrative || !pattern) {
    throw new OracleLlmError('structured output has empty narrative/pattern', { stage: 'L2' });
  }
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
 * 模板正文缺失是内部不变量错误（不能写空提案）；LLM 失败同样抛错。
 *
 * @param {object} ctx
 * @param {object} args
 * @param {string} args.title        模板提案 title
 * @param {string} args.templateBody 模板提案 body
 * @param {object} [args.deepDive={}] L2 深挖结果（{narrative, pattern}）
 * @returns {Promise<{mode:'llm', body:string}>}
 */
export async function l3PolishProposal(ctx, { title, templateBody, deepDive = {} }) {
  if (!templateBody) throw new OracleLlmError('template body missing', { stage: 'L3' });
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
  if (!r.ok) throw new OracleLlmError(r.reason, { stage: 'L3' });
  const body = typeof r.value?.body === 'string' ? r.value.body.trim() : '';
  if (!body) throw new OracleLlmError('structured output has empty body', { stage: 'L3' });
  return { mode: 'llm', body };
}
