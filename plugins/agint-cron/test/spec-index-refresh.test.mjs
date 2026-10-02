// spec-index-refresh job + 只读审计模块测试（Phase-3 轨道 C，2026-10-03）。
//
// 纪律：
//   · 判据不 mock —— 用**真的** bin/build-spec-index.mjs 派生一份临时仓库副本
//     （K115：mock 造出的依赖方法叫幽灵接口，测绿了线上照样炸）。
//   · 排期不靠注释 —— 断言精确表达式 + 跑 schedule-layout 全局门禁。
//   · 部署位没有 docs/ 是一等场景，soft-skip 必须写清缺哪一项（K134）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync,
  copyFileSync, statSync, rmSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultJobs } from '../lib/jobs.js';
import { auditSpecIndex, INDEX_REL, GENERATOR_REL } from '../lib/spec-index-audit.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const job = defaultJobs.find((j) => j.id === 'spec-index-refresh');

/**
 * fixture 用的 AGINT 仓库根 —— **可被环境变量覆盖**。
 *
 * ⭐ 为什么必须可注入（2026-10-03 部署位验收实测）：
 *   上面那个「向上三级」在**仓库**里指向主仓；但同一份测试文件被同步到
 *   部署位 `~/.dsh/profiles/web/plugins/agint-cron/test/` 后，三级变成
 *   `~/.dsh/profiles/web` —— 那里**既不是仓库也不是部署位**，没有 bin/ 也没有 docs/。
 *   症状是一堆 ENOENT，看着像「部署位代码坏了」，实际是**调用前提不满足**。
 *   判据：报错路径若既不是仓库也不是部署位，就是这个问题，别去改产品代码。
 *
 * 用法（部署位跑）：
 *   SPEC_INDEX_REPO_ROOT=/path/to/DSH-AGINT node --test .../spec-index-refresh.test.mjs
 */
const FIXTURE_ROOT = process.env.SPEC_INDEX_REPO_ROOT
  ? resolve(process.env.SPEC_INDEX_REPO_ROOT)
  : REPO_ROOT;

/**
 * 逐文件递归拷贝。
 *
 * ⚠️⛔ 绝不用 `cpSync(src, dst, { recursive: true })` —— Windows 上它崩原生层
 *   0xC0000409（3221226505），零输出、exit 127，症状与「测试全红」无法区分
 *   （Phase-3 §0bis.1 缺陷 8）。本仓所有门禁沙箱都必须逐文件拷。
 */
function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const d = join(dst, name);
    if (statSync(s).isDirectory()) copyTree(s, d);
    else copyFileSync(s, d);
  }
}

/** 造一份最小可审计仓库副本：只拷 bin/ 与 docs/specs/ + 两个被读取的根文件。 */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'spec-audit-'));
  mkdirSync(join(root, 'bin'), { recursive: true });
  copyFileSync(join(FIXTURE_ROOT, GENERATOR_REL), join(root, GENERATOR_REL));
  copyTree(join(FIXTURE_ROOT, 'bin', 'lib'), join(root, 'bin', 'lib'));
  copyTree(join(FIXTURE_ROOT, 'docs', 'specs'), join(root, 'docs', 'specs'));
  copyFileSync(join(FIXTURE_ROOT, 'VERSION'), join(root, 'VERSION'));
  copyFileSync(join(FIXTURE_ROOT, 'package.json'), join(root, 'package.json'));
  return root;
}

const fixtures = [];
function fixture() {
  const r = makeFixture();
  fixtures.push(r);
  return r;
}
process.on('exit', () => {
  for (const f of fixtures) {
    try { rmSync(f, { recursive: true, force: true }); } catch { /* 清理失败不影响断言结论 */ }
  }
});

/** 改磁盘上的规范文件内容（不重生成索引 ⇒ 人为制造漂移）。 */
function touchSpec(root, name, extra = '\n漂移注入\n') {
  const p = join(root, 'docs', 'specs', name);
  writeFileSync(p, readFileSync(p, 'utf8') + extra, 'utf8');
}

// ---------------------------------------------------------------- 前置守卫

test('⛔ 前置守卫：fixture 根必须真的是 AGINT 仓库（有 bin/ 与 docs/specs/）', () => {
  // ⛔ 缺这道守卫时，「fixture 根指错」会表现为一堆 ENOENT，看起来像代码坏了。
  //   实际上只是源目录不对（部署位跑仓库测试的经典陷阱，见 FIXTURE_ROOT 注释）。
  //   先把前提钉死，后面的失败才是真信号。
  for (const rel of [GENERATOR_REL, INDEX_REL, 'VERSION', 'package.json']) {
    assert.ok(
      existsSync(join(FIXTURE_ROOT, rel)),
      `fixture 根不是 AGINT 仓库：${FIXTURE_ROOT} 下缺 ${rel}` +
        `（部署位跑本测试须设 SPEC_INDEX_REPO_ROOT）`,
    );
  }
});

