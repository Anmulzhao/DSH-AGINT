/**
 * agint-compress-guard: 规则版洞察提取器（Q1：规则 + 模板优先，LLM 默认关）。
 *
 * 三类启发式（设计稿 §1.3）：
 *   decision   —— 拍板/决策 + 理由：显式决策词（拍板/决定/采纳/否决/定案/批准）
 *   preference —— 老板偏好/否决记录（不要/禁止/红线/优先/偏好）→ highRetention
 *   fact       —— 稳定事实（版本号 / 端口 / 阈值 / 路径 + 稳定性词）
 *
 * 诚实边界（§1.3）：规则版召回率有限，设计目标不是「提炼一切」，而是
 * 「提炼到的东西 100% 可信 + 提炼漏掉的仍有 raw 检查点兜底」——两段保险，
 * 各管各的失败模式。每条洞察带 rawOffset 可人工核对（§九 靠谱 > 聪明）。
 *
 * 纯函数、无 IO、无时钟 —— 便于单测与离线补录（reindex）复用。
 */

import { LIMITS } from './schema.js';

/** 句子切分：中文句读 + 换行 + 分号。保留偏移量用于 rawOffset。 */
function splitSentences(text) {
  const out = [];
  const re = /[^。！？\n；;]+[。！？\n；;]?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const trimmed = raw.trim();
    if (trimmed.length >= 8) out.push({ text: trimmed, start: m.index + (raw.length - raw.trimStart().length) });
  }
  return out;
}

const DECISION_RE = /(拍板|决定|定案|采纳|否决|批准|拍板记录|最终选择|敲定)/;
const PREFERENCE_RE = /(不要|别再|禁止|红线|不许|优先|更喜欢|偏好|以后一律|一律)/;
const FACT_RE = /(v?\d+\.\d+(?:\.\d+)?|端口\s*\d+|阈值\s*\d+|[A-Za-z]:\\[^\s，。]{3,}|\/(?:[\w.-]+\/){1,}[\w.-]+)/;
const FACT_STABILITY_RE = /(版本|端口|路径|阈值|默认|配置|上限|下限|安装位|目录)/;

/** 洞察类型判定优先级：preference > decision > fact（偏好红线最不可丢） */
function classify(sentence) {
  if (PREFERENCE_RE.test(sentence)) return 'preference';
  if (DECISION_RE.test(sentence)) return 'decision';
  if (FACT_RE.test(sentence) && FACT_STABILITY_RE.test(sentence)) return 'fact';
  return null;
}

/**
 * 从文本/消息列表提取洞察（业务对象，不含 id / recall 元数据）。
 *
 * @param {string|Array<{role?: string, content?: string}>} input 原文文本或消息列表
 * @param {object} [opts] { max?: number, extractor?: 'rule-v1' }
 * @returns {Array<{type: string, content: string, rawOffset: {start: number, end: number}}>}
 */
export function extractInsights(input, opts = {}) {
  const max = Math.max(1, Math.min(opts.max ?? LIMITS.MAX_INSIGHTS_PER_COMPRESS, 100));

  // 消息列表 → 拼接为带角色前缀的单文本（偏移量相对拼接后的文本）
  let text;
  if (Array.isArray(input)) {
    text = input
      .map((m) => {
        const content = typeof m === 'string' ? m : String(m?.content ?? '');
        const role = typeof m === 'object' && m?.role ? `[${m.role}] ` : '';
        return role + content;
      })
      .join('\n');
  } else {
    text = String(input ?? '');
  }
  if (!text.trim()) return [];

  const seen = new Set();
  const out = [];
  for (const { text: sentence, start } of splitSentences(text)) {
    if (out.length >= max) break;
    const type = classify(sentence);
    if (!type) continue;
    // 内容截断到 2KB（LIMITS.INSIGHT_CONTENT_BYTES）
    const content = sentence.length > LIMITS.INSIGHT_CONTENT_BYTES
      ? sentence.slice(0, LIMITS.INSIGHT_CONTENT_BYTES)
      : sentence;
    const key = content;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      type,
      content,
      rawOffset: { start, end: start + content.length },
    });
  }
  return out;
}

/**
 * 洞察类型 → agint-memory 记忆类型映射（§6.2 兜底注入标注用）。
 * agint-memory 类型域：lesson / decision / preference / pattern（AGENTS.md）。
 */
export function mapToMemoryType(insightType) {
  switch (insightType) {
    case 'decision': return 'decision';
    case 'preference': return 'preference';
    case 'fact': return 'lesson';
    default: return 'pattern';
  }
}
