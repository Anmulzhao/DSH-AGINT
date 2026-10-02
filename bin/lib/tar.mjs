// bin/lib/tar.mjs —— 零依赖 tar 打包 / 解包（只用 node:zlib + node:buffer）
//
// ⭐ 为什么手写而不用 tar / archiver npm 包：
//   ① 零依赖纪律（docs/zero-deps-allowlist.json）—— 引入 npm 包必须进白名单，
//      而白名单的门槛是「能指出由谁提供，若答案是 npm 就该让门禁红」。
//   ② 仓库既有偏好（VERSION v0.9.0 记载 killer「仅用 node 内置模块」、
//      agint-restart/lib/respawn.js:3「零依赖守护脚本，不用 shell」）。
//   ③ tar 格式本身很简单：512 字节头 + 数据块 + 两个空块收尾。
//
// ⚠️ **已实现的格式子集**（够用即止，不做完整 GNU/PAX 兼容）：
//   · regular file（typeflag '0'）
//   · directory（typeflag '5'）
//   · GNU long name（typeflag 'L'）—— 文件名 >100 字节时自动走这个
//   · PAX extended header（typeflag 'x'）—— 需要记录 mtime 小数或大 size 时
//   ⚠️ 不支持：符号链接 / 硬链接 / 稀疏文件 / 设备文件。
//      遇到这些**显式抛错**，不静默降级 —— 静默降级会产出损坏的包，
//      而损坏的包在接收方那边才炸，排查成本高一个数量级。
//
// 校验：bin/lib/tar.test.mjs 覆盖空包 / 单文件 / 多层目录 / 长名 / 非 ASCII /
//      大文件，并做**往返测试**（打包 → 解包 → 逐字节比对）。

import { gzipSync, gunzipSync } from 'node:zlib';

const BLOCK = 512;

/** tar 头部的数值字段：8 字节八进制（末尾 1 字节 NUL 或空格）。 */
function octal(value, width) {
  // width 含末尾 NUL 位：实际数字位 = width - 1
  const digits = width - 1;
  const s = Math.floor(value).toString(8);
  if (s.length > digits) {
    throw new Error(`tar 字段溢出：${value} 需要 ${s.length} 位但只有 ${digits} 位`);
  }
  return s.padStart(digits, '0') + '\0';
}

/** tar 头部校验和字段：6 位八进制 + NUL + 空格。 */
function octalChecksum(value) {
  const s = Math.floor(value).toString(8);
  if (s.length > 6) throw new Error(`tar checksum 溢出：${value}`);
  return s.padStart(6, '0') + '\0 ';
}

/** mode / uid / gid / mtime 的固定值。mtime 固定 ⇒ 同样输入产出同样字节（可复现打包）。 */
const DEFAULT_MODE_FILE = 0o644;
const DEFAULT_MODE_DIR = 0o755;
const FIXED_UID = 0;
const FIXED_GID = 0;
/**
 * 固定 mtime = 0（1970-01-01）。
 * ⭐ 这是**打包可复现**的前提：mtime 每次运行都变 ⇒ 同样的输入产出不同的
 * 字节 ⇒ packageHash 不可比、不可验。固定 mtime 是零依赖实现里
 * 唯一能拿到确定性的办法。
 */
const FIXED_MTIME = 0;

function buildHeader({ name, size, type, mode, prefix, truncateName = false }) {
  const buf = Buffer.alloc(BLOCK, 0);

  // name（100 字节）
  const nameBuf = Buffer.from(name, 'utf8');
  if (prefix) {
    // GNU tar 的 split 形态：prefix(155) + '/' + name(100)
    const pBuf = Buffer.from(prefix, 'utf8');
    if (pBuf.length > 155) throw new Error(`tar prefix 超长：${prefix}`);
    if (nameBuf.length > 100) throw new Error(`tar name 超长：${name}`);
    pBuf.copy(buf, 0);
    buf[155] = 0x2f; // '/'
    nameBuf.copy(buf, 156);
  } else {
    if (nameBuf.length > 100) {
      // truncateName=true ⇒ 名字已由 GNU long name（'L' 记录）承载，
      // 这里的 name 字段只放占位（真实解包端读 L 记录的内容）。
      if (!truncateName) {
        throw new Error(`tar name 超长（需 GNU long name）：${name}（${nameBuf.length} 字节）`);
      }
      buf.write('././@LongLink', 0, 'ascii');
    } else {
      nameBuf.copy(buf, 0);
    }
  }

  buf.write(octal(mode & 0o7777, 8), 100, 'ascii'); // mode
  buf.write(octal(FIXED_UID, 8), 108, 'ascii'); // uid
  buf.write(octal(FIXED_GID, 8), 116, 'ascii'); // gid
  buf.write(octal(size, 12), 124, 'ascii'); // size
  buf.write(octal(FIXED_MTIME, 12), 136, 'ascii'); // mtime
  buf.write('        ', 148, 'ascii'); // checksum 占位（8 字节空格）
  buf.write(type, 156, 'ascii'); // typeflag
  buf.write('ustar\0', 257, 'ascii'); // magic "ustar\0"
  buf.write('00', 263, 'ascii'); // version "00"

  // 填充未用区域为 0（Buffer.alloc 已保证）

  // checksum = 全部字节之和（把 checksum 字段当空格算）
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(octalChecksum(sum), 148, 'ascii');

  return buf;
}

