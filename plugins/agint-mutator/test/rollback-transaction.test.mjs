#!/usr/bin/env node
// agint-mutator / Sprint 10 #5 — rollback 三段式事务单元测试
// 覆盖：happy / smoke fail 自动恢复 / 同 pluginName 串行 / 不同 pluginName 并行。

import test from 'node:test';
import assert from 'node:assert/strict';
import * as plugin from '../lib/index.js';
import * as rollback from '../lib/rollback.js';
import * as mutex from '../lib/rollback-mutex.js';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const FIX = {
  prompt: { source: 'attribution-driven', failureId: 'f-p', rootCause: 'PROMPT_DEFICIENCY',
    expectedEffect: 'baseline 通过率 >= 95% 在 7 天', rollbackCondition: 'regression -> rollback', atomicScope: 'prompt',
    promptPayload: { promptId: 'sys-prompt', oldText: 'old prompt', newText: 'new prompt', diffStrategy: 'unified_diff' } },
  tool: { source: 'attribution-driven', failureId: 'f-t', rootCause: 'TOOL_GAP',
    expectedEffect: 'tool OK >= 80% within 7 天', rollbackCondition: 'harm >10% rollback', atomicScope: 'tool',
    toolPayload: { toolName: 'fetch-weather-api', signature: 'fetch_weather(c) -> P<W>', stubs: ['happy returns sample', 'sad returns error'], intent: '补天气工具' } },
  strategy: { source: 'evolution-reversed', failureId: 'f-s', rootCause: 'PLANNING_FAILURE',
    expectedEffect: 'reorder OK >= 80% within 7 天', rollbackCondition: 'manual rollback after 3 failures', atomicScope: 'strategy',
    strategyPayload: { strategyId: 'default-strategy', oldSteps: ['fetch_context', 'plan_subtasks', 'execute', 'verify'], newSteps: ['plan_subtasks', 'fetch_context', 'execute', 'verify'], ordering: 'replace' } },
};
const clone = (x) => JSON.parse(JSON.stringify(x));

// 注入 mock：commit 时 sandbox ok；rollback smoke 由 rollbackSmokeOk 控制
function makeEnv({ commitSandboxOk = true, rollbackSmokeOk = true, rollbackSmokeReason = 'mock', commitPolicyDecision = 'AUTO_DEPLOY' } = {}) {
  const workdir = mkdtempSync(join(tmpdir(), 'agint-mutator-rb-'));
  mkdirSync(join(workdir, 'plugins', 'agint-mutator', 'prompts'), { recursive: true });
  mkdirSync(join(workdir, 'plugins', 'agint-mutator', 'strategies'), { recursive: true });
  writeFileSync(join(workdir, 'plugins', 'agint-mutator', 'prompts', 'sys-prompt.md'), 'OLD prompt content');
  writeFileSync(join(workdir, 'plugins', 'agint-mutator', 'strategies', 'default-strategy.json'), JSON.stringify({ strategyId: 'default-strategy', ordering: 'before', steps: ['fetch_context', 'plan_subtasks', 'execute', 'verify'] }, null, 2));

  const tables = { proposals: new Map(), commits: new Map(), findings: new Map(), metrics_log: new Map() };
  const services = {};
  // 第 1 次 runSmoke = commit sandbox；后续 = rollback smoke
  let smokeCallCount = 0;
  const mockSandbox = {
    runSmoke: async ({ target }) => {
      smokeCallCount += 1;
      const isCommit = smokeCallCount === 1;
      const ok = isCommit ? commitSandboxOk : rollbackSmokeOk;
      return {
        target: { path: target.path, name: target.name },
        ok, mode: 'in-process', exitCode: ok ? 0 : 1,
        stdout: '', stderr: '',
        checks: [{ name: isCommit ? 'mock-commit-smoke' : 'mock-rollback-smoke', ok, detail: 'mock' }],
        reason: ok ? undefined : (isCommit ? 'commit-fail' : rollbackSmokeReason),
        durationMs: 1,
      };
    },
  };
  const mockPolicy = {
    decide: async () => ({ kind: commitPolicyDecision, score: 80, reason: 'mock-policy', triggeredBy: [], decidedAt: new Date().toISOString(), policyId: 'mock@v0' }),
    detectFalseHarmony: async () => ({}),
    setThresholds: async () => ({}),
    health: () => ({ serviceAvailable: true }),
    config: {},
  };
  plugin.apply({
    storageDomain: { open: async () => ({
      table: (name) => {
        const s = tables[name] || (tables[name] = new Map());
        return { entries: () => Array.from(s, ([id, v]) => ({ id, ...v })), put: async (id, v) => { s.set(id, v); }, close: async () => {} };
      }, close: async () => {},
    }) },
    get: (n) => {
      if (n === 'agint.qualitySandbox') return mockSandbox;
      if (n === 'agint.qualityPolicy') return mockPolicy;
      if (n === 'agint.diagnosis') return { queryAnnotations: async () => [], report: async () => ({}) };
      if (n === 'agint.evolution') return { queryFailures: async () => [] };
      return null;
    },
    provide: (n, f) => { services[n] = f; },
    effect: () => () => {},
  });
  return { services, tables, workdir, cleanup: () => rmSync(workdir, { recursive: true, force: true }) };
}

