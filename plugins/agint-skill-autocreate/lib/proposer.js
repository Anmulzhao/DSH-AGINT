/**
 * agint-skill-autocreate: proposer — 技能候选提案生成（设计稿 §3.1 [5]）。
 *
 * 输入：检测到的重复 pattern（业务字段）。
 * 输出：skillDraft（SKILL.md 草稿）+ estimatedBenefit（启发式预估）。
 *
 * 红线：
 *   - 自我评估禁止（设计稿 §9.4）：名/描述含自我指涉关键词 → 返回 null。
 *   - 纯模板填充、零 LLM 调用（开放问题 §14.1 选了 B「模板+LLM 润色」，
 *     但 Sprint 14 交付纯模板版；LLM 润色在 Phase 1 之前由独立环节做，
 *     不阻塞本模块）。
 *   - 预估收益是启发式（D-QAF Phase 2/3 才量实测），公式在此集中注释，
 *     Sprint 15 接入实测后回填校准。
 */

import { selectTemplate, renderBody, extractTriggers, hasConcreteValue } from './templates.js';
import { isSelfReferential } from './schema.js';
import { renderSemanticSections } from './semantic-window.js';

/**
 * pattern → { skillDraft, estimatedBenefit } | null（无模板/自我指涉/无具体值时）。
 *
 * opts（Phase 2 新增，全部可选 —— 不传即退回 Phase 1 行为）：
 *   semanticMarkdown : string  本地会话窗口渲染出的 `## 为什么` / `## 避坑` 段
 *   windowText       : string  窗口原文（A2 判据的附加证据；窗口里抽到具体值
 *                              也算「抽到了」，不必非在 sampleArgs 里）
 *   reasonOut        : object  入口对象；被拦时写入 `reason`，供调用方审计留痕
 *                              （不破坏既有的 `=== null` 断言）
 */
export function buildProposal(pattern, opts = {}) {
  const reasonOut = opts.reasonOut ?? null;
  const skip = (reason) => {
    if (reasonOut) reasonOut.reason = reason;
    return null;
  };

  if (!pattern?.toolSequence?.length) return skip('no-tool-sequence');

  const templateSel = selectTemplate(pattern.toolSequence);
  if (!templateSel) return skip('no-matching-template'); // 模板库无匹配 → 不生成候选
  const template = templateSel.template;

  const description = pattern.description ?? pattern.toolSequence.join(' → ');
  const name = skillName(pattern);

  // ── 自我评估禁止（§9.4）：命中即不生成，写 audit 由调用方处理 ──
  if (isSelfReferential(name, description)) return skip('self-referential');

  // ── A2 具体值门（2026-09-17 Phase 2，质量门方案 §2 A2）─────────────────
  // 「抽不到具体值不生成候选」：通用脚手架序列（read/write/glob…）的
  // sampleArgs 往往只有参数键名或空对象，产出的技能只可能复述工具名——
  // 在**候选生成之前**拦掉，比评估层拦更省、也不污染候选表。
  // 判据外部化在 templates.CONCRETE_RE，纯函数可单测；评估层 A3 还有
  // 同尺兜底（防人工 modifyCandidate 绕过本门）。
  const windowText = typeof opts.windowText === 'string' ? opts.windowText : '';
  if (!hasConcreteValue(pattern, windowText)) return skip('no-concrete-value');

  const triggers = extractTriggers(pattern);
  const tools = [...new Set(pattern.toolSequence)];
  const semanticMarkdown = typeof opts.semanticMarkdown === 'string'
    ? opts.semanticMarkdown
    : renderSemanticSections(opts.semantic ?? {});

  const skillDraft = {
    name,
    description,
    category: 'productivity',
    template: template.templateId,
    frontmatter: {
      name,
      description,
      triggers,
      tools,
    },
    body: renderBody(pattern, template, { semanticMarkdown }),
    references: [],
    scripts: [],
  };

  return { skillDraft, estimatedBenefit: estimateBenefit(pattern) };
}

/** 技能名：从描述/工具序列生成 kebab-case slug */
export function skillName(pattern) {
  const fromDesc = (pattern.description ?? '')
    .split('（')[0]
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join('-');
  const base = fromDesc && fromDesc.length >= 4
    ? fromDesc
    : [...new Set(pattern.toolSequence)].join('-').replace(/_/g, '-').replace(/[^a-z0-9-]/g, '');
  return (base || 'repeated-task').slice(0, 48);
}

/**
 * 启发式收益预估（Sprint 14 版本，公式集中在此便于校准）：
 *   - successRateImprovement：标准化能吃掉大部分随机失败 → (1-successRate)*0.6，
 *     已有成功率 ≥0.95 的模式收益趋零（不值得标准化）。
 *   - timeSavingsPct：固定执行路径省掉探索 → 0.2 + 0.05*工具数，cap 0.5。
 *   - tokenSavingsPct：省掉重复上下文 → 0.15 + 0.03*occurrence，cap 0.4。
 *   - harmIncrementEstimate：任务完成率提升为主项 → 收益加权，clamp [0,1]。
 */
export function estimateBenefit(pattern) {
  const successRate = Number.isFinite(pattern.successRate) ? pattern.successRate : 0.5;
  const occ = pattern.occurrenceCount ?? 1;
  const toolCount = new Set(pattern.toolSequence ?? []).size;

  const successRateImprovement = +Math.max(0, (1 - successRate) * 0.6).toFixed(4);
  const timeSavingsPct = +Math.min(0.5, 0.2 + 0.05 * toolCount).toFixed(4);
  const tokenSavingsPct = +Math.min(0.4, 0.15 + 0.03 * occ).toFixed(4);
  const harmIncrementEstimate = +Math.min(1,
    0.6 * successRateImprovement + 0.25 * timeSavingsPct + 0.15 * tokenSavingsPct,
  ).toFixed(4);

  return { successRateImprovement, timeSavingsPct, tokenSavingsPct, harmIncrementEstimate };
}
