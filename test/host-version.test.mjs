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
import { checkHostVersion, findHostAppAsar } from '../bin/host-version.mjs';
import { readAsarPackage } from '../bin/asar-read.mjs';

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

function tmp() {
  return mkdtempSync(join(tmpdir(), 'agint-hostver-'));
}

test('⛔ 宿主版本与判据不一致 ⇒ critical（抓住假绿）', () => {
  const dir = tmp();
  try {
    const asar = makeAsar(dir, { name: '@deepseek-ai/dsh-desktop', version: '9.9.9' });
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
    const asar = makeAsar(dir, { name: '@deepseek-ai/dsh-desktop', version: '0.2.1-rc.2' });
    const issues = checkHostVersion('0.2.1-rc.2', { env: { DSH_HOST_APP_ASAR: asar } });
    assert.deepEqual(issues, [], '一致时不该报');
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
