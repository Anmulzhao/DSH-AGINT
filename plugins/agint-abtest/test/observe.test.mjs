/**
 * test/observe.test.mjs — observe 编排（方案 §九）
 *
 * 用真实 abtest 插件（mock storage ctx）+ 注入假执行器/judge/scriptRunner，
 * 测编排逻辑：候选对、语料 gating、预算帽、幂等续跑、24h abort、report 一次。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = pathToFileURL(resolve(__dirname, '../lib/index.js')).href;
const OBSERVE_PATH = pathToFileURL(resolve(__dirname, '../lib/observe.js')).href;
const TASKS_DIR = resolve(__dirname, '../tasks');
const REPO_ROOT = resolve(__dirname, '../../..');

function makeMockCtx() {
  const providers = {};
  const tables = {};
  const storageDomain = {
    open: async () => ({
      async table(name) {
        if (!tables[name]) tables[name] = new Map();
        return {
          put: async (id, value) => { tables[name].set(id, value); return true; },
          get: (id) => tables[name].get(id) ?? null,
          delete: async (id) => { tables[name].delete(id); return true; },
          entries: () => Array.from(tables[name].values()),
          get size() { return tables[name].size; },
        };
      },
    }),
  };
  return {
    effect: () => {},
    get: () => null,
    provide: (name, val) => { providers[name] = val; },
    storageDomain,
    on: () => {},
    _providers: providers,
    _tables: tables,
  };
}

async function realAbtest() {
  const mod = await import(PLUGIN_PATH);
  const ctx = makeMockCtx();
  mod.apply(ctx, {});
  return { ab: ctx._providers['agint.abtest'], ctx };
}

function variant(promptId, id, createdAt = '2026-11-18T00:00:00.000Z') {
  return {
    variant_id: id, commit_id: `c-${id}`, parent_variant_id: null,
    mutation_kind: 'PROMPT_MUTATION', source: 'evolution-reversed', atomic_scope: 'prompt',
    payload: { promptId, oldText: '旧文本片段', newText: '新文本片段，更长一些' },
    stage: 'PENDING_REVIEW', traffic_pct: 0, created_at: createdAt,
  };
}

function fakePopulation(variants) {
  return { stats: async () => ({ variants }) };
}

// 假执行器：按 answerShape 返回能过大部分判据的答案；计 LLM 调用数。
function fakeExecutor(state) {
  return async ({ task }) => {
    state.calls++;
    if (task.answerShape === 'steps') {
      return { ok: true, attempted: true, steps: ['校验 package.json', '同步 check-wiring', 'lint 维度 storage permissions', '第四步', '第五步'] };
    }
    if (task.answerShape === 'conclusion') {
      return { ok: true, attempted: true, conclusion: task.id === 'pp-06' ? '是' : '否' };
    }
    return { ok: true, attempted: true, text: `对任务 ${task.id} 的分析文本` };
  };
}

function fakeJudge(state) {
  return async ({ artifactText }) => {
    state.calls++;
    // 按工件长度给分，制造两版差异
    return { ok: true, attempted: true, score: 0.5 + (artifactText.length % 10) * 0.04 };
  };
}

function fakeScriptRunner(state) {
  return async () => {
    state.scriptCalls++;
    return { exitCode: 1, output: '─── fixture ───\n[FAIL] package.json 缺失\n' };
  };
}

const baseDeps = (over = {}) => ({
  tasksDir: TASKS_DIR, repoRoot: REPO_ROOT,
  executorPreset: 'agint', judgePreset: 'agint-zgs',
  ...over,
});

// ── gating ─────────────────────────────────────────────────────────────

test('abtest 未挂载 → skipped', async () => {
  const { runObserve } = await import(OBSERVE_PATH);
  const r = await runObserve(baseDeps({ abtest: null, population: fakePopulation([]) }));
  assert.equal(r.skipped, true);
});

test('无候选对 → skipped + publish reason', async () => {
  const { runObserve } = await import(OBSERVE_PATH);
  const { ab } = await realAbtest();
  const events = [];
  const r = await runObserve(baseDeps({
    abtest: ab, population: fakePopulation([]),
    publish: async (e) => { events.push(e); },
    executor: fakeExecutor({ calls: 0 }), judge: fakeJudge({ calls: 0 }),
  }));
  assert.equal(r.skipped, true);
  assert.match(r.reason, /candidate/);
  assert.ok(events.some((e) => e.topic === 'abtest.observe'));
});

test('候选对存在但无语料 → skipped（不硬开实验）', async () => {
  const { runObserve } = await import(OBSERVE_PATH);
  const { ab } = await realAbtest();
  const r = await runObserve(baseDeps({
    abtest: ab, population: fakePopulation([variant('no-such-skill', 'v1')]),
    executor: fakeExecutor({ calls: 0 }), judge: fakeJudge({ calls: 0 }),
  }));
  assert.equal(r.skipped, true);
  assert.match(r.reason, /corpus/);
  const { tests } = await ab.listTests();
  assert.equal(tests.length, 0);
});

// ── 全流水线 ───────────────────────────────────────────────────────────

test('全流水线：plugin-preflight 10 任务 ×2 变体 → 20 样本 + report 恰一次', async () => {
  const { runObserve } = await import(OBSERVE_PATH);
  const { ab, ctx } = await realAbtest();
  const state = { calls: 0, scriptCalls: 0 };
  const r = await runObserve(baseDeps({
    abtest: ab, population: fakePopulation([variant('plugin-preflight', 'v1')]),
    executor: fakeExecutor(state), judge: fakeJudge(state), scriptRunner: fakeScriptRunner(state),
  }));
  assert.ok(r.testId, `应开实验: ${JSON.stringify(r)}`);
  assert.equal(r.injected, 20, `注入 ${r.injected} ≠ 20（skipped=${JSON.stringify(r.skippedSamples)}）`);
  assert.equal(ctx._tables.samples.size, 20);
  const { tests } = await ab.listTests();
  assert.equal(tests.length, 1);
  assert.ok(['completed', 'inconclusive'].includes(tests[0].status), 'report 应已跑（终态）');
  assert.ok(state.calls <= 60, `LLM 调用 ${state.calls} 超预算`);
});

test('L1-exec 语料：scriptRunner 跑 10 次（5 任务 ×2），不耗 LLM 执行额度', async () => {
  const { runObserve } = await import(OBSERVE_PATH);
  const { ab } = await realAbtest();
  const state = { calls: 0, scriptCalls: 0 };
  const r = await runObserve(baseDeps({
    abtest: ab, population: fakePopulation([variant('plugin-check-sh', 'v1')]),
    executor: fakeExecutor(state), judge: fakeJudge(state), scriptRunner: fakeScriptRunner(state),
  }));
  assert.equal(r.injected, 20);
  assert.equal(state.scriptCalls, 10);
});

test('预算帽：llmBudget=3 → 提前封顶，仍 report 一次', async () => {
  const { runObserve } = await import(OBSERVE_PATH);
  const { ab, ctx } = await realAbtest();
  const state = { calls: 0, scriptCalls: 0 };
  const r = await runObserve(baseDeps({
    abtest: ab, population: fakePopulation([variant('plugin-preflight', 'v1')]),
    executor: fakeExecutor(state), judge: fakeJudge(state), llmBudget: 3,
  }));
  assert.ok(r.budgetCapped, '应标 budgetCapped');
  assert.ok(r.injected < 20);
  assert.ok(state.calls <= 3, `LLM 调用 ${state.calls} 超过帽 3`);
  const { tests } = await ab.listTests();
  assert.ok(['completed', 'inconclusive'].includes(tests[0].status));
});

test('执行器失败 → 样本 skipped，不伪造分数', async () => {
  const { runObserve } = await import(OBSERVE_PATH);
  const { ab } = await realAbtest();
  const state = { calls: 0, scriptCalls: 0 };
  const r = await runObserve(baseDeps({
    abtest: ab, population: fakePopulation([variant('plugin-preflight', 'v1')]),
    executor: async () => { state.calls++; return { ok: false, reason: 'spawn failed', attempted: true }; },
    judge: fakeJudge(state),
  }));
  assert.ok(r.skippedSamples.length > 0);
  assert.ok(r.injected < 20);
});

// ── 生命周期 ───────────────────────────────────────────────────────────

test('续跑：已有 running 实验 → 不新开，补齐样本后 report', async () => {
  const { runObserve } = await import(OBSERVE_PATH);
  const { ab, ctx } = await realAbtest();
  const corpus = JSON.parse((await import('node:fs')).readFileSync(resolve(TASKS_DIR, 'plugin-preflight.json'), 'utf8'));
  const { testId } = await ab.start({
    variantA: { promptId: 'plugin-preflight', version: 'old@v1' },
    variantB: { promptId: 'plugin-preflight', version: 'v1' },
    taskSuite: corpus.tasks.map((t) => t.id),
  });
  await ab._internal.putSample({ testId, variant: 'A', taskId: 'pp-01', score: 0.8 });
  const state = { calls: 0, scriptCalls: 0 };
  const r = await runObserve(baseDeps({
    abtest: ab, population: fakePopulation([variant('plugin-preflight', 'v1')]),
    executor: fakeExecutor(state), judge: fakeJudge(state),
  }));
  assert.equal(r.testId, testId, '应续跑原实验');
  const { tests } = await ab.listTests();
  assert.equal(tests.length, 1, '不得新开实验');
  assert.equal(ctx._tables.samples.size, 20, '幂等补齐到 20');
});

test('24h 未齐 → abort，不新开', async () => {
  const { runObserve } = await import(OBSERVE_PATH);
  const { ab } = await realAbtest();
  const corpus = JSON.parse((await import('node:fs')).readFileSync(resolve(TASKS_DIR, 'plugin-preflight.json'), 'utf8'));
  const { testId } = await ab.start({
    variantA: { promptId: 'plugin-preflight', version: 'old@v1' },
    variantB: { promptId: 'plugin-preflight', version: 'v1' },
    taskSuite: corpus.tasks.map((t) => t.id),
  });
  const state = { calls: 0, scriptCalls: 0 };
  const r = await runObserve(baseDeps({
    abtest: ab, population: fakePopulation([variant('plugin-preflight', 'v1')]),
    executor: fakeExecutor(state), judge: fakeJudge(state),
    now: Date.now() + 25 * 3600 * 1000,
  }));
  assert.equal(r.aborted, testId);
  const { tests } = await ab.listTests();
  assert.equal(tests.length, 1);
  assert.equal(tests[0].status, 'aborted');
  assert.equal(state.calls, 0, 'abort  tick 不跑任务');
});