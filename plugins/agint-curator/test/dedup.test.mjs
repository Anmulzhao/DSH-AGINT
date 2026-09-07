/**
 * lib/dedup.js 单元测试 — Sprint 15 P0-2 T1 重叠检测。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { tokenize, jaccard, arrayJaccard, descSimilarity, overlapOf, detectOverlaps, recommend, OVERLAP_THRESHOLDS } from '../lib/dedup.js';

test('tokenize：中英混合 → 英文词 + 中文单字集合', () => {
  assert.deepEqual([...tokenize('Plan and 复盘')].sort(), ['and', 'plan', '复', '盘']);
  assert.equal(tokenize('').size, 0);
  assert.equal(tokenize(null).size, 0);
});

test('jaccard：|A∩B|/|A∪B|，空集 → 0', () => {
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['b', 'c'])), 1 / 3);
  assert.equal(jaccard(new Set(), new Set(['a'])), 0);
  assert.equal(arrayJaccard(['a', 'b'], ['b', 'c']), 1 / 3);
  assert.equal(arrayJaccard([], []), 0);
});

test('descSimilarity：完全相同的描述 → 1，完全不同 → 0', () => {
  assert.equal(descSimilarity('生成周报', '生成周报'), 1);
  assert.equal(descSimilarity('生成周报', '写诗'), 0);
});

test('overlapOf：三维度（描述≥0.85 / 工具≥0.7 / 触发≥0.6）与达标计数', () => {
  const a = { name: 'a', description: '生成每周工作报告并归档', triggers: ['周报', '报告'], tools: ['write', 'archive'] };
  const b = { name: 'b', description: '生成每周工作报告并归档', triggers: ['周报', '报告'], tools: ['write', 'archive'] };
  const o = overlapOf(a, b);
  assert.equal(o.desc, 1);
  assert.equal(o.tools, 1);
  assert.equal(o.triggers, 1);
  assert.equal(o.dimsMet, 3);
});

test('overlapOf：工具完全不同 → 工具维度不达标，2/3 维达标仍判重叠', () => {
  const a = { name: 'a', description: '生成每周工作报告并归档', triggers: ['周报'], tools: ['write'] };
  const b = { name: 'b', description: '生成每周工作报告并归档', triggers: ['周报'], tools: ['search'] };
  const o = overlapOf(a, b);
  assert.equal(o.descHit, true);
  assert.equal(o.toolsHit, false);
  assert.equal(o.triggersHit, true);
  assert.equal(o.dimsMet, 2);
});

test('detectOverlaps：相似对命中、无关对不命中、按维度降序', () => {
  const skills = [
    { name: 'weekly-report', description: '生成每周工作报告并归档到云盘', triggers: ['周报', '周总结'], tools: ['write', 'archive'] },
    { name: 'weekly-summary', description: '生成每周工作报告并归档到云盘', triggers: ['周报', '周总结'], tools: ['write', 'archive'] },
    { name: 'poetry', description: '写诗', triggers: ['诗'], tools: ['write'] },
  ];
  const pairs = detectOverlaps(skills);
  assert.equal(pairs.length, 1);
  assert.ok(pairs[0].skillA === 'weekly-report' && pairs[0].skillB === 'weekly-summary');
  assert.equal(pairs[0].dims.dimsMet, 3);
  assert.ok(pairs[0].recommendation.rationale.length > 0);
});

test('detectOverlaps：工具+触发 2 维达标即可判重叠（描述维文本相似但非相同）', () => {
  const skills = [
    { name: 'report-a', description: '生成每周工作报告并归档到云盘', triggers: ['周报', '周总结'], tools: ['write', 'archive'] },
    { name: 'report-b', description: '生成每周工作总结并归档到网盘', triggers: ['周报', '周总结'], tools: ['write', 'archive'] },
  ];
  const pairs = detectOverlaps(skills);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].dims.dimsMet, 2);
  assert.equal(pairs[0].dims.descHit, false); // 中文文本 Jaccard < 0.85，诚实不达标
  assert.equal(pairs[0].dims.toolsHit, true);
  assert.equal(pairs[0].dims.triggersHit, true);
});

test('detectOverlaps：includeStates 过滤（只比较指定状态）', () => {
  const skills = [
    { name: 'x1', state: 'active', description: '同一功能描述文本', triggers: ['t1'], tools: ['tool1'] },
    { name: 'x2', state: 'archived', description: '同一功能描述文本', triggers: ['t1'], tools: ['tool1'] },
  ];
  assert.equal(detectOverlaps(skills, { includeStates: ['active'] }).length, 0);
  assert.equal(detectOverlaps(skills, { includeStates: ['active', 'archived'] }).length, 1);
});

test('recommend：使用率高者被保留，使用数据相近 → review 建议', () => {
  const high = { skillName: 'hot', usage: { useCount: 100, successRate: 0.9 } };
  const low = { skillName: 'cold', usage: { useCount: 1, successRate: 0.9 } };
  const r1 = recommend(high, low);
  assert.equal(r1.keep, 'hot');
  assert.equal(r1.archive, 'cold');

  const same = { skillName: 'same', usage: { useCount: 5, successRate: 0.5 } };
  const r2 = recommend(same, { skillName: 'same2', usage: { useCount: 5, successRate: 0.5 } });
  assert.equal(r2.keep, null);
  assert.match(r2.rationale, /review/);
});

test('性能：500 技能全对比较（124,750 对）≤ 30s（验收标准）', () => {
  const skills = [];
  for (let i = 0; i < 500; i++) {
    skills.push({
      name: `skill-${i}`,
      description: `功能描述文本 ${i % 10} 号模板用于自动化处理与归档`,
      triggers: [`trigger-${i % 8}`, '通用'],
      tools: [`tool-${i % 5}`, 'write'],
    });
  }
  const t0 = Date.now();
  const pairs = detectOverlaps(skills);
  const elapsedMs = Date.now() - t0;
  assert.ok(elapsedMs < 30_000, `重叠检测耗时 ${elapsedMs}ms ≥ 30s`);
  assert.ok(Array.isArray(pairs));
  console.log(`  [perf] 500 skills → ${pairs.length} pairs in ${elapsedMs}ms`);
});

test('OVERLAP_THRESHOLDS 默认值与设计稿 §7.3 一致', () => {
  assert.equal(OVERLAP_THRESHOLDS.description, 0.85);
  assert.equal(OVERLAP_THRESHOLDS.tools, 0.7);
  assert.equal(OVERLAP_THRESHOLDS.triggers, 0.6);
  assert.equal(OVERLAP_THRESHOLDS.minDimensions, 2);
});
