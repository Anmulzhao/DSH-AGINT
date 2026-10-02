// bin/verify-manifests.test.mjs — 插件 manifest 一致性门禁的测试
//
// 关键：ERROR 级（name 指错 / main 指向不存在的文件）在真实仓库里当前是 0 处，
// 只跑真实仓库**无法证明**它该红时会红。所以这里用临时目录造坏数据，
// 逐条验证每种违规都能被逮到 —— 门禁的价值全在这几条的可靠性上。
//
// 分档纪律也在测试里钉住：version 漂移是 WARN（权威源未定义），
// name / main 错误是 ERROR（挂载会挂到错的 id 或找不到入口）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'verify-manifests.mjs');
const REPO_ROOT = join(__dirname, '..');

const { checkPlugin } = await import(pathToFileURL(SCRIPT).href);

/** 造一个临时插件目录。files: { 'manifest.json': obj|string, 'package.json': obj, 'lib/index.js': '' } */
function makePlugin(dirName, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mf-test-'));
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  }
  return { root, dir };
}

function cleanup({ root }) {
  rmSync(root, { recursive: true, force: true });
}

const GOOD_MANIFEST = {
  name: 'agint-demo',
  version: '1.0.0',
  description: 'demo',
  main: 'lib/index.js',
  spec: { docs: { readme: 'README.md' }, changelog: 'CHANGELOG.md', tests: { entry: 'test/smoke.mjs' } },
};
const GOOD_PACKAGE = { name: 'agint-demo', version: '1.0.0', main: 'lib/index.js' };
const GOOD_FILES = {
  'manifest.json': GOOD_MANIFEST,
  'package.json': GOOD_PACKAGE,
  'lib/index.js': 'export default {};',
  'README.md': '# demo',
  'CHANGELOG.md': '# log',
  'test/smoke.mjs': '// ok',
};

// ── 基线：干净插件必须零问题 ────────────────────────────────────────────────
test('干净插件：0 ERROR 0 WARN（防止门禁误报）', () => {
  const p = makePlugin('agint-demo', GOOD_FILES);
  try {
    const r = checkPlugin(p.dir, 'agint-demo');
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
  } finally {
    cleanup(p);
  }
});

// ── ERROR 级：这三条是该红时必须红的 ────────────────────────────────────────
test('★ manifest.name 与目录名不一致 ⇒ ERROR（挂载会挂到错的 id）', () => {
  const p = makePlugin('agint-demo', {
    ...GOOD_FILES,
    'manifest.json': { ...GOOD_MANIFEST, name: 'agint-OTHER' },
    'package.json': { ...GOOD_PACKAGE, name: 'agint-OTHER' },
  });
  try {
    const r = checkPlugin(p.dir, 'agint-demo');
    assert.ok(
      r.errors.some((e) => e.kind === 'NAME_DIR_MISMATCH'),
      `未报 NAME_DIR_MISMATCH：${JSON.stringify(r.errors)}`,
    );
  } finally {
    cleanup(p);
  }
});

test('★ manifest.main 指向不存在的文件 ⇒ ERROR（入口找不到，挂载直接失败）', () => {
  const p = makePlugin('agint-demo', {
    'manifest.json': { ...GOOD_MANIFEST, main: 'lib/nope.js' },
    'package.json': { ...GOOD_PACKAGE, main: 'lib/nope.js' },
    'lib/index.js': '',
    README_md: '',
  });
  try {
    const r = checkPlugin(p.dir, 'agint-demo');
    assert.ok(
      r.errors.some((e) => e.kind === 'MAIN_NOT_FOUND'),
      `未报 MAIN_NOT_FOUND：${JSON.stringify(r.errors)}`,
    );
  } finally {
    cleanup(p);
  }
});

test('★ manifest.name 与 package.name 不一致 ⇒ ERROR（两个身份系统认的不是同一个东西）', () => {
  const p = makePlugin('agint-demo', {
    ...GOOD_FILES,
    'package.json': { ...GOOD_PACKAGE, name: 'agint-different' },
  });
  try {
    const r = checkPlugin(p.dir, 'agint-demo');
    assert.ok(r.errors.some((e) => e.kind === 'NAME_MISMATCH'));
  } finally {
    cleanup(p);
  }
});

