/**
 * agint-diagnosis / root-cause-classifier.js
 *
 * 6 类根因判定算法（设计稿 §二.3 「特征投票制」）。
 * 输入 trajectory（步骤序列）→ 输出 { rootCause, confidence, evidence }。
 * 启发式估计，不调真 LLM；纯函数，给 unit test 用。
 */

import { RootCauseKindSchema, ROOT_CAUSE_KINDS } from './schema.js';

const PROMPT_RE = /(prompt|提示词|系统提示|system prompt|prompt 版本|prompt version)/i;
const TOOL_MISSING_RE = /(tool not found|工具不存在|ENOENT|tool.*missing|missing tool|tool_missing|tool not registered)/i;
const WIKI_MEM_MISS_RE = /(wiki.*miss|memory.*miss|cache miss|没有该条目|无该术语|knowledge miss|no entry found|unknown term)/i;
const REASON_CONTRADICTION_RE = /(矛盾|自指|反证|contradiction|self.reference|inconsistent|chain\.consistency=false|逻辑矛盾|自相矛盾)/i;
const PLAN_DISORDER_RE = /(顺序颠倒|顺序倒置|重复拆|漏拆|拆错|subtask.*order|out of order|reorder|重复子任务|缺失子任务)/i;
const ENV_API_ERROR_RE = /(4xx|5xx|http\s*error|status\s*5\d{2}|status\s*4\d{2}|api\s*error|network\s*error|timeout|rate limit|external api)/i;

function stepText(step) {
  if (step == null) return '';
  if (typeof step === 'string') return step;
  if (typeof step !== 'object') return String(step);
  return [step.pattern ?? '', step.evidence ?? '', step.note ?? '', step.message ?? '', step.tool ?? '']
    .filter(Boolean).join(' \u00b7 ');
}

function countStepsWith(trajectory, regex) {
  if (!Array.isArray(trajectory)) return 0;
  let n = 0;
  for (const s of trajectory) if (regex.test(stepText(s))) n += 1;
  return n;
}

function hasStepWith(trajectory, regex) {
  return countStepsWith(trajectory, regex) >= 1;
}

function _classifyPromptDeficiency(trajectory) {
  const matched = [];
  const promptHits = countStepsWith(trajectory, PROMPT_RE);
  if (promptHits >= 2) matched.push(`prompt 段落被引用 ${promptHits} 次`);
  if (hasStepWith(trajectory, /prompt.*(变更|更新|change|upgrade|update|v\d)/i)) {
    matched.push('prompt 版本变更后立即出现失败');
  }
  let repeat = 0;
  if (Array.isArray(trajectory)) {
    for (const s of trajectory) {
      if (s && typeof s === 'object' && Number(s.occurrences) >= 2) repeat += 1;
    }
  }
  if (repeat >= 2) matched.push(`同一 prompt 跨任务反复失败 ${repeat} 次`);
  return { matchedFeatures: matched, confidence: matched.length / 3 };
}

function _classifyToolGap(trajectory) {
  const matched = [];
  const miss = countStepsWith(trajectory, TOOL_MISSING_RE);
  if (miss >= 1) matched.push(`工具缺失日志 ${miss} 条`);
  if (hasStepWith(trajectory, /(ENOENT|tool.*missing|tool_missing)/i)) {
    matched.push('错误信号含 ENOENT / tool.*missing');
  }
  if (hasStepWith(trajectory, /(绕过|跳过该工具|without this tool|skip.*tool|bypass.*tool)/i)
      && hasStepWith(trajectory, /(成功|success|passed|ok)/i)) {
    matched.push('重试绕过该工具即成功');
  }
  return { matchedFeatures: matched, confidence: matched.length / 3 };
}

function _classifyKnowledgeGap(trajectory) {
  const matched = [];
  if (hasStepWith(trajectory, WIKI_MEM_MISS_RE)) matched.push('wiki/memory miss');
  if (hasStepWith(trajectory, /(特定领域|domain term|technical term|专有名词|领域术语)/i)
      && hasStepWith(trajectory, /(无该条目|no entry|not found)/i)) {
    matched.push('领域术语 + memory 无条目');
  }
  if (hasStepWith(trajectory, /(补充 wiki|补 wiki|after.*wiki.*add|wiki.*update.*pass)/i)) {
    matched.push('人工补 wiki 后同任务可过');
  }
  return { matchedFeatures: matched, confidence: matched.length / 3 };
}

function _classifyReasoningError(trajectory) {
  const matched = [];
  if (hasStepWith(trajectory, REASON_CONTRADICTION_RE)) matched.push('推理链含逻辑矛盾');
  const conCount = countStepsWith(trajectory, /(相反结论|矛盾结论|opposite|inconsistent conclusion)/i);
  if (conCount >= 2) matched.push(`同前提推出相反结论 ${conCount} 步`);
  if (hasStepWith(trajectory, /chain\.consistency\s*=\s*false/i)) {
    matched.push('自评 chain.consistency=false');
  }
  return { matchedFeatures: matched, confidence: matched.length / 3 };
}

