#!/usr/bin/env node
// agint-mutator / Sprint 8 #5：3 条变异来源 Service unit test
// 覆盖：happy / 降级 / 0 数据冒烟 / 模块级 pure helpers。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as plugin from '../lib/index.js';

function buildEnv({ deps = null } = {}) {
  const tables = { proposals: new Map(), commits: new Map(), findings: new Map(), metrics_log: new Map() };
  const services = {};
  plugin.apply({
    storageDomain: { open: async () => ({
      table: (n) => { const s = tables[n] || (tables[n] = new Map()); return { entries: () => Array.from(s, ([id, v]) => ({ id, ...v })), put: async (id, v) => { s.set(id, v); } }; },
      close: async () => {},
    }) },
    get: (n) => (deps === null ? null : (n === 'agint.diagnosis' ? deps.diagnosis : n === 'agint.dream' ? deps.dream : n === 'agint.evolution' ? deps.evolution : null)),
    provide: (n, f) => { services[n] = f; },
    effect: () => () => {},
  });
  return { services, tables };
}

// 通用 propose() 软依赖 mock（happy 路径必须满足 #3 propose 的 queryAnnotations / report / queryFailures）
const PROPOSE_DEPS = { diagnosis: { queryAnnotations: async () => [], report: async () => ({}) }, evolution: { queryFailures: async () => [] } };

// ── attributionDriven ──
test('attributionDriven happy PROMPT_DEFICIENCY + trajectory→ok:true+proposal 落库', async () => {
  const { services, tables } = buildEnv({ deps: { ...PROPOSE_DEPS, diagnosis: { ...PROPOSE_DEPS.diagnosis, annotate: async () => ({ rootCause: 'PROMPT_DEFICIENCY', evidence: 'agint-mutator 调用' }) } } });
  const out = await services['agint.mutator.attributionDriven']({ failureId: 'f-1', trajectory: { metadata: { targetPlugin: 'agint-mutator' } } });
  assert.equal(out.ok, true); assert.equal(out.proposal.kind, 'PROMPT_MUTATION'); assert.equal(out.proposal.source, 'attribution-driven');
  assert.equal(tables.proposals.size, 1); assert.equal(tables.findings.size, 0);
});
test('attributionDriven happy TOOL_GAP → TOOL_SYNTHESIS + targetPlugin 从 evidence 派生', async () => {
  const { services } = buildEnv({ deps: { ...PROPOSE_DEPS, diagnosis: { ...PROPOSE_DEPS.diagnosis, annotate: async () => ({ rootCause: 'TOOL_GAP', evidence: 'failure in agint-diagnosis plugin' }) } } });
  const out = await services['agint.mutator.attributionDriven']({ failureId: 'f-t', trajectory: {} });
  assert.equal(out.ok, true); assert.equal(out.proposal.kind, 'TOOL_SYNTHESIS'); assert.equal(out.proposal.atomicScope, 'tool');
});
test('attributionDriven degrade diagnosis=null→ok:false+root-cause-uncertain+finding', async () => {
  const { services, tables } = buildEnv({ deps: { diagnosis: null } });
  const out = await services['agint.mutator.attributionDriven']({ failureId: 'f', trajectory: {} });
  assert.equal(out.ok, false); assert.equal(out.reason, 'root-cause-uncertain'); assert.ok(out.finding);
  assert.equal(tables.findings.size, 1); assert.equal(tables.proposals.size, 0);
});
test('attributionDriven degrade rootCause=UNCERTAIN→降级', async () => {
  const { services } = buildEnv({ deps: { diagnosis: { ...PROPOSE_DEPS.diagnosis, annotate: async () => ({ rootCause: 'UNCERTAIN' }) } } });
  const out = await services['agint.mutator.attributionDriven']({ failureId: 'f', trajectory: {} });
  assert.equal(out.ok, false); assert.equal(out.reason, 'root-cause-uncertain');
});
test('attributionDriven degrade annotate 抛错→降级不抛错', async () => {
  const { services } = buildEnv({ deps: { diagnosis: { ...PROPOSE_DEPS.diagnosis, annotate: async () => { throw new Error('boom'); } } } });
  const out = await services['agint.mutator.attributionDriven']({ failureId: 'f', trajectory: {} });
  assert.equal(out.ok, false); assert.ok(/annotate 抛错|boom/.test(out.finding.message));
});
test('attributionDriven degrade deriveTargetPlugin 全失败→降级', async () => {
  const { services } = buildEnv({ deps: { diagnosis: { ...PROPOSE_DEPS.diagnosis, annotate: async () => ({ rootCause: 'PROMPT_DEFICIENCY', evidence: 'no plugin name' }) } } });
  const out = await services['agint.mutator.attributionDriven']({ failureId: 'f', trajectory: { foo: 'bar' } });
  assert.equal(out.ok, false); assert.ok(/deriveTargetPlugin 4 优先序全失败/.test(out.finding.message));
});
test('attributionDriven degrade 缺 failureId→降级', async () => {
  const { services } = buildEnv({ deps: { diagnosis: { ...PROPOSE_DEPS.diagnosis, annotate: async () => ({ rootCause: 'TOOL_GAP' }) } } });
  const out = await services['agint.mutator.attributionDriven']({ trajectory: {} });
  assert.equal(out.ok, false); assert.equal(out.reason, 'root-cause-uncertain');
});

