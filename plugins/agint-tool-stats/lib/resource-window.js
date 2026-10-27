/**
 * agint-tool-stats/lib/resource-window.js — 资源画像窗口聚合（纯函数）
 *
 * WHY
 * ---
 * D-QAF Phase 3 要求判「有效进化增量」：
 *
 *   有效进化增量 = Δ(任务完成率) / Δ(Token消耗 + 步数 + 时间)      ← docs/evolution-framework.md §5.2
 *
 * 此前这条公式**只在文档里**：分母的 token 项恒缺（docs/capability-boundary.md §4 F3），
 * 公式算不出来，于是「无效进化拒绝部署」这条硬约束从未真正生效。
 *
 * 本模块只做一件事：**把「一个时间窗内的资源读数」口径定死一次**。
 * 判定（有效 / 无效 / 测不出来）在 agint-quality-eval —— 度量归 tool-stats，判定归 eval，
 * 与 deployBudget 的分工一致（数据源不自建，读取口径唯一）。
 *
 * 口径（必须写死，否则数字会漂成新的假读数）
 * --------------------------------------------
 * - **任务** = (sessionId, turn) 一组工具调用。缺 sessionId 或缺 turn 的记录**无法归属任务**，
 *   计入步数但不计入任务数（否则会把「同一次调用的两段人生」当成两个任务）。
 * - **完成任务** = 该组内**全部**调用 ok。任一失败即未完成 —— 与 curator/skill-autocreate
 *   的 groupTaskCalls 同构（同一口径，避免两个插件对「完成」给出不同答案）。
 * - **步数** = 窗口内工具调用条数。
 * - **时间** = latencyMs 求和（只累加**测得**的值），同时给出测得条数。
 * - **token** = deltaTokens 求和（只累加**测得**的值），同时给出测得条数与**覆盖率**。
 *   ⚠️ coverage < 1 时 token 求和**不是**全量成本，判定方必须当「不完整」处理 ——
 *   本模块的职责是把这件事说清楚，而不是替调用方拍板。
 *   ⚠️ null（没测）≠ 0（测得零）：null 不计入求和也不计入 measured，0 两者都计。
 */

/**
 * 任务键：同一 session 的同一 turn 视为一个任务。
 * 用 NUL 分隔，避免 `sessionId='a' turn=1` 与 `sessionId='a1' turn=...` 撞键。
 */
export function taskKeyOf(record) {
  const sid = typeof record?.sessionId === 'string' && record.sessionId ? record.sessionId : null;
  const turn = Number.isInteger(record?.turn) ? record.turn : null;
  if (!sid && turn == null) return null;   // 不可归属
  return `${sid ?? 'no-session'}\0${turn ?? 'no-turn'}`;
}

/**
 * 窗口内资源读数。
 *
 * @param {Array<object>} records  agint_tool_stats.jsonl 的行
 * @param {object} [opts]
 * @param {number|null} [opts.sinceMs]  含下界（ms）；null = 不设下界
 * @param {number|null} [opts.untilMs]  不含上界（ms）；null = 不设上界
 * @returns {{
 *   window: { sinceMs: number|null, untilMs: number|null },
 *   records: number,
 *   tasks: number,
 *   completedTasks: number,
 *   completionRate: number|null,
 *   steps: number,
 *   durationMs: number,
 *   durationMeasured: number,
 *   tokens: { sum: number, measured: number, coverage: number, source: string|null },
 *   firstTs: number|null,
 *   lastTs: number|null,
 * }}
 */
export function summarizeResourceWindow(records = [], { sinceMs = null, untilMs = null } = {}) {
  const filtered = [];
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || typeof r !== 'object') continue;
    const ts = typeof r.ts === 'number' && Number.isFinite(r.ts) ? r.ts : null;
    // 时间窗过滤：ts 缺失的记录无法定位窗口 ⇒ 丢弃（不猜）。无窗口约束时保留。
    if (sinceMs !== null || untilMs !== null) {
      if (ts === null) continue;
      if (sinceMs !== null && ts < sinceMs) continue;
      if (untilMs !== null && ts >= untilMs) continue;
    }
    filtered.push({ ...r, ts });
  }

  const groups = new Map();
  let steps = 0;
  let durationMs = 0;
  let durationMeasured = 0;
  let tokenSum = 0;
  let tokenMeasured = 0;
  let tokenSource = null;
  let firstTs = null;
  let lastTs = null;

  for (const r of filtered) {
    steps += 1;
    if (typeof r.latencyMs === 'number' && Number.isFinite(r.latencyMs)) {
      durationMs += r.latencyMs;
      durationMeasured += 1;
    }
    // null 与 0 分开：只有 number 才算「测得」
    if (typeof r.deltaTokens === 'number' && Number.isFinite(r.deltaTokens)) {
      tokenSum += r.deltaTokens;
      tokenMeasured += 1;
    }
    if (typeof r.tokenSource === 'string' && r.tokenSource) tokenSource = r.tokenSource;

    if (r.ts !== null) {
      if (firstTs === null || r.ts < firstTs) firstTs = r.ts;
      if (lastTs === null || r.ts > lastTs) lastTs = r.ts;
    }

    const key = taskKeyOf(r);
    if (key === null) continue;
    if (!groups.has(key)) groups.set(key, { total: 0, ok: 0 });
    const g = groups.get(key);
    g.total += 1;
    if (r.ok === true) g.ok += 1;
  }

  let completedTasks = 0;
  for (const g of groups.values()) {
    if (g.total > 0 && g.ok === g.total) completedTasks += 1;
  }
  const tasks = groups.size;

  return {
    window: { sinceMs, untilMs },
    records: filtered.length,
    tasks,
    completedTasks,
    completionRate: tasks ? +(completedTasks / tasks).toFixed(4) : null,
    steps,
    durationMs,
    durationMeasured,
    tokens: {
      sum: tokenSum,
      measured: tokenMeasured,
      coverage: filtered.length ? +(tokenMeasured / filtered.length).toFixed(4) : 0,
      source: tokenSource,
    },
    firstTs,
    lastTs,
  };
}
