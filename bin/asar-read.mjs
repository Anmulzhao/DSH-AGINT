/**
 * 最小 asar 读取器（2026-10-21）：从 Electron 的 `app.asar` 里读出一个文件的内容。
 *
 * ## 为什么需要它
 *
 * 真��宿主 = Electron 桌面版的 `resources/app.asar`（本机 174 MB）。
 * 它是**唯一**知道宿主真实版本的地方 —— 而 AGINT 的插件跑在
 * `$DSH_HOME/.agint-deps/dsh-runtime`（版本锁死的解析根）上。
 * 宿主升级而解析根不动 ⇒ 插件跑在旧 dsh 上，而任何只查解析根的门禁都会说"兼容"
 * ⇒ **假绿**。要判住这件事，门禁必须能读宿主版本。
 *
 * ## asar 格式（实测自本机 app.asar 头 32 字节）
 *
 *   [0..3]   UInt32LE = 4                    ← pickle 头长度
 *   [4..7]   UInt32LE = headerPickleSize      ← 头部总大小（含这 8 字节）
 *   [8..11]  UInt32LE = headerPickleSize - 4
 *   [12..15] UInt32LE = headerJsonSize        ← 目录 JSON 的字节数
 *   [16..]   header JSON                      ← {"files":{"<path>":{"size","offset"}}}
 *   文件内容起点 = 8 + headerPickleSize
 *
 * 目录 JSON 里每个文件是 `{ size, offset }`（offset 相对内容起点）或
 * `{ files: {...} }`（目录）。
 *
 * ## 边界
 *
 * - 只读，不写。**不动 dsh 安装目录**（AGENTS.md 红线）。
 * - 找不到文件 / 格式不认 ⇒ 返回 null，**不抛** —— 调用方据此说「没查到」，
 *   而不是假装查到了。
 */

// ── 目录 JSON → 扁平表（"a/b/c" → {size, offset}）────────────────────────
import { openSync, readSync, closeSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT_HERE = join(dirname(fileURLToPath(import.meta.url)), '..');

function flatten(files, prefix = '', out = new Map()) {
  for (const [name, entry] of Object.entries(files ?? {})) {
    const key = prefix ? `${prefix}/${name}` : name;
    if (entry && typeof entry === 'object' && entry.files) {
      flatten(entry.files, key, out);
    } else if (entry && typeof entry === 'object') {
      out.set(key, entry);
    }
  }
  return out;
}

/**
 * 读 app.asar 里的一个文件。
 *
 * @param {string} asarPath  app.asar 路径
 * @param {string} innerPath 归档内相对路径（如 'package.json'）
 * @returns {string|null} 文件文本；找不到 / 格式不认 ⇒ null
 */
export function readAsarFile(asarPath, innerPath) {
  let fd = null;
  try {
    fd = openSync(asarPath, 'r');
    const head = Buffer.alloc(16);
    if (readSync(fd, head, 0, 16, 0) < 16) return null;
    const headerPickleSize = head.readUInt32LE(4);
    const headerJsonSize = head.readUInt32LE(12);
    if (!headerPickleSize || !headerJsonSize) return null;
    const jsonBuf = Buffer.alloc(headerJsonSize);
    if (readSync(fd, jsonBuf, 0, headerJsonSize, 16) < headerJsonSize) return null;
    let header;
    try {
      header = JSON.parse(jsonBuf.toString('utf8'));
    } catch {
      return null;
    }
    const table = flatten(header?.files);
    const entry = table.get(innerPath);
    if (!entry || typeof entry.size !== 'number' || typeof entry.offset !== 'string') return null;
    const contentStart = 8 + headerPickleSize;
    const offset = contentStart + Number(entry.offset);
    const buf = Buffer.alloc(entry.size);
    if (readSync(fd, buf, 0, entry.size, offset) < entry.size) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* teardown must not throw */ } }
  }
}

