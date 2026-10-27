/**
 * test/resource-window.test.mjs — 资源窗口聚合口径（2026-10-26，D2/F3）
 *
 * 这组测的是**口径**，不是实现抄写：
 *   1) 任务 = (sessionId, turn)；缺一半的记录不可归属（计入步数、不计入任务）
 *   2) 完成 = 组内**全部** ok（任一失败即未完成）
 *   3) token：null（没测）不计样本，0（测得零）计样本 —— 两者混同会让成本变成假读数
 *   4) 时间窗左闭右开
 *
 * 每条都配阴性对照（口径放宽 ⇒ 必须变红）。
 *
 * Run: node --test plugins/agint-tool-stats/test/resource-window.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeResourceWindow, taskKeyOf } from '../lib/resource-window.js';

const rec = (over = {}) => ({ ts: 1000, sessionId: 's1', turn: 1, tool: 'bash', ok: true, latencyMs: 10, ...over });

test('任务分组：同 (sessionId, turn) 归一个任务，全 ok 才算完成', () => {
  const w = summarizeResourceWindow([
    rec({ ts: 1000 }),
    rec({ ts: 1001, tool: 'read' }),
    rec({ ts: 1002, sessionId: 's1', turn: 2 }),
    rec({ ts: 1003, sessionId: 's1', turn: 3, ok: false }),
  ]);
  assert.equal(w.records, 4);
  assert.equal(w.tasks, 3, '三个 (sid,turn) 组');
  assert.equal(w.completedTasks, 2, 't1 两条全 ok + t2 一条 ok；t3 失败不算完成');
  assert.equal(w.completionRate, 0.6667);
  assert.equal(w.steps, 4);
});

test('⛔ 阴性对照：一条失败就整组不算完成（不是「有一个 ok 就算完成」）', () => {
  const w = summarizeResourceWindow([
    rec({ ts: 1, ok: true }),
    rec({ ts: 2, ok: false }),
  ]);
  assert.equal(w.tasks, 1);
  assert.equal(w.completedTasks, 0);
  assert.equal(w.completionRate, 0);
});

test('不可归属的记录：计步数、不计任务', () => {
  const w = summarizeResourceWindow([
    rec({ ts: 1 }),
    { ts: 2, tool: 'orphan', ok: true, latencyMs: 5 },            // 既无 sessionId 也无 turn
    { ts: 3, sessionId: '', turn: null, tool: 'x', ok: true },    // 空串 / null 同样不可归属
  ]);
  assert.equal(w.steps, 3);
  assert.equal(w.tasks, 1);
  assert.equal(taskKeyOf({ tool: 'x' }), null);
});

test('⛔ token 的 null 与 0 必须分开：null 不计样本，0 计样本', () => {
  const w = summarizeResourceWindow([
    rec({ ts: 1, deltaTokens: null, tokenSource: null }),
    rec({ ts: 2, deltaTokens: 0, tokenSource: 'tokenMeter' }),
    rec({ ts: 3, deltaTokens: 120, tokenSource: 'tokenMeter' }),
  ]);
  assert.equal(w.tokens.sum, 120);
  assert.equal(w.tokens.measured, 2, 'null 不算测得；0 算');
  assert.equal(w.tokens.coverage, 0.6667);
  assert.equal(w.tokens.source, 'tokenMeter');
});

test('⛔ 阴性对照：把 null 当 0 会让覆盖率虚高', () => {
  const w = summarizeResourceWindow([
    rec({ ts: 1, deltaTokens: null }),
    rec({ ts: 2, deltaTokens: null }),
  ]);
  assert.equal(w.tokens.measured, 0);
  assert.equal(w.tokens.coverage, 0, '两条都没测 ⇒ 覆盖率 0，不是 1');
  assert.equal(w.tokens.sum, 0);
});

test('时间窗左闭右开', () => {
  const records = [rec({ ts: 100 }), rec({ ts: 200 }), rec({ ts: 300 })];
  const w = summarizeResourceWindow(records, { sinceMs: 100, untilMs: 300 });
  assert.equal(w.records, 2, '100 计入、300 不计入');
  assert.equal(w.window.sinceMs, 100);
  assert.equal(w.window.untilMs, 300);
});

test('时间窗内 ts 缺失的记录被丢弃（不猜归属窗口）', () => {
  const w = summarizeResourceWindow([rec({ ts: 100 }), { sessionId: 's1', turn: 1, tool: 'x', ok: true }], { sinceMs: 0 });
  assert.equal(w.records, 1);
});

test('空窗口：完成率 null（不是 0），覆盖率 0', () => {
  const w = summarizeResourceWindow([]);
  assert.equal(w.tasks, 0);
  assert.equal(w.completionRate, null);
  assert.equal(w.tokens.coverage, 0);
  assert.equal(w.firstTs, null);
});

test('耗时只累加测得值，并给出测得条数', () => {
  const w = summarizeResourceWindow([
    rec({ ts: 1, latencyMs: 10 }),
    rec({ ts: 2, latencyMs: null }),
    rec({ ts: 3, latencyMs: 30 }),
  ]);
  assert.equal(w.durationMs, 40);
  assert.equal(w.durationMeasured, 2);
});
