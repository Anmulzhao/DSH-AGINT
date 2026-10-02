// bin/lib/tar.test.mjs —— 手写 tar 的测试
//
// ⭐ 重心是**往返测试**（打包 → 解包 → 逐字节比对）。
//    「能打包」不等于「能解回来」—— 接收方只关心后者。
//    格式类代码的 bug 几乎全部出现在往返不一致上。

import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { packTar, packTarGz, unpackTar } from './tar.mjs';

/** 往返：打 → 解 → 找同 path 的条目。 */
function roundTrip(entries) {
  const out = unpackTar(packTar(entries));
  return out;
}

test('空包：只有收尾的空块，解出 0 条', () => {
  const out = roundTrip([]);
  assert.deepEqual(out, []);
});

test('单文件往返逐字节一致', () => {
  const content = Buffer.from('hello 世界\n', 'utf8');
  const out = roundTrip([{ path: 'a.txt', content }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'a.txt');
  assert.equal(out[0].type, 'file');
  assert.ok(Buffer.isBuffer(out[0].content));
  assert.ok(content.equals(out[0].content), '内容必须逐字节一致');
});

test('多层目录：目录条目与文件条目各自正确', () => {
  const out = roundTrip([
    { path: '01-code', type: 'directory' },
    { path: '01-code/diff.patch', content: 'diff --git a b\n' },
    { path: '01-code/changed-files', type: 'directory' },
    { path: '01-code/changed-files/x.js', content: 'console.log(1)\n' },
  ]);
  const byPath = new Map(out.map((e) => [e.path, e]));
  assert.equal(byPath.get('01-code').type, 'directory');
  assert.equal(byPath.get('01-code/changed-files').type, 'directory');
  assert.equal(byPath.get('01-code/diff.patch').type, 'file');
  assert.equal(byPath.get('01-code/changed-files/x.js').content.toString(), 'console.log(1)\n');
});

test('长文件名（>100 字节）走 GNU long name 且能解回完整名', () => {
  // 造一个 150 字节的单层文件名
  const long = `${'a'.repeat(60)}/${'b'.repeat(60)}/${'c'.repeat(30)}.txt`;
  assert.ok(long.length > 100, `测试前提：路径需 >100 字节，实际 ${long.length}`);
  const out = roundTrip([{ path: long, content: 'x' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].path, long, '长名必须完整解回 —— 截断会让接收方拿不到文件');
  assert.equal(out[0].content.toString(), 'x');
});

test('非 ASCII 文件名与内容往返一致（中文）', () => {
  const out = roundTrip([
    { path: '04-runtime-snapshot/进化记忆.json', content: '{"类型":"进化"}' },
  ]);
  assert.equal(out[0].path, '04-runtime-snapshot/进化记忆.json');
  assert.equal(out[0].content.toString('utf8'), '{"类型":"进化"}');
});

test('Emoji 文件名（4 字节 UTF-8）往返一致', () => {
  const out = roundTrip([{ path: 'docs/📦.md', content: '# 🚀' }]);
  assert.equal(out[0].path, 'docs/📦.md');
  assert.equal(out[0].content.toString('utf8'), '# 🚀');
});

test('大文件（>1MB）往返一致，验证补齐逻辑', () => {
  // 内容刻意不是 512 的整数倍 ⇒ 逼出 padding 分支
  const big = Buffer.alloc(1024 * 1024 + 137);
  for (let i = 0; i < big.length; i++) big[i] = i % 251;
  const out = roundTrip([{ path: 'big.bin', content: big }]);
  assert.equal(out[0].content.length, big.length);
  assert.ok(big.equals(out[0].content), '大文件必须逐字节一致');
});

test('零字节文件往返（空文件边界）', () => {
  const out = roundTrip([{ path: 'empty.txt', content: Buffer.alloc(0) }]);
  assert.equal(out[0].type, 'file');
  assert.equal(out[0].content.length, 0);
});

test('目录条目即使末尾带 / 也能归一', () => {
  const a = roundTrip([{ path: 'd', type: 'directory' }]);
  const b = roundTrip([{ path: 'd/', type: 'directory' }]);
  assert.deepEqual(a, b);
  assert.equal(a[0].path, 'd');
});

test('⛔ 打包可复现：同样输入两次产出同样字节（packageHash 的前提）', () => {
  const entries = [
    { path: 'manifest.json', content: '{"v":1}' },
    { path: '01-code/diff.patch', content: 'patch' },
    { path: '01-code', type: 'directory' },
  ];
  const h1 = packTarGz(entries);
  const h2 = packTarGz(entries);
  assert.ok(h1.equals(h2), 'gzip 字节必须一致 —— 否则 packageHash 不可比、接收方无法验证');
});

test('gzip 能被识别并解包（magic 探测）', () => {
  const gz = packTarGz([{ path: 'a.txt', content: 'x' }]);
  assert.equal(gz[0], 0x1f);
  assert.equal(gz[1], 0x8b);
  const out = unpackTar(gz);
  assert.equal(out[0].path, 'a.txt');
});

test('⛔ 损坏的包必须抛错，不能静默解出残缺内容', () => {
  const gz = packTarGz([{ path: 'a.txt', content: 'hello world hello' }]);
  const raw = Buffer.from(gz);
  // ⚠️ 必须破坏【解压后】的 tar 头（那里有 checksum 保护），不是 gzip 尾部 padding。
  //    改 padding 位可能落在无害处 ⇒ 不报错是**正确行为**，不是漏洞。
  //    这里改 gzip 头之后的数据区：直接对 gunzip 结果动手最确定。
  const inner = gunzipSync(raw);
  inner[10] ^= 0xff; // 落在 name 字段内 ⇒ checksum 必然不匹配
  assert.throws(
    () => unpackTar(inner),
    /校验和不符/,
    '头部被改时必须靠 checksum 抓到 —— 这是包完整性的一道独立防线',
  );
});

test('⛔ gzip 数据区损坏时 gunzip 自己抛错（不静默产出残包）', () => {
  const gz = packTarGz([{ path: 'a.txt', content: 'x'.repeat(2000) }]);
  const raw = Buffer.from(gz);
  raw[30] ^= 0xff; // 改压缩流中段
  assert.throws(() => unpackTar(raw));
});

test('⛔ 不支持的 tar 类型显式抛错（不静默跳过）', () => {
  // 构造一个符号链接条目（typeflag '2'）
  const BLOCK = 512;
  const header = Buffer.alloc(BLOCK, 0);
  Buffer.from('link', 'utf8').copy(header, 0);
  header.write('0000644\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write('00000000000\0', 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii');
  header.write('        ', 148, 'ascii');
  header.write('2', 156, 'ascii'); // typeflag 2 = symlink
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of header) sum += b;
  const s = sum.toString(8).padStart(6, '0');
  header.write(`${s}\0 `, 148, 'ascii');

  const buf = Buffer.concat([header, Buffer.alloc(BLOCK * 2, 0)]);
  assert.throws(
    () => unpackTar(buf),
    /类型不支持/,
    '静默跳过不支持类型会产出「看起来解开了但少了内容」的包 —— 接收方那边才炸',
  );
});

test('⛔ 路径以 / 开头会被归一（防止 tar 绝对路径逃逸）', () => {
  const out = roundTrip([{ path: '/etc/passwd', content: 'x' }]);
  assert.equal(out[0].path, 'etc/passwd', '必须剥掉开头斜杠，否则解包会写绝对路径');
});

test('多个文件顺序保持', () => {
  const names = ['a', 'b', 'c', 'd', 'e'];
  const out = roundTrip(names.map((n) => ({ path: `${n}.txt`, content: n })));
  assert.deepEqual(out.map((e) => e.path), names.map((n) => `${n}.txt`));
});

// ── 与系统 tar 交叉验证 ─────────────────────────────────────────────────────
// ⭐ 这一段的价值：自写的解包器会「宽容地」照读自家格式，即使格式不合标准
//    也能往返成功。真包交付给第三方时，只有**标准工具**能读才算数。
//    本组测试曾抓到一个真 bug：PAX 记录长度手写常量 30（实际 28），
//    自往返全绿，但 GNU tar 报 `Extended header length 30 is out of range` 并拒绝解包。

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('⛔ 系统 tar 必须能解我们打的包（格式合规性交叉验证）', (t) => {
  // 探测系统 tar：Windows 10+ 自带 bsdtar，Linux/macOS 自带 GNU tar
  const probe = spawnSync('tar', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    t.skip('系统无 tar 命令，跳过交叉验证');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'tar-xcheck-'));
  try {
    const entries = [
      { path: 'manifest.json', content: '{"packageVersion":"1.0"}' },
      { path: '01-code', type: 'directory' },
      { path: '01-code/diff.patch', content: 'diff --git a/x b/x\n' },
      { path: '01-code/changed-files/进化记忆.json', content: '{"中文":"值"}' },
      { path: `deep/${'x'.repeat(120)}/long.txt`, content: 'longname' },
      { path: 'empty.txt', content: Buffer.alloc(0) },
    ];
    const gzPath = join(dir, 'out.tar.gz');
    writeFileSync(gzPath, packTarGz(entries));

    // ① 列目录：必须 5 条全在（目录条目带尾斜杠）
    const list = spawnSync('tar', ['-tzf', 'out.tar.gz'], { cwd: dir, encoding: 'utf8' });
    assert.equal(list.status, 0, `系统 tar 列目录失败：\n${list.stderr}`);
    const lines = list.stdout.trim().split('\n');
    assert.equal(lines.length, 6, `应为 6 条（1 manifest + 1 目录 + 3 文件 + 1 长名），实得 ${lines.length}：\n${lines.join('\n')}`);
    assert.ok(lines.some((l) => l.startsWith('01-code/')), '目录条目必须带尾斜杠');
    assert.ok(lines.some((l) => l.includes('进化记忆.json')), '中文名必须可列');

    // ② 解包：退出码必须 0（PAX 长度不自洽时 GNU tar 会在这里失败）
    const ext = spawnSync('tar', ['-xzf', 'out.tar.gz'], { cwd: dir, encoding: 'utf8' });
    assert.equal(ext.status, 0, `系统 tar 解包失败（本组测试曾抓到 PAX 长度 bug）：\n${ext.stderr}`);

    // ③ 内容必须逐字节一致
    assert.equal(
      readFileSync(join(dir, 'manifest.json'), 'utf8'),
      '{"packageVersion":"1.0"}',
    );
    assert.equal(
      readFileSync(join(dir, '01-code', 'changed-files', '进化记忆.json'), 'utf8'),
      '{"中文":"值"}',
    );
    assert.equal(
      readFileSync(join(dir, 'deep', 'x'.repeat(120), 'long.txt'), 'utf8'),
      'longname',
      '长文件名必须被标准工具正确还原（GNU long name 生效）',
    );
    assert.equal(readFileSync(join(dir, 'empty.txt')).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⛔ 我们必须能读系统 tar 打的包（反向兼容）', (t) => {
  const probe = spawnSync('tar', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    t.skip('系统无 tar 命令，跳过反向验证');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'tar-rev-'));
  try {
    writeFileSync(join(dir, 'a.txt'), 'hello');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', '中文.txt'), '内容');
    const mk = spawnSync('tar', ['-czf', 'sys.tar.gz', 'a.txt', 'sub'], { cwd: dir, encoding: 'utf8' });
    assert.equal(mk.status, 0, `系统 tar 打包失败：\n${mk.stderr}`);

    const out = unpackTar(readFileSync(join(dir, 'sys.tar.gz')));
    const byPath = new Map(out.map((e) => [e.path, e]));
    assert.equal(byPath.get('a.txt').content.toString(), 'hello');
    assert.equal(byPath.get('sub/中文.txt')?.content.toString(), '内容');
    assert.equal(byPath.get('sub')?.type, 'directory');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const mkdirSafe = mkdirSync;