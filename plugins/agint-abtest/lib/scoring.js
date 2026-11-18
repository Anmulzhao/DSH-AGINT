/**
 * agint-abtest lib/scoring.js v0.7.0 — 三层打分模块（方案 v2.1 §六）
 *
 *   L1-check  scoreChecks / runArtifactChecks —— 检查器通过率（合规底线）
 *   L1-exec   scoreExec —— 复用 curriculum verdict.judge 的 verifySpec 断言
 *   L2        judgeArtifact —— pointwise 绝对打分，盲评，新输出契约
 *   L3        calibrationAgreement —— judge/人工一致率（校准，非常规打分）
 *
 * 纪律：
 *   - 任何一层拿不到分数 → { ok:false, reason }，不伪造分数（方案 §六.5）。
 *   - L2 复用 llm-verdict 管道层（resolveLlmSelection），不复用其 skill verdict 契约。
 *   - judge 子会话必须传 meta.agentPreset（K114 空壳会话教训），且由 caller 指定
 *     与执行者不同的 preset —— 本模块不给默认值，缺省即 fail-closed。
 *   - 无 temperature 参数（agentOptions 不支持）；复现性口径见方案 §四.5。
 */

import { randomUUID } from 'node:crypto';
import { judge as curriculumJudge } from '../../agint-curriculum/lib/verdict.js';
import { resolveLlmSelection } from '../../agint-skill-autocreate/lib/llm-verdict.js';

// ── L1-check ───────────────────────────────────────────────────────────

/** 检查器结果 → 通过率。results: [{ name, ok }] */
export function scoreChecks(results) {
  const rs = Array.isArray(results) ? results : [];
  if (rs.length === 0) return { ok: false, reason: 'no checks run（空检查集不打分）' };
  const passed = rs.filter((r) => r.ok === true).length;
  return { ok: true, score: passed / rs.length, passed, total: rs.length, results: rs };
}

/**
 * 跑一组检查器桥接。checks: [{ name, run({artifactDir}) → {ok} | boolean }]。
 * 单个检查器抛错记 fail 不中断（检查器崩溃不是工件合规的证据）。
 */
export async function runArtifactChecks({ artifactDir, checks }) {
  const cs = Array.isArray(checks) ? checks : [];
  const results = [];
  for (const c of cs) {
    try {
      const out = await c.run({ artifactDir });
      results.push({ name: c.name, ok: out === true || out?.ok === true });
    } catch (err) {
      results.push({ name: c.name, ok: false, error: err?.message ?? String(err) });
    }
  }
  return scoreChecks(results);
}

// ── L1-exec ────────────────────────────────────────────────────────────

/** verifySpec 断言打分（复用 curriculum 判定器，形状同源）。pass→1，fail→0。
 *  扩展类型 expected-failure：输出必须含全部 expected 信号，exitCode 可选校验。
 *  用于阴性对照（预期脚本对坏输入报特定错误）与区分度断言（新版新增的输出信号）。
 *  curriculum 原生断言器只认 exitCode=0，覆盖不了这两类，故在此扩展。 */
export function scoreExec({ verifySpec, evidence }) {
  if (!verifySpec || !verifySpec.type) {
    return { ok: false, reason: 'verifySpec 缺失（无执行判据不打分）' };
  }
  if (verifySpec.type === 'expected-failure') {
    const ev = evidence ?? {};
    const out = typeof ev.output === 'string' ? ev.output : '';
    if (verifySpec.exitCode != null && ev.exitCode !== verifySpec.exitCode) {
      return { ok: true, score: 0, reason: `exitCode=${ev.exitCode}，期望 ${verifySpec.exitCode}` };
    }
    for (const signal of verifySpec.expected ?? []) {
      if (!out.includes(String(signal))) {
        return { ok: true, score: 0, reason: `output 缺少必需信号「${signal}」` };
      }
    }
    return { ok: true, score: 1, reason: '输出含全部必需信号' };
  }
  const verdict = curriculumJudge({ verifySpec }, evidence ?? {});
  return { ok: true, score: verdict.result === 'pass' ? 1 : 0, reason: verdict.reason, invalidation: verdict.invalidation ?? null };
}

// ── L2 pointwise judge ─────────────────────────────────────────────────

