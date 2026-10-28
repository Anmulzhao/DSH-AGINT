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

  // ── 4. 部分落地：job 成功 ≠ 提案做完（2026-10-28 v0.2.1，提案 `846f4fbb` 实证）──
  //
  // 前面 driver 返回了 `scope.complete=false`（3 个原子单元只落地 1 个）。
  // 旧口径：commit.ok ⇒ 成功 ⇒ 提案标 applied ⇒ 台账显示"已落地"，
  // 而正文里另外两处替身 + 共用模块从此没有任何入口。
  // 新口径：提案留在 approved，execState=partial，execError 写明还差哪些。
  // 本节用**真实** evolve + 真实 executor 对一次 —— 单测两边各自替身是验不出形状错配的。
  ctx.provide('agint.evolutionDriver', {
    async runForProposal(proposalId) {
      return {
        skipped: false,
        proposalId: 'mut-partial',
        commit: { ok: true, path: 'plugins/agint-evolve/test/_stub-dsh-tools.mjs', policyDecision: 'AUTO_DEPLOY' },
        scope: {
          targets: ['a.mjs', 'b.mjs', 'c.mjs'],
          unitsTotal: 3,
          unitsApplied: 1,
          remainingUnits: ['plugins/agint-input-gateway/test/_stub-storage-domain.mjs'],
          requiresNewAsset: false,
          complete: false,
          note: '范围记账 1/3',
        },
      };
    },
  });
  const p4 = await evolve.propose({ title: '收紧替身', body: '抽一份共用的替身，再逐个迁。' });
  await evolve.setStatus(p4.id, 'approved', '批', { execMode: 'immediate' });
  const tick5 = await executor.tick({ force: true, now: Date.now() + 1000 });
  assert.equal(tick5.results[0].ok, true, '单元确实落地了 ⇒ job 是成功的');
  assert.equal(tick5.results[0].partial, true, '但只覆盖了一部分 ⇒ 必须打 partial');
  const after4 = await evolve.getProposal(p4.id);
  assert.equal(after4.status, 'approved', '⛔ 不许标 applied —— 标了就等于把没做的部分一起结账');

  assert.equal(after4.execState, 'partial');
  assert.match(after4.execError, /部分落地/);
  assert.match(after4.execError, /agint-input-gateway/, '欠账里要点名具体文件路径，不然还得重走一遍取证');
  assert.match(after4.note, /部分落地/, 'note 是唯一能追溯"哪一部分已经落地"的地方');
  assert.equal(executor.status().partial, 1, '部分覆盖要单独计数 —— 否则周报把 1/3 的也数成"已落地"');

  // ── 5. 改判回退 ⇒ 执行态要跟着归位（2026-10-28，提案 `846f4fbb` 实证）──
  //
  // 上面那条被自动执行 thrust 成 applied（其实只落地一个单元），人工改判回 approved
  // 时，execState 仍停在 succeeded ⇒ 面板显示「已落地」，与台账的 status 正好相反。
  // 状态与执行态不许各说各话：脱离 applied 且没有活跃执行 ⇒ 归位 idle。
  // ⛔ 归位要发生在入队**之前**：execMode 若仍是 immediate，再入队是合法行为，
  //    队列优先（"马上又跑一次"），不该被归位逻辑抢掉 —— 所以改判到 manual/proposed 才测得到 idle。
  const reverted = await evolve.setStatus(p4.id, 'proposed', '人工改判回退那条假的结案', { execMode: 'manual' });
  assert.equal(reverted.status, 'proposed');
  assert.equal(reverted.execState, 'idle', '脱离 applied 且无活跃执行 ⇒ 执行态必须归位，不许留在 succeeded');

  // 阴性对照：第 1 节那条**真的**做完了，改判回退前它仍是 applied ⇒ 不受这条规则影响。
  assert.equal(after1.execState, 'succeeded', '真做完的那条不该被这条规则带偏');

  // `execState=succeeded` 只在 `status=applied` 时成立 —— 同 Apolo 同一份数据的两处口径
  // 不许相反：applied → approved 之后必须归位，否则面板照旧显示「已落地」。
  const reopened = await evolve.setStatus(p1.id, 'approved', '重新开工', { execMode: 'manual' });
  assert.equal(reopened.status, 'approved');
  assert.equal(reopened.execState, 'idle', 'status 已不是 applied ⇒ succeeded 必须归位 idle');

  console.log('# executor ⇄ evolve 集成: ok（入库→claim→落地/失败/缺驱动/部分落地 四条路径接口对齐）');
} finally {
  await rm(root, { recursive: true, force: true });
}
