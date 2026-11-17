// agint-evolve 判决 + 结案（2026-11-08）。
//
// 钉的是「结案四件事一次做完」与「不该抢写」：
//   ① 写判决字段 / 落终态 / 撤活跃 job / 留复活路径
//   ② 只动 approved：人已改判的不抢写，重复结案幂等
//   ③ listUnsettledProposals 只列有执行行证据、且未判决的悬案
//   ④ 面板 stage 的「已结束」要说清判成了什么（负控制：老 wontfix 不受影响）
//   ⑤ markNotActionable 与 settleExecution(not-actionable) 等价
//
// 运行：node --test plugins/agint-evolve/test/verdict-settle.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';
import { ticketStage } from '../lib/execution.js';

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
    _provides: new Map(),
    effect() {},
    provide(k, v) { this._provides.set(k, v); },
    get(k) { return this._provides.get(k) ?? null; },
    on() {},
    setInterval() { return { dispose() {} }; },
  };
}

async function withApp(fn) {
  const root = await mkdtemp(join(tmpdir(), 'agint-evolve-verdict-'));
  const ctx = makeMockCtx();
  apply(ctx, { root });
  const evo = ctx.get('agint.evolve');
  assert.ok(evo, 'agint.evolve 服务已注册');
  try {
    await fn({ evo });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('① settleExecution：判决字段 + 终态 + 撤队列 + 复活路径一次做完', async () => {
  await withApp(async ({ evo }) => {
    const p = await evo.propose({ title: '额度耗尽的提案', body: '正文' });
    await evo.setStatus(p.id, 'approved', '批准', { execMode: 'immediate' });
    const before = await evo.listExecutions({ proposalId: p.id });
    assert.ok(before.some((j) => j.state === 'queued'), '前置：批准即入队');

    const r = await evo.settleExecution(p.id, { verdict: 'exhausted', reason: '重试额度用尽：policy REJECT' });
    assert.equal(r.status, 'wontfix');
    assert.equal(r.execVerdict, 'exhausted');
    assert.notEqual(r.execVerdictAt, '');
    assert.equal(r.execMode, 'manual');
    assert.equal(r.execState, 'idle');
    assert.match(r.execError, /policy REJECT/, '理由原文必须可复现');
    assert.match(r.note, /要复活/, '结案必须写明可逆路径');

    const after = await evo.listExecutions({ proposalId: p.id });
    assert.ok(after.length > 0);
    assert.ok(after.every((j) => j.state === 'cancelled'), '结案后不该还留着活跃排队');
  });
});

test('② 只动 approved：非 approved 不抢写；重复结案幂等', async () => {
  await withApp(async ({ evo }) => {
    const p = await evo.propose({ title: '人已实现的提案', body: '正文' });
    await evo.setStatus(p.id, 'applied', '已实现', {});
    const late = await evo.settleExecution(p.id, { verdict: 'exhausted', reason: 'late' });
    assert.equal(late, null, '没结成必须如实返回 null，不许谎报成功');
    assert.equal((await evo.getProposal(p.id)).status, 'applied', '人的改判不许被覆盖');

    const q = await evo.propose({ title: '待结案提案', body: '正文' });
    await evo.setStatus(q.id, 'approved', '批准', { execMode: 'manual' });
    const first = await evo.settleExecution(q.id, { verdict: 'not-actionable', reason: 'no target asset resolved' });
    const note1 = first.note;
    const second = await evo.settleExecution(q.id, { verdict: 'exhausted', reason: 'again' });
    assert.equal(second, null, '同一提案不重复结案');
    assert.equal((await evo.getProposal(q.id)).note, note1, 'note 不许被追加第二遍');
  });
});

test('③ listUnsettledProposals：只列有执行行证据、且未判决的悬案', async () => {
  await withApp(async ({ evo }) => {
    const a = await evo.propose({ title: '失败过的提案', body: '正文' });
    await evo.setStatus(a.id, 'approved', '批准', { execMode: 'immediate' });
    const [job] = await evo.claimDueExecutions({ now: Date.now() + 1000, limit: 5 });
    await evo.finishExecution(job.id, { ok: false, error: 'no target asset resolved' });

    const list1 = await evo.listUnsettledProposals();
    assert.equal(list1.length, 1);
    assert.equal(list1[0].id, a.id);
    assert.equal(list1[0].execState, 'failed', '这里带的是执行行状态，不是提案 execState');
    assert.match(list1[0].error, /no target asset resolved/);

    await evo.settleExecution(a.id, { verdict: 'not-actionable', reason: 'no target asset resolved' });
    assert.equal((await evo.listUnsettledProposals()).length, 0, '已判决的不再列');

    // negative control：approved + manual、从没执行过 ⇒ 没有证据，不列。
    const b = await evo.propose({ title: '只批准没执行的提案', body: '正文' });
    await evo.setStatus(b.id, 'approved', '批准', { execMode: 'manual' });
    assert.equal((await evo.listUnsettledProposals()).length, 0, '不许凭 execError 文本编一个判决');
  });
});

test('④ ticketStage：已结案要说清判成了什么；老 wontfix 不受影响', () => {
  const withV = ticketStage({ status: 'wontfix', execVerdict: 'interrupted', execError: '宿主重启导致未结算' });
  assert.equal(withV.stage, 'closed');
  assert.match(withV.why, /interrupted/, '面板只读落盘 JSON，判决必须能从提案行看出来');
  assert.match(withV.why, /已结案/);
  const without = ticketStage({ status: 'wontfix' });
  assert.equal(without.stage, 'closed');
  assert.match(without.why, /提案已 wontfix/);
  assert.doesNotMatch(without.why, /已结案·/, '没有判决字段的老行不许显示成执行器结的案');
});

test('⑤ markNotActionable 是 settleExecution(not-actionable) 的等价兼容入口', async () => {
  await withApp(async ({ evo }) => {
    const p = await evo.propose({ title: '兼容入口', body: '正文' });
    await evo.setStatus(p.id, 'approved', '批准', { execMode: 'manual' });
    const r = await evo.markNotActionable(p.id, 'no target asset resolved');
    assert.equal(r.status, 'wontfix');
    assert.equal(r.execVerdict, 'not-actionable');
    assert.equal(r.execMode, 'manual');
    assert.equal(r.execState, 'idle');
    assert.match(r.note, /要复活/);
  });
});