async function proposeAndCommit(fix, env, extra = {}) {
  const p = await env.services['agint.mutator.propose']({ ...clone(fix), targetPlugin: 'agint-mutator' });
  const c = await env.services['agint.mutator.commit']({ proposalId: p.id, repoRoot: env.workdir, ...extra });
  return { proposal: p, commit: c };
}

function resetState() { mutex._mutexReset(); rollback._snapshotReset(); }
test.beforeEach(() => resetState());
test.afterEach(() => resetState());

// ── happy path ─────────────────────────────────────────────────────

test('happy: smoke ok → rollback 返 { ok: true, restoredHash, rollbackTransactionId, preimageHashAtStart, smokeResult }', async () => {
  const env = makeEnv({ commitSandboxOk: true, rollbackSmokeOk: true });
  try {
    const { commit: c } = await proposeAndCommit(FIX.prompt, env);
    const rb = await env.services['agint.mutator.rollback']({ commitId: c.commitId, repoRoot: env.workdir });
    assert.equal(rb.ok, true);
    assert.equal(rb.restoredHash, c.preimageHash);
    // Sprint 10 #5 新增字段
    assert.ok(rb.rollbackTransactionId, 'rollbackTransactionId 应存在');
    assert.ok(rb.preimageHashAtStart, 'preimageHashAtStart 应存在');
    assert.ok(rb.smokeResult, 'smokeResult 应存在');
    assert.equal(rb.smokeResult.ok, true);
    assert.ok(Array.isArray(rb.smokeResult.checks), 'smokeResult.checks 应该是数组');
    // proposal.status='ROLLED_BACK'
    const proposal = Array.from(env.tables.proposals.values())[0];
    assert.equal(proposal.status, 'ROLLED_BACK');
  } finally { env.cleanup(); }
});

test('happy: smoke ok → evolution_log 写 mutation.rollback（不带 rollback-failed tags）', async () => {
  const env = makeEnv({ commitSandboxOk: true, rollbackSmokeOk: true });
  try {
    const { commit: c } = await proposeAndCommit(FIX.prompt, env);
    await env.services['agint.mutator.rollback']({ commitId: c.commitId, repoRoot: env.workdir });
    const ml = Array.from(env.tables.metrics_log.values());
    const rbMetric = ml.find((m) => m.eventType === 'mutation.rollback');
    assert.ok(rbMetric, 'mutation.rollback 应写入 metrics_log');
    assert.equal(rbMetric.policyDecision, undefined, 'happy path 不带 policyDecision 字段');
    // 不能有 policy_reject
    const rejectMetric = ml.find((m) => m.eventType === 'mutation.policy_reject');
    assert.ok(!rejectMetric, 'happy path 不应写 mutation.policy_reject');
  } finally { env.cleanup(); }
});

test('happy: preimageHashAtStart === 步骤 1 拍的真实快照（确定性，可重算）', async () => {
  const env = makeEnv({ commitSandboxOk: true, rollbackSmokeOk: true });
  try {
    const { commit: c } = await proposeAndCommit(FIX.prompt, env);
    // 拍 rollback 前 pluginDir 的 SHA-256（用 capturePreimageHash 独立重算）
    const pluginDir = join(env.workdir, 'plugins', 'agint-mutator');
    const { hash: expectedHash } = await rollback.capturePreimageHash(pluginDir);
    // 在 commit 已经修改了 prompt 内容的情况下，preimageHashAtStart 应该是 commit **之后**的状态
    //（rollback 事务在恢复之前拍的快照）
    const rb = await env.services['agint.mutator.rollback']({ commitId: c.commitId, repoRoot: env.workdir });
    assert.equal(rb.preimageHashAtStart, expectedHash, 'preimageHashAtStart 应等于 capturePreimageHash 重算结果');
    // restoredHash 应等于 commit 时的 preimageHash（即恢复成 commit 前的原文件）
    assert.equal(rb.restoredHash, c.preimageHash);
  } finally { env.cleanup(); }
});