// ── dreamRandom ──
test('dreamRandom happy seed=42→1-3 个 proposal+source=dream-random', async () => {
  const { services, tables } = buildEnv({ deps: { ...PROPOSE_DEPS, dream: { sweep: async () => ({}), status: async () => ({}) } } });
  const out = await services['agint.mutator.dreamRandom']({ seed: 42, context: 'agint-mutator meta' });
  assert.equal(out.ok, true); assert.ok(out.proposals.length >= 1 && out.proposals.length <= 3);
  for (const p of out.proposals) assert.equal(p.source, 'dream-random');
  assert.equal(tables.proposals.size, out.proposals.length);
});
test('dreamRandom degrade dream=null→ok:false+dream-unavailable+finding', async () => {
  const { services, tables } = buildEnv({ deps: { dream: null } });
  const out = await services['agint.mutator.dreamRandom']({ seed: 1 });
  assert.equal(out.ok, false); assert.equal(out.reason, 'dream-unavailable'); assert.ok(out.finding);
  assert.equal(tables.findings.size, 1); assert.equal(tables.proposals.size, 0);
});
test('dreamRandom degrade 缺 seed→Date.now() 兜底仍出 proposal', async () => {
  const { services } = buildEnv({ deps: { ...PROPOSE_DEPS, dream: { sweep: async () => ({}), status: async () => ({}) } } });
  const out = await services['agint.mutator.dreamRandom']({ context: 'agint-mutator meta' });
  assert.equal(out.ok, true); assert.ok(out.proposals.length >= 1);
});

// ── evolutionReversed ──
test('evolutionReversed happy failure_pattern category=integration→ok:true+TOOL_SYNTHESIS', async () => {
  const { services, tables } = buildEnv({ deps: { ...PROPOSE_DEPS, evolution: { ...PROPOSE_DEPS.evolution, queryFailures: async () => [{ id: 'fp-1', pattern: 'stubs 太长 TOOL_GAP', category: 'integration', evidence: 'in agint-diagnosis' }] } } });
  const out = await services['agint.mutator.evolutionReversed']({ patternSubstring: 'TOOL_GAP' });
  assert.equal(out.ok, true); assert.equal(out.proposal.source, 'evolution-reversed'); assert.equal(out.proposal.kind, 'TOOL_SYNTHESIS');
  assert.equal(tables.proposals.size, 1);
});
test('evolutionReversed happy category=correctness + plan→STRATEGY_REWRITE', async () => {
  const { services } = buildEnv({ deps: { ...PROPOSE_DEPS, evolution: { ...PROPOSE_DEPS.evolution, queryFailures: async () => [{ id: 'fp-3', pattern: 'strategy steps 顺序错 PLANNING_FAILURE', category: 'correctness', evidence: 'agint-mutator context' }] } } });
  const out = await services['agint.mutator.evolutionReversed']({ patternSubstring: 'strategy' });
  assert.equal(out.ok, true); assert.equal(out.proposal.kind, 'STRATEGY_REWRITE');
});
test('evolutionReversed degrade evolution=null→ok:false+no-pattern-match+finding', async () => {
  const { services, tables } = buildEnv({ deps: { evolution: null } });
  const out = await services['agint.mutator.evolutionReversed']({ patternSubstring: 'x' });
  assert.equal(out.ok, false); assert.equal(out.reason, 'no-pattern-match'); assert.ok(out.finding);
  assert.equal(tables.findings.size, 1);
});
test('evolutionReversed degrade queryFailures 空→0 匹配降级', async () => {
  const { services } = buildEnv({ deps: { evolution: { queryFailures: async () => [] } } });
  const out = await services['agint.mutator.evolutionReversed']({ patternSubstring: 'nomatch' });
  assert.equal(out.ok, false); assert.equal(out.reason, 'no-pattern-match');
});
test('evolutionReversed degrade category=security 被过滤→0 匹配降级', async () => {
  const { services } = buildEnv({ deps: { evolution: { queryFailures: async () => [{ id: 'fp-sec', pattern: 'TOOL_GAP', category: 'security' }] } } });
  const out = await services['agint.mutator.evolutionReversed']({ patternSubstring: 'TOOL_GAP' });
  assert.equal(out.ok, false); assert.ok(/仅 category ∈ \{correctness, integration\}/.test(out.finding.message));
});
test('evolutionReversed degrade 缺 patternSubstring→降级', async () => {
  const { services } = buildEnv({ deps: { evolution: { queryFailures: async () => [] } } });
  const out = await services['agint.mutator.evolutionReversed']({});
  assert.equal(out.ok, false); assert.ok(/缺 patternSubstring/.test(out.finding.message));
});

