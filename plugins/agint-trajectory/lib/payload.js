/**
 * agint-trajectory/lib/payload.js — 步骤归一化 / 体积估算 / 截断 / 用量聚合。
 *
 * 三条设计约束落在这里：
 *   1. **不复存参数正文**（§3.2 / §8bis）：observation 轮的 content 只留
 *      结果摘要（≤ observationSummaryChars），参数正文的权威源是
 *      `agint_tool_stats.jsonl` 的 args，P2-1 复存即为双写。
 *   2. **截断必留痕**（不变量 #2）：truncatePayload 返回 truncated=true +
 *      droppedSteps，禁止静默截断。
 *   3. **保头 + 保尾**（v0.3 Hermes 反衬结论，§7bis.2 ③）：截断砍掉的若是
 *      轨迹尾巴 = 最终输出与结局，对训练数据是最不该丢的部分。因此丢中段，
 *      而不是从尾部一刀切。完整「中段摘要」属候选 ④，本版不做（需 LLM）。
 */

import { DEFAULTS, ROLES } from './schema.js';

/** JSON 落盘字节数（UTF-8） */
export function estimateBytes(value) {
  if (value === null || value === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

/**
 * 步骤归一化：补 seq / 合法 role / 摘要化 observation content。
 * 非法 role 归为 observation（不丢内容，降级而不是拒绝）。
 * @returns {Array}
 */
export function normalizeSteps(steps, opts = {}) {
  const summaryChars = opts.observationSummaryChars ?? DEFAULTS.OBSERVATION_SUMMARY_CHARS;
  const raw = Array.isArray(steps) ? steps : [];
  return raw.map((s, i) => {
    const step = s && typeof s === 'object' ? s : { content: String(s ?? '') };
    const role = ROLES.includes(step.role) ? step.role : 'observation';
    let content = typeof step.content === 'string' ? step.content : JSON.stringify(step.content ?? '');
    if (role === 'observation' && content.length > summaryChars) {
      content = `${content.slice(0, summaryChars)}…`;
    }
    return {
      ...step,
      seq: Number.isInteger(step.seq) ? step.seq : i,
      role,
      content,
    };
  });
}

/**
 * 从步骤聚合 usage（toolCalls / toolStats）。
 * errorKinds 不在步级数据里（step schema 无该字段）——它来自 tool-stats，
 * 见 enrichUsageFromToolStats()。
 * @returns {{toolCalls:number, toolStats:Object}}
 */
export function aggregateUsage(steps = []) {
  const toolStats = {};
  let toolCalls = 0;
  for (const s of steps) {
    if (!s?.tool) continue;
    toolCalls++;
    const bucket = toolStats[s.tool] ?? { count: 0, ok: 0, fail: 0 };
    bucket.count++;
    if (s.toolOk === true) bucket.ok++;
    else if (s.toolOk === false) bucket.fail++;
    toolStats[s.tool] = bucket;
  }
  return { toolCalls, toolStats: Object.keys(toolStats).length ? toolStats : null };
}

/**
 * 离线按 callId 回查 tool-stats，补 toolStats / errorKinds（§3.2 v0.3）。
 * tool-stats 无 callId 索引，这里是**全量扫描**，只在调用方显式传入 records
 * 时执行一次；v0.1 不做自动回查（§3.2 原文约定）。
 *
 * @param {{toolCalls?:number, toolStats?:Object}} usage
 * @param {Array} records tool-stats 记录（含 callId/tool/ok/errorKind）
 * @param {Set<string>|null} callIds 限定范围；null = 全量
 */
export function enrichUsageFromToolStats(usage = {}, records = [], callIds = null) {
  const toolStats = { ...(usage.toolStats ?? {}) };
  const errorKinds = {};
  let toolCalls = usage.toolCalls ?? 0;
  for (const r of Array.isArray(records) ? records : []) {
    if (callIds && !callIds.has(r?.callId)) continue;
    const tool = r?.tool ?? 'unknown';
    const bucket = toolStats[tool] ?? { count: 0, ok: 0, fail: 0 };
    bucket.count++;
    if (r?.ok === true) bucket.ok++;
    else if (r?.ok === false) {
      bucket.fail++;
      const kind = r?.errorKind ?? 'unknown';
      errorKinds[kind] = (errorKinds[kind] ?? 0) + 1;
    }
    toolStats[tool] = bucket;
    if (!usage.toolCalls) toolCalls++;
  }
  return {
    ...usage,
    toolCalls,
    toolStats: Object.keys(toolStats).length ? toolStats : null,
    errorKinds: Object.keys(errorKinds).length ? errorKinds : null,
  };
}

/**
 * payload 截断：保头 + 保尾，丢中段。
 * @param {{steps:Array, final?:Object}} payload
 * @param {number} maxBytes
 * @returns {{payload:Object, truncated:boolean, droppedSteps:number, bytes:number}}
 */
export function truncatePayload(payload = { steps: [] }, maxBytes = DEFAULTS.MAX_PAYLOAD_BYTES) {
  const steps = Array.isArray(payload.steps) ? payload.steps : [];
  const finalBytes = estimateBytes(payload.final ?? null);
  const budget = Math.max(0, maxBytes - finalBytes);
  const sizes = steps.map((s) => estimateBytes(s));
  const total = sizes.reduce((a, b) => a + b, 0);

  if (total <= budget) {
    return { payload: { ...payload, steps }, truncated: false, droppedSteps: 0, bytes: total + finalBytes };
  }

  // 头尾各分一半预算，尽量保住「开头上下文」与「结尾结局」。
  const half = budget / 2;
  const head = [];
  let used = 0;
  for (let i = 0; i < steps.length; i++) {
    if (used + sizes[i] > half) break;
    head.push(i);
    used += sizes[i];
  }
  const tail = [];
  used = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (used + sizes[i] > half) break;
    tail.push(i);
    used += sizes[i];
  }
  tail.reverse();

  // 若头尾重叠（步数少但单步巨大），退化为「只保尾」（结局优先）。
  let keep;
  const headSet = new Set(head);
  const merged = [...head, ...tail.filter((i) => !headSet.has(i))].sort((a, b) => a - b);
  const mergedBytes = merged.reduce((a, i) => a + sizes[i], 0);
  if (mergedBytes <= budget) {
    keep = merged;
  } else {
    keep = tail;
  }

  const keptSteps = keep.map((i) => steps[i]);
  return {
    payload: { ...payload, steps: keptSteps, droppedSteps: steps.length - keptSteps.length },
    truncated: steps.length > keptSteps.length,
    droppedSteps: steps.length - keptSteps.length,
    bytes: keptSteps.reduce((a, s) => a + estimateBytes(s), 0) + finalBytes,
  };
}
