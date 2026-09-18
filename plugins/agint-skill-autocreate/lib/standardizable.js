/**
 * agint-skill-autocreate: standardizable — 可标准化判断（设计稿 §3.1 [4]）。
 *
 * 背景：本环节在原实现里**整段缺失**——detector 写死的
 * `standardizable: null` / `standardizableConfidence: null` 从未被填充，
 * 链路实际是 [3] 检测 → [5] 提案，[4] 被跳过（2026-09-09 核查发现）。
 * 后果：检测层一旦出活，跨过门槛的模式会**不分良莠直灌**提案生成。
 *
 * ── 对设计稿的一处修正（必须说明，否则后来人会照抄错的路）──────────────
 * 设计稿 §3.1 [4] 原文：「对每个重复模式调用 diagnosis.annotate 判断根因，
 * rootCause ∈ {TOOL_GAP, KNOWLEDGE_GAP, PROMPT_DEFICIENCY} → 可标准化」。
 *
 * 实测 agint-diagnosis v0.6.0 后确认这条路**在语义上不成立**：
 *   1. `classify(trajectory)` 的 6 类特征全是**失败信号**（tool missing /
 *      ENOENT、wiki miss、逻辑矛盾、子任务顺序异常、4xx/5xx、retry）。
 *      而 P0-1 的「重复模式」是**成功执行的工具序列**，喂进去 → 0 命中
 *      → UNCERTAIN → 全部判「不可标准化」。硬套即等于把链路堵死。
 *   2. `counterfactual.simulate()` 需要 `failureId`（必须存在于
 *      failure_pattern 表）+ evolution 服务 + 样本数 ≥ COLD_START_MIN。
 *      重复成功模式没有 failureId，也不在 failure_pattern 里，不适用。
 *   3. 语义也拧着：diagnosis 回答的是「为什么会失败」，而 [4] 要回答的是
 *      「这个流程值不值得固化成技能」。成功率 100% 的稳定重复流程恰恰是
 *      最该标准化的，但它对 diagnosis 而言是「无话可说」。
 *
 * 因此本模块采用**双轨判定**：
 *   - 轨道 A（diagnosis）：仅当 pattern 携带失败证据时启用，用 STANDARDIZABLE_
 *     ROOT_CAUSES 判定「失败是否源于缺标准做法」。当前聚合层不产出失败证据
 *     （aggregator 只落 successRate，errorKind 未聚合），故**默认不激活**，
 *     接口预留（opts.diagnosis）。
 *   - 轨道 B（启发式，默认）：回答「这是不是一个有复用价值的固定流程」。
 *     硬否决先行（低价值形态），再按正向信号打分 → confidence。
 *   - 轨道 C（LLM，2026-09-18 新增，方案见 `issue-drafts/2026-09-18-LLM接入
 *     autocreate-方案.md` §4）：LLM 的判定结果由调用方（index.js）算好后经
 *     `opts.llmVerdict` 传进来 —— **本模块保持纯函数、无 I/O**，才能单测。
 *     分工是互补不是替换：**LLM 判不了的活留给轨道 B，轨道 B 判不了的活交给
 *     LLM**。LLM 缺失/降级时行为与引入前完全一致（默认 off ⟹ 零行为变化）。
 *
 * 纯函数模块，无 I/O，可单测。
 */

import {
  STANDARDIZABLE_ROOT_CAUSES,
  NON_STANDARDIZABLE_ROOT_CAUSES,
} from './schema.js';

// ── 元工具（Agent 自我运维动作）──────────────────────────────────────────
//
// 判定理由：这些工具操作的是 **Agent 自己的状态**（记忆、进化提案、指标、
// 自检统计、技能调用），不是「完成外部任务的步骤」。给「查自己的统计」或
// 「给自己建技能」生成技能会直接踩设计稿 §9.4 的自我评估/自指红线。
// 序列中**任一**工具命中即否决（从严：掺了自我运维的流程不是任务流程）。
// 注意：`memory_` **不**在 META_TOOL_PREFIXES 里——同前缀下 `memory_read` /
// `memory_search` / `memory_stats` 是业务输入环节（与 `read` / `glob` /
// `skillGraph_list_for_prompt` 同性质），不能误伤。`memory_write` /
// `memory_forget_scan` 这类写/删自管理走 META_TOOLS_MEMORY 精确白名单。
export const META_TOOL_PREFIXES = Object.freeze([
  'autocreate_',   // 本插件自身 → 自指
  'evolve_',       // 进化提案
  'dream_',        // 自省
  'curator_',      // 策展
  'mutator_',      // 自改进 → 自指
  'selfModel_',    // 自模型 → 自指
  'eventBus_',     // 总线运维
  'metrics_',      // 指标
  'diagnosis_',    // 归因
  'evolution_',    // 进化记忆
  'abtest_',       // A/B 实验
  'cordis_',       // 插件框架自检
  'population_',   // 种群统计
  'recall_',       // 记忆召回自检
  'quality_',      // 质量自检
  'tool_stats_',   // 工具统计
  'cron_', 'job_', // 调度运维
  'mount_',        // 挂载运维
  'skill',         // 技能调用本身 → 自指（覆盖 skill / skill_list_check）
]);

