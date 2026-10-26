/**
 * 宿主版本对照的判据测试（2026-10-21）
 *
 * 判据纪律（check-soundness）：不测「我抄的逻辑」，真调生产模块；
 * 每条都配阴性对照（放宽 ⇒ 变红），否则「全绿」不能证明它在校验。
 *
 * ⛔ 本门禁的价值全在「**没查就说没查，查到不一致就红**」上：
 *   · 一致       ⇒ 不报
 *   · 不一致     ⇒ critical（抓住假绿）
 *   · 查不到     ⇒ info 且措辞含「没查」（**不许**报成"一致"）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkHostVersion, findHostAppAsar, resolveHostDshVersion } from '../bin/host-version.mjs';
import { readAsarPackage, listAsarFiles } from '../bin/asar-read.mjs';

/**
 * 造一个最小 asar：只有 package.json 一个文件。
 * 格式（实测自本机 app.asar 头）：
 *   [0..3]=4  [4..7]=headerPickleSize  [8..11]=headerPickleSize-4
 *   [12..15]=headerJsonSize  [16..]=JSON  内容起点 = 8 + headerPickleSize
 */
function makeAsar(dir, pkg) {
  const content = Buffer.from(JSON.stringify(pkg), 'utf8');
  const headerJson = Buffer.from(
    JSON.stringify({ files: { 'package.json': { size: content.length, offset: '0' } } }),
    'utf8',
  );
  const headerPickleSize = 8 + headerJson.length;
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(headerPickleSize, 4);
  head.writeUInt32LE(headerPickleSize - 4, 8);
  head.writeUInt32LE(headerJson.length, 12);
  const file = join(dir, 'app.asar');
  writeFileSync(file, Buffer.concat([head, headerJson, content]));
  return file;
}

/**
 * 造一个含**多层文件**的 asar（宿主真实形状：`dsh/node_modules/...` 在归档内）。
 * @param {object} spec { 'path/to/file': 文件文本 }
 */
function makeAsarTree(dir, spec) {
  const entries = {};
  const blobs = [];
  let off = 0;
  for (const [p, text] of Object.entries(spec)) {
    const buf = Buffer.from(text, 'utf8');
    entries[p] = { size: buf.length, offset: String(off) };
    blobs.push(buf);
    off += buf.length;
  }
  const headerJson = Buffer.from(JSON.stringify({ files: entries }), 'utf8');
  const headerPickleSize = 8 + headerJson.length;
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(headerPickleSize, 4);
  head.writeUInt32LE(headerPickleSize - 4, 8);
  head.writeUInt32LE(headerJson.length, 12);
  const file = join(dir, 'app.asar');
  writeFileSync(file, Buffer.concat([head, headerJson, ...blobs]));
  return file;
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'agint-hostver-'));
}

