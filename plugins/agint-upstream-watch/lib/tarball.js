/**
 * agint-upstream-watch — tgz 解包（纯函数，零依赖）。
 *
 * ## 为什么自己解 tar
 *
 * 判读的核心立论是「不能只读 changelog，要看 API 真变没变」（设计方案 §6-1）。
 * 要做到这一点就得把 npm 上真正发布的包拉下来，比对里面的 `.d.ts`。
 *
 * 而 npm 包格式是 gzip 包一个 tar，Node 自带 `node:zlib` 就能解 gzip，
 * 剩下的 tar 是个极简格式：512 字节头 + 数据块（同样按 512 对齐）。
 * 为一个只需要「读出指定后缀的几个文本文件」的需求引 `tar` 包不值 ——
 * 仓库还有 `docs/zero-deps-allowlist.json` 约束（设计方案 C6）。
 *
 * ## 支持与不支持
 *
 * 支持：ustar（含 `prefix` 字段拼接）、GNU `L` 长文件名、
 *      普通文件 / 目录 / 跳过其他类型（符号链接等）。
 * 不支持：稀疏文件、pax 扩展头（`x` / `g`）—— npm 发布的 tarball 不用这些；
 *      真遇到就当普通条目跳过，函数不会炸。
 *
 * ⛔ 解压体积有上限（默认 96 MB）。防的是「拉到一个畸形包把内存吃光」，
 *    而不是正常包太大 —— dsh 全家桶单个包解压后都在 5 MB 以内。
 */

import { gunzipSync } from 'node:zlib';

/** 单个 tarball 解压后允许的最大字节数 */
export const MAX_INFLATED_BYTES = 96 * 1024 * 1024;

const BLOCK = 512;

/** 读 tar 头的数值字段：八进制、以 NUL 或空格结尾；也接受 base-256（首字节高位为 1） */
function readNumeric(buf, offset, length) {
  const first = buf[offset];
  if (first === undefined) return 0;
  // base-256 编码（大文件用），首字节最高位为 1
  if (first & 0x80) {
    let val = 0;
    for (let i = offset + 1; i < offset + length; i += 1) {
      val = (val * 256) + buf[i];
    }
    return val;
  }
  const raw = buf.subarray(offset, offset + length).toString('latin1');
  const cleaned = raw.replace(/\0.*$/, '').trim();
  if (!cleaned) return 0;
  const n = parseInt(cleaned, 8);
  return Number.isFinite(n) ? n : 0;
}

function readString(buf, offset, length) {
  const raw = buf.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

/**
 * 解 gzip + 遍历 tar 条目，把命中 `filter(path)` 的普通文件交给回调。
 *
 * @param {Buffer} gzBuf  .tgz 原始字节
 * @param {(path: string) => boolean} filter  只取需要的条目（早过滤 = 少解码）
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Map<string, string>} path → utf8 文本
 */
export function extractTextFiles(gzBuf, filter, opts = {}) {
  const maxBytes = opts.maxBytes ?? MAX_INFLATED_BYTES;
  const out = new Map();
  if (!Buffer.isBuffer(gzBuf) || gzBuf.length === 0) return out;

  let tar;
  try {
    tar = gunzipSync(gzBuf, { maxOutputLength: maxBytes });
  } catch {
    // gzip 坏了 / 超限 / 不是 gzip —— 一律返回空，由调用方判 unknown
    return out;
  }

  let off = 0;
  let pendingLongName = null;

  while (off + BLOCK <= tar.length) {
    // 全 0 块 = 归档结束（通常是连续两个）
    let allZero = true;
    for (let i = 0; i < BLOCK; i += 1) {
      if (tar[off + i] !== 0) { allZero = false; break; }
    }
    if (allZero) break;

    const size = readNumeric(tar, off + 124, 12);
    const typeflag = String.fromCharCode(tar[off + 156] || 0x30); // 缺省按 '0'
    let name = readString(tar, off, 100);

    // ustar：长路径拆在 prefix 里
    const magic = readString(tar, off + 257, 6);
    if (magic.startsWith('ustar')) {
      const prefix = readString(tar, off + 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }

    const dataOff = off + BLOCK;
    const dataEnd = Math.min(dataOff + size, tar.length);
    const blocks = Math.ceil(size / BLOCK) || 0;
    off = dataOff + (blocks * BLOCK);

    // GNU 长文件名：真实名字在下一块的 data 里
    if (typeflag === 'L') {
      pendingLongName = tar.subarray(dataOff, dataEnd).toString('utf8').replace(/\0.*$/, '');
      continue;
    }
    if (pendingLongName) {
      name = pendingLongName;
      pendingLongName = null;
    }

    // '0' 普通文件，'\0' 早期 tar 也当普通文件
    if (typeflag !== '0' && typeflag !== '\0') continue;
    if (!filter(name)) continue;
    if (dataEnd <= dataOff) { out.set(name, ''); continue; }

    out.set(name, tar.subarray(dataOff, dataEnd).toString('utf8'));
  }

  return out;
}

/**
 * 从 tarball 里取「类型定义 + 主入口」这两类文件。
 *
 * 为什么只取这两类：判读要看的是**对外接口**。实现文件（其它 .js）内容天天变，
 * 全取会让 diff 全是噪声，反而看不出「签名变没变」。
 */
export function extractApiSurface(gzBuf) {
  return extractTextFiles(gzBuf, (p) => (
    /\/lib\/types\/[^/]+\.d\.ts$/.test(p)
    || /\/lib\/index\.js$/.test(p)
    || /\/package\.json$/.test(p)
  ));
}
