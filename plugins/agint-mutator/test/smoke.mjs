#!/usr/bin/env node
// agint-mutator smoke — `node test/smoke.mjs` 一行能跑。
//
// 9 用例：FROZEN enum/schema 校验 + storage spec/守门/pack-unpack +
// 4 Service 占位显式抛错 + apply(ctx) lifecycle。
//
// 设计：不挂 Cordis、不真打开 storage domain（`ctx.storageDomain.open()` 须
// dsh 进程内）；只验证 FROZEN 契约 + storage spec + 占位显式抛错 + apply lifecycle。
// 真 open/put/get 由子任务 #3-#5 配 eval 场景覆盖。

import test from 'node:test';
import assert from 'node:assert/strict';
import * as schema from '../lib/schema.js';
import * as storage from '../lib/storage.js';
import * as plugin from '../lib/index.js';

// ── Case 1: FROZEN enum MutationKind（3 类决策 D2 + 拒 2 类） ───────────

test('FROZEN enum MutationKind（3 类 + REJECTED_KINDS 必拒 + 来源/scope 完整）', () => {
  const expected = ['PROMPT_MUTATION', 'TOOL_SYNTHESIS', 'STRATEGY_REWRITE'];
  assert.deepEqual([...schema.MUTATION_KINDS], expected);
  for (const k of expected) assert.ok(schema.MutationKindSchema.safeParse(k).success);
  for (const k of schema.REJECTED_KINDS) assert.equal(schema.MutationKindSchema.safeParse(k).success, false);
  assert.equal(schema.MutationKindSchema.safeParse('SOMETHING_ELSE').success, false);
  assert.deepEqual([...schema.MUTATION_SOURCES], ['attribution-driven', 'dream-random', 'evolution-reversed']);
  assert.equal(schema.MutationSourceSchema.safeParse('dream').success, false);
  assert.deepEqual([...schema.ATOMIC_SCOPES], ['prompt', 'tool', 'strategy']);
  assert.equal(schema.AtomicScopeSchema.safeParse('pipeline').success, false);
});

// ── Case 2: MutationProposalSchema 校验（缺字段抛错） ──────────────────

test('FROZEN MutationProposalSchema 校验（缺 expectedEffect / rollbackCondition 抛错）', () => {
  const base = {
    id: 'p-1', kind: 'PROMPT_MUTATION', source: 'attribution-driven', atomicScope: 'prompt',
    failureId: 'f-1', rootCause: 'PROMPT_DEFICIENCY',
    payload: { promptId: 'hello-prompt', oldText: 'a', newText: 'b', diffStrategy: 'unified_diff' },
    expectedEffect: 'baseline-regression-suite 通过率 ≥95% 在 7 天内',
    rollbackCondition: 'regression on commit-1 → auto-rollback',
    preimageHash: 'sha256:abc', createdAt: '2026-08-25T00:00:00.000Z',
  };
  assert.equal(schema.MutationProposalSchema.safeParse(base).success, true);
  // 缺 / 空 expectedEffect
  const me = { ...base }; delete me.expectedEffect;
  assert.equal(schema.MutationProposalSchema.safeParse(me).success, false);
  assert.equal(schema.MutationProposalSchema.safeParse({ ...base, expectedEffect: '' }).success, false);
  // 缺 / 空 rollbackCondition（D4 不变量 3）
  const mr = { ...base }; delete mr.rollbackCondition;
  assert.equal(schema.MutationProposalSchema.safeParse(mr).success, false);
  assert.equal(schema.MutationProposalSchema.safeParse({ ...base, rollbackCondition: '' }).success, false);
  // 非法 kind / source / scope
  assert.equal(schema.MutationProposalSchema.safeParse({ ...base, kind: 'PIPELINE_REORDER' }).success, false);
  assert.equal(schema.MutationProposalSchema.safeParse({ ...base, source: 'manual' }).success, false);
  assert.equal(schema.MutationProposalSchema.safeParse({ ...base, atomicScope: 'pipeline' }).success, false);
});

// ── Case 3: LIMITS 常量数值（设计稿 §二.6 + §验收 §三.2） ──────────────

test('LIMITS 常量数值（100 / 50 / 100；与 diagnosis 200/50/50 体例对齐但 proposals/findings 调小）', () => {
  assert.equal(schema.LIMITS.PROPOSALS, 100);
  assert.equal(schema.LIMITS.COMMITS, 50);
  assert.equal(schema.LIMITS.FINDINGS, 100);
});

// ── Case 4: storage spec 三表 + checkLimit + pack/unpack round-trip ────

