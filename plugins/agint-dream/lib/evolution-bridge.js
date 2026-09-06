/**
 * agint-dream × agint-evolution-memory bridge (v0.3 / task 3 / 2026-09-06).
 *
 * 目标：Deep 阶段读 success-templates 作为评分参考（提案 ba3e1800-... task 3）。
 *
 * 决策（老板 2026-09-06 拍板）：
 * - 映射 = A: 按 plugin id 精确匹配（appliesTo: ['agint-memory', ...]）
 * - 前置验证 = 要：先 rule_check + 读 evolution-memory/lib/index.js 确认
 *   service key 名（`agint.evolution`）+ queryTemplates API
 *
 * 关键事实（前置验证结论，2026-09-06）：
 * - service key: `agint.evolution`（agint-evolution-memory/lib/index.js line 332）
 * - API: `evo.queryTemplates({ appliesTo, query, limit })` → [{id, template, confidence,
 *   appliesTo, sampleSize, level, ...}] 数组
 *   - query: lowercase substring 匹配 template+evidence
 *   - appliesTo: overlap 匹配（数组元素任一命中）
 *   - limit: 默认 20，上限 50（SUCCESS_TEMPLATES）
 * - evolution-memory host 已挂载（cordis.patch.yml line 165-166）
 * - success-template 字段：template / confidence (0-1) / appliesTo (array<string>) /
 *   sampleSize / level / id / evidence / createdAt ...
 *
 * 语义（重要）：
 * - success-templates 评估的是 plugin 质量（appliesTo: plugin id），不是 dream candidate
 *   （preference/decision/lesson/pattern）—— 与 qualityEval 同构
 * - evolution 模板作为全局信号：plugin 成功模板多 → 系统健康 → 候选更可信（boost）
 * - 但更精确：模板数量/置信度反映系统自进化「成功积累」，是「系统健康度」proxy
 *
 * 强降级路径（永不抛错，不阻断 sweep）：
 * - ctx 不可用 / evolution service 不可用 → { status: 'unavailable', reason }
 * - queryTemplates 抛错 → { status: 'unavailable', reason: 'queryTemplates threw' }
 * - 返回空模板 → { status: 'ok', count: 0, templates: [] }（正常，空库）
 */

import { DREAM_BASELINE_TARGETS } from './quality-bridge.js';

// 直接从 quality-bridge import，避免硬编码重复（C1 教训：DREAM_BASELINE_TARGETS 必须 export）

/** 暴露 plugin id 列表（供 status() 透出） */
export function evolutionPluginIds() {
  return DREAM_BASELINE_TARGETS.map((t) => t.id);
}

/**
 * 拉取 success-templates（按 plugin id 精确匹配）。
 *
 * @param {object} ctx - cordis host ctx
 * @param {object} [opts]
 * @param {string[]} [opts.pluginIds] - 默认用 DREAM_BASELINE_TARGETS 的 9 个 id
 * @param {number} [opts.limit] - 默认 50（上限）
 * @returns {Promise<{status, count, topConfidence, templates, reason}>}
 */
export async function fetchEvolutionTemplates(ctx, opts = {}) {
  const pluginIds = opts.pluginIds ?? evolutionPluginIds();
  const limit = opts.limit ?? 50;

  const base = {
    status: 'unavailable',
    count: 0,
    topConfidence: null,
    templates: [],
    reason: null,
  };

  // ── ctx 不可用 ──────────────────────────────────────────────────────────
  if (!ctx || typeof ctx.get !== 'function') {
    return { ...base, reason: 'ctx unavailable' };
  }

  // ── evolution service 不可用 ──────────────────────────────────────────
  const evo = ctx.get('agint.evolution');
  if (!evo || typeof evo.queryTemplates !== 'function') {
    return { ...base, reason: 'agint.evolution.queryTemplates unavailable' };
  }

  // ── queryTemplates 调用（永不抛错）───────────────────────────────────
  let templates;
  try {
    templates = await evo.queryTemplates({ appliesTo: pluginIds, limit });
  } catch (err) {
    return { ...base, reason: `queryTemplates threw: ${err?.message ?? String(err)}` };
  }

  // 归一化模板数组
  const list = Array.isArray(templates) ? templates : [];
  const confidences = list
    .map((t) => t?.confidence)
    .filter((c) => typeof c === 'number' && Number.isFinite(c));

  return {
    status: 'ok',
    count: list.length,
    topConfidence: confidences.length > 0 ? Math.max(...confidences) : null,
    templates: list.map((t) => ({
      id: t?.id,
      template: t?.template,
      confidence: t?.confidence ?? null,
      appliesTo: t?.appliesTo ?? [],
      sampleSize: t?.sampleSize ?? null,
      level: t?.level ?? null,
    })),
    reason: null,
  };
}

/**
 * 从 evolution 摘要算全局 score boost（与 computeQualityBoost 对称，v0.3 / task 3）。
 *
 * 设计：
 * - 仅 status='ok' 时返回非 0 值
 * - count === 0（空库）→ 0（无模板可参考）
 * - topConfidence >= 0.8 → +0.02（高置信模板多 → 系统自进化健康 → 候选可信）
 * - topConfidence <= 0.5 → -0.02（低置信/衰退 → 候选可疑）
 * - 其它 → 0（中性）
 * - 上限 ±0.02，避免单信号颠覆 6 维评分
 *
 * 输入 shape：{ status, count, topConfidence, templates?, reason? }
 * 返回 number ∈ [-0.02, 0.02]
 */
export function computeEvolutionBoost(summary) {
  if (!summary || typeof summary !== 'object') return 0;
  if (summary.status !== 'ok') return 0;
  if (summary.count === 0) return 0;
  const c = summary.topConfidence;
  if (typeof c !== 'number' || !Number.isFinite(c)) return 0;
  if (c >= 0.8) return 0.02;
  if (c <= 0.5) return -0.02;
  return 0;
}

/**
 * 收集 evolution 摘要（sweep Deep 阶段调用）。永不抛错。
 *
 * @param {object} opts
 * @param {object} opts.ctx - cordis host ctx
 * @param {boolean} [opts.enabled] - 默认 true
 * @param {string[]} [opts.pluginIds] - 默认 9 个 plugin id
 * @param {number} [opts.limit] - 默认 50
 * @param {string[]} [opts.errors] - 错误收集数组
 * @returns {Promise<{status, count, topConfidence, templates, reason}>}
 */
export async function collectEvolutionSummary({ ctx, enabled = true, pluginIds, limit, errors = [] } = {}) {
  if (enabled === false) {
    return { status: 'unavailable', count: 0, topConfidence: null, templates: [], reason: 'disabled by sweep opts' };
  }
  try {
    return await fetchEvolutionTemplates(ctx, { pluginIds, limit });
  } catch (err) {
    errors.push(`evolution fetch threw: ${err?.message ?? String(err)}`);
    return { status: 'unavailable', count: 0, topConfidence: null, templates: [], reason: 'evolution fetch threw' };
  }
}

export const __test = {
  evolutionPluginIds,
};