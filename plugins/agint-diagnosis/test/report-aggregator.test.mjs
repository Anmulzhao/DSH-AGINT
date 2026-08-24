#!/usr/bin/env node
// agint-diagnosis / report-aggregator unit test.
// `node test/report-aggregator.test.mjs` 一行能跑（node --test 模式）。
//
// 覆盖（子任务 #5 交付要求）：
//   - 空 window → annotationCount=0, clusterCount=0, 7-key 全 0
//   - window 命中 N 条 → annotationCount=N, rootCauseDistribution 聚合正确
//   - windowDays 边界：1 / 30 / 365 都生效
//   - generatedAt 是 ISO 字符串
//   - 不在 window 内的 annotation 不计入
//   - 7-key map 一项不缺（UNCERTAIN = 0 仍要出现）
//   - ≥6 用例

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateReport,
  isValidWindowDays,
  filterByWindow,
  buildRootCauseDistribution,
} from '../lib/report-aggregator.js';
import { ROOT_CAUSE_KINDS } from '../lib/schema.js';

// ── helpers ──────────────────────────────────────────────────────────────

function isoOffset(daysAgo) {
  return new Date(Date.now() - daysAgo * 86400_000).toISOString();
}

function makeAnnotation({ failureId, rootCause, confidence = 0.7, daysAgo = 0, evidence = '...' }) {
  return {
    failureId,
    rootCause,
    confidence,
    evidence,
    id: `anno-${failureId}-${daysAgo}`,
    kind: 'annotation',
    createdAt: isoOffset(daysAgo),
  };
}

const EMPTY_DIST = Object.freeze({
  PROMPT_DEFICIENCY: 0,
  TOOL_GAP: 0,
  KNOWLEDGE_GAP: 0,
  REASONING_ERROR: 0,
  PLANNING_FAILURE: 0,
  ENVIRONMENT_SHIFT: 0,
  UNCERTAIN: 0,
});

// ── Case 1: 空 annotations → 全 0 ───────────────────────────────────────

test('空 annotations → annotationCount=0, clusterCount=0, 7-key 全 0', async () => {
  const r = await aggregateReport({ annotations: [], windowDays: 7 });
  assert.equal(r.annotationCount, 0);
  assert.equal(r.clusterCount, 0);
  assert.deepEqual(r.rootCauseDistribution, EMPTY_DIST);
  assert.equal(r.windowDays, 7);
});

// ── Case 2: 5 条 annotation（3 TOOL_GAP + 2 PROMPT_DEFICIENCY）window=7 ──

test('5 条 annotation window=7 → annotationCount=5, distribution 正确', async () => {
  const annotations = [
    makeAnnotation({ failureId: 'f-1', rootCause: 'TOOL_GAP', daysAgo: 1 }),
    makeAnnotation({ failureId: 'f-2', rootCause: 'TOOL_GAP', daysAgo: 2 }),
    makeAnnotation({ failureId: 'f-3', rootCause: 'TOOL_GAP', daysAgo: 3 }),
    makeAnnotation({ failureId: 'f-4', rootCause: 'PROMPT_DEFICIENCY', daysAgo: 4 }),
    makeAnnotation({ failureId: 'f-5', rootCause: 'PROMPT_DEFICIENCY', daysAgo: 5 }),
  ];
  const r = await aggregateReport({ annotations, windowDays: 7 });
  assert.equal(r.annotationCount, 5);
  assert.equal(r.rootCauseDistribution.TOOL_GAP, 3);
  assert.equal(r.rootCauseDistribution.PROMPT_DEFICIENCY, 2);
  assert.equal(r.rootCauseDistribution.KNOWLEDGE_GAP, 0);
  assert.equal(r.rootCauseDistribution.REASONING_ERROR, 0);
  assert.equal(r.rootCauseDistribution.PLANNING_FAILURE, 0);
  assert.equal(r.rootCauseDistribution.ENVIRONMENT_SHIFT, 0);
  assert.equal(r.rootCauseDistribution.UNCERTAIN, 0);
});

// ── Case 3: windowDays 边界 1 / 30 / 365 ─────────────────────────────────

test('windowDays=1: 仅 1 天内的 annotation 计入', async () => {
  const annotations = [
    makeAnnotation({ failureId: 'recent', rootCause: 'TOOL_GAP', daysAgo: 0 }),
    makeAnnotation({ failureId: 'old', rootCause: 'TOOL_GAP', daysAgo: 5 }),
  ];
  const r = await aggregateReport({ annotations, windowDays: 1 });
  assert.equal(r.annotationCount, 1, '仅 daysAgo=0 计入；daysAgo=5 被 window=1 过滤');
});

test('windowDays=30: 30 天内的都计入', async () => {
  const annotations = [
    makeAnnotation({ failureId: 'a', rootCause: 'TOOL_GAP', daysAgo: 0 }),
    makeAnnotation({ failureId: 'b', rootCause: 'TOOL_GAP', daysAgo: 29 }),
    makeAnnotation({ failureId: 'c', rootCause: 'TOOL_GAP', daysAgo: 31 }),
  ];
  const r = await aggregateReport({ annotations, windowDays: 30 });
  assert.equal(r.annotationCount, 2, 'daysAgo=0/29 计入；daysAgo=31 不计');
});

test('windowDays=365: 1 年内的都计入', async () => {
  const annotations = [
    makeAnnotation({ failureId: 'a', rootCause: 'TOOL_GAP', daysAgo: 0 }),
    makeAnnotation({ failureId: 'b', rootCause: 'TOOL_GAP', daysAgo: 364 }),
  ];
  const r = await aggregateReport({ annotations, windowDays: 365 });
  assert.equal(r.annotationCount, 2, 'windowDays=365 含 daysAgo=364');
});

