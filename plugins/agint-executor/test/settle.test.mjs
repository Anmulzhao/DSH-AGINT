// agint-executor 终局判决 + 结案接线（2026-11-08）。
//
// 钉的是「每个终局出口都给判决、都结案」，以及「不该结的时候不结」：
//   ① 确定性失败 / 额度耗尽 / 环境顺延到上限 ⇒ 调 settleExecution
//   ② 环境未到上限、有重试额度 ⇒ 不结案
//   ③ 老版 evolve 无结案能力 ⇒ 只降级 not-actionable，其余如实报未结案
//   ④ 历史悬案 sweep：三道收敛闸 + 生产形态样本
//   ⑤ 前置闸（驱动没挂）不是「跑完没结论」⇒ 不结案
//
// 运行：node --test plugins/agint-executor/test/settle.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

const PROD_PENDING = "transaction gate: atomicScope='prompt' 已有 PENDING proposal；同 scope 只允许 1 条 PENDING";
const PROD_ORPHAN = '宿主重启/进程中断导致本次执行未结算（宿主重启前就已 running，上一进程已死）';
const PROD_LLM = 'driver 抛错：evolution-driver aborted: llm unavailable: stopReason=error';

function makeCtx() {
  const provides = new Map();
  return {
    effect() {},
    provide(k, v) { provides.set(k, v); },
    get(k) { return provides.get(k) ?? null; },
    on() {},
    setInterval() { return { dispose() {} }; },
    setTimeout() { return { dispose() {} }; },
    logger: { warn() {}, info() {}, error() {} },
  };
}

function makeFakeEvolve({ proposal, jobs = [], unsettled = [] } = {}) {
  const calls = { finish: [], requeue: [], settle: [], markNotActionable: [] };
  const state = { proposal: proposal ? { ...proposal } : null, jobs: jobs.map((j) => ({ ...j })) };
  return {
    calls,
    state,
    async getProposal(id) { return state.proposal?.id === id ? { ...state.proposal } : null; },
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
    async settleExecution(id, opts) {
      calls.settle.push({ id, opts });
      return { ...state.proposal, status: 'wontfix', execVerdict: opts.verdict, execMode: 'manual', execState: 'idle' };
    },
    async listUnsettledProposals() { return unsettled.map((x) => ({ ...x })); },
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
  id: 'exec-settle-1', proposalId: 'p-settle', mode: 'immediate',
  dueAt: new Date().toISOString(), state: 'queued', attempts: 0, ...over,
});
const approved = (over = {}) => ({ id: 'p-settle', status: 'approved', execMode: 'immediate', blocker: '', ...over });
const skippedDriver = (reason, deterministic = false) => ({
  runForProposal: async () => ({ skipped: true, reason, failures: [reason], deterministic }),
});

test('① 确定性失败 ⇒ 判决 not-actionable 并结案', async () => {
  const evolve = makeFakeEvolve({ proposal: approved(), jobs: [job()] });
  await withExecutor({ evolve, driver: skippedDriver('p-settle: no target asset resolved', true) }, async ({ svc }) => {
    const out = await svc.tick({ force: true });
    assert.equal(out.results[0].action, 'fail');
    assert.equal(out.results[0].verdict, 'not-actionable', '执行器必须给出最终判决');
    assert.equal(out.results[0].settled, true);
    assert.equal(out.results[0].parked, true, '老字段保持语义');
    assert.equal(evolve.calls.finish.length, 1, 'job 仍留失败审计');
    assert.equal(evolve.calls.settle.length, 1);
    assert.equal(evolve.calls.settle[0].opts.verdict, 'not-actionable');
  });
});

test('② 普通失败额度用尽 ⇒ 判决 exhausted 并结案', async () => {
  const evolve = makeFakeEvolve({ proposal: approved(), jobs: [job({ attempts: 1 })] });
  await withExecutor({ evolve, driver: skippedDriver('policy REJECT：改动超出批准范围'), config: { maxAttempts: 2 } }, async ({ svc }) => {
    const out = await svc.tick({ force: true });
    assert.equal(out.results[0].action, 'fail');
    assert.equal(out.results[0].verdict, 'exhausted');
    assert.equal(out.results[0].settled, true);
    assert.equal(evolve.calls.settle[0].opts.verdict, 'exhausted');
    assert.match(evolve.calls.settle[0].opts.reason, /重试额度用尽/);
  });
});