/**
 * 找真实宿主的 app.asar（Electron 桌面版的内核）。
 *
 * ⛔ 为什么必须有这一项：
 *   门禁判据用的是**某个 dsh 包副本**（仓内 node_modules 或
 *   `$DSH_HOME/.agint-deps/dsh-runtime`）。而**真实宿主**是 Electron 的
 *   `resources/app.asar`（把 dsh 打进了 `@deepseek-ai/dsh-desktop-runtime`）。
 *   宿主升级而副本不动 ⇒ 门禁对着旧副本说「兼容」⇒ **假绿**：
 *   门禁说没事，实际 AGINT 的插件跑在旧 dsh 上、宿主已换版本。
 *
 * 路径来源（机器私有，按红线不入库）：
 *   ① 环境变量 `DSH_HOST_APP_ASAR`
 *   ② `AGENTS.local.md` 的 `hostAppAsar:` 键（本机事实落点，该文件已 gitignore；
 *      块外内容不被自动生成脚本覆盖）
 *   ③ 常见安装位扫描（%LOCALAPPDATA%\Programs、%PROGRAMFILES%）
 *
 * @param {object} [opts]
 * @param {object} [opts.env]     环境变量（默认 process.env）
 * @param {string} [opts.repoRoot] 仓根（默认按本文件位置推导）
 * @returns {{path: string, source: string} | null} 找不到 ⇒ null（**不猜**）
 */
export function findHostAppAsar({ env = process.env, repoRoot = null } = {}) {
  const e = env ?? {};
  const fromEnv = e.DSH_HOST_APP_ASAR;
  if (fromEnv && existsSync(fromEnv)) return { path: fromEnv, source: 'env:DSH_HOST_APP_ASAR' };

  const root = repoRoot ?? REPO_ROOT_HERE;
  try {
    const localFile = join(root, 'AGENTS.local.md');
    if (existsSync(localFile)) {
      const m = /^\s*hostAppAsar\s*:\s*(.+?)\s*$/m.exec(readFileSync(localFile, 'utf8'));
      const p = m ? m[1].replace(/^["']|["']$/g, '').trim() : '';
      if (p && existsSync(p)) return { path: p, source: 'AGENTS.local.md:hostAppAsar' };
    }
  } catch { /* 读不到就往下走 */ }

  const bases = [
    e.LOCALAPPDATA ? join(e.LOCALAPPDATA, 'Programs') : null,
    e.ProgramFiles || null,
    e['ProgramFiles(x86)'] || null,
  ].filter(Boolean);
  for (const base of bases) {
    let entries = [];
    try { entries = readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const en of entries) {
      if (!en.isDirectory()) continue;
      const asar = join(base, en.name, 'resources', 'app.asar');
      if (existsSync(asar)) return { path: asar, source: `scan:${base}` };
    }
  }
  return null;
}

/**
 * 列出 app.asar 里的全部文件路径。
 *
 * 用途：宿主（Electron app.asar）里有哪些包 / 文件，是 CLI 包树（`npm root -g` 或
 * `.agint-deps/dsh-runtime`）里没有的 —— 这一栏决定 AGINT 的「dsh 能力面基线」是否完整。
 *
 * @param {string} asarPath app.asar 路径
 * @returns {string[]} 归档内相对路径（目录本身不列出）
 */
export function listAsarFiles(asarPath) {
  let fd = null;
  try {
    fd = openSync(asarPath, 'r');
    const head = Buffer.alloc(16);
    if (readSync(fd, head, 0, 16, 0) < 16) return [];
    const headerPickleSize = head.readUInt32LE(4);
    const headerJsonSize = head.readUInt32LE(12);
    if (!headerPickleSize || !headerJsonSize) return [];
    const jsonBuf = Buffer.alloc(headerJsonSize);
    if (readSync(fd, jsonBuf, 0, headerJsonSize, 16) < headerJsonSize) return [];
    let header;
    try {
      header = JSON.parse(jsonBuf.toString('utf8'));
    } catch {
      return [];
    }
    return [...flatten(header?.files).keys()].sort();
  } catch {
    return [];
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* teardown must not throw */ } }
  }
}

/**
 * 读 app.asar 里的 package.json，取 { name, version }。
 *
 * @param {string} asarPath  app.asar 路径
 * @param {string} [innerPath] 归档内 package.json 路径（默认 'package.json'）
 * @returns {{name: string, version: string} | null}
 */
export function readAsarPackage(asarPath, innerPath = 'package.json') {
  const text = readAsarFile(asarPath, innerPath);
  if (typeof text !== 'string') return null;
  try {
    const pkg = JSON.parse(text);
    if (!pkg || typeof pkg.version !== 'string') return null;
    return { name: typeof pkg.name === 'string' ? pkg.name : '', version: pkg.version };
  } catch {
    return null;
  }
}
