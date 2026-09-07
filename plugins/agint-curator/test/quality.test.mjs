/**
 * lib/quality.js 单元测试 — Sprint 15 P0-2 T2 质量评估 + 质量加速规则。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { successTrend, harmTrend, evaluateQuality, qualityRules, appendQualitySnapshot, QUALITY_THRESHOLDS } from '../lib/quality.js';

// ── successTrend ─────────────────────────────────────────────────────────

test('successTrend：历史不足（<3 周）→ unknown，不编造', () => {
  const r = successTrend([
    { week: 'W1', successRate: 0.9 },
    { week: 'W2', successRate: 0.8 },
  ]);
  assert.equal(r.state, 'unknown');
});

test('successTrend：连续 2 周降幅>10% → declining', () => {
  const r = successTrend([
    { week: 'W1', successRate: 0.9 },
    { week: 'W2', successRate: 0.8 },
    { week: 'W3', successRate: 0.7 },
  ]);
  assert.equal(r.state, 'declining');
  assert.match(r.reason, /连续 2 周下降/);
});

test('successTrend：波动但未达 2 连降 → stable', () => {
  const r = successTrend([
    { week: 'W1', successRate: 0.8 },
    { week: 'W2', successRate: 0.9 },
    { week: 'W3', successRate: 0.85 },
  ]);
  assert.equal(r.state, 'stable');
});

test('successTrend：只取最近 4 周窗口（早于窗口的下降不计）', () => {
  const r = successTrend([
    { week: 'W1', successRate: 1.0 },
    { week: 'W2', successRate: 0.5 },
    { week: 'W3', successRate: 0.9 },
    { week: 'W4', successRate: 0.85 },
    { week: 'W5', successRate: 0.8 },
  ], { ...QUALITY_THRESHOLDS, trendWindowWeeks: 4 });
  // 窗口 = W2..W5：W4→W5 只降 1 次 → stable
  assert.equal(r.state, 'stable');
});

// ── harmTrend ────────────────────────────────────────────────────────────

test('harmTrend：无评估历史 → unknown + hasData=false（HARM 缺失降级）', () => {
  const r = harmTrend([]);
  assert.equal(r.state, 'unknown');
  assert.equal(r.hasData, false);
});

test('harmTrend：HARM 增量连续 2 次<0 → declining', () => {
  const entries = [
    { scores: { harmIncrementEstimate: -0.5 } },
    { scores: { harmIncrementEstimate: -0.3 } },
  ];
  const r = harmTrend(entries);
  assert.equal(r.state, 'declining');
  assert.equal(r.hasData, true);
  assert.equal(r.lastDelta, -0.3);
});

test('harmTrend：中间回升打断连续下降 → stable', () => {
  const entries = [
    { scores: { harmIncrementEstimate: -0.5 } },
    { scores: { harmIncrementEstimate: 0.2 } },
    { scores: { harmIncrementEstimate: -0.3 } },
  ];
  const r = harmTrend(entries);
  assert.equal(r.state, 'stable');
});

// ── evaluateQuality ──────────────────────────────────────────────────────

test('evaluateQuality：成功率下降 + HARM 缺失 → declining（成功率侧）', () => {
  const skill = {
    quality: { history: [
      { week: 'W1', successRate: 0.9 },
      { week: 'W2', successRate: 0.8 },
      { week: 'W3', successRate: 0.7 },
    ] },
  };
  const q = evaluateQuality(skill, { evolutionEntries: [] });
  assert.equal(q.qualityState, 'declining');
  assert.equal(q.successTrend.state, 'declining');
  assert.equal(q.harmTrend.state, 'unknown');
  assert.equal(q.reasons.length, 1);
});

test('evaluateQuality：双路数据都无 → unknown', () => {
  const q = evaluateQuality({ quality: { history: [] } }, { evolutionEntries: [] });
  assert.equal(q.qualityState, 'unknown');
});

test('evaluateQuality：HARM 下降 → declining（即使成功率 stable）', () => {
  const skill = { quality: { history: [
    { week: 'W1', successRate: 0.9 },
    { week: 'W2', successRate: 0.9 },
    { week: 'W3', successRate: 0.9 },
  ] } };
  const q = evaluateQuality(skill, {
    evolutionEntries: [
      { scores: { harmIncrementEstimate: -0.5 } },
      { scores: { harmIncrementEstimate: -0.3 } },
    ],
  });
  assert.equal(q.qualityState, 'declining');
  assert.equal(q.reasons.length, 1);
});

// ── qualityRules（P0-2 §7.2）────────────────────────────────────────────

const decliningQuality = {
  state: 'active',
  quality: { harmTrend: { state: 'declining', lastDelta: -0.3, hasData: true } },
  usage: { successRate: 0.4 },
};

test('规则1：active + HARM 连续 2 次<0 + 成功率<0.5 → 加速 stale', () => {
  const r = qualityRules(decliningQuality, {});
  assert.equal(r.accelerateStale, true);
  assert.equal(r.accelerateArchive, false);
  assert.match(r.reason, /规则1/);
});

test('规则1 不触发：成功率≥0.5', () => {
  const r = qualityRules({ ...decliningQuality, usage: { successRate: 0.6 } }, {});
  assert.equal(r.accelerateStale, false);
});

test('规则2：stale + HARM 持续下降 → 加速 archive（60 天）', () => {
  const r = qualityRules({
    state: 'stale',
    quality: { harmTrend: { state: 'declining', lastDelta: -0.2, hasData: true } },
    usage: { successRate: 0.6 },
  }, {});
  assert.equal(r.accelerateArchive, true);
  assert.match(r.reason, /规则2/);
});

test('规则3：stale + HARM>1.0 + 成功率>0.8 → 保护不归档 + review 标记', () => {
  const r = qualityRules({
    state: 'stale',
    quality: { harmTrend: { state: 'stable', lastDelta: 1.5, hasData: true } },
    usage: { successRate: 0.9 },
  }, {});
  assert.equal(r.protectFromArchive, true);
  assert.equal(r.reviewSuggested, true);
  assert.equal(r.accelerateArchive, false);
  assert.match(r.reason, /规则3/);
});

test('规则 3 优先于规则 2：保护 > 加速', () => {
  const r = qualityRules({
    state: 'stale',
    quality: { harmTrend: { state: 'declining', lastDelta: 1.5, hasData: true } },
    usage: { successRate: 0.9 },
  }, {});
  assert.equal(r.protectFromArchive, true);
  assert.equal(r.accelerateArchive, false);
});

// ── appendQualitySnapshot ────────────────────────────────────────────────

test('appendQualitySnapshot：同周覆盖、按周排序、截断到 maxWeeks', () => {
  let hist = [];
  hist = appendQualitySnapshot({ quality: { history: hist } }, { week: 'W1', successRate: 0.9, useCount: 1 }, 4);
  hist = appendQualitySnapshot({ quality: { history: hist } }, { week: 'W2', successRate: 0.8, useCount: 2 }, 4);
  hist = appendQualitySnapshot({ quality: { history: hist } }, { week: 'W1', successRate: 0.95, useCount: 3 }, 4); // 覆盖 W1
  assert.equal(hist.length, 2);
  assert.equal(hist[0].week, 'W1');
  assert.equal(hist[0].successRate, 0.95);
  assert.equal(hist[1].week, 'W2');

  for (let i = 0; i < 8; i++) {
    hist = appendQualitySnapshot({ quality: { history: hist } }, { week: `W${i}`, successRate: 0.9, useCount: i }, 4);
  }
  assert.equal(hist.length, 4);
  assert.equal(hist[0].week, 'W4');
});
