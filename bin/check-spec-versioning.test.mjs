// bin/check-spec-versioning.test.mjs —— spec 版本门禁的测试
//
// ⭐ 重心：**每个用例都先构造一份坏矩阵，断言门禁报红**。
//   门禁的价值全在「能抓到什么」上 —— 一个从不报错的门禁等于没有门禁。
//
// ⚠️ 沙箱做法：把 bin/ + docs/specs/ 复制到临时目录再改坏。
//    绝不改真实仓库文件（测试不该有副作用）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const NODE = process.execPath;

/**
 * 复制出沙箱仓库（含门禁依赖的 bin/ 与 docs/specs/）。
 *
 * ⚠️⛔ 不要用 `cpSync(dir, dest, {recursive:true})` —— 本机（Windows）
 *   跑它会**直接崩掉原生层**（0xC0000409 / STATUS_STACK_BUFFER_OVERRUN），
 *   node 进程零输出、退出码 127，连堆栈都没有。已隔离复现确认是该调用本身。
 *   （同族坑见技能 msys-gitbash-path-pitfalls。）
 *   ⇒ 一律改成 readdirSync + 逐文件 cpSync。
 */
function copyDirFlat(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const f of readdirSync(srcDir, { withFileTypes: true })) {
    if (!f.isFile()) continue;
    cpSync(join(srcDir, f.name), join(destDir, f.name));
  }
}

/**
 * 矩阵里声明为消费方、门禁会做存在性检查的文件。
 * 沙箱必须把它们都复制过去，否则真实仓库里正确的声明在沙箱里会被判为失真。
 */
const CONSUMER_FILES = [
  'bin/check-l0-frozen.mjs',
  'bin/check-spec-consistency.mjs',
  'bin/build-spec-index.mjs',
  'bin/validate-contract-schema.mjs',
  'bin/build-scenario-inventory.mjs',
  'bin/export-evolution-package.mjs',
  'bin/verify-evolution-package.mjs',
  'bin/check-preimage-retention.mjs',
  'bin/build-dependency-inventory.mjs',
];