const JUDGE_SYSTEM_PROMPT = [
  '你是一个独立评审。对给定工件按固定 rubric 逐维度打分。',
  '规则：',
  '1. 只评工件本身的质量，不猜测作者、来源或版本。',
  '2. 每个维度独立打 0 到 1 的分数（0=完全不符合，1=完全符合）。',
  '3. 不比较其他工件，不做相对排序——这是绝对打分。',
  '4. 输出结构化 JSON：scores（每维度一个数）+ reason（一句话总评）。',
].join('\n');

/** 构造盲评 prompt。不含 A/B 标签、变体来源、实验上下文。 */
export function buildJudgePrompt({ artifactText, rubric }) {
  const dims = (rubric?.dims ?? []).map((d) => `- ${d}`).join('\n');
  return [
    '## 评分维度（固定 rubric）',
    dims,
    '',
    '## 待评工件',
    '<<<ARTIFACT',
    String(artifactText ?? ''),
    'ARTIFACT>>>',
    '',
    '请按维度输出 scores 与 reason。',
    '重要：这是封闭卷面评分。不要调用任何工具，不要读文件、不要探索环境，直接输出结构化结果。',
  ].join('\n');
}

/** 归一化 structured 输出：每维度必须有有限数值，夹 0..1；缺维度/非法 → null。 */
export function normalizeJudgeScores(structured, rubric) {
  const dims = rubric?.dims ?? [];
  if (!dims.length || !structured || typeof structured !== 'object') return null;
  const raw = structured.scores;
  if (!raw || typeof raw !== 'object') return null;
  const scores = {};
  for (const d of dims) {
    const v = raw[d];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    scores[d] = Math.min(1, Math.max(0, v));
  }
  const mean = dims.reduce((s, d) => s + scores[d], 0) / dims.length;
  return { scores, score: mean, reason: typeof structured.reason === 'string' ? structured.reason.slice(0, 500) : '' };
}

/**
 * L2 主入口。永不抛错：异常转 { ok:false, mode:'failed', reason, attempted }。
 * attempted = 是否真的发起了子 agent（预算记账依据，照 llm-verdict 口径）。
 *
 * @param {object} args
 * @param {object} args.ctx cordis host ctx
 * @param {string} args.artifactText 工件全文（盲评：caller 负责抹掉标签）
 * @param {object} args.rubric { dims: string[] }（固定，不随任务变）
 * @param {string} args.agentPreset 必填，与执行者不同（K114 + 自我偏好隔离）
 */
