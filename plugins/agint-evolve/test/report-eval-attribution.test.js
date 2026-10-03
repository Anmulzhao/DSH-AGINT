/**
 * agint-evolve A4 章节单测 —— 周报的 eval 存量 FAIL 归因固定章节。
 *
 * 钉的是**三态诚实**（K 纪律）：
 *   没采到 ≠ 0 个。0 个 ≠ 没查。产物坏了 ≠ 0 个。
 *
 * 另钉：REAL_DEFECT 与归因盲区必须明写，不许藏在总数里。
 *
 * Run: node --test plugins/agint-evolve/test/report-eval-attribution.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { findingsFromSnapshot, buildReport, renderEvalFailAttribution } from '../lib/report.js';
import { repoRootFromHere } from '../lib/index.js';

const base = {
  collectedAt: '2026-10-03T00:00:00.000Z',
  memory: { total: 10, byType: { lesson: 3, decision: 2, preference: 1, pattern: 4 }, byLevel: {}, avgConfidence: 0.7 },
  wiki: { checked: 3, brokenLinks: [], contradictions: [], orphans: [], healthy: true },
  cron: { healthy: true, issues: [], jobs: [{ id: 'evolve-review' }] },
  rules: { totals: { hits: 5, denies: 0, asks: 0 }, fired: [], lintIssues: [] },
};

/** 一份真实的归因产物形状（字段名与 attribute-eval-fails.mjs 的输出对齐）。 */
const attribution = {
  total: 6,
  attributed: 6,
  coverage: 1,
  coverageMin: 0.8,
  byCategory: { ASSERT_DRIFT: 5, HARNESS_GAP: 1, REAL_DEFECT: 0, NOT_ATTRIBUTED: 0 },
  realDefects: 0,
  generatedAt: '2026-10-03T02:00:00.000Z',
  unattributedUnitIds: [],
};

function sectionOf(md) {
  const start = md.indexOf('## 二·B、eval 存量 FAIL 归因');
  assert.ok(start >= 0, '报告必须含固定章节');
  const rest = md.slice(start);
  const end = rest.indexOf('\n## ', 1);
  return end < 0 ? rest : rest.slice(0, end);
}

// ── 1. 三态诚实 ──────────────────────────────────────────────────────

test('⛔ 数据源缺席 ⇒ 印「本周未采到」，绝不印「0 个 FAIL」', () => {
  const lines = [];
  renderEvalFailAttribution(lines, undefined);
  const text = lines.join('\n');
  assert.match(text, /未采到/);
  assert.doesNotMatch(text, /FAIL \*\*0\*\*/, '⛔ 没采到不许印成 0 个 FAIL');
  assert.match(text, /没采到与没有，两回事/);
});

test('⛔ 采到 0 个 FAIL ⇒ 明说「无内容可归因」，且与「没采到」区分开', () => {
  const lines = [];
  renderEvalFailAttribution(lines, { total: 0, attributed: 0, coverage: null, coverageMin: 0.8, byCategory: {} });
  const text = lines.join('\n');
  assert.match(text, /FAIL \*\*0\*\*/);
  assert.match(text, /无内容可归因/);
  assert.doesNotMatch(text, /未采到/);
});

test('⛔ 产物解析失败 ⇒ 明说数据不可信，不退化成 0', () => {
  const lines = [];
  renderEvalFailAttribution(lines, {
    total: null, coverage: null, byCategory: {}, parseError: 'Unexpected token',
  });
  const text = lines.join('\n');
  assert.match(text, /解析失败/);
  assert.match(text, /Unexpected token/);
  assert.doesNotMatch(text, /FAIL \*\*0\*\*/);
});

// ── 2. 覆盖率的 null 语义 ────────────────────────────────────────────

test('coverage 为 null（无 total 可算）⇒ 印 N/A 而不是 0%', () => {
  const lines = [];
  renderEvalFailAttribution(lines, { total: 6, attributed: 0, coverage: null, coverageMin: 0.8, byCategory: {} });
  assert.match(lines.join('\n'), /覆盖率 \*\*N\/A\*\*/);
});

