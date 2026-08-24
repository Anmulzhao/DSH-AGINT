/**
 * agint-diagnosis / counterfactual-simulator.js
 *
 * 反事实模拟算法（设计稿 wiki/AGINT/sprint-7-设计稿-2026-08.md §二.4）。
 * 子任务 #4 — 接口签名 FROZEN（任务描述 §1）：
 *   counterfactual({ failureId, modifiedStrategy })
 *     → { successRate, divergentSteps }
 *
 * 算法本质：确定性重放 + 启发式估算，不调真 LLM（设计稿 §八 红线）。
 *
 * 三种 modifiedStrategy（任务描述 §1 FROZEN 枚举）：
 *   - 'skip-tool'          移除 TOOL_GAP 相关步骤
 *   - 'use-prev-prompt'    用 agint-memory 拉历史同类成功 prompt 替换当前 prompt 段落
 *   - 'reorder-subtasks'   调换 PLANNING_FAILURE 相关步骤顺序
 *
 * 「反事实成功」定义（任务描述 §1 步骤 5）：
 *   扰动后的 trajectory 不再被 #3 classifier 判为「原 rootCause」→ successRate = 1/3。
 *   UNCERTAIN 兜底（任务描述 §1 + fixture-5）→ successRate = 0.3。
 *
 * 性质（README 明示）：
 *   - 启发式估计 ≠ 真实成功率（设计稿 §二.4 / §五）
 *   - 软门槛：10 条种子任务反事实成功率 ≥50%（设计稿 §三 验收）
 *   - 不调真 LLM（设计稿 §八）
 *
 * 依赖：
 *   - 同插件 #3 classifier（root-cause-classifier.classify）
 *   - 兄弟插件 agint-evolution-memory（queryFailures）拿 failure_pattern
 *   - 兄弟插件 agint-memory（search）拿 prompt 历史（use-prev-prompt 用）
 *
 * 注：trajectory 在 Sprint 7 是 failure_pattern 单条代理（设计稿 §二.6），
 *     所以 input 也允许外部传入 trajectory 入参回退（与 #3 annotate 同模式）。
 */

import { classify as rootCauseClassify } from './root-cause-classifier.js';

// ── 冷启动阈值（与 lib/index.js annotate 守门保持一致） ─────────────────

const COLD_START_MIN = 10;

// ── modifiedStrategy FROZEN 枚举（任务描述 §1） ──────────────────────────

const MODIFIED_STRATEGIES = Object.freeze([
  'skip-tool',
  'use-prev-prompt',
  'reorder-subtasks',
]);

// ── TOOL/PROMPT/PLANNING 三个特征 regex（与 #3 classifier 保持一致） ────

const TOOL_MISSING_RE = /(tool not found|工具不存在|ENOENT|tool.*missing|missing tool|tool_missing|tool not registered)/i;
const PROMPT_RE = /(prompt|提示词|系统提示|system prompt|prompt 版本|prompt version)/i;
const PLAN_DISORDER_RE = /(顺序颠倒|顺序倒置|重复拆|漏拆|拆错|subtask.*order|out of order|reorder|重复子任务|缺失子任务)/i;

// ── 步骤文本拼接（与 #3 classifier 同语义） ──────────────────────────────

function stepText(step) {
  if (step == null) return '';
  if (typeof step === 'string') return step;
  if (typeof step !== 'object') return String(step);
  return [step.pattern ?? '', step.evidence ?? '', step.note ?? '', step.message ?? '', step.tool ?? '']
    .filter(Boolean).join(' \u00b7 ');
}

function isArraySafeTraj(t) {
  return Array.isArray(t);
}

function asTrajectory(entry) {
  // failure_pattern 单条代理 → 包成 1 步序列（与 #3 annotate 同模式）
  if (!entry) return [];
  return [{
    pattern: entry.pattern ?? '',
    evidence: entry.evidence ?? '',
    severity: entry.severity ?? '',
    occurrences: entry.occurrences ?? 1,
    category: entry.category ?? '',
  }];
}

// ── 三种 modifiedStrategy 的扰动实现 ─────────────────────────────────────

/**
 * skip-tool：移除所有被 TOOL_MISSING_RE 命中的步骤。
 * divergentSteps：列出被移除的步骤文本。
 */
