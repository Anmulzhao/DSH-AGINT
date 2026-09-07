// detector 单元测试：序列匹配 + 参数相似度 + 重复计数 + 增量累计。

import test from 'node:test';
import assert from 'node:assert/strict';

import { detectPatterns, paramSimilarity, sequenceEqual } from '../lib/detector.js';

function task(toolSequence, paramSignature, extra = {}) {
  return {
    id: 't',
    toolSequence,
    paramSignature,
    description: toolSequence.join(' → '),
    durationMs: 100,
    successRate: 1,
    sampleArgs: {},
    ...extra,
  };
}

test('sequenceEqual：严格全等', () => {
  assert.equal(sequenceEqual(['a', 'b'], ['a', 'b']), true);
  assert.equal(sequenceEqual(['a', 'b'], ['b', 'a']), false);
  assert.equal(sequenceEqual(['a'], ['a', 'b']), false);
});

test('paramSimilarity：同形高分，异形低分', () => {
  const a = { file_read: 'path:str:.md', file_write: 'path:str:.md' };
  const b = { file_read: 'path:str:.md', file_write: 'path:str:.js' };
  const c = { terminal: 'command:str' };
  assert.equal(paramSimilarity(a, a), 1);
  // 仅一个工具的扩展名不同 → 0.75，低于 0.8 阈值（扩展名是有意义的任务差异）
  assert.equal(paramSimilarity(a, b), 0.75);
  assert.equal(paramSimilarity(a, c), 0);   // 无共有工具
});

test('同一批内相同形态任务合并累计，跨阈值触发 newRepeat', () => {
  const mk = () => task(['file_read', 'file_write'], { file_read: 'path:str:.md', file_write: 'path:str:.md' });
  const { upserts, newRepeat } = detectPatterns([mk(), mk(), mk()], { minOccurrence: 3 });
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].occurrenceCount, 3);
  assert.equal(newRepeat.length, 1);
});

test('阈值未到不触发 newRepeat', () => {
  const mk = () => task(['file_read', 'file_write'], { file_read: 'path:str:.md', file_write: 'path:str:.md' });
  const { newRepeat } = detectPatterns([mk(), mk()], { minOccurrence: 3 });
  assert.equal(newRepeat.length, 0);
});

test('与已有 pattern 增量累计：occurrence 递增 + 统计滚动 + firstSeen 保留', () => {
  const mk = () => task(['file_read', 'file_write'], { file_read: 'path:str:.md', file_write: 'path:str:.md' }, { durationMs: 200, successRate: 0.5 });
  const existing = [{
    ...mk(),
    id: 'tp_1',
    occurrenceCount: 2,
    firstSeenAt: '2026-09-01T00:00:00Z',
    lastSeenAt: '2026-09-02T00:00:00Z',
    avgDurationMs: 100,
    status: 'active',
  }];
  const { upserts, newRepeat } = detectPatterns([mk()], { existingPatterns: existing, minOccurrence: 3 });
  assert.equal(newRepeat.length, 1); // 2+1=3 跨阈值
  assert.equal(upserts.length, 1);
  const p = upserts[0];
  assert.equal(p.id, 'tp_1');
  assert.equal(p.occurrenceCount, 3);
  assert.equal(p.firstSeenAt, '2026-09-01T00:00:00Z');
  // 均值滚动：(100*2 + 200) / 3 = 133
  assert.equal(p.avgDurationMs, 133);
});

test('参数相似度低于阈值 → 视为不同模式', () => {
  const mkA = () => task(['terminal'], { terminal: 'command:str' });
  const mkB = () => task(['terminal'], { terminal: 'path:str:.env' });
  const { upserts } = detectPatterns([mkA(), mkA(), mkB()], { minOccurrence: 3 });
  // A 两次不成模式；B 一次 → 两个独立 pattern，均未跨阈值
  assert.equal(upserts.length, 2);
});
