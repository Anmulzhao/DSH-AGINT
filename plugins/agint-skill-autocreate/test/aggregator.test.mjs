// aggregator 单元测试：JSONL 记录 → 任务实例聚合 + 参数签名。
// 零 I/O：纯函数。

import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregateTasks, signatureOf, filterWindow } from '../lib/aggregator.js';

function rec(tool, { ts = 1000, sessionId = 's1', turn = 1, ok = true, latencyMs = 100, args = {} } = {}) {
  return { ts, sessionId, turn, tool, ok, latencyMs, args };
}

test('同一 (sessionId, turn) 内的连续调用聚成一个任务实例', () => {
  const { tasks, unmatched } = aggregateTasks([
    rec('terminal', { ts: 100 }),
    rec('file_read', { ts: 200 }),
    rec('file_write', { ts: 300 }),
    rec('terminal', { ts: 400, turn: 2 }), // 换 turn → 新任务
  ]);
  assert.equal(tasks.length, 2);
  assert.equal(unmatched, 0);
  assert.deepEqual(tasks[0].toolSequence, ['terminal', 'file_read', 'file_write']);
  assert.deepEqual(tasks[1].toolSequence, ['terminal']);
});

test('sessionId 与 turn 都缺失的记录计入 unmatched', () => {
  const { tasks, unmatched } = aggregateTasks([
    { ts: 1, tool: 'terminal', ok: true }, // 无 sessionId 无 turn
    rec('terminal', { ts: 2 }),
  ]);
  assert.equal(unmatched, 1);
  assert.equal(tasks.length, 1);
});

test('特征提取：签名/成功率/耗时', () => {
  const { tasks } = aggregateTasks([
    rec('terminal', { ts: 100, ok: true, latencyMs: 50, args: { command: 'ls -la' } }),
    rec('file_read', { ts: 200, ok: false, latencyMs: 150, args: { path: 'a/b.md' } }),
  ]);
  const t = tasks[0];
  assert.equal(t.toolCount, 2);
  assert.equal(t.successRate, 0.5);
  assert.equal(t.durationMs, 200);
  assert.equal(t.paramSignature.terminal, signatureOf({ command: 'ls -la' }));
  assert.equal(t.paramSignature.file_read, 'path:str:md');
  assert.deepEqual(t.sampleArgs.file_read, { path: 'a/b.md' });
});

test('signatureOf：形状相同 → 签名相同；扩展名参与签名', () => {
  assert.equal(signatureOf({ path: 'x/y.md' }), signatureOf({ path: 'other.md' }));
  assert.notEqual(signatureOf({ path: 'x/y.md' }), signatureOf({ path: 'x/y.js' }));
  assert.equal(signatureOf({ a: 1, b: 'x' }), signatureOf({ b: 'y', a: 2 })); // key 排序
  assert.equal(signatureOf({}), 'empty');
  assert.equal(signatureOf(null), 'none');
});

test('工具数超过 30 的探索性任务被跳过', () => {
  const many = Array.from({ length: 31 }, (_, i) => rec('terminal', { ts: 1000 + i }));
  const { tasks } = aggregateTasks(many);
  assert.equal(tasks.length, 0);
});

test('filterWindow：只保留窗口内记录', () => {
  const now = 10_000_000;
  const records = [
    { ts: now - 25 * 3600_000, tool: 'a' },
    { ts: now - 1 * 3600_000, tool: 'b' },
  ];
  const kept = filterWindow(records, 24, now);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].tool, 'b');
});
