/**
 * agint-curator: aggregator — 技能清单扫描 + 技能级使用数据聚合。
 *
 * 设计稿 P0-2 §3.1 [2]，Sprint14 §3.1/§3.4 + D3：
 *   [1] 扫描 preset skills 目录 → 技能清单（name/description/tools/triggers）
 *   [2] 读 agint_tool_stats.jsonl → 按 (sessionId, turn) 聚成任务实例
 *   [3] 任务 ↔ 技能匹配 → 每技能 useCount / lastUsedAt / successRate
 *
 * 技能使用数据从哪来（P0-2 开放问题，选 C「先推断，后切换」）：
 *   - **准确路径**：记录带 `skill` 字段（P0-1 上线后 tool-stats 增补）→ 直接归属。
 *   - **推断路径**（当前默认）：技能 frontmatter 声明的 `tools` 与任务的
 *     工具序列求覆盖率，≥ usage_inference_min_tool_coverage 判定命中。
 *     这是**启发式**，如实标注：技能没声明 tools 时无法推断（useCount 保持
 *     0，不参与陈旧判定，见 state-engine 的 `noUsageData` 分支）。
 *
 * D3（Sprint14 §2.1）：sessionId 前缀 `curriculum-`（或 source==='curriculum'）
 * 的记录**整条丢弃**，避免挑战调用刷新 lastUsedAt 把陈旧技能误判为活跃。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isExcludedRecord } from './schema.js';

const DAY_MS = 86_400_000;

/**
 * 极简 frontmatter 解析：只取 SKILL.md 顶部 `---` 之间的 YAML 子集。
 * 支持：key: value / key: "value" / key: [a, b] / key:\n  - a
 * 不支持嵌套对象与多行字符串——技能 frontmatter 用不到，遇到就跳过该 key。
 */
