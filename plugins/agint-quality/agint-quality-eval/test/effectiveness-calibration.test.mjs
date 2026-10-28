/**
 * effectiveness 维度 × 判读校准（v0.3）。
 *
 * 守三件事：
 *   1. **别的插件不受影响** —— calibration 只对判读类 target 生效（阴性对照）
 *   2. **有样本时准确率真的进分**（否则这套仪器等于没接）
 *   3. **样本不足时不并入**（1 个样本就能把分数拽到 0 或 1，比不给分更糟）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { evalEffectiveness } from '../lib/evaluators.js';

/** 最小 ctx：只实现被测代码用到的 get */
function makeCtx({ toolStats = null, calibration = null, calibrationThrows = false } = {}) {
  const services = {
    'agint.toolStats': toolStats,
    'agint.upstreamWatch': calibration === null && !calibrationThrows
      ? undefined
      : {
        calibration: async () => {
          if (calibrationThrows) throw new Error('boom');
          return calibration;
        },
      },
  };
  return { get: (k) => services[k] };
}

const stats = (calls) => ({ summary: async () => ({ items: [{ tool: 'agint-upstream-watch', calls, avgLatencyMs: 100 }] }) });

test('非判读类 target 完全不读校准（阴性对照）', async () => {
  const ctx = makeCtx({
    toolStats: { summary: async () => ({ items: [{ tool: 'agint-evolve', calls: 50, avgLatencyMs: 100 }] }) },
    calibration: { packagesChecked: 10, counts: { falseNegative: 9 }, falseNegativeRate: 0.9 },
  });
  const r = await evalEffectiveness(ctx, { id: 'agint-evolve' });
  // 0.5 usage × ~0.994 speed
  assert.ok(r.score > 0.45 && r.score < 0.55, `不该被校准影响，实得 ${r.score}`);
  assert.equal(r.raw.calibration, undefined);
});

test('有 >=3 个样本时误报/漏报真的压低分数', async () => {
  const clean = await evalEffectiveness(makeCtx({
    toolStats: stats(50),
    calibration: { packagesChecked: 10, counts: { falseNegative: 0, falsePositive: 0 }, falsePositiveRate: 0, falseNegativeRate: 0 },
  }), { id: 'agint-upstream-watch' });

  const dirty = await evalEffectiveness(makeCtx({
    toolStats: stats(50),
    calibration: { packagesChecked: 10, counts: { falseNegative: 5, falsePositive: 0 }, falsePositiveRate: 0, falseNegativeRate: 0.5 },
  }), { id: 'agint-upstream-watch' });

  assert.ok(dirty.score < clean.score, `漏报 50% 必须比零错误低（${dirty.score} vs ${clean.score}）`);
  assert.ok(dirty.findings.some((f) => f.severity === 'warn' && /漏报/.test(f.message)), '漏报要出 warn');
  assert.equal(dirty.raw.calibration.packagesChecked, 10);
});

test('样本 <3 时不并入，并说明原因', async () => {
  const r = await evalEffectiveness(makeCtx({
    toolStats: stats(50),
    calibration: { packagesChecked: 1, counts: { falseNegative: 1 }, falseNegativeRate: 1 },
  }), { id: 'agint-upstream-watch' });
  assert.ok(r.score > 0.45, `一个样本不该把分数拽到 0，实得 ${r.score}`);
  assert.ok(r.findings.some((f) => /样本不足/.test(f.message)));
});

test('没有校准出口（插件未装）⇒ 行为与 v0.2 一致，不报错', async () => {
  const r = await evalEffectiveness(makeCtx({ toolStats: stats(50) }), { id: 'agint-upstream-watch' });
  assert.ok(r.score > 0.45 && r.score < 0.55);
  assert.equal(r.findings.filter((f) => f.severity === 'warn').length, 0);
});

test('calibration() 抛错 ⇒ 只记 info，不污染分数', async () => {
  const r = await evalEffectiveness(makeCtx({ toolStats: stats(50), calibrationThrows: true }), { id: 'agint-upstream-watch' });
  assert.ok(r.score > 0.45 && r.score < 0.55);
  assert.ok(r.findings.some((f) => f.severity === 'info' && /calibration\(\) 失败/.test(f.message)));
});

test('无用工具记录但有真值样本 ⇒ 用准确率兜底，不返回 null', async () => {
  const r = await evalEffectiveness(makeCtx({
    toolStats: { summary: async () => ({ items: [] }) },
    calibration: { packagesChecked: 5, counts: { falseNegative: 0, falsePositive: 0 }, falsePositiveRate: 0, falseNegativeRate: 0 },
  }), { id: 'agint-upstream-watch' });
  assert.equal(r.score, 1, '5 个包全对 ⇒ 1.0');
  assert.equal(r.raw.basis, 'calibration-only');
});
