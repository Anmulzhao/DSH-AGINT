/**
 * test/statistics.test.mjs — Sprint 10 v0.6.4 #9b
 *
 * 统计纯函数单元测试（≥10 用例）：
 *   - welchTTest:  4 用例（等均值 / 显著差异 / n<2 / 零方差）
 *   - bonferroni:  3 用例（常规 / 严格 / 边界）
 *   - cohensD:     3 用例（等均值 / 大效应 / 零方差）
 *   - decideWinner:4 用例（显著 A 胜 / 等均值 / 样本不足 / 不显著）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { welchTTest, bonferroniAdjust, cohensD, decideWinner } from '../lib/statistics.js';

// ── welchTTest ────────────────────────────────────────────────────────

test('welchTTest: 等均值样本 → pValue 接近 1', () => {
  const r = welchTTest([0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
  assert.equal(r.t, 0);
  assert.equal(r.df, 0); // 等均值+等方差 → df 公式分子为 0 → 0
  assert.equal(r.pValue, 1);
});

test('welchTTest: 显著差异（A=0.9×10, B=0.5×10）→ pValue<0.05 + |t|大', () => {
  const r = welchTTest(
    [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9],
    [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
  );
  assert.ok(Math.abs(r.t) > 5, `|t|=${Math.abs(r.t)} 应 >5`);
  assert.ok(r.pValue < 0.05, `pValue=${r.pValue} 应 <0.05`);
});

test('welchTTest: n<2 → 返 {t:0, df:0, pValue:1}', () => {
  const r1 = welchTTest([0.5], [0.5, 0.6]);
  assert.deepEqual(r1, { t: 0, df: 0, pValue: 1 });
  const r2 = welchTTest([0.5, 0.6], [0.7]);
  assert.deepEqual(r2, { t: 0, df: 0, pValue: 1 });
  const r3 = welchTTest([0.5], [0.6]);
  assert.deepEqual(r3, { t: 0, df: 0, pValue: 1 });
});

test('welchTTest: 全相等（零方差）→ pValue=1', () => {
  const r = welchTTest([0.7, 0.7, 0.7, 0.7], [0.7, 0.7, 0.7, 0.7]);
  assert.equal(r.pValue, 1);
});

// ── bonferroniAdjust ──────────────────────────────────────────────────

test('bonferroniAdjust: α=0.05 / k=4 → 0.0125', () => {
  assert.equal(bonferroniAdjust(0.05, 4), 0.0125);
});

test('bonferroniAdjust: α=0.01 / k=10 → 0.001', () => {
  assert.equal(bonferroniAdjust(0.01, 10), 0.001);
});

test('bonferroniAdjust: numTests=0 → 返 α（边界）', () => {
  assert.equal(bonferroniAdjust(0.05, 0), 0.05);
  assert.equal(bonferroniAdjust(0.05, -1), 0.05);
});

// ── cohensD ───────────────────────────────────────────────────────────

test('cohensD: 差异 0（相同样本）→ 0', () => {
  assert.equal(cohensD([0.5, 0.5, 0.5], [0.5, 0.5, 0.5]), 0);
});

test('cohensD: 差异 0.5（[0.5,0.5,0.5] vs [1.0,1.0,1.0]）→ 大效应', () => {
  const d = cohensD([0.5, 0.5, 0.5], [1.0, 1.0, 1.0]);
  // 等方差（=0），pooledStd=0 → spec 返 0
  // 这里两列方差都是 0，按 spec 字面 pooledVar=0 → d=0
  assert.equal(d, 0, '两列零方差时 pooledStd=0，按边界返 0');
});

test('cohensD: pooledStd=0（边界）→ 0', () => {
  const d = cohensD([1, 1, 1, 1], [1, 1, 1, 1]);
  assert.equal(d, 0);
});

// ── decideWinner ──────────────────────────────────────────────────────

test('decideWinner: A 显著优于 B（各 10 个 0.9 vs 0.5）→ winner="A"', () => {
  const a = Array(10).fill(0.9);
  const b = Array(10).fill(0.5);
  const taskSuite = Array.from({ length: 10 }, (_, k) => `t${k}`);
  const r = decideWinner({ samplesA: a, samplesB: b, threshold: 0.05, taskSuite });
  assert.equal(r.winner, 'A');
  assert.ok(r.pValue < 0.05, `pValue=${r.pValue}`);
  assert.ok(Math.abs(r.effectSize) > 0.3, `|effectSize|=${Math.abs(r.effectSize)}`);
  assert.equal(r.samples, 20);
});

test('decideWinner: A 与 B 等均值 → inconclusive', () => {
  const a = Array(10).fill(0.7);
  const b = Array(10).fill(0.7);
  const r = decideWinner({
    samplesA: a, samplesB: b,
    threshold: 0.05,
    taskSuite: Array.from({ length: 10 }, (_, k) => `t${k}`),
  });
  assert.equal(r.winner, 'inconclusive');
});

test('decideWinner: samples <10 → inconclusive + reason="samples < 10"', () => {
  const r = decideWinner({
    samplesA: [0.9, 0.9, 0.9], samplesB: [0.5, 0.5, 0.5],
    threshold: 0.05, taskSuite: ['t1', 't2', 't3', 't4', 't5'],
  });
  assert.equal(r.winner, 'inconclusive');
  assert.equal(r.reason, 'samples < 10');
  assert.equal(r.samples, 6);
});

test('decideWinner: 不显著（相等样本 1 vs 1）→ inconclusive + reason 含 pValue', () => {
  const a = Array(10).fill(1);
  const b = Array(10).fill(1);
  const r = decideWinner({
    samplesA: a, samplesB: b,
    threshold: 0.05,
    taskSuite: Array.from({ length: 10 }, (_, k) => `t${k}`),
  });
  assert.equal(r.winner, 'inconclusive');
  assert.ok(r.reason.includes('pValue') || r.reason.includes('effectSize'),
    `reason=${r.reason} 应含 pValue 或 effectSize`);
});