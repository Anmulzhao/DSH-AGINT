/**
 * agint-quality-policy: 跨能力回归门测试（含 negative control）
 *
 * 来源：RSI-Env（arXiv 2611.01736）表 1。
 *   Knowledge Self：SimpleQA 82.0 → 88.0，同时 GPQA 65.2 → 53.0、
 *   Terminal-Bench 12.4 → 5.6。目标涨、非目标掉是常态，不是异常。
 *
 * 本文件必须同时跑正例与负控。只跑正例时，门禁改没改都看不出来
 * （KNOWLEDGE.md K200：只跑正例不跑负控 = 门禁改没改都看不出来）。
 *
 * Run: node --test plugins/agint-quality/agint-quality-policy/test/cross-capability-guard.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCrossCapabilityRegression } from '../lib/crossCapabilityGuard.js';
import { decidePolicy } from '../lib/decide.js';

const baseline = { effectiveness: 0.70, safety: 0.90, trust: 0.90, integrability: 0.80 };

test('正例：目标涨、非目标稳定 ⇒ stable', () => {
  const r = detectCrossCapabilityRegression({
    baseline,
    current: { effectiveness: 0.88, safety: 0.90, trust: 0.90, integrability: 0.80 },
    targetDimensions: ['effectiveness'],
  });
  assert.equal(r.verdict, 'stable');
  assert.deepEqual(r.regressions, []);
});

test('negative control：目标涨、非目标大跌 ⇒ 必须判 regressed', () => {
  // 复刻 RSI-Env Knowledge Self 的形状：目标 +6，非目标 -12.2 / -6.8。
  const r = detectCrossCapabilityRegression({
    baseline,
    current: { effectiveness: 0.88, safety: 0.78, trust: 0.70, integrability: 0.65 },
    targetDimensions: ['effectiveness'],
  });
  assert.equal(r.verdict, 'regressed', '单目标门禁会放行这种改动，本门必须拦');
  assert.ok(r.regressions.length >= 2, '应列出全部退化维度，便于归因');
  assert.ok(r.regressions.every((x) => x.delta < 0), '退化方向必须是负');
  assert.ok(r.reason.includes('safety'));
});

test('unmeasured：缺基线 / 未声明目标 / 缺当期维度，都不得冒充 stable', () => {
  const a = detectCrossCapabilityRegression({
    baseline: null,
    current: { effectiveness: 0.9 },
    targetDimensions: ['effectiveness'],
  });
  assert.equal(a.verdict, 'unmeasured');
  assert.equal(a.reason, 'baseline-missing');

  const b = detectCrossCapabilityRegression({
    baseline,
    current: { effectiveness: 0.9 },
    targetDimensions: [],
  });
  assert.equal(b.verdict, 'unmeasured');
  assert.equal(b.reason, 'target-dimensions-unspecified');

  const c = detectCrossCapabilityRegression({
    baseline,
    current: { effectiveness: 0.9 },
    targetDimensions: ['effectiveness'],
  });
  assert.equal(c.verdict, 'unmeasured', 'current 缺非目标维度 = 没核过，不是没退化');
  assert.ok(c.reason.startsWith('dimensions-unmeasured:'));
});

test('阈值边界：恰好等于允许幅度不算退化，超过一点才算', () => {
  const justAt = detectCrossCapabilityRegression({
    baseline: { safety: 0.90 },
    current: { safety: 0.80 },
    targetDimensions: ['effectiveness'],
    dropThreshold: 0.10,
  });
  assert.equal(justAt.verdict, 'stable');
  const justOver = detectCrossCapabilityRegression({
    baseline: { safety: 0.90 },
    current: { safety: 0.79 },
    targetDimensions: ['effectiveness'],
    dropThreshold: 0.10,
  });
  assert.equal(justOver.verdict, 'regressed');
});

// ── decidePolicy 接入 ────────────────────────────────────────────────────

function highScoreResult() {
  return {
    targetId: 'target-1',
    dimensions: ['trust', 'reliability', 'effectiveness', 'safety', 'integrability', 'promptStatic']
      .map((key) => ({ key, score: { score: 0.95 } })),
    findings: [],
    tags: [],
  };
}

test('negative control：不传 crossCapability ⇒ 决策零行为变化', async () => {
  const d = await decidePolicy({ results: [highScoreResult()] });
  assert.equal(d.kind, 'AUTO_DEPLOY');
  assert.ok(
    !d.triggeredBy.some((t) => t.startsWith('cross-capability-')),
    '没给基线时本门不得跑，也不得往 triggeredBy 塞新标记',
  );
});

test('regressed ⇒ AUTO_DEPLOY 封顶为 PENDING_REVIEW，且留归因', async () => {
  const d = await decidePolicy({
    results: [highScoreResult()],
    options: {
      crossCapability: {
        baseline,
        current: { effectiveness: 0.88, safety: 0.70, trust: 0.70, integrability: 0.70 },
        targetDimensions: ['effectiveness'],
      },
    },
  });
  assert.equal(d.kind, 'PENDING_REVIEW', '目标涨、非目标掉不得自动放行');
  assert.ok(d.triggeredBy.some((t) => t.startsWith('cross-capability-regressed:')));
});

test('unmeasured ⇒ 不阻断，但强制留痕', async () => {
  const d = await decidePolicy({
    results: [highScoreResult()],
    options: { crossCapability: { baseline: null, current: {}, targetDimensions: ['effectiveness'] } },
  });
  assert.equal(d.kind, 'AUTO_DEPLOY', '没核过不等于失败，不冒充门禁发现');
  assert.ok(d.triggeredBy.some((t) => t === 'cross-capability-unmeasured:baseline-missing'));
});

test('kill-switch：config.crossCapabilityGuard.enabled=false 关闭本门', async () => {
  const d = await decidePolicy({
    results: [highScoreResult()],
    config: { crossCapabilityGuard: { enabled: false } },
    options: {
      crossCapability: {
        baseline,
        current: { effectiveness: 0.88, safety: 0.70, trust: 0.70, integrability: 0.70 },
        targetDimensions: ['effectiveness'],
      },
    },
  });
  assert.equal(d.kind, 'AUTO_DEPLOY');
  assert.ok(!d.triggeredBy.some((t) => t.startsWith('cross-capability-')));
});
