// D2 回归测试（Sprint14 §2.1）：curriculum 挑战调用不得进入模式检测，
// 否则「做挑战」会被误判成可标准化的重复任务模式 → 批量产出垃圾技能候选。

import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregateTasks } from '../lib/aggregator.js';
import { isExcludedRecord, EXCLUDED_DATA_SOURCES, DATA_SOURCE_BLACKLIST_VERSION } from '../lib/schema.js';

function rec(sessionId, tool = 'file_read', extra = {}) {
  return { ts: 1_700_000_000_000, sessionId, turn: 1, step: 1, tool, ok: true, latencyMs: 10, args: {}, ...extra };
}

test('D2：curriculum- 前缀 sessionId 的记录被排除，不成任务', () => {
  const { tasks, excluded } = aggregateTasks([
    rec('curriculum-challenge-1', 'file_read'),
    rec('curriculum-challenge-1', 'file_write'),
    rec('s1', 'file_read'),
  ]);
  assert.equal(excluded, 2);
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].toolSequence, ['file_read']);
});

test('D2：只靠挑战调用重复 3 次也不会形成重复模式（防垃圾候选）', () => {
  const records = [];
  for (let i = 0; i < 3; i++) {
    records.push({ ...rec(`curriculum-c${i}`, 'file_read'), ts: 1_700_000_000_000 + i });
    records.push({ ...rec(`curriculum-c${i}`, 'file_write'), ts: 1_700_000_000_001 + i });
  }
  const { tasks, excluded } = aggregateTasks(records);
  assert.equal(excluded, 6);
  assert.equal(tasks.length, 0); // 一个模式都形不成
});

test('D2：source=curriculum 标签同样被排除（未来 tool-stats 增补字段后生效）', () => {
  assert.equal(isExcludedRecord({ sessionId: 's1', source: 'curriculum' }), true);
  const { excluded } = aggregateTasks([rec('s1', 'file_read', { source: 'curriculum' })]);
  assert.equal(excluded, 1);
});

test('D2 向后兼容：旧记录无 sessionId/source → 照常处理', () => {
  assert.equal(isExcludedRecord({ tool: 'x' }), false);
  assert.equal(isExcludedRecord({ sessionId: 's1' }), false);
  const { tasks, excluded } = aggregateTasks([rec('normal-session', 'file_read')]);
  assert.equal(excluded, 0);
  assert.equal(tasks.length, 1);
});

test('D4：本插件副本与约定一致（curator 侧测试会扫描比对）', () => {
  assert.deepEqual([...EXCLUDED_DATA_SOURCES.sessionIdPrefixes], ['curriculum-']);
  assert.deepEqual([...EXCLUDED_DATA_SOURCES.sourceTags], ['curriculum']);
  assert.equal(DATA_SOURCE_BLACKLIST_VERSION, '2026-09-14.v1');
});