// ── 0 数据冒烟（设计稿 §二.4 末段验收） ──
test('降级冒烟：3 条 Service 全 0 数据（所有软依赖 null）→ 全部 ok:false 不抛错，finding 落库', async () => {
  const { services, tables } = buildEnv({ deps: { diagnosis: null, dream: null, evolution: null } });
  const r1 = await services['agint.mutator.attributionDriven']({ failureId: 'f', trajectory: {} });
  const r2 = await services['agint.mutator.dreamRandom']({ seed: 1 });
  const r3 = await services['agint.mutator.evolutionReversed']({ patternSubstring: 'x' });
  assert.equal(r1.ok, false); assert.equal(r1.reason, 'root-cause-uncertain'); assert.ok(r1.finding);
  assert.equal(r2.ok, false); assert.equal(r2.reason, 'dream-unavailable'); assert.ok(r2.finding);
  assert.equal(r3.ok, false); assert.equal(r3.reason, 'no-pattern-match'); assert.ok(r3.finding);
  assert.equal(tables.findings.size, 3); assert.equal(tables.proposals.size, 0);
});

// ── 模块级 pure helpers 独立可测 ──
test('_deriveTargetPlugin: 4 优先序覆盖', () => {
  assert.equal(plugin._deriveTargetPlugin({ metadata: { targetPlugin: 'agint-mutator' }, trajectory: 'agint-diagnosis' }), 'agint-mutator');
  assert.equal(plugin._deriveTargetPlugin({ targetPlugin: 'agint-mutator' }), 'agint-mutator');
  assert.equal(plugin._deriveTargetPlugin({ trajectory: 'in agint-evolution-memory/lib/foo.js' }), 'agint-evolution-memory');
  assert.equal(plugin._deriveTargetPlugin({}), null);
  assert.equal(plugin._deriveTargetPlugin(null), null);
});
test('_reversePayload: STRATEGY 反转 / TOOL 加 stub / PROMPT newText / null 兜底', () => {
  const r1 = plugin._reversePayload({ pattern: 'strategy steps 顺序错' }, { oldSteps: ['a','b','c'], newSteps: ['a','b','c'], ordering: 'replace' }, 'STRATEGY_REWRITE');
  assert.deepEqual(r1.newSteps, ['c','b','a']);
  const r2 = plugin._reversePayload({ pattern: 'tool gap' }, { toolName: 't', stubs: ['x'] }, 'TOOL_SYNTHESIS');
  assert.ok(r2.stubs.length >= 2);
  assert.equal(plugin._reversePayload({}, null, 'PROMPT_MUTATION'), null);
  assert.equal(plugin._reversePayload({}, {}, 'PROMPT_MUTATION'), null);
});
test('_pickKindFromSeed: 同 seed 同结果，异 seed 多样', () => {
  const pool = ['PROMPT_MUTATION', 'TOOL_SYNTHESIS', 'STRATEGY_REWRITE'];
  const a = plugin._pickKindFromSeed(42, pool, 2);
  const b = plugin._pickKindFromSeed(42, pool, 2);
  assert.deepEqual(a, b);
  assert.ok(a.length >= 1 && a.length <= 2);
  assert.equal(new Set(a).size, a.length);
});
test('_scopeToRoot / _scopeOfKind 双向映射', () => {
  assert.equal(plugin._scopeToRoot('prompt'), 'PROMPT_DEFICIENCY');
  assert.equal(plugin._scopeToRoot('tool'), 'TOOL_GAP');
  assert.equal(plugin._scopeOfKind('PROMPT_MUTATION'), 'prompt');
  assert.equal(plugin._scopeOfKind('TOOL_SYNTHESIS'), 'tool');
});
test('_patternToKind: 3 类关键词命中 + 默认 PROMPT', () => {
  assert.equal(plugin._patternToKind({ pattern: 'tool stubs too long' }), 'TOOL_SYNTHESIS');
  assert.equal(plugin._patternToKind({ pattern: 'strategy step order wrong' }), 'STRATEGY_REWRITE');
  assert.equal(plugin._patternToKind({ pattern: 'prompt too short' }), 'PROMPT_MUTATION');
});