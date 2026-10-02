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

const { checkPlugin, loadMountedPluginDirs } = await import(pathToFileURL(SCRIPT).href);

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

// ── MANIFEST_MISSING：按挂载声明判定（2026-10-02 修订）──────────────────────
// 旧实现 glob 目录后一律报警，实测 3 处全是误报（父容器 / 两个未挂载目录）。
// 挂载脚本只处理 patch 里声明过的条目，所以「没被声明的目录缺 manifest」不是风险。
test('★ 已挂载却无 manifest.json ⇒ ERROR（挂载脚本读不到入口，直接 fail）', () => {
  const p = makePlugin('agint-demo', { 'package.json': GOOD_PACKAGE, 'lib/index.js': '' });
  try {
    const r = checkPlugin(p.dir, 'agint-demo', { mounted: true });
    assert.ok(
      r.errors.some((e) => e.kind === 'MANIFEST_MISSING'),
      `未报 MANIFEST_MISSING：${JSON.stringify(r.errors)}`,
    );
  } finally {
    cleanup(p);
  }
});

test('★ 未挂载且无 manifest.json ⇒ 不报错（挂载脚本根本不读它）', () => {
  const p = makePlugin('agint-demo', { 'package.json': GOOD_PACKAGE, 'lib/index.js': '' });
  try {
    const r = checkPlugin(p.dir, 'agint-demo', { mounted: false });
    assert.deepEqual(r.errors, [], '未挂载不该 ERROR');
    assert.ok(
      !r.warnings.some((w) => w.kind === 'MANIFEST_MISSING'),
      '未挂载不该报 MANIFEST_MISSING —— 这正是被修掉的 3 处误报',
    );
    assert.ok(r.notes.some((n) => n.kind === 'NOT_MOUNTED_NO_MANIFEST'), '应记为「不校验」而非静默');
  } finally {
    cleanup(p);
  }
});

test('默认（不传 mounted）按已挂载处理 —— 拿不到声明时保守不漏报', () => {
  const p = makePlugin('agint-demo', { 'package.json': GOOD_PACKAGE, 'lib/index.js': '' });
  try {
    const r = checkPlugin(p.dir, 'agint-demo');
    assert.ok(r.errors.some((e) => e.kind === 'MANIFEST_MISSING'));
  } finally {
    cleanup(p);
  }
});

// ── 挂载集合解析：来源是 patch 的真实声明，不是目录 glob ────────────────────
test('★ 挂载集合不含被注释掉的条目（正则必须锚定行首）', () => {
  const m = loadMountedPluginDirs();
  assert.equal(m.ok, true, `解析失败：${m.reason}`);
  // agint-quality-report 在 patch 里是 `# - id: agint-quality-report`（整段注释）
  assert.ok(
    !m.dirs.has('agint-quality/agint-quality-report'),
    '注释掉的挂载条目被当成真挂载了 —— 不锚定行首会中这个坑',
  );
});

test('★ 父容器 agint-quality 本身不算挂载，子模块才算（修掉误报的关键）', () => {
  const m = loadMountedPluginDirs();
  assert.ok(
    !m.dirs.has('agint-quality'),
    'agint-quality 是嵌套父容器，patch 挂的是它的子模块；把它算作挂载就会复现旧误报',
  );
  assert.ok(
    [...m.dirs].some((d) => d.startsWith('agint-quality/')),
    '子模块应当被识别为挂载目录',
  );
});

test('挂载集合不含未在 patch 声明的目录', () => {
  const m = loadMountedPluginDirs();
  for (const d of ['agint-search-tools', 'agint-session-extract']) {
    assert.ok(!m.dirs.has(d), `${d} 无挂载声明，不该出现在挂载集合里`);
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

test('★ 真实仓库：MANIFEST_MISSING 为 0（3 处旧报已确认为误报，不得复现）', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--json'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const j = JSON.parse(r.stdout);
  const kinds = [...j.errors, ...j.warnings].filter((x) => x.kind === 'MANIFEST_MISSING');
  assert.equal(
    kinds.length,
    0,
    `MANIFEST_MISSING 应已归零，仍报：${JSON.stringify(kinds)}`,
  );
  // 3 个曾误报的目录必须落进「不校验」而不是被静默吞掉
  const noted = j.notes.map((n) => n.plugin);
  for (const d of ['agint-quality', 'agint-search-tools', 'agint-session-extract']) {
    assert.ok(noted.includes(d), `${d} 应被标注为「未挂载，不校验」，而不是消失在输出里`);
  }
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