test('⛔ 宿主版本与判据不一致 ⇒ critical（抓住假绿）', () => {
  const dir = tmp();
  try {
    const asar = makeAsarTree(dir, {
      'package.json': JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.2.1-rc.2' }),
      'dsh/node_modules/@deepseek-ai/dsh/package.json': JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9' }),
    });
    const issues = checkHostVersion('0.2.1-rc.2', { env: { DSH_HOST_APP_ASAR: asar } });
    assert.equal(issues.length, 1, '不一致时必须报一条');
    assert.equal(issues[0].level, 'critical', '不一致必须 critical（门禁要红）');
    assert.equal(issues[0].kind, 'host-version-mismatch');
    assert.match(issues[0].message, /9\.9\.9/, '消息里要带上宿主实际版本');
    assert.match(issues[0].message, /0\.2\.1-rc\.2/, '消息里要带上判据版本');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('宿主版本与判据一致 ⇒ 不报（不制造噪音）', () => {
  const dir = tmp();
  try {
    const asar = makeAsarTree(dir, {
      'package.json': JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.2.1-rc.2' }),
      'dsh/node_modules/@deepseek-ai/dsh/package.json': JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' }),
    });
    const issues = checkHostVersion('0.2.1-rc.2', { env: { DSH_HOST_APP_ASAR: asar } });
    assert.deepEqual(issues, [], '一致时不该报');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * ⛔ 关键负向对照：**两条版本轨道**。
 * 宿主 asar 根 package.json 是**桌面应用**版本，dsh 运行时版本在
 * `dsh/node_modules/@deepseek-ai/dsh/package.json`。
 * 上游只升运行时不升应用版号时，用错来源 ⇒ 假绿（本测试会红）。
 */
test('⛔ 两条版本轨道不同时 ⇒ 必须按 dsh 运行时版本判（用应用版本会假绿）', () => {
  const dir = tmp();
  try {
    const asar = makeAsarTree(dir, {
      // 桌面应用版本：与判据**同号**（这正是它有欺骗性的地方）
      'package.json': JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.2.1-rc.2' }),
      // dsh 运行时版本：**不同号** ⇒ 宿主已升、AGINT 判据没升
      'dsh/node_modules/@deepseek-ai/dsh/package.json': JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2' }),
    });
    const issues = checkHostVersion('0.2.1-rc.2', { env: { DSH_HOST_APP_ASAR: asar } });
    assert.equal(issues.length, 1, '必须报一条（用应用版本比就会漏报）');
    assert.equal(issues[0].level, 'critical');
    assert.match(issues[0].message, /0\.2\.2/, '消息里要带 dsh 运行时版本');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveHostDshVersion: 来源优先级 = dsh 包 > desktop-runtime.json > 根 package.json', () => {
  const dir = tmp();
  try {
    // ① dsh 包优先
    const a1 = makeAsarTree(dir, {
      'package.json': JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '9.9.9' }),
      'dsh/desktop-runtime.json': JSON.stringify({ release: { version: '8.8.8' } }),
      'dsh/node_modules/@deepseek-ai/dsh/package.json': JSON.stringify({ name: '@deepseek-ai/dsh', version: '7.7.7' }),
    });
    const r1 = resolveHostDshVersion(a1);
    assert.equal(r1.version, '7.7.7', 'dsh 包版本优先');
    assert.match(r1.source, /dsh\/node_modules/);

    // ② 没有 dsh 包 ⇒ 用 desktop-runtime.json
    const a2 = makeAsarTree(dir, {
      'package.json': JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '9.9.9' }),
      'dsh/desktop-runtime.json': JSON.stringify({ release: { version: '8.8.8' } }),
    });
    const r2 = resolveHostDshVersion(a2);
    assert.equal(r2.version, '8.8.8');
    assert.match(r2.source, /desktop-runtime/);

    // ③ 只剩根 package.json ⇒ 兜底且**标注语义不同**
    const a3 = makeAsarTree(dir, {
      'package.json': JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '9.9.9' }),
    });
    const r3 = resolveHostDshVersion(a3);
    assert.equal(r3.version, '9.9.9');
    assert.match(r3.source, /桌面应用版本/, '兜底来源必须标注它不是 dsh 运行时版本');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listAsarFiles: 列出归档内全部文件路径（宿主真实形状是嵌套路径）', () => {
  const dir = tmp();
  try {
    const asar = makeAsarTree(dir, {
      'package.json': '{}',
      'dsh/node_modules/@deepseek-ai/dsh/package.json': '{}',
    });
    const files = listAsarFiles(asar);
    assert.ok(files.includes('package.json'));
    assert.ok(files.includes('dsh/node_modules/@deepseek-ai/dsh/package.json'));
    assert.equal(files.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⛔ 宿主查不到 ⇒ info 且措辞明说「没查」（不许报成"一致"）', () => {
  // 三个来源全部失效：env 无、AGENTS.local.md 无、扫描位无
  const dir = tmp();
  try {
    const issues = checkHostVersion('0.2.1-rc.2', {
      env: { DSH_HOST_APP_ASAR: '', LOCALAPPDATA: dir, ProgramFiles: dir },
      repoRoot: dir,
    });
    assert.equal(issues.length, 1, '查不到时必须报一条（不能静默）');
    assert.equal(issues[0].level, 'info', '查不到不是 critical（不是"不一致"，是"没查"）');
    assert.equal(issues[0].kind, 'host-version-unknown');
    assert.match(issues[0].message, /没查/, '措辞必须明说"没查"');
    assert.doesNotMatch(issues[0].message, /版本一致|已核对/, '不许说成核对过了');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⛔ 宿主路径存在但读不出版本 ⇒ info（同样说"没查"，不假绿）', () => {
  const dir = tmp();
  try {
    const asar = join(dir, 'app.asar');
    writeFileSync(asar, 'not-an-asar');
    const issues = checkHostVersion('0.2.1-rc.2', { env: { DSH_HOST_APP_ASAR: asar } });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, 'host-version-unread');
    assert.match(issues[0].message, /没核对/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findHostAppAsar: env 优先；env 指向不存在 ⇒ 回落到 AGENTS.local.md 键', () => {
  const dir = tmp();
  try {
    const asar = makeAsar(dir, { name: '@deepseek-ai/dsh-desktop', version: '1.2.3' });
    const local = join(dir, 'AGENTS.local.md');
    writeFileSync(local, `hostAppAsar: ${asar}\n`);

    // env 有效 ⇒ 用 env
    const viaEnv = findHostAppAsar({ env: { DSH_HOST_APP_ASAR: asar }, repoRoot: dir });
    assert.equal(viaEnv?.source, 'env:DSH_HOST_APP_ASAR');

    // env 指向不存在 ⇒ 回落到 AGENTS.local.md
    const viaLocal = findHostAppAsar({
      env: { DSH_HOST_APP_ASAR: join(dir, 'nope.asar') }, repoRoot: dir,
    });
    assert.equal(viaLocal?.source, 'AGENTS.local.md:hostAppAsar');
    assert.equal(viaLocal?.path, asar);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readAsarPackage: 读不到 / 格式不对 ⇒ null（不抛、不猜）', () => {
  const dir = tmp();
  try {
    assert.equal(readAsarPackage(join(dir, 'missing.asar')), null);
    const bad = join(dir, 'bad.asar');
    writeFileSync(bad, 'x');
    assert.equal(readAsarPackage(bad), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
