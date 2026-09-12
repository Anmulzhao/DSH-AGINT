/**
 * agint-trajectory/lib/redact.js — 规则脱敏（§7.2 / §7.3，Q3 落点）。
 *
 * 诚实边界（写在代码里，别只写文档）：**规则脱敏不保证零泄漏**。它是正则
 * 匹配，覆盖已知形态（sk-* / Bearer / AKIA / email / api_key= / 私钥头）。
 * 老板评审意见 Q3 已确认接受这个边界 + 全局熔断作为兜底。
 *
 * v0.2 补充要求：脱敏范围必须覆盖「工具参数正文」——实测 tool-stats 的
 * args 含完整用户输入。因此 redactSteps 对**所有 role 的 content**生效，
 * 不只是 observation。
 */

import { DEFAULT_REDACT_RULES, REDACTED } from './schema.js';

/**
 * 编译规则表。pattern 非法（用户配置写错）→ 跳过该条而不是让整个记录器崩。
 * @param {{useDefaultRedactRules?:boolean, extraRedactRules?:Array}} config
 * @returns {Array<{name:string, re:RegExp}>}
 */
export function compileRules(config = {}) {
  const raw = [
    ...(config.useDefaultRedactRules === false ? [] : DEFAULT_REDACT_RULES),
    ...(Array.isArray(config.extraRedactRules) ? config.extraRedactRules : []),
  ];
  const out = [];
  for (const r of raw) {
    if (!r || typeof r.pattern !== 'string' || !r.pattern) continue;
    try {
      out.push({ name: r.name ?? 'custom', re: new RegExp(r.pattern, 'g') });
    } catch {
      /* 非法正则：跳过，不阻塞记录（fail-open 精神） */
    }
  }
  return out;
}

/**
 * 单文本脱敏。
 * @returns {{text:string, hit:boolean, hits:string[]}}
 */
export function redactText(text, rules = []) {
  if (typeof text !== 'string' || text.length === 0) return { text: text ?? '', hit: false, hits: [] };
  let out = text;
  const hits = [];
  for (const { name, re } of rules) {
    re.lastIndex = 0;
    if (re.test(out)) {
      hits.push(name);
      re.lastIndex = 0;
      out = out.replace(re, REDACTED);
    }
  }
  return { text: out, hit: hits.length > 0, hits };
}

/**
 * 步骤序列脱敏（所有 role 的 content + outcome.errorMsg 之类由调用方传）。
 * 不改原数组（纯函数，返回新对象）。
 * @returns {{steps:Array, hit:boolean, hits:string[]}}
 */
export function redactSteps(steps = [], rules = []) {
  const out = [];
  const hits = new Set();
  let hit = false;
  for (const s of steps ?? []) {
    const r = redactText(s?.content, rules);
    if (r.hit) { hit = true; for (const h of r.hits) hits.add(h); }
    out.push({ ...s, content: r.text });
  }
  return { steps: out, hit, hits: [...hits] };
}

/**
 * 递归脱敏任意 JSON 值（payload.final / feedback 用）。
 * @returns {{value:unknown, hit:boolean}}
 */
export function redactValue(value, rules = []) {
  if (typeof value === 'string') {
    const r = redactText(value, rules);
    return { value: r.text, hit: r.hit };
  }
  if (Array.isArray(value)) {
    let hit = false;
    const arr = value.map((v) => {
      const r = redactValue(v, rules);
      if (r.hit) hit = true;
      return r.value;
    });
    return { value: arr, hit };
  }
  if (value && typeof value === 'object') {
    let hit = false;
    const obj = {};
    for (const [k, v] of Object.entries(value)) {
      const r = redactValue(v, rules);
      if (r.hit) hit = true;
      obj[k] = r.value;
    }
    return { value: obj, hit };
  }
  return { value, hit: false };
}
