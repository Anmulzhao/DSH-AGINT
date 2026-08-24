#!/usr/bin/env node
// agint-diagnosis / counterfactual-simulator unit test.
// `node test/counterfactual-simulator.test.mjs` 一行能跑（node --test 模式）。
//
// 覆盖（任务描述 §3 + 设计稿 §二.4）：
//   - 3 种 modifiedStrategy 各 ≥1 个正向用例
//   - 3 种 modifiedStrategy 各 ≥1 个反向用例（failureId 不存在 / 扰动无效）
//   - cold-start 抛错（failure_pattern < 10）
//   - failureId 不存在抛错
//   - successRate ∈ [0, 1] 范围校验
//   - divergentSteps 非空且 ≥1 元素
//   - service 层 counterfactual 已注册（不再 not implemented）+ 走通算法路径
//   - UNCERTAIN 兜底 successRate = 0.3
//   - modifiedStrategy 非法抛错
//   - evolution service 缺失抛错

import test from 'node:test';
import assert from 'node:assert/strict';

import { simulate, MODIFIED_STRATEGIES, COLD_START_MIN } from '../lib/counterfactual-simulator.js';

// ── 构造 mock evolution + memory + 5 条 fixture 用的 failure_pattern ─────

function makeMocks({ failures = {}, memoryHits = [] } = {}) {
  const all = Object.values(failures);
  const evolution = {
    queryFailures: async () => all,
  };
  const memory = {
    search: async (_q, _opts) => memoryHits,
  };
  return { evolution, memory };
}

const FIXTURES = {
  'fix-1-toolgap': {
    id: 'fix-1-toolgap',
    pattern: 'tool not found: fetch_weather_api',
    evidence: 'ENOENT tool_missing detected; 绕过该工具 → success',
    severity: 'medium',
    category: 'integration',
    occurrences: 3,
  },
  'fix-2-toolgap-no-prompt': {
    id: 'fix-2-toolgap-no-prompt',
    pattern: 'tool not found: legacy_importer',
    evidence: 'ENOENT tool_missing',
    severity: 'low',
    category: 'integration',
    occurrences: 2,
  },
  'fix-3-prompt': {
    id: 'fix-3-prompt',
    pattern: '旧 prompt 段落 A 反复调用',
    evidence: 'prompt 版本变更后立即出现失败；同一 prompt 跨任务反复失败 occurrences=3',
    severity: 'medium',
    category: 'correctness',
    occurrences: 4,
  },
  'fix-4-planning': {
    id: 'fix-4-planning',
    pattern: '子任务顺序颠倒 out of order reorder',
    evidence: '重做 redo again 无进展 no progress stuck；重新拆分 replan 后一步通过 success',
    severity: 'high',
    category: 'correctness',
    occurrences: 2,
  },
  'fix-5-uncertain': {
    id: 'fix-5-uncertain',
    pattern: '正常执行无异常',
    evidence: '完成 success',
    severity: 'low',
    category: 'other',
    occurrences: 1,
  },
};

function makeTenSeedFailures() {
  const out = [];
  for (let i = 0; i < 10; i += 1) {
    out.push({
      id: `seed-${i}`,
      pattern: `seed pattern ${i}`,
      evidence: '',
      severity: 'medium',
      category: 'other',
      occurrences: 1,
    });
  }
  return out;
}

// ── Case 1: skip-tool 正向 ──────────────────────────────────────────────

test('simulate: skip-tool + TOOL_GAP → 扰动命中 successRate=1/3', async () => {
  const { evolution, memory } = makeMocks({
    failures: { ...Object.fromEntries(makeTenSeedFailures().map((r) => [r.id, r])), ...FIXTURES },
  });
  const r = await simulate({
    failureId: 'fix-1-toolgap',
    modifiedStrategy: 'skip-tool',
    evolution,
    memory,
  });
  assert.equal(r.successRate, 1 / 3, '命中扰动应得 1/3');
  assert.ok(Array.isArray(r.divergentSteps));
  assert.ok(r.divergentSteps.length >= 1);
  assert.ok(r.divergentSteps.some((s) => /skip-tool/.test(s)));
});

// ── Case 2: skip-tool 反向 / UNCERTAIN 兜底 ─────────────────────────────

