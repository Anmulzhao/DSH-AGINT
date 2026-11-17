/**
 * agint-curriculum: replay-llm —— 方案 3「LLM 语义判据」实现（提案 10d2d87f，选项 2 拍板 2026-11-18）。
 *
 * ⚠️ 架构声明（必须随代码保留）：
 *   项目纲领 §9.5「评分链路永久零 LLM」。本模块由用户**明确知情拍板**启用：
 *   选项描述已写明「明确违反纲领 §9.5，属于架构级变更，由你承担决策」。
 *   本模块只做**复读附加信号**（判定「换说法填两遍」这种确定性指纹抓不到的场景），
 *   不产生分数、不改 verdict 的 pass/fail、不写任何评分字段。
 *
 * ── 与确定性护栏的关系（提案原话「附加信号而非替换」）──────────────────
 *   - replay.js（方案 1/4）是核心护栏：原样复读 + 同题面逐字重复，零误杀。
 *   - 本模块补的是它的盲区：同义改写 / 换说法复读（字面不同、语义相同）。
 *   - 调用策略：只在确定性**未命中**时才调 LLM（已命中就没必要再花钱）；
 *     LLM 判等价 ⇒ 升级为 replay（不计能力成功）；判不等价 / 不可用 / 超时 ⇒ 保持确定性结论。
 *
 * ── 失败降级（与 aesthetic-oracle「无降级」刻意不同）──────────────────
 *   课程 submit 是工具同步调用，判定链路必须守住可用性：
 *   服务缺失 / 超时 / stopReason!=completed / structured 缺失 / 异常 ⇒ 一律 { ok:false }，
 *   由 index.js 忽略并保持确定性判定，**绝不阻塞提交、绝不抛到 agent**。
 *
 * ── 宿主调用契约（照抄 aesthetic-oracle/lib/llm-enhance.js，2026-11-18 实测形态）──
 *   - ctx.get('agents') / ctx.get('subagents') 软获取，不进 inject（manifest optionalInject 声明）
 *   - agents.create 必带 meta.agentPreset（空壳会话血债）+ agentOptions（provider/model/reasoningEffort）
 *   - subagents.startActivation 顶层摊平 prompt/parent/agentPreset/agentOptions/outputSchema
 *     （dsh 0.2.2-rc.1 起不接受嵌套 request）
 *   - 结果在 result.structured，不在 result.output
 *   - 双超时：AbortController + Promise.race；finally dispose 防会话泄漏
 *   - outputSchema 只用宿主受限子集：type(单值)/properties/required/additionalProperties/enum
 *     ⛔ 不用 minimum/maximum/pattern/maxLength（宿主 enforced 子集不支持 → 创建子 agent 前就抛）
 */

import { randomUUID } from 'node:crypto';

// ── 模型兜底常量（agentDefaultModel.currentSelection() 不可用时使用）──────
const DEFAULT_LLM_PROVIDER = 'minimax-cn';
const DEFAULT_LLM_MODEL = 'MiniMax-M3.1-Flash';
const DEFAULT_REASONING_EFFORT = 'high';
const DEFAULT_AGENT_PRESET = 'agint';

/** submit 是同步工具调用，超时设短一些；可用 config.replay_llm_timeout_ms 覆盖 */
export const REPLAY_LLM_TIMEOUT_MS = 30_000;
/** 默认置信度门槛：只有 high 才升级为 replay（保守，避免 LLM 误判误杀） */
export const REPLAY_LLM_MIN_CONFIDENCE = 'high';
/** prompt 里最多带几条历史 pass（预算控制） */
export const MAX_HISTORY_IN_PROMPT = 5;

const CONFIDENCE_RANK = Object.freeze({ low: 1, medium: 2, high: 3 });

/**
 * 输出 schema —— 只用宿主受限子集。
 * 置信度用 enum 字符串而非 number+minimum（后者会触发 JsonSchemaError）。
 */
export const REPLAY_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['isEquivalent', 'confidence', 'rationale', 'matchedIndex'],
  properties: {
    isEquivalent: {
      type: 'boolean',
      description: '本次作答与某条历史通过记录是否语义等价（换说法复读）',
    },
    confidence: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description: '对该判断的把握：low/medium/high',
    },
    rationale: {
      type: 'string',
      description: '一句话理由（≤120字），说明为何等价或为何是不同解法',
    },
    matchedIndex: {
      type: 'string',
      enum: ['1', '2', '3', '4', '5', 'none'],
      description: '若等价，指出与第几条历史记录最相似（从1开始）；否则填 none',
    },
  },
});

