// test/orphan-sweep.test.mjs — skills_root 孤儿 tmp/failed 目录清理（2026-09-21 新增）
//
// 背景：publishToSkillsRoot 的 catch 分支只把 `.<name>.tmp-<ts>` **改名**成
// `.<name>.tmp-<ts>.failed-<ts2>`，**从不删除**；而宿主 dsh-skill-filesystem 的
// isPotentialSkillPath（lib/index.js:552-557）**只跳过 `.system`**，
// `<root>/<seg0>/SKILL.md` 一律视为技能 → 这些孤儿会被当成技能发现、污染技能目录。
// 见 docs/known-limitations/skills-root-rename-eperm.md §4。
//
// 本测试验证：识别判据、TTL 语义、不误删、以及真实文件系统上的清理行为。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, readdir, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOD_PATH = pathToFileURL(resolve(__dirname, '../lib/release-manager.js')).href;
const { sweepSkillOrphans, isOrphanTmpDir } = await import(MOD_PATH);

const TS = 1789625089555;   // 13 位时间戳

// ── 判据（纯函数，零 IO）────────────────────────────────────────────────

test('isOrphanTmpDir：识别本插件产生的 .tmp-/.failed- 目录', () => {
  assert.equal(isOrphanTmpDir(`.foo-skill.tmp-${TS}`), true);
  assert.equal(isOrphanTmpDir(`.foo-skill.tmp-${TS}.failed-${TS + 5}`), true);
  assert.equal(isOrphanTmpDir('.pwsh-glob.tmp-1789625089555'), true);
});

test('isOrphanTmpDir：不误判真实技能目录（核心安全回归）', () => {
  // 真实技能目录：不带点、不带 .tmp-
  assert.equal(isOrphanTmpDir('causal-reasoning'), false);
  assert.equal(isOrphanTmpDir('glob-glob-glob-glob'), false);
  // ⚠️ 以点开头但不是 tmp 的目录（用户可能真有这种技能）→ 必须不碰
  assert.equal(isOrphanTmpDir('.hidden-skill'), false);
  assert.equal(isOrphanTmpDir('.system'), false);
  assert.equal(isOrphanTmpDir('.config'), false);
  // 时间戳位数不够（<10 位）→ 不认，宁可漏删
  assert.equal(isOrphanTmpDir('.foo.tmp-12345'), false);
  // 缺 .tmp- 段
  assert.equal(isOrphanTmpDir('.foo.failed-1789625089600'), false);
  // 非字符串
  assert.equal(isOrphanTmpDir(undefined), false);
  assert.equal(isOrphanTmpDir(null), false);
  assert.equal(isOrphanTmpDir(42), false);
});

// ── TTL 语义（真实文件系统）──────────────────────────────────────────────

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'orphan-sweep-'));
  await mkdir(root, { recursive: true });
  return root;
}

/** 造一个孤儿目录（带 SKILL.md，模拟真实形态），并把 mtime 设为 ageMs 之前 */
async function makeOrphan(root, name, ageMs) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), 'stub\n', 'utf8');
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    await utimes(dir, t, t);
  }
  return dir;
}

test('sweepSkillOrphans：超 TTL 的孤儿被清理，新鲜的保留', async () => {
  const root = await makeRoot();
  try {
    await makeOrphan(root, `.old-skill.tmp-${TS}`, 2 * 3600_000);          // 2h 前 → 该删
    await makeOrphan(root, `.old-skill.tmp-${TS}.failed-${TS + 1}`, 2 * 3600_000); // 该删
    await makeOrphan(root, `.fresh-skill.tmp-${TS}`, 60_000);              // 1min 前 → 保留

    const res = await sweepSkillOrphans({ skillsRoot: root, ttlMs: 3600_000 });
    assert.equal(res.removed.length, 2, '应清掉 2 个超 TTL 的孤儿');
    assert.deepEqual(res.skipped, [`.fresh-skill.tmp-${TS}`], '新鲜孤儿应保留');

    const left = await readdir(root);
    assert.ok(left.includes(`.fresh-skill.tmp-${TS}`), '新鲜孤儿必须还在');
    assert.ok(!left.includes(`.old-skill.tmp-${TS}`), '老孤儿应已删除');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sweepSkillOrphans：绝不误删真实技能目录（红线）', async () => {
  const root = await makeRoot();
  try {
    // 三个"看起来可能被误伤"的真实技能，全部设成很旧
    for (const n of ['causal-reasoning', '.hidden-skill', 'glob-glob-glob-glob']) {
      const d = join(root, n);
      await mkdir(d, { recursive: true });
      await writeFile(join(d, 'SKILL.md'), 'real\n', 'utf8');
      const t = new Date(Date.now() - 30 * 24 * 3600_000);   // 30 天前
      await utimes(d, t, t);
    }
    const res = await sweepSkillOrphans({ skillsRoot: root, ttlMs: 3600_000 });
    assert.equal(res.removed.length, 0, '真实技能一个都不许删');
    const left = await readdir(root);
    assert.equal(left.length, 3, '三个真实技能应原封不动');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sweepSkillOrphans：dryRun 只报不删', async () => {
  const root = await makeRoot();
  try {
    await makeOrphan(root, `.x-skill.tmp-${TS}`, 2 * 3600_000);
    const res = await sweepSkillOrphans({ skillsRoot: root, ttlMs: 3600_000, dryRun: true });
    assert.equal(res.removed.length, 1, 'dryRun 应报告 1 个可删');
    const left = await readdir(root);
    assert.ok(left.includes(`.x-skill.tmp-${TS}`), 'dryRun 不许真的删');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sweepSkillOrphans：目录不存在 → 静默返回空（不抛）', async () => {
  const res = await sweepSkillOrphans({ skillsRoot: join(tmpdir(), 'definitely-not-exist-' + Date.now()) });
  assert.deepEqual(res, { removed: [], scanned: 0, skipped: [] });
});

test('sweepSkillOrphans：文件（非目录）同名不删', async () => {
  const root = await makeRoot();
  try {
    // 极端情况：同名但不是目录
    await writeFile(join(root, `.x-skill.tmp-${TS}`), 'i am a file\n', 'utf8');
    const res = await sweepSkillOrphans({ skillsRoot: root, ttlMs: 0 });
    assert.equal(res.removed.length, 0, '文件不是目录，不该被 rm -r');
    const left = await readdir(root);
    assert.ok(left.includes(`.x-skill.tmp-${TS}`), '该文件应还在');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