/**
 * memory_* 工具的精确划分——Sprint 17 重审结果（2026-09-17）：
 *   - 输入类（不拒）：memory_read / memory_search / memory_stats —— 业务输入环节
 *   - 写/删类（拒）：memory_write / memory_forget_scan —— agent 自身状态管理
 * 教训：之前用 `memory_` 前缀一锅端，把"老板跨会话反复做的 pwsh → memory_read"
 * 真实工作流误杀 3 次门槛以上，跨会话聚合（v0.3.5）暴露后才看出来。
 */
export const META_TOOLS_MEMORY = Object.freeze([
  'memory_write',
  'memory_forget_scan',
]);

/**
 * 精确匹配的元工具（**不放宽成前缀**，因为同前缀下有业务动作）。
 *
 * 反例教训（2026-09-09 生产回放）：`rule_` 若做成前缀会把 `rule_check`
 * 一起打成元工具，但 `rule_check` 在本项目里是「查项目规范」——它是**业务
 * 输入环节**，与 `rule_check > pwsh`（先查规范再执行）这类真实流程误伤严重。
 * 真正需要拦的是规则的增删改查自管理（rule_add/rule_lint/rule_audit/
 * rule_list）。
 */
export const META_TOOLS_EXACT = Object.freeze([
  'rule_add', 'rule_lint', 'rule_audit', 'rule_list',
]);

/** 读类工具（用于「有输入」信号） */
const READ_LIKE = /^(read|file_read|glob|grep|search|fetch|wiki_read|wiki_search|web_fetch|web_search|list|get|cat)/i;

/** 写类工具（用于「有输出」信号） */
const WRITE_LIKE = /^(write|edit|file_write|create|update|patch|append|wiki_write|put|set|add|delete|move|rename)/i;

/** 判定结论码（写 audit_log / 周复盘用，机器可读） */
export const VERDICT_REASONS = Object.freeze({
  // 硬否决（明确低价值 → standardizable:false，无需人工）
  EMPTY_SEQUENCE: 'empty_sequence',
  TOO_FEW_STEPS: 'too_few_steps',
  TRIVIAL_SINGLE_TOOL: 'trivial_single_tool',
  META_TOOL: 'meta_tool',
  NO_PARAM_STRUCTURE: 'no_param_structure',
  DIAGNOSIS_NON_STANDARDIZABLE: 'diagnosis_non_standardizable',
  // 软判定（证据不足 → standardizable:null，需人工判断，写周复盘）
  LOW_CONFIDENCE: 'low_confidence',
  DIAGNOSIS_UNCERTAIN: 'diagnosis_uncertain',
  // 通过
  OK_HEURISTIC: 'ok_heuristic',
  OK_DIAGNOSIS: 'ok_diagnosis',
  // ── 轨道 C：LLM 判定（2026-09-18 LLM 接入方案 §4.2）──────────────────
  // 位置恒定在**硬否决之后**：那五条是「结构性事实」，零成本且判得准，
  // 让 LLM 重判等于每条 pattern 白付一次调用。
  OK_LLM: 'ok_llm',                       // LLM 判可标准化
  LLM_REJECT: 'llm_reject',               // LLM 判不可标准化
  LLM_LOW_CONFIDENCE: 'llm_low_confidence', // LLM 给不了把握 → 归「需人工」
  LLM_DEGRADED: 'llm_degraded',           // 调用失败/超时/产出不可用 → 回落轨道 B
});

/** 默认阈值（与 ConfigSchema 保持一致，纯函数默认值便于单测） */
export const DEFAULTS = Object.freeze({
  minSteps: 2,
  minDistinctTools: 2,
  minConfidence: 0.6,
});

// ── 信号提取 ─────────────────────────────────────────────────────────────

/** 序列中命中的元工具（返回工具名数组） */
export function metaToolsIn(toolSequence) {
  const seq = Array.isArray(toolSequence) ? toolSequence : [];
  return [...new Set(seq.filter((t) => isMetaTool(t)))];
}

