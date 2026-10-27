// 集成：真 agint-evolve + 真 agint-executor + 假 driver（2026-10-27）。
//
// 为什么需要这一层：两边的单测各自用替身（evolve 的用例替 executor，executor 的用例替 evolve），
// 替身**各自以为**对方的方法名/返回形状是对的。接口一旦对不上，两边单测都绿、装上去全哑。
// 这里用**真实实现**对接一次，只把 driver（真 LLM + 真写仓库）换成假的。
//
// 运行：node --import ./test/_stub-register.mjs test/executor-integration.test.mjs

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply as applyEvolve } from '../lib/index.js';
import { apply as applyExecutor } from '../../agint-executor/lib/index.js';

function makeCtx() {
  const tables = new Map();
  const provides = new Map();
  const effects = [];
  return {
    _provides: provides,
    _effects: effects,
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
              put: async (id, v) => { t.set(id, v); return true; },
              delete: async (id) => t.delete(id),
              entries: () => [...t.entries()],
            };
          },
          async close() {},
        };
      },
    },
    effect(fn) { effects.push(fn()); },
    provide(k, v) { provides.set(k, v); },
    get(k) { return provides.get(k) ?? null; },
    on() {},
    setInterval() { return { dispose() {} }; },
    setTimeout() { return { dispose() {} }; },
    logger: { warn() {}, info() {}, error() {} },
  };
}

const root = await mkdtemp(join(tmpdir(), 'agint-integration-'));
const ctx = makeCtx();
applyEvolve(ctx, { root });
applyExecutor(ctx, { enabled: false, maxAttempts: 2 });

const evolve = ctx.get('agint.evolve');
const executor = ctx.get('agint.executor');
assert.ok(evolve, 'agint.evolve 服务已注册');
assert.ok(executor, 'agint.executor 服务已注册');

try {
  // ── 1. 批准即入队 → 执行器捡到 → driver 落地 → 提案 applied ──────────
  let driverCalls = 0;
  ctx.provide('agint.evolutionDriver', {
    async runForProposal(proposalId) {
      driverCalls += 1;
      return {
        skipped: false,
        proposalId: 'mut-1',
        commit: { ok: true, path: `plugins/${proposalId}/lib/x.js`, policyDecision: 'AUTO_DEPLOY' },
      };
    },
  });

  const p1 = await evolve.propose({ title: '改 e1', body: '正文' });
  const approved1 = await evolve.setStatus(p1.id, 'approved', '批', { execMode: 'immediate' });
  assert.equal(approved1.execState, 'queued', '真实 setStatus 应把提案放进队列');

  const tick1 = await executor.tick({ force: true, now: Date.now() + 1000 });
  assert.equal(tick1.ran, 1, '执行器应捡到这条执行（两边接口对齐）');
  assert.equal(driverCalls, 1);
  assert.equal(tick1.results[0].ok, true);

  const after1 = await evolve.getProposal(p1.id);
  assert.equal(after1.status, 'applied', '成功后提案应标 applied');
  assert.equal(after1.execState, 'succeeded');
  assert.match(after1.note, /自动执行落地/);

  // ── 2. 定时未到：执行器不该跑 ────────────────────────────────────────
  const p2 = await evolve.propose({ title: '改 e2', body: '正文' });
  const at = new Date(Date.now() + 3600_000).toISOString();
  await evolve.setStatus(p2.id, 'approved', '定时跑', { execMode: 'scheduled', execAt: at });
  const tick2 = await executor.tick({ force: true, now: Date.now() + 1000 });
  assert.equal(tick2.ran, 0, '定时未到不该被 claim');
  assert.equal(driverCalls, 1, 'drive 不该被多调一次');

  // 到点后能跑（driver 这次返回失败，验证失败路径的接口）
  ctx.provide('agint.evolutionDriver', {
    async runForProposal() {
      return { skipped: true, reason: 'no actionable candidate', failures: ['p: no target asset resolved'] };
    },
  });
  const tick3 = await executor.tick({ force: true, now: Date.now() + 3600_000 + 2000 });
  assert.equal(tick3.ran, 1, '到点后应被 claim');
  const after2 = await evolve.getProposal(p2.id);
  assert.equal(after2.status, 'approved', '失败不得标 applied');
  assert.equal(after2.execState, 'queued', '还有一次重试额度 ⇒ 回到排队（execState=queued）');
  assert.match(after2.execError, /no target asset/);

  const execRows = await evolve.listExecutions({ proposalId: p2.id });
  assert.equal(execRows.length, 1, '重试复用同一行，不新增行');
  assert.equal(execRows[0].attempts, 1);

  // ── 3. 驱动缺席：失败要留下"没有执行能力"，而不是静默或顺延 ─────────────
  const p3 = await evolve.propose({ title: '改 e3', body: '正文' });
  await evolve.setStatus(p3.id, 'approved', '批', { execMode: 'immediate' });
  ctx._provides.delete('agint.evolutionDriver');
  const tick4 = await executor.tick({ force: true, now: Date.now() + 1000 });
  assert.equal(tick4.results[0].action, 'fail');
  const after3 = await evolve.getProposal(p3.id);
  assert.equal(after3.execState, 'failed');
  assert.match(after3.execError, /runForProposal 未挂载/);

  console.log('# executor ⇄ evolve 集成: ok（入库→claim→落地/失败/缺驱动 三条路径接口对齐）');
} finally {
  await rm(root, { recursive: true, force: true });
}
