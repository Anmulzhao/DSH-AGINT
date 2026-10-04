/**
 * lib/staging.js — Sprint 15 T1 候选物化（设计稿 §5.1）
 *
 * 评估前把候选草稿物化到磁盘：
 *   $DSH_HOME/storages/agint_skill_autocreate/staging/<candidateId>/
 *     ├── SKILL.md        ← frontmatter + body（质量静态检查 / 沙箱的执行对象）
 *     └── manifest.json   ← 最小元数据（名称/版本/工具/触发器 + 候选来源）
 *
 * 生命周期：
 *   - createStaging()：评估开始时创建（幂等，重复调用只重建不报错）
 *   - cleanupCandidate()：单候选终态后由调用方决定清理（默认保留至 TTL）
 *   - cleanupStale()：终态后 7 天 TTL 兜底清理（设计稿 §5.1 TTL=7d；聚合
 *     日调度顺路执行，无独立 cron）
 *
 * 安全：candidateId 仅允许 [A-Za-z0-9_-]（datedId 生成），防路径穿越。
 */

import { mkdir, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { renderModelFrontmatter, normalizeModelScope } from './model-scope.js';

export const STAGING_SUBDIR = 'staging';
export const DEFAULT_TTL_DAYS = 7;

export function stagingRootFor(dshHome, domain = 'agint_skill_autocreate') {
  if (!dshHome) throw new Error('staging: dshHome is required');
  return resolve(dshHome, 'storages', domain, STAGING_SUBDIR);
}

const CANDIDATE_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

export function assertSafeCandidateId(id) {
  if (typeof id !== 'string' || !CANDIDATE_ID_RE.test(id)) {
    throw new Error(`staging: unsafe candidateId '${id}'`);
  }
}

/**
 * YAML 标量加引号（**只在该加时加**）。
 *
 * 模型名里会出现 `minimax-cn/MiniMax-M3.1-Flash-Preview` 这类含 `/` `.` `-`
 * 的串，以及 `provider/model` 形态。YAML 里 `/` 与 `.` 开头在特定位置有语法
 * 含义（`/` 无、`~` 与 `*` 有），未加引号的 `~`/`*` 开头会解析失败 → 整个
 * frontmatter 报错 → **宿主静默忽略整个技能文件**（最高危的失效形态）。
 * 所以这里对**所有**模型相关标量一律加引号：多余引号 YAML 会正确去掉，
 * 漏引号则可能让技能凭空消失。代价为零。
 */
function yamlScalar(value) {
  const s = String(value ?? '');
  if (s === '') return '""';
  const needsQuote = /^[~*&!%@`>|{}[\]#,"']/.test(s)   // YAML 有语法意义的起始字符
    || /:\s/.test(s)                                   // ": " 会被解析成嵌套映射
    || /\s#/.test(s)                                   // " #" 会被当注释起点
    || /^\s|\s$/.test(s)                               // 首尾空格会被 YAML trim
    || s.includes(String.fromCharCode(10));
  if (!needsQuote) return s;
  return '"' + s.split('\\').join('\\\\').split('"').join('\\"') + '"';
}

/**
 * 模型字段的 frontmatter 块（2026-10-03）。
 * 形态（扁平键，便于 grep）：
 *   model-scope: observed|unknown
 *   verified-on: [provider/model, ...]      # 空则 []
 *   verified-on-note: <一句话说明>
 * 取证：宿主 `dsh-skill-filesystem` 的 `parseSkillFile` 只挑
 * name / description / whenToUse / metadata / 两个 invocation 布尔 ⇒
 * **额外 frontmatter 键被忽略而不报错**（不会导致技能被忽略）。
 */
function modelFrontmatterLines(scope) {
  const fm = renderModelFrontmatter(scope);
  const lines = [`model-scope: ${yamlScalar(fm['model-scope'])}`];
  const verified = Array.isArray(fm['verified-on']) ? fm['verified-on'] : [];
  if (verified.length) {
    lines.push('verified-on:');
    for (const v of verified) lines.push(`  - ${yamlScalar(v)}`);
  } else {
    lines.push('verified-on: []');
  }
  lines.push(`verified-on-note: ${yamlScalar(fm['verified-on-note'])}`);
  return lines;
}

/** SKILL.md 渲染：frontmatter（name/description/triggers/tools + 模型归属）+ body */
export function renderSkillMd(draft) {
  const fm = draft?.frontmatter ?? {};
  const lines = ['---', `name: ${fm.name ?? draft.name ?? ''}`, `description: ${fm.description ?? draft.description ?? ''}`];
  const triggers = Array.isArray(fm.triggers) ? fm.triggers : [];
  const tools = Array.isArray(fm.tools) ? fm.tools : [];
  if (triggers.length) {
    lines.push('triggers:');
    for (const t of triggers) lines.push(`  - ${t}`);
  } else {
    lines.push('triggers: []');
  }
  if (tools.length) {
    lines.push('tools:');
    for (const t of tools) lines.push(`  - ${t}`);
  } else {
    lines.push('tools: []');
  }
  // 模型归属：只在草稿带 modelScope 时写（存量草稿 / 手工草稿保持原样输出，
  // 不凭空加一个 model-scope: unknown —— 那会把「本来就没这个维度」的
  // 人工技能说成「来源未知」，两者含义不同）。
  if (fm.modelScope !== undefined && fm.modelScope !== null) {
    lines.push(...modelFrontmatterLines(fm.modelScope));
  }
  lines.push('---', '');
  lines.push(draft?.body ?? '');
  return `${lines.join('\n')}\n`;
}

export function renderManifest(draft, candidateId, nowIso) {
  const fm = draft?.frontmatter ?? {};
  const manifest = {
    name: fm.name ?? draft.name,
    version: '0.0.0',               // 候选评估版本，发布时由 release 侧正式定版
    description: fm.description ?? draft.description,
    category: draft?.category ?? 'productivity',
    template: draft?.template ?? '',
    tools: Array.isArray(fm.tools) ? fm.tools : [],
    triggers: Array.isArray(fm.triggers) ? fm.triggers : [],
    references: draft?.references ?? [],
    scripts: draft?.scripts ?? [],
    candidateId,
    createdAt: nowIso,
    stagedBy: 'agint-skill-autocreate/sprint15',
  };
  // 模型归属的**完整**清单（2026-10-03）：SKILL.md 的 frontmatter 只列展示用的
  // 前 N 个（见 renderModelFrontmatter 的 MODELS_DISPLAY_MAX），完整占比与
  // 消息数留在这里 —— 「完整清单见 manifest.json」这句话必须真的找得到。
  // 存量/手工草稿无 modelScope → 不加这个键（不凭空声明一个 unknown）。
  const scope = normalizeModelScope(fm.modelScope ?? draft?.modelScope);
  if (fm.modelScope !== undefined && fm.modelScope !== null) {
    manifest.modelScope = scope;
  }
  return manifest;
}

/**
 * 物化候选到 staging（幂等：同 candidateId 已存在则覆盖重建）。
 * @returns {{ dir: string, files: string[] }}
 */
export async function createStaging(candidate, opts = {}) {
  const id = candidate?.id;
  assertSafeCandidateId(id);
  const root = stagingRootFor(opts.dshHome);
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });

  const skillMd = renderSkillMd(candidate.skillDraft);
  const manifest = renderManifest(candidate.skillDraft, id, opts.nowIso ?? new Date().toISOString());

  await writeFile(join(dir, 'SKILL.md'), skillMd, 'utf8');
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // scripts 目录：候选带脚本时一并物化（Phase 2 可执行物判定依据）
  const scripts = candidate.skillDraft?.scripts ?? [];
  if (scripts.length) {
    const scriptsDir = join(dir, 'scripts');
    await mkdir(scriptsDir, { recursive: true });
    for (let i = 0; i < scripts.length; i++) {
      const s = scripts[i];
      // 支持两种形态：字符串 = 脚本内容（自动命名 script_<i>.sh）；对象 = {name, content}
      const fileName = typeof s === 'string' ? `script_${i}.sh` : (s?.name ?? `script_${i}.sh`);
      const content = typeof s === 'string' ? s : (s?.content ?? '');
      if (!content) continue;
      // 防穿越：只允许脚本文件名，不接受子路径
      const safeName = fileName.split(/[\\/]/).pop();
      if (!safeName) continue;
      await writeFile(join(scriptsDir, safeName), content, 'utf8');
    }
  }

  return { dir, files: ['SKILL.md', 'manifest.json', ...(scripts.length ? ['scripts/'] : [])] };
}

/** 删除单个候选 staging（终态后调用；失败不抛，返回 false） */
export async function cleanupCandidate(candidateId, opts = {}) {
  assertSafeCandidateId(candidateId);
  const dir = join(stagingRootFor(opts.dshHome), candidateId);
  try {
    await rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * TTL 兜底清理：删除所有最后修改时间早于 now - ttlDays 的候选 staging。
 * @returns {{ removed: string[], scanned: number }}
 */
export async function cleanupStale(opts = {}) {
  const root = stagingRootFor(opts.dshHome);
  const ttlMs = (opts.ttlDays ?? DEFAULT_TTL_DAYS) * 24 * 60 * 60 * 1000;
  const now = opts.nowMs ?? Date.now();
  let names = [];
  try {
    names = await readdir(root);
  } catch {
    return { removed: [], scanned: 0, root };
  }
  const removed = [];
  for (const name of names) {
    if (!CANDIDATE_ID_RE.test(name)) continue;
    const dir = join(root, name);
    try {
      const s = await stat(dir);
      if (!s.isDirectory()) continue;
      if (now - s.mtimeMs > ttlMs) {
        await rm(dir, { recursive: true, force: true });
        removed.push(name);
      }
    } catch {
      // 单目录异常不阻断整体清理
    }
  }
  return { removed, scanned: names.length, root };
}
