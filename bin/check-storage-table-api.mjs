#!/usr/bin/env node
/**
 * check-storage-table-api.mjs —— 存储表 API 误用静态护栏
 *
 * 背景（2026-09-26）：
 *   宿主 dsh-storage-domain 的 table API 长这样：
 *       get size() { return this.records.size; }                       ← 计数入口
 *       entries() { return [...this.records.entries()][Symbol.iterator](); }  ← 迭代器
 *   `entries()` 返回的是**迭代器**，迭代器没有 `.length`。因此
 *       X.entries().length
 *   恒为 `undefined`：
 *     - 表满守门 `if (X.entries().length >= CAP) throw` → **永不触发**（caps 全失效）
 *     - stats 报表 `{ reports: X.entries().length }`     → **恒为 undefined**
 *
 *   该写法曾在 9 个插件、38 处出现，把 reports 表放纵到 66,480 条（cap 是 50）。
 *
 * 正确写法：
 *   - 只要计数          → `X.size`
 *   - 要遍历/数组化     → `for (const [, v] of X.entries())` 或 `[...X.entries()].length`
 *
 * 用法：node bin/check-storage-table-api.mjs          → 违规即 exit 1
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'plugins');
const BAD = /\.entries\(\)\.length/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|mjs|ts|mts)$/.test(name)) out.push(p);
  }
  return out;
}

const violations = [];
for (const f of walk(ROOT)) {
  // 只扫生产代码：测试里允许**故意**引用该反模式来自证失效
  // （见 plugins/agint-diagnosis/test/cap-enforcement.test.mjs Case 0）。
  if (/[\\/]test[\\/]/.test(f)) continue;
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(BAD)) {
    const lineNo = src.slice(0, m.index).split('\n').length;
    violations.push(`${relative(ROOT, f).replace(/\\/g, '/')}:${lineNo}  ${m[0]}`);
  }
}

if (violations.length > 0) {
  console.error('✗ 存储表 API 误用：`.entries().length` 恒为 undefined（应改用 `.size`）');
  console.error(violations.join('\n'));
  console.error(`\n共 ${violations.length} 处。`);
  process.exit(1);
}

console.log('✓ 存储表 API 用法检查通过（无 `.entries().length` 误用）');
