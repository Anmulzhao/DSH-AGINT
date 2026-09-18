/**
 * agint-skill-autocreate: proposer — 技能候选提案生成（设计稿 §3.1 [5]）。
 *
 * 输入：检测到的重复 pattern（业务字段）。
 * 输出：skillDraft（SKILL.md 草稿）+ estimatedBenefit（启发式预估）。
 *
 * 红线：
 *   - 自我评估禁止（设计稿 §9.4）：名/描述含自我指涉关键词 → 返回 null。
 *     这条**对 LLM 产出同样执行**，而且更要严——LLM 更容易写出「本技能可以
 *     自我改进」这类自指内容（LLM 接入方案 §5.3）。
 *   - 默认零 LLM 调用：模板填充 + 本地语义窗口。LLM 撰写（2026-09-18 接入）
 *     只在调用方显式传 `llmAuthoring` 且开关打开时才生效，且**必须过本地
 *     校验**（见 `validateLlmAuthoring`）——生成侧与判据侧天然分离，
 *     比让 LLM 自评可靠得多。
 *   - 预估收益是启发式（D-QAF Phase 2/3 才量实测），公式在此集中注释，
 *     Sprint 15 接入实测后回填校准。
 */

import { selectTemplate, renderBody, extractTriggers, hasConcreteValue } from './templates.js';
import { isSelfReferential } from './schema.js';
import { renderSemanticSections } from './semantic-window.js';
import { isHostSkillName, isToolChainName } from './authoring.js';

/**
 * 本地校验 LLM 撰写的产出（LLM 接入方案 §5.2）——**不相信模型守规矩**。
 *
 * 两道判据（判据所有者在 `authoring.js`，本模块不另立一份）：
 *   ① 名字合法：宿主 `SKILL_NAME` 正则。不合法时 `dsh-skill-filesystem` 会
 *      **静默忽略整个技能文件**（文件在盘上、技能永不出现，最难排查的失效）。
 *   ② 不是工具链名：`TOOL_CHAIN_NAME_RE`。实测判别力——自动产物 5/5 命中、
 *      人工撰写 0/6 命中，恰好把「工具序列拼接」与「类级领域名」分开。
 *
 * **拒绝即整条丢弃**（不是只丢名字、保留描述）：半信半疑的混合产出更难解释，
 * 也让「这条候选的正文到底谁写的」变得无法回答。丢弃后回落现行为。
 *
 * @param {object|null} llmAuthoring  `{name?, description?, why?, pitfalls?}`
 * @returns {{authoring: object|null, rejection: object|null}}
 *   rejection = { rejectedFields: string[], values: object, reason: string }
 */
export function validateLlmAuthoring(llmAuthoring) {
  if (!llmAuthoring || typeof llmAuthoring !== 'object') return { authoring: null, rejection: null };
  const name = typeof llmAuthoring.name === 'string' ? llmAuthoring.name.trim() : '';
  // 核心字段是 name：没有它，最要命的那个问题（K57 发现 1 命名回落工具序列）没被解决，
  // 用它剩下一半产出反而更难解释 → 整条不用。
  if (!name) {
    return {
      authoring: null,
      rejection: { rejectedFields: ['name'], values: { name: null }, reason: 'name-missing' },
    };
  }
  if (!isHostSkillName(name)) {
    return {
      authoring: null,
      rejection: { rejectedFields: ['name'], values: { name }, reason: 'name-not-ascii-kebab' },
    };
  }
  if (isToolChainName(name)) {
    return {
      authoring: null,
      rejection: { rejectedFields: ['name'], values: { name }, reason: 'name-tool-chain' },
    };
  }
  return { authoring: llmAuthoring, rejection: null };
}

/**
 * pattern → { skillDraft, estimatedBenefit } | null（无模板/自我指涉/无具体值时）。
 *
 * opts（Phase 2 新增，全部可选 —— 不传即退回 Phase 1 行为）：
 *   semanticMarkdown : string  本地会话窗口渲染出的 `## 为什么` / `## 避坑` 段
 *   windowText       : string  窗口原文（A2 判据的附加证据；窗口里抽到具体值
 *                              也算「抽到了」，不必非在 sampleArgs 里）
 *   semanticEvidence : object  结构化语义证据 `{why:[], pitfalls:[]}`（可选）。
 *                              仅当 LLM 只给了其中一半时，用它对另一半补齐。
 *   reasonOut        : object  入口对象；被拦时写入 `reason`，供调用方审计留痕
 *                              （不破坏既有的 `=== null` 断言）
 *   llmAuthoring     : object|null  LLM 撰写的 `{name, description, why[], pitfalls[]}`
 *                              （2026-09-18 接入）。过不了 `validateLlmAuthoring`
 *                              就整条丢弃并回落现行为。
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

  // ── LLM 撰写落地（2026-09-18）：优先用 LLM 的名/描述，过不了校验就整条丢 ──
  const { authoring: llmAuthoring, rejection } = validateLlmAuthoring(opts.llmAuthoring);
  if (rejection && reasonOut) reasonOut.llmAuthoringRejected = rejection;

  const description = llmAuthoring?.description
    ?? pattern.description
    ?? pattern.toolSequence.join(' → ');
  const name = llmAuthoring?.name ?? skillName(pattern);

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
  let semanticMarkdown = typeof opts.semanticMarkdown === 'string'
    ? opts.semanticMarkdown
    : renderSemanticSections(opts.semantic ?? {});

  // ── 正文 WHY/避坑段：LLM 优先、按字段补齐（方案 §5.1）──────────────────
  // 只在 LLM 真给了 why 或 pitfalls 时才重渲染；否则完全保持现行为。
  const llmWhy = Array.isArray(llmAuthoring?.why) ? llmAuthoring.why : [];
  const llmPitfalls = Array.isArray(llmAuthoring?.pitfalls) ? llmAuthoring.pitfalls : [];
  if (llmWhy.length || llmPitfalls.length) {
    const ev = opts.semanticEvidence ?? {};
    semanticMarkdown = renderSemanticSections({
      why: llmWhy.length ? llmWhy : (ev.why ?? []),
      pitfalls: llmPitfalls.length ? llmPitfalls : (ev.pitfalls ?? []),
    });
  }

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