// ---------------------------------------------------------------- job 注册

test('job 已注册，排期为每月 1 日 10:30', () => {
  assert.ok(job, 'defaultJobs 中存在 spec-index-refresh');
  assert.equal(job.schedule, '30 10 1 * *');
  assert.match(job.description, /只读/, '描述必须写明只读（形态约束，防后人改成写盘）');
});

test('⛔ 排期不是设计稿建议的 09:30（那里已被 4 个周任务占满，dom=1 必撞）', () => {
  // 09:30 已被 wiki-lint / baseline-regression-suite / curriculum-weekly /
  // skill-graph-weekly 占满。dom=1 每月落任意星期几 ⇒ 用 09:30 每月必撞一次。
  const at0930 = defaultJobs
    .filter((j) => j.id !== 'diagnosis-watchdog' && j.id !== 'spec-index-refresh')
    .filter((j) => j.schedule.endsWith('9:30'.split(':')[1].padStart(2, '0') + ' * * ' + j.schedule.trim().split(/\s+/)[4]) || j.schedule.trim().split(/\s+/).slice(0, 2).join(' ') === '30 9');
  assert.ok(at0930.length >= 4, `09:30 应已被 ≥4 个周任务占用，实测 ${at0930.length}`);
  assert.notEqual(job.schedule, '30 9 1 * *');
});

// ---------------------------------------------------------------- 三种状态

test('一致 → status:ok，带上规范份数与未登记清单', async () => {
  const root = fixture();
  const r = await auditSpecIndex({ repoRoot: root });
  assert.equal(r.status, 'ok', `期望一致，实际 ${JSON.stringify(r)}`);
  assert.ok(r.specCount > 0, '必须有已登记规范数');
  assert.equal(r.untracked.length, 0, `不应有未登记文件：${r.untracked.join(', ')}`);
});

test('改了规范文件但索引没重生成 → status:drift，errors 非空', async () => {
  const root = fixture();
  const before = await auditSpecIndex({ repoRoot: root });
  assert.equal(before.status, 'ok', '前置：fixture 必须是干净的');

  // 改一个被索引登记的 schema 文件 ⇒ schemaHash 漂移
  touchSpec(root, 'evolution-contract-v1.schema.json');
  const after = await auditSpecIndex({ repoRoot: root });
  assert.equal(after.status, 'drift');
  assert.ok(after.errors.length > 0, 'drift 必须带 errors');
  assert.ok(
    after.errors.some((e) => e.includes('schemaHash')),
    `errors 应指出 schemaHash 漂移，实际：${after.errors.join(' | ')}`,
  );
});

test('新增孤儿规范文件 → status:drift（防「没登记=不存在」）', async () => {
  const root = fixture();
  writeFileSync(join(root, 'docs', 'specs', 'orphan-spec.md'), '# 孤儿\n', 'utf8');
  const r = await auditSpecIndex({ repoRoot: root });
  assert.equal(r.status, 'drift');
  assert.ok(
    r.errors.some((e) => e.includes('孤儿')),
    `应报孤儿规范，实际：${r.errors.join(' | ')}`,
  );
});

// ---------------------------------------------------------------- skip 三态

test('未提供 repoRoot → skipped + REPO_ROOT_UNKNOWN（不猜目录）', async () => {
  const r = await auditSpecIndex({ repoRoot: null });
  assert.equal(r.status, 'skipped');
  assert.match(r.reason, /REPO_ROOT_UNKNOWN/);
});

test('部署位（无 docs/ 无 bin/）→ skipped 且**不报通过**', async () => {
  // 真实 bundle 部署位只有 cordis.patch.yml / package.json / plugins/
  const root = mkdtempSync(join(tmpdir(), 'spec-deploy-'));
  fixtures.push(root);
  const r = await auditSpecIndex({ repoRoot: root });
  assert.equal(r.status, 'skipped', `部署位必须 skip，实际 ${JSON.stringify(r)}`);
  assert.ok(r.reason, 'skip 必须写清缺哪一项');
  assert.notEqual(r.status, 'ok', '⛔ 判据不可用时绝不能报 ok（那是假防线）');
});

