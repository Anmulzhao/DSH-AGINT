/**
 * lib/checkers/env-access.js — Sprint 10 #4 subagent 实现
 *
 * AST / 正则扫描 pluginDir/lib/ 下所有 .js，定位 process.env.<NAME> 或
 * process.env[<NAME>] 访问，对照 profile.envAllowlist。
 *
 * 设计稿 §二.3 表格：env-access = warn（设计稿 §六 §6.5 误报阻断缓解）
 *
 * 行数预算（设计稿 §十.1）：单 checker ≤80 行
 */

import { readFileSync } from 'node:fs';
import { collectSourceFiles } from './scan-files.js';

const ENV_ACCESS_PATTERNS = [
  /\bprocess\.env\.([A-Z_][A-Z0-9_]*)\b/g,
  /\bprocess\.env\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
];

export async function checkEnvAccess({ pluginDir, profile }) {
  const findings = [];
  for (const file of collectSourceFiles(pluginDir)) {
    let lines;
    try { lines = readFileSync(file, 'utf8').split('\n'); } catch { continue; }
    for (let i = 0; i < lines.length; i += 1) {
      const seen = new Set();
      for (const re of ENV_ACCESS_PATTERNS) {
        for (const match of lines[i].matchAll(re)) {
          const varName = match[1];
          if (!varName || seen.has(varName)) continue;
          seen.add(varName);
          if (profile.envAllowlist.has(varName)) continue;
          findings.push({
            family: 'env-access',
            severity: 'warn',
            message: `direct process.env access: ${varName}`,
            location: `${file}:${i + 1}`,
          });
        }
      }
    }
  }
  return findings;
}