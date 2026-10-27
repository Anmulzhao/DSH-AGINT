// agint-executor（2026-10-27）：批准即执行的调度与守护。
//
// 这组用例钉的是**六道闸的顺序与后果**，不是实现细节：
//   ① 状态不是 approved ⇒ 撤单（人撤销批准后，后台不许继续改代码）
//   ② 有 blocker ⇒ 撤单（前置没到位，不是"失败"）
//   ③ 驱动没挂 ⇒ 失败且**不消耗**周额度（能力缺失不该被顺延掩盖）
//   ④ 周上限到顶 ⇒ 顺延到下周起点（不是失败，也不是静默丢弃）
//   ⑤ 失败且有重试额度 ⇒ 排队重试（不标 applied、不留半截）
//   ⑥ 失败且额度用尽 ⇒ 失败收尾 + 落 failure_pattern
//
// 运行：node test/executor.test.mjs

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { apply, inject } from '../lib/index.js';
import { startOfWeek, nextWeekStart } from '../lib/week.js';
import { decideRun, canRetry } from '../lib/plan.js';
import * as evolveExec from '../../agint-evolve/lib/execution.js';

function makeCtx() {
  const provides = new Map();
  const effects = [];
  return {
    _provides: provides,
    _effects: effects,
    effect(fn) { effects.push(fn()); },
    provide(k, v) { provides.set(k, v); },
    get(k) { return provides.get(k) ?? null; },
    on() {},
    setInterval() { return { dispose() {} }; },
    setTimeout(fn) { const h = { dispose() {} }; return h; },
    logger: { warn() {}, info() {}, error() {} },
  };
}

/** 假 evolve：只实现执行器真正会调的那几个口，行为按用例需要配置。 */
function makeFakeEvolve({ proposal, jobs = [], weekCommits = 0 } = {}) {
  const calls = { finish: [], requeue: [], enqueue: [], claim: 0 };
  const state = { proposal: proposal ? { ...proposal } : null, jobs: jobs.map((j) => ({ ...j })) };
  return {
    calls,
    state,
    async getProposal(id) { return state.proposal && state.proposal.id === id ? { ...state.proposal } : null; },
    async claimDueExecutions() {
      calls.claim += 1;
      const claimable = state.jobs.filter((j) => j.state === 'queued' || j.state === 'deferred');
      return claimable.map((j) => ({ ...j, state: 'running', attempts: (j.attempts ?? 0) + 1 }));
    },
    async finishExecution(id, patch) { calls.finish.push({ id, patch }); return { id, ...patch }; },
    async requeueExecution(id, opts) { calls.requeue.push({ id, opts }); return { id, ...opts }; },
    async executionStats() { return { lastWeekCommits: weekCommits }; },
    async enqueueExecution(id, opts) {
      calls.enqueue.push({ id, opts });
      return { enqueued: true, job: { id: 'exec-fake' } };
    },
  };
}

async function withExecutor({ evolve, driver, env = {}, config = {} }, fn) {
  const ctx = makeCtx();
  ctx.provide('agint.evolve', evolve);
  if (driver !== undefined && driver !== null) ctx.provide('agint.evolutionDriver', driver);
  apply(ctx, { enabled: false, ...config });
  process.env.AGINT_EXECUTOR = env.AGINT_EXECUTOR ?? 'on';
  try {
    await fn({ ctx, svc: ctx.get('agint.executor'), evolve });
  } finally {
    delete process.env.AGINT_EXECUTOR;
  }
}

const job = (over = {}) => ({
  id: 'exec-1', proposalId: 'p1', mode: 'immediate', dueAt: new Date().toISOString(),
  state: 'queued', attempts: 0, ...over,
});
const approved = (over = {}) => ({ id: 'p1', status: 'approved', execMode: 'immediate', blocker: '', ...over });

// ── ① 不是 approved ⇒ 撤单 ────────────────────────────────────────────
{
  const evolve = makeFakeEvolve({ proposal: approved({ status: 'proposed' }), jobs: [job()] });
  await withExecutor({ evolve, driver: { runForProposal: async () => ({ skipped: false, commit: { ok: true } }) } }, async ({ svc }) => {
    const out = await svc.tick({ force: true });
    assert.equal(out.results[0].action, 'cancel');
    assert.match(evolve.calls.finish[0].patch.reason, /不再是 approved/);
  });
}

// ── ② blocker ⇒ 撤单 ─────────────────────────────────────────────────
{
  const evolve = makeFakeEvolve({ proposal: approved({ blocker: '等 8-12 周标注' }), jobs: [job()] });
  await withExecutor({ evolve, driver: { runForProposal: async () => ({ skipped: false, commit: { ok: true } }) } }, async ({ svc }) => {
    const out = await svc.tick({ force: true });
    assert.equal(out.results[0].action, 'cancel');
    assert.match(evolve.calls.finish[0].patch.reason, /blocker/);
  });
}

