// agint-executor（2026-11-07）：环境故障与提案失败分开记账。
//
// 这一组钉的是**归因**，不是「跑通」：
//   ① LLM 通道挂掉（driver 抛错）⇒ 顺延 + 退还尝试额度，**不**把提案记成 failed
//   ② 连续环境故障到阈值 ⇒ 熔断，本轮剩的不再捡；冷却期内 tick 直接跳过
//   ③ 非环境失败（LLM 产出不合格）照旧走原逻辑，不许被环境判据放行
//   ④ 判据与退避是纯函数：正反例逐条钉死
//
// 实机背景（提案 cdf41d63，2026-11-07 07:52–08:15）：
//   子代理每次 4–9 秒返回 stopReason=error、0 条消息；两次批准各烧 2 次重试额度，
//   最后面板显示「已批准·执行失败」，而提案一行代码都没改。
//
// 运行：node --test test/env-failure.test.mjs

import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
import { isEnvironmentFailure, envBackoffMs } from '../lib/env.js';

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
  };
}

async function withExecutor({ evolve, driver, config = {}, force = true }, fn) {
  const ctx = makeCtx();
  ctx.provide('agint.evolve', evolve);
  if (driver !== undefined && driver !== null) ctx.provide('agint.evolutionDriver', driver);
  apply(ctx, { enabled: false, ...config });
  process.env.AGINT_EXECUTOR = 'on';
  try {
    await fn({ svc: ctx.get('agint.executor'), ctx, force });
  } finally {
    delete process.env.AGINT_EXECUTOR;
  }
}

const job = (over = {}) => ({
  id: 'exec-env-1', proposalId: 'p-env', mode: 'immediate', dueAt: new Date().toISOString(),
  state: 'queued', attempts: 0, ...over,
});
const approved = (over = {}) => ({ id: 'p-env', status: 'approved', execMode: 'immediate', blocker: '', ...over });
const llmBroken = () => ({
  runForProposal: async () => {
    throw new Error('evolution-driver aborted: llm unavailable: stopReason=error');
  },
});

// ── ① LLM 挂掉 ⇒ 顺延 + 退还额度，提案不记失败 ────────────────────────
{
  const evolve = makeFakeEvolve({ proposal: approved(), jobs: [job()] });
  await withExecutor({
    evolve,
    driver: llmBroken(),
    config: { maxAttempts: 2, retryDelayMs: 300_000 },
  }, async ({ svc }) => {
    const out = await svc.tick({ force: true });
    const r = out.results[0];
    assert.equal(r.env, true, '环境故障必须自报身份，日志/周报才归得了因');
    assert.equal(r.deferred, true, '环境故障是顺延，不是失败');
    assert.equal(evolve.calls.finish.length, 0, '⛔ 不许把提案结算成 failed');
    assert.equal(evolve.calls.requeue.length, 1);
    const opts = evolve.calls.requeue[0].opts;
    assert.equal(opts.deferred, true, 'deferred=true ⇒ 提案 execState=deferred，面板显示「已顺延」');
    assert.equal(opts.refundAttempt, true, '⛔ 必须退还本次 claim 消耗的尝试额度');
    assert.match(opts.reason, /环境不可用/);
    assert.ok(Date.parse(opts.dueAt) > Date.now(), '顺延时刻必须在将来');
    assert.equal(svc.status().envDeferred, 1);
    assert.equal(svc.status().failed, 0, 'failed 计数器不许被环境故障污染');
  });
}

// ── ② 连续环境故障到阈值 ⇒ 熔断，本轮剩的不再捡；冷却期内跳过 ─────────
{
  const evolve = makeFakeEvolve({
    proposal: approved(),
    jobs: [job({ id: 'exec-a' }), job({ id: 'exec-b' }), job({ id: 'exec-c' })],
  });
  const ctx = makeCtx();
  ctx.provide('agint.evolve', evolve);
  ctx.provide('agint.evolutionDriver', llmBroken());
  // enabled=true：熔断要验的是普通 tick 路径（force 允许穿透，不能用来验熔断）
  // effect() 里会 setInterval + wake，假 ctx 的 setTimeout 不触发回调 ⇒ 不会提前跑。
  apply(ctx, { enabled: true, envBreakerThreshold: 2, envBreakerCooldownMs: 600_000 });
  process.env.AGINT_EXECUTOR = 'on';
  try {
    const svc = ctx.get('agint.executor');
    const now = Date.now();
    const first = await svc.tick({ now });
    assert.equal(first.results.length, 2, '第二次环境故障后必须立刻停手，第三条不许再撞墙');
    assert.equal(svc.status().breakerTrips, 1);
    assert.equal(svc.status().envStreak, 2);
    const second = await svc.tick({ now: now + 1000 });
    assert.equal(second.skipped, true);
    assert.match(second.reason, /环境熔断中/);
    // 冷却结束后恢复
    const third = await svc.tick({ now: now + 600_001 });
    assert.notEqual(third.skipped, true, '冷却到期必须自动恢复，不能永久停摆');
  } finally {
    delete process.env.AGINT_EXECUTOR;
  }
}

// ── ③ 非环境失败不许被环境判据放行 ────────────────────────────────────
{
  const evolve = makeFakeEvolve({ proposal: approved(), jobs: [job()] });
  await withExecutor({
    evolve,
    driver: { runForProposal: async () => ({ skipped: true, failures: ['p-env: oldText not found in target file (hallucination guard)'] }) },
    config: { maxAttempts: 1, retryDelayMs: 1000 },
  }, async ({ svc }) => {
    const out = await svc.tick({ force: true });
    assert.notEqual(out.results[0].env, true, 'LLM 产出不合格不是环境故障');
    assert.equal(evolve.calls.finish.length, 1, '额度用完 ⇒ 照常结算为失败');
    assert.equal(evolve.calls.finish[0].patch.ok, false);
    assert.equal(svc.status().envDeferred, 0);
  });
}

// ── ④ 纯判据正反例 ────────────────────────────────────────────────────
{
  const envTrue = [
    'driver 抛错：evolution-driver aborted: llm unavailable: stopReason=error',
    'llm unavailable: timeout',
    'spawn provider not registered',
    'agents service missing (create() not callable)',
    'read failed: ECONNRESET',
    'HTTP 429 too many requests',
  ];
  for (const s of envTrue) assert.equal(isEnvironmentFailure(s), true, `应判为环境故障：${s}`);
  const envFalse = [
    'not-actionable（这条提案没有可改的目标）：no target asset resolved',
    'llm judged not applicable',
    'oldText not found in target file (hallucination guard)',
    'fabricated entities in newText: foo (entity gate)',
    'commit 未通过（policy/verify 拒绝）',
    '',
  ];
  for (const s of envFalse) assert.equal(isEnvironmentFailure(s), false, `不许判为环境故障：${s}`);

  assert.equal(envBackoffMs(1, 300_000, 1_800_000), 300_000);
  assert.equal(envBackoffMs(2, 300_000, 1_800_000), 600_000);
  assert.equal(envBackoffMs(9, 300_000, 1_800_000), 1_800_000, '必须封顶，不许无限翻倍');
  assert.equal(envBackoffMs(0, 300_000, 1_800_000), 300_000, 'attempts=0 按第一次算');
}

console.log('env-failure.test.mjs: all cases passed');
