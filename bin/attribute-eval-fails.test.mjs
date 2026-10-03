/**
 * bin/attribute-eval-fails.mjs 单测（路线图 A4）
 *
 * 钉的是**归因纪律**，不是「报告长什么样」：
 *   ⛔ 根因类必须来自封闭集（4 类），不能临时编一个
 *   ⛔ 未登记 unitId 一律 NOT_ATTRIBUTED，不许走「兜底猜一个」
 *   ⛔ 证据不足时诚实标 NOT_ATTRIBUTED，不许硬给类
 *   ⛔ 归因值必须来自权威模块实时读数，不是硬编码
 *
 * ⛔ 每条关键判据做「放宽⇒变红」实验。
 *
 * Run: node --test bin/attribute-eval-fails.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FAIL_CATEGORIES,
  DEFAULT_COVERAGE_MIN,
  attributeAll,
  attributeDefaultJobs,
  attributePolicyDecision,
  attributeStatsLimits,
  attributeThrowsOnTableFull,
  attributeUmbrellaKeyProbe,
  probeFor,
  readDefaultJobIds,
  readEvolutionMemoryLimits,
  readFakeTableShape,
  readPolicyWeightsAndThresholds,
  readUmbrellaKeyShape,
  renderAttribution,
} from './attribute-eval-fails.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const INVENTORY = join(REPO_ROOT, 'eval', 'scenarios', 'inventory.json');

// ── 1. 根因类是封闭集 ────────────────────────────────────────────────

test('根因类恰好 4 个且不含占位值', () => {
  assert.deepEqual([...FAIL_CATEGORIES], ['ASSERT_DRIFT', 'HARNESS_GAP', 'REAL_DEFECT', 'NOT_ATTRIBUTED']);
  for (const c of FAIL_CATEGORIES) {
    assert.equal(typeof c, 'string');
    assert.doesNotMatch(c, /unknown|todo|fixme|xxx/i, `⛔ 根因类 ${c} 像占位值`);
  }
});

test('放宽⇒变红：把根因类集合扩到 6 个（含 UNKNOWN / TODO），单测必须变红', () => {
  const widened = [...FAIL_CATEGORIES, 'UNKNOWN', 'TODO'];
  assert.equal(widened.length, 6);
  assert.notDeepEqual([...widened], [...FAIL_CATEGORIES]);
  // 收紧：真正生效的判据是「集合长度恰为 4 且名字固定」
  assert.equal(FAIL_CATEGORIES.length, 4);
});

test('⛔ 未登记的 unitId 不得走兜底猜测', () => {
  assert.equal(probeFor('some-brand-new-unit'), null);
  // 已登记的 6 条必须都有探针 —— 这本身也是门禁：漏一个会让它悄悄变成 NOT_ATTRIBUTED
  const registered = [
    'cron-default-jobs-registered',
    'sprint6-cron-job-prompt-static-check-registered',
    'service-annotations-table-full-throws',
    'stats-reports-counts-and-limits',
    'policy-decide-clean-results-pending-or-deploy',
    's12-05-policy-policy-deployed-rolledback-shadow',
  ];
  for (const id of registered) {
    assert.notEqual(probeFor(id), null, `${id} 必须登记探针`);
  }
});

// ── 2. 权威读数：不硬编码 ─────────────────────────────────────────────

test('readDefaultJobIds 取到真实 job 数（不是脚本里写死的数）', async () => {
  const { ids, count } = await readDefaultJobIds();
  assert.equal(ids.length, count);
  assert.ok(count >= 10, `默认 job 应至少有 10 个，实际读到 ${count}`);
  // 若脚本硬编码成 24，这里改 jobs.js 就会红
  const src = readFileSync(join(REPO_ROOT, 'plugins', 'agint-cron', 'lib', 'jobs.js'), 'utf8');
  const declared = (src.match(/^ {4}id: '/gm) ?? []).length;
  assert.equal(count, declared, `读数 ${count} 应等于 jobs.js 里声明的 ${declared}`);
});

test('readEvolutionMemoryLimits 取到全部 LIMITS key', async () => {
  const limits = await readEvolutionMemoryLimits();
  const src = readFileSync(join(REPO_ROOT, 'plugins', 'agint-evolution-memory', 'lib', 'schema.js'), 'utf8');
  const declared = (src.match(/^ {2}[A-Z_]+: \d+/gm) ?? []).length;
  assert.equal(Object.keys(limits).length, declared, 'LIMITS 读数应与 schema.js 声明数一致');
});

test('readPolicyWeightsAndThresholds 能取到权重与阈值（阈值读不到就返回 null，不猜）', async () => {
  const { weights, thresholds } = await readPolicyWeightsAndThresholds();
  assert.ok(weights.safety > 0);
  assert.ok(thresholds === null || (thresholds.autoDeploy > 0 && thresholds.pendingReview > 0));
});

// ── 3. 探针：断言漂移 ─────────────────────────────────────────────────

test('defaultJobs 探针：场景漏列新 job ⇒ ASSERT_DRIFT + 列出漏了谁', () => {
  const unit = { expected: [{ expectedIds: ['a', 'b'] }] };
  const live = { ids: ['a', 'b', 'c', 'd'], count: 4 };
  const r = attributeDefaultJobs(unit, live);
  assert.equal(r.category, 'ASSERT_DRIFT');
  assert.match(r.reason, /漏列了 2 个/);
  const ev = r.evidence.join('\n');
  assert.match(ev, /c/);
  assert.match(ev, /d/);
  assert.match(r.fix, /不要改 driver 的相等判据/);
});

test('⛔ defaultJobs 探针：期望与真值一致时不许硬给类', () => {
  const unit = { expected: [{ expectedIds: ['a', 'b'] }] };
  const r = attributeDefaultJobs(unit, { ids: ['a', 'b'], count: 2 });
  assert.equal(r.category, 'NOT_ATTRIBUTED');
  assert.match(r.reason, /第三个原因/);
});

test('defaultJobs 探针：双向不一致（场景多了已删 job）时 reason 要分开写', () => {
  const unit = { expected: [{ expectedIds: ['a', 'gone'] }] };
  const r = attributeDefaultJobs(unit, { ids: ['a', 'new'], count: 2 });
  assert.equal(r.category, 'ASSERT_DRIFT');
  assert.match(r.reason, /双向不一致/);
});

test('defaultJobs 探针：expectedIds 缺失 ⇒ NOT_ATTRIBUTED 而非崩', () => {
  const r = attributeDefaultJobs({ expected: [{}] }, { ids: ['a'], count: 1 });
  assert.equal(r.category, 'NOT_ATTRIBUTED');
});

test('statsLimits 探针：新增 key ⇒ ASSERT_DRIFT，并点明「全等比对的必然后果」', () => {
  const unit = { expected: [{ limitsShape: { A: 1 } }] };
  const r = attributeStatsLimits(unit, { A: 1, B: 2 });
  assert.equal(r.category, 'ASSERT_DRIFT');
  assert.match(r.reason, /新增了 key/);
  assert.match(r.evidence.join('\n'), /全等比对/);
  assert.match(r.fix, /新增 key 不再 fail/, '修法必须给出「放宽判据」这条路，但说明它是改判据');
});

test('statsLimits 探针：值漂移单独成类，不与新增 key 混为一谈', () => {
  const unit = { expected: [{ limitsShape: { A: 1 } }] };
  const r = attributeStatsLimits(unit, { A: 999 });
  assert.equal(r.category, 'ASSERT_DRIFT');
  assert.match(r.reason, /上限值变了/);
});

test('statsLimits 探针：完全一致 ⇒ NOT_ATTRIBUTED', () => {
  const r = attributeStatsLimits({ expected: [{ limitsShape: { A: 1 } }] }, { A: 1 });
  assert.equal(r.category, 'NOT_ATTRIBUTED');
});

// ── 4. 探针：policy 决策漂移 ──────────────────────────────────────────

test('policyDecision 探针：按权威权重实算，与场景期望不符 ⇒ ASSERT_DRIFT', () => {
  const unit = {
    input: [{
      results: [{ dimensions: [
        { key: 'safety', score: { score: 1 }, veto: false },
        { key: 'trust', score: { score: 0.5 }, veto: false },
      ] }],
    }],
    expected: [{ decision: 'PENDING_REVIEW' }],
  };
  const r = attributePolicyDecision(unit, {
    weights: { safety: 0.3, trust: 0.2 },
    thresholds: { autoDeploy: 70, pendingReview: 60 },
  });
  assert.equal(r.category, 'ASSERT_DRIFT');
  assert.match(r.reason, /composite=80 → AUTO_DEPLOY/, '结论里必须印出实算值与分类');
  assert.match(r.reason, /场景期望 PENDING_REVIEW/);
  // (1*0.3 + 0.5*0.2) / (0.3+0.2) * 100 = 0.4/0.5*100 = 80 ⇒ AUTO_DEPLOY（≥70）
  const ev = r.evidence.join('\n');
  assert.match(ev, /0\.4000 \/ 0\.5000/);
  assert.match(ev, /AUTO_DEPLOY/);
});

test('policyDecision 探针：实算与期望一致 ⇒ NOT_ATTRIBUTED', () => {
  const unit = {
    input: [{ results: [{ dimensions: [{ key: 'safety', score: { score: 1 } }] }] }],
    expected: [{ decision: 'AUTO_DEPLOY' }],
  };
  const r = attributePolicyDecision(unit, {
    weights: { safety: 1 },
    thresholds: { autoDeploy: 70, pendingReview: 60 },
  });
  assert.equal(r.category, 'NOT_ATTRIBUTED');
});

test('policyDecision 探针：阈值读不到 ⇒ NOT_ATTRIBUTED，不猜', () => {
  const unit = {
    input: [{ results: [{ dimensions: [{ key: 'safety', score: { score: 1 } }] }] }],
    expected: [{ decision: 'PENDING_REVIEW' }],
  };
  const r = attributePolicyDecision(unit, { weights: { safety: 1 }, thresholds: null });
  assert.equal(r.category, 'NOT_ATTRIBUTED');
  assert.match(r.reason, /不猜/);
});

test('policyDecision 探针：den=0（无有效维度）⇒ NOT_ATTRIBUTED', () => {
  const unit = {
    input: [{ results: [{ dimensions: [{ key: 'convention', score: { score: 1 } }] }] }],
    expected: [{ decision: 'AUTO_DEPLOY' }],
  };
  const r = attributePolicyDecision(unit, {
    weights: { convention: 0 },
    thresholds: { autoDeploy: 70, pendingReview: 60 },
  });
  assert.equal(r.category, 'NOT_ATTRIBUTED');
});

// ── 5. 探针：HARNESS_GAP vs REAL_DEFECT 的分界 ────────────────────────

test('tableFull 探针：fake table 缺 size ⇒ HARNESS_GAP（不是 REAL_DEFECT）', () => {
  const unit = { input: [{ args: { annotationsCount: 200, failurePatternCount: 20 } }], expected: [{ kind: 'throws' }] };
  const r = attributeThrowsOnTableFull(unit, { ANNOTATIONS: 200 }, { found: true, hasSize: false, hasEntries: true });
  assert.equal(r.category, 'HARNESS_GAP');
  assert.match(r.reason, /t\.size/);
  assert.match(r.evidence.join('\n'), /get size\(\)/, '证据必须含真实 Table 接口的定义位置');
  assert.match(r.fix, /不改插件的守门逻辑/);
});

test('tableFull 探针：fake table 有 size ⇒ 判 REAL_DEFECT（前提已满足）', () => {
  const unit = { input: [{ args: { annotationsCount: 200, failurePatternCount: 20 } }], expected: [{ kind: 'throws' }] };
  const r = attributeThrowsOnTableFull(unit, { ANNOTATIONS: 200 }, { found: true, hasSize: true, hasEntries: true });
  assert.equal(r.category, 'REAL_DEFECT');
  assert.match(r.evidence.join('\n'), /HARNESS_GAP 排除/);
});

test('放宽⇒变红：若 HARNESS_GAP / REAL_DEFECT 不分（全部归 REAL_DEFECT），必须被测出来', () => {
  const unit = { input: [{ args: { annotationsCount: 200, failurePatternCount: 20 } }], expected: [{ kind: 'throws' }] };
  const noSize = { found: true, hasSize: false, hasEntries: true };
  const withSize = { found: true, hasSize: true, hasEntries: true };
  const strict = attributeThrowsOnTableFull(unit, { ANNOTATIONS: 200 }, noSize);
  const sloppy = attributeThrowsOnTableFull(unit, { ANNOTATIONS: 200 }, withSize);
  assert.notEqual(strict.category, sloppy.category, '两类必须能被区分，否则 mock 缺口会被当成产品缺陷去改代码');
});

test('tableFull 探针：cold-start 会先拦时要把守门顺序印出来', () => {
  const unit = { input: [{ args: { annotationsCount: 200, failurePatternCount: 3 } }], expected: [{ kind: 'throws' }] };
  const r = attributeThrowsOnTableFull(unit, { ANNOTATIONS: 200 }, { found: true, hasSize: false, hasEntries: true });
  assert.match(r.evidence.join('\n'), /cold-start\(failure_pattern<10\)/);
});

// ── 6. 探针：前提被推翻的断言 ─────────────────────────────────────────

test('umbrellaKey 探针：伞键已补上 ⇒ ASSERT_DRIFT，且不许建议删断言', () => {
  const unit = { expected: [{ expectedKeys: ['publishDoesNotUseUmbrellaKey=true'] }] };
  const r = attributeUmbrellaKeyProbe(unit, { hasUmbrellaProvide: true, umbrellaProvidesPublish: true });
  assert.equal(r.category, 'ASSERT_DRIFT');
  assert.match(r.reason, /已被推翻的前提/);
  assert.match(r.fix, /不要删掉这项断言/);
  assert.match(r.evidence.join('\n'), /11 项都过|12 项断言/, '证据要包含「其余断言都过」这一关键区分');
});

test('umbrellaKey 探针：伞键未 provide ⇒ 不猜（NOT_ATTRIBUTED）', () => {
  const unit = { expected: [{ expectedKeys: ['publishDoesNotUseUmbrellaKey=true'] }] };
  const r = attributeUmbrellaKeyProbe(unit, { hasUmbrellaProvide: false });
  assert.equal(r.category, 'NOT_ATTRIBUTED');
});

test('umbrellaKey 探针：场景不含该断言 ⇒ NOT_ATTRIBUTED', () => {
  const r = attributeUmbrellaKeyProbe({ expected: [{ expectedKeys: ['other=true'] }] }, { hasUmbrellaProvide: true });
  assert.equal(r.category, 'NOT_ATTRIBUTED');
});

// ── 7. 端到端：真实 inventory ────────────────────────────────────────

test('真实 inventory：6 个 FAIL 全部归因到类，覆盖率 100% ≥ 80%', async () => {
  const inv = JSON.parse(readFileSync(INVENTORY, 'utf8'));
  const fails = inv.units.filter((u) => u.lastKnownStatus === 'FAIL');
  const a = await attributeAll({ units: inv.units });
  assert.equal(a.total, fails.length);
  assert.equal(a.attributed, a.total);
  assert.equal(a.coverage, 1);
  assert.equal(a.coverageOk, true);
  assert.equal(a.results.filter((r) => r.category === 'NOT_ATTRIBUTED').length, 0);
});

test('真实 inventory：0 条 REAL_DEFECT（6 个 fail 全在评估侧）', async () => {
  const inv = JSON.parse(readFileSync(INVENTORY, 'utf8'));
  const a = await attributeAll({ units: inv.units });
  assert.equal(a.realDefects, 0);
  const byCat = a.byCategory;
  assert.ok(byCat.ASSERT_DRIFT >= 1);
});

test('每条归因的证据都不为空，且都有修法', async () => {
  const inv = JSON.parse(readFileSync(INVENTORY, 'utf8'));
  const a = await attributeAll({ units: inv.units });
  for (const r of a.results) {
    assert.ok(Array.isArray(r.evidence) && r.evidence.length >= 2, `${r.unitId} 证据太少`);
    for (const e of r.evidence) assert.ok(e && e.length > 0, `${r.unitId} 有空证据项`);
    assert.ok(r.fix && r.fix.length > 0, `${r.unitId} 缺修法`);
    assert.ok(r.reason && r.reason.length > 0, `${r.unitId} 缺结论`);
  }
});

test('覆盖率阈值可调：把阈值提到 1.1 ⇒ coverageOk 必须为 false（判据有牙齿）', async () => {
  const inv = JSON.parse(readFileSync(INVENTORY, 'utf8'));
  const a = await attributeAll({ units: inv.units, coverageMin: 1.1 });
  assert.equal(a.coverage, 1);
  assert.equal(a.coverageOk, false, '⛔ 覆盖率 100% 也可能不达 1.1 的阈值 —— 判据不是恒真');
});

test('0 个 FAIL 时 coverage 必须是 null 而不是 1（不把「没查」印成「全过」）', async () => {
  const a = await attributeAll({ units: [{ unitId: 'x', lastKnownStatus: 'PASS' }] });
  assert.equal(a.total, 0);
  assert.equal(a.coverage, null);
  assert.equal(a.coverageOk, false);
  const md = renderAttribution(a);
  assert.match(md, /0 个 FAIL/, '⛔ 0 个 FAIL 要显式声明「无内容可归因」');
});

// ── 8. 渲染纪律 ─────────────────────────────────────────────────────

test('渲染：4 个根因类都要印出来（哪怕计数为 0）', async () => {
  const inv = JSON.parse(readFileSync(INVENTORY, 'utf8'));
  const md = renderAttribution(await attributeAll({ units: inv.units }));
  for (const c of FAIL_CATEGORIES) assert.match(md, new RegExp(`\`${c}\``));
  assert.match(md, /不要为了让 driver 全绿而放宽判据/);
});

test('渲染：每条 unitId 都要有独立小节', async () => {
  const inv = JSON.parse(readFileSync(INVENTORY, 'utf8'));
  const fails = inv.units.filter((u) => u.lastKnownStatus === 'FAIL');
  const md = renderAttribution(await attributeAll({ units: inv.units }));
  for (const f of fails) assert.ok(md.includes(`### \`${f.unitId}\``), `缺 ${f.unitId} 小节`);
});

test('只读纪律：归因过程不改任何文件', async () => {
  const { execFileSync } = await import('node:child_process');
  const { readdirSync, statSync } = await import('node:fs');
  const snapshot = () => readdirSync(REPO_ROOT)
    .map((f) => `${f}:${statSync(join(REPO_ROOT, f)).mtimeMs}`).sort().join('|');
  const before = snapshot();
  execFileSync(process.execPath, [join(HERE, 'attribute-eval-fails.mjs')], { cwd: REPO_ROOT });
  assert.equal(snapshot(), before, '⛔ 只读脚本不许在仓库根写/改任何东西');
});

test('DEFAULT_COVERAGE_MIN 就是路线图要求的 0.8', () => {
  assert.equal(DEFAULT_COVERAGE_MIN, 0.8);
});