// ── ③ 驱动没挂 ⇒ 失败（且不因周上限被顺延掩盖）──────────────────────────
{
  const evolve = makeFakeEvolve({ proposal: approved(), jobs: [job()], weekCommits: 99 });
  await withExecutor({ evolve, driver: null }, async ({ svc }) => {
    const out = await svc.tick({ force: true });
    assert.equal(out.results[0].action, 'fail', '能力缺失必须是失败，不能顺延');
    assert.match(evolve.calls.finish[0].patch.error, /runForProposal 未挂载/);
    assert.equal(evolve.calls.requeue.length, 0);
  });
}

// ── ④ 周上限到顶 ⇒ 顺延到下周起点 ─────────────────────────────────────
{
  const evolve = makeFakeEvolve({ proposal: approved(), jobs: [job()], weekCommits: 3 });
  let invoked = 0;
  await withExecutor({
    evolve,
    driver: { runForProposal: async () => { invoked += 1; return { skipped: false, commit: { ok: true } }; } },
    config: { weeklyCommitCap: 3 },
  }, async ({ svc }) => {
    const out = await svc.tick({ force: true });
    assert.equal(out.results[0].action, 'defer');
    assert.equal(invoked, 0, '到顶时不得调用驱动');
    const req = evolve.calls.requeue[0];
    assert.equal(req.opts.deferred, true);
    assert.equal(req.opts.dueAt, nextWeekStart(Date.now()), '顺延目标应是下周起点');
  });
}

// ── ⑤ 成功 ⇒ finish(ok:true)，带落地证据 ─────────────────────────────
{
  const evolve = makeFakeEvolve({ proposal: approved(), jobs: [job()] });
  await withExecutor({
    evolve,
    driver: {
      runForProposal: async () => ({
        skipped: false,
        proposalId: 'mut-9',
        commit: { ok: true, path: 'plugins/agint-evolve/lib/index.js', policyDecision: 'AUTO_DEPLOY' },
      }),
    },
  }, async ({ svc }) => {
    const out = await svc.tick({ force: true });
    assert.equal(out.results[0].ok, true);
    const patch = evolve.calls.finish[0].patch;
    assert.equal(patch.ok, true);
    assert.equal(patch.commitPath, 'plugins/agint-evolve/lib/index.js');
    assert.equal(patch.mutationId, 'mut-9');
    assert.equal(patch.policyDecision, 'AUTO_DEPLOY');
  });
}

// ── ⑤' 失败但有额度 ⇒ 排队重试（不标 applied）────────────────────────
{
  const evolve = makeFakeEvolve({ proposal: approved(), jobs: [job({ attempts: 0 })] });
  await withExecutor({
    evolve,
    driver: { runForProposal: async () => ({ skipped: true, failures: ['p1: no target asset resolved'], reason: 'no actionable candidate' }) },
    config: { maxAttempts: 2, retryDelayMs: 1000 },
  }, async ({ svc }) => {
    const out = await svc.tick({ force: true });
    assert.equal(out.results[0].action, 'retry');
    assert.equal(evolve.calls.finish.length, 0, '还有额度时不得收尾为失败');
    assert.match(evolve.calls.requeue[0].opts.error, /no target asset/);
  });
}

// ── ⑥ 失败且额度用尽 ⇒ 失败收尾 + 记 failure_pattern ─────────────────
{
  const evolve = makeFakeEvolve({ proposal: approved(), jobs: [job({ attempts: 1 })] });
  const addFailureCalls = [];
  evolve.addFailure = async () => {};
  await withExecutor({
    evolve,
    driver: { runForProposal: async () => ({ skipped: true, failures: ['p1: construct failed — anchor missing'] }) },
    config: { maxAttempts: 2 },
  }, async ({ ctx, svc }) => {
    ctx.provide('agint.evolution', { addFailure: async (a) => addFailureCalls.push(a) });
    await svc.tick({ force: true });
    assert.equal(evolve.calls.finish.length, 1);
    assert.equal(evolve.calls.finish[0].patch.ok, false);
    assert.match(evolve.calls.finish[0].patch.error, /anchor missing/);
    assert.equal(addFailureCalls.length, 1, '失败必须落到 failure_pattern（周报查得动）');
    assert.equal(addFailureCalls[0].pattern, 'executor-run-failed');
  });
}

// ── commit 没发生过（变异构造成功但没写盘）不算落地 ────────────────────
{
  const evolve = makeFakeEvolve({ proposal: approved(), jobs: [job({ attempts: 5 })] });
  await withExecutor({
    evolve,
    driver: { runForProposal: async () => ({ skipped: false, proposalId: 'mut-1', commit: null }) },
    config: { maxAttempts: 1 },
  }, async ({ svc }) => {
    await svc.tick({ force: true });
    assert.equal(evolve.calls.finish[0].patch.ok, false);
    assert.match(evolve.calls.finish[0].patch.error, /不算落地/);
  });
}