export function isMetaTool(tool) {
  const t = String(tool ?? '');
  if (!t) return false;
  if (META_TOOLS_EXACT.includes(t)) return true;
  if (META_TOOLS_MEMORY.includes(t)) return true;
  return META_TOOL_PREFIXES.some((p) => t.startsWith(p));
}

/** 参数结构 token 总数（跨工具累加；'none'/'empty' 不计） */
export function paramTokenCount(paramSignature) {
  let n = 0;
  for (const sig of Object.values(paramSignature ?? {})) {
    const s = String(sig ?? '');
    if (!s || s === 'none' || s === 'empty') continue;
    n += s.split('|').filter(Boolean).length;
  }
  return n;
}

function hasReadWritePair(toolSequence) {
  const seq = Array.isArray(toolSequence) ? toolSequence : [];
  return seq.some((t) => READ_LIKE.test(String(t)))
    && seq.some((t) => WRITE_LIKE.test(String(t)));
}

/** 构造判定信号（纯函数；判定与硬否决预筛共用，保证两边看到同一组事实）。 */
function buildSignals(pattern) {
  const seq = Array.isArray(pattern?.toolSequence) ? pattern.toolSequence : [];
  const distinctTools = [...new Set(seq)];
  return {
    steps: seq.length,
    distinctTools: distinctTools.length,
    tools: distinctTools,
    paramTokens: paramTokenCount(pattern?.paramSignature),
    hasReadWritePair: hasReadWritePair(seq),
    successRate: Number.isFinite(pattern?.successRate) ? pattern.successRate : null,
    occurrenceCount: pattern?.occurrenceCount ?? null,
    metaTools: metaToolsIn(seq),
  };
}

/**
 * 五条硬否决（顺序即优先级，先命中先返回）。
 *
 * 为什么单独抽出来：LLM 接入（2026-09-18）要求「只在**过了硬否决**的 pattern
 * 上调用 LLM」——那是花钱的预筛。预筛与判定**必须共用这一份判据**，否则
 * 「预筛说可以调」与「判定说该硬否决」迟早漂移，表现就是「白花一次调用」。
 */
function hardVeto(signals, minSteps, minDistinctTools) {
  if (signals.steps === 0) return VERDICT_REASONS.EMPTY_SEQUENCE;
  if (signals.metaTools.length > 0) return VERDICT_REASONS.META_TOOL;
  if (signals.steps < minSteps) return VERDICT_REASONS.TOO_FEW_STEPS;
  if (signals.distinctTools < minDistinctTools) return VERDICT_REASONS.TRIVIAL_SINGLE_TOOL;
  if (signals.paramTokens === 0) return VERDICT_REASONS.NO_PARAM_STRUCTURE;
  return null;
}

/**
 * 硬否决预筛：命中即返回结论码，未命中返回 null。
 * 调用方（detect 的 LLM 预算门）用它决定「值不值得为这条 pattern 花一次 LLM 调用」。
 * 判据与 `judgeStandardizable` 严格同源（同一份 `hardVeto`），不另写一遍。
 *
 * @param {object} pattern
 * @param {{minSteps?: number, minDistinctTools?: number}} [opts]
 * @returns {string|null} VERDICT_REASONS 里的一条，或 null
 */
export function hardVetoOf(pattern, opts = {}) {
  return hardVeto(
    buildSignals(pattern),
    opts.minSteps ?? DEFAULTS.minSteps,
    opts.minDistinctTools ?? DEFAULTS.minDistinctTools,
  );
}

// ── 主入口 ───────────────────────────────────────────────────────────────

/**
 * 判定一个重复模式是否可标准化。
 *
 * @param {object} pattern  任务模式业务字段（toolSequence/paramSignature/
 *                          successRate/occurrenceCount/description）
 * @param {object} opts
 *   minSteps / minDistinctTools / minConfidence : 阈值
 *   diagnosis : { classify(trajectory) → {rootCause, confidence} } | null
 *   failureEvidence : array | null —— 轨道 A 的输入；无则走轨道 B
 *   llmVerdict  : { standardizable: boolean, confidence: number, rationale?: string } | null
 *                 —— 轨道 C 的输入（调用方调 LLM 后传入；null = 不用 LLM）
 *   llmShadow   : boolean —— true = 只观测不改变结论（把分歧写进
 *                 `signals.llmShadow`），用于 Phase A 灰度取证
 *   llmDegraded : string | null —— LLM 调用失败的 reason；非空时结论跟随轨道 B，
 *                 但 reason 标 `llm_degraded`（K59：降级必须留痕，且要能说清原因）
 *
 * @returns {{
 *   standardizable: boolean|null,  // true=可标准化 / false=明确否 / null=需人工
 *   confidence: number,
 *   route: 'diagnosis'|'heuristic'|'llm',
 *   rootCause: string|null,
 *   reason: string,
 *   signals: object,
 * }}
 */
