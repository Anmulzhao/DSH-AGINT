// agint-evolve 提案批准后形成自动化任务（2026-11-14）。
//
// 钉的是「批准必然产生任务」，以及三条不许破的边界：
//   ① 新提案在提议时就有计划；批准沿用计划，不依赖调用方记得传 execMode。
//   ② 没有 execMode 的历史行仍归一 manual —— 升级不让存量提案突然改代码。
//   ③ 显式 manual / 全局 kill-switch / 定时计划三种否决与例外都有出口。
//
// 每条阳性断言都配一条负控制：只验「任务出现了」不够，还要验「不该出现时没出现」。
// 运行：node --test plugins/agint-evolve/test/proposal-task-formation.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

function makeMockCtx(seedRows = []) {
  const tables = new Map();
  const proposal = new Map();
  for (const row of seedRows) proposal.set(row.id, row);
  tables.set('proposal', proposal);
  const events = [];
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
    _events: events,
    _provides: new Map([
      ['agint.eventBus.publish', async (envelope) => {
        events.push(envelope);
        return { envelopeId: 'e1', deliveredTo: 1 };
      }],
    ]),
    effect() {},
    provide(k, v) { this._provides.set(k, v); },
    get(k) { return this._provides.get(k) ?? null; },
    on() {},
    setInterval() { return { dispose() {} }; },
  };
}

async function withApp(config, fn, seedRows = []) {
  const root = await mkdtemp(join(tmpdir(), 'agint-evolve-task-'));
  const ctx = makeMockCtx(seedRows);
  apply(ctx, { root, ...config });
  const evo = ctx.get('agint.evolve');
  assert.ok(evo, 'agint.evolve 服务已注册');
  try {
    await fn({ evo, ctx });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const jobsOf = (ctx, proposalId) => [...(ctx._tables.get('execution')?.values() ?? [])]
  .filter((j) => j && j.proposalId === proposalId);

const futureIso = (ms) => new Date(Date.now() + ms).toISOString();

test('① 新提案默认带自动计划；批准恰好形成一条 queued 任务', async () => {
  await withApp({}, async ({ evo, ctx }) => {
    const rec = await evo.propose({ title: '补一个门禁', body: '在 bin/ 下加 check-x.mjs' });
    assert.equal(rec.execMode, 'immediate', '新提案默认计划必须是 immediate');
    assert.equal(rec.status, 'proposed', '提议不是批准');
    assert.equal(jobsOf(ctx, rec.id).length, 0, '提议阶段不得建任务');

    const approved = await evo.setStatus(rec.id, 'approved');
    assert.equal(approved.status, 'approved', '批准 ≠ 已落地');
    assert.equal(approved.execState, 'queued', '批准即排队');
    const jobs = jobsOf(ctx, rec.id);
    assert.equal(jobs.length, 1, '一次批准只建一条任务，不叠单');
    assert.equal(jobs[0].state, 'queued');
    assert.equal(jobs[0].mode, 'immediate');
    assert.equal(jobs[0].requestedBy, 'approval');

    const evt = ctx._events.find((e) => e.topic === 'evolution.status-changed');
    assert.equal(evt?.payload?.execMode, 'immediate', '事件总线要能看见「批准 + 自动计划」');
    assert.equal(evt?.payload?.to, 'approved');
  });
});

test('② 负控制：缺 execMode 的历史行批准仍不建任务', async () => {
  // 加字段之前写入的行：只有 9 个键，没有执行计划。
  const legacy = {
    id: 'legacy-1', title: '老提案', body: 'B', category: 'other',
    status: 'proposed', source: '', note: '',
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  };
  await withApp({}, async ({ evo, ctx }) => {
    const approved = await evo.setStatus(legacy.id, 'approved');
    assert.equal(approved.execMode, 'manual', '老行归一成 manual');
    assert.equal(approved.execState, 'idle', '老行不该排队');
    assert.equal(jobsOf(ctx, legacy.id).length, 0, '升级不能让存量提案突然改代码');
  }, [legacy]);
});

test('③ 显式 manual 是结构化否决：提议方声明「仅建议」后批准不建任务', async () => {
  await withApp({}, async ({ evo, ctx }) => {
    const rec = await evo.propose({
      title: '美谕建议', body: '仅存为建议，不自动生效', execMode: 'manual',
    });
    assert.equal(rec.execMode, 'manual');
    const approved = await evo.setStatus(rec.id, 'approved');
    assert.equal(approved.execState, 'idle');
    assert.equal(jobsOf(ctx, rec.id).length, 0, '显式 manual 必须盖过默认 immediate');
  });
});

test('④ kill-switch 回退默认，但不剥夺显式声明', async () => {
  await withApp({ defaultExecMode: 'manual' }, async ({ evo, ctx }) => {
    const quiet = await evo.propose({ title: '默认回退', body: 'B' });
    assert.equal(quiet.execMode, 'manual', '配 manual 后新提案回到只批准');
    await evo.setStatus(quiet.id, 'approved');
    assert.equal(jobsOf(ctx, quiet.id).length, 0);

    // 负控制：kill-switch 管的是「默认」，不是封死自动执行。
    const loud = await evo.propose({ title: '仍要自动', body: 'B', execMode: 'immediate' });
    assert.equal(loud.execMode, 'immediate');
    await evo.setStatus(loud.id, 'approved');
    assert.equal(jobsOf(ctx, loud.id).length, 1, '显式 immediate 仍可覆盖全局默认');
  });
});

test('⑤ 定时计划：批准形成到期任务；缺时刻或非法模式一律抛错且不留行', async () => {
  await withApp({}, async ({ evo, ctx }) => {
    const at = futureIso(2 * 60 * 60 * 1000);
    const rec = await evo.propose({ title: '定时', body: 'B', execMode: 'scheduled', execAt: at });
    assert.equal(rec.execMode, 'scheduled');
    await evo.setStatus(rec.id, 'approved');
    const jobs = jobsOf(ctx, rec.id);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].mode, 'scheduled');
    assert.equal(jobs[0].dueAt, at, '任务到期时刻必须等于批准前定下的时刻');

    const before = ctx._tables.get('proposal').size;
    await assert.rejects(
      () => evo.propose({ title: '缺时刻', body: 'B', execMode: 'scheduled' }),
      /必须给 execAt/,
      '定时缺时刻不得静默降级成 immediate',
    );
    await assert.rejects(
      () => evo.propose({ title: '非法模式', body: 'B', execMode: 'maybe' }),
      /不在白名单/,
    );
    assert.equal(ctx._tables.get('proposal').size, before, '校验失败不得落库');
  });
});
