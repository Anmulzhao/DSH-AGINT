/**
 * agint-skill-graph: 取数层 —— 节点全集扫描 + 技能级调用聚合（P2-2 §3.3）。
 *
 * 两条真实口径（v0.2 起，全部实测）：
 *   主口径（唯一在产）：tool-stats 里 `tool === 'skill'` 的记录，技能名取 `args.name`。
 *     依据：`skill` 工具就是"加载某技能"的宿主入口；实测本机 7815 条中 86 条命中。
 *     ⚠️ 局限：只覆盖"显式加载技能"这一种形态；隐式使用（模型自行遵守规范而不加载）
 *     无法捕捉 —— 如实标注，不假装全知。
 *   辅口径（待 P2-1 补 `skillName` 字段后启用）：轨迹里的技能级记录 → 才有 successRate。
 *     在此之前 `successRate` 一律 null，不编造。
 *
 * 节点全集（§2.1 R8）：presetsDir 下每个 preset 的 skills/{技能名}/SKILL.md，
 * **不以 curator 运行时快照为全集**。
 * 复用 curator 的 `parseFrontmatter`（不写第五份 frontmatter 解析器）与 `isExcludedRecord`。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { parseFrontmatter } from '../../agint-curator/lib/aggregator.js';
import { isExcludedRecord } from './schema.js';

const DAY_MS = 86_400_000;

/**
 * 一个技能根目录下的技能清单（返回节点草稿数组 + 失败计数）。
 * 根的直接子目录即技能目录（一层深）：`<root>/<技能名>/SKILL.md`。
 *
 * @param skillsDir - 技能根
 * @param source - 来源标签，写入节点的 `preset` 字段。真实 preset 名，
 *                 或 `@user`（额外技能根，见 schema.extraSkillDirs）
 */
async function scanSkillRoot(skillsDir, source) {
  let entries = [];
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return { nodes: [], failures: 0 }; // 该根无 skills 目录 → 空，不抛
  }
  const nodes = [];
  let failures = 0;
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue; // .archive 等不扫
    const path = join(skillsDir, ent.name, 'SKILL.md');
    try {
      const [text, st] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      const fm = parseFrontmatter(text);
      const skillName = typeof fm.name === 'string' && fm.name ? fm.name : ent.name;
      nodes.push({
        skillName,
        dirName: ent.name,
        preset: source,
        path,
        description: typeof fm.description === 'string' ? fm.description : '',
        tools: Array.isArray(fm.tools) ? fm.tools : [],
        triggers: Array.isArray(fm.triggers) ? fm.triggers : [],
        relatedSkills: Array.isArray(fm.related_skills) ? fm.related_skills : [],
        createdAt: new Date(
          Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs,
        ).toISOString(),
      });
    } catch {
      failures++; // SKILL.md 缺失/不可读 → 跳过并计数（宁可漏，不可错）
    }
  }
  return { nodes, failures };
}

/** 一个 preset 的技能清单 = 该 preset 目录下的 `skills/` 根 */
const scanPreset = (presetsDir, preset) =>
  scanSkillRoot(join(presetsDir, preset, 'skills'), preset);

/** 额外技能根的来源标签（非真实 preset 名；preset 名不含 `@`，不会撞） */
export const USER_SKILL_SOURCE = '@user';

/**
 * 扫全部预设 + 额外技能根 → 去重后的节点全集。
 * 去重键 = `skillName`（§4.3 不变量 5）；同名跨根的声明**取并集**
 * （relatedSkills / tools / triggers），`presets` 记录全部收录方。
 *
 * @param presetsDir - preset 容器目录（`<presetsDir>/<preset>/skills/<技能名>/SKILL.md`）
 * @param extraSkillDirs - 额外技能根（一层深，直接含 `<技能名>/SKILL.md`）。默认空；
 *   插件侧传 `config.extraSkillDirs`（含 `$DSH_HOME/skills`，见 schema 注释）。
 * @returns {{ nodes: Array, scanFailures: number }}
 */
