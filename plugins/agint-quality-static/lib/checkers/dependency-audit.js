/**
 * lib/checkers/dependency-audit.js — Sprint 10 #4 subagent 实现
 *
 * 解析 pluginDir/package.json 的 dependencies / peerDependencies / devDependencies，
 * 比对 profile.allowedDeps 白名单。命中未授权依赖 → finding { family: 'dependency-audit', severity: 'blocker' }。
 *
 * 设计稿 §二.3 表格：dependency-audit = blocker
 *
 * 行数预算（设计稿 §十.1）：单 checker ≤80 行
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export async function checkDependencyAudit({ pluginDir, profile }) {
  const findings = [];
  const pkgPath = resolve(pluginDir, 'package.json');
  if (!existsSync(pkgPath)) {
    findings.push({ family: 'dependency-audit', severity: 'blocker', message: `package.json not found at ${pkgPath}`, location: pkgPath });
    return findings;
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    findings.push({ family: 'dependency-audit', severity: 'blocker', message: `package.json parse error: ${e.message}`, location: pkgPath });
    return findings;
  }
  const names = new Set();
  for (const field of ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies']) {
    const block = pkg[field];
    if (block && typeof block === 'object') for (const n of Object.keys(block)) names.add(n);
  }
  for (const name of names) {
    if (isPlatformOrOwnDep(name)) continue;
    if (profile.allowedDeps.has(name)) continue;
    findings.push({
      family: 'dependency-audit',
      severity: 'blocker',
      message: `unauthorized dependency: ${name}`,
      location: pkgPath,
    });
  }
  return findings;
}

/** dsh 平台依赖 + agint 自家插件依赖 + node 内建视为合法。 */
function isPlatformOrOwnDep(name) {
  if (name.startsWith('node:')) return true;
  if (name.startsWith('@deepseek-ai/agint-')) return true;
  if (name.startsWith('@deepseek-ai/dsh-')) return true;
  return false;
}