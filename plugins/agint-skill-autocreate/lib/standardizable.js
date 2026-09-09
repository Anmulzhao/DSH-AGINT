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
export const META_TOOL_PREFIXES = Object.freeze([
  'autocreate_',   // 本插件自身 → 自指
  'evolve_',       // 进化提案
  'dream_',        // 自省
  'curator_',      // 策展
  'mutator_',      // 自改进 → 自指
  'selfModel_',    // 自模型 → 自指
  'memory_',       // 记忆读写 = agent 自身状态
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
 *
 * @returns {{
 *   standardizable: boolean|null,  // true=可标准化 / false=明确否 / null=需人工
 *   confidence: number,
 *   route: 'diagnosis'|'heuristic',
 *   rootCause: string|null,
 *   reason: string,
 *   signals: object,
 * }}
 */
export function judgeStandardizable(pattern, opts = {}) {
  const minSteps = opts.minSteps ?? DEFAULTS.minSteps;
  const minDistinctTools = opts.minDistinctTools ?? DEFAULTS.minDistinctTools;
  const minConfidence = opts.minConfidence ?? DEFAULTS.minConfidence;

  const seq = Array.isArray(pattern?.toolSequence) ? pattern.toolSequence : [];
  const distinctTools = [...new Set(seq)];
  const signals = {
    steps: seq.length,
    distinctTools: distinctTools.length,
    tools: distinctTools,
    paramTokens: paramTokenCount(pattern?.paramSignature),
    hasReadWritePair: hasReadWritePair(seq),
    successRate: Number.isFinite(pattern?.successRate) ? pattern.successRate : null,
    occurrenceCount: pattern?.occurrenceCount ?? null,
    metaTools: metaToolsIn(seq),
  };

  // ── 轨道 A：有失败证据 + diagnosis 可用 → 根因归因 ──
  const failureEvidence = Array.isArray(opts.failureEvidence) ? opts.failureEvidence : null;
  if (failureEvidence && failureEvidence.length > 0 && typeof opts.diagnosis?.classify === 'function') {
    const verdict = routeViaDiagnosis(failureEvidence, signals, opts, minConfidence);
    if (verdict) return verdict;
    // diagnosis 给不出结论 → 落到轨道 B
  }

  // ── 硬否决：低价值形态（顺序即优先级，先命中先返回）──
  if (signals.steps === 0) return verdict(false, 0, 'heuristic', null, VERDICT_REASONS.EMPTY_SEQUENCE, signals, minConfidence);
  if (signals.metaTools.length > 0) return verdict(false, 0, 'heuristic', null, VERDICT_REASONS.META_TOOL, signals, minConfidence);
  if (signals.steps < minSteps) return verdict(false, 0, 'heuristic', null, VERDICT_REASONS.TOO_FEW_STEPS, signals, minConfidence);
  if (signals.distinctTools < minDistinctTools) return verdict(false, 0, 'heuristic', null, VERDICT_REASONS.TRIVIAL_SINGLE_TOOL, signals, minConfidence);
  if (signals.paramTokens === 0) return verdict(false, 0, 'heuristic', null, VERDICT_REASONS.NO_PARAM_STRUCTURE, signals, minConfidence);

  // ── 正向信号打分 → confidence ──
  const score = scoreSignals(signals);
  if (score < minConfidence) {
    return verdict(null, +score.toFixed(4), 'heuristic', null, VERDICT_REASONS.LOW_CONFIDENCE, signals, minConfidence);
  }
  return verdict(true, +score.toFixed(4), 'heuristic', null, VERDICT_REASONS.OK_HEURISTIC, signals, minConfidence);
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