// ── 失败自动恢复 ───────────────────────────────────────────────────

test('fail: smoke ok=false → rollback 返 { ok: false, error: rollback-failed-smoke, smokeResult.ok=false }', async () => {
  const env = makeEnv({ commitSandboxOk: true, rollbackSmokeOk: false, rollbackSmokeReason: 'plugin-not-found' });
  try {
    const { commit: c } = await proposeAndCommit(FIX.prompt, env);
    const rb = await env.services['agint.mutator.rollback']({ commitId: c.commitId, repoRoot: env.workdir });
    assert.equal(rb.ok, false);
    assert.match(rb.error, /rollback-failed-smoke/);
    assert.equal(rb.smokeResult.ok, false);
    assert.equal(rb.smokeResult.reason, 'plugin-not-found');
    // 新字段仍存在
    assert.ok(rb.rollbackTransactionId, 'rollbackTransactionId 应存在');
    assert.ok(rb.preimageHashAtStart, 'preimageHashAtStart 应存在');
  } finally { env.cleanup(); }
});

test('fail: smoke fail → 自动恢复到 step 1 拍的内容（文件内容等于 step 1 前的状态）', async () => {
  const env = makeEnv({ commitSandboxOk: true, rollbackSmokeOk: false, rollbackSmokeReason: 'mock-fail' });
  try {
    const original = readFileSync(join(env.workdir, 'plugins/agint-mutator/prompts/sys-prompt.md'), 'utf8');
    const { commit: c } = await proposeAndCommit(FIX.prompt, env);
    // commit 后文件是新内容
    const afterCommit = readFileSync(join(env.workdir, 'plugins/agint-mutator/prompts/sys-prompt.md'), 'utf8');
    assert.notEqual(afterCommit, original);
    // rollback：smoke 失败 → 应当自动恢复到 step 1 拍的安全位
    // step 1 是在事务开始时拍的，那时 prompt.md 已经是 commit 后的 'new prompt' 状态
    // 所以「恢复到 step 1 拍的安全位」= 文件内容回到 commit 后、rollback 前的状态（即 'new prompt'）
    const rb = await env.services['agint.mutator.rollback']({ commitId: c.commitId, repoRoot: env.workdir });
    assert.equal(rb.ok, false);
    assert.equal(rb.recovered, true, 'recovered 标志应为 true');
    // 文件内容应当仍是 commit 后的新内容（因为 step 1 拍的是 commit 后的状态，自动恢复就回到这里）
    const afterAutoRecover = readFileSync(join(env.workdir, 'plugins/agint-mutator/prompts/sys-prompt.md'), 'utf8');
    assert.equal(afterAutoRecover, afterCommit, '自动恢复后文件 = step 1 拍的安全位 = commit 后未变的状态');
    // 注意：与「恢复成原始 preimage 内容」不同——preimage 是 commit 时的旧内容，事务 step 1 是在 commit 之后拍的
  } finally { env.cleanup(); }
});

test('fail: smoke fail → metrics_log 写 mutation.policy_reject + policyDecision=ABSTAIN', async () => {
  const env = makeEnv({ commitSandboxOk: true, rollbackSmokeOk: false, rollbackSmokeReason: 'mock-fail' });
  try {
    const { commit: c } = await proposeAndCommit(FIX.prompt, env);
    await env.services['agint.mutator.rollback']({ commitId: c.commitId, repoRoot: env.workdir });
    const ml = Array.from(env.tables.metrics_log.values());
    const rejectMetric = ml.find((m) => m.eventType === 'mutation.policy_reject');
    assert.ok(rejectMetric, 'mutation.policy_reject 应写入');
    assert.equal(rejectMetric.policyDecision, 'ABSTAIN');
    assert.match(rejectMetric.reason, /rollback-smoke-failed|mock-fail/);
    // 不能有 mutation.rollback（因为事务失败，没改 proposal.status）
    const rbMetric = ml.find((m) => m.eventType === 'mutation.rollback');
    assert.ok(!rbMetric, '失败路径不应写 mutation.rollback');
  } finally { env.cleanup(); }
});

// ── 并发 ─────────────────────────────────────────────────────────

