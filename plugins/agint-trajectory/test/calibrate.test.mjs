/**
 * agint-trajectory 标定期单测（§7bis / 不变量 #5）。
 *
 * 不变量 #5 是硬门禁：setRecordMode('live') 无 ready 报告必须抛错。本文件
 * 验的是「报告怎么算出来的」——四项齐备才算 ready，缺项要列在 missing 里。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalibrationState, noteSample, buildReport, percentile } from '../lib/calibrate.js';
import { computeBudget, DEFAULTS } from '../lib/schema.js';

test('percentile：空/单值/P50/P95', () => {
  assert.equal(percentile([], 0.5), 0);
  assert.equal(percentile([42], 0.95), 42);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.ok(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95) >= 9);
  assert.equal(percentile([5, 3, 1], 0.5), 3, '输入无序也正确');
});

test('noteSample：按天累加 + 样本滚动窗口上限 500', () => {
  let s = createCalibrationState('2026-11-03');
  s = noteSample(s, { day: '2026-11-03', bytes: 1000 });
  s = noteSample(s, { day: '2026-11-03', bytes: 3000 });
  s = noteSample(s, { day: '2026-11-04', bytes: 2000 });
  assert.deepEqual(s.byDay, { '2026-11-03': 2, '2026-11-04': 1 });
  assert.deepEqual(s.sampleBytes, [1000, 3000, 2000]);

  // 再塞 498 条 → 总数 501，滚动丢 1 条最旧
  for (let i = 0; i < 498; i++) s = noteSample(s, { day: '2026-11-04', bytes: 1 });
  assert.equal(s.sampleBytes.length, DEFAULTS.CALIBRATION_SAMPLES);
  assert.equal(s.sampleBytes[0], 3000, '滚动丢弃最旧样本（1000 已被丢）');

  s = noteSample(s, { day: '2026-11-04', bytes: 7 });
  assert.equal(s.sampleBytes[s.sampleBytes.length - 1], 7, '新样本在队尾');
});

test('空标定 → not ready，missing 列全四项', () => {
  const r = buildReport({ state: createCalibrationState(), counters: { total: 0, truncatedCount: 0 } });
  assert.equal(r.ready, false);
  assert.equal(r.perDay, 0);
  assert.equal(r.p95Bytes, 0);
  assert.ok(r.missing.length >= 4, JSON.stringify(r.missing));
  assert.ok(r.missing.some((m) => m.includes('perDay')));
  assert.ok(r.missing.some((m) => m.includes('p95Bytes')));
});

test('四项齐备 → ready，且 suggested 由 §7.4 方程推出', () => {
  let s = createCalibrationState('2026-11-03');
  for (let d = 0; d < 3; d++) {
    for (let i = 0; i < 10; i++) s = noteSample(s, { day: `2026-11-0${3 + d}`, bytes: 65 * 1024 });
  }
  const r = buildReport({ state: s, counters: { total: 30, truncatedCount: 1 } });
  assert.equal(r.ready, true);
  assert.deepEqual(r.missing, []);
  assert.equal(r.days, 3);
  assert.equal(r.perDay, 10);
  assert.equal(r.p95Bytes, 65 * 1024);
  assert.ok(r.truncateRate >= 0);

  const expect = computeBudget({ perDay: 10, p95Bytes: 65 * 1024 }, { retentionDays: 90, safetyFactor: 2 });
  assert.deepEqual(r.suggested, expect);
  assert.equal(r.estimatedRetentionBytes, expect.maxBytes);
});

test('截断率：标定期用估算样本算（否则不变量 #5 门禁死锁）', () => {
  let s = createCalibrationState('2026-11-03');
  s = noteSample(s, { day: '2026-11-03', bytes: 300 * 1024, truncated: true });
  s = noteSample(s, { day: '2026-11-03', bytes: 1024 });
  s = noteSample(s, { day: '2026-11-03', bytes: 1024 });
  s = noteSample(s, { day: '2026-11-03', bytes: 1024 });
  // count-only 期 counters.total=0，但样本已能给出预测截断率
  const r = buildReport({ state: s, counters: { total: 0, truncatedCount: 0 } });
  assert.equal(r.truncateRate, 0.25);
  assert.equal(r.ready, true, 'count-only 期也必须能产出 ready 报告，否则永远切不了 live');
  // live 后：无样本时退回真实计数
  const r2 = buildReport({ state: createCalibrationState(), counters: { total: 10, truncatedCount: 5 } });
  assert.equal(r2.truncateRate, 0.5);
});

test('保留期/安全系数可配，方程随之变化', () => {
  const a = buildReport({
    state: (() => { let s = createCalibrationState('d'); s = noteSample(s, { day: 'd', bytes: 1000 }); return s; })(),
    counters: { total: 1 }, retentionDays: 30, safetyFactor: 1,
  });
  assert.equal(a.suggested.maxCount, 30);
  assert.equal(a.suggested.maxBytes, 30 * 1000);
});