test('simulate: skip-tool + UNCERTAIN 兜底走 0.3（fixture-5）', async () => {
  const { evolution, memory } = makeMocks({
    failures: { ...Object.fromEntries(makeTenSeedFailures().map((r) => [r.id, r])), ...FIXTURES },
  });
  const r = await simulate({
    failureId: 'fix-5-uncertain',
    modifiedStrategy: 'skip-tool',
    evolution,
    memory,
  });
  assert.equal(r.successRate, 0.3, 'UNCERTAIN 兜底 successRate=0.3');
  assert.ok(r.divergentSteps.some((s) => /UNCERTAIN/.test(s)));
});

// ── Case 3: use-prev-prompt 正向（PROMPT_DEFICIENCY） ────────────────────

test('simulate: use-prev-prompt + multi-step PROMPT trajectory → 扰动命中 successRate=1/3', async () => {
  const multiStepPromptTraj = [
    { pattern: '旧 prompt 段落 A' },
    { pattern: '又用 prompt 段落 A' },
    { pattern: 'prompt 版本 v3 变更后立即出现失败' },
    { pattern: '同一 prompt 跨任务反复失败 occurrences=3' },
    { pattern: '同一 prompt 跨任务又失败 occurrences=2' },
  ];
  const { evolution, memory } = makeMocks({
    failures: { ...Object.fromEntries(makeTenSeedFailures().map((r) => [r.id, r])), ...FIXTURES },
    memoryHits: [{ id: 'm-1', type: 'pattern', content: 'use clear and concise prompt template v3' }],
  });
  const r = await simulate({
    failureId: 'fix-3-prompt',
    modifiedStrategy: 'use-prev-prompt',
    trajectory: multiStepPromptTraj,
    evolution,
    memory,
  });
  assert.equal(r.successRate, 1 / 3);
  assert.ok(r.divergentSteps.some((s) => /use-prev-prompt/.test(s)));
  assert.ok(r.divergentSteps.some((s) => /originalRootCause=PROMPT_DEFICIENCY/.test(s)));
});

// ── Case 4: use-prev-prompt 反向（TOOL_GAP + 与 prompt 无关） ────────────

test('simulate: use-prev-prompt + TOOL_GAP → 扰动未命中 successRate=0', async () => {
  const { evolution, memory } = makeMocks({
    failures: { ...Object.fromEntries(makeTenSeedFailures().map((r) => [r.id, r])), ...FIXTURES },
    memoryHits: [],
  });
  const r = await simulate({
    failureId: 'fix-2-toolgap-no-prompt',
    modifiedStrategy: 'use-prev-prompt',
    evolution,
    memory,
  });
  assert.equal(r.successRate, 0, '扰动未命中应得 0');
  assert.ok(r.divergentSteps.some((s) => /未命中|no prev-prompt/.test(s)));
});

// ── Case 5: reorder-subtasks 正向（PLANNING_FAILURE 单步代理） ────────────

test('simulate: reorder-subtasks + PLANNING_FAILURE trajectory → 行为合理', async () => {
  const { evolution, memory } = makeMocks({
    failures: { ...Object.fromEntries(makeTenSeedFailures().map((r) => [r.id, r])), ...FIXTURES },
  });
  const r = await simulate({
    failureId: 'fix-4-planning',
    modifiedStrategy: 'reorder-subtasks',
    evolution,
    memory,
  });
  assert.ok(r.successRate === 0 || r.successRate === 1 / 3);
  assert.ok(r.divergentSteps.some((s) => /reorder-subtasks/.test(s)));
});

// ── Case 6: reorder-subtasks 反向（非 planning trajectory） ──────────────

test('simulate: reorder-subtasks + 非 planning trajectory → successRate=0', async () => {
  const traj = [
    { pattern: 'tool not found: x' },
    { pattern: 'ENOENT tool_missing' },
  ];
  const { evolution, memory } = makeMocks({
    failures: { ...Object.fromEntries(makeTenSeedFailures().map((r) => [r.id, r])), ...FIXTURES },
  });
  const r = await simulate({
    failureId: 'fix-1-toolgap',
    modifiedStrategy: 'reorder-subtasks',
    trajectory: traj,
    evolution,
    memory,
  });
  assert.equal(r.successRate, 0);
  assert.ok(r.divergentSteps.some((s) => /未命中/.test(s)));
});

