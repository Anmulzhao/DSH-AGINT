/**
 * 工单状态机**等价性**测试（2026-11-01）。
 *
 * 面板不 import agint-evolve（既有纪律：它只读落盘文件），所以 `v2-proposals.js`
 * 里保留了一份 `ticketStageOf()` 镜像。与 hasBlocker / isExecActive / startOfWeek
 * 同一处理方式：**两处各有一份，靠这个用例钉住等价**。
 *
 * ⛔ 为什么不能省这份用例：镜像实现一旦漂移，面板说的和工具说的就是两件事，
 *    而两边都不像在撒谎 —— 这正是 a85ef850 那次「待办写阻塞中、提案台写待入队」
 *    的形态，查起来比一个字段写错难得多。
 *
 * 判据的单一事实源：plugins/agint-evolve/lib/execution.js → ticketStage()
 * 改那边必须同时改这边，否则本用例立刻红。
 *
 * 运行：node --test test/stage-parity.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ticketStage } from '../../agint-evolve/lib/execution.js';
import { ticketStageOf } from '../lib/v2-proposals.js';

/** 取两边算出的可比部分（why 也纳入：文案对不上同样是漂移）。 */
const both = (r) => {
  const a = ticketStage(r);
  const b = ticketStageOf(r);
  return {
    a: { stage: a.stage, side: a.side, label: a.label, why: a.why },
    b: { stage: b.stage, side: b.side, label: b.label, why: b.why },
  };
};

test('手写现场：两边逐字一致', () => {
  const cases = [
    { status: 'proposed' },
    { status: 'applied', execState: 'succeeded' },
    { status: 'approved', execMode: 'immediate', execState: 'idle', blocker: '样本未标注' },
    { status: 'approved', execMode: 'immediate', execState: 'failed', execError: 'driver 抛错：timeout' },
    { status: 'approved', execMode: 'immediate', execState: 'partial', execError: '部分落地（1/3）' },
    { status: 'approved', execMode: 'manual', execState: 'idle' },
    { status: 'approved', execMode: 'scheduled', execAt: '', execState: 'idle' },
    { status: 'approved', execMode: 'scheduled', execAt: '明天', execState: 'idle' },
    { status: 'approved', execMode: 'scheduled', execAt: '2026-11-03T09:00:00.000Z', execState: 'queued' },
    { status: 'approved', execMode: 'immediate', execState: 'queued' },
    { status: 'approved', execMode: 'immediate', execState: 'deferred', execError: '本周已达上限（5/5）' },
    { status: 'approved', execMode: 'immediate', execState: 'running' },
    { status: 'approved', execMode: 'immediate', execState: 'cancelled' },
    { status: 'approved' },
  ];
  for (const r of cases) {
    const { a, b } = both(r);
    assert.deepEqual(b, a, `现场 ${JSON.stringify(r)} 两边不一致`);
  }
});

test('笛卡尔穷举：status × execMode × execState × blocker × execAt 全部一致', () => {
  const statuses = ['proposed', 'approved', 'applied', 'rejected', 'wontfix', 'weird'];
  const modes = ['manual', 'immediate', 'scheduled', 'garbage'];
  const states = ['idle', 'queued', 'running', 'succeeded', 'failed', 'deferred', 'cancelled', 'partial', 'garbage'];
  const blockers = ['', '   ', '样本未标注'];
  const ats = ['', '2026-11-03T09:00:00.000Z', '明天'];
  let n = 0;
  for (const status of statuses) {
    for (const execMode of modes) {
      for (const execState of states) {
        for (const blocker of blockers) {
          for (const execAt of ats) {
            const r = { status, execMode, execState, blocker, execAt, execError: 'x' };
            const { a, b } = both(r);
            assert.deepEqual(b, a, `组合不一致：${JSON.stringify(r)}`);
            n += 1;
          }
        }
      }
    }
  }
  assert.ok(n >= 1000, `穷举样本太少（${n}），覆盖不住分支组合`);
});

test('字段全缺（历史行）两边一致', () => {
  for (const status of ['proposed', 'approved', 'applied']) {
    const { a, b } = both({ status });
    assert.deepEqual(b, a, `历史行 ${status} 两边不一致`);
  }
});
