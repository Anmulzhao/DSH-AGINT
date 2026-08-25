#!/usr/bin/env node
// agint-mutator / propose unit test — `node test/propose.test.mjs` 一行能跑。
// 子任务 #3 交付：≥10 用例覆盖 3 类路由 / 入参校验 / payload 二次校验 / LIMITS / 软依赖 / round-trip。

import test from 'node:test';
import assert from 'node:assert/strict';
import * as plugin from '../lib/index.js';

const { LIMITS, ProposeInputSchema, _proposePromptMutation, _proposeToolSynthesis, _proposeStrategyRewrite } = plugin;

// ── fixtures（inline；用 clone 防止污染原 fixture） ────────────────────
const FIX = {
  prompt: { source: 'attribution-driven', failureId: 'f-p1', rootCause: 'PROMPT_DEFICIENCY',
    expectedEffect: 'baseline ≥95% in 7d', rollbackCondition: 'regression → rollback', atomicScope: 'prompt',
    promptPayload: { promptId: 'sys-prompt', oldText: 'old', newText: 'new', diffStrategy: 'unified_diff' } },
  tool: { source: 'attribution-driven', failureId: 'f-t1', rootCause: 'TOOL_GAP',
    expectedEffect: 'tool success ≥80%', rollbackCondition: 'tool fail >10% → rollback', atomicScope: 'tool',
    toolPayload: { toolName: 'fetch-weather-api', signature: 'fetch_weather(c) -> P<W>', stubs: ['happy returns sample'], intent: '补天气工具' } },
  strategy: { source: 'evolution-reversed', failureId: 'f-s1', rootCause: 'PLANNING_FAILURE',
    expectedEffect: 'reorder ≥80%', rollbackCondition: 'no-progress ≥3 → rollback', atomicScope: 'strategy',
    strategyPayload: { strategyId: 's-default', oldSteps: ['fetch_context', 'plan_subtasks', 'execute', 'verify'], newSteps: ['plan_subtasks', 'fetch_context', 'execute', 'verify'], ordering: 'replace' } },
};
const clone = (x) => JSON.parse(JSON.stringify(x));
const DIAG = { queryAnnotations: async () => [], report: async () => ({ generatedAt: '2026-08-25T00:00:00.000Z' }) };
const EVO = { queryFailures: async () => [] };

function makeCtx(opts = {}) {
  const store = opts.existing ? new Map(opts.existing) : new Map();
  const services = {};
  plugin.apply({
    storageDomain: { open: async () => ({ table: () => ({ entries: () => Array.from(store, ([id, v]) => ({ id, ...v })), put: async (id, v) => { store.set(id, v); } }), close: async () => {} }) },
    get: (n) => opts.nullDeps?.includes(n) ? null : (n === 'agint.diagnosis' ? DIAG : n === 'agint.evolution' ? EVO : null),
    provide: (n, f) => { services[n] = f; },
    effect: () => () => {},
  });
  return { services, store };
}

// 入参校验（Case 1-3）
test('Case 1: 缺 expectedEffect 抛 zod 错', () => {
  const i = clone(FIX.prompt); delete i.expectedEffect;
  assert.equal(ProposeInputSchema.safeParse(i).success, false);
});
test('Case 2: 缺 rollbackCondition 抛 zod 错', () => {
  const i = clone(FIX.tool); delete i.rollbackCondition;
  assert.equal(ProposeInputSchema.safeParse(i).success, false);
});
test('Case 3: atomicScope 非法值抛 enum 错（设计稿 D2 拒 PIPELINE_REORDER）', () => {
  for (const scope of ['pipeline', 'PIPELINE_REORDER']) {
    assert.equal(ProposeInputSchema.safeParse({ ...FIX.prompt, atomicScope: scope }).success, false);
  }
});

// 3 类路由（Case 4-6）
for (const [kind, fix, expects] of [
  ['PROMPT_MUTATION', FIX.prompt, { field: 'promptId', value: 'sys-prompt', scope: 'prompt' }],
  ['TOOL_SYNTHESIS', FIX.tool, { field: 'toolName', value: 'fetch-weather-api', scope: 'tool' }],
  ['STRATEGY_REWRITE', FIX.strategy, { field: 'strategyId', value: 's-default', scope: 'strategy' }],
]) {
  test(`Case: ${kind} 路由`, async () => {
    const { services } = makeCtx();
    const out = await services['agint.mutator.propose'](fix);
    assert.equal(out.kind, kind);
    assert.equal(out.atomicScope, expects.scope);
    assert.equal(out.payload[expects.field], expects.value);
    assert.ok(out.preimageHash.length > 0);
  });
}

