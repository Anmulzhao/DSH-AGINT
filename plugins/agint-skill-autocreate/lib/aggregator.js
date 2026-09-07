/**
 * agint-skill-autocreate: aggregator — 工具调用记录 → 任务实例。
 *
 * 设计稿 §3.1 [2]：按「任务边界」聚合——一次 turn 内的连续工具调用 =
 * 一个任务实例；提取任务特征（工具组合序列、参数模式、耗时、成功率）。
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
 */

/** 单任务实例工具数上限：超过视为探索性任务（非标准化候选），降噪 */
const MAX_TOOLS_PER_TASK = 30;

/**
 * 把 JSONL 记录聚合成任务实例数组。
 * 返回 { tasks, unmatched }。
 *
 * 任务实例：
 * {
 *   id, sessionId, turn, startedAt, endedAt, durationMs,
 *   toolSequence: [...],            // 按调用顺序，允许重复（序列语义）
 *   paramSignature: { tool: sig },  // 每个工具的参数结构签名（同工具多次
 *                                   // 调用取首现签名）
 *   successRate, sampleArgs,        // 每工具首现 args（模板参数提取用）
 * }
 */
export function aggregateTasks(records) {
  if (!Array.isArray(records)) return { tasks: [], unmatched: 0 };
  const groups = new Map();
  let unmatched = 0;
  for (const r of records) {
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
  return { tasks, unmatched };
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