export async function scanNodes(presetsDir, { extraSkillDirs = [] } = {}) {
  let presets = [];
  try {
    presets = (await readdir(presetsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    presets = []; // presetsDir 不存在 → 只扫额外根，仍不抛（fail-open）
  }

  const byName = new Map();
  let scanFailures = 0;
  /** 同名节点合并。declarations：每条 related 声明的溯源（哪份 SKILL.md 声明了谁） */
  const merge = (nodes) => {
    for (const n of nodes) {
      const ex = byName.get(n.skillName);
      if (!ex) {
        byName.set(n.skillName, { ...n, presets: [n.preset], declarations: { [n.path]: n.relatedSkills } });
        continue;
      }
      if (!ex.presets.includes(n.preset)) ex.presets.push(n.preset);
      ex.tools = [...new Set([...ex.tools, ...n.tools])];
      ex.triggers = [...new Set([...ex.triggers, ...n.triggers])];
      ex.relatedSkills = [...new Set([...ex.relatedSkills, ...n.relatedSkills])];
      ex.declarations = { ...(ex.declarations ?? {}), [n.path]: n.relatedSkills };
      if (!ex.description && n.description) ex.description = n.description;
    }
  };

  for (const preset of presets) {
    const { nodes, failures } = await scanPreset(presetsDir, preset);
    scanFailures += failures;
    merge(nodes);
  }
  // 额外技能根（用户级，如 `$DSH_HOME/skills`）—— 2026-09-23 新增
  for (const dir of extraSkillDirs) {
    const { nodes, failures } = await scanSkillRoot(dir, USER_SKILL_SOURCE);
    scanFailures += failures;
    merge(nodes);
  }

  const nodes = [...byName.values()].sort((a, b) => a.skillName.localeCompare(b.skillName));
  return { nodes, scanFailures };
}

/** 读 JSONL（不存在 → 空数组，不抛） */
export async function readJsonl(path) {
  try {
    const text = await readFile(path, 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 主口径取数：`tool === 'skill'` → `args.name`。
 *
 * 丢弃必须可观测（§3.3 / §九）：
 *   - `skippedNoSkillField`：窗口内**无技能归属**的记录数（tool!=='skill' 或 args.name 缺失）
 *   - `unknownSkillName`：有技能名但该技能节点不在全集内（已归档/已删/拼写漂移）
 *
 * @returns {{ calls: Array<{ts,sessionId,skillName,ok,fingerprint}>, skippedNoSkillField, unknownSkillName, total }}
 */
export function collectSkillCalls(records, { lookbackDays = 180, nowMs = Date.now(), knownNames } = {}) {
  const since = nowMs - lookbackDays * DAY_MS;
  const known = knownNames instanceof Set ? knownNames : new Set(knownNames ?? []);
  const calls = [];
  let skippedNoSkillField = 0;
  let unknownSkillName = 0;

  for (const r of records ?? []) {
    if (isExcludedRecord(r)) continue;                       // 复用 curator 黑名单（不新写第 4 份）
    if (typeof r?.ts !== 'number') continue;
    if (r.ts < since || r.ts > nowMs + DAY_MS) continue;      // 容忍轻微时钟漂移
    const skillName = r.tool === 'skill' ? r?.args?.name : null;
    if (typeof skillName !== 'string' || !skillName) { skippedNoSkillField++; continue; }
    if (known.size && !known.has(skillName)) { unknownSkillName++; continue; }
    calls.push({
      ts: r.ts,
      sessionId: typeof r.sessionId === 'string' && r.sessionId ? r.sessionId : null,
      skillName,
      ok: r.ok === true,
      fingerprint: typeof r.argFingerprint === 'string' ? r.argFingerprint : null,
    });
  }
  calls.sort((a, b) => a.ts - b.ts);
  return { calls, skippedNoSkillField, unknownSkillName, total: (records ?? []).length };
}

/**
 * 技能级统计聚合。
 * `successRate` / `viewCount` / `patchCount` 恒 null —— 不是"还没算"，是**取不到**（§3.3）。
 */
export function aggregateUsage(nodes, calls) {
  const map = new Map();
  for (const n of nodes) {
    map.set(n.skillName, {
      skillName: n.skillName,
      dirName: n.dirName,
      presets: [...(n.presets ?? [])],
      calls: 0,
      viewCount: null,
      patchCount: null,
      successRate: null,
      lastUsedAt: null,
      firstUsedAt: null,
    });
  }
  for (const c of calls) {
    const u = map.get(c.skillName);
    if (!u) continue; // 已由 unknownSkillName 计数
    u.calls += 1;
    const iso = new Date(c.ts).toISOString();
    if (!u.lastUsedAt || iso > u.lastUsedAt) u.lastUsedAt = iso;
    if (!u.firstUsedAt || iso < u.firstUsedAt) u.firstUsedAt = iso;
  }
  return map;
}

export { DAY_MS };