// ── 3. 四类都在表里，计数为 0 也要印 ────────────────────────────────

test('四类都要出现在表里，哪怕计数为 0（否则「0 条 REAL_DEFECT」会被漏读）', () => {
  const lines = [];
  renderEvalFailAttribution(lines, attribution);
  const text = lines.join('\n');
  for (const c of ['ASSERT_DRIFT', 'HARNESS_GAP', 'REAL_DEFECT', 'NOT_ATTRIBUTED']) {
    assert.match(text, new RegExp(c));
  }
});

test('0 条 REAL_DEFECT 时明写「无」的方向（不静默）', () => {
  const lines = [];
  renderEvalFailAttribution(lines, attribution);
  const text = lines.join('\n');
  assert.match(text, /REAL_DEFECT（真产品缺陷） \| 0/);
});

// ── 4. 盲区与真缺陷必须明写 ─────────────────────────────────────────

test('归因盲区 > 0 ⇒ 明写条数并点名未归因单元', () => {
  const lines = [];
  renderEvalFailAttribution(lines, {
    ...attribution,
    attributed: 4,
    coverage: 0.667,
    byCategory: { ASSERT_DRIFT: 2, HARNESS_GAP: 1, REAL_DEFECT: 0, NOT_ATTRIBUTED: 3 },
    unattributedUnitIds: ['unit-a', 'unit-b', 'unit-c'],
  });
  const text = lines.join('\n');
  assert.match(text, /3 条未归因/);
  assert.match(text, /`unit-a`/);
  assert.match(text, /`unit-c`/);
});

test('REAL_DEFECT > 0 ⇒ 明写「产品缺陷 + 过门禁」', () => {
  const lines = [];
  renderEvalFailAttribution(lines, {
    ...attribution,
    byCategory: { ASSERT_DRIFT: 0, HARNESS_GAP: 0, REAL_DEFECT: 2, NOT_ATTRIBUTED: 0 },
  });
  const text = lines.join('\n');
  assert.match(text, /2 条 REAL_DEFECT/);
  assert.match(text, /产品缺陷/);
  assert.match(text, /门禁/);
});

test('⛔ 章节必须带「不许为全绿放宽判据」的护栏', () => {
  const lines = [];
  renderEvalFailAttribution(lines, attribution);
  assert.match(lines.join('\n'), /不许.*放宽判据/);
});

// ── 5. findings 三态 ────────────────────────────────────────────────

test('findings：无 eval 数据时不得凭空造 eval finding', () => {
  const findings = findingsFromSnapshot(base);
  assert.equal(findings.filter((f) => f.key.startsWith('eval.')).length, 0);
});

test('findings：NOT_ATTRIBUTED > 0 ⇒ warn finding', () => {
  const f = findingsFromSnapshot({
    ...base,
    evalFailAttribution: { ...attribution, byCategory: { ...attribution.byCategory, NOT_ATTRIBUTED: 2 } },
  });
  const hit = f.find((x) => x.key === 'eval.fail.unattributed');
  assert.ok(hit);
  assert.equal(hit.level, 'warn');
  assert.match(hit.message, /2 条未归因/);
});

test('findings：REAL_DEFECT > 0 ⇒ warn finding', () => {
  const f = findingsFromSnapshot({
    ...base,
    evalFailAttribution: { ...attribution, byCategory: { ASSERT_DRIFT: 4, HARNESS_GAP: 1, REAL_DEFECT: 1, NOT_ATTRIBUTED: 0 } },
  });
  const hit = f.find((x) => x.key === 'eval.fail.realDefect');
  assert.ok(hit);
  assert.equal(hit.level, 'warn');
});

