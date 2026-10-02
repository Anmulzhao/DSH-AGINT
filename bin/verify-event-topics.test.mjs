// bin/verify-event-topics.test.mjs — 事件 topic 事实清单门禁的测试
//
// 这个门禁的失效模式有两种，都很安静，所以两条都必须有断言：
//   1. **漏掉动态发布的 topic** —— 只扫代码字面量的话，模板串/变量构造出来的
//      主题（ov.* / oracle.* / policy.*）永远进不了清单，订阅方静默空转。
//      ⇒ 断言清单里必须包含只在生产侧出现的 topic。
//   2. **把测试占位 topic 扫进清单** —— 实测 62 个候选里有一半是
//      evt.a / x / whatever 这种测试垃圾。
//      ⇒ 断言这些占位**不在**清单里。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'verify-event-topics.mjs');
const REPO_ROOT = join(__dirname, '..');
const REGISTRY_PATH = join(REPO_ROOT, 'docs', 'event-topics.json');

const { scanCodeTopics } = await import(pathToFileURL(SCRIPT).href);
const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
const known = Object.keys(registry.topics || {});

// ── 提取逻辑 ────────────────────────────────────────────────────────────────
test('三种 topic 写法都要能提取到', () => {
  const dir = mkdtempSync(join(tmpdir(), 'topic-test-'));
  const f = join(dir, 'x.js');
  writeFileSync(
    f,
    `await publish('a.published', {});\n` +
      `subscribe('b.subscribed', handler);\n` +
      `bus.publish({ topic: 'c.viaProp', payload: 1 });\n`,
    'utf8',
  );
  try {
    const found = scanCodeTopics([f]);
    for (const t of ['a.published', 'b.subscribed', 'c.viaProp']) {
      assert.ok(found.has(t), `漏提取：${t}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('模板串构造的 topic 提取不到 —— 这正是必须叠加生产证据的原因', () => {
  const dir = mkdtempSync(join(tmpdir(), 'topic-test-'));
  const f = join(dir, 'x.js');
  writeFileSync(f, "publish(`ov.${kind}.flushed`, {});\n", 'utf8');
  try {
    const found = scanCodeTopics([f]);
    assert.equal(found.size, 0, '模板串不该被静态扫成字面量');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 失效模式 1：动态发布的 topic 不能漏 ─────────────────────────────────────
test('★ 清单必须包含只在生产侧出现的 topic（动态构造的发布方）', () => {
  // 这几个实测只在生产存储里出现，代码里扫不到字面量
  for (const t of ['ov.session.flushed', 'policy.deployed', 'metrics.snapshot']) {
    assert.ok(known.includes(t), `清单漏了动态发布的 topic：${t}`);
  }
});

test('清单条目带生产条数证据（证明不是只靠静态扫描拍脑袋）', () => {
  const e = registry.topics['ov.session.flushed'];
  assert.ok(e, 'ov.session.flushed 应在清单中');
  assert.ok(
    e.evidence.productionCount > 0,
    `生产条数应为正：${JSON.stringify(e)}`,
  );
});

test('清单规模合理（代码 29 ∪ 生产 30 → 并集量级应在 40 上下）', () => {
  assert.ok(known.length >= 40, `清单只有 ${known.length} 条，疑似某条证据来源失效`);
});

// ── 失效模式 2：测试占位不能混进来 ──────────────────────────────────────────
test('★ 清单不得包含测试占位 topic', () => {
  const junk = ['evt.a', 'evt.b', 'evt.c', 'x', 'xxx', 'whatever', 'invalid', 'dl.test', 'iso.test', 'probe.topic'];
  const hit = junk.filter((t) => known.includes(t));
  assert.deepEqual(hit, [], `测试占位混进了事实清单：${hit.join(', ')}`);
});

// ── 清单治理 ────────────────────────────────────────────────────────────────
test('清单声明了来源与生成方式（可追溯）', () => {
  assert.equal(registry.version, '1.0');
  assert.match(registry.generatedBy, /--update/);
  assert.ok(registry.source && registry.source.code && registry.source.production);
  assert.ok(registry.note && registry.note.length > 20);
});

// ── 端到端 ──────────────────────────────────────────────────────────────────
test('真实仓库校验通过（退出 0）', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `不该红，stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  assert.ok((r.stdout || '').includes('topic'), 'stdout 为空 —— main() 可能没执行');
});

test('--json 输出结构完整', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--json'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const j = JSON.parse(r.stdout);
  assert.ok(j.scannedFiles > 0);
  assert.ok(Array.isArray(j.unregistered));
  assert.ok(Array.isArray(j.stale));
  assert.ok(Array.isArray(j.prodOnly));
  assert.equal(j.failed, false);
});