function perturbSkipTool(trajectory) {
  if (!isArraySafeTraj(trajectory)) return { trajectory: [], divergentSteps: ['skip-tool: invalid trajectory'] };
  const kept = [];
  const divergent = [];
  for (const step of trajectory) {
    if (TOOL_MISSING_RE.test(stepText(step))) {
      divergent.push(`skip-tool 移除 tool-gap 步骤：${stepText(step).slice(0, 120)}`);
    } else {
      kept.push(step);
    }
  }
  if (divergent.length === 0) {
    divergent.push('skip-tool: trajectory 不含 tool-gap 步骤，扰动未命中');
  }
  return { trajectory: kept, divergentSteps: divergent };
}

/**
 * use-prev-prompt：
 *   1) 删去 PROMPT_RE 命中的步骤。
 *   2) 通过入参 prevPromptLookup 查 agint-memory 找历史 prompt——
 *      找到 → 注入「prev-prompt applied」标记步骤；找不到 → 标记 fallback。
 */
function perturbUsePrevPrompt(trajectory, prevPromptLookup) {
  if (!isArraySafeTraj(trajectory)) return { trajectory: [], divergentSteps: ['use-prev-prompt: invalid trajectory'] };
  const kept = [];
  const divergent = [];
  for (const step of trajectory) {
    if (PROMPT_RE.test(stepText(step))) {
      divergent.push(`use-prev-prompt 替换 prompt 步骤：${stepText(step).slice(0, 120)}`);
    } else {
      kept.push(step);
    }
  }
  let prevApplied = false;
  if (typeof prevPromptLookup === 'function') {
    try {
      const prev = prevPromptLookup();
      if (prev && typeof prev.content === 'string' && prev.content.length > 0) {
        kept.push({ pattern: `use-prev-prompt applied (prev=${prev.content.slice(0, 80)})`, note: 'replaced by previous successful prompt' });
        prevApplied = true;
      }
    } catch (_e) { /* 容错 */ }
  }
  if (!prevApplied) {
    kept.push({ pattern: 'use-prev-prompt: no prev-prompt in memory, fallback to original' });
  }
  if (divergent.length === 0) {
    divergent.push('use-prev-prompt: trajectory 不含 prompt 步骤，扰动未命中');
  }
  return { trajectory: kept, divergentSteps: divergent };
}

/**
 * reorder-subtasks：调换 PLANNING_FAILURE 相关步骤顺序——
 *   取所有 PLAN_DISORDER_RE 命中的步骤，把首尾对调插回原位置。
 */
function perturbReorderSubtasks(trajectory) {
  if (!isArraySafeTraj(trajectory)) return { trajectory: [], divergentSteps: ['reorder-subtasks: invalid trajectory'] };
  const indices = [];
  for (let i = 0; i < trajectory.length; i += 1) {
    if (PLAN_DISORDER_RE.test(stepText(trajectory[i]))) indices.push(i);
  }
  if (indices.length < 2) {
    return {
      trajectory: trajectory.slice(),
      divergentSteps: [
        indices.length === 0
          ? 'reorder-subtasks: trajectory 不含 planning 步骤，扰动未命中'
          : 'reorder-subtasks: planning 步骤不足 2 个，Sprint 7 trajectory 单步代理无足够步骤调换',
      ],
    };
  }
  const reordered = trajectory.slice();
  const first = reordered[indices[0]];
  reordered[indices[0]] = reordered[indices[indices.length - 1]];
  reordered[indices[indices.length - 1]] = first;
  return {
    trajectory: reordered,
    divergentSteps: [`reorder-subtasks 调换步骤 ${indices[0]} <-> ${indices[indices.length - 1]}`],
  };
}

// ── 主算法：单次 simulate ────────────────────────────────────────────────

/**
 * simulate({ failureId, modifiedStrategy, trajectory?, evolution, memory })
 *
 * 异常：
 *   - failureId 缺失 / 不在 failure_pattern → throw
 *   - failure_pattern 样本数 < COLD_START_MIN → throw（cold-start）
 *   - modifiedStrategy 非法 → throw
 */