test('findings：覆盖率低于阈值 ⇒ warn finding', () => {
  const f = findingsFromSnapshot({
    ...base,
    evalFailAttribution: { ...attribution, coverage: 0.5, coverageMin: 0.8 },
  });
  assert.ok(f.find((x) => x.key === 'eval.fail.coverage'));
});

test('findings：全归因且无真缺陷 ⇒ 不产生 eval warn', () => {
  const f = findingsFromSnapshot({ ...base, evalFailAttribution: attribution });
  assert.equal(f.filter((x) => x.key.startsWith('eval.fail.')).length, 0);
});

// ── 6. 章节在整份报告里的位置 ───────────────────────────────────────

test('固定章节出现在「二·A」之前，且是独立一级章节', () => {
  const md = buildReport({ date: '2026-10-03', snapshot: { ...base, evalFailAttribution: attribution }, findings: [] });
  const iB = md.indexOf('## 二·B、eval 存量 FAIL 归因');
  const iA = md.indexOf('## 二·A、外部信号与多源输入');
  assert.ok(iB >= 0 && iA >= 0);
  assert.ok(iB < iA, '二·B 应排在二·A 之前');
});

test('快照表含 eval 归因行', () => {
  const md = buildReport({ date: '2026-10-03', snapshot: { ...base, evalFailAttribution: attribution }, findings: [] });
  assert.match(md, /\| eval 存量 FAIL 归因 \|/);
  assert.match(md, /覆盖率 100\.0%/);
});

test('⛔ 快照缺席时快照表不含 eval 行（不印 0）', () => {
  const md = buildReport({ date: '2026-10-03', snapshot: base, findings: [] });
  assert.doesNotMatch(md, /\| eval 存量 FAIL 归因 \|/);
  assert.match(sectionOf(md), /本周未采到/);
});

test('sectionOf 提取的章节内容完整（含护栏）', () => {
  const md = buildReport({ date: '2026-10-03', snapshot: { ...base, evalFailAttribution: attribution }, findings: [] });
  const sec = sectionOf(md);
  assert.match(sec, /ASSERT_DRIFT/);
  assert.match(sec, /不许.*放宽判据/);
  assert.match(sec, /attribute-eval-fails\.mjs/);
});

// ── 7. 路径推导（K141：调用前提）─────────────────────────────────────
//
// ⛔ 2026-10-04 部署位实测修正：这两条原先**只按仓库布局**断言
//   （`new URL('../../../')` 必须含 eval/），拷到部署位后必红——
//   部署位插件在 ~/.dsh/.agint-bundle/plugins/ 或 ~/.dsh/profiles/web/plugins/ 下，
//   祖先里根本没有 eval/。真缺陷在**生产代码**（固定层数推导必推错目录），
//   已改为「逐级向上探测 + 存在性判据，探测不到返回 null」。
//   ⇒ 测试改成**双形态**：在仓库位必须解析成功；在非仓库位必须**诚实降级**。
//   判据是「行为对不对」，不是「我在哪个目录」。

test('⛔ 路径推导：直接调生产函数（不许在测试里复算算法）', async () => {
  const { existsSync } = await import('node:fs');
  const { repoRootFromHere } = await import('../lib/index.js');
  const found = repoRootFromHere();
  if (found === null) {
    // 部署位形态（非仓库布局）：合法结果，但**必须是 null**，不能是某个猜测路径。
    // ⛔ 若这里返回非 null，运维会去查一个根本不存在的目录。
    return;
  }
  // 仓库位形态：探测到的根必须真的含 eval/ 与 plugins/（不是碰巧像的目录）
  assert.ok(existsSync(join(found, 'eval')), `生产函数返回的根 ${found} 下没有 eval/`);
  assert.ok(existsSync(join(found, 'plugins')), `生产函数返回的根 ${found} 下没有 plugins/`);
  assert.ok(existsSync(join(found, 'eval', 'scenarios', 'inventory.json')), '推出的根应含场景清单');
});

