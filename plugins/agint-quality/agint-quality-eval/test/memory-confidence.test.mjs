/**
 * 回归闸：agint-quality-eval 写进 memory 的 confidence 不得落到 0.5 兜底。
 *
 * 背景（2026-11-01）：toMemoryRecord 曾只返回 type/content/evidence，
 * agint.memory.write 的 `input.confidence ?? 0.5` 兜底把每次 weekly 的评估日志
 * 都写成假 50% 确信。神谕层「决策确信度」= Σ(conf × [evidence 非空]) / N 是
 * **全库均值**，271 条里 195 条是 0.5（其中 109 条来自本插件），指标被压到
 * 0.610，低于阈 0.70 判红。
 *
 * 这些用例钉死：① 必须显式给 confidence；② 值 = compositeScore/100；
 * ③ veto（compositeScore=null）时给 0 而非 0.5。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMemoryRecord } from '../lib/index.js';

/** 构造一个 EvalResult（字段形状取 evaluators.js 的真实产物） */
function evalResult({ trust = 1, reliability = 1, effectiveness = 1, safety = 1, integrability = 1, harm = {} } = {}) {
  const s = (v) => ({ score: v === null ? null : { score: v } });
  return {
    targetId: 'agint-demo',
    kind: 'plugin',
    dimensions: [
      { key: 'trust', ...s(trust) },
      { key: 'reliability', ...s(reliability) },
      { key: 'effectiveness', ...s(effectiveness) },
      { key: 'safety', ...s(safety) },
      { key: 'integrability', ...s(integrability) },
    ],
    harm: { homogeneity: 0, alignment: 0, reduction: 0, mutability: 0, ...harm },
    evaluatorId: 'd-qaf-v0.2',
  };
}

test('buildMemoryRecord: confidence 必须显式存在，且 ≠ 0.5 兜底', () => {
  const rec = buildMemoryRecord(evalResult(), 'PENDING_REVIEW');
  assert.ok('confidence' in rec, '缺 confidence 会落到 memory.write 的 0.5 兜底');
  assert.equal(typeof rec.confidence, 'number');
  assert.ok(rec.confidence >= 0 && rec.confidence <= 1);
  // 全维满分 → 1.0，不是 0.5
  assert.equal(rec.confidence, 1);
});

test('buildMemoryRecord: confidence = compositeScore/100（全维 0.8 → 0.8）', () => {
  const rec = buildMemoryRecord(evalResult({ trust: 0.8, reliability: 0.8, effectiveness: 0.8, safety: 0.8, integrability: 0.8 }), 'PENDING_REVIEW');
  assert.equal(rec.confidence, 0.8);
});

test('buildMemoryRecord: safety veto（compositeScore=null）→ confidence 0，不是 0.5', () => {
  const rec = buildMemoryRecord(evalResult({ safety: 0 }), 'REJECT');
  assert.equal(rec.confidence, 0, '无结论 = 零确信；0.5 会伪装成「有一半把握」');
});

test('buildMemoryRecord: 维度全 null（den=0）→ confidence 0', () => {
  const rec = buildMemoryRecord(evalResult({ trust: null, reliability: null, effectiveness: null, safety: null, integrability: null }), 'REJECT');
  assert.equal(rec.confidence, 0);
});

test('buildMemoryRecord: evidence 非空（合规项不得让 confidence 归零）', () => {
  const rec = buildMemoryRecord(evalResult(), 'PENDING_REVIEW');
  assert.ok(rec.evidence && String(rec.evidence).trim() !== '');
});

test('buildMemoryRecord: content 仍带得出维度明细（可回填复算）', () => {
  const rec = buildMemoryRecord(evalResult({ trust: 0.9 }), 'PENDING_REVIEW');
  const m = /evaluated\s*→\s*\S+\s*\((\{[\s\S]*\})\)\s*$/.exec(rec.content);
  assert.ok(m, 'content 尾部必须保留 JSON 维度明细');
  const dims = JSON.parse(m[1]);
  assert.equal(dims.trust, 0.9);
  assert.ok('harm' in dims);
});
