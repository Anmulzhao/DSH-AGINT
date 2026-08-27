/**
 * lib/checkers/contract-reference.js — Sprint 10 #4 subagent 实现
 *
 * grep -r 'agint-quality-contract' <pluginDir> --include=*.js --include=*.mjs
 * 0 命中原则（设计稿 §二.3 + §七 L0-frozen 保护）。
 * 任何引用都判定为 L0 污染 → blocker finding。
 *
 * 设计稿 §二.3 表格：contract-reference = blocker
 *
 * 行数预算（设计稿 §十.1）：单 checker ≤80 行
 *
 * 注：本 checker 字符串 'agint-quality-contract' 出现于本文件源代码是**实现需要**，
 *     不是污染 —— 但 Sprint 10 #4 subagent 应理解这点，避免误报自身。
 *     实际扫的是 pluginDir/*.js，**不**扫 checker 自己。
 */

import { readFileSync } from 'node:fs';
import { collectSourceFiles } from './scan-files.js';

const CONTRACT_PATTERN = /agint-quality-contract/g;

export async function checkContractReference({ pluginDir, profile }) {
  const findings = [];
  // collectSourceFiles 已跳过 lib/checkers/（本文件所在目录）+ node_modules/，
  // 因此本 checker 的 pattern 常量不会被自身命中（self-scan 防护）。
  for (const file of collectSourceFiles(pluginDir)) {
    let lines;
    try { lines = readFileSync(file, 'utf8').split('\n'); } catch { continue; }
    for (let i = 0; i < lines.length; i += 1) {
      for (const _match of lines[i].matchAll(CONTRACT_PATTERN)) {
        const location = `${file}:${i + 1}`;
        findings.push({
          family: 'contract-reference',
          severity: 'blocker',
          message: `agint-quality-contract reference found at ${location}`,
          location,
        });
      }
    }
  }
  return findings;
}