export function judgeStandardizable(pattern, opts = {}) {
  const minSteps = opts.minSteps ?? DEFAULTS.minSteps;
  const minDistinctTools = opts.minDistinctTools ?? DEFAULTS.minDistinctTools;
  const minConfidence = opts.minConfidence ?? DEFAULTS.minConfidence;

  const signals = buildSignals(pattern);

  // ── 轨道 A：有失败证据 + diagnosis 可用 → 根因归因 ──
  const failureEvidence = Array.isArray(opts.failureEvidence) ? opts.failureEvidence : null;
  if (failureEvidence && failureEvidence.length > 0 && typeof opts.diagnosis?.classify === 'function') {
    const verdict = routeViaDiagnosis(failureEvidence, signals, opts, minConfidence);
    if (verdict) return verdict;
    // diagnosis 给不出结论 → 落到轨道 B
  }

  // ── 硬否决：低价值形态（顺序即优先级，先命中先返回）──
  // 判据在 `hardVeto` 里，与 LLM 预算预筛 `hardVetoOf` 同源。
  const veto = hardVeto(signals, minSteps, minDistinctTools);
  if (veto) return verdict(false, 0, 'heuristic', null, veto, signals, minConfidence);

  // ── 轨道 C：LLM 判定（2026-09-18；只在硬否决之后介入）───────────────────
  // 固定顺序：硬否决(5) → [轨道 A] → [轨道 C] → 轨道 B 打分。
  // 上游（index.js）算出 LLM 结果后经 opts 传入；本函数不自己调模型。
  // 注：轨道 A 的判断在硬否决**之前**（既有行为，本轮不动）；轨道 C 恒在其后。
  const llm = usableLlmVerdict(opts.llmVerdict);
  if (llm) {
    const ruleScore = scoreSignals(signals);
    // 规则侧同尺对照：≥ 阈值 = true，< 阈值 = null（需人工）——与轨道 B 同语义
    const ruleVerdict = ruleScore >= minConfidence ? true : null;
    const agree = ruleVerdict === llm.standardizable;

    if (opts.llmShadow === true) {
      // shadow：**不改任何结论**，只把分歧样本塞进返回值供调用方落 audit。
      // 这是 Phase A 校准 prompt / minConfidence 的唯一依据（方案 §8）。
      signals.llmShadow = {
        ruleVerdict,
        ruleConfidence: +ruleScore.toFixed(4),
        llmVerdict: llm.standardizable,
        llmConfidence: llm.confidence,
        agree,
        rationale: llm.rationale || null,
      };
      // 落到轨道 B 打分（下面照常执行）
    } else {
      signals.ruleConfidence = +ruleScore.toFixed(4);
      signals.llmConfidence = llm.confidence;
      signals.llmRationale = llm.rationale || null;
      // ★ LLM **不享有特权阈值**：即便它说 true，置信度低于 minConfidence 仍归
      //   「需人工」。两侧用同一把尺，分歧才可比（方案 §4.2 关键）。
      if (llm.confidence < minConfidence) {
        return verdict(null, llm.confidence, 'llm', null, VERDICT_REASONS.LLM_LOW_CONFIDENCE, signals, minConfidence);
      }
      return verdict(
        llm.standardizable,
        llm.confidence,
        'llm',
        null,
        llm.standardizable ? VERDICT_REASONS.OK_LLM : VERDICT_REASONS.LLM_REJECT,
        signals,
        minConfidence,
      );
    }
  } else if (typeof opts.llmDegraded === 'string' && opts.llmDegraded) {
    // 调用失败/超时/产出不合规 → 结论**完全跟随轨道 B**（下面照常打分），
    // 但路径必须留痕：K59 的教训是「没有候选」与「429 超限」在日记上长得
    // 一模一样，错误归因因此被固化 12 天。reason 直接标 llm_degraded，
    // 轨道 B 原本的结论挪到 signals.ruleReason（信息不丢）。
    signals.llmDegraded = true;
    signals.llmDegradedReason = opts.llmDegraded;
  }

  // ── 轨道 B：正向信号打分 → confidence（LLM 不可用时的兜底，行为不变）──
  const degraded = signals.llmDegraded === true;
  const score = scoreSignals(signals);
  if (degraded) {
    signals.ruleReason = score < minConfidence
      ? VERDICT_REASONS.LOW_CONFIDENCE
      : VERDICT_REASONS.OK_HEURISTIC;
  }
  if (score < minConfidence) {
    return verdict(null, +score.toFixed(4), 'heuristic', null,
      degraded ? VERDICT_REASONS.LLM_DEGRADED : VERDICT_REASONS.LOW_CONFIDENCE, signals, minConfidence);
  }
  return verdict(true, +score.toFixed(4), 'heuristic', null,
    degraded ? VERDICT_REASONS.LLM_DEGRADED : VERDICT_REASONS.OK_HEURISTIC, signals, minConfidence);
}

