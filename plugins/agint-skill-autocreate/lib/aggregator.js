/**
 * agint-skill-autocreate: aggregator — 工具调用记录 → 任务实例。
 *
 * 设计稿 §3.1 [2]：按「任务边界」聚合——一次 turn 内的连续工具调用 =
 * 一个任务实例；提取任务特征（工具组合序列、参数模式、耗时、成功率）。
 *
 * Sprint 17（2026-09-17）：新增「跨会话聚合」（cross_session_aggregation）。
 * 原实现 key = (sessionId, turn) 会把跨会话反复做的工作流切成 N 份 x1，
 * 导致 min_occurrence_count 几乎永远跨不过去。13.5 天 / 9088 条回放：
 *   session+turn: 11 个跨门槛模式；跨会话: 21 个（+91%）。
 * 详见 evolve_proposals d5124051-817c-4aa3-bea6-fe259cf9914d。
 *
 * 模式：
 *   'off'     — 旧行为，按 (sessionId, turn) 切分（v0.3.4 等价，default）
 *   'shadow'  — 旧 + 新并行算，结果 diff 写审计，**不发候选**（灰度期）
 *   'primary' — 用跨会话结果作为唯一任务边界
 *
 * 输入：agint_tool_stats.jsonl 的记录行（纯数据，本模块不做 I/O）：
 *   { ts, sessionId, turn, step, tool, callId, latencyMs, ok, errorKind,
 *     argFingerprint, args }
 *
 * 已知缺口（如实标注）：
 *   - tool-stats 不记录 tokenCost → avgTokenCost 恒 null（设计稿 §4.2 字段
 *     保留，待 tool-stats 增补 token 计量后自然填充）。
 *   - sessionId/turn 缺失的记录无法归属任务边界 → 计入 unmatched，不参与
 *     模式检测（宁可漏检，不可错检）。
 *
 * D2（Sprint14 §2.1）：sessionId 以 `curriculum-` 开头（或 source==='curriculum'）
 * 的记录**整条丢弃**，不计入任务聚合。理由：curriculum 的挑战是「同一类任务
 * 反复练」，天然命中「工具序列全等 + 累计 ≥3 次」的重复模式判定，不过滤会
 * 批量产出「做挑战」的垃圾技能候选。向后兼容：无该字段的旧记录照常处理。
 */

import { isExcludedRecord } from './schema.js';

/** 单任务实例工具数上限：超过视为探索性任务（非标准化候选），降噪 */
const MAX_TOOLS_PER_TASK = 30;

/**
 * 模式分发：返回 { tasks, unmatched, excluded, mode }。
 *   mode ∈ 'off' | 'shadow' | 'primary'
 *   'shadow' 模式额外返回 shadowDiff: { extra, lost, shared }
 *     extra  = 新模式有、旧模式无（跨会话新增发现）
 *     lost   = 旧模式有、新模式无（极端 case：宽 key 把同一指纹降权到 1 次）
 *     shared = 两边都有
 *
 * 旧调用形态 aggregateTasks(records) 仍然 100% 兼容（mode='off'）。
 */
export function aggregateTasks(records, options = {}) {
  const mode = options.mode ?? 'off';
  if (mode === 'primary') {
    const cross = aggregateTasksCrossSession(records, options);
    return { ...cross, mode };
  }
  if (mode === 'shadow') {
    const legacy = aggregateBySessionTurn(records);
    const cross = aggregateTasksCrossSession(records, options);
    return {
      tasks: cross.tasks, // shadow 默认返回 cross 给调用方审计
      unmatched: cross.unmatched,
      excluded: cross.excluded,
      mode,
      shadowDiff: diffTasks(legacy.tasks, cross.tasks),
      legacyTasks: legacy.tasks,
    };
  }
  const r = aggregateBySessionTurn(records);
  return { ...r, mode };
}

/**
 * 旧实现：key = (sessionId, turn)。v0.3.4 行为，外部单测锚定，**不允许改**。
 */