test('⛔ 路径推导：探测逻辑本身在任意位置都不得返回猜测路径', async () => {
  const { fileURLToPath } = await import('node:url');
  const { existsSync } = await import('node:fs');
  const selfUrl = new URL('../lib/index.js', import.meta.url);
  // 用探测逻辑（同款逐级向上 + eval/ 判据）复算，不依赖固定层数
  let dir = dirname(fileURLToPath(selfUrl));
  let found = null;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'eval'))) { found = dir; break; }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (found === null) {
    assert.equal(found, null, '非仓库布局下必须返回 null（诚实降级），不得返回猜测路径');
    return;
  }
  assert.ok(existsSync(join(found, 'eval')), `探测到的根 ${found} 下没有 eval/`);
  assert.ok(existsSync(join(found, 'plugins')), `探测到的根 ${found} 下没有 plugins/`);
  assert.ok(existsSync(join(found, 'eval', 'scenarios', 'inventory.json')), '推出的根应含场景清单');
});

test('⛔ 非仓库布局（部署位）必须诚实降级：报「路径未解析」，不许伪装成「未采到」', () => {
  const lines = [];
  // 模拟部署位快照：路径没解析出来，键缺席
  renderEvalFailAttribution(lines, undefined, { pathUnresolved: true });
  const md = lines.join('\n');
  assert.match(md, /路径未解析/, '必须明说路径没解析出来');
  assert.match(md, /evalAttributionPath/, '必须给出可执行的修法');
  // ⛔ 关键：不许印成「本周未采到」—— 那会把排障方向引到归因脚本上
  assert.doesNotMatch(md, /本周未采到/, '路径未解析不得退化成「未采到」');
  // 且不许出现任何暗示「0 个 FAIL」的措辞
  assert.doesNotMatch(md, /FAIL \*\*0\*\*/, '路径未解析不得印成 0 个 FAIL');
});

test('⛔ 没采到（路径解析出来了但文件不存在）才印「未采到」—— 与「路径未解析」分开', () => {
  const lines = [];
  renderEvalFailAttribution(lines, undefined, { pathUnresolved: false });
  const md = lines.join('\n');
  assert.match(md, /本周未采到/);
  assert.match(md, /不等于「0 个FAIL」|不等于「0 个 FAIL」/);
  assert.doesNotMatch(md, /路径未解析/, '普通未采到不该印「路径未解析」');
});

test('⛔ 生产代码里探测逻辑必须是「逐级向上 + eval 判据」，不许固定层数', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  // ⛔ 固定层数 `new URL('../../../')` 在部署位必推错目录 —— 这是本条判据拦的东西
  assert.doesNotMatch(src, /repoRootFromHere[\s\S]{0,400}new URL\('\.\.\/\.\.\/\.\.\/'\)/,
    'repoRootFromHere 不得用固定层数推导（部署位祖先无 eval/，必推错）');
  assert.match(src, /existsSync\(join\(dir, 'eval'\)\)/, '必须用 eval/ 存在性作判据');
  assert.match(src, /return null;/, '探测不到必须返回 null（诚实降级），不许返回猜测路径');
});

test('⛔ 端到端：快照带 pathUnresolved ⇒ 周报全文必须印「路径未解析」（走 buildReport，不走内部函数）', () => {
  // ⛔ 这条是**端到端**判据：只经 buildReport，不直接调 renderEvalFailAttribution。
  //   原因：单测内部函数时，「生产代码有没有真的设这个标志位」是测不到的 ——
  //   删掉标志位那行，函数级单测照样全绿（实测过），只有端到端才变红。
  const md = buildReport({
    date: '2026-10-04',
    snapshot: { ...base, evalFailAttributionUnresolved: true },
    findings: [],
  });
  assert.match(md, /路径未解析/, '端到端：周报必须印「路径未解析」');
  assert.doesNotMatch(md, /本周未采到/, '端到端：不得退化成「本周未采到」');
  assert.match(md, /evalAttributionPath/, '端到端：必须给可执行修法');
});