// ── kill-switch ─────────────────────────────────────────────────────
{
  const evolve = makeFakeEvolve({ proposal: approved(), jobs: [job()] });
  await withExecutor({ evolve, driver: { runForProposal: async () => ({}) }, env: { AGINT_EXECUTOR: 'off' } }, async ({ svc }) => {
    const out = await svc.tick({ force: true });
    assert.equal(out.skipped, true);
    assert.match(out.reason, /paused/);
    assert.equal(evolve.calls.claim, 0, '关掉后不许碰队列');
  });
}

// ── runNow：入队 + 立刻跑 ────────────────────────────────────────────
{
  const evolve = makeFakeEvolve({ proposal: approved(), jobs: [job()] });
  await withExecutor({
    evolve,
    driver: { runForProposal: async () => ({ skipped: false, proposalId: 'm', commit: { ok: true, path: 'a.js' } }) },
  }, async ({ svc }) => {
    const out = await svc.runNow('p1');
    assert.equal(evolve.calls.enqueue.length, 1);
    assert.equal(out.ok, true);
  });
}

// ── 判据层：decideRun 的顺序 ────────────────────────────────────────
{
  const base = { job: { attempts: 1 }, proposal: approved(), weekCommits: 0, cap: 3, driverReady: true, now: Date.now() };
  assert.equal(decideRun(base).action, 'run');
  assert.equal(decideRun({ ...base, proposal: null }).action, 'cancel');
  assert.equal(decideRun({ ...base, proposal: approved({ status: 'applied' }) }).action, 'cancel');
  assert.equal(decideRun({ ...base, weekCommits: 3 }).action, 'defer');
  assert.equal(decideRun({ ...base, driverReady: false, weekCommits: 3 }).action, 'fail', '能力缺失优先于额度');
  assert.equal(decideRun({ ...base, cap: 0, weekCommits: 99 }).action, 'run', 'cap=0 = 不限');
  assert.equal(canRetry(1, 2), true);
  assert.equal(canRetry(2, 2), false);
  assert.equal(canRetry(1, 0), false);
}

// ── 自然周口径：本插件与 agint-evolve 必须算出同一个周一 00:00 ──────────
{
  // 2026-10-27 是周二；用几个跨周边界验（含周日/周一本身）。
  for (const iso of ['2026-10-27T12:00:00+08:00', '2026-10-26T00:00:00+08:00', '2026-11-01T23:59:00+08:00']) {
    const ts = Date.parse(iso);
    assert.equal(startOfWeek(ts), evolveExec.startOfWeek(ts), `startOfWeek 口径漂移：${iso}`);
    assert.equal(nextWeekStart(ts), evolveExec.nextWeekStart(ts), `nextWeekStart 口径漂移：${iso}`);
  }
  const tue = Date.parse('2026-10-27T12:00:00+08:00');
  assert.equal(new Date(startOfWeek(tue)).getDay(), 1, '周一为一周起点');
  assert.equal(nextWeekStart(tue), new Date(startOfWeek(tue) + 7 * 24 * 3600 * 1000).toISOString());
}

console.log('# agint-executor smoke: ok（六道闸 / 周上限 / 重试 / kill-switch / 周口径）');


// ── 注入声明：用宿主定时器就必须 inject 'timer'（2026-10-27 首次部署翻车）──
//
// 实机症状：插件 apply 时抛 `cannot get property "timer" without inject`，
// 整个插件没挂上，而面板只显示「服务 get 不到、tick 从不发生」。
// 本地用例当时全绿 —— 因为假 ctx 把 setTimeout 直接给了出去，比真宿主宽松。
// 这条断言钉的是「代码用了什么」与「声明要了什么」必须一致。
{
  assert.ok(
    inject.includes('timer'),
    '使用 ctx.setInterval / ctx.setTimeout 必须 inject timer，否则宿主拒绝挂载',
  );
  const src = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.ok(
    /ctx\.setInterval|ctx\.setTimeout/.test(src),
    '反向校验：代码确实在用宿主定时器，否则这条断言会退化成摆设',
  );
}

// ── 挂载即注册 tick（enabled=true 时）────────────────────────────────
{
  const ctx = makeCtx();
  let intervals = 0;
  ctx.setInterval = () => { intervals += 1; return { dispose() {} }; };
  ctx.provide('agint.evolve', makeFakeEvolve({}));
  apply(ctx, { enabled: true, tickMs: 60000 });
  assert.equal(intervals, 1, 'enabled=true 时应注册恰好一个 interval');
}
