#!/usr/bin/env node
/**
 * eval/anchor/anchor.test.mjs —— 阶段 1 纯函数单测
 * ⛔ 显式路径跑：node --test eval/anchor/anchor.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LABEL_AUTHORITY_VALUES } from '../../bin/lib/scenario-tier.mjs';
import {
  isExternalFrozen,
  decisionOf,
  groupByKind,
  splitFalsePosNeg,
  computeConsistency,
  EXTERNAL_LABEL_AUTHORITIES,
  REGRESSION_DELTA_THRESHOLD,
} from './anchor.mjs';

/** 造一条判定样本。 */
function s(id, over = {}) {
  return {
    id, kind: 'curriculum', layer: 'L3',
    labelAuthority: 'GOLD', frozenLabel: 'PASS',
    frozenBy: 'human', frozenAt: '2026-11-07T00:00:00Z',
    compositeScore: 0.8, ...over,
  };
}

function assertNoData(rate, reasonRe) {
  assert.equal(rate.value, null, '无数据必须是 null');
  assert.match(rate.reason, reasonRe);
}

// ── 枚举单一真源 ───────────────────────────────────────────────────────────
test('✅ 枚举复用 scenario-tier.mjs，外部权威是其子集', () => {
  assert.deepEqual([...LABEL_AUTHORITY_VALUES], ['UNSET', 'SILVER', 'GOLD', 'HELDOUT']);
  for (const a of EXTERNAL_LABEL_AUTHORITIES) assert.ok(LABEL_AUTHORITY_VALUES.includes(a));
});

test('✅ isExternalFrozen 只认 GOLD/HELDOUT + 合法 frozenLabel', () => {
  assert.equal(isExternalFrozen(s('a')), true);
  assert.equal(isExternalFrozen(s('b', { labelAuthority: 'HELDOUT' })), true);
  assert.equal(isExternalFrozen(s('c', { labelAuthority: 'SILVER' })), false);
  assert.equal(isExternalFrozen(s('d', { labelAuthority: 'UNSET' })), false);
  assert.equal(isExternalFrozen(s('e', { frozenLabel: 'MAYBE' })), false);
  assert.equal(isExternalFrozen(null), false);
});

// ── 三态纪律 ───────────────────────────────────────────────────────────────
test('⛔ 0 样本 ⇒ 一致率无数据，绝不返回 0', () => {
  const r = computeConsistency([]);
  assert.equal(r.verdict, 'NOT_EVALUATED');
  assert.equal(r.total, 0);
  assertNoData(r.rate, /NO_EXTERNAL_FROZEN_LABELS/);
  assert.equal(r.regression.value, null);
  assert.match(r.regression.reason, /NO_COMPARABLE_RATE/);
});

test('⛔ 全 UNSET / SILVER ⇒ 可用样本 0，SILVER 单独计数，不作真值', () => {
  const r = computeConsistency([
    s('a', { labelAuthority: 'UNSET' }),
    s('b', { labelAuthority: 'SILVER' }),
    s('c', { labelAuthority: 'SILVER' }),
  ]);
  assert.equal(r.usable, 0);
  assert.equal(r.excluded.unset, 1);
  assert.equal(r.excluded.silver, 2);
  assertNoData(r.rate, /NO_EXTERNAL_FROZEN_LABELS/);
  assert.equal(r.falsePositive, 0);
  assert.equal(r.falseNegative, 0);
});

test('⛔ labelAuthority 列缺失 ≠ 真 0；非法枚举不静默丢弃', () => {
  const noField = { id: 'x', frozenLabel: 'PASS', compositeScore: 0.8 };
  const r = computeConsistency([
    noField,
    s('b', { labelAuthority: 'HUMAN_FROZEN' }),
    s('c', { labelAuthority: 'GOLD', frozenLabel: 'MAYBE' }),
  ]);
  assert.equal(r.excluded.noAuthorityField, 1);
  assert.equal(r.excluded.unknownAuthority, 1);
  assert.equal(r.excluded.invalidFrozenLabel, 1);
  assert.equal(r.usable, 0);
  assertNoData(r.rate, /NO_EXTERNAL_FROZEN_LABELS/);
});