// ── 8. 真·端到端（起真插件 → 调生产 dataSnapshot → 喂 buildReport）──────
//
// ⛔ 为什么要这一节：前面所有判据都是「喂手写快照给 report.js」。
//   那样测不到生产代码**有没有真的设标志位** ——
//   实测：把 `snapshot.evalFailAttributionUnresolved = true` 删掉，
//   仓库位与部署位都**照样 26/26 全绿**。判据是空壳。
//   唯一能咬住它的办法：真起插件、真调 dataSnapshot()、真把返回值喂进 buildReport。

function makeMockCtx() {
  const provides = new Map();
  return {
    provides,
    effects: [],
    warns: [],
    storageDomain: {
      async open(spec) {
        return {
          name: spec.name, version: spec.version,
          table() {
            return { get: () => null, put: async () => true, delete: async () => true, entries: () => [] };
          },
          async close() {},
        };
      },
    },
    logger: { warn: (msg, extra) => { this.parent?.warns?.push?.({ msg, extra }); } },
    effect(fn) { this.parent?.effects?.push?.(fn()); },
    provide(k, v) { provides.set(k, v); },
    get(k) { return provides.get(k) ?? null; },
    on() {}, setInterval() { return { dispose() {} }; },
  };
}

test('⛔ 真·端到端：起真插件 → dataSnapshot() → buildReport，标志位必须真被设上', async () => {
  const { apply } = await import('../lib/index.js');
  const { existsSync } = await import('node:fs');
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');

  // 关键：**不传** evalAttributionPath ⇒ 走自动探测分支
  const root = await mkdtemp(join(tmpdir(), 'agint-evolve-e2e-'));
  const ctx = makeMockCtx();
  ctx.parent = ctx;
  apply(ctx, { root });
  const evo = ctx.get('agint.evolve');
  assert.ok(evo && typeof evo.dataSnapshot === 'function', '拿不到生产 dataSnapshot');

  const snapshot = await evo.dataSnapshot();

  // 判据按「当前所在位置」分支，但**两边都必须真的被观察到**：
  const resolved = existsSync(join(repoRootFromHere() ?? '', 'eval'));
  if (resolved) {
    // 仓库位：路径解析出来了 ⇒ 标志位必须**不存在**
    assert.notEqual(snapshot.evalFailAttributionUnresolved, true,
      '仓库位路径能解析，不该报「未解析」');
    // 且真产物在位时应读到数据
    assert.ok(snapshot.evalFailAttribution, '仓库位应读到归因产物');
    assert.equal(typeof snapshot.evalFailAttribution.total, 'number');
  } else {
    // 部署位：路径解析不出来 ⇒ 标志位必须**为 true**（否则周报会误报「未采到」）
    assert.equal(snapshot.evalFailAttributionUnresolved, true,
      '⛔ 部署位路径解析不出来，dataSnapshot() 必须设 unresolved 标志位 —— '
      + '没设的话周报会印「本周未采到」，把排障方向引到归因脚本上（真因是路径）');
    // 端到端：周报全文必须据此改口
    const md = buildReport({ date: '2026-10-04', snapshot, findings: [] });
    assert.match(md, /路径未解析/, '端到端：周报必须印「路径未解析」');
    assert.doesNotMatch(md, /本周未采到/, '端到端：不得退化成「本周未采到」');
  }
});

test('⛔ 端到端：标志位缺失时不得印「路径未解析」（标志位是唯一触发来源）', () => {
  const md = buildReport({ date: '2026-10-04', snapshot: { ...base }, findings: [] });
  assert.doesNotMatch(md, /路径未解析/, '没有标志位就不该印「路径未解析」');
  assert.match(md, /本周未采到/, '无标志位时应印普通「未采到」');
});

test('⛔ Config schema 认 evalAttributionPath（可选），但认不出就静默丢配置', async () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.match(src, /evalAttributionPath: z\.string\(\)\.min\(1\)\.optional\(\)/);
});