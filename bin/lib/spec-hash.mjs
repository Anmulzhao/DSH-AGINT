// bin/lib/spec-hash.mjs —— 协议 schemaHash 计算（build-spec-index 与 check-spec-consistency 共用）
//
// ⭐ 为什么要抽出来：生成器与门禁都要算 hash。两份实现必然会分叉
//    （改了一处忘了另一处 ⇒ 门禁永远绿或永远红）。
//    与 K110「官方 bundle 存在 ⇒ 自研作废」同源：同一语义只有一处实现。
//
// 口径（**改动此口径会作废所有已登记的 hash**，须升 INDEX_VERSION）：
//   · 只对 `*.schema.json` 算 hash（人读的 .md 不算）
//   · 用 textHash（文件字节）而**不是** canonicalHash（解析后重排）
//     理由：schema 的字节就是契约；只改格式没改语义也是改动，
//     而那恰恰是 code review 该看见的 diff。
//   · `sha256:` 前缀

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { textHash } from './canonical-json.mjs';

/**
 * 算出某份规范登记项的 schemaHash。
 * @param {{ files?: string[] }} spec 登记项（只需 files）
 * @param {string} specsDir docs/specs/ 绝对路径
 * @returns {string|null} `sha256:...` 或 null（无 schema 文件）
 */
export function computeSpecHash(spec, specsDir) {
  const machine = (spec.files ?? []).filter((f) => f.endsWith('.schema.json'));
  if (machine.length === 0) return null;
  if (machine.length > 1) {
    throw new Error(
      `spec 有多个 schema 文件，hash 口径未定义：${machine.join(', ')}。` +
        `⇒ 要么合并成一个，要么在 INDEX_VERSION 里定义多文件 hash 口径（当前未定义）。`,
    );
  }
  const p = join(specsDir, machine[0]);
  if (!existsSync(p)) return null; // 文件缺失交给调用方报「悬空引用」，不重复报 hash
  return textHash(readFileSync(p, 'utf8'), { prefix: true });
}

/**
 * 批量算：返回 { specId: schemaHash }。
 * @param {Array<{id:string, files?:string[]}>} specs
 * @param {string} specsDir
 * @returns {Record<string,string>}
 */
export function computeSpecHashes(specs, specsDir) {
  const out = {};
  for (const s of specs) {
    const h = computeSpecHash(s, specsDir);
    if (h) out[s.id] = h;
  }
  return out;
}
