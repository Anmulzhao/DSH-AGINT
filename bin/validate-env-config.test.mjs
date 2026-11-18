#!/usr/bin/env node
/**
 * bin/validate-env-config.test.mjs — 机器级环境校验器行为测试（多机配置分层步 1-2）。
 *
 * 判据来源：dsh-app-boot loadLayeredEnv()（只读 cwd .env + $DSH_HOME/.env，
 * DSH_ 与 XDG_ 前缀 bootstrap-only 禁入 .env）与 cordis.patch.yml 的真实 env 通道。
 * 跑法：node --test bin/validate-env-config.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SCRIPT = join(REPO, 'bin', 'validate-env-config.mjs');

function run(args, env) {
  const r = spawnSync(process.execPath, [SCRIPT, '--json', ...args], {
    env, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(r.status, 0, `校验器自身应 exit 0（不带 --strict）：${r.stderr}`);
  return JSON.parse(r.stdout);
}

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'agint-env-test-'));
  return dir;
}

// 干净环境：只留系统必需项，机器通道全部未设
function cleanEnv(extra = {}) {
  return { SystemRoot: process.env.SystemRoot || 'C:\\Windows', PATH: process.env.PATH, ...extra };
}

test('AGINT_REPO_ROOT 是必填通道：未配置 → FAIL', () => {
  const home = tmp();
  const cwd = tmp();
  try {
    const out = run([`--repo-root=${REPO}`, `--cwd=${cwd}`], cleanEnv({ DSH_HOME: home }));
    const ch = out.channels.find((c) => c.key === 'AGINT_REPO_ROOT');
    assert.ok(ch, 'CHANNELS 必须登记 AGINT_REPO_ROOT（cordis 4 处 repoRoot 的真通道）');
    assert.equal(ch.status, 'FAIL');
    assert.ok(out.failCount >= 1);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); }
});

test('AGINT_DATA_HOME 与 AGINT_WIKI_ROOT 已登记为可选通道', () => {
  const home = tmp();
  const cwd = tmp();
  try {
    const out = run([`--repo-root=${REPO}`, `--cwd=${cwd}`], cleanEnv({ DSH_HOME: home }));
    for (const key of ['AGINT_DATA_HOME', 'AGINT_WIKI_ROOT']) {
      const ch = out.channels.find((c) => c.key === key);
      assert.ok(ch, `CHANNELS 必须登记 ${key}`);
      assert.equal(ch.status, 'unset');
    }
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); }
});

test('机器值从 $DSH_HOME/.env（user 层）读到 —— 与运行时加载器一致', () => {
  const home = tmp();
  const cwd = tmp();
  const repo = tmp();
  mkdirSync(join(repo, 'plugins'), { recursive: true });
  try {
    writeFileSync(join(home, '.env'), `AGINT_REPO_ROOT=${repo}\n`);
    const out = run([`--repo-root=${repo}`, `--cwd=${cwd}`], cleanEnv({ DSH_HOME: home }));
    const ch = out.channels.find((c) => c.key === 'AGINT_REPO_ROOT');
    assert.equal(ch.status, 'ok');
    assert.equal(ch.value, repo);
    assert.match(ch.from, /DSH_HOME|user/);
  } finally { [home, cwd, repo].forEach((d) => rmSync(d, { recursive: true, force: true })); }
});

test('优先级：process.env > cwd .env（project 层）> $DSH_HOME/.env（user 层）', () => {
  const home = tmp();
  const cwd = tmp();
  const repo = tmp();
  const a = tmp(); const b = tmp(); const c = tmp();
  mkdirSync(join(repo, 'plugins'), { recursive: true });
  try {
    writeFileSync(join(cwd, '.env'), `AGINT_REPO_ROOT=${b}\n`);
    writeFileSync(join(home, '.env'), `AGINT_REPO_ROOT=${c}\n`);
    // project 层压过 user 层
    let out = run([`--repo-root=${repo}`, `--cwd=${cwd}`], cleanEnv({ DSH_HOME: home }));
    assert.equal(out.channels.find((x) => x.key === 'AGINT_REPO_ROOT').value, b);
    // 进程 env 压过一切
    out = run([`--repo-root=${repo}`, `--cwd=${cwd}`], cleanEnv({ DSH_HOME: home, AGINT_REPO_ROOT: a }));
    assert.equal(out.channels.find((x) => x.key === 'AGINT_REPO_ROOT').value, a);
  } finally { [home, cwd, repo, a, b, c].forEach((d) => rmSync(d, { recursive: true, force: true })); }
});

test('DSH_* bootstrap-only 键写进 .env → FAIL（运行时加载器会直接抛错）', () => {
  const home = tmp();
  const cwd = tmp();
  const repo = tmp();
  mkdirSync(join(repo, 'plugins'), { recursive: true });
  try {
    writeFileSync(join(home, '.env'), 'DSH_HOME=/some/where\n');
    const out = run([`--repo-root=${repo}`, `--cwd=${cwd}`], cleanEnv({ DSH_HOME: home }));
    assert.ok(out.failCount >= 1, 'bootstrap-only 键入 .env 必须计入 FAIL');
    assert.ok(JSON.stringify(out).includes('DSH_HOME'), '报告必须点名违例键');
  } finally { [home, cwd, repo].forEach((d) => rmSync(d, { recursive: true, force: true })); }
});

test('硬编码扫描覆盖 bin/ 与 cordis.patch.yml 的真实代码行', () => {
  const repo = tmp();
  mkdirSync(join(repo, 'bin'), { recursive: true });
  mkdirSync(join(repo, 'plugins'), { recursive: true });
  try {
    writeFileSync(join(repo, 'bin', 'bad.mjs'), "const p = 'D:/DSH/AGINT-date';\n");
    writeFileSync(join(repo, 'cordis.patch.yml'), "repoRoot: 'D:/DSH/project'\n");
    const out = run([`--repo-root=${repo}`], cleanEnv({}));
    const files = out.hardcodedMachinePaths.map((h) => h.file.replace(/\\/g, '/'));
    assert.ok(files.some((f) => f.includes('bin/bad.mjs')), 'bin/ 必须在扫描范围');
    assert.ok(files.some((f) => f.includes('cordis.patch.yml')), 'cordis.patch.yml 必须在扫描范围');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('硬编码扫描跳过注释行（js 与 yml 两种注释形态）', () => {
  const repo = tmp();
  mkdirSync(join(repo, 'bin'), { recursive: true });
  mkdirSync(join(repo, 'plugins'), { recursive: true });
  try {
    writeFileSync(join(repo, 'bin', 'ok.mjs'), "// 示例 D:/DSH/foo\n/* D:/DSH/bar */\n * D:/DSH/baz\nconst x = 1;\n");
    writeFileSync(join(repo, 'cordis.patch.yml'), "# 注释 D:/DSH/foo\nkey: !!js (process.env.X || 'rel')\n");
    const out = run([`--repo-root=${repo}`], cleanEnv({}));
    assert.equal(out.hardcodedMachinePaths.length, 0);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('盘符正则不误报 URL scheme 与正则字面量（https: / file: / name:\\s）', () => {
  const repo = tmp();
  mkdirSync(join(repo, 'plugins'), { recursive: true });
  try {
    writeFileSync(join(repo, 'plugins', 'ok.js'), [
      "const u = 'https://registry.npmjs.org';",
      "const f = `file://${p}`;",
      "const re = /name:\\s*['\"]?/;",
      "const r2 = /openviking:\\/\\/search/;",
      "const r3 = /\\b[a-z][a-z0-9+.-]*:\\/\\/[^\\s:/@]+:[^\\s:/@]+@[^\\s/]+/gi;",
      "const cls = /[^\\s:/@]+/;",
    ].join('\n'));
    const out = run([`--repo-root=${repo}`], cleanEnv({}));
    assert.equal(out.hardcodedMachinePaths.length, 0);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('盘符正则认得 JS 转义的双反斜杠路径（C:\\\\Users\\\\…）', () => {
  const repo = tmp();
  mkdirSync(join(repo, 'plugins'), { recursive: true });
  try {
    writeFileSync(join(repo, 'plugins', 'bad.js'), "const p = 'C:\\\\Users\\\\me\\\\AppData';\n");
    const out = run([`--repo-root=${repo}`], cleanEnv({}));
    assert.equal(out.hardcodedMachinePaths.length, 1);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('本仓 bin 两个脚本不得含写死机器盘符兜底（check-arch-edges / evolution-viz-snapshot）', () => {
  const drive = /[A-Za-z]:[\\/]/;
  for (const f of ['bin/check-arch-edges.mjs', 'bin/evolution-viz-snapshot.mjs']) {
    const lines = readFileSync(join(REPO, f), 'utf8').split(/\r?\n/);
    const hits = lines.filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && drive.test(l);
    });
    assert.deepEqual(hits, [], `${f} 存在写死盘符路径的代码行`);
  }
});

test('--strict 有 FAIL 时 exit 1（门禁可阻断）', () => {
  const home = tmp();
  const cwd = tmp();
  try {
    const r = spawnSync(process.execPath, [SCRIPT, '--strict', `--repo-root=${REPO}`, `--cwd=${cwd}`], {
      env: cleanEnv({ DSH_HOME: home }), encoding: 'utf8', timeout: 30000,
    });
    assert.equal(r.status, 1);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); }
});