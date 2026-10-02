// bin/check-protocol-gates.test.mjs —— Phase 3 协议族门禁的测试
//
// 测的不只是「能跑通」，而是**门禁能不能抓到问题**。
// 一个永远绿的检查器比没有检查器更危险 —— 它给人虚假的安全感。
//
// 覆盖：
//   A. build-spec-index：--check 不写盘（防自证循环）/ 孤儿 / 悬空 / hash 漂移
//   B. check-spec-consistency：四类错误各自能被抓到
//   C. spec-hash 口径：字节敏感（只改格式也要能检出）

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const BUILD = join(__dirname, 'build-spec-index.mjs');
const CONSISTENCY = join(__dirname, 'check-spec-consistency.mjs');
const NODE = process.execPath;

/**
 * 在临时目录里造一个最小「仓库」，让两个门禁脚本对着它跑。
 * 必须造真实目录结构 —— 两个脚本都按 REPO_ROOT 相对定位，
 * 且一致性门禁还要读 docs/l0-frozen-baseline.json。
 */
function makeSandbox(specFiles) {
  const root = mkdtempSync(join(tmpdir(), 'spec-gate-'));
  const bin = join(root, 'bin');
  const lib = join(bin, 'lib');
  mkdirSync(join(root, 'docs', 'specs'), { recursive: true });
  mkdirSync(lib, { recursive: true });
  // 复制脚本与共享库
  for (const f of ['build-spec-index.mjs', 'check-spec-consistency.mjs']) {
    cpSync(join(__dirname, f), join(bin, f));
  }
  for (const f of ['canonical-json.mjs', 'spec-hash.mjs']) {
    cpSync(join(__dirname, 'lib', f), join(lib, f));
  }
  // 复制 VERSION 与 l0-frozen（两脚本都会读）
  cpSync(join(REPO_ROOT, 'VERSION'), join(root, 'VERSION'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.9.0' }, null, 2));
  writeFileSync(
    join(root, 'docs', 'l0-frozen-baseline.json'),
    JSON.stringify({ _comment: 'test', units: [{ id: 'a' }] }, null, 2),
  );
  for (const [name, content] of Object.entries(specFiles)) {
    writeFileSync(join(root, 'docs', 'specs', name), content, 'utf8');
  }
  return root;
}

function run(root, script, args = []) {
  const r = spawnSync(NODE, [join(root, 'bin', script), ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  // ⚠️ ERROR 走 console.error（stdout / stderr 分流）。断言时必须看 combined，
  //    否则会误判成「门禁没报错」—— 这是本测试第一版的真实 bug：
  //    门禁逻辑是对的，测试却红了 8 条。教训：测 CLI 时永远断言 combined 输出。
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    output: `${r.stdout || ''}
${r.stderr || ''}`,
  };
}

const SCHEMA_V1 = JSON.stringify({ $id: 'x', type: 'object', properties: { a: { type: 'string' } } }, null, 2);

/** 最小可用的 spec 文件集（与 REGISTRY 对齐文件名）。 */
function baseFiles() {
  return {
    'evolution-contract-v1.schema.json': SCHEMA_V1,
    'evolution-contract-v1.md': '# contract\n',
    'evaluation-protocol-v1.md': '# evaluation\n',
    'evolution-package-v1.md': '# package\n',
  };
}

// ── A. build-spec-index ─────────────────────────────────────────────────────

test('build-spec-index 生成后 --check 应通过', () => {
  const root = makeSandbox(baseFiles());
  try {
    assert.equal(run(root, 'build-spec-index.mjs').status, 0);
    const r = run(root, 'build-spec-index.mjs', ['--check']);
    assert.equal(r.status, 0, `生成后 --check 应当通过：\n${r.stdout}\n${r.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('build-spec-index --check 不写盘（防自证循环）', () => {
  const root = makeSandbox(baseFiles());
  try {
    run(root, 'build-spec-index.mjs');
    const p = join(root, 'docs', 'specs', 'INDEX.json');
    // 篡改索引（删掉一份 spec 登记）
    const idx = JSON.parse(readFileSync(p, 'utf8'));
    idx.specs = idx.specs.slice(1);
    writeFileSync(p, JSON.stringify(idx, null, 2), 'utf8');
    const before = readFileSync(p, 'utf8');

    const r = run(root, 'build-spec-index.mjs', ['--check']);
    assert.equal(r.status, 1, '索引被篡改后 --check 必须报红');
    assert.equal(readFileSync(p, 'utf8'), before, '❌ --check 把文件改回去了 ⇒ 自证循环');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('build-spec-index --check 能抓到 schemaHash 漂移', () => {
  const root = makeSandbox(baseFiles());
  try {
    run(root, 'build-spec-index.mjs');
    // 改 schema 内容（保持合法 JSON）
    const p = join(root, 'docs', 'specs', 'evolution-contract-v1.schema.json');
    writeFileSync(p, JSON.stringify({ $id: 'x', type: 'object', properties: { a: { type: 'number' } } }, null, 2), 'utf8');

    const r = run(root, 'build-spec-index.mjs', ['--check']);
    assert.equal(r.status, 1, 'schema 改了但索引没更新 ⇒ 必须报红');
    assert.match(r.output, /schemaHash 与磁盘文件不一致/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('build-spec-index 报出未登记的 spec 文件（孤儿预警）', () => {
  const root = makeSandbox({ ...baseFiles(), 'rogue-spec.md': '# 没登记\n' });
  try {
    const r = run(root, 'build-spec-index.mjs');
    assert.equal(r.status, 0, '生成模式不阻塞，只告警');
    assert.match(r.output, /未登记的 spec 文件 1 个.*rogue-spec\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── B. check-spec-consistency ───────────────────────────────────────────────

test('check-spec-consistency：孤儿规范必须报红', () => {
  const root = makeSandbox({ ...baseFiles(), 'rogue-spec.md': '# 忘了登记\n' });
  try {
    run(root, 'build-spec-index.mjs');
    const r = run(root, 'check-spec-consistency.mjs');
    assert.equal(r.status, 1, '孤儿规范必须阻塞');
    assert.match(r.output, /孤儿规范.*rogue-spec\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check-spec-consistency：悬空引用必须报红', () => {
  const root = makeSandbox(baseFiles());
  try {
    run(root, 'build-spec-index.mjs');
    // 删掉一个被登记的文件
    rmSync(join(root, 'docs', 'specs', 'evaluation-protocol-v1.md'));
    const r = run(root, 'check-spec-consistency.mjs');
    assert.equal(r.status, 1);
    assert.match(r.output, /悬空引用.*evaluation-protocol-v1\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check-spec-consistency：ACTIVE 无 evidence = 状态虚报，必须报红', () => {
  const root = makeSandbox(baseFiles());
  try {
    run(root, 'build-spec-index.mjs');
    const p = join(root, 'docs', 'specs', 'INDEX.json');
    const idx = JSON.parse(readFileSync(p, 'utf8'));
    // 手工把某份标成 ACTIVE，但不给 evidence —— 这是最典型的失真形态
    idx.specs[0].status = 'ACTIVE';
    idx.specs[0].evidence = [];
    writeFileSync(p, JSON.stringify(idx, null, 2), 'utf8');

    const r = run(root, 'check-spec-consistency.mjs');
    assert.equal(r.status, 1);
    assert.match(r.output, /状态虚报.*ACTIVE 但 evidence 为空/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check-spec-consistency：非法 status 报红', () => {
  const root = makeSandbox(baseFiles());
  try {
    run(root, 'build-spec-index.mjs');
    const p = join(root, 'docs', 'specs', 'INDEX.json');
    const idx = JSON.parse(readFileSync(p, 'utf8'));
    idx.specs[0].status = 'Active'; // 人手写常见错：大小写
    writeFileSync(p, JSON.stringify(idx, null, 2), 'utf8');

    const r = run(root, 'check-spec-consistency.mjs');
    assert.equal(r.status, 1);
    assert.match(r.output, /状态非法.*"Active"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check-spec-consistency：悬空依赖报红', () => {
  const root = makeSandbox(baseFiles());
  try {
    run(root, 'build-spec-index.mjs');
    const p = join(root, 'docs', 'specs', 'INDEX.json');
    const idx = JSON.parse(readFileSync(p, 'utf8'));
    idx.specs[0].dependencies = ['never-registered'];
    writeFileSync(p, JSON.stringify(idx, null, 2), 'utf8');

    const r = run(root, 'check-spec-consistency.mjs');
    assert.equal(r.status, 1);
    assert.match(r.output, /悬空依赖.*never-registered/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check-spec-consistency：spec 同时在 specs 与 pendingSpecs 报结构冲突', () => {
  const root = makeSandbox(baseFiles());
  try {
    run(root, 'build-spec-index.mjs');
    const p = join(root, 'docs', 'specs', 'INDEX.json');
    const idx = JSON.parse(readFileSync(p, 'utf8'));
    idx.pendingSpecs.push({ id: idx.specs[0].id, status: 'DESIGN' });
    writeFileSync(p, JSON.stringify(idx, null, 2), 'utf8');

    const r = run(root, 'check-spec-consistency.mjs');
    assert.equal(r.status, 1);
    assert.match(r.output, /结构冲突/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check-spec-consistency：兼容矩阵缺升级策略时阻塞', () => {
  const root = makeSandbox(baseFiles());
  try {
    run(root, 'build-spec-index.mjs');
    // 不放 compatibility-matrix.json → 应 WARN
    let r = run(root, 'check-spec-consistency.mjs');
    assert.equal(r.status, 0, '缺矩阵是 WARN 不阻塞（Phase 3 早期允许）');
    assert.match(r.output, /compatibility-matrix\.json 不存在/);

    // 放一个缺规则的矩阵 → 应 ERROR
    writeFileSync(
      join(root, 'docs', 'specs', 'compatibility-matrix.json'),
      JSON.stringify({ matrixVersion: '1.0', rules: [] }, null, 2),
      'utf8',
    );
    r = run(root, 'check-spec-consistency.mjs');
    assert.equal(r.status, 1, '矩阵存在但缺规则 ⇒ 每份规范都没有升级策略，必须阻塞');
    assert.match(r.output, /兼容矩阵缺/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check-spec-consistency：INDEX.json 不存在时给明确修法而非崩溃', () => {
  const root = makeSandbox(baseFiles());
  try {
    const r = run(root, 'check-spec-consistency.mjs');
    assert.equal(r.status, 1);
    assert.match(r.output, /build-spec-index\.mjs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── C. spec-hash 口径 ───────────────────────────────────────────────────────

test('spec-hash 对字节敏感：只改格式也必须检出漂移', async () => {
  const { computeSpecHash } = await import('./lib/spec-hash.mjs');
  const root = makeSandbox(baseFiles());
  try {
    const spec = { files: ['evolution-contract-v1.schema.json'] };
    const dir = join(root, 'docs', 'specs');
    const p = join(dir, 'evolution-contract-v1.schema.json');
    const h1 = computeSpecHash(spec, dir);
    // 只改缩进（语义相同，字节不同）
    writeFileSync(p, JSON.stringify(JSON.parse(SCHEMA_V1)), 'utf8');
    const h2 = computeSpecHash(spec, dir);
    assert.notEqual(h1, h2, 'hash 必须对字节敏感 —— 只改格式也是 code review 该看见的 diff');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('spec-hash：多个 schema 文件时抛错而非静默取第一个', async () => {
  const { computeSpecHash } = await import('./lib/spec-hash.mjs');
  const root = makeSandbox({ ...baseFiles(), 'second.schema.json': SCHEMA_V1 });
  try {
    const dir = join(root, 'docs', 'specs');
    assert.throws(
      () => computeSpecHash({ files: ['evolution-contract-v1.schema.json', 'second.schema.json'] }, dir),
      /多个 schema 文件，hash 口径未定义/,
      '多 schema 的 hash 口径未定义时必须抛错 —— 静默取第一个会算出无意义的 hash',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('spec-hash：无 schema 文件时返回 null（人读 .md 不算契约）', async () => {
  const { computeSpecHash } = await import('./lib/spec-hash.mjs');
  const root = makeSandbox(baseFiles());
  try {
    assert.equal(computeSpecHash({ files: ['evaluation-protocol-v1.md'] }, join(root, 'docs', 'specs')), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
