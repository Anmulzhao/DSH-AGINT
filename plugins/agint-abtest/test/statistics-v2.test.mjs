/**
 * test/statistics-v2.test.mjs — v2.1 统计修复（方案 §八，老板 2026-11-18 拍板）
 *
 * 覆盖四处修复：
 *   1. welchTTest p 值改 t 分布 CDF（临界值表对拍，误差 <1e-4）
 *   2. 零方差 epsilon 护栏（浮点噪声不得造出假显著）
 *   3. decideWinner Bonferroni 按 numExperiments（不再除任务数）
 *   4. decideWinnerPaired 配对检验（差值单样本 t）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { welchTTest, decideWinner, decideWinnerPaired, tTwoTailedP } from '../lib/statistics.js';

// ── 1. t 分布对拍（临界值取自标准 t 表，双尾 α=0.05）────────────────────

test('tTwoTailedP: df=9, t=2.262157 → p≈0.05（误差<1e-4）', () => {
  const p = tTwoTailedP(2.262157, 9);
  assert.ok(Math.abs(p - 0.05) < 1e-4, `p=${p} 应≈0.05`);
});

test('tTwoTailedP: df=18, t=2.100922 → p≈0.05（误差<1e-4）', () => {
  const p = tTwoTailedP(2.100922, 18);
  assert.ok(Math.abs(p - 0.05) < 1e-4, `p=${p} 应≈0.05`);
});

test('tTwoTailedP: df=30, t=2.042272 → p≈0.05（误差<1e-4）', () => {
  const p = tTwoTailedP(2.042272, 30);
  assert.ok(Math.abs(p - 0.05) < 1e-4, `p=${p} 应≈0.05`);
});

test('tTwoTailedP: df=1（柯西）, t=1 → p≈0.5（解析真值 2*(0.5-atan(1)/π)）', () => {
  const truth = 2 * (0.5 - Math.atan(1) / Math.PI);
  const p = tTwoTailedP(1, 1);
  assert.ok(Math.abs(p - truth) < 1e-6, `p=${p} truth=${truth}`);
});

test('tTwoTailedP: t=0 → p=1；负 t 与正 t 同 p', () => {
  assert.equal(tTwoTailedP(0, 10), 1);
  assert.equal(tTwoTailedP(-2.5, 10), tTwoTailedP(2.5, 10));
});

test('welchTTest: p 值走 t 分布——同统计量下比正态近似更保守', () => {
  // 构造小样本：n=5/5，t≈2.3。正态近似 p≈0.021，t(df≈8) p≈0.05 附近。
  const a = [0.9, 0.8, 0.85, 0.95, 0.8];
  const b = [0.6, 0.7, 0.65, 0.55, 0.7];
  const r = welchTTest(a, b);
  const normalP = 2 * (1 - 0.5 * (1 + erfApprox(Math.abs(r.t) / Math.SQRT2)));
  assert.ok(r.pValue > normalP, `t 分布 p=${r.pValue} 应 > 正态 p=${normalP}`);
});

// 测试专用正态 CDF（Abramowitz-Stegun），只用来对拍方向，不进生产代码
function erfApprox(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

// ── 2. 零方差 epsilon 护栏 ─────────────────────────────────────────────

test('welchTTest: 两组常数（0.9×10 vs 0.5×10）→ pValue=1，不得假显著', () => {
  const r = welchTTest(Array(10).fill(0.9), Array(10).fill(0.5));
  assert.equal(r.pValue, 1, `浮点噪声方差不得造出 p=${r.pValue}`);
});

test('cohensD 路径: 常数组 decideWinner → inconclusive（effectSize 不得是 1e15 噪声）', () => {
  const r = decideWinner({
    samplesA: Array(10).fill(0.9), samplesB: Array(10).fill(0.5),
    threshold: 0.05, taskSuite: Array.from({ length: 10 }, (_, k) => `t${k}`),
  });
  assert.equal(r.winner, 'inconclusive');
  assert.ok(Math.abs(r.effectSize) < 100, `effectSize=${r.effectSize} 应是有限小值或 0`);
});

// ── 3. Bonferroni 按实验数 ─────────────────────────────────────────────

test('decideWinner: numExperiments=1 时不除任务数（taskSuite=10 不再把 α 压到 0.005）', () => {
  // 差值均值 0.08、差值标准差 ~0.06、n=12 → t≈4.6, p≈0.0007 < 0.05 但 > 0.005? 不，
  // 用边界构造：p 落在 (0.005, 0.05) 区间。n=10, mean=0.1, sd=0.12 → t≈2.64, p≈0.027。
  const diffs = [0.22, -0.02, 0.18, 0.04, 0.26, -0.06, 0.14, 0.08, 0.2, -0.04];
  const a = diffs.map((d) => 0.5 + d);
  const b = diffs.map(() => 0.5);
  const suite = Array.from({ length: 10 }, (_, k) => `t${k}`);
  const r1 = decideWinner({ samplesA: a, samplesB: b, threshold: 0.05, taskSuite: suite, numExperiments: 1 });
  const r10 = decideWinner({ samplesA: a, samplesB: b, threshold: 0.05, taskSuite: suite, numExperiments: 10 });
  assert.ok(r1.pValue < 0.05 && r1.pValue > 0.005, `构造 p=${r1.pValue} 应落在 (0.005,0.05)`);
  assert.equal(r1.winner, 'A', 'numExperiments=1 → α=0.05，应判 A');
  assert.equal(r10.winner, 'inconclusive', 'numExperiments=10 → α=0.005，应不显著');
});

// ── 4. 配对检验 ────────────────────────────────────────────────────────

test('decideWinnerPaired: 一致正差值（12 对，均值 0.2 有抖动）→ winner=A + 小 p', () => {
  const pairs = Array.from({ length: 12 }, (_, i) => ({
    taskId: `t${i}`, scoreA: 0.7 + (i % 3) * 0.02, scoreB: 0.5 + (i % 4) * 0.01,
  }));
  const r = decideWinnerPaired({ pairs, threshold: 0.05 });
  assert.equal(r.winner, 'A');
  assert.ok(r.pValue < 0.001, `p=${r.pValue}`);
  assert.ok(r.effectSize >= 0.3, `d=${r.effectSize}`);
  assert.equal(r.samples, 24);
});

test('decideWinnerPaired: 差值有正有负均值≈0 → inconclusive', () => {
  const pairs = Array.from({ length: 12 }, (_, i) => ({
    taskId: `t${i}`, scoreA: 0.6 + (i % 2 === 0 ? 0.1 : -0.1), scoreB: 0.6,
  }));
  const r = decideWinnerPaired({ pairs, threshold: 0.05 });
  assert.equal(r.winner, 'inconclusive');
});

test('decideWinnerPaired: 配对 <10 → inconclusive + reason', () => {
  const pairs = Array.from({ length: 9 }, (_, i) => ({ taskId: `t${i}`, scoreA: 0.9, scoreB: 0.5 }));
  const r = decideWinnerPaired({ pairs, threshold: 0.05 });
  assert.equal(r.winner, 'inconclusive');
  assert.equal(r.reason, 'pairs < 10');
  assert.equal(r.samples, 18);
});

test('decideWinnerPaired: 差值全同（零方差）→ inconclusive，不得假显著', () => {
  const pairs = Array.from({ length: 12 }, (_, i) => ({ taskId: `t${i}`, scoreA: 0.9, scoreB: 0.5 }));
  const r = decideWinnerPaired({ pairs, threshold: 0.05 });
  assert.equal(r.winner, 'inconclusive');
});

test('decideWinnerPaired: 弱效应（差值均值 0.01，sd≈0.05 → d≈0.2）→ inconclusive（d<0.3）', () => {
  const ds = [0.07, -0.04, 0.05, -0.02, 0.08, -0.05, 0.04, -0.01, 0.06, -0.03, 0.02, -0.05];
  const pairs = ds.map((d, i) => ({ taskId: `t${i}`, scoreA: 0.6 + d, scoreB: 0.6 }));
  const r = decideWinnerPaired({ pairs, threshold: 0.05 });
  assert.equal(r.winner, 'inconclusive');
  assert.ok(Math.abs(r.effectSize) < 0.3, `d=${r.effectSize}`);
});

test('decideWinnerPaired: numExperiments=5 → α 除以 5', () => {
  // mean≈0.062, sd≈0.085, n=12 → t≈2.5, df=11 → p≈0.03：α=0.05 显著，α=0.01 不显著
  const ds = [0.17, -0.03, 0.15, 0.01, 0.19, -0.05, 0.11, 0.03, 0.13, -0.01, 0.09, -0.05];
  const pairs = ds.map((d, i) => ({ taskId: `t${i}`, scoreA: 0.6 + d, scoreB: 0.6 }));
  const r1 = decideWinnerPaired({ pairs, threshold: 0.05, numExperiments: 1 });
  const r5 = decideWinnerPaired({ pairs, threshold: 0.05, numExperiments: 5 });
  assert.ok(r1.pValue > 0.01 && r1.pValue < 0.05, `构造 p=${r1.pValue} 应落在 (0.01,0.05)`);
  assert.equal(r1.winner, 'A');
  assert.equal(r5.winner, 'inconclusive');
});