function aggregateBySessionTurn(records) {
  if (!Array.isArray(records)) return { tasks: [], unmatched: 0, excluded: 0 };
  const groups = new Map();
  let unmatched = 0;
  let excluded = 0;
  for (const r of records) {
    if (isExcludedRecord(r)) { excluded++; continue; }   // D2：挑战调用不进模式检测
    if (!r || typeof r.tool !== 'string' || !r.tool) { unmatched++; continue; }
    const sid = typeof r.sessionId === 'string' && r.sessionId ? r.sessionId : null;
    const turn = Number.isInteger(r.turn) ? r.turn : null;
    if (!sid && turn == null) { unmatched++; continue; }
    const key = `${sid ?? 'no-session'}::${turn ?? 'no-turn'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const tasks = [];
  for (const [key, recs] of groups) {
    recs.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    if (recs.length > MAX_TOOLS_PER_TASK) continue; // 探索性任务，跳过
    const toolSequence = recs.map((r) => r.tool);
    const paramSignature = {};
    const sampleArgs = {};
    for (const r of recs) {
      if (!(r.tool in paramSignature)) {
        paramSignature[r.tool] = signatureOf(r.args);
        sampleArgs[r.tool] = r.args ?? {};
      }
    }
    const oks = recs.filter((r) => r.ok === true).length;
    const withLatency = recs.filter((r) => typeof r.latencyMs === 'number');
    const first = recs[0];
    const last = recs[recs.length - 1];
    tasks.push({
      id: `task_${key.replace(/[^a-zA-Z0-9]/g, '_')}_${first.ts ?? 0}`,
      sessionId: first.sessionId ?? null,
      turn: first.turn ?? null,
      startedAt: first.ts ?? null,
      endedAt: last.ts ?? null,
      durationMs: withLatency.length ? withLatency.reduce((s, r) => s + r.latencyMs, 0) : null,
      toolCount: recs.length,
      toolSequence,
      paramSignature,
      sampleArgs,
      successRate: recs.length ? +(oks / recs.length).toFixed(4) : 0,
    });
  }
  tasks.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  return { tasks, unmatched, excluded };
}

/**
 * 跨会话聚合：任务边界 = 按 ts idle gap > idleMs 切分（与 sessionId 解耦）。
 *
 * 安全护栏：
 *   1. 参数签名仍然必须保留——单纯工具序列相同但参数结构不同的不算同模式。
 *   2. 单任务跨过的 sessionId 数 > maxSessionsPerTask → 整体弃（防误合并）。
 *   3. MAX_TOOLS_PER_TASK 仍生效。
 *   4. 元数据扩 sessionIds[] + firstSeenAt/lastSeenAt + occurrenceSource='cross_session'。
 */
export function aggregateTasksCrossSession(records, options = {}) {
  if (!Array.isArray(records)) return { tasks: [], unmatched: 0, excluded: 0 };
  const idleMs = options.idleMs ?? 30_000;
  const maxSessions = options.maxSessionsPerTask ?? 20;

  // 1) 排除 curriculum + 缺工具名 → unmatched/excluded
  const eligible = [];
  let unmatched = 0;
  let excluded = 0;
  for (const r of records) {
    if (isExcludedRecord(r)) { excluded++; continue; }
    if (!r || typeof r.tool !== 'string' || !r.tool) { unmatched++; continue; }
    eligible.push(r);
  }
  if (eligible.length === 0) return { tasks: [], unmatched, excluded };

  // 2) 按 ts 升序，按 idle gap 切任务边界
  const sorted = [...eligible].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const segments = [];
  let cur = [];
  let lastTs = null;
  for (const r of sorted) {
    if (lastTs != null && typeof r.ts === 'number' && (r.ts - lastTs) > idleMs) {
      if (cur.length) segments.push(cur);
      cur = [];
    }
    cur.push(r);
    if (typeof r.ts === 'number') lastTs = r.ts;
  }
  if (cur.length) segments.push(cur);

  // 3) 每段独立生成 task；sessionIds 超阈值或工具超阈值的丢弃
  const tasks = [];
  for (const recs of segments) {
    if (recs.length > MAX_TOOLS_PER_TASK) continue;
    const sids = [...new Set(recs.map(r => r.sessionId).filter(s => typeof s === 'string' && s))];
    if (sids.length > maxSessions) continue; // 护栏 R1

    const toolSequence = recs.map(r => r.tool);
    const paramSignature = {};
    const sampleArgs = {};
    for (const r of recs) {
      if (!(r.tool in paramSignature)) {
        paramSignature[r.tool] = signatureOf(r.args);
        sampleArgs[r.tool] = r.args ?? {};
      }
    }
    const oks = recs.filter(r => r.ok === true).length;
    const withLatency = recs.filter(r => typeof r.latencyMs === 'number');
    const first = recs[0];
    const last = recs[recs.length - 1];

    tasks.push({
      id: `xtask_${(first.ts ?? 0).toString(36)}_${(sids[0] ?? 'x').slice(0, 8)}_${tasks.length}`,
      sessionId: first.sessionId ?? null,        // 兼容字段：留首个会话
      turn: first.turn ?? null,
      sessionIds: sids,                          // Sprint 17 新字段
      startedAt: first.ts ?? null,
      endedAt: last.ts ?? null,
      firstSeenAt: first.ts != null ? new Date(first.ts).toISOString() : null,
      lastSeenAt: last.ts != null ? new Date(last.ts).toISOString() : null,
      durationMs: withLatency.length ? withLatency.reduce((s, r) => s + r.latencyMs, 0) : null,
      toolCount: recs.length,
      toolSequence,
      paramSignature,
      sampleArgs,
      successRate: recs.length ? +(oks / recs.length).toFixed(4) : 0,
      occurrenceSource: 'cross_session',         // 区分用
    });
  }
  tasks.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  return { tasks, unmatched, excluded };
}

/**
 * 影子期 diff：返回新旧两边的指纹重合度。
 * 指纹 = `${toolSeq.join('>')}::${JSON.stringify(paramSig)}`
 */
function diffTasks(legacyTasks, crossTasks) {
  const fp = (t) => `${t.toolSequence.join('>')}::${JSON.stringify(t.paramSignature)}`;
  const legacyFp = new Map();
  const crossFp = new Map();
  for (const t of legacyTasks) legacyFp.set(fp(t), (legacyFp.get(fp(t)) ?? 0) + 1);
  for (const t of crossTasks) crossFp.set(fp(t), (crossFp.get(fp(t)) ?? 0) + 1);
  const shared = [];
  const extra = [];
  const lost = [];
  for (const k of crossFp.keys()) {
    if (legacyFp.has(k)) shared.push(k);
    else extra.push(k);
  }
  for (const k of legacyFp.keys()) {
    if (!crossFp.has(k)) lost.push(k);
  }
  return {
    extra,
    lost,
    shared,
    extraCount: extra.length,
    lostCount: lost.length,
    sharedCount: shared.length,
  };
}

/**
 * 参数结构签名：抓 args 的「形状」而非具体值。
 * 规则（v1，够 Sprint 14 相似度用）：
 *   - 顶层 key 排序 + 每个 key 的粗类型（str/num/bool/obj/arr/empty）
 *   - string 值带扩展名时提取扩展名（如 path_pattern:.md）
 * 例：{ path: "a/b.md" } → "path:str:.md"
 */
export function signatureOf(args) {
  if (args == null || typeof args !== 'object' || Array.isArray(args)) return 'none';
  const keys = Object.keys(args).sort();
  if (keys.length === 0) return 'empty';
  return keys.map((k) => `${k}:${typeTag(args[k])}`).join('|');
}

function typeTag(v) {
  if (v === null || v === undefined) return 'empty';
  if (Array.isArray(v)) return 'arr';
  switch (typeof v) {
    case 'string': {
      const m = /\.([A-Za-z0-9]{1,8})$/.exec(v);
      return m ? `str:${m[1].toLowerCase()}` : 'str';
    }
    case 'number': return 'num';
    case 'boolean': return 'bool';
    case 'object': return 'obj';
    default: return 'other';
  }
}

/** 读取窗口过滤：过去 N 小时的记录（ts 为毫秒时间戳） */
export function filterWindow(records, windowHours, nowMs = Date.now()) {
  const since = nowMs - windowHours * 3600_000;
  return (records ?? []).filter((r) => typeof r.ts === 'number' && r.ts >= since);
}