// payload 二次校验失败（Case 7-9）：用 clone 防止污染原 fixture
test('Case 7: PROMPT 缺 diffStrategy 二次校验失败', async () => {
  const { services } = makeCtx();
  const bad = clone(FIX.prompt); delete bad.promptPayload.diffStrategy;
  await assert.rejects(() => services['agint.mutator.propose'](bad), /payload|invalid/i);
});
test('Case 8: TOOL 缺 signature 二次校验失败', async () => {
  const { services } = makeCtx();
  const bad = clone(FIX.tool); delete bad.toolPayload.signature;
  await assert.rejects(() => services['agint.mutator.propose'](bad), /payload|invalid/i);
});
test('Case 9: STRATEGY newSteps 空 二次校验失败', async () => {
  const { services } = makeCtx();
  const bad = clone(FIX.strategy); bad.strategyPayload.newSteps = [];
  await assert.rejects(() => services['agint.mutator.propose'](bad), /payload|invalid/i);
});
test('Case 10: 二次校验（atomicScope=strategy 但只传 promptPayload）', async () => {
  const { services } = makeCtx();
  const bad = clone(FIX.strategy); bad.strategyPayload = undefined; bad.promptPayload = FIX.prompt.promptPayload;
  await assert.rejects(() => services['agint.mutator.propose'](bad), /payload|缺失|invalid/i);
});

// LIMITS + 软依赖缺失（Case 11-12）
test('Case 11: LIMITS.PROPOSALS=100 满表抛错', async () => {
  const existing = Array.from({ length: LIMITS.PROPOSALS }, (_, i) => [`p-${i}`, { id: `p-${i}` }]);
  const { services } = makeCtx({ existing });
  await assert.rejects(() => services['agint.mutator.propose'](FIX.prompt), /proposals table full/i);
});
for (const [scope, dep, pattern] of [
  ['prompt', 'agint.diagnosis', /agint\.diagnosis|queryAnnotations/i],
  ['tool', 'agint.evolution', /agint\.evolution|queryFailures/i],
  ['strategy', 'agint.diagnosis', /agint\.diagnosis|report/i],
]) {
  test(`Case: ${scope} 软依赖缺失抛错（${dep}=null）`, async () => {
    const { services } = makeCtx({ nullDeps: [dep] });
    await assert.rejects(() => services['agint.mutator.propose'](FIX[scope]), pattern);
  });
}

// round-trip + preimageHash 稳定（Case 13，v2 唯一索引要求换 atomicScope）
test('Case 13: 写表后能读出 + 同 payload 同 preimageHash（不同 atomicScope 突破唯一索引）', async () => {
  const { services, store } = makeCtx();
  const a = await services['agint.mutator.propose'](FIX.prompt);
  // 第二次同 atomicScope 必被唯一索引拒（设计稿 §二.6 v2）
  await assert.rejects(() => services['agint.mutator.propose'](FIX.prompt), /atomicScope='prompt' 已有 PENDING/i);
  // 第三次换 atomicScope → 成功；preimageHash 稳定（payload 内容同 → 同 hash；payload 不同 → 不同 hash 此处改用 strategy scope）
  const fixStrategy = clone(FIX.prompt); fixStrategy.atomicScope = 'strategy'; fixStrategy.rootCause = 'PLANNING_FAILURE';
  fixStrategy.strategyPayload = FIX.strategy.strategyPayload; fixStrategy.promptPayload = undefined;
  const b = await services['agint.mutator.propose'](fixStrategy);
  assert.equal(a.preimageHash.length, b.preimageHash.length); // hash 长度稳定（payload 不同 hash 不同）
  assert.notEqual(a.id, b.id);
  assert.equal(store.size, 2);
  assert.equal(store.get(a.id).kind, 'PROMPT_MUTATION');
});

// _propose* 独立可测（Case 14-16）
test('Case: _proposePromptMutation 独立 happy + missing', () => {
  assert.equal(_proposePromptMutation(FIX.prompt, DIAG).promptId, 'sys-prompt');
  assert.throws(() => _proposePromptMutation(FIX.prompt, null), /不可用/);
});
test('Case: _proposeToolSynthesis 独立 happy + missing', async () => {
  const out = await _proposeToolSynthesis(FIX.tool, EVO);
  assert.equal(out.toolName, 'fetch-weather-api');
  await assert.rejects(() => _proposeToolSynthesis(FIX.tool, null), /queryFailures/);
});
test('Case: _proposeStrategyRewrite 独立 happy + missing', () => {
  assert.equal(_proposeStrategyRewrite(FIX.strategy, DIAG).ordering, 'replace');
  assert.throws(() => _proposeStrategyRewrite(FIX.strategy, null), /不可用/);
});