test('manifest.json 不是合法 JSON ⇒ ERROR（解析不了根本没法挂）', () => {
  const p = makePlugin('agint-demo', { ...GOOD_FILES, 'manifest.json': '{ 坏掉的 json' });
  try {
    const r = checkPlugin(p.dir, 'agint-demo');
    assert.ok(r.errors.some((e) => e.kind === 'MANIFEST_UNPARSEABLE'));
  } finally {
    cleanup(p);
  }
});

// ── WARN 级：漂移，默认不拦 ─────────────────────────────────────────────────
test('version 漂移 ⇒ WARN 而非 ERROR（权威源未定义，不能替人拍板）', () => {
  const p = makePlugin('agint-demo', {
    ...GOOD_FILES,
    'package.json': { ...GOOD_PACKAGE, version: '9.9.9' },
  });
  try {
    const r = checkPlugin(p.dir, 'agint-demo');
    assert.equal(r.errors.length, 0, 'version 漂移不该是 ERROR');
    assert.ok(r.warnings.some((w) => w.kind === 'VERSION_DRIFT'));
  } finally {
    cleanup(p);
  }
});

test('manifest 声明了却不存在的文件 ⇒ WARN', () => {
  const p = makePlugin('agint-demo', {
    'manifest.json': GOOD_MANIFEST,
    'package.json': GOOD_PACKAGE,
    'lib/index.js': '',
    'README.md': '# demo',
  });
  try {
    const r = checkPlugin(p.dir, 'agint-demo');
    const kinds = r.warnings.filter((w) => w.kind === 'DECLARED_FILE_MISSING');
    assert.equal(kinds.length, 2, 'CHANGELOG 与 test entry 都应报缺失');
  } finally {
    cleanup(p);
  }
});

test('无 manifest.json ⇒ WARN（挂载脚本会 fail，但当前有 3 个存量插件如此，默认不拦）', () => {
  const p = makePlugin('agint-demo', { 'package.json': GOOD_PACKAGE, 'lib/index.js': '' });
  try {
    const r = checkPlugin(p.dir, 'agint-demo');
    assert.ok(r.warnings.some((w) => w.kind === 'MANIFEST_MISSING'));
    assert.equal(r.hasManifest, false);
  } finally {
    cleanup(p);
  }
});

// ── 归一：写法差异不是实质问题 ──────────────────────────────────────────────
test('main 的 "./lib/index.js" 与 "lib/index.js" 视为等价（纯写法差异不该报警）', () => {
  const p = makePlugin('agint-demo', {
    ...GOOD_FILES,
    'manifest.json': { ...GOOD_MANIFEST, main: './lib/index.js' },
  });
  try {
    const r = checkPlugin(p.dir, 'agint-demo');
    assert.deepEqual(r.errors, []);
    assert.ok(!r.warnings.some((w) => w.kind === 'MAIN_MISMATCH'));
  } finally {
    cleanup(p);
  }
});

// ── 端到端：真实仓库 ────────────────────────────────────────────────────────
test('真实仓库默认模式退出 0（ERROR 级为 0 —— 身份错误必须保持清零）', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `默认模式不该红，stderr: ${r.stderr}`);
  assert.ok((r.stdout || '').includes('ERROR 0 处'), `ERROR 不为 0：\n${r.stdout}`);
});

test('真实仓库 --strict 退出 1（存量 WARN  backlog 未清）', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--strict'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 1, 'strict 模式应把 WARN 计为失败');
});

test('--json 输出结构完整', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--json'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const j = JSON.parse(r.stdout);
  assert.ok(j.stats.plugins > 0);
  assert.ok(Array.isArray(j.errors));
  assert.ok(Array.isArray(j.warnings));
  assert.equal(typeof j.failed, 'boolean');
});