const SYSTEM_PROMPT = `你是 AGINT 自主课程的学习证据审查员。你的唯一任务：判断「本次作答」与「历史通过记录」是否语义等价的重复作答（换说法复读）。

严格口径：
1. 只看语义，不看字面。两次作答若给出同一套步骤 / 同一结论 / 同一解法，只是措辞、顺序微调、加了解释词 ⇒ isEquivalent=true。
2. 若两次针对不同题面、或步骤有实质差异（不同方法、不同工具、不同关键动作）⇒ isEquivalent=false。
3. 拿不准时倾向 false（宁可放过，不可误杀）——误判会剥夺一次真实学习成果。
4. 数字、id、命令必须逐字来自输入，禁止编造或重算。
5. rationale 用中文，≤120 字。`;

/**
 * 组装 prompt（纯函数，便于单测）。
 * @returns {{system:string, user:string, history:Array}}
 */
export function buildReplayPrompt({ challenge, evidence, priorPasses = [] } = {}) {
  const history = (Array.isArray(priorPasses) ? priorPasses : []).slice(-MAX_HISTORY_IN_PROMPT);
  const steps = Array.isArray(evidence?.steps) ? evidence.steps : [];
  const lines = [
    `【当前题面】${challenge?.prompt ?? '(未提供)'}`,
    `【当前作答步骤】`,
    ...(steps.length ? steps.map((s, i) => `${i + 1}. ${String(s).slice(0, 400)}`) : ['(无步骤)']),
    '',
    `【历史通过记录】共 ${history.length} 条（编号从 1 开始）：`,
  ];
  history.forEach((p, i) => {
    const hs = Array.isArray(p.evidence?.steps) ? p.evidence.steps : [];
    lines.push(`${i + 1}. 题面：${String(p.prompt ?? '(未提供)').slice(0, 300)}`);
    lines.push(`   步骤：${hs.map((s) => String(s).slice(0, 200)).join(' | ').slice(0, 600) || '(无步骤)'}`);
  });
  lines.push('', '请判断本次作答是否与上面某条历史记录语义等价。按输出 schema 回答。');
  return { system: SYSTEM_PROMPT, user: lines.join('\n'), history };
}

/**
 * 调一次 LLM 拿结构化输出。失败不 throw。
 * @returns {Promise<{ok:true,value:any}|{ok:false,reason:string}>}
 */