async function simulate({
  failureId,
  modifiedStrategy,
  trajectory: inputTrajectory = null,
  evolution = null,
  memory = null,
} = {}) {
  if (!failureId || typeof failureId !== 'string') {
    throw new Error('failureId is required');
  }
  if (!MODIFIED_STRATEGIES.includes(modifiedStrategy)) {
    throw new Error(
      `modifiedStrategy 必须是 ${JSON.stringify(MODIFIED_STRATEGIES)} 之一，得到 ${JSON.stringify(modifiedStrategy)}`,
    );
  }
  if (!evolution || typeof evolution.queryFailures !== 'function') {
    throw new Error('evolution service (agint.evolution.queryFailures) 不可用');
  }

  // 1) 拉 failure_pattern 整表（与 #3 annotate 一致：limit 1000）
  const all = await evolution.queryFailures({ limit: 1000 });
  const patternCount = Array.isArray(all) ? all.length : 0;

  // 2) cold-start 守门
  if (patternCount < COLD_START_MIN) {
    throw new Error(
      `cold-start: failure_pattern 样本数 ${patternCount} < ${COLD_START_MIN}，需先喂失败种子`,
    );
  }

  // 3) 按 failureId 找基准 entry（先按 id，再按 pattern 文本兼容）
  const matched = all.filter(
    (rec) => rec && (rec.id === failureId || rec.pattern === failureId),
  );
  if (matched.length === 0) {
    throw new Error(`failureId not found in failure_pattern: ${failureId}`);
  }
  const baselineEntry = matched[0];

  // 4) 构造 trajectory（优先用外部入参，回退 baseline entry 包成单步）
  let baselineTrajectory = inputTrajectory && inputTrajectory.length > 0
    ? inputTrajectory
    : asTrajectory(baselineEntry);
  if (!isArraySafeTraj(baselineTrajectory)) baselineTrajectory = [];

  // 5) 计算原始 rootCause
  const baselineResult = rootCauseClassify(baselineTrajectory);
  const originalRootCause = baselineResult.rootCause;

  // 6) UNCERTAIN 兜底
  if (originalRootCause === 'UNCERTAIN') {
    return {
      successRate: 0.3,
      divergentSteps: [
        `originalRootCause=UNCERTAIN，启发式兜底 successRate=0.3（任务描述 §1 + fixture-5）`,
      ],
    };
  }

  // 7) 按 modifiedStrategy 应用扰动
  let perturbed;
  if (modifiedStrategy === 'skip-tool') {
    perturbed = perturbSkipTool(baselineTrajectory);
  } else if (modifiedStrategy === 'use-prev-prompt') {
    const lookup = memory && typeof memory.search === 'function'
      ? () => {
          const hits = memory.search('prompt success template', { type: 'pattern', limit: 1 });
          if (Array.isArray(hits) && hits.length > 0 && typeof hits[0].content === 'string') {
            return { content: hits[0].content };
          }
          return null;
        }
      : null;
    perturbed = perturbUsePrevPrompt(baselineTrajectory, lookup);
  } else if (modifiedStrategy === 'reorder-subtasks') {
    perturbed = perturbReorderSubtasks(baselineTrajectory);
  } else {
    throw new Error(`unreachable: ${modifiedStrategy}`);
  }

  // 8) 评估扰动后是否还会被判为原 rootCause
  const perturbedResult = rootCauseClassify(perturbed.trajectory);
  const perturbedRootCause = perturbedResult.rootCause;

  // 9) 计算 successRate
  //    - 扰动命中：扰动后 rootCause ≠ 原 rootCause → 反事实成功（+1/3）
  //    - 扰动未命中：扰动后 rootCause 仍 = 原 rootCause → 反事实失败（+0）
  //    - 特殊：扰动后变成 UNCERTAIN → 也算「反事实成功」（既不是原 rootCause）
  let successRate = 0;
  if (perturbedRootCause !== originalRootCause) {
    successRate = 1 / 3;
  }

  return {
    successRate,
    divergentSteps: perturbed.divergentSteps.concat([
      `originalRootCause=${originalRootCause}`,
      `perturbedRootCause=${perturbedRootCause}`,
      `strategy=${modifiedStrategy}`,
    ]),
  };
}

export {
  simulate,
  perturbSkipTool,
  perturbUsePrevPrompt,
  perturbReorderSubtasks,
  MODIFIED_STRATEGIES,
  COLD_START_MIN,
};