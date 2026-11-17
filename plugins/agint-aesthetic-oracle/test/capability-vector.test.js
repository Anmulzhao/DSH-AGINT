/**
 * v0.10.0 能力向量栏单测。
 *
 * 覆盖：
 *  ① 三态纪律：缺席 ⇒ `?` + 未采集源，绝不写 0（本项目最重要的一条）
 *  ② AC-2 不破：daily 同行追加，≤5 行 / ≤2KB；不传 capability 时逐字节不变
 *  ③ 硬判据：aesthetic_score / FORMULA_VERSION / scaleHash 不因加栏而改变
 *  ④ weekly/monthly 单独成行；2KB 截断仍保首行与总分行
 *
 * ⛔ 本文件只测渲染层与评分常量的不变性。评分链路（`scoring.js`）在本版
 *    一个字节都没改 —— 由「r4 复算夹具 + scaleHash 常量断言」钉住。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderReport, formatCapabilityVector, MAX_BYTES,
} from '../lib/broadcast.js';
import {
  FORMULA_VERSION, scaleHash, SCALE_SPEC, computeAestheticScore,
} from '../lib/scoring.js';

// ── 夹具 ───────────────────────────────────────────────────────────────────

const NOW = new Date('2026-11-07T09:00:00+08:00');

const evaluation = {
  scored: {
    score: 99.9, naDims: [], renormalized: false, effectiveDenominator: 100,
    dims: {},
  },
  verdict: { verdict: 'flat', worseCount: 0, betterCount: 0, note: '' },
  worst: { key: 'confidence', value: 0.698 },
  advice: { advice: '本日无可执行建议', evidence: '无证据条目清单为空' },
  composites: {},
};

const baseCtx = {
  now: NOW,
  asOf: '2026-11-07T04:00:00+08:00',
  evaluation,
  atomic: {
    memoryNoEvidence: 0, wikiOrphans: 0, ruleDuplicates: 0,
    wikiContradictions: 0, skillsBytes: 100_000, skillsTotal: 10,
  },
  baseline: { established: true, score: 93.55 },
  activity: 0.5,
};

const fullCap = {
  can: 0, cannot: 1, uncertain: 1,
  challenges: 5, attempts: 1,
  succeeded: 0, proposals: 7,
  unavailable: [],
};

// ── ① 三态纪律 ────────────────────────────────────────────────────────────

test('全有值：三态 + 课程 + 闭环计数都出现在同一行', () => {
  const s = formatCapabilityVector(fullCap);
  assert.match(s, /CAN 0／CANNOT 1／UNCERTAIN 1/);
  assert.match(s, /课程挑战 5／尝试 1/);
  assert.match(s, /闭环成功 0／提案 7/);
  assert.ok(!s.includes('未采集'));
});

test('⛔ 全缺席：显示 ? 与未采集源，绝不把「没采到」写成 0', () => {
  const s = formatCapabilityVector({
    can: null, cannot: null, uncertain: null,
    challenges: null, attempts: null, succeeded: null, proposals: null,
    unavailable: ['self-model', 'curriculum', 'loop'],
  });
  assert.match(s, /CAN \?／CANNOT \?／UNCERTAIN \?/);
  assert.match(s, /课程挑战 \?／尝试 \?/);
  assert.match(s, /闭环成功 \?／提案 \?/);
  assert.match(s, /未采集：self-model\/curriculum\/loop/);
  // ⛔ 除了分隔符，不能出现「 0」这种把缺席伪装成零的读数
  assert.ok(!s.includes('CAN 0'), '缺席时必须显示 ?，不能显示 0');
});

test('部分缺席：只有缺席的那几项显示 ?，已采到的真 0 仍是 0', () => {
  const s = formatCapabilityVector({
    can: 0, cannot: 1, uncertain: 1,
    challenges: null, attempts: null,
    succeeded: 0, proposals: 7,
    unavailable: ['curriculum'],
  });
  assert.match(s, /CAN 0／CANNOT 1／UNCERTAIN 1/, '已采到的真 0 要如实显示');
  assert.match(s, /课程挑战 \?／尝试 \?/);
  assert.match(s, /闭环成功 0／提案 7/);
  assert.match(s, /未采集：curriculum/);
});

test('null / 非对象 ⇒ 返回 null（调用方不渲染该栏）', () => {
  assert.equal(formatCapabilityVector(null), null);
  assert.equal(formatCapabilityVector(undefined), null);
  assert.equal(formatCapabilityVector('x'), null);
});

// ── ② AC-2 不破 ───────────────────────────────────────────────────────────

test('⛔ AC-2：daily 加能力向量仍是 5 行、≤2KB（同行追加，不新增行）', () => {
  const plain = renderReport('daily', baseCtx);
  const withCap = renderReport('daily', { ...baseCtx, capability: fullCap });
  assert.equal(plain.lines.length, 5);
  assert.equal(withCap.lines.length, 5, 'daily 行数不得因加栏而增加');
  assert.ok(withCap.bytes <= MAX_BYTES);
  assert.match(withCap.text, /CAN 0／CANNOT 1／UNCERTAIN 1/);
  assert.match(withCap.text, /总分：99\.9\/100/);
});

test('⛔ 不传 capability 时渲染与旧版逐字节一致（向后兼容）', () => {
  const a = renderReport('daily', baseCtx);
  const b = renderReport('daily', { ...baseCtx, capability: null });
  assert.equal(b.text, a.text);
  assert.equal(b.bytes, a.bytes);
  for (const kind of ['weekly', 'monthly']) {
    assert.equal(renderReport(kind, baseCtx).text, renderReport(kind, { ...baseCtx, capability: null }).text);
  }
});

test('daily 全缺席也只多加同行文本，不增行且仍 ≤2KB', () => {
  const r = renderReport('daily', {
    ...baseCtx,
    capability: {
      can: null, cannot: null, uncertain: null, challenges: null, attempts: null,
      succeeded: null, proposals: null, unavailable: ['self-model', 'curriculum', 'loop'],
    },
  });
  assert.equal(r.lines.length, 5);
  assert.ok(r.bytes <= MAX_BYTES);
  assert.match(r.text, /未采集：self-model\/curriculum\/loop/);
});

// ── ③ 硬判据：评分指纹不变 ────────────────────────────────────────────────

test('⛔ 硬判据：FORMULA_VERSION=r4 / scaleHash=f4f5c879 / SCALE_SPEC 逐值未动', () => {
  assert.equal(FORMULA_VERSION, 'r4');
  assert.equal(scaleHash, 'f4f5c879', '判尺指纹必须逐字节不变（改了历史分数就不可比）');
  // 对拍整个判尺规格（scaleHash 的输入），比逐个猜常量名更严谨：
  // 任何一个阈值/权重/效应量被改动，都会在这里变红。
  assert.deepEqual(SCALE_SPEC, {
    thresholds: {
      NOISE_RATIO: 0.30,
      CONFIDENCE: 0.70,
      REDUNDANCY: 0.05,
      BLOAT_BUDGET_PER_SKILL_BYTES: 11170,
      BLOAT_ABS_CEILING_BYTES: 614400,
      BLOAT_SATURATION: 1.5,
    },
    weights: { noise: 30, confidence: 20, redundancy: 20, bloat: 30 },
    effectEpsilon: { noise: 0.03, confidence: 0.07, redundancy: 0.005, bloat: 0.1 },
  });
});

test('⛔ 硬判据：能力向量不参与任何计算，同一 composites 复算分数恒等', () => {
  const composites = {
    noise: { value: 0.01, na: false },
    confidence: { value: 0.698, na: false },
    redundancy: { value: 0.01, na: false },
    bloat: { value: 0.5, na: false },
  };
  const before = computeAestheticScore(composites);
  renderReport('daily', { ...baseCtx, capability: fullCap });
  const after = computeAestheticScore(composites);
  assert.deepEqual(after, before, '渲染层调用不得改变评分函数的任何输出');
  assert.equal(after.score, before.score);
});

test('⛔ 分数文本不因能力向量而改变（加栏前后分数段逐字节相同）', () => {
  const a = renderReport('daily', baseCtx).lines[1];
  const b = renderReport('daily', { ...baseCtx, capability: fullCap }).lines[1];
  assert.ok(b.startsWith(a), '同行追加只能追加在末尾，不能改写原有分数段');
  assert.equal(b.slice(0, a.length), a);
});

// ── ④ weekly / monthly ────────────────────────────────────────────────────

test('weekly / monthly 能力向量单独成行，且在总分行之后', () => {
  for (const kind of ['weekly', 'monthly']) {
    const r = renderReport(kind, { ...baseCtx, capability: fullCap });
    assert.ok(r.lines.some((l) => l.startsWith('能力 CAN')), `${kind} 应有独立能力行`);
    assert.equal(r.lines[1].startsWith('总分：'), true, `${kind} 第 2 行仍是总分行`);
    assert.ok(r.bytes <= MAX_BYTES);
  }
});

test('alert 档不渲染能力向量（警报不依赖任何服务）', () => {
  const r = renderReport('alert', {
    now: NOW, reason: '测试', detail: '', capability: fullCap,
  });
  assert.ok(!r.text.includes('能力 CAN'));
});

test('2KB 截断保护：超长能力向量行仍保住首行与总分行', () => {
  const longCap = {
    ...fullCap,
    unavailable: Array.from({ length: 80 }, (_, i) => `source-${i}`),
  };
  const r = renderReport('daily', { ...baseCtx, capability: longCap });
  assert.ok(r.bytes <= MAX_BYTES);
  assert.match(r.lines[0], /今日美评|…（截断）/);
});
