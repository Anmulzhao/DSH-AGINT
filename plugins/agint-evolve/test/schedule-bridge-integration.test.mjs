// 端到端：真 apply(agint-evolve) + 假 ctx.schedule，证「批准 → dsh 原生自动化任务」。
// 单测 schedule-bridge.test.mjs 只测纯模块；这里测它真的挂进了批准路径。
// 运行：node --test plugins/agint-evolve/test/schedule-bridge-integration.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';
import { PROPOSAL_TASK_PREFIX } from '../lib/schedule-bridge.js';

function fakeCtx(scheduleSvc) {
  const tables = new Map();
  const provides = new Map();
  provides.set('schedule', scheduleSvc);
  return {
    storageDomain: {
      async open(spec) {
        const t = (name) => {
          let m = tables.get(name);
          if (!m) { m = new Map(); tables.set(name, m); }
          return {
            get: (id) => m.get(id) ?? null,
            put: async (id, v) => { m.set(id, v); return true; },
            delete: async (id) => m.delete(id),
            entries: () => [...m.entries()],
          };
        };
        return { name: spec.name, version: spec.version, table: t, async close() {} };
      },
    },
    _tables: tables,
    effect() {},
    provide(k, v) { provides.set(k, v); },
    get(k) { return provides.get(k) ?? null; },
    on() {},
    setInterval() { return { dispose() {} }; },
    setTimeout(fn) { return { dispose() {} }; },
    logger: { info() {}, warn() {} },
  };
}

function fakeSchedule() {
  const rows = new Map();
  let seq = 0;
  return {
    _rows: rows,
    async catalog() { return [...rows.values()]; },
    async list() { return { items: [...rows.values()], total: rows.size }; },
    async create(req) { const id = `task-${++seq}`; rows.set(id, { id, ...req }); return { id }; },
    async edit(req) { if (req.action === 'delete') rows.delete(req.id); return {}; },
  };
}

async function withApp(scheduleSvc, fn, cfg = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agint-sched-int-'));
  const ctx = fakeCtx(scheduleSvc);
  apply(ctx, { root, scheduleBridge: { enabled: true, immediateDelaySeconds: 10 }, ...cfg });
  const evo = ctx.get('agint.evolve');
  try { await fn({ evo, ctx, root }); } finally { await rm(root, { recursive: true, force: true }); }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test('批准 → execution 入队 + dsh 自动化任务创建（真 apply）', async () => {
  const sched = fakeSchedule();
  await withApp(sched, async ({ evo, ctx }) => {
    const rec = await evo.propose({ title: '补门禁', body: '加 check-x.mjs', execMode: 'immediate' });
    assert.equal(sched._rows.size, 0, '提议阶段不建 dsh 任务');

    const approved = await evo.setStatus(rec.id, 'approved');
    assert.equal(approved.status, 'approved');
    await flush(); // sync 是 fire-and-forget，让微任务跑完

    assert.equal(sched._rows.size, 1, '批准恰好建一条 dsh 自动化任务');
    const task = [...sched._rows.values()][0];
    assert.equal(task.title, `${PROPOSAL_TASK_PREFIX}${rec.id}`);
    assert.equal(task.timing.kind, 'after');
    assert.equal(task.target.kind, 'new_once');
    assert.equal(task.target.create.agentPreset, 'agint');
    assert.match(task.prompt, /evolve_executions/);
    assert.match(task.prompt, /action=run/);

    // execution 表仍在（单一事实源，不是被 dsh 任务替代）。
    const jobs = [...(ctx._tables.get('execution')?.values() ?? [])];
    assert.ok(jobs.some((j) => j.proposalId === rec.id && j.state === 'queued'), 'execution 表仍入队');
  });
});

test('撤销批准 → dsh 自动化任务被删除（真 apply）', async () => {
  const sched = fakeSchedule();
  await withApp(sched, async ({ evo }) => {
    const rec = await evo.propose({ title: '定时', body: 'B', execMode: 'immediate' });
    await evo.setStatus(rec.id, 'approved');
    await flush();
    assert.equal(sched._rows.size, 1);

    await evo.setStatus(rec.id, 'proposed'); // 撤销批准，离开 approved
    await flush();
    assert.equal(sched._rows.size, 0, '离开 approved 后 dsh 任务被删除');
  });
});

test('开关关闭：批准入队但不建任何 dsh 任务（阴性对照）', async () => {
  const sched = fakeSchedule();
  await withApp(sched, async ({ evo, ctx }) => {
    const rec = await evo.propose({ title: '关', body: 'B', execMode: 'immediate' });
    await evo.setStatus(rec.id, 'approved');
    await flush();
    assert.equal(sched._rows.size, 0, '默认关闭路径零副作用');
    const jobs = [...(ctx._tables.get('execution')?.values() ?? [])];
    assert.ok(jobs.some((j) => j.proposalId === rec.id), 'execution 仍照常入队（executor 兜底）');
  }, { scheduleBridge: { enabled: false } });
});

test('dsh 服务不可用：批准照常入队，零抛错（软依赖兜底）', async () => {
  await withApp(null, async ({ evo, ctx }) => {
    const rec = await evo.propose({ title: '无服务', body: 'B', execMode: 'immediate' });
    const out = await evo.setStatus(rec.id, 'approved');
    await flush();
    assert.equal(out.status, 'approved', 'dsh 服务缺席不影响批准');
    const jobs = [...(ctx._tables.get('execution')?.values() ?? [])];
    assert.ok(jobs.some((j) => j.proposalId === rec.id), 'execution 仍入队');
  });
});
