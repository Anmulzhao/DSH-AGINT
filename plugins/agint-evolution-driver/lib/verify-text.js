/**
 * agint-evolution-driver/lib/verify-text.js —— 在内存里验证「最终文本」。
 *
 * ## 为什么需要它
 *
 * 提案级全组事务要求「先全部验证、再一次性写盘」。旧的 `verifyTargetFile()`
 * 是从**磁盘**读文件再跑 `node --check`，写法是「先写后验」—— 事务里不能用。
 * 本函数对一段还没落盘的 postimage 文本做同一套语法检查。
 *
 * ## 口径与 verifyTargetFile 对齐（不引入第二套判据）
 *
 *   · `.js` 若含顶层 import/export ⇒ 按 ESM 检（复制成 `.mjs`），否则按 CJS。
 *     这一步不能省：`node --check` 对含 ESM 标记的 `.js` 恒返回 0，会漏检语法错。
 *   · `.mjs` / `.cjs` 自带语义，直接检。
 *   · `.sh` / `.bash` ⇒ `bash -n`（只解析，不执行）。
 *   · `.json` ⇒ JSON.parse。
 *   · 其他扩展名（.md/.yaml/.txt…）⇒ 跳过，由 policy 定夺。
 *
 * ⛔ 只做语法/结构验证，不做语义验证（import 是否真的存在、跨文件引用是否成立
 *    需要工作区里所有文件都在位才能判，属于「写盘之后」的事，本函数不承诺）。
 *
 * 返回 `{ ok, mode, reason?, skipped? }`。
 */

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export function normalizeRelPath(relPath) {
  return String(relPath ?? '').split('\\').join('/').replace(/^\.\//, '');
}

/**
 * @param {object} opts
 * @param {string} opts.relPath 仓库相对路径（决定用哪种验证器）
 * @param {string} opts.text 还没写盘的最终文本
 * @returns {Promise<{ok:boolean, mode:string, reason?:string, skipped?:boolean}>}
 */
export async function verifyPostimageText({ relPath, text } = {}) {
  const norm = normalizeRelPath(relPath);
  if (!norm || norm.includes('..')) return { ok: false, mode: 'none', reason: `unsafe path: ${norm}` };
  if (typeof text !== 'string' || !text.trim()) return { ok: false, mode: 'none', reason: 'empty postimage' };

  const dot = norm.lastIndexOf('.');
  const ext = dot < 0 ? '' : norm.slice(dot).toLowerCase();

  if (ext === '.json') {
    try { JSON.parse(text); return { ok: true, mode: 'json' }; }
    catch (e) { return { ok: false, mode: 'json', reason: `JSON parse failed: ${e?.message ?? e}` }; }
  }

  const isShell = ext === '.sh' || ext === '.bash';
  const isJs = ext === '.js' || ext === '.mjs' || ext === '.cjs';
  if (!isShell && !isJs) {
    return { ok: true, mode: 'skip', skipped: true, reason: `no syntax concept for '${ext || '(no ext)'}'` };
  }

  // `.js` 判 ESM：是则改用 `.mjs` 扩展名，绕开 node --check 的 CJS 漏检。
  const looksEsm = ext === '.js' && /^[ \t]*(?:import[ \t{*'"]|export[ \t{*])/m.test(text);
  const suffix = isShell ? '.sh' : (looksEsm ? '.mjs' : ext);
  const tmp = join(tmpdir(), `agint-postimage-${randomUUID()}${suffix}`);
  try {
    await writeFile(tmp, text, 'utf8');
    const [cmd, args] = isShell ? ['bash', ['-n', tmp]] : [process.execPath, ['--check', tmp]];
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000 });
    if (r.error) return { ok: false, mode: isShell ? 'shell' : 'syntax', reason: String(r.error?.message ?? r.error) };
    if (r.status !== 0) {
      return {
        ok: false, mode: isShell ? 'shell' : 'syntax',
        reason: `${cmd} exited ${r.status}: ${String(r.stderr ?? '').trim().slice(0, 300)}`,
      };
    }
    return { ok: true, mode: isShell ? 'shell' : 'syntax' };
  } finally {
    try { await rm(tmp, { force: true }); } catch { /* 临时文件清理失败不影响验证结论 */ }
  }
}
