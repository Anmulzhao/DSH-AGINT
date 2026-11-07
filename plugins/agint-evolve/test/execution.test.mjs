// agint-evolve 执行队列（2026-10-27）：批准即入队的判据与状态机。
//
// 这一组用例钉的是**行为承诺**，不是实现细节：
//   ① 批准 + 立即 ⇒ 入队（此前批准即断链，没人捡）
//   ② 批准 + 有 blocker ⇒ 不入队（批准的是方向，不是"现在能做"）
//   ③ 已批准 + 清空 blocker ⇒ 补入队（解锁那一刻才开始跑，而不是解锁后等人再点）
//   ④ manual ⇒ 永不入队（加字段前的老提案不会被这次升级偷偷开始改代码）
//   ⑤ 定时未到 ⇒ claim 捡不到；到点 ⇒ 捡得到
//   ⑥ 执行成功 ⇒ 提案同一刻标记 applied（不留「已落地 + 已批准待执行」的自相矛盾）
//   ⑦ 执行失败 ⇒ 提案留在 approved 且 execError 有原因（不静默吞）
//   ⑧ 撤销批准 ⇒ 排队中的执行被撤销（否则人撤了批，活还在后台跑）
//   ⑧ 重复批准 ⇒ 不叠单
//
// 运行：node --test test/execution.test.mjs

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';
import { validateExecPlan, computeDueAt, autoEnqueueBlocker, interpretRunResult } from '../lib/execution.js';

function makeMockCtx() {
  const tables = new Map();
  return {
    storageDomain: {
      async open(spec) {
        return {
          name: spec.name,
          version: spec.version,
          table(name) {
            let t = tables.get(name);
            if (!t) { t = new Map(); tables.set(name, t); }
            return {
              get: (id) => t.get(id) ?? null,
              put: async (id, value) => { t.set(id, value); return true; },
              delete: async (id) => t.delete(id),
              entries: () => [...t.entries()],
            };
          },
          async close() {},
        };
      },
    },
    _tables: tables,
    _effects: [],
    _provides: new Map(),
    effect(fn) { this._effects.push(fn()); },
    provide(k, v) { this._provides.set(k, v); },
    get(k) { return this._provides.get(k) ?? null; },
    on() {},
    setInterval() { return { dispose() {} }; },
  };
}

