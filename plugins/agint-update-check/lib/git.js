/**
 * git 命令执行器 —— agint-update-check 唯一 fork 子进程的地方。
 *
 * 为什么要单独一层：本插件要读远端状态（ls-remote / fetch）并做快进合并，
 * 这两件事都会 fork 子进程。收敛在一个文件里便于：
 *   1) 单测用假实现替换（不碰真仓库）；
 *   2) 权限声明集中（manifest.permissions.shell = true 的唯一理由在此）。
 *
 * 纪律（红线）：
 *   - 只用 execFile + 参数数组，**不经过 shell** ⇒ 路径/分支名里的特殊字符不会被二次解释；
 *   - 每条命令都有超时 ⇒ 远端不可达时是「超时失败」而不是「挂死」；
 *   - 永不 reject：调用方按 ok/code 判断，避免一个网络抖动把整个插件炸掉。
 */
import { execFile } from 'node:child_process';

/** 单条 git 命令的默认超时（毫秒）。远端不可达时靠它兜底。 */
export const DEFAULT_TIMEOUT_MS = 20_000;

/** git 输出缓冲上限（字节）。diff --name-only 在超大仓库上可能很大。 */
const MAX_BUFFER = 8 * 1024 * 1024;

/**
 * 跑一条 git 命令，永远 resolve（不 reject）。
 *
 * @param {string[]} args git 参数数组（不含 git 本身）
 * @param {{cwd?: string, timeoutMs?: number, env?: Record<string,string>}} [opts]
 * @returns {Promise<{ok: boolean, code: number, stdout: string, stderr: string, error: string|null}>}
 */
export function runGit(args, opts = {}) {
  const cwd = opts.cwd;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = opts.env ? { ...process.env, ...opts.env } : process.env;
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout, windowsHide: true, maxBuffer: MAX_BUFFER, env, encoding: 'utf8' },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          error: err ? (err.message || String(err)) : null,
        });
      },
    );
  });
}

/**
 * 只取 stdout 的便捷封装：失败时返回 null。
 *
 * 调用方据此判定「没测到」，而不是把空串当成「测到了但是空的」。
 */
export async function gitOut(args, opts = {}) {
  const r = await runGit(args, opts);
  return r.ok ? r.stdout.trim() : null;
}