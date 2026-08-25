#!/usr/bin/env node
// agint-mutator v2 patch test — 覆盖设计稿 v2 的 4 个缺口：
//   1) MutationStatus / DiffStrategy / OrderingStrategy 3 个 FROZEN enum
//   2) metrics_log 表（pack/unpack + logMetric + LIMITS 守门）
//   3) proposals 表 atomicScope + status='PENDING' 唯一索引
//   4) payload 字段 FROZEN 类型（promptId/toolName/strategyId 正则 + stubs 长度 + intent 长度）
//
// 设计：`node test/v2-patch.test.mjs` 一行能跑。覆盖 v2 契约 ≥5 用例。

import test from 'node:test';
import assert from 'node:assert/strict';
import * as schema from '../lib/schema.js';
import * as storage from '../lib/storage.js';
import * as plugin from '../lib/index.js';

const { LIMITS, MutationStatusSchema, MUTATION_STATUSES, DiffStrategySchema, DIFF_STRATEGIES,
  OrderingStrategySchema, ORDERING_STRATEGIES } = schema;

// ── Case 1: MutationStatus FROZEN enum 4 值 + 拒非法值 ─────────────────

test('MutationStatus FROZEN enum: 4 值（PENDING/COMMITTED/ROLLED_BACK/REJECTED）+ 拒非法', () => {
  assert.deepEqual([...MUTATION_STATUSES], ['PENDING', 'COMMITTED', 'ROLLED_BACK', 'REJECTED']);
  for (const s of MUTATION_STATUSES) assert.ok(MutationStatusSchema.safeParse(s).success);
  for (const bad of ['pending', 'COMMIT', 'rolled', 'UNKNOWN']) {
    assert.equal(MutationStatusSchema.safeParse(bad).success, false);
  }
});

// ── Case 2: DiffStrategy / OrderingStrategy FROZEN enum ─────────────────

test('DiffStrategy FROZEN enum: unified_diff / line_replace', () => {
  assert.deepEqual([...DIFF_STRATEGIES], ['unified_diff', 'line_replace']);
  assert.ok(DiffStrategySchema.safeParse('unified_diff').success);
  assert.ok(DiffStrategySchema.safeParse('line_replace').success);
  assert.equal(DiffStrategySchema.safeParse('replace-block').success, false);
  assert.equal(DiffStrategySchema.safeParse('').success, false);
});

test('OrderingStrategy FROZEN enum: before / after / replace', () => {
  assert.deepEqual([...ORDERING_STRATEGIES], ['before', 'after', 'replace']);
  assert.ok(OrderingStrategySchema.safeParse('before').success);
  assert.ok(OrderingStrategySchema.safeParse('after').success);
  assert.ok(OrderingStrategySchema.safeParse('replace').success);
  assert.equal(OrderingStrategySchema.safeParse('swap-1-2').success, false);
});

// ── Case 3: payload 字段 FROZEN 类型 + 拒绝非法 ─────────────────────────

test('payload promptId/toolName/strategyId 正则 ^[a-z][a-z0-9-]{2,30}$', () => {
  // 合法
  for (const ok of ['sys-prompt', 'fetch-weather-api', 'default-strategy', 'abc', 'a-b-c-d-e-f-g']) {
    assert.ok(schema.MutationPayloadSchema.safeParse({ kind: 'PROMPT_MUTATION', payload: { promptId: ok, oldText: 'a', newText: 'b', diffStrategy: 'unified_diff' } }).success);
    assert.ok(schema.MutationPayloadSchema.safeParse({ kind: 'TOOL_SYNTHESIS', payload: { toolName: ok, signature: 'sig', stubs: ['x'], intent: 'i' } }).success);
    assert.ok(schema.MutationPayloadSchema.safeParse({ kind: 'STRATEGY_REWRITE', payload: { strategyId: ok, oldSteps: ['a'], newSteps: ['b'], ordering: 'replace' } }).success);
  }
  // 非法
  for (const bad of ['AB', '-bad', '1abc', 'a', 'ab', 'with spaces', 'a_b_c']) {
    assert.equal(schema.MutationPayloadSchema.safeParse({ kind: 'PROMPT_MUTATION', payload: { promptId: bad, oldText: 'a', newText: 'b', diffStrategy: 'unified_diff' } }).success, false, `promptId=${bad} 必拒`);
  }
});

test('payload stubs ≥1 + intent ≤500 字符', () => {
  // stubs 空数组必拒
  assert.equal(schema.MutationPayloadSchema.safeParse({ kind: 'TOOL_SYNTHESIS', payload: { toolName: 'fetch-weather', signature: 's', stubs: [], intent: 'i' } }).success, false);
  // intent 超 500 字符必拒
  const longIntent = 'x'.repeat(501);
  assert.equal(schema.MutationPayloadSchema.safeParse({ kind: 'TOOL_SYNTHESIS', payload: { toolName: 'fetch-weather', signature: 's', stubs: ['x'], intent: longIntent } }).success, false);
  // intent 500 字符合法
  const okIntent = 'x'.repeat(500);
  assert.ok(schema.MutationPayloadSchema.safeParse({ kind: 'TOOL_SYNTHESIS', payload: { toolName: 'fetch-weather', signature: 's', stubs: ['x'], intent: okIntent } }).success);
});