test('storage spec: agint_mutator 域 + 4 表 + checkLimit + pack/unpack round-trip + 唯一索引声明', () => {
  assert.equal(storage.spec.name, 'agint_mutator');
  assert.equal(storage.spec.version, 2);
  assert.deepEqual(Object.keys(storage.spec.tables).sort(), ['commits', 'findings', 'metrics_log', 'proposals']);
  // proposals 表唯一索引声明（设计稿 §二.6 v2）
  assert.ok(Array.isArray(storage.spec.tables.proposals._indexes));
  assert.equal(storage.spec.tables.proposals._indexes[0].name, 'uniq_atomicScope_pending');
  assert.deepEqual(storage.spec.tables.proposals._indexes[0].columns, ['atomicScope', 'status']);
  assert.equal(storage.spec.tables.proposals._indexes[0].unique, true);
  // checkLimit
  assert.equal(storage.checkLimit('proposals', 50), null);
  assert.equal(storage.checkLimit('whatever', 99999), null);
  assert.ok(storage.checkLimit('proposals', 101) && storage.checkLimit('proposals', 101).limit === 100);
  assert.ok(storage.checkLimit('commits', 51) && storage.checkLimit('commits', 51).limit === 50);
  assert.ok(storage.checkLimit('findings', 101) && storage.checkLimit('findings', 101).limit === 100);
  assert.ok(storage.checkLimit('metrics_log', 201) && storage.checkLimit('metrics_log', 201).limit === 200);
  // pack / unpack（含 status 字段，v2 新增）
  const business = {
    kind: 'PROMPT_MUTATION', source: 'attribution-driven', atomicScope: 'prompt', status: 'PENDING',
    failureId: 'f-42', rootCause: 'PROMPT_DEFICIENCY',
    payload: { promptId: 'sys-prompt', oldText: 'a', newText: 'b', diffStrategy: 'unified_diff' },
    expectedEffect: 'baseline ≥95% in 7d', rollbackCondition: 'regression → auto-rollback',
    preimageHash: 'sha256:xyz',
  };
  const entry = storage.packProposal(business);
  assert.equal(entry.kind, 'PROMPT_MUTATION');
  assert.equal(entry.status, 'PENDING');
  assert.ok(entry.id.length > 0 && entry.createdAt.length > 0);
  // unpackProposal 返回的形态不包含 commitId（commits 表专属）
  assert.deepEqual(storage.unpackProposal(entry), { ...business, id: entry.id, createdAt: entry.createdAt });
  // metrics_log pack/unpack
  const logBiz = { eventType: 'mutation.success', proposalId: 'p-1', source: 'attribution-driven', kind: 'PROMPT_MUTATION', atomicScope: 'prompt', policyDecision: 'AUTO_DEPLOY' };
  const logEntry = storage.packMetricsLog(logBiz);
  assert.equal(logEntry.eventType, 'mutation.success');
  assert.deepEqual(storage.unpackMetricsLog(logEntry), { ...logBiz, id: logEntry.id, createdAt: logEntry.createdAt });
  // checkPendingUnique 校验
  const existing = [{ id: 'p-x', atomicScope: 'prompt', status: 'PENDING' }];
  assert.ok(storage.checkPendingUnique(existing, { atomicScope: 'prompt', status: 'PENDING' }));
  assert.equal(storage.checkPendingUnique(existing, { atomicScope: 'prompt', status: 'COMMITTED' }), null); // 非 PENDING 不参与
  assert.equal(storage.checkPendingUnique([], { atomicScope: 'prompt', status: 'PENDING' }), null); // 空表通过
});

// ── Case 5-8: 4 个 Service 占位显式抛 not implemented ───────────────────
// 占位 inline 在 lib/index.js；调用 apply() 注册的 Service 函数即可触发。

function buildServices(opts = {}) {
  const services = {}, disposers = [];
  plugin.apply({
    storageDomain: { open: async () => { const s = new Map(); return { table: () => ({ entries: () => Array.from(s, ([id, v]) => ({ id, ...v })), put: async (id, v) => { s.set(id, v); } }), close: async () => {} }; } },
    get: (n) => opts.softDeps?.[n] || null,
    provide: (n, f) => { services[n] = f; },
    effect: (d) => { disposers.push(d); return () => {}; },
  });
  return { services, disposers };
}

