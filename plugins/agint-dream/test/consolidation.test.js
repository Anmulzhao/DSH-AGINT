/**
 * agint-dream: unit tests for the LLM consolidation module (P1).
 * Run with: node --test packages/agint-dream/test/consolidation.test.js
 *
 * 设计见 AGINT/计划-agint-dream升级三方向.md P1 段。
 * 关键不变量：
 *   1. ctx 不可用 / 服务不可用 → mode='heuristic-degraded' + reason 解释
 *   2. gated 为空 → mode='heuristic-degraded' + operations=null
 *   3. subagent 拿到 structured output 后 → mode='llm' + operations 对齐 gated.length
 *   4. subagent stopReason !== 'completed' → mode='heuristic-degraded'
 *   5. structured.operations.length !== gated.length → mode='heuristic-degraded'
 *   6. 不抛异常 —— 所有错误必须 degrade（sweep 不能因为 consolidation 失败而崩溃）
 *   7. buildConsolidationPrompt 是纯函数，输出包含所有 gated 候选 + existing 内容
 *   8. CONSOLIDATION_OUTPUT_SCHEMA 满足 DSH assertObjectJsonSchema 的子集
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  consolidate,
  buildConsolidationPrompt,
  CONSOLIDATION_OUTPUT_SCHEMA,
} from '../lib/consolidation.js';

// ── 纯函数：buildConsolidationPrompt ──────────────────────────────────────

test('buildConsolidationPrompt: 列出所有 gated 候选 + existing 内容 + 输出指令', () => {
  const gated = [
    { key: 'c1', text: '禁止在生产环境 rm -rf', type: 'lesson', score: 0.85, sessionKey: 's1', signalCount: 4, uniqueDays: 2 },
    { key: 'c2', text: '老板是创造者，反馈优先级最高', type: 'preference', score: 0.82, sessionKey: 's2', signalCount: 3, uniqueDays: 1 },
  ];
  const existing = [
    { id: 'e1', type: 'lesson', content: '禁止 rm -rf 系统文件', lineageKey: 'safety/rm-rf' },
  ];
  const out = buildConsolidationPrompt(gated, existing, '2026-09-05');
  // 候选 1:1 列出
  assert.match(out, /禁止在生产环境 rm -rf/);
  assert.match(out, /老板是创造者/);
  assert.match(out, /Candidate 1 \[key: c1\]/);
  assert.match(out, /Candidate 2 \[key: c2\]/);
  // existing 列出
  assert.match(out, /禁止 rm -rf 系统文件/);
  // 输出约束
  assert.match(out, /Operations array length MUST equal 2/);
});

test('buildConsolidationPrompt: 空 gated 输出约束 0', () => {
  const out = buildConsolidationPrompt([], [], '2026-09-05');
  assert.match(out, /Operations array length MUST equal 0/);
});

// ── Schema 子集自检（不调 DSH assert，但保证形态正确） ──────────────────────

test('CONSOLIDATION_OUTPUT_SCHEMA: 是 object-root，且 operations 是 array of object', () => {
  assert.equal(CONSOLIDATION_OUTPUT_SCHEMA.type, 'object');
  assert.ok(CONSOLIDATION_OUTPUT_SCHEMA.properties.operations);
  assert.equal(CONSOLIDATION_OUTPUT_SCHEMA.properties.operations.type, 'array');
  const opItem = CONSOLIDATION_OUTPUT_SCHEMA.properties.operations.items;
  assert.equal(opItem.type, 'object');
  // required 必须存在
  assert.deepEqual(opItem.required, ['candidateKey', 'action', 'priorEntries']);
  // 必须是 DSH 子集：boolean additionalProperties
  assert.equal(opItem.additionalProperties, false);
  assert.equal(CONSOLIDATION_OUTPUT_SCHEMA.additionalProperties, false);
  // 顶层 required
  assert.deepEqual(CONSOLIDATION_OUTPUT_SCHEMA.required, ['operations']);
});

// ── 退化路径 ─────────────────────────────────────────────────────────────

test('consolidate: gated 为空 → degraded, operations=null', async () => {
  const result = await consolidate({
    ctx: { get: () => ({}) },
    gated: [],
    existing: [],
    day: '2026-09-05',
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'heuristic-degraded');
  assert.equal(result.operations, null);
  assert.match(result.reason, /no gated/);
});

test('consolidate: ctx 不可用 → degraded, operations=null, reason 解释', async () => {
  const result = await consolidate({
    ctx: null,
    gated: [{ key: 'c1', text: '某条候选', type: 'lesson', score: 0.8 }],
    existing: [],
    day: '2026-09-05',
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'heuristic-degraded');
  assert.equal(result.operations, null);
  assert.match(result.reason, /ctx unavailable/);
});

test('consolidate: ctx.get("agents") 返回 null → degraded, reason 解释', async () => {
  const ctx = { get: (name) => name === 'subagents' ? { start: () => {} } : null };
  const result = await consolidate({
    ctx,
    gated: [{ key: 'c1', text: '某条候选', type: 'lesson', score: 0.8 }],
    existing: [],
    day: '2026-09-05',
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'heuristic-degraded');
  assert.equal(result.operations, null);
  assert.match(result.reason, /agents service unavailable/);
});

test('consolidate: spawn provider 未注册 → degraded, reason 解释', async () => {
  const ctx = {
    get: (name) => {
      if (name === 'agents') return { create: () => {} };
      if (name === 'subagents') return { start: () => {}, getProvider: () => null };
      return null;
    },
  };
  const result = await consolidate({
    ctx,
    gated: [{ key: 'c1', text: '某条候选', type: 'lesson', score: 0.8 }],
    existing: [],
    day: '2026-09-05',
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'heuristic-degraded');
  assert.equal(result.operations, null);
  assert.match(result.reason, /spawn provider not registered/);
});

// ── 成功路径（用 mock subagent 注入） ────────────────────────────────────

function makeMockCtx({ runResult, throwOnCreate = false, throwOnStart = false }) {
  const calls = { createArgs: null, startArgs: null, disposed: [] };
  const handle = {
    agent: { id: 'mock-parent' },
    dispose: async () => { calls.disposed.push('handle'); },
  };
  const agents = {
    create: async (opts) => {
      calls.createArgs = opts;
      if (throwOnCreate) throw new Error('mock create failed');
      return handle;
    },
  };
  const run = {
    result: Promise.resolve(runResult),
    dispose: async () => { calls.disposed.push('run'); },
  };
  const subagents = {
    getProvider: (name) => name === 'spawn' ? { name: 'spawn' } : null,
    start: async (name, req) => {
      calls.startArgs = { name, ...req };
      if (throwOnStart) throw new Error('mock start failed');
      return run;
    },
  };
  return {
    ctx: { get: (n) => n === 'agents' ? agents : n === 'subagents' ? subagents : null },
    calls,
  };
}

test('consolidate: subagent 返回 llm structured → mode=llm, operations 对齐', async () => {
  const gated = [
    { key: 'c1', text: '禁止 rm -rf', type: 'lesson', score: 0.85 },
    { key: 'c2', text: '老板是创造者', type: 'preference', score: 0.82 },
  ];
  const operations = [
    { candidateKey: 'c1', action: 'added', priorEntries: [] },
    { candidateKey: 'c2', action: 'merged', priorEntries: ['老板 = 创造者'], lineageKey: 'identity/boss' },
  ];
  const { ctx, calls } = makeMockCtx({
    runResult: {
      output: [],
      structured: { operations, reasoning: 'merge c2 into existing identity entry' },
      stopReason: 'completed',
    },
  });
  const result = await consolidate({ ctx, gated, existing: [], day: '2026-09-05' });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'llm');
  assert.deepEqual(result.operations, operations);
  // verify subagent called with right shape
  assert.equal(calls.createArgs.agentOptions.provider, 'deepseek');
  assert.equal(calls.createArgs.agentOptions.model, 'deepseek-chat');
  assert.equal(calls.startArgs.name, 'spawn');
  assert.equal(calls.startArgs.parent.id, 'mock-parent');
  assert.ok(calls.startArgs.outputSchema, 'outputSchema must be passed');
  // run + handle disposed in finally
  assert.ok(calls.disposed.includes('run'));
  assert.ok(calls.disposed.includes('handle'));
});

test('consolidate: stopReason !== completed → degraded, operations=null', async () => {
  const { ctx } = makeMockCtx({
    runResult: { output: [], structured: { operations: [] }, stopReason: 'error', diagnostic: 'LLM timeout' },
  });
  const result = await consolidate({
    ctx,
    gated: [{ key: 'c1', text: '某条', type: 'lesson', score: 0.8 }],
    existing: [],
    day: '2026-09-05',
  });
  assert.equal(result.mode, 'heuristic-degraded');
  assert.equal(result.operations, null);
  assert.match(result.reason, /stopReason=error/);
});

test('consolidate: structured.operations 长度不对齐 → degraded', async () => {
  const { ctx } = makeMockCtx({
    runResult: {
      output: [],
      structured: { operations: [{ candidateKey: 'c1', action: 'added', priorEntries: [] }] },
      stopReason: 'completed',
    },
  });
  const result = await consolidate({
    ctx,
    gated: [
      { key: 'c1', text: '某条1', type: 'lesson', score: 0.8 },
      { key: 'c2', text: '某条2', type: 'preference', score: 0.8 },
    ],
    existing: [],
    day: '2026-09-05',
  });
  assert.equal(result.mode, 'heuristic-degraded');
  assert.equal(result.operations, null);
  assert.match(result.reason, /operations length mismatch/);
});

test('consolidate: structured 缺失 → degraded', async () => {
  const { ctx } = makeMockCtx({
    runResult: { output: [], stopReason: 'completed' }, // 没有 structured
  });
  const result = await consolidate({
    ctx,
    gated: [{ key: 'c1', text: '某条', type: 'lesson', score: 0.8 }],
    existing: [],
    day: '2026-09-05',
  });
  assert.equal(result.mode, 'heuristic-degraded');
  assert.match(result.reason, /structured output invalid/);
});

test('consolidate: agents.create 抛错 → degraded, 不向外抛', async () => {
  const { ctx } = makeMockCtx({ throwOnCreate: true });
  const result = await consolidate({
    ctx,
    gated: [{ key: 'c1', text: '某条', type: 'lesson', score: 0.8 }],
    existing: [],
    day: '2026-09-05',
  });
  assert.equal(result.mode, 'heuristic-degraded');
  assert.match(result.reason, /mock create failed/);
});

test('consolidate: subagents.start 抛错 → degraded, 不向外抛', async () => {
  const { ctx } = makeMockCtx({ throwOnStart: true });
  const result = await consolidate({
    ctx,
    gated: [{ key: 'c1', text: '某条', type: 'lesson', score: 0.8 }],
    existing: [],
    day: '2026-09-05',
  });
  assert.equal(result.mode, 'heuristic-degraded');
  assert.match(result.reason, /mock start failed/);
});

test('consolidate: provider/model 参数被透传到 create', async () => {
  const { ctx, calls } = makeMockCtx({
    runResult: { output: [], structured: { operations: [] }, stopReason: 'completed' },
  });
  await consolidate({
    ctx,
    gated: [{ key: 'c1', text: '某条', type: 'lesson', score: 0.8 }],
    existing: [],
    day: '2026-09-05',
    provider: 'custom-provider',
    model: 'custom-model-v2',
  });
  assert.equal(calls.createArgs.agentOptions.provider, 'custom-provider');
  assert.equal(calls.createArgs.agentOptions.model, 'custom-model-v2');
});

test('consolidate: timeout 时 dispose 仍跑（finally）', async () => {
  // mock：result 永不 resolve，触发 abort
  let aborted = false;
  const ctx = {
    get: (n) => {
      if (n === 'agents') {
        return {
          create: async () => ({
            agent: { id: 'mock' },
            dispose: async () => { aborted = true; },
          }),
        };
      }
      if (n === 'subagents') {
        return {
          getProvider: () => ({ name: 'spawn' }),
          start: async () => ({
            result: new Promise(() => {}), // never resolves → 靠 timeout abort
            dispose: async () => {},
          }),
        };
      }
      return null;
    },
  };
  const result = await consolidate({
    ctx,
    gated: [{ key: 'c1', text: '某条', type: 'lesson', score: 0.8 }],
    existing: [],
    day: '2026-09-05',
    timeoutMs: 50,
  });
  // 50ms timeout → result never resolved → 走 timeout 路径
  // 这里我们只验证：consolidate 不挂死、不抛错、最终返回 degraded
  assert.equal(result.mode, 'heuristic-degraded');
  assert.equal(aborted, true, 'handle.dispose must run in finally');
});
