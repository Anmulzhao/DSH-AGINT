// difficulty-ctl 单元测试（§4.6 难度调节纯函数）。

import test from 'node:test';
import assert from 'node:assert/strict';

import { recordVerdict, adjustDifficulty } from '../lib/difficulty.js';
import { DIFFICULTY_LEVELS } from '../lib/schema.js';

const NOW = Date.parse('2026-09-08T00:00:00Z');
const day = (n) => new Date(NOW - n * 86400000).toISOString();

function baseState(overrides = {}) {
  return {
    domain: 'codegen',
    level: 'D2',
    windowResults: [],
    consecutivePass: 0,
    consecutiveFail: 0,
    cannotCandidate: false,
    ...overrides,
  };
}

function results(...list) {
  return list.map((r, i) => ({ result: r, at: day(i) }));
}

test('cold-start：窗口样本 < 5 且无连续序列信号 → 不调档（§4.6）', () => {
  // pass/fail/pass 交错：完成率 66.7% 在护栏内，但样本 3 < 5 → keep
  const state = baseState({ windowResults: results('pass', 'fail', 'pass') });
  const adj = adjustDifficulty(state, { minSamples: 5 });
  assert.equal(adj.action, 'keep');
  assert.match(adj.reason, /cold-start/);
  assert.equal(adj.level, 'D2');
});

test('行为信号优先于 cold-start：连续 pass=3 即使样本 <5 也强制升档（防刷分）', () => {
  const state = baseState({ windowResults: results('pass', 'pass', 'pass'), consecutivePass: 3 });
  const adj = adjustDifficulty(state, { minSamples: 5, forcePromoteStreak: 3 });
  assert.equal(adj.action, 'force-promote');
  assert.equal(adj.level, 'D3');
});

test('行为信号优先于 cold-start：连续 fail=3 即使样本 <5 也降档（防挫败）', () => {
  const state = baseState({ windowResults: results('fail', 'fail', 'fail'), consecutiveFail: 3 });
  const adj = adjustDifficulty(state, { minSamples: 5, forceDemoteStreak: 3 });
  assert.equal(adj.action, 'force-demote');
  assert.equal(adj.level, 'D1');
  assert.equal(adj.cannotCandidate, true);
});

test('完成率 < 40% → 降档；> 70% → 升档', () => {
  const low = baseState({ windowResults: results('fail', 'fail', 'pass', 'fail', 'fail') }); // 1/5 = 20%
  const adjLow = adjustDifficulty(low, { minSamples: 5 });
  assert.equal(adjLow.action, 'demote');
  assert.equal(adjLow.level, 'D1');

  const high = baseState({ windowResults: results('pass', 'pass', 'pass', 'pass', 'pass') }); // 5/5 = 100%
  const adjHigh = adjustDifficulty(high, { minSamples: 5 });
  assert.equal(adjHigh.action, 'promote');
  assert.equal(adjHigh.level, 'D3');
});

test('连续 pass ≥ 3 → 强制升档（防停在舒适区刷分，§4.6）', () => {
  const state = baseState({ consecutivePass: 3 });
  const adj = adjustDifficulty(state, { forcePromoteStreak: 3 });
  assert.equal(adj.action, 'force-promote');
  assert.equal(adj.level, 'D3');
  assert.match(adj.reason, /强制升档防刷分/);
});

test('连续 fail ≥ 3 → 降档 + CANNOT 候选（供 self-model 复验，§4.6）', () => {
  const state = baseState({ consecutiveFail: 3 });
  const adj = adjustDifficulty(state, { forceDemoteStreak: 3 });
  assert.equal(adj.action, 'force-demote');
  assert.equal(adj.level, 'D1');
  assert.equal(adj.cannotCandidate, true);
  assert.match(adj.reason, /CANNOT 候选/);
});

test('档位边界：D1 不再降 / D5 不再升（夹紧）', () => {
  const floor = baseState({ level: 'D1', windowResults: results('fail', 'fail', 'fail', 'fail', 'fail') });
  const adjFloor = adjustDifficulty(floor, { minSamples: 5 });
  assert.equal(adjFloor.level, 'D1');
  assert.match(adjFloor.reason, /已到 D1 下限/);

  const ceil = baseState({ level: 'D5', windowResults: results('pass', 'pass', 'pass', 'pass', 'pass') });
  const adjCeil = adjustDifficulty(ceil, { minSamples: 5 });
  assert.equal(adjCeil.level, 'D5');
  assert.match(adjCeil.reason, /已到 D5 上限/);
});

test('窗口内正常完成率 → keep（40%-70% 护栏内）', () => {
  // 4/6 = 66.7%
  const state = baseState({ windowResults: results('pass', 'fail', 'pass', 'fail', 'pass', 'pass') });
  const adj = adjustDifficulty(state, { minSamples: 5 });
  assert.equal(adj.action, 'keep');
  assert.equal(adj.windowStats.rate, 0.667);
});

test('recordVerdict：并入判定 + 窗口滚动（28 天外结果被滤掉）+ 连续序列', () => {
  const state = baseState({
    windowResults: [{ result: 'pass', at: day(40) }, { result: 'fail', at: day(5) }],
    consecutivePass: 1,
  });
  const next = recordVerdict(state, { result: 'pass', at: day(0) }, { windowDays: 28, nowMs: NOW });
  // 40 天前的 pass 被滤掉；保留 fail(5天前) + pass(今天)
  assert.equal(next.windowResults.length, 2);
  assert.equal(next.windowResults[0].result, 'fail');
  assert.equal(next.consecutivePass, 2);
  assert.equal(next.consecutiveFail, 0);
});

test('recordVerdict：窗口内结果不排序（保持时间序）', () => {
  const state = baseState();
  const next = recordVerdict(state, { result: 'pass', at: day(2) }, { nowMs: NOW });
  assert.deepEqual(next.windowResults, [{ result: 'pass', at: day(2) }]);
});

test('adjustDifficulty 纯函数：同输入同输出且不改入参', () => {
  const state = baseState({ windowResults: results('pass', 'pass', 'pass', 'pass', 'pass') });
  const snapshot = JSON.stringify(state);
  const a = adjustDifficulty(state, { minSamples: 5 });
  const b = adjustDifficulty(state, { minSamples: 5 });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(state), snapshot);
});

test('难度档序列为 D1-D5', () => {
  assert.deepEqual(DIFFICULTY_LEVELS, ['D1', 'D2', 'D3', 'D4', 'D5']);
});
