/**
 * lib/checkers/scan-files.js — Sprint 10 #4 共享文件枚举
 *
 * 3 个源码级 checker（storage-boundary / env-access / contract-reference）共用的
 * 目标文件枚举逻辑：pluginDir/lib/**\/*.js + pluginDir/index.js。
 *
 * self-scan 防护（设计稿 §七）：跳过 node_modules/ 与 lib/checkers/ ——
 * checker 自身必然含被检模式（正则常量、domain 名），扫自己 100% 误报。
 *
 * 行数预算：≤40 行
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'checkers', '.git']);

/** 递归收集 dir 下所有 .js 文件（跳过 SKIP_DIRS）。 */
function walk(dir, out) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(full, out);
    } else if (entry.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

/** 返回待扫源码文件绝对路径数组。 */
export function collectSourceFiles(pluginDir) {
  const files = walk(resolve(pluginDir, 'lib'), []);
  const rootIndex = resolve(pluginDir, 'index.js');
  if (existsSync(rootIndex)) files.push(rootIndex);
  return files;
}