async function withApp(fn, cfg = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agint-evolve-exec-'));
  const ctx = makeMockCtx();
  apply(ctx, { root, ...cfg });
  const evo = ctx.get('agint.evolve');
  assert.ok(evo, 'agint.evolve 服务已注册');
  try {
    await fn({ ctx, evo, tables: ctx._tables });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const futureIso = (ms) => new Date(Date.now() + ms).toISOString();

// ── 纯判据 ────────────────────────────────────────────────────────────
{
  const ok = validateExecPlan({ execMode: 'scheduled', execAt: futureIso(60 * 60 * 1000) });
  assert.equal(ok.ok, true, '合法的定时计划应通过');
  assert.equal(ok.mode, 'scheduled');

  const past = validateExecPlan({ execMode: 'scheduled', execAt: '2020-01-01T00:00:00.000Z' });
  assert.equal(past.ok, false, '过去的定时必须被拒（要立刻跑请选 immediate）');

  const missing = validateExecPlan({ execMode: 'scheduled' });
  assert.equal(missing.ok, false, 'scheduled 缺 execAt 必须被拒');

  const bogus = validateExecPlan({ execMode: 'someday' });
  assert.equal(bogus.ok, false, '未知 execMode 必须被拒');

  // immediate/manual 残留的 execAt 被丢弃：不报错，但不许留下"看起来有定时"的字段。
  const cleared = validateExecPlan({ execMode: 'immediate', execAt: futureIso(1000) });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.at, '');

  assert.equal(computeDueAt('immediate', '', 1700000000000), new Date(1700000000000).toISOString());
  assert.equal(
    computeDueAt('scheduled', '2030-01-01T00:00:00.000Z', 1700000000000),
    '2030-01-01T00:00:00.000Z',
    '定时模式的 dueAt 就是 execAt',
  );

  // 老行（没有 execMode）⇒ 归一成 manual，因此不会自动执行。
  assert.equal(autoEnqueueBlocker({ id: 'x', status: 'approved' }), 'manual');
  assert.equal(autoEnqueueBlocker({ id: 'x', status: 'proposed', execMode: 'immediate' }), 'not-approved');
  assert.equal(
    autoEnqueueBlocker({ id: 'x', status: 'approved', execMode: 'immediate', blocker: '等样本' }),
    'blocked',
  );
  assert.equal(
    autoEnqueueBlocker(
      { id: 'x', status: 'approved', execMode: 'immediate' },
      [{ proposalId: 'x', state: 'queued' }],
    ),
    'already-queued',
    '已有排队中的执行不叠单',
  );

  // 执行结果的判据：只有 commit ok 才算落地。
  assert.equal(interpretRunResult({ skipped: true, failures: ['no target asset'] }).ok, false);
  assert.equal(interpretRunResult({ skipped: false, commit: { ok: true, path: 'a/b.js' } }).ok, true);
  assert.equal(interpretRunResult({ skipped: false, commit: null }).ok, false);
}

// ── ① 批准 + 立即 ⇒ 入队 ──────────────────────────────────────────────
await withApp(async ({ evo }) => {
  const p = await evo.propose({ title: '改 a', body: '正文', category: 'doc' });
  const rec = await evo.setStatus(p.id, 'approved', '批准', { execMode: 'immediate' });
  assert.equal(rec.status, 'approved');
  assert.equal(rec.execMode, 'immediate');
  assert.equal(rec.execState, 'queued', '批准后应立刻进入排队态');

  const jobs = await evo.listExecutions({ proposalId: p.id });
  assert.equal(jobs.length, 1, '应生成一条执行记录');
  assert.equal(jobs[0].state, 'queued');
  assert.equal(jobs[0].mode, 'immediate');

  // ⑧ 重复批准不叠单
  await evo.setStatus(p.id, 'approved', '再批一次', { execMode: 'immediate' });
  const again = await evo.listExecutions({ proposalId: p.id });
  assert.equal(again.length, 1, '重复批准不得叠出第二条执行');

  // claim → running
  const claimed = await evo.claimDueExecutions({ now: Date.now() + 1000, limit: 5 });
  assert.equal(claimed.length, 1, '到期的执行应被 claim');
  assert.equal(claimed[0].state, 'running');
  assert.equal(claimed[0].attempts, 1);
  let mid = await evo.getProposal(p.id);
  assert.equal(mid.execState, 'running');
  assert.equal(mid.execAttempts, 1);

  // ⑥ 成功 ⇒ 同一刻 applied
  const done = await evo.finishExecution(claimed[0].id, {
    ok: true, mutationId: 'mut-1', commitPath: 'plugins/x/lib/a.js', policyDecision: 'AUTO_DEPLOY',
  });
  assert.equal(done.state, 'succeeded');
  const after = await evo.getProposal(p.id);
  assert.equal(after.status, 'applied', '执行成功必须同一刻把提案标 applied');
  assert.equal(after.execState, 'succeeded');
  assert.match(after.note, /自动执行落地/, 'note 里必须留落地证据');
  assert.match(after.note, /plugins\/x\/lib\/a\.js/);
  assert.match(after.note, /再批一次/, '原有 note 不能被落地证据覆盖掉');
});

// ── ②③ blocker 语义 ──────────────────────────────────────────────────
await withApp(async ({ evo }) => {
  const p = await evo.propose({ title: '改 b', body: '正文' });
  await evo.setStatus(p.id, 'approved', '批准', { execMode: 'immediate', blocker: '等 8-12 周样本' });
  assert.equal((await evo.listExecutions({ proposalId: p.id })).length, 0, '有 blocker 不得入队');
  assert.equal((await evo.getProposal(p.id)).execState, 'idle');

  // ③ 清空 blocker ⇒ 补入队
  const unlocked = await evo.setStatus(p.id, 'approved', '解锁', { blocker: '' });
  assert.equal(unlocked.execState, 'queued', '清空 blocker 应自动补入队');
  assert.equal((await evo.listExecutions({ proposalId: p.id })).length, 1);

  // ⑧ 撤销批准 ⇒ 排队中的执行被撤销
  await evo.setStatus(p.id, 'proposed', '撤销批准', {});
  const jobs = await evo.listExecutions({ proposalId: p.id });
  assert.equal(jobs[0].state, 'cancelled', '撤销批准必须同时撤销排队中的执行');
  const back = await evo.getProposal(p.id);
  assert.equal(back.execState, 'cancelled');
});

// ── ④ manual 永不入队 ────────────────────────────────────────────────
await withApp(async ({ evo }) => {
  const p = await evo.propose({ title: '改 c', body: '正文' });
  const rec = await evo.setStatus(p.id, 'approved', '只批准');
  assert.equal(rec.execMode, 'manual', '不传 execMode 默认 manual');
  assert.equal((await evo.listExecutions({ proposalId: p.id })).length, 0, 'manual 不得自动执行');
});

// ── ⑤ 定时未到不跑 ───────────────────────────────────────────────────
await withApp(async ({ evo }) => {
  const at = futureIso(3600 * 1000);
  const p = await evo.propose({ title: '改 d', body: '正文' });
  const rec = await evo.setStatus(p.id, 'approved', '定时', { execMode: 'scheduled', execAt: at });
  assert.equal(rec.execMode, 'scheduled');
  assert.equal(rec.execAt, at);

  const early = await evo.claimDueExecutions({ now: Date.now() + 1000, limit: 5 });
  assert.equal(early.length, 0, '定时未到不得被 claim');
  const late = await evo.claimDueExecutions({ now: Date.now() + 3600 * 1000 + 1000, limit: 5 });
  assert.equal(late.length, 1, '到点后应被 claim');
});

// ── ⑦ 失败留原因 + 重试排队 ──────────────────────────────────────────
await withApp(async ({ evo }) => {
  const p = await evo.propose({ title: '改 e', body: '正文' });
  await evo.setStatus(p.id, 'approved', '批准', { execMode: 'immediate' });
  const [job] = await evo.claimDueExecutions({ now: Date.now() + 1000, limit: 5 });
  await evo.finishExecution(job.id, { ok: false, error: 'no target asset resolved' });

  const after = await evo.getProposal(p.id);
  assert.equal(after.status, 'approved', '失败不得把提案标 applied');
  assert.equal(after.execState, 'failed');
  assert.match(after.execError, /no target asset/, '失败原因必须留在提案上');

  const requeued = await evo.requeueExecution(job.id, { dueAt: futureIso(60000), error: '重试中' });
  assert.equal(requeued.state, 'queued');
  assert.equal((await evo.getProposal(p.id)).execState, 'queued');
  assert.equal((await evo.claimDueExecutions({ now: Date.now() + 1000, limit: 5 })).length, 0, '重试时间未到不跑');

  // 顺延（周上限）走 deferred：人读作"等条件"，不是失败。
  const deferred = await evo.requeueExecution(job.id, { dueAt: futureIso(1000), reason: '本周自动执行已用尽（3/3）', deferred: true });
  assert.equal(deferred.state, 'deferred');
  assert.equal((await evo.getProposal(p.id)).execState, 'deferred');
});

// ── 手动撤销（面板/工具出口）────────────────────────────────────────────
await withApp(async ({ evo }) => {
  const p = await evo.propose({ title: '改 f', body: '正文' });
  await evo.setStatus(p.id, 'approved', '批准', { execMode: 'immediate' });
  const cancelled = await evo.cancelExecution(p.id, '不想跑了');
  assert.equal(cancelled.length, 1);
  assert.equal((await evo.getProposal(p.id)).execState, 'cancelled');
  // 已撤销后再批准：应重新入队（cancelled 不在活跃态里，不挡路）
  await evo.setStatus(p.id, 'approved', '再来', { execMode: 'immediate' });
  assert.equal((await evo.listExecutions({ proposalId: p.id, state: 'queued' })).length, 1);
});

// ── executionStats 口径 ──────────────────────────────────────────────
await withApp(async ({ evo }) => {
  const p = await evo.propose({ title: '改 g', body: '正文' });
  await evo.setStatus(p.id, 'approved', '批准', { execMode: 'immediate' });
  const s1 = await evo.executionStats({ now: Date.now() });
  assert.equal(s1.queued, 1);
  assert.equal(s1.lastWeekCommits, 0);

  const [job] = await evo.claimDueExecutions({ now: Date.now() + 1000, limit: 5 });
  await evo.finishExecution(job.id, { ok: true, commitPath: 'x.js' });
  const s2 = await evo.executionStats({ now: Date.now() });
  assert.equal(s2.lastWeekCommits, 1, '近 7 天落地数应算上这次');
});

// ── 2026-10-29：语义闸已撤 —— autoExecutable=false 照常入队 ──────────────
//
// 2026-10-27 曾按「复核类没有可改目标」挡在队列外。老板裁定撤销：批准即自动执行，
// 跑不动由执行器的目标解析给确定性失败原因（零目标时连 LLM 都不起）。
await withApp(async ({ evo }) => {
  const p = await evo.propose({ title: '复核类提案', body: '正文', source: 'agint-aesthetic-oracle', autoExecutable: false });
  assert.equal((await evo.getProposal(p.id)).autoExecutable, false, '字段仍然照实落库（惰性历史标记）');

  await evo.setStatus(p.id, 'approved', '批准', { execMode: 'immediate' });
  const jobs = await evo.listExecutions({ proposalId: p.id });
  assert.equal(jobs.length, 1, '这个标记不再阻止入队');
  const rec = await evo.getProposal(p.id);
  assert.equal(rec.execState, 'queued', '入队了就该显示排队中');
  assert.equal(rec.status, 'approved');
});

// ── force 与普通入队同一结果（这个标记不参与判据）────────────────────
await withApp(async ({ evo }) => {
  const p = await evo.propose({ title: '复核类提案二', body: '正文', autoExecutable: false });
  await evo.setStatus(p.id, 'approved', '批准', { execMode: 'manual' });
  const forced = await evo.enqueueExecution(p.id, { force: true });
  assert.equal(forced.enqueued, true, 'force 照样能排 —— 不再有不可强穿的语义闸');
});

// ── 老提案（无 autoExecutable 字段）仍可自动执行 ──────────────────────
await withApp(async ({ evo }) => {
  const p = await evo.propose({ title: '普通提案', body: '正文' });
  assert.equal((await evo.getProposal(p.id)).autoExecutable, true, '默认 true —— 字段是后加的，老提案不受影响');
  await evo.setStatus(p.id, 'approved', '批准', { execMode: 'immediate' });
  assert.equal((await evo.listExecutions({ proposalId: p.id })).length, 1, '普通提案照常入队');
});

// ── setStatus 仍可写这个标记，但它**不许**撤队列（2026-10-29）──────────
await withApp(async ({ evo }) => {
  const p = await evo.propose({ title: '先可执行后标记', body: '正文' });
  await evo.setStatus(p.id, 'approved', '批准', { execMode: 'immediate' });
  assert.equal((await evo.listExecutions({ proposalId: p.id })).length, 1);
  const rec = await evo.setStatus(p.id, 'approved', '补一个历史标记', { autoExecutable: false });
  assert.equal(rec.autoExecutable, false);
  assert.equal((await evo.listExecutions({ proposalId: p.id, state: 'queued' })).length, 1, '标记不再撤队列');
});

// ── 2026-10-30：partial 之后**自动续跑剩余单元** ─────────────────────────
//
// 实机（2026-10-29，提案 a6e6e1d9）：3 个原子单元只落地 1 个就停在那儿，面板把它
// 归进「已批准·等手动执行（工作单）」—— 正是老板说的「让我去执行」。
// 根因不在面板分档，而在 partial 之后没人问「剩下的谁来跑」。
await withApp(async ({ evo }) => {
  const p = await evo.propose({ title: '多单元提案', body: '正文' });
  await evo.setStatus(p.id, 'approved', '批准', { execMode: 'immediate' });
  const [job] = await evo.claimDueExecutions({ now: Date.now() + 1000, limit: 5 });
  await evo.finishExecution(job.id, {
    ok: true, commitPath: 'a.js', partial: true,
    unitsApplied: 1, unitsTotal: 3, remainingUnits: ['b.js', 'c.js'],
    reason: '部分落地（1/3 个原子单元）',
  });

  const rec = await evo.getProposal(p.id);
  assert.equal(rec.status, 'approved', 'partial 不许结案成 applied（那是替剩下两份结账）');

  const jobs = await evo.listExecutions({ proposalId: p.id });
  const queued = jobs.filter((j) => j.state === 'queued');
  assert.equal(queued.length, 1, '剩余单元必须自动续跑 —— 不许停在「等人做」那一档');
  assert.equal(queued[0].requestedBy, 'auto-continue');
  assert.equal(queued[0].continuations, 1, '第一次续跑记 1');
  assert.equal(rec.execState, 'queued', '续跑排上了，提案就该显示在自动执行档');

  const first = jobs.find((j) => j.id === job.id);
  assert.equal(first.unitsTotal, 3, '范围账要落库 —— 续跑判据只能靠它');
  assert.deepEqual(first.remainingUnits, ['b.js', 'c.js']);
});

// ── 没推进就不许再排：否则是烧 token 的死循环 ────────────────────────────
await withApp(async ({ evo }) => {
  const p = await evo.propose({ title: '卡住的提案', body: '正文' });
  await evo.setStatus(p.id, 'approved', '批准', { execMode: 'immediate' });

  const [j1] = await evo.claimDueExecutions({ now: Date.now() + 1000, limit: 5 });
  await evo.finishExecution(j1.id, {
    ok: true, partial: true, unitsApplied: 1, unitsTotal: 3,
    remainingUnits: ['b.js', 'c.js'], reason: '部分落地（1/3）',
  });

  const [j2] = await evo.claimDueExecutions({ now: Date.now() + 2000, limit: 5 });
  assert.ok(j2, '续跑那条应当被 claim 到');
  assert.equal(j2.continuations, 1);

  // 第二轮剩余清单没变 ⇒ done 还是 1 ⇒ 判为没推进
  await evo.finishExecution(j2.id, {
    ok: true, partial: true, unitsApplied: 1, unitsTotal: 3,
    remainingUnits: ['b.js', 'c.js'], reason: '部分落地（1/3）',
  });

  const rec = await evo.getProposal(p.id);
  const queued = (await evo.listExecutions({ proposalId: p.id })).filter((j) => j.state === 'queued');
  assert.equal(queued.length, 0, '没推进就不许再排 —— 「试过一次没变」重试也不会变');
  assert.equal(rec.execState, 'partial', '停在 partial，别伪装成还在跑');
  assert.match(rec.execError, /没推进/, '要写明为什么停了，否则读的人分不清「做完了」和「做不动了」');
});

// ── 没有剩余单元 ⇒ 不续跑（requiresNewAsset 的空快照也走这条）─────────────
await withApp(async ({ evo }) => {
  const p = await evo.propose({ title: '要新建资产的提案', body: '正文' });
  await evo.setStatus(p.id, 'approved', '批准', { execMode: 'immediate' });
  const [job] = await evo.claimDueExecutions({ now: Date.now() + 1000, limit: 5 });
  await evo.finishExecution(job.id, {
    ok: true, partial: true, unitsApplied: 0, unitsTotal: 2,
    remainingUnits: [], reason: '需要新建资产，本轮只出快照',
  });
  const queued = (await evo.listExecutions({ proposalId: p.id })).filter((j) => j.state === 'queued');
  assert.equal(queued.length, 0, '没有可改的目标，再跑一次只会得到同样的结论');
});

// ── 配置可关掉续跑（0 = 回到 2026-10-28 的行为）───────────────────────────
await withApp(async ({ evo }) => {
  const p = await evo.propose({ title: '关掉续跑', body: '正文' });
  await evo.setStatus(p.id, 'approved', '批准', { execMode: 'immediate' });
  const [job] = await evo.claimDueExecutions({ now: Date.now() + 1000, limit: 5 });
  await evo.finishExecution(job.id, {
    ok: true, partial: true, unitsApplied: 1, unitsTotal: 3,
    remainingUnits: ['b.js', 'c.js'], reason: '部分落地（1/3）',
  });
  const queued = (await evo.listExecutions({ proposalId: p.id })).filter((j) => j.state === 'queued');
  assert.equal(queued.length, 0, 'maxAutoContinuations=0 ⇒ 一条都不排');
  assert.match((await evo.getProposal(p.id)).execError, /续跑已关闭/);
}, { maxAutoContinuations: 0 });

// ── 2026-11-02：孤儿执行回收（提案 a6e6e1d9 实证）──────────────────────
//
// 实机：exec-1793280728689-kmy9h1 停在 state='running'（startedAt=
// 2026-11-01T16:00:04.986Z，finishedAt=''），面板显示「已批准·执行中」，
// 但没有任何东西在跑 —— 宿主在执行途中重启，结算撞上已 dispose 的存储域被吞掉。
// 队列不自愈：running 行永不被 claim，又被 activeJobsFor 算成活跃 job。
await withApp(async ({ evo }) => {
  const p = await evo.propose({ title: '重启遗留的提案', body: '正文' });
  await evo.setStatus(p.id, 'approved', '批准', { execMode: 'immediate' });
  const [job] = await evo.claimDueExecutions({ now: Date.now() + 1000, limit: 5 });

  // 模拟「宿主在执行途中重启」：本进程挂载时刻晚于该行的 startedAt。
  const mountedAt = Date.now() + 60_000;
  const out = await evo.reapOrphanExecutions({ now: mountedAt, mountedAt, staleMs: 30 * 60_000 });
  assert.equal(out.count, 1, '重启前就在 running 的行必须被回收');
  assert.equal(out.reaped[0].id, job.id);

  const after = await evo.listExecutions({ proposalId: p.id });
  assert.equal(after[0].state, 'failed', '孤儿行落 failed（不是 cancelled：中断≠人撤销）');
  assert.equal(after[0].finishedAt !== '', true, '回收必须写 finishedAt，否则仍像在跑');
  assert.match(after[0].error, /宿主重启|进程中断/);

  const rec = await evo.getProposal(p.id);
  assert.equal(rec.status, 'approved', '⛔ 回收不得把提案标 applied —— 中断的是一次执行，不是这件事做完了');
  assert.notEqual(rec.execState, 'running', '提案不得再显示「执行中」');
  assert.match(rec.execError, /未结算|中断/, '要写明为什么停了，否则读的人分不清「做完了」和「做不动了」');
});

// ── 回收不得吃掉本进程正在跑的 job ────────────────────────────────────
await withApp(async ({ evo }) => {
  const p = await evo.propose({ title: '本进程正在跑的提案', body: '正文' });
  await evo.setStatus(p.id, 'approved', '批准', { execMode: 'immediate' });
  const [job] = await evo.claimDueExecutions({ now: Date.now() + 1000, limit: 5 });

  const out = await evo.reapOrphanExecutions({
    now: Date.now(), mountedAt: Date.now() - 10_000, staleMs: 30 * 60_000,
    excludeIds: [job.id],
  });
  assert.equal(out.count, 0, 'excludeIds 里的 job 不能被判成孤儿');
  assert.equal((await evo.listExecutions({ proposalId: p.id }))[0].state, 'running');
});

// ── 超时兜底：没有跨进程证据时，靠 staleMs 判孤儿 ────────────────────────
await withApp(async ({ evo }) => {
  const p = await evo.propose({ title: '卡住很久的提案', body: '正文' });
  await evo.setStatus(p.id, 'approved', '批准', { execMode: 'immediate' });
  const [job] = await evo.claimDueExecutions({ now: Date.now() + 1000, limit: 5 });

  // mountedAt 早于 startedAt（没有跨进程证据），但已 running 超过 staleMs。
  const out = await evo.reapOrphanExecutions({
    now: Date.now() + 60 * 60_000, mountedAt: Date.now() - 1000, staleMs: 60_000,
  });
  assert.equal(out.count, 1, '超过 staleMs 且不在活跃执行里 ⇒ 兜底判孤儿');
  assert.equal((await evo.listExecutions({ proposalId: p.id }))[0].state, 'failed');
});

// ── 非 running 行不得被回收（回收范围只限 running）─────────────────────
await withApp(async ({ evo }) => {
  const p = await evo.propose({ title: '正常排队的提案', body: '正文' });
  await evo.setStatus(p.id, 'approved', '批准', { execMode: 'immediate' });
  const out = await evo.reapOrphanExecutions({ now: Date.now() + 999_999_999, mountedAt: Date.now() + 1 });
  assert.equal(out.count, 0, 'queued 行不是孤儿');
  assert.equal((await evo.listExecutions({ proposalId: p.id }))[0].state, 'queued');
});

// ── 提案级范围账落到 proposal 行（2026-11-07）──────────────────────────
//
// driver 一次执行交回 commits[]，面板只读 proposal 表 ⇒ 必须在这里同步写过去。
await withApp(async ({ evo }) => {
  const p = await evo.propose({ title: '一次改两个文件', body: '正文' });
  await evo.setStatus(p.id, 'approved', '批准', { execMode: 'immediate' });
  const [job] = await evo.claimDueExecutions({ now: Date.now() + 1000, limit: 5 });
  await evo.finishExecution(job.id, {
    ok: true,
    commitPath: 'plugins/x/a.js',
    commits: [
      { path: 'plugins/x/a.js', policyDecision: 'AUTO_DEPLOY' },
      { path: 'plugins/_shared/helper.js', created: true },
    ],
    unitsApplied: 2,
    unitsTotal: 3,
    remainingUnits: ['plugins/x/c.js'],
  });
  const rec = await evo.getProposal(p.id);
  assert.equal(rec.execCommits.length, 2, 'commits[] 必须落到 proposal 行');
  assert.equal(rec.execCommits[1].created, true, '新建文件要能标出来');
  assert.equal(rec.execUnitsApplied, 2);
  assert.equal(rec.execUnitsTotal, 3);
  assert.deepEqual(rec.execRemainingUnits, ['plugins/x/c.js']);
});

// ── 确定性不可执行 ⇒ 退出自动队列，不挂 failed（2026-11-07）────────────
//
// 根因：执行器只做单原子文件编辑，特性级/机械动作提案没有仓库目标 ⇒ driver 判
// deterministic not-actionable ⇒ 旧协议把提案打成 execState=failed，面板
// 「已批准·执行失败」永久挂着，没有自动出口。收口口径：保留 approved（批准是
// 人的决定），execMode 降 manual、execState 归 idle，原因写进 execError/note。
await withApp(async ({ evo }) => {
  const p = await evo.propose({ title: '特性级提案', body: '正文没有仓库路径' });
  await evo.setStatus(p.id, 'approved', '批准', { execMode: 'immediate' });
  const [job] = await evo.claimDueExecutions({ now: Date.now() + 1000, limit: 5 });
  await evo.finishExecution(job.id, { ok: false, error: 'no target asset resolved' });
  assert.equal((await evo.getProposal(p.id)).execState, 'failed', '前置：旧路径会留下 failed');

  const parked = await evo.markNotActionable(p.id, 'no target asset resolved (mentioned:0 inRepo:0)');
  assert.equal(parked.status, 'approved', '批准是人的决定，机器不撤销');
  assert.equal(parked.execMode, 'manual', '退出自动执行队列');
  assert.equal(parked.execState, 'idle', '不得再挂 failed');
  assert.match(parked.execError, /自动执行不适用/);
  assert.match(parked.note, /请人工结案/, 'note 必须写明下一步');
  assert.match(parked.note, /批准/, '原有 note 不得被覆盖');

  // 人已经改判过的行，机器不抢写
  await evo.setStatus(p.id, 'applied', '已实现', {});
  const after = await evo.markNotActionable(p.id, 'late');
  assert.equal(after.status, 'applied', '非 approved 的行不得被收口改写');
});

// ── 环境故障顺延 ⇒ 退还本次尝试额度（2026-11-07）──────────────────────
//
// 根因：LLM 通道挂掉与提案本身无关，但 claim 已经把 attempts +1 记在提案上。
// 不退额度的话，通道恢复时这条提案已经被烧完 2 次、永久失去自动执行资格
// （实机 cdf41d63：批准后 9 秒内两次撞同一个通道故障）。
await withApp(async ({ evo }) => {
  const p = await evo.propose({ title: '通道故障期间被顺延的提案', body: '正文' });
  await evo.setStatus(p.id, 'approved', '批准', { execMode: 'immediate' });
  const [job] = await evo.claimDueExecutions({ now: Date.now() + 1000, limit: 5 });
  assert.equal(job.attempts, 1, '前置：claim 会消耗一次额度');
  assert.equal((await evo.getProposal(p.id)).execAttempts, 1);

  const dueAt = new Date(Date.now() + 300_000).toISOString();
  const next = await evo.requeueExecution(job.id, {
    dueAt, reason: '环境不可用（llm unavailable）', deferred: true, refundAttempt: true,
  });
  assert.equal(next.state, 'deferred');
  assert.equal(next.attempts, 0, '环境故障必须退还本次 claim 的额度');
  const rec = await evo.getProposal(p.id);
  assert.equal(rec.execState, 'deferred', '提案是顺延，不是失败');
  assert.equal(rec.execAttempts, 0, '提案侧计数也要跟着退，否则面板与执行行对不上');
  assert.equal(rec.status, 'approved', '批准不受影响');
  assert.match(rec.execError, /环境不可用/);

  // 普通失败（不传 refundAttempt）保持原行为：额度照扣，否则重试上限失效
  const [job2] = await evo.claimDueExecutions({ now: Date.now() + 400_000, limit: 5 });
  assert.equal(job2.attempts, 1);
  const again = await evo.requeueExecution(job2.id, { dueAt, reason: '第 1 次失败', error: 'x' });
  assert.equal(again.state, 'queued');
  assert.equal(again.attempts, 1, '普通失败不退还');
});

console.log('# agint-evolve execution smoke: ok（批准即入队 / blocker / 定时 / 失败 / 撤销 / 统计 / 惰性标记 / 续跑 / 孤儿回收 / 不可执行收口）');
