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
import { checkHostVersion, findHostAppAsar, resolveHostDshVersion, isCliInstallation } from '../bin/host-version.mjs';
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

// ─────────────────────────────────────────────────────────────────────────────
// 2026-11-03 补：CLI 形态与「配错了」必须不同形
//
// 背景：`host-version-unknown` 自 2026-10-21 起一直挂在门禁输出里。真实成因是
// **本机是 npm/CLI 装的 dsh（无 Electron resources/）**，根本没有第二个宿主 ——
// 但原措辞「未找到 ⇒ 没核对」会让人以为配错了路径，每台 CLI 机器都会收到一条假警报。
// 这组用例守：形态不同 ⇒ 结论类型不同 ⇒ 不许合并成同一条 INFO。
// ─────────────────────────────────────────────────────────────────────────────

/** 造一个假 npm 安装树：<prefix>/bin/dsh + <prefix>/lib/node_modules/@deepseek-ai/dsh */
function makeCliPrefix(withResources = false) {
  const prefix = tmp();
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  const pkgDir = join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9' }));
  writeFileSync(join(prefix, 'bin', 'dsh'), '#!/usr/bin/env node\n');
  if (withResources) {
    mkdirSync(join(pkgDir, 'resources'), { recursive: true });
    makeAsar(join(pkgDir, 'resources'), { name: '@deepseek-ai/dsh-desktop', version: '9.9.9' });
  }
  return prefix;
}

test('CLI 形态（有 dsh 包、无 resources/）⇒ not-applicable，不说「没查到」', () => {
  const prefix = makeCliPrefix(false);
  const dir = tmp();
  try {
    const issues = checkHostVersion('0.2.1-rc.5', {
      env: { PATH: join(prefix, 'bin') },
      repoRoot: dir,          // 无 AGENTS.local.md
    });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, 'host-version-not-applicable', 'CLI 形态必须单独归类');
    assert.equal(issues[0].level, 'info', '仍不许升成 critical（它不是不一致）');
    assert.match(issues[0].message, /npm|CLI/, '措辞必须点明这是安装形态，不是缺失');
    assert.doesNotMatch(issues[0].message, /未找到真实宿主/, '⛔ 不许沿用「未找到」的措辞');
  } finally {
    rmSync(prefix, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⛔ 阴性对照：装了 resources/ 的 dsh 不许被判成 CLI（那是桌面版）', () => {
  const prefix = makeCliPrefix(true);   // 有 resources/app.asar
  const dir = tmp();
  try {
    const issues = checkHostVersion('0.2.1-rc.5', {
      env: { PATH: join(prefix, 'bin') },
      repoRoot: dir,
    });
    assert.notEqual(
      issues[0]?.kind,
      'host-version-not-applicable',
      '有 resources/ 就不是 CLI 形态 —— 误判会让真正的宿主版本不一致被当成「不适用」而放过',
    );
  } finally {
    rmSync(prefix, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⛔ 阴性对照：显式配了不存在的 hostAppAsar ⇒ 仍是 unknown（配置错，不是形态问题）', () => {
  const prefix = makeCliPrefix(false);
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'AGENTS.local.md'), 'hostAppAsar: /nonexistent/app.asar\n');
    const issues = checkHostVersion('0.2.1-rc.5', {
      env: { PATH: join(prefix, 'bin') },
      repoRoot: dir,
    });
    assert.equal(
      issues[0]?.kind,
      'host-version-unknown',
      '配了锚点却扫不到 = 配错了，必须报 unknown 让用户去修，不许说「不适用」',
    );
  } finally {
    rmSync(prefix, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⛔ 不许回探进程状态：env 里没有任何 dsh 线索时判不出 CLI', () => {
  const dir = tmp();
  try {
    // 空 env ⇒ 候选集为空 ⇒ 必须返回 false（哪怕这台机器上真的装着 CLI dsh）。
    // 这条守的是「判据可被真跑」：一旦代码去读 process.execPath / 真实 PATH，
    // 隔离 env 的测试就会失去意义（第 180 行那条既有用例会红）。
    assert.equal(isCliInstallation({ env: {}, repoRoot: dir }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