export function parseFrontmatter(text) {
  const out = {};
  if (typeof text !== 'string') return out;
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) { i++; continue; }
    const key = kv[1];
    let raw = kv[2].trim();
    if (raw.startsWith('[') && raw.endsWith(']')) {
      out[key] = raw.slice(1, -1).split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
      i++;
      continue;
    }
    if (raw === '') {
      // 可能是列表：收集后续 `  - item`
      const items = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
        items.push(lines[j].replace(/^\s*-\s+/, '').trim().replace(/^['"]|['"]$/g, ''));
        j++;
      }
      if (items.length) { out[key] = items; i = j; continue; }
      out[key] = '';
      i++;
      continue;
    }
    out[key] = raw.replace(/^['"]|['"]$/g, '');
    i++;
  }
  return out;
}

/**
 * 扫描技能目录 → 技能清单。
 * 每项：{ name, description, triggers, tools, dirName, path, createdAt }
 * createdAt 取 SKILL.md 的 birthtime（不可得时退回 mtime）。
 */
export async function scanSkills(skillsDir) {
  let entries = [];
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return []; // 目录不存在 → 空清单，不抛（冒烟友好）
  }
  const skills = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('.')) continue; // .archive 等隐藏目录不扫
    const skillPath = join(skillsDir, ent.name, 'SKILL.md');
    try {
      const [text, st] = await Promise.all([readFile(skillPath, 'utf8'), stat(skillPath)]);
      const fm = parseFrontmatter(text);
      const name = typeof fm.name === 'string' && fm.name ? fm.name : ent.name;
      skills.push({
        name,
        description: typeof fm.description === 'string' ? fm.description : '',
        triggers: Array.isArray(fm.triggers) ? fm.triggers : [],
        tools: Array.isArray(fm.tools) ? fm.tools : [],
        dirName: ent.name,
        path: skillPath,
        createdAt: new Date(
          Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs,
        ).toISOString(),
      });
    } catch {
      // SKILL.md 缺失/不可读 → 跳过（宁可漏，不可错）
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/** 时间窗过滤：过去 N 天（ts 为毫秒时间戳）+ D3 数据源黑名单过滤 */
export function filterRecords(records, { lookbackDays = 180, nowMs = Date.now() } = {}) {
  const since = nowMs - lookbackDays * DAY_MS;
  return (records ?? []).filter((r) => {
    if (isExcludedRecord(r)) return false;                       // D3
    if (typeof r.ts !== 'number') return false;
    return r.ts >= since && r.ts <= nowMs + DAY_MS;              // 容忍轻微时钟漂移
  });
}

/** 与 agint-skill-autocreate.aggregator 同构：按 (sessionId, turn) 聚成任务 */
export function groupTaskCalls(records) {
  const groups = new Map();
  for (const r of records) {
    if (!r || typeof r.tool !== 'string' || !r.tool) continue;
    const sid = typeof r.sessionId === 'string' && r.sessionId ? r.sessionId : null;
    const turn = Number.isInteger(r.turn) ? r.turn : null;
    if (!sid && turn == null) continue;   // 无法归属任务边界 → 丢弃
    const key = `${sid ?? 'no-session'}::${turn ?? 'no-turn'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const tasks = [];
  for (const recs of groups.values()) {
    recs.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    tasks.push({
      toolSequence: recs.map((r) => r.tool),
      startedAt: recs[0].ts,
      endedAt: recs[recs.length - 1].ts,
      okCount: recs.filter((r) => r.ok === true).length,
      totalCount: recs.length,
      latencySumMs: recs.reduce((s, r) => s + (typeof r.latencyMs === 'number' ? r.latencyMs : 0), 0),
      latencySampleCount: recs.filter((r) => typeof r.latencyMs === 'number').length,
      skillTags: recs.map((r) => (typeof r.skill === 'string' ? r.skill : null)).filter(Boolean),
    });
  }
  tasks.sort((a, b) => a.startedAt - b.startedAt);
  return tasks;
}

/**
 * 技能 ↔ 任务匹配，产出每技能使用统计。
 *
 * @returns {Object} { usage: { [skillName]: stats }, matchedTasks, unmatchedTasks, inference }
 *   stats: { useCount, lastUsedAt, firstUsedAt, successRate, avgDurationMs, avgTokenCost }
 *   inference: 'explicit'（记录带 skill 字段）| 'inferred' | 'disabled'
 */
export function aggregateUsage(tasks, skills, opts = {}) {
  const {
    inferenceEnabled = true,
    minToolCoverage = 0.6,
  } = opts;

  const usage = {};
  for (const s of skills) {
    usage[s.name] = {
      useCount: 0,
      lastUsedAt: null,
      firstUsedAt: null,
      successRate: null,
      avgDurationMs: null,
      avgTokenCost: null,
    };
  }

  const tasksWithSkillField = tasks.filter((t) => t.skillTags.length > 0).length;
  let matchedTasks = 0;
  let okSum = 0;
  let totalSum = 0;
  let latencySum = 0;
  let latencyCount = 0;

  for (const task of tasks) {
    const hits = new Set();
    // 路径 1：记录自带 skill 字段（未来 tool-stats 增补后自动生效）
    for (const tag of task.skillTags) {
      if (usage[tag]) hits.add(tag);
    }
    // 路径 2：工具集合覆盖率推断（当前默认）
    if (hits.size === 0 && inferenceEnabled) {
      const taskTools = new Set(task.toolSequence);
      for (const s of skills) {
        if (!s.tools.length) continue;
        const declared = new Set(s.tools);
        let inter = 0;
        for (const t of taskTools) if (declared.has(t)) inter++;
        const coverage = inter / declared.size;
        if (coverage >= minToolCoverage) hits.add(s.name);
      }
    }
    if (hits.size === 0) continue;
    matchedTasks++;
    const lastIso = new Date(task.endedAt ?? task.startedAt).toISOString();
    const firstIso = new Date(task.startedAt).toISOString();
    for (const name of hits) {
      const u = usage[name];
      u.useCount += 1;
      if (!u.lastUsedAt || lastIso > u.lastUsedAt) u.lastUsedAt = lastIso;
      if (!u.firstUsedAt || firstIso < u.firstUsedAt) u.firstUsedAt = firstIso;
    }
    okSum += task.okCount;
    totalSum += task.totalCount;
    latencySum += task.latencySumMs;
    latencyCount += task.latencySampleCount;
  }

  // 全局成功率/耗时（阶段 1 不做技能级细分：样本太小，细分反而失真）
  const globalSuccessRate = totalSum ? +(okSum / totalSum).toFixed(4) : null;
  const globalAvgLatency = latencyCount ? Math.round(latencySum / latencyCount) : null;
  for (const name of Object.keys(usage)) {
    const u = usage[name];
    if (u.useCount > 0) {
      u.successRate = globalSuccessRate;
      u.avgDurationMs = globalAvgLatency;
      u.avgTokenCost = null; // tool-stats 无 token 计量，恒 null（如实标注）
    }
  }

  const inference = tasksWithSkillField > 0 ? 'explicit' : (inferenceEnabled ? 'inferred' : 'disabled');
  return { usage, matchedTasks, unmatchedTasks: tasks.length - matchedTasks, inference };
}

export { DAY_MS };
