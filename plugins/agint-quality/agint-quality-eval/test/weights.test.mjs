/**
 * weights 外置可配置测试（行动 #5，2026-09-28）。
 * 覆盖：默认快照、schema/校验（未知键、越界、非法类型）、resolve 合并与回退、
 * compositeScore 权重注入。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DIMENSION_WEIGHTS,
  WEIGHT_KEYS,
  validateWeights,
  resolveWeights,
  mergedWeights,
} from '../lib/weights.js';
import { compositeScore, DIMENSION_WEIGHTS } from '../lib/evaluators.js';

test('默认权重快照 = evaluators 的 DIMENSION_WEIGHTS（单一事实源）', () => {
  assert.deepEqual(DEFAULT_DIMENSION_WEIGHTS, { ...DIMENSION_WEIGHTS });
  assert.equal(DEFAULT_DIMENSION_WEIGHTS.safety, 0.30);
  assert.equal(DEFAULT_DIMENSION_WEIGHTS.convention, 0.00);
});

test('WEIGHT_KEYS 覆盖全部维度键', () => {
  assert.deepEqual(
    [...WEIGHT_KEYS].sort(),
    ['adaptability', 'convention', 'effectiveness', 'integrability', 'promptStatic', 'reliability', 'safety', 'trust'].sort(),
  );
});

test('validateWeights: null/undefined → valid', () => {
  assert.deepEqual(validateWeights(null), { valid: true, issues: [] });
  assert.deepEqual(validateWeights(undefined), { valid: true, issues: [] });
});

test('validateWeights: 合法 partial → valid', () => {
  assert.deepEqual(validateWeights({ safety: 0.4, trust: 0.1 }), { valid: true, issues: [] });
});

test('validateWeights: 未知维度键 → invalid', () => {
  const r = validateWeights({ magic: 0.5 });
  assert.equal(r.valid, false);
  assert.match(r.issues[0], /unknown dimension key "magic"/);
});

test('validateWeights: 越界值 → invalid', () => {
  assert.equal(validateWeights({ safety: 1.5 }).valid, false);
  assert.equal(validateWeights({ safety: -0.1 }).valid, false);
});

test('validateWeights: 非数字 → invalid', () => {
  assert.equal(validateWeights({ safety: '0.5' }).valid, false);
  assert.equal(validateWeights({ safety: NaN }).valid, false);
});

test('resolveWeights: partial 覆盖 + 缺失键回退默认', () => {
  const r = resolveWeights({ safety: 0.4 });
  assert.equal(r.fallbackToDefault, false);
  assert.equal(r.issues.length, 0);
  assert.equal(r.weights.safety, 0.4);
  assert.equal(r.weights.trust, DEFAULT_DIMENSION_WEIGHTS.trust);
  assert.equal(r.weights.reliability, DEFAULT_DIMENSION_WEIGHTS.reliability);
});

test('resolveWeights: 非法 patch → 回退默认 + issues（不抛）', () => {
  const r = resolveWeights({ safety: 2.0 });
  assert.equal(r.fallbackToDefault, true);
  assert.equal(r.issues.length, 1);
  assert.equal(r.weights.safety, DEFAULT_DIMENSION_WEIGHTS.safety);
});

test('resolveWeights: null → 默认', () => {
  const r = resolveWeights(null);
  assert.deepEqual(r.weights, { ...DEFAULT_DIMENSION_WEIGHTS });
  assert.equal(r.fallbackToDefault, false);
});

test('mergedWeights: 快捷合并', () => {
  const w = mergedWeights({ effectiveness: 0.3 });
  assert.equal(w.effectiveness, 0.3);
  assert.equal(w.safety, DEFAULT_DIMENSION_WEIGHTS.safety);
});

// ---- compositeScore 权重注入（evaluators.js 改动验证） ----

const sampleResult = {
  dimensions: [
    { key: 'trust', score: { score: 0.8 } },
    { key: 'safety', score: { score: 0.9 } },
    { key: 'effectiveness', score: { score: 0.5 } },
  ],
};

test('compositeScore: 缺省权重 = 内置表（向后兼容）', () => {
  const score = compositeScore(sampleResult);
  // (0.20*0.8 + 0.30*0.9 + 0.10*0.5) / (0.20+0.30+0.10) * 100 = (0.16+0.27+0.05)/0.60*100 = 80.0
  assert.equal(score, 80.0);
});

test('compositeScore: 注入权重改变综合分（可配置生效）', () => {
  const score = compositeScore(sampleResult, { trust: 0.4, safety: 0.3, effectiveness: 0.1 });
  // (0.4*0.8 + 0.3*0.9 + 0.1*0.5) / (0.4+0.3+0.1) * 100 = (0.32+0.27+0.05)/0.8*100 = 80.0
  assert.equal(score, 80.0);
  const score2 = compositeScore(sampleResult, { trust: 0.1, safety: 0.8, effectiveness: 0.1 });
  // (0.1*0.8 + 0.8*0.9 + 0.1*0.5) / 1.0 * 100 = (0.08+0.72+0.05)*100 = 85.0
  assert.equal(score2, 85.0);
});

test('compositeScore: 注入权重为 0 的维度不计入', () => {
  const r = compositeScore(sampleResult, { trust: 0, safety: 0.3, effectiveness: 0.1 });
  // 只 trust 权重 0 → 忽略 trust； (0.3*0.9 + 0.1*0.5)/(0.4)*100 = (0.27+0.05)/0.4*100 = 80.0
  assert.equal(r, 80.0);
});
