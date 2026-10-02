// bin/check-publish-safety.test.mjs —— 发布安全门禁的测试
//
// ⭐ 重心：证明这个门禁**真的能拦住危险配置**。
//    一个只会打印「✅ 通过」的检查器比没有检查器更危险。
//    每个用例都构造一种真实的误发布形态，断言它被拦。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SCRIPT = join(__dirname, 'check-publish-safety.mjs');
const NODE = process.execPath;

/** 造一个最小仓库，pkg 是要写进 package.json 的内容。 */
function makeSandbox(pkg, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'publish-safety-'));
  mkdirSync(join(root, 'bin'), { recursive: true });
  cpSync(SCRIPT, join(root, 'bin', 'check-publish-safety.mjs'));
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
  writeFileSync(join(root, 'VERSION'), '# 矩阵\n\n## 当前\n\n| AGINT | dsh minimum |\n|---|---|\n| v0.9.0 | 0.1.7-rc.1 |\n', 'utf8');
  // 白名单里被要求的路径必须真实存在
  mkdirSync(join(root, 'plugins', 'p1'), { recursive: true });
  mkdirSync(join(root, 'presets'), { recursive: true });
  writeFileSync(join(root, 'cordis.patch.yml'), 'plugins: []\n', 'utf8');
  for (const [name, content] of Object.entries(extra)) {
    const p = join(root, name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
  return root;
}

function run(root) {
  const r = spawnSync(NODE, [join(root, 'bin', 'check-publish-safety.mjs')], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: r.status, output: `${r.stdout || ''}\n${r.stderr || ''}` };
}

const GOOD_FILES = ['cordis.patch.yml', 'VERSION', 'plugins/', 'presets/'];
const BASE = { name: '@agint/host', version: '0.9.0', private: true, files: GOOD_FILES };

test('基线：private + 合理白名单 ⇒ 通过', () => {
  const root = makeSandbox(BASE);
  try {
    const r = run(root);
    assert.equal(r.status, 0, `应当通过：\n${r.output}`);
    assert.match(r.output, /0 ERROR/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('拦：files 含 node_modules', () => {
  const root = makeSandbox({ ...BASE, files: [...GOOD_FILES, 'node_modules'] });
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(r.output, /危险路径 "node_modules"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('拦：files 含 .agint-preimage（绝对路径泄露）', () => {
  const root = makeSandbox({ ...BASE, files: [...GOOD_FILES, '.agint-preimage'] });
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(r.output, /\.agint-preimage.*绝对路径/s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('拦：files 含备份残留（实测根目录有 2 个 *.bak-*）', () => {
  const root = makeSandbox({ ...BASE, files: [...GOOD_FILES, 'cordis.patch.yml.bak-20260929'] }, {
    'cordis.patch.yml.bak-20260929': 'x',
  });
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(r.output, /备份残留/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('拦：files 含 packages（导出包含脱敏后的 runtime 数据）', () => {
  const root = makeSandbox({ ...BASE, files: [...GOOD_FILES, 'packages'] });
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(r.output, /危险路径 "packages"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('拦：files 缺 plugins（包发出去完全不可用）', () => {
  const root = makeSandbox({ ...BASE, files: ['cordis.patch.yml'] });
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(r.output, /files 缺必需路径 "plugins\/"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('拦：files 里有拼错的路径（静默少内容，不会报错）', () => {
  const root = makeSandbox({ ...BASE, files: [...GOOD_FILES, 'preset/'] }); // 少了 s
  try {
    const r = run(root);
    assert.equal(r.status, 1, '拼错路径必须拦住 —— npm 不会报错，只会静默少打包');
    assert.match(r.output, /"preset\/" 在仓库中不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('拦：完全没有 files 白名单', () => {
  const { files, ...noFiles } = BASE;
  const root = makeSandbox(noFiles);
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(r.output, /没有 `files` 白名单/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('拦：private:false 但前置未齐（.npmrc / CI 都没有）', () => {
  const root = makeSandbox({ ...BASE, private: false });
  try {
    const r = run(root);
    assert.equal(r.status, 1, '移除 private 是不可撤回动作，前置不齐必须当场拦住');
    assert.match(r.output, /private 被设为 false，但发布前置未齐备/);
    assert.match(r.output, /\.npmrc/);
    assert.match(r.output, /\.github\/workflows/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('拦：版本号与 VERSION 表不一致', () => {
  const root = makeSandbox({ ...BASE, version: '0.8.6' });
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(r.output, /版本不一致.*0\.8\.6.*≠.*0\.9\.0/s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('拦：package.json 是坏 JSON 时非零退出（不是静默通过）', () => {
  const root = makeSandbox(BASE);
  try {
    writeFileSync(join(root, 'package.json'), '{ broken', 'utf8');
    const r = run(root);
    // ⚠️ 注意：坏 JSON 会让 **Node 的 ESM 加载器**先崩（它在 import 任何模块前
    // 就读 package.json），脚本本身可能一行都没执行。所以这里只断言
    // 「非零退出 + 输出里能看出是 package.json 的问题」——
    // 不能断言脚本自己的文案，那种断言在真实 Node 行为下永远不成立。
    assert.notEqual(r.status, 0, '坏 JSON 绝不能静默通过');
    assert.match(r.output, /package\.json|JSON/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('拦：package.json 缺失时给明确修法', () => {
  const root = makeSandbox(BASE);
  try {
    rmSync(join(root, 'package.json'));
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(r.output, /package\.json 不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('真实仓库当前状态必须通过（防测试与实况脱节）', () => {
  const r = spawnSync(NODE, [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  assert.equal(r.status, 0, `真实仓库必须通过本门禁：\n${out}`);
  assert.match(out, /private=true/);
});