// ── Case 4: metrics_log 表 pack/unpack + LIMITS 守门 + logMetric Service ─

test('metrics_log 表 pack/unpack + LIMITS.METRICS_LOG=200', () => {
  assert.equal(LIMITS.METRICS_LOG, 200);
  // checkLimit 守门
  assert.equal(storage.checkLimit('metrics_log', 50), null);
  assert.equal(storage.checkLimit('metrics_log', 200), null); // == 不算超
  assert.ok(storage.checkLimit('metrics_log', 201) && storage.checkLimit('metrics_log', 201).limit === 200);
  // pack/unpack
  const biz = { eventType: 'mutation.success', proposalId: 'p-1', source: 'attribution-driven', kind: 'PROMPT_MUTATION', atomicScope: 'prompt', policyDecision: 'AUTO_DEPLOY' };
  const e = storage.packMetricsLog(biz);
  assert.equal(e.eventType, 'mutation.success');
  assert.equal(e.policyDecision, 'AUTO_DEPLOY');
  assert.deepEqual(storage.unpackMetricsLog(e), { ...biz, id: e.id, createdAt: e.createdAt });
  // 非法 eventType 必抛 zod 错（zod enum 无 default；上层 caller 负责选合法值）
  assert.throws(() => storage.packMetricsLog({ eventType: 'mutation.unknown' }), /Invalid option|invalid_value/);
});

// ── Case 5: 唯一索引 checkPendingUnique + apply() 集成验证 ─────────────

test('checkPendingUnique: 同 atomicScope + status=PENDING 冲突；非 PENDING 不参与；空表通过', () => {
  const existing = [
    { id: 'p-x', atomicScope: 'prompt', status: 'PENDING' },
    { id: 'p-y', atomicScope: 'tool', status: 'COMMITTED' }, // 已提交不参与唯一约束
    { id: 'p-z', atomicScope: 'prompt', status: 'ROLLED_BACK' }, // 已回滚不参与
  ];
  // 同 scope + PENDING → 冲突
  assert.ok(storage.checkPendingUnique(existing, { atomicScope: 'prompt', status: 'PENDING' }));
  // 同 scope + COMMITTED → OK（不影响）
  assert.equal(storage.checkPendingUnique(existing, { atomicScope: 'prompt', status: 'COMMITTED' }), null);
  // 异 scope + PENDING → OK
  assert.equal(storage.checkPendingUnique(existing, { atomicScope: 'strategy', status: 'PENDING' }), null);
  // 空表 → OK
  assert.equal(storage.checkPendingUnique([], { atomicScope: 'prompt', status: 'PENDING' }), null);
});

test('apply() 集成：同 atomicScope 二次 propose 必被唯一索引拒 + logMetric Service 可调', async () => {
  const services = {}; const disposers = [];
  // mock：4 表各自独立存储（生产环境 dsh-storage-domain 按 table name 分）
  const tables = { proposals: new Map(), commits: new Map(), findings: new Map(), metrics_log: new Map() };
  plugin.apply({
    storageDomain: { open: async () => ({
      table: (name) => {
        const s = tables[name] || (tables[name] = new Map());
        return { entries: () => Array.from(s, ([id, v]) => ({ id, ...v })), put: async (id, v) => { s.set(id, v); }, close: async () => {} };
      },
      close: async () => {},
    }) },
    get: (n) => ({ 'agint.diagnosis': { queryAnnotations: async () => [], report: async () => ({}) }, 'agint.evolution': { queryFailures: async () => [] } })[n] || null,
    provide: (n, f) => { services[n] = f; },
    effect: (d) => { disposers.push(d); return () => {}; },
  });
  await new Promise((r) => setImmediate(r));

  const propose = services['agint.mutator.propose'];
  const fix = { source: 'attribution-driven', failureId: 'f-uniq-1', rootCause: 'PROMPT_DEFICIENCY', expectedEffect: 'baseline ≥95% in 7d', rollbackCondition: 'regression → rollback', atomicScope: 'prompt', promptPayload: { promptId: 'sys-prompt', oldText: 'old', newText: 'new', diffStrategy: 'unified_diff' } };
  // 第一次 → OK
  const p1 = await propose(fix);
  assert.ok(p1.id);
  // 第二次同 atomicScope → 必拒（设计稿 §二.6 v2 唯一索引）
  await assert.rejects(() => propose(fix), /atomicScope='prompt' 已有 PENDING/);

  // logMetric Service 可调（#4 commit/rollback 用）
  const log = services['agint.mutator.logMetric'];
  assert.equal(typeof log, 'function');
  const logOut = await log({ eventType: 'mutation.success', proposalId: p1.id, source: 'attribution-driven', kind: 'PROMPT_MUTATION', atomicScope: 'prompt', policyDecision: 'AUTO_DEPLOY' });
  assert.equal(logOut.eventType, 'mutation.success');
  // stats 含 metrics_log 计数
  const s = await services['agint.mutator.stats']();
  assert.equal(s.proposals, 1);
  assert.equal(s.metrics_log, 1);
  assert.equal(s.limits.METRICS_LOG, 200);
});