export async function spawnReplayLlm(ctx, { system, user, timeoutMs = REPLAY_LLM_TIMEOUT_MS, label = 'curriculum-replay' } = {}) {
  const agents = ctx?.get?.('agents');
  const subagents = ctx?.get?.('subagents');
  if (!agents || typeof agents.create !== 'function') {
    return { ok: false, reason: 'agents service missing (create() not callable)' };
  }
  if (!subagents) return { ok: false, reason: 'subagents service missing' };
  const hasActivation = typeof subagents.startActivation === 'function';
  const hasLegacyStart = typeof subagents.start === 'function';
  if (!hasActivation && !hasLegacyStart) {
    return { ok: false, reason: `subagents method missing (startActivation=${hasActivation}, start=${hasLegacyStart})` };
  }
  if (typeof subagents.getProvider === 'function') {
    let provider = null;
    try { provider = subagents.getProvider('spawn'); } catch (e) {
      return { ok: false, reason: `getProvider('spawn') failed: ${e?.message ?? String(e)}` };
    }
    if (!provider) return { ok: false, reason: 'spawn provider not registered' };
  }

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
    controller.abort('curriculum-replay-timeout');
    rejectOnTimeout?.(new Error(`timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  let handle = null;
  let activation = null;
  let cancelled = false;
  const disposeLate = (resource) => {
    try { Promise.resolve(resource?.dispose?.()).catch(() => {}); } catch { /* ignore */ }
  };
  try {
    const createPromise = agents.create({
      sessionId: `curriculum-replay-${randomUUID()}`,
      meta: { cwd: process.cwd(), agentPreset: DEFAULT_AGENT_PRESET },
      agentOptions,
      signal: controller.signal,
    }).then((h) => { if (cancelled) disposeLate(h); return h; });
    handle = await Promise.race([createPromise, timeoutGuard]);

    const prompt = [{ type: 'text', text: `${system}\n\n${user}` }];
    const startPromise = (hasActivation
      ? Promise.resolve().then(() => subagents.startActivation({
        provider: 'spawn',
        label,
        parent: handle.agent,
        prompt,
        agentPreset: DEFAULT_AGENT_PRESET,
        agentOptions,
        outputSchema: REPLAY_OUTPUT_SCHEMA,
        signal: controller.signal,
        delivery: 'caller',
      }))
      : Promise.resolve().then(() => subagents.start('spawn', {
        parent: handle.agent,
        prompt,
        outputSchema: REPLAY_OUTPUT_SCHEMA,
        signal: controller.signal,
        label,
      }))).then((act) => { if (cancelled) disposeLate(act); return act; });
    startPromise.catch(() => { /* handled by race */ });
    activation = await Promise.race([startPromise, timeoutGuard]);
    const result = await Promise.race([activation.result, timeoutGuard]);
    if (result?.stopReason !== 'completed') {
      const diagnostic = result?.diagnostic ? ` (${result.diagnostic})` : '';
      return { ok: false, reason: `stopReason=${result?.stopReason ?? 'unknown'}${diagnostic}` };
    }
    const structured = result?.structured;
    if (structured === undefined || structured === null) {
      return { ok: false, reason: `structured output missing (stopReason=${result?.stopReason})` };
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

/**
 * 归一化 LLM 结构化输出 → 判定信号（纯函数）。
 * @returns {{accepted:boolean,isReplay:boolean,confidence:string,rationale:string,matchedIndex:string|null,reason?:string}}
 */
export function normalizeLlmVerdict(value, minConfidence = REPLAY_LLM_MIN_CONFIDENCE) {
  if (!value || typeof value !== 'object') {
    return { accepted: false, isReplay: false, confidence: 'low', rationale: '', matchedIndex: null, reason: 'empty structured output' };
  }
  const isEquivalent = value.isEquivalent === true;
  const confidence = CONFIDENCE_RANK[value.confidence] ? value.confidence : 'low';
  const rationale = typeof value.rationale === 'string' ? value.rationale.slice(0, 400) : '';
  const matchedIndex = typeof value.matchedIndex === 'string' && /^[1-5]$/.test(value.matchedIndex)
    ? value.matchedIndex
    : null;
  const accepted = (CONFIDENCE_RANK[confidence] ?? 0) >= (CONFIDENCE_RANK[minConfidence] ?? 3);
  return {
    accepted,
    isReplay: accepted && isEquivalent,
    confidence,
    rationale,
    matchedIndex: isEquivalent ? matchedIndex : null,
    ...(accepted ? {} : { reason: `confidence ${confidence} < ${minConfidence}` }),
  };
}

/**
 * 主入口：对一次 pass 做 LLM 复读判据。永不抛。
 *
 * @param {object} ctx cordis ctx
 * @param {object} args { challenge, evidence, priorPasses, config }
 * @returns {Promise<object>} { called, ok, isReplay, confidence, rationale, matchedAttemptId, reason }
 */
export async function judgeReplayWithLlm(ctx, { challenge, evidence, priorPasses = [], config = {} } = {}) {
  const {
    enabled = true,
    timeoutMs = REPLAY_LLM_TIMEOUT_MS,
    minConfidence = REPLAY_LLM_MIN_CONFIDENCE,
  } = config;
  const base = { called: false, ok: false, isReplay: false, confidence: null, rationale: '', matchedAttemptId: null, reason: null };
  if (!enabled) return { ...base, reason: 'disabled' };

  const { system, user, history } = buildReplayPrompt({ challenge, evidence, priorPasses });
  const spawned = await spawnReplayLlm(ctx, { system, user, timeoutMs });
  const called = true;
  if (!spawned.ok) return { ...base, called, reason: spawned.reason };

  const normalized = normalizeLlmVerdict(spawned.value, minConfidence);
  let matchedAttemptId = null;
  if (normalized.isReplay && normalized.matchedIndex) {
    const idx = Number(normalized.matchedIndex) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < history.length) {
      matchedAttemptId = history[idx].id ?? history[idx].challengeId ?? null;
    }
  }
  return {
    called,
    ok: true,
    isReplay: normalized.isReplay,
    confidence: normalized.confidence,
    rationale: normalized.rationale,
    matchedAttemptId,
    reason: normalized.reason ?? null,
  };
}