/** 递归平铺复制（⛔ 不用 cpSync recursive —— 本机会崩原生层，见上）。 */
function copyDirFlatIfPresent(srcDir, destDir) {
  if (!existsSafe(srcDir)) return;
  const walk = (rel) => {
    const abs = join(srcDir, rel);
    for (const f of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${f.name}` : f.name;
      if (f.isDirectory()) walk(childRel);
      else if (f.isFile()) {
        const dest = join(destDir, childRel);
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(join(abs, f.name), dest);
      }
    }
  };
  mkdirSync(destDir, { recursive: true });
  walk('');
}

function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'spec-ver-'));
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  cpSync(join(REPO_ROOT, 'bin', 'check-spec-versioning.mjs'), join(root, 'bin', 'check-spec-versioning.mjs'));
  // ⚠️ 必须把「矩阵里被声明为消费方」的文件全部复制进来。
  //    门禁有一条诚实性检查：声明「已实施」但磁盘上找不到 ⇒ 报红。
  //    沙箱少复制文件 ⇒ 真实仓库里正确的声明在沙箱里变成「失真」⇒ 基线用例假失败。
  //    （门禁测试自己的沙箱必须先满足门禁。这不是门禁的错。）
  for (const f of CONSUMER_FILES) {
    if (existsSafe(join(REPO_ROOT, f))) cpSync(join(REPO_ROOT, f), join(root, f));
  }
  // check-l0-frozen 需要它自己的依赖（质量插件契约源文件）
  copyDirFlatIfPresent(join(REPO_ROOT, 'plugins'), join(root, 'plugins'));
  if (existsSafe(join(REPO_ROOT, 'bin', 'lib'))) {
    copyDirFlat(join(REPO_ROOT, 'bin', 'lib'), join(root, 'bin', 'lib'));
  }
  copyDirFlat(join(REPO_ROOT, 'docs', 'specs'), join(root, 'docs', 'specs'));
  if (existsSafe(join(REPO_ROOT, 'docs', 'l0-frozen-baseline.json'))) {
    cpSync(join(REPO_ROOT, 'docs', 'l0-frozen-baseline.json'), join(root, 'docs', 'l0-frozen-baseline.json'));
  }
  return root;
}
function existsSafe(p) {
  try { statSync(p); return true; } catch { return false; }
}

function run(root) {
  const r = spawnSync(NODE, [join(root, 'bin', 'check-spec-versioning.mjs')], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  return { status: r.status, output: `${r.stdout || ''}\n${r.stderr || ''}` };
}

function patchMatrix(root, mutate) {
  const p = join(root, 'docs', 'specs', 'compatibility-matrix.json');
  const m = JSON.parse(readFileSync(p, 'utf8'));
  mutate(m);
  writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`, 'utf8');
}
function patchIndex(root, mutate) {
  const p = join(root, 'docs', 'specs', 'INDEX.json');
  const m = JSON.parse(readFileSync(p, 'utf8'));
  mutate(m);
  writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`, 'utf8');
}

test('✅ 真实矩阵必须 0 ERROR（本门禁自身的基线）', () => {
  const root = makeSandbox();
  try {
    const r = run(root);
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /0 ERROR/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ 矩阵里的规范未登记在 INDEX → 报红', () => {
  const root = makeSandbox();
  try {
    patchMatrix(root, (m) => { m.rules.push({ spec: 'ghost-spec', currentVersion: '1.0', consumers: [], breakingChanges: [], upgradePolicy: 'x' }); });
    const r = run(root);
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /未登记的规范：ghost-spec/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ 新增规范但矩阵漏规则 → 报红（最容易漏的一条）', () => {
  const root = makeSandbox();
  try {
    patchIndex(root, (m) => {
      m.specs.push({ id: 'new-spec', status: 'DESIGN', version: '1.0', files: {} });
    });
    const r = run(root);
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /new-spec 已登记在 INDEX.json.*没有对应规则/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ 消费方标注「未实施」但文件已存在 → 报红（诚实性）', () => {
  const root = makeSandbox();
  try {
    patchMatrix(root, (m) => {
      m.rules.find((x) => x.spec === 'evolution-package').consumers = ['bin/export-evolution-package.mjs (未实施)'];
    });
    const r = run(root);
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /标注「未实施」，但该文件已存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ 消费方标注「已实施」但文件不存在 → 报红（反向失真）', () => {
  const root = makeSandbox();
  try {
    patchMatrix(root, (m) => {
      m.rules.find((x) => x.spec === 'evolution-contract').consumers = ['bin/no-such-file.mjs (已实施)'];
    });
    const r = run(root);
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /标注「已实施」，但磁盘上找不到/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ 有 breakingChanges 却仍是 1.x → 报红（该升 major）', () => {
  const root = makeSandbox();
  try {
    patchMatrix(root, (m) => {
      m.rules.find((x) => x.spec === 'evaluation-protocol').breakingChanges = ['删除 labelAuthority 字段'];
    });
    const r = run(root);
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /应升 major/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ 版本号带 v 前缀 / 三段式 → 报红（宽松格式会让比较静默失配）', () => {
  for (const bad of ['v1.0', '1.0.0', '1']) {
    const root = makeSandbox();
    try {
      patchMatrix(root, (m) => { m.rules[0].currentVersion = bad; });
      const r = run(root);
      assert.equal(r.status, 1, `版本号 ${bad} 应被拒\n${r.output}`);
      assert.match(r.output, /版本号非法/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('⛔ INDEX 与矩阵的版本不一致 → 报红', () => {
  const root = makeSandbox();
  try {
    patchMatrix(root, (m) => { m.rules.find((x) => x.spec === 'evolution-contract').currentVersion = '2.0'; });
    patchIndex(root, (m) => {
      const s = m.specs.find((x) => x.id === 'evolution-contract');
      if (s.version !== undefined) s.version = '1.0';
    });
    const r = run(root);
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /在 INDEX.json.*与矩阵.*里不一致/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ 删掉「脱敏只可收紧」不变量 → 报红（放松脱敏的入口）', () => {
  const root = makeSandbox();
  try {
    patchMatrix(root, (m) => {
      m.invariants = m.invariants.filter((x) => !/脱敏规则只可收紧/.test(x));
    });
    const r = run(root);
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /缺少「脱敏规则只可收紧不可放松」/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ upgradePolicy 删掉「收紧/放松」字样 → 报红', () => {
  const root = makeSandbox();
  try {
    patchMatrix(root, (m) => {
      m.rules.find((x) => x.spec === 'evolution-package').upgradePolicy = '随便改';
    });
    const r = run(root);
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /未声明「脱敏只可收紧不可放松」/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ upgradePolicy 为空 → 报红', () => {
  const root = makeSandbox();
  try {
    patchMatrix(root, (m) => { m.rules[0].upgradePolicy = '   '; });
    const r = run(root);
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /缺 upgradePolicy/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ knownGaps 谎报「门禁尚未实施」→ 报红（该销账了）', () => {
  const root = makeSandbox();
  try {
    patchMatrix(root, (m) => {
      m.knownGaps.unshift({ gap: 'check-spec-versioning.mjs 尚未实施', impact: 'x', plannedBy: 'y' });
    });
    const r = run(root);
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /该 gap 应销账/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ invariants 为空 → 报红（不变量清单本身要有人看护）', () => {
  const root = makeSandbox();
  try {
    patchMatrix(root, (m) => { m.invariants = []; });
    const r = run(root);
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /invariants 为空/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ 权威 L0 检查缺失 → 报红（不许静默跳过不变量）', () => {
  const root = makeSandbox();
  try {
    rmSync(join(root, 'bin', 'check-l0-frozen.mjs'), { force: true });
    const r = run(root);
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /权威 L0 冻结检查不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ 矩阵坏 JSON → 报红且提示文件名（不是崩栈）', () => {
  const root = makeSandbox();
  try {
    writeFileSync(join(root, 'docs', 'specs', 'compatibility-matrix.json'), '{ 这不是 JSON', 'utf8');
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(r.output, /compatibility-matrix\.json 解析失败/);
    assert.doesNotMatch(r.output, /at Object\.|at Module\._compile/, '⛔ 抛了未捕获栈');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ 矩阵文件不存在 → 报红', () => {
  const root = makeSandbox();
  try {
    rmSync(join(root, 'docs', 'specs', 'compatibility-matrix.json'), { force: true });
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(r.output, /兼容矩阵不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ 缺 upgradePolicy 的规范必须被点名（不能只报数量）', () => {
  const root = makeSandbox();
  try {
    patchMatrix(root, (m) => { delete m.rules[1].upgradePolicy; });
    const r = run(root);
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /evaluation-protocol 缺 upgradePolicy/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