test('生成器缺失 → skipped + GENERATOR_MISSING', async () => {
  const root = fixture();
  rmSync(join(root, GENERATOR_REL));
  const r = await auditSpecIndex({ repoRoot: root });
  assert.equal(r.status, 'skipped');
  assert.match(r.reason, /GENERATOR_MISSING/);
});

test('判据不可用 ≠ 审计通过：三种 skip 都不许带 specCount', async () => {
  for (const repoRoot of [null, makeFixture()]) {
    const r = await auditSpecIndex({ repoRoot });
    if (r.status === 'skipped') {
      assert.equal(r.specCount, undefined, `skip 不该带 specCount：${JSON.stringify(r)}`);
    }
    fixtures.push(repoRoot);
  }
});

// ---------------------------------------------------------------- job 编排

test('job：一致 → 返回可记账的摘要', async () => {
  const root = fixture();
  const r = await job.action({ 'agint.repoRoot': root });
  assert.equal(r.status, 'ok');
  assert.ok(r.specCount > 0);
});

test('job：漂移 → 抛错（红色是对的，那是要人修的）', async () => {
  const root = fixture();
  touchSpec(root, 'evolution-contract-v1.schema.json');
  await assert.rejects(
    () => job.action({ 'agint.repoRoot': root }),
    (e) => {
      assert.match(e.message, /协议索引漂移/);
      assert.match(e.message, /build-spec-index/, '消息里必须给出修法');
      return true;
    },
  );
});

test('job：判据不可用 → soft-skip 且 reason 可读（不抛错制造永久噪声）', async () => {
  const r = await job.action({});
  assert.equal(r.skipped, true);
  assert.match(r.reason, /REPO_ROOT_UNKNOWN/);
});

test('⛔ 只读保证：审计不得改磁盘（含 schemaHash 计算）', async () => {
  const root = fixture();
  const indexPath = join(root, INDEX_REL);
  const before = readFileSync(indexPath, 'utf8');
  await auditSpecIndex({ repoRoot: root });
  assert.equal(readFileSync(indexPath, 'utf8'), before, '审计改写了 INDEX.json');
});

// ---------------------------------------------------------------- 排期门禁
//
// ⛔ 以下三条只在**仓库**里有意义：它们要读仓库的 bin/ 与 plugins/ 布局。
//   部署位没有那些目录 ⇒ 报 ENOENT 只会掩盖真实结论，直接跳过并说明原因。
const inRepo = FIXTURE_ROOT === REPO_ROOT;

test('全局排期门禁仍绿（新增 job 不撞车）', async (t) => {
  if (!inRepo) {
    t.skip(`不在仓库布局内（FIXTURE_ROOT=${FIXTURE_ROOT}），排期门禁属仓库侧检查`);
    return;
  }
  // 直接跑真门禁文件，而不是复制它的断言 —— 复制就会分叉。
  const { execFileSync } = await import('node:child_process');
  const p = join(REPO_ROOT, 'plugins', 'agint-cron', 'test', 'schedule-layout.test.mjs');
  try {
    execFileSync(process.execPath, ['--test', p], { stdio: 'pipe' });
  } catch (e) {
    assert.fail(`schedule-layout 门禁变红：\n${e.stdout?.toString() ?? e.message}`);
  }
});

test('⛔ 回归钉：漂移判据不得退回 --check 分支私有', async (t) => {
  if (!inRepo) {
    t.skip(`不在仓库布局内（FIXTURE_ROOT=${FIXTURE_ROOT}），生成器源码不在部署位`);
    return;
  }
  // 这条钉的是本轮抓到的真缺陷：validateIndex 名字像「全部校验」，
  // 实际不含 schemaHash 漂移检查（那段只写在 main() 里）。
  // 后人若图省事把漂移逻辑搬回 --check 分支，导出面会缩回去 ⇒ 这条测试红。
  const gen = await import(pathToFileURL(join(REPO_ROOT, GENERATOR_REL)).href);
  for (const fn of ['validateIndex', 'validateSchemaHashDrift', 'computeIndex', 'NON_SPEC_FILES']) {
    assert.ok(gen[fn] !== undefined, `生成器必须导出 ${fn}（cron 巡检与 --check 共用判据）`);
  }
  // --check 分支不得再自带一份漂移比较（会与导出函数分叉）
  const src = readFileSync(join(REPO_ROOT, GENERATOR_REL), 'utf8');
  const driftMentions = (src.match(/schemaHash 与磁盘文件不一致/g) ?? []).length;
  assert.equal(driftMentions, 1, `漂移报错文案应只出现 1 处（共用），实测 ${driftMentions} 处`);
});