// ── Case 4: generatedAt 是 ISO 字符串 ───────────────────────────────────

test('generatedAt 是 ISO 字符串', async () => {
  const r = await aggregateReport({ annotations: [], windowDays: 7 });
  assert.equal(typeof r.generatedAt, 'string');
  // ISO 8601: e.g. 2026-08-25T00:00:00.000Z
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(r.generatedAt), `generatedAt="${r.generatedAt}" 符合 ISO 8601`);
  assert.equal(isNaN(Date.parse(r.generatedAt)), false, 'generatedAt 可被 Date.parse 解析');
});

// ── Case 5: 不在 window 内的 annotation 不计入 ──────────────────────────

test('不在 window 内的 annotation 不计入', async () => {
  const annotations = [
    // 在 7 天内
    makeAnnotation({ failureId: 'in1', rootCause: 'TOOL_GAP', daysAgo: 0 }),
    makeAnnotation({ failureId: 'in2', rootCause: 'TOOL_GAP', daysAgo: 6 }),
    // 超过 7 天
    makeAnnotation({ failureId: 'out1', rootCause: 'TOOL_GAP', daysAgo: 8 }),
    makeAnnotation({ failureId: 'out2', rootCause: 'TOOL_GAP', daysAgo: 30 }),
    makeAnnotation({ failureId: 'out3', rootCause: 'TOOL_GAP', daysAgo: 100 }),
  ];
  const r = await aggregateReport({ annotations, windowDays: 7 });
  assert.equal(r.annotationCount, 2, '仅 daysAgo ∈ [0, 7] 计入');
});

// ── Case 6: 7-key map 一项不缺（UNCERTAIN=0 仍出现）─────────────────────

test('7-key map 一项不缺（UNCERTAIN=0 仍出现）', async () => {
  const r = await aggregateReport({ annotations: [], windowDays: 7 });
  // 7 个 key 全在
  for (const k of ROOT_CAUSE_KINDS) {
    assert.ok(Object.prototype.hasOwnProperty.call(r.rootCauseDistribution, k),
      `distribution 应含 key=${k}`);
    assert.equal(r.rootCauseDistribution[k], 0, `未匹配 → ${k}=0`);
  }
  assert.equal(Object.keys(r.rootCauseDistribution).length, ROOT_CAUSE_KINDS.length);
});

// ── Case 7: UNCERTAIN 也计入 distribution ───────────────────────────────

test('UNCERTAIN annotation 也计入 distribution', async () => {
  const annotations = [
    makeAnnotation({ failureId: 'u1', rootCause: 'UNCERTAIN', daysAgo: 0 }),
    makeAnnotation({ failureId: 'u2', rootCause: 'UNCERTAIN', daysAgo: 0 }),
    makeAnnotation({ failureId: 'p1', rootCause: 'PROMPT_DEFICIENCY', daysAgo: 0 }),
  ];
  const r = await aggregateReport({ annotations, windowDays: 7 });
  assert.equal(r.rootCauseDistribution.UNCERTAIN, 2);
  assert.equal(r.rootCauseDistribution.PROMPT_DEFICIENCY, 1);
});

// ── Case 8: 非法 windowDays 抛错 ────────────────────────────────────────

test('非法 windowDays 抛错', async () => {
  await assert.rejects(
    () => aggregateReport({ annotations: [], windowDays: 0 }),
    /windowDays 必须在 1\.\.365/,
  );
  await assert.rejects(
    () => aggregateReport({ annotations: [], windowDays: 366 }),
    /windowDays 必须在 1\.\.365/,
  );
  await assert.rejects(
    () => aggregateReport({ annotations: [], windowDays: -1 }),
    /windowDays 必须在 1\.\.365/,
  );
  await assert.rejects(
    () => aggregateReport({ annotations: [], windowDays: 'abc' }),
    /windowDays 必须在 1\.\.365/,
  );
  await assert.rejects(
    () => aggregateReport({ annotations: [], windowDays: 7.5 }),
    /windowDays 必须在 1\.\.365/,
  );
});

// ── Case 9: isValidWindowDays 边界直接验 ───────────────────────────────

test('isValidWindowDays: 1..365 整数通过，其他 reject', () => {
  assert.equal(isValidWindowDays(1), true);
  assert.equal(isValidWindowDays(7), true);
  assert.equal(isValidWindowDays(365), true);
  assert.equal(isValidWindowDays(0), false);
  assert.equal(isValidWindowDays(366), false);
  assert.equal(isValidWindowDays(-5), false);
  assert.equal(isValidWindowDays(7.5), false);
  assert.equal(isValidWindowDays('7'), false);
  assert.equal(isValidWindowDays(null), false);
});

// ── Case 10: filterByWindow + buildRootCauseDistribution 直接验 ──────────

test('filterByWindow + buildRootCauseDistribution 内部 helper', () => {
  const annotations = [
    makeAnnotation({ failureId: 'a', rootCause: 'TOOL_GAP', daysAgo: 0 }),
    makeAnnotation({ failureId: 'b', rootCause: 'TOOL_GAP', daysAgo: 10 }),
    makeAnnotation({ failureId: 'c', rootCause: 'PROMPT_DEFICIENCY', daysAgo: 0 }),
    { kind: 'annotation', failureId: 'bad', createdAt: 'not-a-date' },  // createdAt 损坏
  ];
  const filtered = filterByWindow(annotations, 7);
  assert.equal(filtered.length, 2, 'filterByWindow 应过滤掉 daysAgo=10 和 createdAt 损坏的');
  const dist = buildRootCauseDistribution(filtered);
  assert.equal(dist.TOOL_GAP, 1);
  assert.equal(dist.PROMPT_DEFICIENCY, 1);
  assert.equal(dist.UNCERTAIN, 0);
});