export async function judgeArtifact({
  ctx, artifactText, rubric, agentPreset,
  provider = '', model = '', reasoningEffort = '',
  timeoutMs = 300_000, signal = null,
} = {}) {
  const selection = resolveLlmSelection(ctx ?? {}, { provider, model, reasoningEffort });
  const meta = () => ({ provider: selection.provider, model: selection.model });
  const failed = (reason, attempted = false) => ({ ok: false, mode: 'failed', reason, attempted, meta: meta() });

  if (!agentPreset) return failed('agentPreset 必填（K114：缺失 ⇒ 空壳会话）');
  if (!rubric?.dims?.length) return failed('rubric.dims 为空');
  if (!ctx || typeof ctx.get !== 'function') return failed('ctx unavailable');
  const agents = ctx.get('agents');
  const subagents = ctx.get('subagents');
  if (!agents || typeof agents.create !== 'function') return failed('agents service unavailable');
  if (!subagents) return failed('subagents service unavailable');
  const hasActivation = typeof subagents.startActivation === 'function';
  const hasLegacyStart = typeof subagents.start === 'function';
  if (!hasActivation && !hasLegacyStart) return failed('subagents method missing');
  if (signal?.aborted) return failed('aborted before start');

  // 超时双保险（照 llm-verdict / dream，K49）：abort + timeoutGuard。
  const abortController = new AbortController();
  const onExternalAbort = () => abortController.abort('abtest-judge-external-abort');
  if (signal && typeof signal.addEventListener === 'function') {
    signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  let rejectOnTimeout = null;
  const timeoutGuard = new Promise((_, reject) => { rejectOnTimeout = reject; });
  const timer = setTimeout(() => {
    abortController.abort('abtest-judge-timeout');
    rejectOnTimeout?.(new Error(`abtest judge timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  // 输出 schema 按 rubric 维度动态生成（宿主受限子集内：object/number/string/required）
  const outputSchema = {
    type: 'object',
    properties: {
      scores: {
        type: 'object',
        properties: Object.fromEntries(rubric.dims.map((d) => [d, { type: 'number' }])),
        required: rubric.dims,
      },
      reason: { type: 'string' },
    },
    required: ['scores'],
  };

  let handle = null;
  let activation = null;
  let spawned = false;
  let cancelled = false;
  const disposeLate = (resource) => {
    try { Promise.resolve(resource?.dispose?.()).catch(() => {}); } catch { /* ignore */ }
  };
  try {
    const agentOptions = {
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
    };
    const createPromise = agents.create({
      sessionId: `abtest-judge-${randomUUID()}`,
      meta: { cwd: process.cwd(), agentPreset },
      agentOptions,
      signal: abortController.signal,
    }).then((h) => { if (cancelled) disposeLate(h); return h; });
    handle = await Promise.race([createPromise, timeoutGuard]);

    const prompt = [{ type: 'text', text: `${JUDGE_SYSTEM_PROMPT}\n\n${buildJudgePrompt({ artifactText, rubric })}` }];
    // spec 顶层摊平（宿主 0.2.2-rc.1 起不接受嵌套 request，照 llm-verdict 注释）
    const startPromise = (hasActivation
      ? Promise.resolve().then(() => subagents.startActivation({
        provider: 'spawn',
        label: 'agint-abtest pointwise judge',
        parent: handle.agent,
        prompt,
        agentPreset,
        agentOptions,
        outputSchema,
        signal: abortController.signal,
        delivery: 'caller',
      }))
      : Promise.resolve().then(() => subagents.start('spawn', {
        parent: handle.agent,
        prompt,
        outputSchema,
        signal: abortController.signal,
        label: 'agint-abtest pointwise judge',
      }))).then((act) => { if (cancelled) disposeLate(act); return act; });
    startPromise.catch(() => { /* handled by race */ });
    activation = await Promise.race([startPromise, timeoutGuard]);
    spawned = true;

    const result = await Promise.race([activation.result, timeoutGuard]);
    if (result?.stopReason !== 'completed') {
      return failed(`LLM stopReason=${result?.stopReason ?? 'unknown'}`, true);
    }
    const normalized = normalizeJudgeScores(result.structured, rubric);
    if (!normalized) {
      return failed('structured output invalid（维度分缺失或非法）', true);
    }
    return { ok: true, mode: 'llm', ...normalized, attempted: true, meta: meta() };
  } catch (err) {
    const reason = abortController.signal.aborted
      ? `abtest judge timeout (${timeoutMs}ms)`
      : `abtest judge error: ${err?.message ?? String(err)}`;
    return failed(reason, spawned);
  } finally {
    cancelled = true;
    if (activation && typeof activation.dispose === 'function') {
      try { await activation.dispose(); } catch { /* already settled */ }
    }
    if (handle && typeof handle.dispose === 'function') {
      try { await handle.dispose(); } catch { /* swallow */ }
    }
    clearTimeout(timer);
    if (signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onExternalAbort);
    }
  }
}

// ── L3 校准 ────────────────────────────────────────────────────────────

/**
 * judge/人工一致率。|judge−human| ≤ tol 记一致。
 * agreement < threshold → disableRecommended=true（方案 §六.4：关 abtestJudge.enabled）。
 */
export function calibrationAgreement(pairs, { tol = 0.15, threshold = 0.7 } = {}) {
  const ps = Array.isArray(pairs) ? pairs.filter((p) => Number.isFinite(p?.judge) && Number.isFinite(p?.human)) : [];
  if (ps.length === 0) return { ok: false, reason: '无校准样本' };
  const agree = ps.filter((p) => Math.abs(p.judge - p.human) <= tol).length;
  const agreement = agree / ps.length;
  const mae = ps.reduce((s, p) => s + Math.abs(p.judge - p.human), 0) / ps.length;
  return { ok: true, n: ps.length, agreement, mae, disableRecommended: agreement < threshold };
}