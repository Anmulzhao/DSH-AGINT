#!/usr/bin/env node
// agint-mutator / commit + rollback unit test — `node test/commit-rollback.test.mjs` 一行能跑。
// Sprint 8 #4：commit 7 步 + rollback 5 步闭环（哈希校验 + 文件落点表 + mutation.* 事件）。
// 设计：tmpdir 隔离文件系统；mock sandbox + policy + diagnosis/evolution；≥8 用例。

import test from 'node:test';
import assert from 'node:assert/strict';
import * as plugin from '../lib/index.js';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { LIMITS } = plugin;

// ── fixtures ────────────────────────────────────────────────────────
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

// ── helpers ────────────────────────────────────────────────────────

function makeEnv({ sandboxOk = true, sandboxReason, policyDecision = 'AUTO_DEPLOY', policyReason, writePreimage = true } = {}) {
  const workdir = mkdtempSync(join(tmpdir(), 'agint-mutator-'));
  // pre-write prompt file content + strategies JSON
  if (writePreimage) {
    mkdirSync(join(workdir, 'plugins', 'agint-mutator', 'prompts'), { recursive: true });
    mkdirSync(join(workdir, 'plugins', 'agint-mutator', 'strategies'), { recursive: true });
    writeFileSync(join(workdir, 'plugins', 'agint-mutator', 'prompts', 'sys-prompt.md'), 'OLD prompt content');
    writeFileSync(join(workdir, 'plugins', 'agint-mutator', 'strategies', 'default-strategy.json'), JSON.stringify({ strategyId: 'default-strategy', ordering: 'before', steps: ['fetch_context', 'plan_subtasks', 'execute', 'verify'] }, null, 2));
  }
  const tables = { proposals: new Map(), commits: new Map(), findings: new Map(), metrics_log: new Map() };
  const services = {};
  const mockSandbox = {
    runSmoke: async ({ target }) => ({
      target: { path: target.path, name: target.name },
      ok: sandboxOk, mode: 'in-process', exitCode: sandboxOk ? 0 : 1,
      stdout: '', stderr: '', checks: [{ name: 'mock-smoke', ok: sandboxOk, detail: 'mock' }],
      reason: sandboxReason,
      durationMs: 1,
    }),
  };
  const mockPolicy = {
    decide: async () => ({
      kind: policyDecision, score: 80, reason: policyReason || `mock-policy-${policyDecision}`,
      triggeredBy: [], decidedAt: new Date().toISOString(), policyId: 'mock@v0',
    }),
    detectFalseHarmony: async () => ({}),
    setThresholds: async () => ({}),
    health: () => ({ serviceAvailable: true }),
    config: {},
  };
  plugin.apply({
    storageDomain: { open: async () => ({
      table: (name) => {
        const s = tables[name] || (tables[name] = new Map());
        return {
          entries: () => Array.from(s, ([id, v]) => ({ id, ...v })),
          put: async (id, v) => { s.set(id, v); },
          close: async () => {},
        };
      },
      close: async () => {},
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
  const { services } = env;
  // Sprint 8 #4：targetPlugin 通过 propose() 透传 → 内部 _targetPlugin 字段；commit 读内部字段
  const p = await services['agint.mutator.propose']({
    ...clone(fix),
    targetPlugin: 'agint-mutator',
  });
  const c = await services['agint.mutator.commit']({
    proposalId: p.id,
    repoRoot: env.workdir,
    ...extra,
  });
  return { proposal: p, commit: c };
}

// ── commit happy path：3 类 mutation 各 1 ───────────────────────────

test('commit happy PROMPT_MUTATION: sandbox ok + policy AUTO_DEPLOY → mutation.success + status=COMMITTED', async () => {
  const env = makeEnv({ sandboxOk: true, policyDecision: 'AUTO_DEPLOY' });
  try {
    const { commit: c } = await proposeAndCommit(FIX.prompt, env);
    assert.equal(c.ok, true);
    assert.ok(c.commitId.length > 0);
    assert.ok(c.postimageHash.length > 0);
    assert.equal(c.policyDecision, 'AUTO_DEPLOY');
    // 文件已写
    const written = readFileSync(join(env.workdir, 'plugins/agint-mutator/prompts/sys-prompt.md'), 'utf8');
    assert.equal(written, 'new prompt'); // payload.newText
    // commits 表写入
    assert.equal(env.tables.commits.size, 1);
    // metrics_log 写入 mutation.success
    const metricsLog = Array.from(env.tables.metrics_log.values());
    assert.equal(metricsLog.length, 1);
    assert.equal(metricsLog[0].eventType, 'mutation.success');
    assert.equal(metricsLog[0].policyDecision, 'AUTO_DEPLOY');
    // proposals.status='COMMITTED'
    const proposal = Array.from(env.tables.proposals.values()).find((p) => p.status === 'COMMITTED');
    assert.ok(proposal, 'should have a COMMITTED proposal');
  } finally { env.cleanup(); }
});

test('commit happy TOOL_SYNTHESIS: 新建文件 + sandbox ok + AUTO_DEPLOY', async () => {
  const env = makeEnv({ sandboxOk: true, policyDecision: 'AUTO_DEPLOY' });
  try {
    const { commit: c } = await proposeAndCommit(FIX.tool, env);
    assert.equal(c.ok, true);
    assert.equal(c.policyDecision, 'AUTO_DEPLOY');
    // 文件新建
    const absTool = join(env.workdir, 'plugins/agint-mutator/tools/fetch-weather-api.js');
    assert.ok(existsSync(absTool));
    const written = readFileSync(absTool, 'utf8');
    assert.ok(written.includes('Auto-generated tool: fetch-weather-api'));
    assert.ok(written.includes('happy returns sample'));
    // commits 表写入
    assert.equal(env.tables.commits.size, 1);
    // audit 字段有 sandboxResult='ok'
    const commitEntry = Array.from(env.tables.commits.values())[0];
    assert.equal(commitEntry.audit.sandboxResult, 'ok');
    assert.equal(commitEntry.preimageContent, ''); // TOOL_SYNTHESIS preimageContent 为空（文件原本不存在）
    // metrics_log mutation.success
    assert.equal(Array.from(env.tables.metrics_log.values())[0].eventType, 'mutation.success');
  } finally { env.cleanup(); }
});

test('commit happy STRATEGY_REWRITE: 整文件替换 + sandbox ok + PENDING_REVIEW', async () => {
  const env = makeEnv({ sandboxOk: true, policyDecision: 'PENDING_REVIEW' });
  try {
    const { commit: c } = await proposeAndCommit(FIX.strategy, env);
    assert.equal(c.ok, true);
    assert.equal(c.policyDecision, 'PENDING_REVIEW');
    // 文件已替换为新 steps
    const written = JSON.parse(readFileSync(join(env.workdir, 'plugins/agint-mutator/strategies/default-strategy.json'), 'utf8'));
    assert.deepEqual(written.steps, ['plan_subtasks', 'fetch_context', 'execute', 'verify']);
    assert.equal(written.ordering, 'replace');
    // metrics_log mutation.success + policyDecision='PENDING_REVIEW'
    const ml = Array.from(env.tables.metrics_log.values())[0];
    assert.equal(ml.eventType, 'mutation.success');
    assert.equal(ml.policyDecision, 'PENDING_REVIEW');
  } finally { env.cleanup(); }
});

// ── commit policy REJECT 路径：恢复 preimage + mutation.failure + status=REJECTED ──

test('commit policy REJECT：sandbox ok 但 policy 拒 → mutation.failure + REJECTED + preimage 恢复', async () => {
  const env = makeEnv({ sandboxOk: true, policyDecision: 'REJECT', policyReason: 'low-trust' });
  try {
    // 先把原始 prompt 内容存一份（事后比对）
    const original = readFileSync(join(env.workdir, 'plugins/agint-mutator/prompts/sys-prompt.md'), 'utf8');
    // propose 后 commit 应当抛错（policy REJECT）
    await assert.rejects(async () => {
      await proposeAndCommit(FIX.prompt, env);
    }, /policyDecision=REJECT/);
    // 文件应当恢复为旧内容
    const restored = readFileSync(join(env.workdir, 'plugins/agint-mutator/prompts/sys-prompt.md'), 'utf8');
    assert.equal(restored, original, 'preimage 应当恢复');
    // commits 表还是写了一份（commit 表先写后判定）
    assert.ok(env.tables.commits.size >= 1, 'commit entry 落了，便于审计');
    // proposal.status='REJECTED'
    const proposal = Array.from(env.tables.proposals.values()).find((p) => p.status === 'REJECTED');
    assert.ok(proposal, 'proposal.status 应该 REJECTED');
    // metrics_log mutation.failure
    const failed = Array.from(env.tables.metrics_log.values()).find((m) => m.eventType === 'mutation.failure');
    assert.ok(failed, 'mutation.failure 应该被写入');
    assert.equal(failed.policyDecision, 'REJECT');
    // audit.rollbackTrigger = 原 rollbackCondition 字符串
    const commitEntry = Array.from(env.tables.commits.values())[0];
    assert.equal(commitEntry.audit.rollbackTrigger, 'regression -> rollback');
  } finally { env.cleanup(); }
});

// ── rollback happy path：3 类 mutation 各 1 ─────────────────────────

test('rollback happy PROMPT_MUTATION：commit 后 rollback → file 还原', async () => {
  const env = makeEnv({ sandboxOk: true, policyDecision: 'AUTO_DEPLOY' });
  try {
    const original = readFileSync(join(env.workdir, 'plugins/agint-mutator/prompts/sys-prompt.md'), 'utf8');
    const { commit: c } = await proposeAndCommit(FIX.prompt, env);
    const written = readFileSync(join(env.workdir, 'plugins/agint-mutator/prompts/sys-prompt.md'), 'utf8');
    assert.notEqual(written, original);
    // rollback
    const rb = await env.services['agint.mutator.rollback']({
      commitId: c.commitId, repoRoot: env.workdir,
    });
    assert.equal(rb.ok, true);
    // restoredHash 应等于 preimageHash
    assert.equal(rb.restoredHash, c.preimageHash);
    // 文件还原
    const restored = readFileSync(join(env.workdir, 'plugins/agint-mutator/prompts/sys-prompt.md'), 'utf8');
    assert.equal(restored, original);
    // proposal.status = 'ROLLED_BACK'
    const proposal = Array.from(env.tables.proposals.values())[0];
    assert.equal(proposal.status, 'ROLLED_BACK');
    // metrics_log mutation.rollback
    const rbMetric = Array.from(env.tables.metrics_log.values()).find((m) => m.eventType === 'mutation.rollback');
    assert.ok(rbMetric);
  } finally { env.cleanup(); }
});

test('rollback happy TOOL_SYNTHESIS：commit 后 rollback → 文件应 unlink（回到不存在）', async () => {
  const env = makeEnv({ sandboxOk: true, policyDecision: 'AUTO_DEPLOY', writePreimage: false });
  try {
    const { commit: c } = await proposeAndCommit(FIX.tool, env);
    const absTool = join(env.workdir, 'plugins/agint-mutator/tools/fetch-weather-api.js');
    assert.ok(existsSync(absTool), 'commit 后文件存在');
    // rollback
    const rb = await env.services['agint.mutator.rollback']({
      commitId: c.commitId, repoRoot: env.workdir,
    });
    assert.equal(rb.ok, true);
    assert.equal(rb.restoredHash, c.preimageHash);
    // 文件应已删除
    assert.ok(!existsSync(absTool), 'TOOL_SYNTHESIS rollback 后文件应 unlink');
    // metrics_log mutation.rollback
    const rbMetric = Array.from(env.tables.metrics_log.values()).find((m) => m.eventType === 'mutation.rollback');
    assert.ok(rbMetric);
  } finally { env.cleanup(); }
});

test('rollback happy STRATEGY_REWRITE：commit 后 rollback → JSON 还原', async () => {
  const env = makeEnv({ sandboxOk: true, policyDecision: 'AUTO_DEPLOY' });
  try {
    const original = readFileSync(join(env.workdir, 'plugins/agint-mutator/strategies/default-strategy.json'), 'utf8');
    const { commit: c } = await proposeAndCommit(FIX.strategy, env);
    const written = readFileSync(join(env.workdir, 'plugins/agint-mutator/strategies/default-strategy.json'), 'utf8');
    assert.notEqual(written, original);
    // rollback
    const rb = await env.services['agint.mutator.rollback']({
      commitId: c.commitId, repoRoot: env.workdir,
    });
    assert.equal(rb.ok, true);
    assert.equal(rb.restoredHash, c.preimageHash);
    // JSON 还原
    const restored = JSON.parse(readFileSync(join(env.workdir, 'plugins/agint-mutator/strategies/default-strategy.json'), 'utf8'));
    assert.deepEqual(restored, JSON.parse(original));
  } finally { env.cleanup(); }
});

// ── rollback 失败语义：preimageContent 篡改 → 抛错 + findings ────────

test('rollback 失败：篡改 commits.preimageContent → SHA-256 不匹配 + 写 findings + 抛错', async () => {
  const env = makeEnv({ sandboxOk: true, policyDecision: 'AUTO_DEPLOY' });
  try {
    const { commit: c } = await proposeAndCommit(FIX.prompt, env);
    // 篡改 commits.preimageContent（模拟外部攻击 / 数据漂移）
    const commitEntry = Array.from(env.tables.commits.values())[0];
    commitEntry.preimageContent = 'tampered content';
    env.tables.commits.set(commitEntry.id, commitEntry);
    // rollback 必抛错
    await assert.rejects(
      () => env.services['agint.mutator.rollback']({ commitId: c.commitId, repoRoot: env.workdir }),
      /SHA-256 校验失败/,
    );
    // 写 findings 表
    const finding = Array.from(env.tables.findings.values()).find((f) => /SHA-256/.test(f.message));
    assert.ok(finding, '应该写一条 SHA-256 校验失败 finding');
    assert.equal(finding.severity, 'error');
    // proposal.status 应当仍为 COMMITTED（rollback 失败未走完 5 步）
    const proposal = Array.from(env.tables.proposals.values())[0];
    assert.equal(proposal.status, 'COMMITTED');
  } finally { env.cleanup(); }
});

// ── 软依赖缺失硬抛：mutation 关键路径不静默 ────────────────────────

test('commit 软依赖缺失抛错：agint.qualitySandbox=null 时 commit 不静默', async () => {
  const env = makeEnv({ sandboxOk: true, policyDecision: 'AUTO_DEPLOY' });
  // 重写 ctx.get 让 sandbox 不可用
  const workdir = env.workdir;
  rmSync(workdir, { recursive: true, force: true });
  // 直接用最小 ctx 调 propose + 注入空 sandbox
  const tables = { proposals: new Map(), commits: new Map(), findings: new Map(), metrics_log: new Map() };
  const services = {};
  plugin.apply({
    storageDomain: { open: async () => ({
      table: (name) => {
        const s = tables[name] || (tables[name] = new Map());
        return {
          entries: () => Array.from(s, ([id, v]) => ({ id, ...v })),
          put: async (id, v) => { s.set(id, v); },
          close: async () => {},
        };
      }, close: async () => {},
    }) },
    get: (n) => {
      // 关键：所有软依赖都 null
      return null;
    },
    provide: (n, f) => { services[n] = f; },
    effect: () => () => {},
  });
  const propose = services['agint.mutator.propose'];
  // 走 tool 路径，避开 diagnosis，但 commit 时 sandbox+policy 都 null
  let p;
  try {
    p = await propose({ ...clone(FIX.tool), targetPlugin: 'agint-mutator' });
  } catch (err) {
    // evolution 也被 null，可能 propose 直接挂
    if (/agint\.evolution/.test(err.message)) return; // 符合预期（关键路径不静默）
    throw err;
  }
  await assert.rejects(
    () => services['agint.mutator.commit']({ proposalId: p.id, repoRoot: '/tmp' }),
    /agint\.qualitySandbox 服务不可用/,
  );
});

// ── MutationStatus 状态机迁移验证（直接读 proposals 表） ────────────

test('状态机：propose=PENDING → commit policy AUTO_DEPLOY 后 → COMMITTED', async () => {
  const env = makeEnv({ sandboxOk: true, policyDecision: 'AUTO_DEPLOY' });
  try {
    // propose 后 status='PENDING'
    const { proposal: p1 } = await proposeAndCommit(FIX.prompt, env);
    assert.equal(p1.status, 'PENDING');
    // commit 后通过查 tables 验证状态已改成 'COMMITTED'
    const stored = Array.from(env.tables.proposals.values()).find((p) => p.id === p1.id);
    assert.equal(stored.status, 'COMMITTED');
  } finally { env.cleanup(); }
});

test('状态机：rollback 后 status='+'ROLLED_BACK', async () => {
  const env = makeEnv({ sandboxOk: true, policyDecision: 'AUTO_DEPLOY' });
  try {
    const { commit: c } = await proposeAndCommit(FIX.tool, env);
    const proposal = Array.from(env.tables.proposals.values())[0];
    assert.equal(proposal.status, 'COMMITTED');
    await env.services['agint.mutator.rollback']({ commitId: c.commitId, repoRoot: env.workdir });
    const rolled = Array.from(env.tables.proposals.values())[0];
    assert.equal(rolled.status, 'ROLLED_BACK');
  } finally { env.cleanup(); }
});

test('LIMITS.COMMITS=50 守门生效', () => {
  // 直接断言 schema 值
  assert.equal(LIMITS.COMMITS, 50);
  assert.equal(LIMITS.PREIMAGE_BYTES, 5 * 1024 * 1024);
});

// ── Sprint 10 #5：rollback 向后兼容断言（4 个新可选字段） ────────

test('兼容：rollback FROZEN 字段 { ok, restoredHash } 仍然成立', async () => {
  const env = makeEnv({ sandboxOk: true, policyDecision: 'AUTO_DEPLOY' });
  try {
    const { commit: c } = await proposeAndCommit(FIX.prompt, env);
    const rb = await env.services['agint.mutator.rollback']({
      commitId: c.commitId, repoRoot: env.workdir,
    });
    // Sprint 8 FROZEN 契约：ok=true, restoredHash 等于 commit 时记的 preimageHash
    assert.equal(rb.ok, true);
    assert.equal(rb.restoredHash, c.preimageHash);
  } finally { env.cleanup(); }
});

test('兼容：rollback 新增可选字段 rollbackTransactionId 存在', async () => {
  const env = makeEnv({ sandboxOk: true, policyDecision: 'AUTO_DEPLOY' });
  try {
    const { commit: c } = await proposeAndCommit(FIX.prompt, env);
    const rb = await env.services['agint.mutator.rollback']({
      commitId: c.commitId, repoRoot: env.workdir,
    });
    assert.ok(rb.rollbackTransactionId, 'rollbackTransactionId 应存在');
    assert.equal(typeof rb.rollbackTransactionId, 'string');
    assert.ok(rb.rollbackTransactionId.length > 0);
  } finally { env.cleanup(); }
});

test('兼容：rollback 新增可选字段 preimageHashAtStart 存在', async () => {
  const env = makeEnv({ sandboxOk: true, policyDecision: 'AUTO_DEPLOY' });
  try {
    const { commit: c } = await proposeAndCommit(FIX.prompt, env);
    const rb = await env.services['agint.mutator.rollback']({
      commitId: c.commitId, repoRoot: env.workdir,
    });
    assert.ok(rb.preimageHashAtStart, 'preimageHashAtStart 应存在');
    assert.equal(typeof rb.preimageHashAtStart, 'string');
    assert.equal(rb.preimageHashAtStart.length, 64, 'SHA-256 hex 应 64 字符');
  } finally { env.cleanup(); }
});
