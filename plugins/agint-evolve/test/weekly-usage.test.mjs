#!/usr/bin/env node
// agint-evolve / W8-1 Effects：周额度按「提案」而非「执行行」计数 — `node test/weekly-usage.test.mjs`。
//
// ══ 这份用例守的是什么 ══
//
// v0.22.0 起 partial 会自动续跑：一条横跨 N 个文件的提案会产出 N 条
// `ok:true, state:'succeeded'` 的执行行。旧的 weeklyUsage 数的是**执行行**，
// 于是**一条提案吃掉 N 格周额度** —— 而红线说的是「部署几次」，不是「改了几个文件」。
//
// 实测后果：一条 3 单元提案 + 续跑上限 5 ⇒ 单条提案就能把 weeklyCommitCap=5 吃光，
// 之后所有提案一律 defer 到下周。那不是限流，是误伤。
//
// ⛔ 每条用例都配了阴性对照：证明「旧口径会红、新口径才对」，而不是自证新代码正确。

import test from 'node:test';
import assert from 'node:assert/strict';
import { weeklyUsage } from '../lib/execution.js';

const NOW = Date.parse('2026-11-04T10:00:00.000Z'); // 周三
const HOUR = 3600 * 1000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

/** 一条成功的执行行。 */
const row = (proposalId, msAgo, extra = {}) => ({
  id: `exec-${proposalId}-${msAgo}`,
  proposalId,
  state: 'succeeded',
  ok: true,
  finishedAt: iso(msAgo),
  ...extra,
});

/** 旧口径（数执行行）—— 只在断言里当阴性对照用，不进生产代码。 */
const oldCount = (jobs, now = NOW) => (Array.isArray(jobs) ? jobs : []).filter((j) => {
  if (!j || j.ok !== true || j.state !== 'succeeded') return false;
  const ts = Date.parse(String(j.finishedAt ?? j.updatedAt ?? ''));
  return Number.isFinite(ts) && ts >= now - 7 * 24 * HOUR;
}).length;

// ── 一组：基本语义 ──────────────────────────────────────────────────

test('E1 同一提案的 3 次续跑只算 1 格（⛔ 阴性对照：旧口径会算 3）', () => {
  const jobs = [
    row('p-alpha', 5 * HOUR),
    row('p-alpha', 4 * HOUR),
    row('p-alpha', 3 * HOUR),
  ];
  const out = weeklyUsage(jobs, NOW);
  assert.equal(out.count, 1, '同一条提案续跑 3 次，周额度只能算 1 格');
  assert.deepEqual(out.proposals, ['p-alpha']);
  // 明细不去重：周报要能说出「跑了 3 次」
  assert.equal(out.jobs.length, 3, 'jobs 是明细，必须保留未去重的 3 行');
  // ⛔ 阴性对照
  assert.equal(oldCount(jobs), 3, '旧口径确实会算 3 —— 这不是假设，是同一份数据算出来的');
});

test('E2 两条提案各跑 2 次 ⇒ 2 格（⛔ 阴性对照：旧口径算 4）', () => {
  const jobs = [
    row('p-a', 6 * HOUR), row('p-a', 5 * HOUR),
    row('p-b', 4 * HOUR), row('p-b', 3 * HOUR),
  ];
  const out = weeklyUsage(jobs, NOW);
  assert.equal(out.count, 2);
  assert.deepEqual(out.proposals.sort(), ['p-a', 'p-b']);
  assert.equal(oldCount(jobs), 4);
});

test('E3 上限语义：3 单元提案 + cap=5 ⇒ 旧口径吃不饱一条就顺延，新口径只占 1 格', () => {
  // 构造一条 5 单元的提案（续跑 4 次 = 5 条执行行）
  const jobs = Array.from({ length: 5 }, (_, i) => row('p-big', (9 - i) * HOUR));
  const cap = 5;
  const before = oldCount(jobs);
  const after = weeklyUsage(jobs, NOW).count;
  assert.equal(before, 5);
  assert.equal(after, 1);
  assert.ok(before >= cap, '旧口径下这一条提案就把 5 格额度吃满 ⇒ 后续提案全被 defer');
  assert.ok(after < cap, '新口径下它还只占 1 格 ⇒ 本周还能再推进 4 条提案');
});

// ── 二组：不该被计入的 ─────────────────────────────────────────────

test('E4 失败的行不占额度（红线只算成功落地）', () => {
  const jobs = [
    row('p-a', HOUR),
    { ...row('p-b', 2 * HOUR), ok: false, state: 'failed' },
    { ...row('p-c', 3 * HOUR), ok: true, state: 'failed' }, // ok 与 state 不一致：以 state 为准
    { ...row('p-d', 4 * HOUR), ok: false, state: 'succeeded' },
  ];
  const out = weeklyUsage(jobs, NOW);
  assert.equal(out.count, 1, '只有 ok===true 且 state===succeeded 的才算');
  assert.deepEqual(out.proposals, ['p-a']);
});

test('E5 窗口外的行不算（自然周之外的历史不压本周）', () => {
  const jobs = [
    row('p-new', 2 * HOUR),
    row('p-old', 10 * 24 * HOUR), // 10 天前
  ];
  const out = weeklyUsage(jobs, NOW, NOW - Date.parse('2026-11-02T00:00:00.000Z')); // 本周一起
  assert.equal(out.count, 1);
  assert.deepEqual(out.proposals, ['p-new']);
});