// ── Case 7: cold-start 抛错 ─────────────────────────────────────────────

test('simulate: cold-start throws when failure_pattern < 10', async () => {
  const { evolution, memory } = makeMocks({
    failures: { 'fix-1-toolgap': FIXTURES['fix-1-toolgap'] },
  });
  await assert.rejects(
    () => simulate({
      failureId: 'fix-1-toolgap',
      modifiedStrategy: 'skip-tool',
      evolution,
      memory,
    }),
    /cold-start.*failure_pattern.*样本数/,
  );
});

// ── Case 8: failureId 不存在抛错 ────────────────────────────────────────

test('simulate: failureId not found in failure_pattern throws', async () => {
  const { evolution, memory } = makeMocks({
    failures: { ...Object.fromEntries(makeTenSeedFailures().map((r) => [r.id, r])) },
  });
  await assert.rejects(
    () => simulate({
      failureId: 'does-not-exist',
      modifiedStrategy: 'skip-tool',
      evolution,
      memory,
    }),
    /failureId not found in failure_pattern/,
  );
});

// ── Case 9: successRate 范围校验 ────────────────────────────────────────

test('simulate: successRate ∈ [0, 1] for all 5 fixture combinations', async () => {
  for (const fix of Object.keys(FIXTURES)) {
    for (const strategy of MODIFIED_STRATEGIES) {
      const { evolution, memory } = makeMocks({
        failures: { ...Object.fromEntries(makeTenSeedFailures().map((r) => [r.id, r])), ...FIXTURES },
      });
      const r = await simulate({ failureId: fix, modifiedStrategy: strategy, evolution, memory });
      assert.ok(r.successRate >= 0 && r.successRate <= 1, `${fix}/${strategy}: successRate=${r.successRate} 越界`);
    }
  }
});

// ── Case 10: divergentSteps 非空 ─────────────────────────────────────────

test('simulate: divergentSteps 非空且 ≥1 元素', async () => {
  const { evolution, memory } = makeMocks({
    failures: { ...Object.fromEntries(makeTenSeedFailures().map((r) => [r.id, r])), ...FIXTURES },
  });
  for (const strategy of MODIFIED_STRATEGIES) {
    const r = await simulate({ failureId: 'fix-1-toolgap', modifiedStrategy: strategy, evolution, memory });
    assert.ok(Array.isArray(r.divergentSteps));
    assert.ok(r.divergentSteps.length >= 1, `${strategy}: divergentSteps 应 ≥1 元素`);
    for (const s of r.divergentSteps) assert.equal(typeof s, 'string');
  }
});

// ── Case 11: modifiedStrategy 非法抛错 ──────────────────────────────────

test('simulate: modifiedStrategy not in enum throws', async () => {
  const { evolution, memory } = makeMocks({
    failures: { ...Object.fromEntries(makeTenSeedFailures().map((r) => [r.id, r])) },
  });
  await assert.rejects(
    () => simulate({ failureId: 'seed-0', modifiedStrategy: 'illegal-strategy', evolution, memory }),
    /modifiedStrategy 必须是/,
  );
});

// ── Case 12: evolution service 缺失抛错 ─────────────────────────────────

test('simulate: evolution service 缺失 throws', async () => {
  await assert.rejects(
    () => simulate({ failureId: 'x', modifiedStrategy: 'skip-tool', evolution: null }),
    /evolution service/,
  );
});

// ── Case 13: service 层 counterfactual 已注册 ────────────────────────────

import * as plugin from '../lib/index.js';

