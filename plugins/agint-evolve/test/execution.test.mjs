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

async function withApp(fn) {
  const root = await mkdtemp(join(tmpdir(), 'agint-evolve-exec-'));
  const ctx = makeMockCtx();
  apply(ctx, { root });
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

console.log('# agint-evolve execution smoke: ok（批准即入队 / blocker / 定时 / 失败 / 撤销 / 统计）');