/** 数据补齐到 512 的整数倍。 */
function padBlock(buf) {
  const rem = buf.length % BLOCK;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(BLOCK - rem, 0)]);
}

/** GNU long name 记录（typeflag 'L'）：把完整文件名放进数据区。 */
function longNameHeader(fullName) {
  const nameBuf = Buffer.from(fullName, 'utf8');
  return {
    header: buildHeader({
      name: '././@LongLink',
      size: nameBuf.length + 1, // 必须含结尾 NUL
      type: 'L',
      mode: DEFAULT_MODE_FILE,
    }),
    data: padBlock(Buffer.concat([nameBuf, Buffer.alloc(1, 0)])),
  };
}

/**
 * PAX extended header（typeflag 'x'）—— 承载 mtime 小数部分。
 * 固定 mtime=0 时不需要小数，但 PAX 同时是「未来要放宽 mtime 时的扩展点」。
 * 当前只写必需的 mtime 记录。
 */
function paxHeader(mtimeSeconds) {
  // ⚠️ PAX 记录格式是 `<decimal-length> <key>=<value>\n`，**length 含自身**。
  //    长度算错时 GNU tar 报 `Extended header length N is out of range` 并拒绝解包，
  //    而自写的解包器会「宽容地」照读 ⇒ 往返测试全绿、包却是坏的。
  //    ⇒ 长度必须由内容算出，不能手写常量；且必须用系统 tar 交叉验证。
  const value = `${Math.floor(mtimeSeconds)}.000000000`;
  const payload = `mtime=${value}\n`;
  // 求使 (len + payload) 的十进制位数自洽的长度
  let len = payload.length + 3; // 至少 "N " 两字符 + \n ⇒ 初始估计
  for (let i = 0; i < 4; i++) {
    const candidate = `${len} ${payload}`;
    if (String(candidate.length).length + 1 === String(len).length) break;
    len = candidate.length;
  }
  const record = `${len} ${payload}`;
  // 自校验：长度字段必须等于整条记录的实际字节数（否则直接抛错，不产出坏包）
  const actual = Buffer.byteLength(record, 'utf8');
  if (actual !== len) {
    throw new Error(`PAX 记录长度不自洽：声明 ${len} 实得 ${actual} ⇒ 拒绝产出坏包`);
  }
  const data = Buffer.from(record, 'utf8');
  return {
    header: buildHeader({
      name: 'PaxHeader',
      size: data.length,
      type: 'x',
      mode: DEFAULT_MODE_FILE,
    }),
    data: padBlock(data),
  };
}

/**
 * 把输入条目转成 tar 字节流（未压缩）。
 *
 * @param {Array<{path: string, content?: Buffer|string, type?: 'file'|'directory', mode?: number, mtime?: number}>} entries
 *        path 用 '/' 分隔，且【不以 / 开头】（相对路径）
 * @returns {Buffer}
 */
