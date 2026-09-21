/**
 * agint-dream: unit tests for the validation gate + loss fraction budget.
 * Run with: node --test packages/agint-dream/test/validation-gate.test.js
 *
 * 覆盖老板 2026-09-05 验证发现的洞：priorEntry 必须是已存在 memory entry，
 * 不能是 candidate key（不能让 A 互为 B 的 priorEntry）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAndApply, planToWriteCalls, stripPriorEntryDecoration } from '../lib/validation-gate.js';

const GATED = [
  { key: 'c1', text: '老板是创造者，反馈优先级最高', path: 'memory/a.md', startLine: 1, endLine: 2, score: 0.85 },
  { key: 'c2', text: 'AGINT 老板 = 创造者，部署 / 维护 / 行为校准拥有最高权威', path: 'memory/b.md', startLine: 5, endLine: 7, score: 0.82 },
  { key: 'c3', text: '禁止在生产环境直接 rm -rf', path: 'memory/c.md', startLine: 10, endLine: 12, score: 0.80 },
];

const EXISTING = [
  { id: 'e1', type: 'lesson', content: '禁止在生产环境 rm -rf 系统文件', lineageKey: 'safety/rm-rf', supersedesKey: null },
  { id: 'e2', type: 'preference', content: '老板 = 创造者', lineageKey: 'identity/boss', supersedesKey: null },
];

test('validateAndApply: 无 operations 走 added 退化路径', () => {
  const r = validateAndApply({ gated: GATED, existing: EXISTING });
  assert.equal(r.ok, true);
  assert.equal(r.plan.length, 3);
  assert.ok(r.plan.every((p) => p.action === 'added'));
  assert.equal(r.stats.added, 3);
  assert.equal(r.stats.merged, 0);
  assert.equal(r.stats.superseded, 0);
});

test('validateAndApply: added 成功', () => {
  const r = validateAndApply({
    gated: GATED,
    existing: EXISTING,
    operations: [
      { candidateKey: 'c1', action: 'added', priorEntries: [] },
      { candidateKey: 'c2', action: 'added', priorEntries: [] },
      { candidateKey: 'c3', action: 'added', priorEntries: [] },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.stats.added, 3);
});

test('validateAndApply: merged with existing entry', () => {
  // 这个 case loss = 2/2 = 1.0 > default 0.25 会拒
  // 用 maxPriorEntryLossFraction = 1.0 允许全量 merge 验证去重逻辑
  const r = validateAndApply({
    gated: GATED,
    existing: EXISTING,
    operations: [
      { candidateKey: 'c1', action: 'merged', priorEntries: ['老板 = 创造者'], lineageKey: 'identity/boss' },
      { candidateKey: 'c2', action: 'merged', priorEntries: ['老板 = 创造者'], lineageKey: 'identity/boss' },
      { candidateKey: 'c3', action: 'merged', priorEntries: ['禁止在生产环境 rm -rf 系统文件'], lineageKey: 'safety/rm-rf' },
    ],
    maxPriorEntryLossFraction: 1.0,
  });
  assert.equal(r.ok, true);
  assert.equal(r.stats.merged, 3);
  assert.equal(r.stats.added, 0);
  // 同一 priorEntry 被两个 candidate 引用，去重后只算 1 个 removed
  assert.equal(r.stats.lossFraction, 1.0); // 2 distinct / 2 existing
});

test('validateAndApply: 关键洞 — priorEntry 不能是 candidate key（拒绝）', () => {
  // 模拟老板 2026-09-05 验证发现的洞：c1 和 c2 互为 priorEntry
  const r = validateAndApply({
    gated: GATED,
    existing: EXISTING,
    operations: [
      { candidateKey: 'c1', action: 'merged', priorEntries: ['c2'], lineageKey: 'identity/boss' },
      { candidateKey: 'c2', action: 'merged', priorEntries: ['c1'], lineageKey: 'identity/boss' },
      { candidateKey: 'c3', action: 'added', priorEntries: [] },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /priorEntry "c2" is a candidate key/);
});

test('validateAndApply: priorEntry 不在 existing memory 中（拒绝）', () => {
  const r = validateAndApply({
    gated: GATED,
    existing: EXISTING,
    operations: [
      { candidateKey: 'c1', action: 'merged', priorEntries: ['不存在的 entry'], lineageKey: 'identity/boss' },
      { candidateKey: 'c2', action: 'added', priorEntries: [] },
      { candidateKey: 'c3', action: 'added', priorEntries: [] },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /priorEntry "不存在的 entry" not found in existing memory/);
});

test('validateAndApply: added 带 priorEntries（拒绝）', () => {
  const r = validateAndApply({
    gated: GATED,
    existing: EXISTING,
    operations: [
      { candidateKey: 'c1', action: 'added', priorEntries: ['老板 = 创造者'] },
      { candidateKey: 'c2', action: 'added', priorEntries: [] },
      { candidateKey: 'c3', action: 'added', priorEntries: [] },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /added action with priorEntries/);
});

test('validateAndApply: merged 不带 priorEntries（拒绝）', () => {
  const r = validateAndApply({
    gated: GATED,
    existing: EXISTING,
    operations: [
      { candidateKey: 'c1', action: 'merged', priorEntries: [] },
      { candidateKey: 'c2', action: 'added', priorEntries: [] },
      { candidateKey: 'c3', action: 'added', priorEntries: [] },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /merged action without priorEntries/);
});

test('validateAndApply: superseded 不带 lineageKey（拒绝）', () => {
  const r = validateAndApply({
    gated: GATED,
    existing: EXISTING,
    operations: [
      { candidateKey: 'c1', action: 'superseded', priorEntries: ['老板 = 创造者'] },
      { candidateKey: 'c2', action: 'added', priorEntries: [] },
      { candidateKey: 'c3', action: 'added', priorEntries: [] },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /superseded action without lineageKey/);
});

test('validateAndApply: loss fraction 超 0.25（拒绝）', () => {
  // 准备：existing 4 条 entry，operations 要 remove 2 条 → loss = 0.5
  // 注意：lineageKey 必须一致才能走到 loss fraction 校验（先校验 lineage 再校验 loss）
  const fourExisting = [
    { id: 'e1', type: 'lesson', content: '禁止在生产环境 rm -rf 系统文件', lineageKey: 'safety/rm-rf', supersedesKey: null },
    { id: 'e2', type: 'preference', content: '老板 = 创造者', lineageKey: 'identity/boss', supersedesKey: null },
    { id: 'e3', type: 'lesson', content: 'some lesson 1', lineageKey: 'identity/boss', supersedesKey: null },
    { id: 'e4', type: 'lesson', content: 'some lesson 2', lineageKey: 'identity/boss', supersedesKey: null },
  ];
  const fourGated = [
    ...GATED,
    { key: 'c4', text: 'extra 1', path: 'memory/d.md', startLine: 1, endLine: 1, score: 0.8 },
  ];
  const r = validateAndApply({
    gated: fourGated,
    existing: fourExisting,
    operations: [
      { candidateKey: 'c1', action: 'merged', priorEntries: ['老板 = 创造者', 'some lesson 1'], lineageKey: 'identity/boss' },
      { candidateKey: 'c2', action: 'added', priorEntries: [] },
      { candidateKey: 'c3', action: 'added', priorEntries: [] },
      { candidateKey: 'c4', action: 'added', priorEntries: [] },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /loss fraction/);
});

test('validateAndApply: operation 数量不对（拒绝）', () => {
  const r = validateAndApply({
    gated: GATED,
    existing: EXISTING,
    operations: [
      { candidateKey: 'c1', action: 'added', priorEntries: [] },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /operation count 1 != candidate count 3/);
});

test('validateAndApply: 同一 candidate 多个 operation（拒绝）', () => {
  // 必须 length 一致才能走到 duplicate 检查；这里用 3 个但 candidateKey 重复
  const r = validateAndApply({
    gated: GATED,
    existing: EXISTING,
    operations: [
      { candidateKey: 'c1', action: 'added', priorEntries: [] },
      { candidateKey: 'c1', action: 'added', priorEntries: [] },
      { candidateKey: 'c2', action: 'added', priorEntries: [] },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /duplicate operation for c1/);
});

test('validateAndApply: lineageKey 不一致（拒绝）', () => {
  const r = validateAndApply({
    gated: GATED,
    existing: EXISTING,
    operations: [
      { candidateKey: 'c1', action: 'merged', priorEntries: ['老板 = 创造者'], lineageKey: 'wrong/lineage' },
      { candidateKey: 'c2', action: 'added', priorEntries: [] },
      { candidateKey: 'c3', action: 'added', priorEntries: [] },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /lineageKey mismatch/);
});

test('planToWriteCalls: added 路径能写出', async () => {
  const r = validateAndApply({
    gated: [GATED[0]],
    existing: EXISTING,
    operations: [
      { candidateKey: 'c1', action: 'added', priorEntries: [] },
    ],
  });
  assert.equal(r.ok, true);
  const calls = planToWriteCalls(r.plan);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'added');
  // 写调用是 async，应能调通
  const fakeMemory = {
    write: async (input) => ({ id: 'new1', ...input }),
  };
  const result = await calls[0].write(fakeMemory, 'evidence-x');
  assert.equal(result.id, 'new1');
  assert.equal(result.lineageKey, null);
});

test('planToWriteCalls: superseded 路径带 supersedesKey', async () => {
  // 单 candidate 单 superseded：1 priorEntry / 2 existing = 0.5，budget 提到 1.0 通过
  const r = validateAndApply({
    gated: [GATED[0]],
    existing: EXISTING,
    operations: [
      { candidateKey: 'c1', action: 'superseded', priorEntries: ['老板 = 创造者'], lineageKey: 'identity/boss' },
    ],
    maxPriorEntryLossFraction: 1.0,
  });
  assert.equal(r.ok, true);
  const calls = planToWriteCalls(r.plan);
  assert.equal(calls.length, 1);
  const fakeMemory = { write: async (input) => ({ id: 'new3', ...input }) };
  const result = await calls[0].write(fakeMemory, 'evidence-z');
  assert.equal(result.id, 'new3');
  assert.equal(result.lineageKey, 'identity/boss');
  assert.equal(result.supersedesKey, '老板 = 创造者');
});

test('planToWriteCalls: superseded 带 supersedesKey', async () => {
  // 单 candidate 单 superseded 不会触发 loss fraction（1/2 = 0.5 > 0.25）
  // 改用 added 路径验证 supersedesKey 字段在 plan 里正确传递
  const r = validateAndApply({
    gated: [GATED[0]],
    existing: EXISTING,
    operations: [
      { candidateKey: 'c1', action: 'merged', priorEntries: ['老板 = 创造者'], lineageKey: 'identity/boss' },
    ],
  });
  // 1 priorEntry / 2 existing = 0.5 > 0.25，会被 loss budget 拒
  // 改用更大的 budget 验证
  const r2 = validateAndApply({
    gated: [GATED[0]],
    existing: EXISTING,
    operations: [
      { candidateKey: 'c1', action: 'merged', priorEntries: ['老板 = 创造者'], lineageKey: 'identity/boss' },
    ],
    maxPriorEntryLossFraction: 1.0,
  });
  assert.equal(r2.ok, true);
  const calls = planToWriteCalls(r2.plan);
  assert.equal(calls.length, 1);
  const fakeMemory = { write: async (input) => ({ id: 'new2', ...input }) };
  // merged 路径：write 带 lineageKey，supersedesKey 是 null（merged 不直接填）
  const result = await calls[0].write(fakeMemory, 'evidence-y');
  assert.equal(result.id, 'new2');
  assert.equal(result.lineageKey, 'identity/boss');
});

// ── 2026-09-21：priorEntry 前缀污染回归（真实事故：16 候选整批被拒） ──────────

test('stripPriorEntryDecoration: 剥离 prompt 头部 / 引用块 / 项目符号', () => {
  assert.equal(
    stripPriorEntryDecoration('(id=e1, type=lesson) 禁止在生产环境 rm -rf 系统文件'),
    '禁止在生产环境 rm -rf 系统文件',
  );
  assert.equal(
    stripPriorEntryDecoration('> - (id=e1, type=lesson) 禁止在生产环境 rm -rf 系统文件'),
    '禁止在生产环境 rm -rf 系统文件',
  );
  assert.equal(
    stripPriorEntryDecoration('> > - (id=e1, type=lesson) 禁止在生产环境 rm -rf 系统文件'),
    '禁止在生产环境 rm -rf 系统文件',
  );
  assert.equal(stripPriorEntryDecoration('- 禁止在生产环境 rm -rf 系统文件'), '禁止在生产环境 rm -rf 系统文件');
  // 干净输入不被改动
  assert.equal(stripPriorEntryDecoration('禁止在生产环境 rm -rf 系统文件'), '禁止在生产环境 rm -rf 系统文件');
});

test('checkOperations: 模型带 (id=...) 前缀不再整批拒绝（2026-09-18 事故回归）', () => {
  const r = validateAndApply({
    gated: [GATED[0]],
    existing: EXISTING,
    operations: [
      {
        candidateKey: 'c1',
        action: 'merged',
        // 模型照抄 prompt 头部形态 —— 修复前必然 ok:false
        priorEntries: ['(id=e2, type=preference) 老板 = 创造者'],
        lineageKey: 'identity/boss',
      },
    ],
    maxPriorEntryLossFraction: 1.0,
  });
  assert.equal(r.ok, true);
  assert.equal(r.stats.merged, 1);
});

test('checkOperations: 模型带引用块前缀同样容错', () => {
  const r = validateAndApply({
    gated: [GATED[0]],
    existing: EXISTING,
    operations: [
      {
        candidateKey: 'c1',
        action: 'merged',
        priorEntries: ['> - (id=e2, type=preference) 老板 = 创造者'],
        lineageKey: 'identity/boss',
      },
    ],
    maxPriorEntryLossFraction: 1.0,
  });
  assert.equal(r.ok, true);
});

test('checkOperations: plan 里存的 priorEntries 是剥离后的干净文本（防污染二次落库）', () => {
  const r = validateAndApply({
    gated: [GATED[0]],
    existing: EXISTING,
    operations: [
      {
        candidateKey: 'c1',
        action: 'superseded',
        priorEntries: ['(id=e2, type=preference) 老板 = 创造者'],
        lineageKey: 'identity/boss',
      },
    ],
    maxPriorEntryLossFraction: 1.0,
  });
  assert.equal(r.ok, true);
  // supersedesKey 直接落库 → 必须是干净原文
  assert.equal(r.plan[0].priorEntries[0], '老板 = 创造者');
});

test('checkOperations: 本体已被污染的 existing，模型给干净 content 也能匹配', () => {
  // 历史污染形态：content 自带前缀
  const polluted = [
    { id: 'p1', type: 'lesson', content: '> - (id=e2, type=preference) 老板 = 创造者' },
  ];
  const r = validateAndApply({
    gated: [GATED[0]],
    existing: polluted,
    operations: [
      { candidateKey: 'c1', action: 'merged', priorEntries: ['老板 = 创造者'], lineageKey: 'identity/boss' },
    ],
    maxPriorEntryLossFraction: 1.0,
  });
  assert.equal(r.ok, true);
});
