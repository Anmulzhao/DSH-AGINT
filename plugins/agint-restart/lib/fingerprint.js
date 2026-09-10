/**
 * agint-restart v0.8.0 —— 运行中代码指纹
 *
 * 解决的问题（2026-09-11 一夜里重复踩了 3 次）：改完插件无法一眼确认"跑着的进程到底是哪版代码"。
 * 当时只能靠间接指纹推断——marker 有没有被重新 apply 重写、日志里有没有该版本独有的行、
 * 或者手动 import host 文件比对。而 HMR 到底有没有重载，一直没有确定答案。
 *
 * 做法：apply 时对本插件 `lib/*.js` 算一个聚合 sha256（取前 12 位十六进制）记进 marker 与 status()；
 * status() 每次都重新算一遍磁盘上的指纹并对比：
 *   - 相等 → codeStale=false（运行中的代码 == 磁盘上的代码）
 *   - 不等 → codeStale=true（磁盘改过了，进程里还是旧的 → 要么等 HMR，要么重启）
 * 于是"是否需要重启"从推断变成事实，且顺带回答了"HMR 到底有没有重载"。
 *
 * 只读、纯函数、绝不抛：任何异常都返回 null，不能让诊断能力反过来把插件搞挂。
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 参与指纹的文件后缀（默认 .js；测试可用 .mjs 等） */
const DEFAULT_EXT = '.js';

/**
 * 算一个目录下所有匹配文件的聚合指纹。
 * 顺序敏感：**按文件名字典序**，先各自 sha256，再对 "文件名\0哈希\0" 序列做一次 sha256。
 * 这样重命名、增删、改内容都会变；而文件系统遍历顺序变化不会变。
 *
 * @param {string} dir 目录
 * @param {{ext?: string}} [opts]
 * @returns {string|null} 12 位十六进制，出错返回 null
 */
export function codeFingerprint(dir, opts = {}) {
  const ext = opts.ext ?? DEFAULT_EXT;
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .sort();
    if (files.length === 0) return null;
    const outer = createHash('sha256');
    for (const f of files) {
      const inner = createHash('sha256').update(readFileSync(join(dir, f))).digest('hex');
      outer.update(f).update('\0').update(inner).update('\0');
    }
    return outer.digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

/** 两个指纹是否不同（null 与 null 视为相同：都算不出来时不下"变了"的结论） */
export function fingerprintChanged(a, b) {
  if (a == null && b == null) return false;
  return a !== b;
}