/**
 * 校验调用方传来的 LLM 判定（不信任边界输入）。
 * @returns {{standardizable: boolean, confidence: number, rationale: string}|null}
 */
function usableLlmVerdict(v) {
  if (!v || typeof v !== 'object') return null;
  if (typeof v.standardizable !== 'boolean') return null;
  const conf = Number(v.confidence);
  if (!Number.isFinite(conf)) return null;
  return {
    standardizable: v.standardizable,
    confidence: Math.min(1, Math.max(0, conf)),
    rationale: typeof v.rationale === 'string' ? v.rationale : '',
  };
}

/**
 * 正向信号打分（0..1，cap 1）。公式集中在此，便于用 50 模式集校准。
 *   - 工具多样性：≥2 类 0.25 / ≥3 类 0.35（说明是「组合流程」而非单动作）
 *   - 流程长度：≥3 步 +0.15 / ≥5 步 +0.2（有实质步骤可固化）
 *   - 读写配对：有取有存 +0.2（输入→输出的完整流程特征）
 *   - 参数结构：token ≥2 +0.15 / ≥4 +0.25（有稳定入参可定义）
 *   - 成功率：≥0.9 +0.1 / ≥0.7 +0.05（稳定流程才值得固化）
 *   - 出现次数：≥5 +0.1（复用频次佐证）
 */
export function scoreSignals(signals) {
  let s = 0;
  if (signals.distinctTools >= 3) s += 0.35;
  else if (signals.distinctTools >= 2) s += 0.25;

  if (signals.steps >= 5) s += 0.2;
  else if (signals.steps >= 3) s += 0.15;

  if (signals.hasReadWritePair) s += 0.2;

  if (signals.paramTokens >= 4) s += 0.25;
  else if (signals.paramTokens >= 2) s += 0.15;

  if (signals.successRate != null) {
    if (signals.successRate >= 0.9) s += 0.1;
    else if (signals.successRate >= 0.7) s += 0.05;
  }

  if ((signals.occurrenceCount ?? 0) >= 5) s += 0.1;

  return Math.min(1, +s.toFixed(4));
}

function routeViaDiagnosis(failureEvidence, signals, opts, minConfidence) {
  let res;
  try {
    res = opts.diagnosis.classify(failureEvidence);
  } catch {
    return null; // diagnosis 抛错 → 交回轨道 B
  }
  if (!res?.rootCause) return null;

  const rootCause = res.rootCause;
  const conf = Number.isFinite(res.confidence) ? res.confidence : 0;

  if (NON_STANDARDIZABLE_ROOT_CAUSES.includes(rootCause)) {
    // UNCERTAIN 归入「需人工」，其余（推理/规划/环境）明确不可标准化
    if (rootCause === 'UNCERTAIN') {
      return verdict(null, conf, 'diagnosis', rootCause, VERDICT_REASONS.DIAGNOSIS_UNCERTAIN, signals, minConfidence);
    }
    return verdict(false, conf, 'diagnosis', rootCause, VERDICT_REASONS.DIAGNOSIS_NON_STANDARDIZABLE, signals, minConfidence);
  }

  if (STANDARDIZABLE_ROOT_CAUSES.includes(rootCause) && conf >= minConfidence) {
    return verdict(true, conf, 'diagnosis', rootCause, VERDICT_REASONS.OK_DIAGNOSIS, signals, minConfidence);
  }
  // 可标准化根因但置信度不足 → 交回轨道 B 复核（不直接放行）
  return null;
}

function verdict(standardizable, confidence, route, rootCause, reason, signals, minConfidence) {
  return {
    standardizable,
    confidence: +Number(confidence).toFixed(4),
    route,
    rootCause: rootCause ?? null,
    reason,
    threshold: minConfidence,
    signals,
  };
}

export {
  STANDARDIZABLE_ROOT_CAUSES,
  NON_STANDARDIZABLE_ROOT_CAUSES,
};