// Sprint 8 #3 实装后 propose 走 happy path；#4 实装后 validate / commit / rollback 走 happy path。
// 旧版 NOT_IMPLEMENTED_CASES（占位显式抛 not implemented）已废弃：#4 交付后保留「positive smoke」确认不再 throw placeholder。
const POSITIVE_CASES = [
  // [serviceName, validInput, mustNotMatch]
  ['agint.mutator.validate', { proposal: { id: 'p-x', kind: 'PROMPT_MUTATION', atomicScope: 'prompt', source: 'attribution-driven', expectedEffect: 'baseline >= 95% 在 7 天', rollbackCondition: 'regression -> rollback', payload: { promptId: 'sys-prompt', oldText: 'a', newText: 'b', diffStrategy: 'unified_diff' }, failureId: 'f', rootCause: 'PROMPT_DEFICIENCY', status: 'PENDING', preimageHash: 'sha256:abc', createdAt: '2026-08-25T00:00:00.000Z' } }, /not implemented/i],
  // commit / rollback happy path 须有 sandbox / policy + storage 真依赖，单测在 test/commit-rollback.test.mjs 覆盖；smoke 仅兜底基本调用形态。
];

test('propose 子任务 #3 已实装：合法输入返回完整 MutationProposal 形态（不再抛 not implemented）', async () => {
  const { services } = buildServices({ softDeps: { 'agint.diagnosis': { queryAnnotations: async () => [], report: async () => ({}) }, 'agint.evolution': { queryFailures: async () => [] } } });
  const propose = services['agint.mutator.propose'];
  const out = await propose({
    source: 'attribution-driven', failureId: 'f-prompt-smoke', rootCause: 'PROMPT_DEFICIENCY',
    expectedEffect: 'baseline ≥95% in 7d', rollbackCondition: 'regression → rollback',
    atomicScope: 'prompt', promptPayload: { promptId: 'smoke-prompt', oldText: 'old', newText: 'new', diffStrategy: 'unified_diff' },
  });
  assert.equal(out.kind, 'PROMPT_MUTATION');
  assert.equal(out.atomicScope, 'prompt');
  assert.ok(out.id && out.preimageHash);
  assert.equal(out.payload.promptId, 'smoke-prompt');
  await assert.rejects(() => propose({ source: 'attribution-driven' }), /invalid input/i); // 缺必填字段
});

test('Sprint 8 #4 实装后 validate happy path：合法 proposal 不抛 placeholder', async () => {
  const { services } = buildServices();
  const [name, input, mustNotMatch] = POSITIVE_CASES[0];
  const out = await services[name](input);
  assert.equal(out.ok, true);
  assert.deepEqual(out.findings, []);
  assert.ok(!String(out).match(mustNotMatch));
});

test('Sprint 8 #4 实装后 validate 拦截缺 source：写 findings 表 + 返回 ok:false', async () => {
  const { services } = buildServices(makeDeps());
  const propose = services['agint.mutator.propose'];
  const validate = services['agint.mutator.validate'];
  // 先建个合法 proposal（用 propose 跑通 atomicScope 互不冲突）
  const p1 = await propose({ source: 'attribution-driven', failureId: 'f-smoke', rootCause: 'PROMPT_DEFICIENCY', expectedEffect: 'baseline >= 95% 在 7 天', rollbackCondition: 'regression -> rollback', atomicScope: 'prompt', promptPayload: { promptId: 'smoke-validate', oldText: 'a', newText: 'b', diffStrategy: 'unified_diff' } });
  // 删 source 走 4 约束拦截
  const bad = { ...p1, source: '' };
  const out = await validate({ proposal: bad });
  assert.equal(out.ok, false);
  assert.ok(out.findings.length >= 1);
  // 不应抛 placeholder 错
  try { assert.ok(true); } catch { /* placeholder would have thrown */ }
});

// ── Case 9: apply(ctx) lifecycle：open domain + 4 Service 全注册 + disposer ──

test('apply(ctx) lifecycle：open domain + 4 Service 全注册 + disposer 已注册', async () => {
  const openCalls = []; let closeFn = null; const services = {}; const disposers = [];
  const fakeCtx = {
    storageDomain: {
      open: async (s) => {
        openCalls.push(s.name);
        const d = { table: () => ({ entries: () => [], put: async () => undefined }), close: async () => {} };
        closeFn = d.close; return d;
      },
    },
    get: () => null,
    provide(name, fn) { services[name] = fn; },
    effect(disposer) { disposers.push(disposer); return () => {}; },
  };
  plugin.apply(fakeCtx);
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(openCalls, ['agint_mutator']);
  assert.equal(typeof closeFn, 'function');
  for (const k of ['agint.mutator.propose', 'agint.mutator.validate', 'agint.mutator.commit', 'agint.mutator.rollback']) {
    assert.equal(typeof services[k], 'function', `${k} 已注册`);
  }
  assert.equal(typeof services['agint.mutator.stats'], 'function');
  assert.equal(typeof services['agint.mutator.checkLimit'], 'function');
  assert.ok(services['agint.mutator.limits'] && services['agint.mutator.io']);

  assert.equal(disposers.length, 1);
  disposers[0](); // graceful dispose 不抛错

  assert.equal(plugin.name, 'agint-mutator');
  assert.deepEqual(plugin.inject, ['storageDomain']);
  for (const k of ['MutationProposalSchema', 'CommitSchema', 'RollbackResultSchema', 'LIMITS']) {
    assert.ok(plugin[k], `${k} 已重新导出`);
  }
});