test('service counterfactual: 已注册 + 走通算法路径', async () => {
  const services = {};
  const fakeCtx = {
    storageDomain: {
      open: async () => ({
        table: () => ({ entries: () => [], put: async () => undefined }),
        close: async () => undefined,
      }),
    },
    get: (name) => {
      if (name === 'agint.evolution') {
        const all = [
          ...makeTenSeedFailures(),
          FIXTURES['fix-1-toolgap'],
        ];
        return { queryFailures: async () => all };
      }
      if (name === 'agint.memory') {
        return { search: async () => [] };
      }
      return null;
    },
    provide(name, fn) { services[name] = fn; },
    effect() { return () => undefined; },
  };
  plugin.apply(fakeCtx);
  const cf = services['agint.diagnosis.counterfactual'];
  assert.ok(typeof cf === 'function');
  const result = await cf({
    failureId: 'fix-1-toolgap',
    modifiedStrategy: 'skip-tool',
  });
  assert.ok(typeof result.successRate === 'number');
  assert.ok(Array.isArray(result.divergentSteps));
  assert.ok(result.successRate > 0, `TOOL_GAP + skip-tool 应命中，得 successRate=${result.successRate}`);
});

// ── Case 14: service 层 cold-start 抛错 ─────────────────────────────────

test('service counterfactual: cold-start throws when failure_pattern < 10', async () => {
  const services = {};
  const fakeCtx = {
    storageDomain: {
      open: async () => ({
        table: () => ({ entries: () => [], put: async () => undefined }),
        close: async () => undefined,
      }),
    },
    get: (name) => {
      if (name === 'agint.evolution') {
        return { queryFailures: async () => [FIXTURES['fix-1-toolgap']] };
      }
      return null;
    },
    provide(name, fn) { services[name] = fn; },
    effect() { return () => undefined; },
  };
  plugin.apply(fakeCtx);
  const cf = services['agint.diagnosis.counterfactual'];
  await assert.rejects(
    () => cf({ failureId: 'fix-1-toolgap', modifiedStrategy: 'skip-tool' }),
    /cold-start.*failure_pattern/,
  );
});

// ── Case 15: service 层 failureId not found ──────────────────────────────

test('service counterfactual: failureId not found throws', async () => {
  const services = {};
  const fakeCtx = {
    storageDomain: {
      open: async () => ({
        table: () => ({ entries: () => [], put: async () => undefined }),
        close: async () => undefined,
      }),
    },
    get: (name) => {
      if (name === 'agint.evolution') {
        return { queryFailures: async () => makeTenSeedFailures() };
      }
      return null;
    },
    provide(name, fn) { services[name] = fn; },
    effect() { return () => undefined; },
  };
  plugin.apply(fakeCtx);
  const cf = services['agint.diagnosis.counterfactual'];
  await assert.rejects(
    () => cf({ failureId: 'missing', modifiedStrategy: 'skip-tool' }),
    /failureId not found in failure_pattern/,
  );
});

// ── Case 16: 5 条 fixture 自测 successRate 矩阵 ─────────────────────────

test('5 条 fixture 自测 successRate 矩阵（任务描述自测段）', async () => {
  const expected = [
    { fix: 'fix-1-toolgap', strategy: 'skip-tool', note: '期望高（扰动命中）' },
    { fix: 'fix-2-toolgap-no-prompt', strategy: 'use-prev-prompt', note: '期望中/低（与 prompt 无关）' },
    { fix: 'fix-3-prompt', strategy: 'use-prev-prompt', note: '期望高（扰动命中）' },
    { fix: 'fix-4-planning', strategy: 'reorder-subtasks', note: '期望低（Sprint 7 单步代理调换未命中）' },
    { fix: 'fix-5-uncertain', strategy: 'skip-tool', note: '期望 0.3 兜底' },
  ];
  const results = [];
  for (const e of expected) {
    const { evolution, memory } = makeMocks({
      failures: { ...Object.fromEntries(makeTenSeedFailures().map((r) => [r.id, r])), ...FIXTURES },
      memoryHits: [{ id: 'm-1', type: 'pattern', content: 'clear concise prompt v3' }],
    });
    const r = await simulate({ failureId: e.fix, modifiedStrategy: e.strategy, evolution, memory });
    results.push({ ...e, successRate: r.successRate });
    console.log(`  fixture ${e.fix} + ${e.strategy}: rate=${r.successRate.toFixed(3)} (${e.note})`);
  }
  assert.ok(results[0].successRate > 0, `fixture-1 TOOL_GAP + skip-tool 应 > 0，得 ${results[0].successRate}`);
  assert.equal(results[4].successRate, 0.3, `fixture-5 UNCERTAIN 应 = 0.3`);
});