// ── 一致率与误放/误杀 ──────────────────────────────────────────────────────
test('✅ 全一致 ⇒ 一致率 1，无误放误杀', () => {
  const r = computeConsistency([
    s('a'), s('b'), s('c', { frozenLabel: 'REJECT', compositeScore: null }),
  ]);
  assert.equal(r.usable, 3);
  assert.equal(r.rate.value, 1);
  assert.equal(r.falsePositive, 0);
  assert.equal(r.falseNegative, 0);
});

test('✅ 误放 / 误杀分开统计，不合并成一个「错误数」', () => {
  const r = computeConsistency([
    s('a'),                                                      // 判 PASS / 真 PASS ✓
    s('b', { frozenLabel: 'REJECT', compositeScore: 0.9 }),        // 判 PASS / 真 REJECT ⇒ 误放
    s('c', { frozenLabel: 'PASS', compositeScore: null }),         // 判 REJECT / 真 PASS ⇒ 误杀
  ]);
  assert.equal(r.rate.value, 1 / 3);
  assert.equal(r.falsePositive, 1);
  assert.equal(r.falseNegative, 1);
  assert.equal(splitFalsePosNeg([s('b', { frozenLabel: 'REJECT', compositeScore: 0.9 })]).falsePositive.length, 1);
});

test('✅ decisionOf：0 是合法有限分数判 PASS，null/NaN 判 REJECT', () => {
  assert.equal(decisionOf({ compositeScore: 0 }), 'PASS');
  assert.equal(decisionOf({ compositeScore: 0.5 }), 'PASS');
  assert.equal(decisionOf({ compositeScore: null }), 'REJECT');
  assert.equal(decisionOf({}), 'REJECT');
  assert.equal(decisionOf({ compositeScore: Number.NaN }), 'REJECT');
});

// ── 分组 ───────────────────────────────────────────────────────────────────
test('✅ groupByKind 把缺 kind 归 UNSPECIFIED，不丢样本', () => {
  const g = groupByKind([s('a'), { id: 'b' }, s('c', { kind: 'evolve' })]);
  assert.equal(g.curriculum.length, 1);
  assert.equal(g.UNSPECIFIED.length, 1);
  assert.equal(g.evolve.length, 1);
});

test('⛔ 分组样本不足 ⇒ 该组不出一致率（不许 1 条报 100%）', () => {
  const r = computeConsistency([s('a', { kind: 'dream' }), s('b'), s('c'), s('d')]);
  assert.equal(r.rate.value, 1, '整体有 4 条，可出一致率');
  assertNoData(r.byKind.dream, /INSUFFICIENT_GROUP_SAMPLES/);
  assert.equal(r.byKind.curriculum.value, 1);
});

// ── 回归探测 ───────────────────────────────────────────────────────────────
test('✅ 一致率下降超过 2% ⇒ 告警；恰好等于阈值不告警', () => {
  const rows = [s('a'), s('b', { frozenLabel: 'REJECT', compositeScore: 0.9 })]; // 0.5
  const r = computeConsistency(rows, { previousRate: 0.55 });
  assert.equal(r.rate.value, 0.5);
  assert.equal(r.regression.value, true);
  assert.ok(Math.abs(r.regression.delta - (-0.05)) < 1e-12);
  assert.equal(REGRESSION_DELTA_THRESHOLD, -0.02);

  const flat = computeConsistency([s('a'), s('b')], { previousRate: 1 });
  assert.equal(flat.regression.value, false, 'delta = 0 不告警');
});

test('⛔ 本期或参照期无数据 ⇒ 回归不判，不编一个 false', () => {
  const r = computeConsistency([], { previousRate: 0.9 });
  assert.equal(r.regression.value, null);
  const r2 = computeConsistency([s('a')], { previousRate: null });
  assert.equal(r2.regression.value, null);
  assert.match(r2.regression.reason, /NO_COMPARABLE_RATE/);
});