test('E6 缺 proposalId 的行**不合并**（宁多算不错并 —— 错并会让上限静默失效）', () => {
  const jobs = [
    { id: 'e1', state: 'succeeded', ok: true, finishedAt: iso(HOUR) },
    { id: 'e2', state: 'succeeded', ok: true, finishedAt: iso(2 * HOUR) },
    { id: 'e3', proposalId: '', state: 'succeeded', ok: true, finishedAt: iso(3 * HOUR) },
  ];
  const out = weeklyUsage(jobs, NOW);
  assert.equal(out.count, 3, '没有 proposalId 的每条都算独立一格，不能全部塌缩成键 undefined');
  // ⛔ 反向对照：天真去重 `new Set(map(j => String(j.proposalId ?? '')))` 在这里算成 **1**
  //    —— 两条 undefined 和一条空串全被 `?? ''` 挤成同一个键。
  //    3 条真实执行被记成 1 格 ⇒ 上限被静默放宽 3 倍。这是本用例要挡的那种错合并：
  //    它不报错、不崩溃，只是让红线悄悄失效。
  const naive = new Set(jobs.map((j) => String(j.proposalId ?? ''))).size;
  assert.equal(naive, 1, '天真去重会把 3 条挤成 1 —— 方向是「上限变松」，最危险的那一侧');
  assert.ok(out.count > naive, '正确实现必须比天真去重更保守（数得更多）');;
});

test('E7 返回 shape 稳定：count / proposals / since / jobs 都在', () => {
  const out = weeklyUsage([row('p-a', HOUR)], NOW);
  assert.equal(typeof out.count, 'number');
  assert.ok(Array.isArray(out.proposals));
  assert.equal(typeof out.since, 'string');
  assert.ok(Array.isArray(out.jobs));
  assert.ok(!Number.isNaN(Date.parse(out.since)));
});

test('E8 空输入 / 非数组输入不炸', () => {
  assert.equal(weeklyUsage([], NOW).count, 0);
  assert.equal(weeklyUsage(null, NOW).count, 0);
  assert.equal(weeklyUsage(undefined, NOW).count, 0);
  assert.deepEqual(weeklyUsage([], NOW).proposals, []);
});

test('E9 时间戳坏掉的行被丢弃（不当作"刚刚发生"）', () => {
  const jobs = [
    row('p-a', HOUR),
    { id: 'x', proposalId: 'p-b', state: 'succeeded', ok: true, finishedAt: 'not-a-date' },
    { id: 'y', proposalId: 'p-c', state: 'succeeded', ok: true, finishedAt: '' },
  ];
  const out = weeklyUsage(jobs, NOW);
  assert.equal(out.count, 1);
  assert.deepEqual(out.proposals, ['p-a']);
});

test('E10 同一提案跨窗口边界时：窗口外那次不拉低、窗口内那次照算', () => {
  const weekStart = Date.parse('2026-11-02T00:00:00.000Z');
  const jobs = [
    { ...row('p-a', 0), finishedAt: '2026-11-01T23:00:00.000Z' }, // 上周日，窗口外
    { ...row('p-a', 0), finishedAt: '2026-11-03T09:00:00.000Z' }, // 本周一，窗口内
  ];
  const out = weeklyUsage(jobs, NOW, NOW - weekStart);
  assert.equal(out.count, 1, '本周确实推进过 p-a');
  assert.equal(out.jobs.length, 1, '明细里只该有本周那一行');
});

// ── 三组：与 agint-executor 的等价实现口径一致 ──────────────────────
//
// `agint-executor/test/week-unit.test.mjs` 里有一份**独立实现**的 newCount()
// （按仓库硬约定：跨插件不许直接 import，那次单侧升级就会让路径失效）。
// 两份实现必须算出同一个数 —— 否则 executor 的判定用例会「自己跟自己绿」，
// 而生产上 evolve 报的数根本不是它以为的那个口径。
//
// ⛔ 一致性只能在这一侧验（这里能 import 自己的真实实现）；executor 侧那份
//    只能是**同一套判据的复刻**，它无法自证。这正是本组用例存在的理由。

test('E11 口径一致性：executor 那份等价实现与本实现给出同一个数', () => {
  // 与 executor 用例里 newCount() 逐字等价的实现（改动本用例需同步改那边）
  const executorSideCount = (rows) => new Set(
    (Array.isArray(rows) ? rows : [])
      .filter((j) => j && j.ok === true && j.state === 'succeeded')
      .map((j) => String(j.proposalId ?? '').trim() || `__row_${j.id}`),
  ).size;

  const cases = [
    // 单提案续跑
    [row('p-a', HOUR), row('p-a', 2 * HOUR), row('p-a', 3 * HOUR)],
    // 多提案
    [row('p-a', HOUR), row('p-b', HOUR), row('p-c', HOUR)],
    // 含失败行
    [row('p-a', HOUR), { ...row('p-b', HOUR), ok: false }, { ...row('p-c', HOUR), state: 'failed' }],
    // 缺 proposalId
    [{ id: 'x1', ok: true, state: 'succeeded', finishedAt: iso(HOUR) },
     { id: 'x2', ok: true, state: 'succeeded', finishedAt: iso(2 * HOUR) }],
    // 空
    [],
  ];
  for (const rows of cases) {
    const mine = weeklyUsage(rows, NOW).count;
    const theirs = executorSideCount(rows);
    assert.equal(theirs, mine, `口径不一致：evolve=${mine} executor=${theirs}（数据 ${JSON.stringify(rows)}）`);
  }
});
