// detector 单元测试：序列匹配 + 参数相似度 + 重复计数 + 增量累计 + 成功率准入门。

import test from 'node:test';
import assert from 'node:assert/strict';

import { detectPatterns, paramSimilarity, sequenceEqual, passesSuccessGate } from '../lib/detector.js';

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
  // 本例测的是「统计滚动」，不是成功率门 → 显式关掉该门（minSuccessRate: 0），
  // 否则 successRate 0.5 会被默认门（0.6）拦下，与本例意图无关。
  const { upserts, newRepeat } = detectPatterns([mk()], {
    existingPatterns: existing, minOccurrence: 3, minSuccessRate: 0,
  });
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

// ── 成功率准入门（2026-09-13；Hermes 对照 §六ter 建议 B）────────────────
// 次数门槛只证明「经常发生」，不证明「做对了」：稳定失败的序列重复 3 次
// 同样跨过 minOccurrence，而它恰是最不该被沉淀成技能的东西。

const SEQ = ['file_read', 'file_write'];
const SIG = { file_read: 'path:str:.md', file_write: 'path:str:.md' };
const mkTask = (sr) => task(SEQ, SIG, { successRate: sr });

test('成功率低于准入门：跨过次数门槛但不进 newRepeat（仍入库 + 进 blockedBySuccessRate）', () => {
  const { upserts, newRepeat, blockedBySuccessRate } =
    detectPatterns([mkTask(0), mkTask(0), mkTask(0)], { minOccurrence: 3 });
  assert.equal(upserts.length, 1);              // 仍入库 → 可观测
  assert.equal(upserts[0].occurrenceCount, 3);
  assert.equal(newRepeat.length, 0);            // 但不成候选
  assert.equal(blockedBySuccessRate.length, 1); // 且明确留痕
  assert.equal(blockedBySuccessRate[0].successRate, 0);
});

test('成功率达标：正常进 newRepeat，blocked 为空', () => {
  const { newRepeat, blockedBySuccessRate } =
    detectPatterns([mkTask(0.8), mkTask(0.8), mkTask(0.8)], { minOccurrence: 3 });
  assert.equal(newRepeat.length, 1);
  assert.equal(blockedBySuccessRate.length, 0);
});

test('成功率恰好等于阈值 → 放行（>= 语义，不是 >）', () => {
  const { newRepeat } =
    detectPatterns([mkTask(0.6), mkTask(0.6), mkTask(0.6)], { minOccurrence: 3, minSuccessRate: 0.6 });
  assert.equal(newRepeat.length, 1);
});

test('默认门为 0.6：不传 minSuccessRate 时 0.5 被拦、0.7 放行', () => {
  const low = detectPatterns([mkTask(0.5), mkTask(0.5), mkTask(0.5)], { minOccurrence: 3 });
  const high = detectPatterns([mkTask(0.7), mkTask(0.7), mkTask(0.7)], { minOccurrence: 3 });
  assert.equal(low.newRepeat.length, 0);
  assert.equal(low.blockedBySuccessRate.length, 1);
  assert.equal(high.newRepeat.length, 1);
});

test('successRate 缺失 / 非数值 → 不放行（缺数据不编造）', () => {
  const { newRepeat, blockedBySuccessRate } =
    detectPatterns([mkTask(undefined), mkTask(undefined), mkTask(undefined)], { minOccurrence: 3 });
  assert.equal(newRepeat.length, 0);
  assert.equal(blockedBySuccessRate.length, 1);
});

test('minSuccessRate: 0 → 关闭该门（退回 2026-09-13 前行为）', () => {
  const { newRepeat, blockedBySuccessRate } =
    detectPatterns([mkTask(0), mkTask(0), mkTask(0)], { minOccurrence: 3, minSuccessRate: 0 });
  assert.equal(newRepeat.length, 1);
  assert.equal(blockedBySuccessRate.length, 0);
});

test('passesSuccessGate：有限数比较 + 非有限数一律否', () => {
  assert.equal(passesSuccessGate(0.6, 0.6), true);
  assert.equal(passesSuccessGate(0.59, 0.6), false);
  assert.equal(passesSuccessGate(undefined, 0.6), false);
  assert.equal(passesSuccessGate(NaN, 0.6), false);
});
