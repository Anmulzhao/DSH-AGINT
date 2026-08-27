/**
 * lib/checkers/storage-boundary.js — Sprint 10 #4 subagent 实现
 *
 * AST 扫描 pluginDir/lib/ + pluginDir/index.js，定位 fs.writeFile / fs.appendFile /
 * fs.createWriteStream 调用，校验：若写入路径包含 storage domain 目录，
 * **必须**经过 Service（ctx.<storageDomain>.write）调用，不能直接 fs。
 *
 * 设计稿 §二.3 表格：storage-boundary = blocker
 *
 * 行数预算（设计稿 §十.1）：单 checker ≤80 行
 *
 * 简化策略：Sprint 10 初版用正则匹配常见 fs.write 调用模式（不做完整 AST）；
 * 后续 Sprint 11+ 升级到 acorn parser。
 */

import { readFileSync } from 'node:fs';
import { collectSourceFiles } from './scan-files.js';

const FS_WRITE_PATTERNS = [
  /\bfs\.writeFile\s*\(/,
  /\bfs\.writeFileSync\s*\(/,
  /\bfs\.appendFile\s*\(/,
  /\bfs\.appendFileSync\s*\(/,
  /\bfs\.createWriteStream\s*\(/,
];

/** 命中行之后 5 行内的字符串字面量（含裸 domain 片段）。 */
const LOOKAHEAD_LINES = 5;

export async function checkStorageBoundary({ pluginDir, profile }) {
  const findings = [];
  for (const file of collectSourceFiles(pluginDir)) {
    let lines;
    try { lines = readFileSync(file, 'utf8').split('\n'); } catch { continue; }
    for (let i = 0; i < lines.length; i += 1) {
      if (!FS_WRITE_PATTERNS.some(re => re.test(lines[i]))) continue;
      const window = lines.slice(i, i + 1 + LOOKAHEAD_LINES).join('\n');
      const domain = findDomain(window, profile.storageDomains);
      if (!domain) continue;
      findings.push({
        family: 'storage-boundary',
        severity: 'blocker',
        message: `direct fs write to ${domain} bypasses service`,
        location: `${file}:${i + 1}`,
      });
    }
  }
  return findings;
}

/** 在窗口内的字符串字面量中查找任一合法 storage domain 名。 */
function findDomain(window, storageDomains) {
  for (const match of window.matchAll(/['"`]([^'"`\n]*)['"`]/g)) {
    const literal = match[1];
    for (const domain of storageDomains) {
      if (literal === domain || literal.includes(`${domain}/`) || literal.endsWith(`/${domain}`)) {
        return domain;
      }
    }
  }
  return null;
}