#!/usr/bin/env node
// agint-executor / W8-1 Effects 的判定层 — `node test/week-unit.test.mjs` 一行能跑。
//
// `plan.js:decideRun` 是「顺延还是执行」的唯一判据，而它只看一个数 `weekCommits`。
// agint-evolve v0.18.0 把那个数的口径从「执行行」改成「提案去重」。
// 本用例守的是**口径变化会不会真的改变判定**。
//
// ⛔ 不在本文件里 import `../../agint-evolve/lib/execution.js`。
//    虽然当前部署位两个插件确实并列、那条相对路径能解析，但本仓硬约定是
//    **跨插件不许直接 import**（一次单侧升级就能让路径失效 ⇒ preset 起不来，
//    而症状只是"某个插件没挂上"）。同 `week.js` 头注的口径：各自保留等价实现，
//    一致性由 evolve 侧的 `test/weekly-usage.test.mjs` 钉住，不是靠这里复算。
//    所以下面两个计数器都是**独立实现的纯函数**，只在本用例内当对照用。

import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRun } from '../lib/plan.js';

const NOW = Date.parse('2026-11-04T10:00:00.000Z'); // 周三
const HOUR = 3600 * 1000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

const OK_PROPOSAL = { id: 'p-x', status: 'approved', blocker: '', autoExecutable: true };
const job = { id: 'e-1', proposalId: 'p-x', attempts: 1, maxAttempts: 2 };
const base = { job, proposal: OK_PROPOSAL, driverReady: true, now: NOW };

/** 一条 5 单元提案跑完的执行行（首次 + 4 次续跑）。 */
const fiveUnitProposalRows = Array.from({ length: 5 }, (_, i) => ({
  id: `exec-p-big-${i}`,
  proposalId: 'p-big',
  state: 'succeeded',
  ok: true,
  finishedAt: iso((10 - i) * HOUR),
}));

/** 旧口径：数执行行（v0.17.0 的 weeklyUsage 行为）。 */
const oldCount = (rows) => rows.filter((j) => j.ok === true && j.state === 'succeeded').length;
/** 新口径：按 proposalId 去重（v0.18.0 的 weeklyUsage 行为）。 */
const newCount = (rows) => new Set(
  rows.filter((j) => j.ok === true && j.state === 'succeeded')
    .map((j) => String(j.proposalId ?? '').trim() || `__row_${j.id}`),
).size;

test('X1 ⛔ 阴性对照：旧口径下（5 格已满）→ defer 顺延', () => {
  const oldWeekCommits = oldCount(fiveUnitProposalRows);
  assert.equal(oldWeekCommits, 5);
  const d = decideRun({ ...base, weekCommits: oldWeekCommits, cap: 5 });
  assert.equal(d.action, 'defer', '旧口径：一条 5 单元提案就把 5 格吃满，新提案一律顺延到下周');
  assert.match(d.reason, /已达上限（5\/5/);
  // 顺延不是拒绝：dueAt 必须是下周起点，而且是可解析的时间
  assert.ok(d.dueAt && !Number.isNaN(Date.parse(d.dueAt)), 'defer 必须给出可解析的下周起点');
});

test('X2 新口径下（1 格）→ run（同一条提案不再吃满周额度）', () => {
  const newWeekCommits = newCount(fiveUnitProposalRows);
  assert.equal(newWeekCommits, 1);
  const d = decideRun({ ...base, weekCommits: newWeekCommits, cap: 5 });
  assert.equal(d.action, 'run', '新口径：同一条提案只占 1 格，本周还有余量推进别的提案');
});

test('X3 真实打满仍然 defer（口径改小不等于上限失效）', () => {
  // 5 条**不同**提案各跑一次 = 真的落地了 5 条
  const rows = Array.from({ length: 5 }, (_, i) => ({
    id: `exec-${i}`, proposalId: `p-${i}`, state: 'succeeded', ok: true, finishedAt: iso((i + 1) * HOUR),
  }));
  const n = newCount(rows);
  assert.equal(n, 5, '5 条不同提案必须算 5 格 —— 否则红线形同虚设');
  const d = decideRun({ ...base, weekCommits: n, cap: 5 });
  assert.equal(d.action, 'defer');
});

test('X4 cap=0 表示不限（不用来判上限）', () => {
  const d = decideRun({ ...base, weekCommits: 999, cap: 0 });
  assert.equal(d.action, 'run');
});

test('X5 混合：2 条提案共 5 次执行 ⇒ 2 格，仍可继续跑', () => {
  const rows = [
    ...fiveUnitProposalRows.slice(0, 3).map((r) => ({ ...r, proposalId: 'p-a' })),
    ...fiveUnitProposalRows.slice(0, 2).map((r) => ({ ...r, proposalId: 'p-b', id: `${r.id}-b` })),
  ];
  const n = newCount(rows);
  assert.equal(n, 2);
  assert.equal(oldCount(rows), 5, '旧口径会算 5（刚好卡在上限边缘，再跑一条就顺延）');
  assert.equal(decideRun({ ...base, weekCommits: n, cap: 5 }).action, 'run');
  assert.equal(decideRun({ ...base, weekCommits: oldCount(rows), cap: 5 }).action, 'defer');
});
