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

/** SKILL.md 渲染：frontmatter（name/description/triggers/tools）+ body */
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
  lines.push('---', '');
  lines.push(draft?.body ?? '');
  return `${lines.join('\n')}\n`;
}

export function renderManifest(draft, candidateId, nowIso) {
  const fm = draft?.frontmatter ?? {};
  return {
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
