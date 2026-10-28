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
    assert.notEqual(patch.partial, true, '单单元提案：新字段缺席时行为与原来逐字一致');
  });
}

// ── ⑤b 部分落地：job 成功 ≠ 提案做完（2026-10-28，提案 `846f4fbb` 实证）──
//
// 一次自动执行的原子单元 = 一个文件的一次编辑，而提案横跨多文件是常态。
// driver v0.9.0 起会把 `scope.complete=false` 带出来 —— 这时 finish 仍要 ok:true
// （单元确实落地了），但**必须** 连同剩余单元一起声明 partial，否则 evolve
// 会把提案标成 applied：账面上它做完了，而正文里其余三个单元从此没有入口。
{
  const evolve = makeFakeEvolve({ proposal: approved(), jobs: [job()] });
  await withExecutor({
    evolve,
    driver: {
      runForProposal: async () => ({
        skipped: false,
        proposalId: 'mut-partial',
        commit: { ok: true, path: 'plugins/agint-evolve/test/_stub-dsh-tools.mjs', policyDecision: 'AUTO_DEPLOY' },
        scope: {
          unitsTotal: 3, unitsApplied: 1,
          remainingUnits: ['plugins/agint-input-gateway/test/_stub-storage-domain.mjs'],
          requiresNewAsset: false, complete: false,
        },
      }),
    },
  }, async ({ svc }) => {
    const out = await svc.tick({ force: true });
    assert.equal(out.results[0].ok, true, '单元确实落地 ⇒ 本次执行是成功的');
    assert.equal(out.results[0].partial, true, '但只覆盖了一部分 ⇒ 必须声明 partial');
    const patch = evolve.calls.finish[0].patch;
    assert.equal(patch.ok, true);
    assert.equal(patch.partial, true);
    assert.equal(patch.unitsTotal, 3);
    assert.equal(patch.unitsApplied, 1);
    assert.deepEqual(patch.remainingUnits, ['plugins/agint-input-gateway/test/_stub-storage-domain.mjs']);
    assert.match(patch.reason, /部分落地/);
    assert.equal(svc.status().partial, 1,
      '周报要说清楚「本周完成 N 条」里有多少条是只做完了一部分');
  });
}

// ── ⑤c 阴性对照：scope 说「单单元」⇒ 不许打 partial（假欠账也是污染）──
{
  const evolve = makeFakeEvolve({ proposal: approved(), jobs: [job()] });
  await withExecutor({
    evolve,
    driver: {
      runForProposal: async () => ({
        skipped: false,
        proposalId: 'mut-single',
        commit: { ok: true, path: 'plugins/agint-dream/lib/sweep.js', policyDecision: 'AUTO_DEPLOY' },
        scope: { unitsTotal: 1, unitsApplied: 1, remainingUnits: [], requiresNewAsset: false, complete: true },
      }),
    },
  }, async ({ svc }) => {
    await svc.tick({ force: true });
    const patch = evolve.calls.finish[0].patch;
    assert.equal(patch.partial, false);
    assert.equal(patch.reason, '');
    assert.equal(svc.status().partial, 0, '每条正常提案都记成欠账 ⇒ 面板全是黄，等于没有欠账机制');
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


// ── 2026-10-27：确定性失败不重试（b）──────────────────────────────────
//
// 实机教训：oracle 的「美谕提案」没有可改的代码目标，driver 两次各 1 秒失败，
// 第二次产出与第一次逐字相同 —— 重试只是再烧一遍 LLM。所以 driver 判定为
// deterministic 时，执行器必须**一次就收尾**，不许排重试。
{
  const evolve = makeFakeEvolve({ proposal: approved(), jobs: [job({ attempts: 0 })] });
  const addFailureCalls = [];
  await withExecutor({
    evolve,
    driver: {
      runForProposal: async () => ({
        skipped: true,
        deterministic: true,
        reason: 'not-actionable（这条提案没有可改的目标，重试也不会变）：p1: no target asset resolved',
        failures: ['p1: no target asset resolved'],
      }),
    },
    config: { maxAttempts: 3, retryDelayMs: 1000 },
  }, async ({ ctx, svc }) => {
    ctx.provide('agint.evolution', { addFailure: async (a) => addFailureCalls.push(a) });
    const out = await svc.tick({ force: true });
    assert.equal(out.results[0].action, 'fail');
    assert.equal(out.results[0].deterministic, true, '结果里要带出「确定性」，否则调用方分不清');
    assert.equal(evolve.calls.requeue.length, 0, '确定性失败绝不排重试（重试不会变，只烧 token）');
    assert.equal(evolve.calls.finish.length, 1);
    assert.equal(evolve.calls.finish[0].patch.ok, false);
    assert.match(evolve.calls.finish[0].patch.error, /not-actionable/, '失败原因要带「不可执行」这个结论');
    assert.equal(addFailureCalls.length, 1);
    assert.equal(addFailureCalls[0].pattern, 'executor-run-not-actionable', '失败模式要能单独归类，周报才查得动');
  });
}

// ── 2026-10-27：偶发失败仍然重试（别把 b 做成「一律不重试」）──────────
{
  const evolve = makeFakeEvolve({ proposal: approved(), jobs: [job({ attempts: 0 })] });
  await withExecutor({
    evolve,
    driver: { runForProposal: async () => ({ skipped: true, failures: ['p1: llm unavailable: timeout'] }) },
    config: { maxAttempts: 3, retryDelayMs: 1000 },
  }, async ({ svc }) => {
    const out = await svc.tick({ force: true });
    assert.equal(out.results[0].action, 'retry', 'LLM 挂掉这类偶发失败必须照常重试');
    assert.equal(evolve.calls.requeue.length, 1);
  });
}

// ── 2026-10-27：不可自动执行的提案 ⇒ 撤单（a 的执行侧兜底）──────────────
//
// 语义闸：复核类提案没有可改的目标，排进队列也只会失败。按 cancel 撤单
// （不是 fail）——「这次不该跑」与「跑了但没跑成」是两回事。
{
  const evolve = makeFakeEvolve({
    proposal: approved({ autoExecutable: false }),
    jobs: [job()],
  });
  await withExecutor({
    evolve,
    driver: { runForProposal: async () => ({ skipped: false, commit: { ok: true, path: 'x' } }) },
  }, async ({ svc }) => {
    const out = await svc.tick({ force: true });
    assert.equal(out.results[0].action, 'cancel');
    assert.match(out.results[0].reason, /不可自动执行/);
    assert.equal(evolve.calls.finish[0].patch.state, 'cancelled');
  });
}

// ── decideRun：autoExecutable=false ⇒ cancel（纯判据层）────────────────
{
  const d = decideRun({
    job: job({ attempts: 1 }),
    proposal: approved({ autoExecutable: false }),
    weekCommits: 0,
    cap: 3,
    driverReady: true,
    now: Date.now(),
  });
  assert.equal(d.action, 'cancel');
  assert.match(d.reason, /不可自动执行/);
}

// ── decideRun：autoExecutable 缺席（老提案）⇒ 照常可跑 ──────────────────
{
  const d = decideRun({
    job: job({ attempts: 1 }),
    proposal: { id: 'p1', status: 'approved', execMode: 'immediate', blocker: '' },
    weekCommits: 0,
    cap: 3,
    driverReady: true,
    now: Date.now(),
  });
  assert.equal(d.action, 'run', '字段缺席 = 可执行（老提案不能因这次改动集体失去自动执行能力）');
}