test('concurrent: 同 pluginName 两次 rollback → 串行执行（maxInFlight ≤ 1）', async () => {
  const env = makeEnv({ commitSandboxOk: true, rollbackSmokeOk: true });
  try {
    const { commit: c1 } = await proposeAndCommit(FIX.prompt, env);
    const { commit: c2 } = await proposeAndCommit(FIX.prompt, env);
    let maxInFlight = 0;
    let observed = false;
    const sample = setInterval(() => {
      const st = mutex._mutexState();
      if (st.keys.length > maxInFlight) maxInFlight = st.keys.length;
      if (st.keys.length >= 1) observed = true;
    }, 1);
    const [rb1, rb2] = await Promise.all([
      env.services['agint.mutator.rollback']({ commitId: c1.commitId, repoRoot: env.workdir }),
      env.services['agint.mutator.rollback']({ commitId: c2.commitId, repoRoot: env.workdir }),
    ]);
    clearInterval(sample);
    assert.equal(rb1.ok, true);
    assert.equal(rb2.ok, true);
    assert.ok(maxInFlight <= 1, `同 pluginName 串行：maxInFlight=${maxInFlight} 应 ≤ 1`);
    assert.ok(observed, '应观察到 mutex 占用状态');
  } finally { env.cleanup(); }
});

test('concurrent: 不同 pluginName → 并行（总耗时 < 500ms）', async () => {
  // 直接调 runRollbackTransaction 测并行语义（绕过 index.js 的 pluginName 派生）
  const mkCtx = () => ({
    get: (n) => {
      if (n === 'agint.qualitySandbox') return { runSmoke: async () => ({ ok: true, checks: [], reason: undefined }) };
      if (n === 'agint.qualityPolicy') return { decide: async () => ({ kind: 'AUTO_DEPLOY' }) };
      return null;
    },
  });
  const ctxA = mkCtx(); const ctxB = mkCtx();
  const wdA = mkdtempSync(join(tmpdir(), 'agint-rb-A-'));
  const wdB = mkdtempSync(join(tmpdir(), 'agint-rb-B-'));
  for (const [wd, name, content] of [[wdA, 'plugin-A', 'A'], [wdB, 'plugin-B', 'B']]) {
    mkdirSync(join(wd, 'plugins', name, 'prompts'), { recursive: true });
    writeFileSync(join(wd, 'plugins', name, 'prompts', 'p.md'), `${content} content`);
  }
  const t0 = Date.now();
  const [resA, resB] = await Promise.all([
    rollback.runRollbackTransaction({
      ctx: ctxA, commitEntry: { preimageContent: 'A-preimage', targetPath: 'plugins/plugin-A/prompts/p.md' },
      proposal: { kind: 'PROMPT_MUTATION' }, repoRoot: wdA, pluginName: 'plugin-A',
      targetPath: 'plugins/plugin-A/prompts/p.md',
    }),
    rollback.runRollbackTransaction({
      ctx: ctxB, commitEntry: { preimageContent: 'B-preimage', targetPath: 'plugins/plugin-B/prompts/p.md' },
      proposal: { kind: 'PROMPT_MUTATION' }, repoRoot: wdB, pluginName: 'plugin-B',
      targetPath: 'plugins/plugin-B/prompts/p.md',
    }),
  ]);
  const total = Date.now() - t0;
  assert.equal(resA.smokeResult.ok, true);
  assert.equal(resB.smokeResult.ok, true);
  rmSync(wdA, { recursive: true, force: true });
  rmSync(wdB, { recursive: true, force: true });
  assert.ok(total < 500, `并行总耗时 ${total}ms 应 < 500ms`);
});

// ── capturePreimageHash 纯函数测试 ───────────────────────────────

test('capturePreimageHash: 同一目录两次调用 → 同一 hash（确定性 + 排除 node_modules）', async () => {
  const wd = mkdtempSync(join(tmpdir(), 'agint-cap-'));
  mkdirSync(join(wd, 'a')); mkdirSync(join(wd, 'b'));
  writeFileSync(join(wd, 'a', '1.txt'), 'alpha');
  writeFileSync(join(wd, 'b', '2.txt'), 'beta');
  mkdirSync(join(wd, 'node_modules'));
  writeFileSync(join(wd, 'node_modules', 'big.txt'), 'ignored');
  const r1 = await rollback.capturePreimageHash(wd);
  const r2 = await rollback.capturePreimageHash(wd);
  assert.equal(r1.hash, r2.hash);
  assert.equal(r1.fileCount, 2);
  rmSync(wd, { recursive: true, force: true });
});

test('capturePreimageHash: 文件内容变化 → hash 变化', async () => {
  const wd = mkdtempSync(join(tmpdir(), 'agint-cap2-'));
  mkdirSync(join(wd, 'x'));
  writeFileSync(join(wd, 'x', 'f.txt'), 'v1');
  const h1 = (await rollback.capturePreimageHash(wd)).hash;
  writeFileSync(join(wd, 'x', 'f.txt'), 'v2');
  const h2 = (await rollback.capturePreimageHash(wd)).hash;
  assert.notEqual(h1, h2);
  rmSync(wd, { recursive: true, force: true });
});