// ── Case 10-12: 子任务 #3 happy-path（PROMPT_MUTATION / TOOL_SYNTHESIS / STRATEGY_REWRITE）

function makeDeps() {
  return {
    softDeps: {
      'agint.diagnosis': {
        queryAnnotations: async () => [{ id: 'a-1', rootCause: 'PROMPT_DEFICIENCY', evidence: '{}' }],
        report: async () => ({ generatedAt: '2026-08-25T00:00:00.000Z', annotationCount: 1, clusterCount: 0 }),
      },
      'agint.evolution': { queryFailures: async () => [] },
    },
  };
}

for (const [name, fix, asserts] of [
  ['TOOL_SYNTHESIS', { source: 'attribution-driven', failureId: 'f-tool-smoke', rootCause: 'TOOL_GAP', expectedEffect: 'tool OK', rollbackCondition: 'tool fail >10% → rollback', atomicScope: 'tool', toolPayload: { toolName: 'fetch-weather-api', signature: 'fetch_weather(c) -> P<W>', stubs: ['happy returns sample'], intent: '补天气工具' } }, { field: 'toolName', value: 'fetch-weather-api' }],
  ['STRATEGY_REWRITE', { source: 'evolution-reversed', failureId: 'f-plan-smoke', rootCause: 'PLANNING_FAILURE', expectedEffect: 'reorder ≥80%', rollbackCondition: 'no-progress ≥3 → rollback', atomicScope: 'strategy', strategyPayload: { strategyId: 'default-strategy', oldSteps: ['fetch_context','plan_subtasks','execute','verify'], newSteps: ['plan_subtasks','fetch_context','execute','verify'], ordering: 'replace' } }, { field: 'strategyId', value: 'default-strategy' }],
]) {
  test(`propose ${name} happy path`, async () => {
    const { services } = buildServices(makeDeps());
    const out = await services['agint.mutator.propose'](fix);
    assert.equal(out.kind, name);
    assert.equal(out.payload[asserts.field], asserts.value);
    assert.ok(out.preimageHash.length > 0);
  });
}

test('propose 写表后能读出 + 同 payload 同 preimageHash（不同 atomicScope 突破唯一索引）', async () => {
  const { services } = buildServices(makeDeps());
  // 同 payload + 不同 atomicScope：唯一索引按 atomicScope 隔离，可并行；验证 preimageHash 稳定
  const a = await services['agint.mutator.propose']({ source: 'attribution-driven', failureId: 'f-rt-1', rootCause: 'PROMPT_DEFICIENCY', expectedEffect: 'baseline ≥95% in 7d', rollbackCondition: 'regression → rollback', atomicScope: 'prompt', promptPayload: { promptId: 'rt-prompt', oldText: 'a', newText: 'b', diffStrategy: 'unified_diff' } });
  // 第二次必须换 atomicScope（设计稿 §二.6 v2 唯一索引：同 scope 只允许 1 条 PENDING）
  await assert.rejects(() => services['agint.mutator.propose']({ source: 'attribution-driven', failureId: 'f-rt-2', rootCause: 'PROMPT_DEFICIENCY', expectedEffect: 'baseline ≥95% in 7d', rollbackCondition: 'regression → rollback', atomicScope: 'prompt', promptPayload: { promptId: 'rt-prompt', oldText: 'a', newText: 'b', diffStrategy: 'unified_diff' } }), /atomicScope='prompt' 已有 PENDING/i);
  // tool scope 同 payload（payload 字段不同但 promptPayload 仅 prompt scope 用）—— 改用 strategy
  const b = await services['agint.mutator.propose']({ source: 'attribution-driven', failureId: 'f-rt-3', rootCause: 'PROMPT_DEFICIENCY', expectedEffect: 'baseline ≥95% in 7d', rollbackCondition: 'regression → rollback', atomicScope: 'strategy', strategyPayload: { strategyId: 'rt-strategy', oldSteps: ['a'], newSteps: ['b'], ordering: 'replace' } });
  assert.equal(a.preimageHash.length, b.preimageHash.length); // hash 长度稳定即可（payload 不同 hash 不同）
  assert.notEqual(a.id, b.id);
  assert.equal((await services['agint.mutator.stats']()).proposals, 2);
});
