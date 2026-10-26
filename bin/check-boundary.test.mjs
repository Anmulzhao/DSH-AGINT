// bin/check-boundary.test.mjs —— 能力边界门禁的自证测试
//
// 门禁最危险的失败模式不是「误报」，是**假绿**：扫不出东西却报 PASS。
// 所以这里的测试分两半：
//   ① 负例 —— 注释里的路径、URL、块注释里的内容**不得**被报（否则门禁会被立刻绕过）
//   ② 正例 —— 真实代码里的越界**必须**被报，且必须能命中本仓真实文件里的已知欠账
//      （证明它真的在扫，而不是"扫了个寂寞"）
//
// 红绿自证：把 findViolations 的 B1 规则临时放宽成"连注释一起报"，
// 负例会立刻变红；把扫描范围缩成空，正例会立刻变红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findViolations, codeLineMask, extractStringLiterals } from './check-boundary.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const cats = (fs) => fs.map((f) => f.category);
const has = (fs, c) => fs.some((f) => f.category === c);

// ── 负例：不该报 ────────────────────────────────────────────────────────────

test('B1: 注释行里的本机路径不报', () => {
  const src = [
    '// 事故记录：当时 cwd 是 C:\\Users\\Administrator\\Desktop',
    '/* 举例：D:\\foo\\hello.md */',
    'const x = 1;',
  ].join('\n');
  const fs = findViolations(src, 't.js');
  assert.equal(has(fs, 'machine-private-path'), false, `不该报，实际 ${JSON.stringify(fs)}`);
});

test('B1: 块注释整段不报', () => {
  const src = ['/*', " * zstd 在 D:/Tools/zstd/zstd.exe", ' */', 'const y = 2;'].join('\n');
  const fs = findViolations(src, 't.js');
  assert.equal(has(fs, 'machine-private-path'), false);
  assert.equal(has(fs, 'zstd-self-decompress'), false);
});

test('B1: URL 里的 https:// 不当盘符报', () => {
  const src = "const u = 'https://example.com/a/b';";
  const fs = findViolations(src, 't.js');
  assert.equal(has(fs, 'machine-private-path'), false, `不该报，实际 ${JSON.stringify(fs)}`);
});

test('B1: 行尾注释里的路径不报（路径不在字符串字面量内）', () => {
  const src = "const z = 1; // 曾经用 D:/Tools/zstd/zstd.exe";
  const fs = findViolations(src, 't.js');
  assert.equal(has(fs, 'machine-private-path'), false, `不该报，实际 ${JSON.stringify(fs)}`);
});

test('B2: 注释里的会话日志名不报', () => {
  const src = ['// 09-22 改名 session.v4.jsonl.zstd 导致断供 12 天', 'const a = 1;'].join('\n');
  const fs = findViolations(src, 't.js');
  assert.equal(has(fs, 'session-log-name-table'), false);
});

// ── 正例：该报 ──────────────────────────────────────────────────────────────

test('B1: 代码里字符串中的本机路径要报', () => {
  const src = "const p = 'D:/Tools/zstd/zstd.exe';";
  const fs = findViolations(src, 't.js');
  assert.equal(has(fs, 'machine-private-path'), true, '代码里的机器私有路径必须报');
  assert.equal(fs[0].line, 1);
});

test('B2: 代码里的 zstd 解压调用要报', () => {
  const src = "const { stdout } = await execFileAsync(bin, ['-dc', path]);";
  const fs = findViolations(src, 't.js');
  assert.equal(has(fs, 'zstd-self-decompress'), true);
});

test('B2: 代码里的会话日志名表要报', () => {
  const src = "const NAMES = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd'];";
  const fs = findViolations(src, 't.js');
  assert.equal(has(fs, 'session-log-name-table'), true);
});

test('B2: token 计量字段名要报', () => {
  const src = 'const avgTokenCost = null;';
  const fs = findViolations(src, 't.js');
  assert.equal(has(fs, 'token-metering-selfbuild'), true);
});

// ── 红绿自证：对真实仓库文件必须能命中已知欠账 ────────────────────────────

test('对真实仓库文件：能命中已登记的机器私有路径欠账', () => {
  const p = join(REPO_ROOT, 'plugins/agint-input-gateway/lib/channels/self-observation.js');
  assert.ok(existsSync(p), '被测文件必须存在，否则测试是空转');
  const fs = findViolations(readFileSync(p, 'utf8'), 'plugins/agint-input-gateway/lib/channels/self-observation.js');
  assert.equal(has(fs, 'machine-private-path'), true, '真实文件里的 zstd 盘符路径必须被抓到');
});

test('对真实仓库文件：能命中已登记的会话日志名表欠账', () => {
  const p = join(REPO_ROOT, 'plugins/agint-session-source/lib/index.mjs');
  assert.ok(existsSync(p));
  const fs = findViolations(readFileSync(p, 'utf8'), 'plugins/agint-session-source/lib/index.mjs');
  assert.equal(has(fs, 'session-log-name-table'), true, '真实文件里的会话日志名表必须被抓到');
});

test('对真实仓库文件：能命中已登记的 zstd 自解压欠账', () => {
  const p = join(REPO_ROOT, 'plugins/agint-session-extract/index.js');
  assert.ok(existsSync(p));
  const fs = findViolations(readFileSync(p, 'utf8'), 'plugins/agint-session-extract/index.js');
  assert.equal(has(fs, 'zstd-self-decompress'), true, '真实文件里的 zstd 解压必须被抓到');
});

// ── 工具函数契约 ────────────────────────────────────────────────────────────

test('codeLineMask: 块注释区间整段为 false', () => {
  const src = ['const a = 1;', '/*', 'const b = 2;', '*/', 'const c = 3;'].join('\n');
  const m = codeLineMask(src);
  assert.deepEqual(m, [true, false, false, false, true]);
});

test('extractStringLiterals: 取到字面量内容，跳过转义', () => {
  assert.deepEqual(extractStringLiterals("const a = 'x'; const b = \"y\";"), ['x', 'y']);
  assert.deepEqual(extractStringLiterals("const a = 'it\\'s';"), ["it's"]);
});
