/**
 * agint-quality-sdk/lib/check-all.js — Prompt SDK 批量静态检查器（Sprint 6.1）
 *
 * Sprint 6 接入 D-QAF 流水线入口:
 *   - cron job prompt-static-check 调 batchStaticCheck()
 *   - 扫所有 prompt manifest + template, 跑 staticCheck
 *   - blocker → 返回 failure records (给 caller 写 evo)
 *
 * 纯函数 + 显式 dependency injection (paths)
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { staticCheckPrompt } from './static-check.js';

/** Prompt candidate source: 一个 manifest + template path pair. */
export async function discoverPromptTargets({ manifestsRoots = [] } = {}) {
  const targets = [];
  for (const root of manifestsRoots) {
    if (!existsSync(root)) continue;
    // search "**/manifest.json" by greedy fs walk (avoids glob dep)
    await walkDir(root, async (filePath) => {
      if (!filePath.endsWith('manifest.json')) return;
      try {
        const content = JSON.parse(await readFile(filePath, 'utf8'));
        const dirName = filePath.replace(/\/manifest\.json$/, '');
        const templatePath = join(dirName, 'template.md');
        if (!existsSync(templatePath)) return;
        const templateText = await readFile(templatePath, 'utf8');
        targets.push({
          manifestPath: filePath,
          templatePath,
          manifest: content,
          templateText,
        });
      } catch {
        // skip malformed manifest; do not throw
      }
    });
  }
  return targets;
}

async function walkDir(dir, visitor) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      await walkDir(p, visitor);
    } else if (e.isFile()) {
      await visitor(p);
    }
  }
}

/**
 * Run static-check on all discovered targets. Returns aggregate report:
 *
 * @param {object} args
 * @param {string[]} args.manifestsRoots  — paths to walk
 * @returns {Promise<{
 *   totalScanned: number,
 *   cleanCount: number,
 *   blockerCount: number,
 *   warnCount: number,
 *   failures: Array<{
 *     manifestPath: string,
 *     targetId: string,           // name@version
 *     blockers: number,
 *     warns: number,
 *     violationCodes: string[],
 *     firstViolation: string,
 *   }>,
 *   summaries: Array<{ manifestPath, targetId, ok, blockers, warns }>,
 * }>}
 */
export async function batchStaticCheck({ manifestsRoots = [] } = {}) {
  const targets = await discoverPromptTargets({ manifestsRoots });
  const summaries = [];
  const failures = [];
  for (const t of targets) {
    const result = staticCheckPrompt({ templateText: t.templateText, manifest: t.manifest });
    summaries.push({
      manifestPath: t.manifestPath,
      targetId: `${t.manifest.name}@${t.manifest.version}`,
      ok: result.ok,
      blockers: result.blockers,
      warns: result.warnings,
    });
    if (!result.ok) {
      failures.push({
        manifestPath: t.manifestPath,
        targetId: `${t.manifest.name}@${t.manifest.version}`,
        blockers: result.blockers,
        warns: result.warnings,
        violationCodes: [...new Set(result.violations.map((v) => v.code))],
        firstViolation: result.violations[0]?.message ?? '',
      });
    }
  }
  return {
    totalScanned: targets.length,
    cleanCount: summaries.filter((s) => s.ok).length,
    blockerCount: failures.length,
    warnCount: summaries.filter((s) => !s.ok).length,
    failures,
    summaries,
  };
}

/**
 * Convenience: 把 failures 转 evo.addFailure 调用 (caller 提供 evo ctx).
 * 返回 recorded 数组 (供 caller 落地审计).
 */
export async function reportFailuresToEvo({ batchReport, evo }) {
  if (!evo || typeof evo.addFailure !== 'function') return [];
  const recorded = [];
  for (const f of batchReport.failures ?? []) {
    const pattern = `prompt-static:${f.violationCodes[0] ?? 'UNKNOWN'}`;
    const r = await evo.addFailure({
      pattern,
      category: 'prompt',
      severity: f.blockers > 0 ? 'high' : 'medium',
      evidence: JSON.stringify({ manifestPath: f.manifestPath, ...f }),
    });
    recorded.push(r);
  }
  return recorded;
}