test('③ 普通失败还有额度 ⇒ 重试，不结案', async () => {
  const evolve = makeFakeEvolve({ proposal: approved(), jobs: [job({ attempts: 0 })] });
  await withExecutor({ evolve, driver: skippedDriver('policy REJECT'), config: { maxAttempts: 2 } }, async ({ svc }) => {
    const out = await svc.tick({ force: true });
    assert.equal(out.results[0].action, 'retry');
    assert.equal(evolve.calls.settle.length, 0, '还没到终局，不许结案');
  });
});

test('④ 环境故障：未到上限顺延，到上限判 env-blocked 并结案', async () => {
  const evolve = makeFakeEvolve({ proposal: approved(), jobs: [job()] });
  await withExecutor({
    evolve, driver: skippedDriver(PROD_LLM),
    config: { maxAttempts: 2, envMaxDeferrals: 1, settleIntervalMs: 0 },
  }, async ({ svc }) => {
    const first = await svc.tick({ force: true });
    assert.equal(first.results[0].action, 'retry');
    assert.equal(first.results[0].deferred, true);
    assert.equal(evolve.calls.settle.length, 0, '第一次仍要等通道恢复');
    const second = await svc.tick({ force: true });
    assert.equal(second.results[0].verdict, 'env-blocked');
    assert.equal(second.results[0].settled, true);
    assert.equal(evolve.calls.settle[0].opts.verdict, 'env-blocked');
  });
});

test('⑤ 老版 evolve：只有 not-actionable 可降级，exhausted 如实报未结案', async () => {
  const a = makeFakeEvolve({ proposal: approved(), jobs: [job()] });
  delete a.settleExecution;
  await withExecutor({ evolve: a, driver: skippedDriver('no target asset resolved', true) }, async ({ svc }) => {
    const out = await svc.tick({ force: true });
    assert.equal(out.results[0].parked, true, 'markNotActionable 是语义等价的降级');
    assert.equal(a.calls.markNotActionable.length, 1);
  });

  const b = makeFakeEvolve({ proposal: approved(), jobs: [job({ attempts: 1 })] });
  delete b.settleExecution;
  await withExecutor({ evolve: b, driver: skippedDriver('policy REJECT'), config: { maxAttempts: 2 } }, async ({ svc }) => {
    const out = await svc.tick({ force: true });
    assert.equal(out.results[0].verdict, 'exhausted', '判决照给');
    assert.equal(out.results[0].settled, false, '但没有结案能力，不许谎报结案');
    assert.equal(b.calls.markNotActionable.length, 0, 'exhausted 不许借 not-actionable 的降级口');
  });
});

test('⑥ 历史悬案 sweep：三道闸 + 生产形态样本', async () => {
  const now = Date.now();
  const old = new Date(now - 3600_000).toISOString();
  const near = new Date(now).toISOString();
  const unsettled = [
    { id: 'p-a', execState: 'failed', error: PROD_PENDING, updatedAt: old },
    { id: 'p-b', execState: 'failed', error: PROD_ORPHAN, updatedAt: old },
    { id: 'p-c', execState: 'failed', error: '没见过的失败', updatedAt: old },
    { id: 'p-d', execState: 'deferred', error: PROD_LLM, updatedAt: old },
    { id: 'p-e', execState: 'failed', error: PROD_LLM, updatedAt: near },
    { id: 'p-f', execState: 'failed', error: '', updatedAt: old },
  ];
  const evolve = makeFakeEvolve({ proposal: approved(), unsettled });
  await withExecutor({ evolve }, async ({ svc }) => {
    const out = await svc.settleUnsettled({ now });
    assert.equal(out.scanned, 6);
    assert.equal(out.settled, 3, '两条生产悬案 + 一条无法归因的都结案');
    assert.equal(out.skipped, 3, '还会动的 / 刚失败的 / 没证据的都不结');
    assert.deepEqual(
      evolve.calls.settle.map((c) => [c.id, c.opts.verdict]),
      [['p-a', 'not-actionable'], ['p-b', 'interrupted'], ['p-c', 'exhausted']],
    );
    assert.equal(svc.status().settled, 3, '结案数必须进可观测出口');
    assert.equal(svc.status().lastSettle.scanned, 6);
  });
});

test('⑦ 前置闸（驱动没挂）不是「跑完没结论」⇒ 不结案', async () => {
  const evolve = makeFakeEvolve({ proposal: approved(), jobs: [job()] });
  await withExecutor({ evolve, driver: null }, async ({ svc }) => {
    const out = await svc.tick({ force: true });
    assert.equal(out.results[0].action, 'fail');
    assert.equal(evolve.calls.settle.length, 0, '缺能力该修宿主，不是把提案了结掉');
  });
});
