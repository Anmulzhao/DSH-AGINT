#!/usr/bin/env node
// agint-dream / consolidateBatched 分批整合 unit test
//
// 起因（2026-10-07 实测）：单批 43 条候选 → 子代理 60s 超时 →
// `consolidation timeout (60000ms)` → 整批 heuristic-degraded → sweep 退回
// 「见一条推一条」→ 当晚 76 条记忆里 33 条（43%）是重复副本与无上下文碎片。
// LLM 整合是质量闸门，它一超时就等于闸门敞开 —— 所以治批大小，不是调超时。
//
// 本文件锁四件事：分批切分与拼接、单批不超限时行为不变、all-or-nothing 降级、
// 以及「gate 未超时就不分批」这条性能前提（分批是降超时手段，不是常态开销）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { consolidate, consolidateBatched, DEFAULT_BATCH_SIZE } from '../lib/consolidation.js';

const flush = () => new Promise((r) => setImmediate(r));

/** 记录每次 consolidate 被喂了几条，以及每条产出的 operations 长度。 */
function makeMockCtx({ perBatchLimit = Infinity } = {}) {
  const batchSizes = [];
  const agents = { createCount: 0 };
  const subagents = { startCount: 0 };
  const ctx = {
    get(key) {
      if (key === 'agents') {
        return {
          async create() {
            agents.createCount += 1;
            return { agent: { id: `a${agents.createCount}` }, dispose() {} };
          },
        };
      }
      if (key === 'subagents') {
        return {
          getProvider: () => ({}),
          async start(_provider, { prompt }) {
            subagents.startCount += 1;
            if (batchSizes.length >= perBatchLimit) {
              // 模拟该批跑不完：延迟到超时守卫之后
              await new Promise(() => {});
            }
            const n = (prompt[0].text.match(/c\d+/g) || []).length;
            batchSizes.push(n);
            await flush();
            return {
              localAgent: { ctx: { on() {} } },
              result: {
                stopReason: 'completed',
                structured: {
                  operations: Array.from({ length: n }, (_, i) => ({
                    action: 'added', candidateKey: `k${i}`, priorEntries: [],
                  })),
                  reasoning: 'ok',
                },
              },
              dispose() {},
            };
          },
        };
      }
      return undefined;
    },
    provide() {},
    effect() {},
    on() { return () => {}; },
  };
  return { ctx, agents, subagents, batchSizes };
}

const mkGated = (n) => Array.from({ length: n }, (_, i) => ({
  key: `c${i}`, text: `候选 ${i} 的正文`, type: 'lesson', score: 0.7,
}));

// ── ① 分批切分与拼接 ────────────────────────────────────────────────

test('分批：43 条按 8 切 = 6 批，operations 拼回 43 条且 1:1 对齐', async () => {
  const { ctx, batchSizes } = makeMockCtx();
  const res = await consolidateBatched({ ctx, gated: mkGated(43), existing: [], day: 'd', batchSize: 8 });
  assert.equal(res.mode, 'llm');
  assert.equal(res.operations.length, 43, 'operations 必须与 gated 等长（下游 gate 硬要求）');
  assert.deepEqual(batchSizes, [8, 8, 8, 8, 8, 3], '最后一批是余数，不得丢');
  assert.equal(res.batches, 6);
});

test('分批：正好整除时不多切一刀', async () => {
  const { ctx, batchSizes } = makeMockCtx();
  const res = await consolidateBatched({ ctx, gated: mkGated(16), existing: [], day: 'd', batchSize: 8 });
  assert.equal(res.mode, 'llm');
  assert.deepEqual(batchSizes, [8, 8]);
  assert.equal(res.operations.length, 16);
});

// ── ② 不超批量 ⇒ 走原单批路径（性能前提）─────────────────────────

test('不超批量：行为与单批一致，且只起一个子代理', async () => {
  const { ctx, agents, subagents } = makeMockCtx();
  const res = await consolidateBatched({ ctx, gated: mkGated(4), existing: [], day: 'd', batchSize: 8 });
  assert.equal(res.mode, 'llm');
  assert.equal(res.operations.length, 4);
  assert.equal(subagents.startCount, 1, '未超批量不该被切批');
  assert.equal(agents.createCount, 1);
});

test('DEFAULT_BATCH_SIZE 有界且为正整数（批大小为 0 会退化成死循环）', () => {
  assert.ok(Number.isInteger(DEFAULT_BATCH_SIZE) && DEFAULT_BATCH_SIZE > 0);
});

// ── ③ all-or-nothing：一批坏了整批降级 ─────────────────────────────

test('all-or-nothing：任一批降级 ⇒ 整体降级并报出第几批（不返回半成品）', async () => {
  // 前 2 批成功，第 3 批卡死触发超时
  const { ctx } = makeMockCtx({ perBatchLimit: 2 });
  const res = await consolidateBatched({
    ctx, gated: mkGated(24), existing: [], day: 'd', batchSize: 8, timeoutMs: 120,
  });
  assert.equal(res.mode, 'heuristic-degraded');
  assert.equal(res.operations, null, '部分成功无法表达成合法 1:1 形状 ⇒ 必须整体降级');
  assert.match(res.reason, /^batch 3\/3 degraded/, 'reason 要能定位到具体批次');
});

// ── ④ 边界 ────────────────────────────────────────────────────────

test('空 gated：直接降级，不起子代理', async () => {
  const { ctx, subagents } = makeMockCtx();
  const res = await consolidateBatched({ ctx, gated: [], existing: [], day: 'd' });
  assert.equal(res.mode, 'heuristic-degraded');
  assert.equal(subagents.startCount, 0);
});

test('batchSize 传 0 / 负数 / 非法值时回落到 DEFAULT_BATCH_SIZE，不死循环', async () => {
  for (const bad of [0, -1, NaN, 'x']) {
    const { ctx, batchSizes } = makeMockCtx();
    const res = await consolidateBatched({ ctx, gated: mkGated(5), existing: [], day: 'd', batchSize: bad });
    assert.equal(res.mode, 'llm', `batchSize=${bad} 应回落而非崩`);
    assert.equal(res.operations.length, 5);
    assert.ok(batchSizes.length >= 1 && batchSizes.length <= 5, `batchSize=${bad} 切批数异常: ${batchSizes.length}`);
  }
});

test('单批函数 consolidate 的既有契约未被分批改动（回归护栏）', async () => {
  const { ctx } = makeMockCtx();
  const res = await consolidate({ ctx, gated: mkGated(3), existing: [], day: 'd' });
  assert.equal(res.mode, 'llm');
  assert.equal(res.operations.length, 3);
  assert.equal(res.batches, undefined, '单批不该带 batches 字段');
});
