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
import { join } from 'node:path';

import { findingsFromSnapshot, buildReport, renderEvalFailAttribution } from '../lib/report.js';

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

test('⛔ 从 import.meta.url 推的仓库根层数必须对（写错 ⇒ 永远「未采到」）', async () => {
  const { fileURLToPath } = await import('node:url');
  const { existsSync } = await import('node:fs');
  const selfUrl = new URL('../lib/index.js', import.meta.url);
  const root = fileURLToPath(new URL('../../../', selfUrl));
  // 推出的根必须真的含 eval/ 与 plugins/ —— 错一层就会指向 plugins/ 或 plugins/agint-evolve/
  assert.ok(existsSync(join(root, 'eval')), `推出的根 ${root} 下没有 eval/ ⇒ 层数写错了`);
  assert.ok(existsSync(join(root, 'plugins')), `推出的根 ${root} 下没有 plugins/ ⇒ 层数写错了`);
  assert.ok(existsSync(join(root, 'eval', 'scenarios', 'inventory.json')), '推出的根应含场景清单');
});

test('⛔ 归因产物必须已落盘（否则自动推导也读不到 → 周报永远「未采到」）', async () => {
  const { existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../../../', new URL('../lib/index.js', import.meta.url)));
  const p = join(root, 'eval', 'attribution', 'fail-attribution.json');
  assert.ok(existsSync(p), `缺少归因产物 ${p} —— 请跑 node bin/attribute-eval-fails.mjs --json > ${p}`);
  const parsed = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(typeof parsed.total, 'number');
  assert.equal(typeof parsed.byCategory, 'object');
});

test('⛔ Config schema 认 evalAttributionPath（可选），但认不出就静默丢配置', async () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.match(src, /evalAttributionPath: z\.string\(\)\.min\(1\)\.optional\(\)/);
});