// agint-executor（2026-11-07）：确定性不可执行 ⇒ 提案退出自动队列，不挂「执行失败」。
//
// 这一组钉的是**收口行为**：
//   ① driver 判 deterministic not-actionable ⇒ job 记 failed（审计），但提案必须被
//      markNotActionable 收口（保留 approved、降 manual、execState 归 idle）
//   ② 偶发失败（LLM 不可用等）⇒ 走重试，不误收口
//   ③ 老版 evolve 没有 markNotActionable ⇒ 退回原行为，不抛错
//
// 运行：node --test test/deterministic-park.test.mjs

import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

function makeCtx() {
  const provides = new Map();
  return {
    effect(fn) { fn(); },
    provide(k, v) { provides.set(k, v); },
    get(k) { return provides.get(k) ?? null; },
    on() {},
    setInterval() { return { dispose() {} }; },
    setTimeout() { return { dispose() {} }; },
    logger: { warn() {}, info() {}, error() {} },
  };
}

function makeFakeEvolve({ proposal, jobs = [] } = {}) {
  const calls = { finish: [], requeue: [], markNotActionable: [] };
  const state = { proposal: proposal ? { ...proposal } : null, jobs: jobs.map((j) => ({ ...j })) };
  return {
    calls,
    state,
    async getProposal(id) { return state.proposal && state.proposal.id === id ? { ...state.proposal } : null; },
    async claimDueExecutions() {
      return state.jobs
        .filter((j) => j.state === 'queued' || j.state === 'deferred')
        .map((j) => ({ ...j, state: 'running', attempts: (j.attempts ?? 0) + 1 }));
    },
    async finishExecution(id, patch) { calls.finish.push({ id, patch }); return { id, ...patch }; },
    async requeueExecution(id, opts) { calls.requeue.push({ id, opts }); return { id, ...opts }; },
    async executionStats() { return { lastWeekCommits: 0 }; },
    async enqueueExecution() { return { enqueued: true, job: { id: 'exec-fake' } }; },
    async reapOrphanExecutions() { return { reaped: [], count: 0 }; },
    async markNotActionable(id, reason) {
      calls.markNotActionable.push({ id, reason });
      return { ...state.proposal, execMode: 'manual', execState: 'idle' };
    },
  };
}

async function withExecutor({ evolve, driver, config = {} }, fn) {
  const ctx = makeCtx();
  ctx.provide('agint.evolve', evolve);
  if (driver !== undefined && driver !== null) ctx.provide('agint.evolutionDriver', driver);
  apply(ctx, { enabled: false, ...config });
  process.env.AGINT_EXECUTOR = 'on';
  try {
    await fn({ svc: ctx.get('agint.executor') });
  } finally {
    delete process.env.AGINT_EXECUTOR;
  }
}

const job = (over = {}) => ({
  id: 'exec-park-1', proposalId: 'p-park', mode: 'immediate', dueAt: new Date().toISOString(),
  state: 'queued', attempts: 0, ...over,
});
const approved = (over = {}) => ({ id: 'p-park', status: 'approved', execMode: 'immediate', blocker: '', ...over });

// ── ① 确定性不可执行 ⇒ job failed，但提案被收口 ────────────────────────
{
  const evolve = makeFakeEvolve({ proposal: approved(), jobs: [job()] });
  await withExecutor({
    evolve,
    driver: {
      runForProposal: async () => ({
        skipped: true,
        failures: ['p-park: no target asset resolved (mentioned:0 inRepo:0 bodyLen:1200)'],
        reason: 'p-park: no target asset resolved',
        deterministic: true,
      }),
    },
  }, async ({ svc }) => {
    const out = await svc.tick({ force: true });
    assert.equal(out.results[0].action, 'fail');
    assert.equal(out.results[0].deterministic, true);
    assert.equal(out.results[0].parked, true, '确定性失败必须收口提案');
    assert.equal(evolve.calls.finish.length, 1, 'job 仍要留失败审计');
    assert.equal(evolve.calls.finish[0].patch.ok, false);
    assert.equal(evolve.calls.markNotActionable.length, 1, '提案必须退出自动队列');
    assert.equal(evolve.calls.markNotActionable[0].id, 'p-park');
    assert.match(evolve.calls.markNotActionable[0].reason, /no target asset resolved/);
  });
}

// ── ② 偶发失败 ⇒ 重试，不误收口 ────────────────────────────────────────
{
  const evolve = makeFakeEvolve({ proposal: approved(), jobs: [job({ attempts: 0 })] });
  await withExecutor({
    evolve,
    driver: {
      runForProposal: async () => ({
        skipped: true,
        failures: ['p-park: llm unavailable: stopReason=error'],
        reason: 'llm unavailable',
        deterministic: false,
      }),
    },
    config: { maxAttempts: 2, retryDelayMs: 1000 },
  }, async ({ svc }) => {
    const out = await svc.tick({ force: true });
    assert.equal(out.results[0].action, 'retry');
    assert.equal(evolve.calls.markNotActionable.length, 0, '偶发失败可能下次就成，不得收口');
  });
}

// ── ③ 老版 evolve 无 markNotActionable ⇒ 不抛错，退回原行为 ─────────────
{
  const evolve = makeFakeEvolve({ proposal: approved(), jobs: [job()] });
  delete evolve.markNotActionable;
  await withExecutor({
    evolve,
    driver: {
      runForProposal: async () => ({
        skipped: true,
        failures: ['p-park: no target asset resolved'],
        reason: 'p-park: no target asset resolved',
        deterministic: true,
      }),
    },
  }, async ({ svc }) => {
    const out = await svc.tick({ force: true });
    assert.equal(out.results[0].action, 'fail');
    assert.equal(out.results[0].parked, false, '没有收口能力时如实报告未收口');
    assert.equal(evolve.calls.finish.length, 1);
  });
}

console.log('deterministic-park.test.mjs: all cases passed');
