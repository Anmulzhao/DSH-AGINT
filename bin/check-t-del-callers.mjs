#!/usr/bin/env node
/**
 * check-t-del-callers.mjs —— 存储表删除 API 误用静态护栏（`t.del` ⇒ `t.delete`）
 *
 * ── 背景（2026-11-12 实测取证）────────────────────────────────────────────
 * 宿主 dsh-storage-domain 的表 API **只有** 两个删除方法：
 *   delete(key: K): Promise<boolean>            —— domain.d.ts:70
 *   deleteMany(keys: readonly K[]): Promise<number> —— domain.d.ts:86
 * **没有 `del`**（`@deepseek-ai/dsh-storage-domain/lib/types/domain.d.ts`，
 * 本机实际路径在 dsh/node_modules/ 下）。
 *
 * 但仓内有 5 处调用了 `t.del(...)`：
 *   plugins/agint-skill-autocreate/lib/index.js:172  ? (key) => t.del(key)
 *   plugins/agint-curator/lib/index.js:108          typeof t.del === 'function' ? ...
 *   plugins/agint-curator/lib/index.js:267          await t.del(key).catch(() => {})
 *   plugins/agint-skill-graph/lib/index.js:444      await edgeTable.del(key).catch(() => {})
 *   plugins/agint-curriculum/lib/index.js:169        typeof t.del === 'function' ? ...
 *
 * 后果：**滚动清理从未真的删掉任何一行**（假上限）。
 *   · `t.del` 恒为 undefined → `typeof t.del === 'function'` 恒 false ⇒ 整块跳过；
 *   · 或 `t.del(...)` 抛 TypeError 被 `.catch(() => {})` **静默吞掉**。
 * 两处形态都表现为「删了但其实没删」，且生产表未到上限前这段代码根本不会被触发
 * ⇒ 问题长期隐身（2026-11-12 实测：audit_log 72 行 / curation_actions 10 行 /
 * challenges 6 行，均远低于 1000 行上限）。
 *
 * ── 判据 ──────────────────────────────────────────────────────────────────
 * 扫 plugins 目录下每个插件的 lib 子树（**生产代码**，不含 test/）里所有
 * `.del(` 调用。
 * 命中即 exit 1 —— **不做 warn-only 豁免**：一个只打印警告的门禁等于没有门禁
 * （check-soundness §一：静默降级的检查器比没有检查器更危险）。
 *
 * 正则说明：`/\.del\s*\(/g` —— `.delete(` / `.deleteMany(` **不会**命中
 * （"del" 后面不是左括号），因此不会误报正确写法。
 *
 * 用法：node bin/check-t-del-callers.mjs               → 扫仓内 plugins/
 *      node bin/check-t-del-callers.mjs --root <dir>   → 扫指定目录（如部署位）
 *      node bin/check-t-del-callers.mjs --json         → 机器可读输出
 *
 * 退出码：0 = 无违规 / 1 = 有 `.del(` 调用
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const rootIdx = argv.indexOf('--root');
const SCAN_ROOT = rootIdx >= 0 && argv[rootIdx + 1]
  ? argv[rootIdx + 1]
  : join(REPO_ROOT, 'plugins');

/** 违规正则：`.del(` —— 不匹配 `.delete(` / `.deleteMany(` */
const BAD = /\.del\s*\(/g;

/** 递归收集 plugins/<plugin>/lib 下的生产代码文件 */
export function walkLibFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkLibFiles(p, out);
    else if (e.isFile() && /\.(js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 单文件源码 → 命中列表（纯函数，便于测试） */
export function checkSource(src, label = '<string>') {
  const hits = [];
  for (const m of src.matchAll(BAD)) {
    const lineNo = src.slice(0, m.index).split('\n').length;
    const lineText = src.split('\n')[lineNo - 1]?.trim() ?? '';
    hits.push({ file: label, line: lineNo, text: lineText });
  }
  return hits;
}

/** 扫一个 plugins 根目录 → 命中列表 */
export function scanPluginsRoot(root = SCAN_ROOT) {
  const hits = [];
  let pluginDirs;
  try {
    pluginDirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('agint-'))
      .map((e) => join(root, e.name));
  } catch {
    return hits;
  }
  for (const pluginDir of pluginDirs) {
    const libDir = join(pluginDir, 'lib');
    try {
      if (!statSync(libDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const f of walkLibFiles(libDir)) {
      const src = readFileSync(f, 'utf8');
      const label = relative(root, f).replace(/\\/g, '/');
      hits.push(...checkSource(src, label));
    }
  }
  return hits;
}

const hits = scanPluginsRoot(SCAN_ROOT);

if (AS_JSON) {
  console.log(JSON.stringify({ scanRoot: SCAN_ROOT, hits }, null, 2));
} else if (hits.length > 0) {
  console.error('✗ 存储表删除 API 误用：宿主表 API 只有 delete(key)/deleteMany(keys)，没有 del');
  console.error('  （t.del 恒为 undefined ⇒ 删除静默失败 ⇒ 上限/清理是假上限）');
  for (const h of hits) {
    console.error(`${h.file}:${h.line}  ${h.text}`);
  }
  console.error(`\n共 ${hits.length} 处。修法：t.del(key) → t.delete(key)。`);
} else {
  console.log(`✓ 存储表删除 API 用法检查通过（扫描 ${SCAN_ROOT}，无 \`.del(\` 调用）`);
}

if (hits.length > 0) process.exit(1);
