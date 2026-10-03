/**
 * metric-resolver 单测（1a 补片 / 方案②）。
 *
 * 要守的是两条：① 只读提案自己声明的期望，读不出就 null（不猜）；
 * ② 解析出的指标名必须落在 predictor 的规则表列名里 —— 两张表各写各的，
 * 接线就变成"解析得到、预测不出来"的哑弹。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveTargetMetric,
  matchMetricFromExpectedEffect,
  METRIC_KEYWORDS,
  METRIC_SOURCE,
  RESOLVABLE_METRICS,
} from '../lib/metric-resolver.js';
import { DEFAULT_RULE_TABLE } from '../lib/predictor.js';

test('variant 行记过指标 ⇒ 原样用，本模块不插手（含四类之外的名字）', () => {
  for (const metric of ['SUCCESS_RATE', 'HARM_RATE', '某个业务自定义指标']) {
    const r = resolveTargetMetric({ variantMetric: metric, expectedEffect: '延迟 <= 1s 在 7 天' });
    assert.deepEqual(r, { metric, source: METRIC_SOURCE.VARIANT, reason: null, matched: [] },
      `variant 有指标还去解析期望串 = 篡改已有记录：${metric}`);
  }
});

test('⛔ 兜底值 unspecified / 空串 / 全空格 都算「没定过指标」', () => {
  for (const bad of ['unspecified', '', '   ', null, undefined, 42, {}]) {
    const r = resolveTargetMetric({ variantMetric: bad, expectedEffect: null });
    assert.equal(r.source, null, `不该认它是指标：${JSON.stringify(bad)}`);
    assert.equal(r.metric, null);
  }
});

test('从期望串读指标（生产实况措辞）', () => {
  const cases = [
    ['baseline 通过率 >= 95% 在 7 天', 'SUCCESS_RATE'],
    ['tool 调用成功率 >= 80% within 7 天', 'SUCCESS_RATE'],
    ['token 用量 <= 40% within 7 天', 'TOKEN_EFFICIENCY'],
    ['Token 消耗 <= 20% 在 7 天', 'TOKEN_EFFICIENCY'],
    ['响应延迟 <= 1200ms 在 7 天', 'LATENCY'],
    ['p95 latency <= 900ms within 7 天', 'LATENCY'],
    ['回归 <= 5% 在 7 天', 'REGRESSION'],
  ];
  for (const [text, metric] of cases) {
    const r = resolveTargetMetric({ variantMetric: 'unspecified', expectedEffect: text });
    assert.equal(r.metric, metric, `${text} ⇒ ${r.metric}（期望 ${metric}）`);
    assert.equal(r.source, METRIC_SOURCE.EXPECTED_EFFECT, '出处必须标 EXPECTED_EFFECT');
    assert.equal(r.reason, null);
    assert.deepEqual(r.matched, [metric]);
  }
});

test('⛔ 一个都不匹配 ⇒ null + METRIC_UNSTATED（不替提案编指标）', () => {
  const r = resolveTargetMetric({ variantMetric: null, expectedEffect: '质量 >= 95% 在 7 天' });
  assert.equal(r.metric, null);
  assert.equal(r.reason, 'METRIC_UNSTATED');
  assert.deepEqual(r.matched, []);
});

test('⛔ 命中两类以上 ⇒ null + METRIC_AMBIGUOUS + matched 列出全部', () => {
  const r = resolveTargetMetric({
    variantMetric: 'unspecified',
    expectedEffect: '通过率 >= 95% 且延迟 <= 1s 在 7 天',
  });
  assert.equal(r.metric, null, '歧义时取第一个命中 = 关键词表的顺序替系统做预测');
  assert.equal(r.reason, 'METRIC_AMBIGUOUS');
  assert.deepEqual(r.matched, ['SUCCESS_RATE', 'LATENCY']);
});

test('期望串缺失 / 非串 ⇒ NO_EXPECTED_EFFECT', () => {
  for (const bad of [null, undefined, '', '   ', 7, { metric: 'SUCCESS_RATE' }]) {
    const r = resolveTargetMetric({ variantMetric: 'unspecified', expectedEffect: bad });
    assert.equal(r.metric, null);
    assert.equal(r.reason, 'NO_EXPECTED_EFFECT', `${JSON.stringify(bad)}`);
  }
});

test('matchMetricFromExpectedEffect 是纯函数：同串两次结果逐字段相同', () => {
  const t = 'baseline 通过率 >= 95% 在 7 天';
  assert.deepEqual(matchMetricFromExpectedEffect(t), matchMetricFromExpectedEffect(t));
});

test('两张表不许分叉：解析表每个指标都要在 predictor 规则表里有缺省条目', () => {
  assert.deepEqual(RESOLVABLE_METRICS, Object.keys(METRIC_KEYWORDS));
  for (const kind of Object.keys(DEFAULT_RULE_TABLE)) {
    for (const metric of RESOLVABLE_METRICS) {
      assert.ok(DEFAULT_RULE_TABLE[kind][metric],
        `规则表 ${kind} 缺 ${metric} ⇒ 解析得到却预测不出来（哑弹）`);
    }
  }
  // 反方向：规则表里有、解析表里没有的指标名 = 解析不出来的死角，必须显式承认。
  const ruleOnly = new Set();
  for (const kind of Object.keys(DEFAULT_RULE_TABLE)) {
    for (const metric of Object.keys(DEFAULT_RULE_TABLE[kind])) {
      if (!RESOLVABLE_METRICS.includes(metric)) ruleOnly.add(`${kind}::${metric}`);
    }
  }
  assert.deepEqual([...ruleOnly], [], '两张表的指标清单必须一一对应');
});