export function packTar(entries) {
  const chunks = [];

  for (const e of entries) {
    const type = e.type ?? (e.content === undefined ? 'directory' : 'file');
    const isDir = type === 'directory';
    const path = e.path.replace(/^\/+/, ''); // 归一：去掉开头斜杠

    if (path === '') throw new Error('tar 条目路径为空');

    if (isDir) {
      const dirPath = path.endsWith('/') ? path : `${path}/`;
      // 目录名走 GNU long name：真实名（含尾斜杠）放 L 记录，name 字段放占位。
      // 目录名常常超 100（多层路径），而截断的 name 字段会让不认 long name 的
      // 解包端把目录建到错误位置 —— 比报错更糟。
      const ln = longNameHeader(dirPath);
      chunks.push(ln.header, ln.data);
      const dh = buildHeader({
        name: dirPath,
        size: 0,
        type: '5',
        mode: DEFAULT_MODE_DIR,
        truncateName: true,
      });
      chunks.push(dh);
      continue;
    }

    const content = Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content ?? '', 'utf8');

    // 名字太长 → 先写 GNU long name
    // ⚠️ 目录条目在 isDir 分支已处理（目录名总是走 long name，因为要保留尾斜杠语义）。
    //    这里只处理文件。
    const nameBuf = Buffer.from(path, 'utf8');
    if (nameBuf.length > 100) {
      const ln = longNameHeader(path);
      chunks.push(ln.header, ln.data);
    }

    // PAX（携带 mtime）
    const px = paxHeader(e.mtime ?? FIXED_MTIME);
    chunks.push(px.header, px.data);

    const h = buildHeader({
      name: path,
      size: content.length,
      type: '0',
      mode: e.mode ?? DEFAULT_MODE_FILE,
      truncateName: nameBuf.length > 100,
    });
    chunks.push(h, padBlock(content));
  }

  // 两个空块收尾（POSIX 要求）
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(chunks);
}

/**
 * gzip 封装（tar.gz）。
 * @param {Array} entries
 * @param {{ level?: number }} [opts] level 固定为 9 以保证可复现
 * @returns {Buffer}
 */
export function packTarGz(entries, opts = {}) {
  // ⭐ level 固定 9：gzip 默认级别变化会改变字节 ⇒ 破坏打包可复现性。
  const gz = gzipSync(packTar(entries), { level: opts.level ?? 9 });
  return gz;
}

/** 解析 tar 字节流。跳过 GNU long name / PAX 头。 */
function parseTar(buf) {
  const entries = [];
  let off = 0;
  let pendingLongName = null;
  let pendingPax = null;

  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK);
    off += BLOCK;

    // 连续两个空块 = 结束
    if (header.every((b) => b === 0)) {
      if (off + BLOCK <= buf.length && buf.subarray(off, off + BLOCK).every((b) => b === 0)) {
        off += BLOCK;
      }
      break;
    }

    const readStr = (start, len) => {
      const raw = header.subarray(start, start + len);
      const z = raw.indexOf(0);
      return raw.subarray(0, z === -1 ? len : z).toString('utf8');
    };
    const readOct = (start, len) => {
      const s = readStr(start, len).trim();
      return s === '' ? 0 : parseInt(s, 8);
    };

    // 校验和：把 checksum 字段当空格重算
    const stored = readOct(148, 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) {
      sum += i >= 148 && i < 156 ? 0x20 : header[i];
    }
    if (sum !== stored) {
      throw new Error(
        `tar 校验和不符（block 偏移 ${off - BLOCK}）：期望 ${stored} 实得 ${sum} ⇒ 包已损坏`,
      );
    }

    const name = readStr(0, 100);
    const prefix = readStr(345, 155);
    const size = readOct(124, 12);
    const typeflag = readStr(156, 1);
    const fullName = prefix ? `${prefix}/${name}` : name;

    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === 'L') {
      pendingLongName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (typeflag === 'x') {
      // PAX：只解析 mtime，其余忽略
      const text = data.toString('utf8');
      const m = text.match(/\d+ mtime=([\d.]+)/);
      pendingPax = m ? Math.floor(parseFloat(m[1])) : null;
      continue;
    }

    if (typeflag === '5') {
      entries.push({
        path: (pendingLongName ?? fullName).replace(/\/+$/, ''),
        type: 'directory',
      });
      pendingLongName = null;
      continue;
    }
    if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      entries.push({
        path: pendingLongName ?? fullName,
        type: 'file',
        content: Buffer.from(data),
        mtime: pendingPax,
      });
      pendingLongName = null;
      pendingPax = null;
      continue;
    }

    // ⛔ 遇到不支持的类型：显式抛错，不静默跳过
    throw new Error(
      `tar 类型不支持：typeflag=${JSON.stringify(typeflag)}（path=${fullName}）。` +
        `本实现只支持 regular file / directory / GNU long name / PAX；` +
        `符号链接、硬链接、稀疏文件、设备文件一律拒绝 —— 静默跳过会产出损坏的包。`,
    );
  }

  return entries;
}

/**
 * 解包 tar（自动识别 gzip）。
 * @param {Buffer} buf
 * @returns {Array<{path:string, type:'file'|'directory', content?:Buffer, mtime?:number}>}
 */
export function unpackTar(buf) {
  // gzip magic = 1f 8b
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return parseTar(gunzipSync(buf));
  }
  return parseTar(buf);
}