function _classifyPlanningFailure(trajectory) {
  const matched = [];
  const disorder = countStepsWith(trajectory, PLAN_DISORDER_RE);
  if (disorder >= 1) matched.push(`任务顺序/拆分异常 ${disorder} 次`);
  const redo = countStepsWith(trajectory, /(重做|redo|retry.*same|again)/i);
  const noProg = countStepsWith(trajectory, /(无进展|no progress|stuck|deadlock)/i);
  if (redo >= 2 && noProg >= 1) matched.push(`同目标重做 ${redo} 轮无进展`);
  if (hasStepWith(trajectory, /(重新拆分|replan|replan.*pass|拆分后通过)/i)
      && hasStepWith(trajectory, /(通过|passed|success)/i)) {
    matched.push('重新拆分后一步通过');
  }
  return { matchedFeatures: matched, confidence: matched.length / 3 };
}

function _classifyEnvironmentShift(trajectory) {
  const matched = [];
  const total = Array.isArray(trajectory) && trajectory.length > 0 ? trajectory.length : 1;
  const api4xx5xx = countStepsWith(trajectory, ENV_API_ERROR_RE);
  if (api4xx5xx / total >= 0.3) matched.push(`外部 API 4xx/5xx 占比 ${(api4xx5xx / total * 100).toFixed(0)}%`);
  if (hasStepWith(trajectory, /(外部事件|outage|external event|deploy announcement|status page)/i)) {
    matched.push('时间窗口对齐外部事件');
  }
  if (hasStepWith(trajectory, /(重试|retry)/i)
      && hasStepWith(trajectory, /(幂等|idempotent)/i)
      && hasStepWith(trajectory, /(成功|passed|success)/i)) {
    matched.push('重试+幂等绕过即成功');
  }
  return { matchedFeatures: matched, confidence: matched.length / 3 };
}

const SIX = ['PROMPT_DEFICIENCY', 'TOOL_GAP', 'KNOWLEDGE_GAP', 'REASONING_ERROR', 'PLANNING_FAILURE', 'ENVIRONMENT_SHIFT'];

const CLASSIFIERS = {
  PROMPT_DEFICIENCY: _classifyPromptDeficiency,
  TOOL_GAP: _classifyToolGap,
  KNOWLEDGE_GAP: _classifyKnowledgeGap,
  REASONING_ERROR: _classifyReasoningError,
  PLANNING_FAILURE: _classifyPlanningFailure,
  ENVIRONMENT_SHIFT: _classifyEnvironmentShift,
};

/**
 * 主入口：对 trajectory 跑 6 类特征投票。
 * 规则（设计稿 §二.3）：
 *   - 命中 0 类 → UNCERTAIN
 *   - 全部类命中 <2 特征 → UNCERTAIN (insufficient evidence)
 *   - 命中 ≥2 类（均 ≥2 特征）→ 取字典序前 + evidence.tied 标「并列」
 */
function classify(trajectory) {
  const scores = {};
  const details = {};
  for (const kind of SIX) {
    const r = CLASSIFIERS[kind](trajectory);
    scores[kind] = r.matchedFeatures.length;
    details[kind] = r;
  }
  scores.UNCERTAIN = 0; // 兜底类的命中数永远是 0（schema 完整性需要）

  const maxHits = Math.max(...SIX.map((k) => scores[k]), 0);
  if (maxHits === 0) {
    return { rootCause: 'UNCERTAIN', confidence: 0, evidence: { matchedFeatures: [], scores, note: 'no class matched → UNCERTAIN' } };
  }
  const topKinds = SIX.filter((k) => scores[k] >= 2);
  if (topKinds.length === 0) {
    return { rootCause: 'UNCERTAIN', confidence: 0, evidence: { matchedFeatures: [], scores, note: 'no class reached ≥2 features → UNCERTAIN (insufficient evidence)' } };
  }

  const winner = topKinds.sort()[0];
  const tied = topKinds.length > 1 ? topKinds.filter((k) => k !== winner) : [];
  const confidence = Math.min(details[winner].matchedFeatures.length / 3, 1);
  const evidence = { matchedFeatures: details[winner].matchedFeatures, scores };
  if (tied.length > 0) {
    evidence.tied = tied;
    evidence.note = `并列 ${tied.length} 类，取字典序前 ${winner}`;
  }

  const parsed = RootCauseKindSchema.safeParse(winner);
  if (!parsed.success) {
    return { rootCause: 'UNCERTAIN', confidence: 0, evidence: { matchedFeatures: [], scores, note: 'internal: winner not in enum' } };
  }
  return { rootCause: parsed.data, confidence, evidence };
}

export {
  classify,
  _classifyPromptDeficiency,
  _classifyToolGap,
  _classifyKnowledgeGap,
  _classifyReasoningError,
  _classifyPlanningFailure,
  _classifyEnvironmentShift,
  ROOT_CAUSE_KINDS,
};