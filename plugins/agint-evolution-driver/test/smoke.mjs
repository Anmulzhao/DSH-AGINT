import test from 'node:test';
import assert from 'node:assert/strict';

import {
  apply,
  isDisabled,
  isCommitEnabled,
  resolveTargetSkill,
  anchorExists,
  pickCandidate,
} from '../lib/index.js';

// ── mock ctx ────────────────────────────────────────────────────────────

function makeCtx(services = {}) {
  const provided = {};
  const published = [];
  const ctx = {
    get: (k) => services[k] ?? null,
    provide: (k, v) => {
      provided[k] = v;
    },
    effect: () => () => {},
    on: () => () => {},
  };
  ctx.services = services;
  ctx.provided = provided;
  ctx.published = published;
  return ctx;
}

function busRecorder(ctx) {
  const out = [];
  ctx.services['agint.eventBus.publish'] = async (topic, payload) => {
    out.push({ topic, payload });
    return true;
  };
  return out;
}

function fakeEvolve(proposals = []) {
  return { listProposals: async () => proposals };
}

function fakeMutator({ validateOk = true } = {}) {
  const calls = { propose: [], validate: [], commit: [] };
  return {
    calls,
    propose: async (input) => {
      calls.propose.push(input);
      return { id: `mp_${calls.propose.length}`, ...input, kind: 'PROMPT_MUTATION' };
    },
    validate: async (input) => {
      calls.validate.push(input);
      return validateOk ? { ok: true, findings: [] } : { ok: false, findings: ['atomicity violated'] };
    },
    commit: async (input) => {
      calls.commit.push(input);
      return { ok: true };
    },
  };
}

function fakePopulation() {
  const calls = [];
  return {
    calls,
    ingest: async (input) => {
      calls.push(input);
      return { variant_id: `v_${calls.length}`, policy_decision: 'PENDING_REVIEW', stage: 'PENDING_REVIEW' };
    },
  };
}

const SKILL_TEXT = '# plugin-preflight\n\nStep 1: lint.\nStep 2: smoke.\nStep 3: safe-update.\n';
const GOOD_LLM = async () => ({
  ok: true,
  value: {
    applicable: true,
    targetSkill: 'plugin-preflight',
    oldText: 'Step 2: smoke.',
    newText: 'Step 2: smoke (must include a cross-platform fixture case).',
    rationale: 'adds fixture requirement',
  },
});

// ── 纯函数契约 ──────────────────────────────────────────────────────────

test('T1: kill-switch — 只有显式 off 才关；未设 / 乱值都算开', () => {
  assert.equal(isDisabled({}), false);
  assert.equal(isDisabled({ AGINT_EVOLUTION_DRIVER: 'off' }), true);
  assert.equal(isDisabled({ AGINT_EVOLUTION_DRIVER: ' OFF ' }), true);
  assert.equal(isDisabled({ AGINT_EVOLUTION_DRIVER: 'on' }), false);
  assert.equal(isDisabled({ AGINT_EVOLUTION_DRIVER: 'yes' }), false);
});

test('T2: commit 默认关 —— 改自己代码必须显式开', () => {
  assert.equal(isCommitEnabled({}), false);
  assert.equal(isCommitEnabled({ AGINT_EVOLUTION_DRIVER_COMMIT: 'on' }), true);
  assert.equal(isCommitEnabled({ AGINT_EVOLUTION_DRIVER_COMMIT: 'true' }), false);
});

test('T3: resolveTargetSkill — 长名优先 + 词边界（push 不应命中 github-push）', () => {
  const skills = ['plugin-preflight', 'github-push', 'memory-discipline'];
  assert.equal(resolveTargetSkill({ title: 'plugin-preflight 补跨平台 fixture' }, skills), 'plugin-preflight');
  assert.equal(resolveTargetSkill({ title: 'push 前先跑 lint' }, skills), null);
  assert.equal(resolveTargetSkill({ title: 'github-push 加确认' }, skills), 'github-push');
  assert.equal(resolveTargetSkill({ title: '随便聊聊' }, skills), null);
});

test('T4: anchorExists — 幻觉闸门（空串 / 改写的文本都判不存在）', () => {
  assert.equal(anchorExists(SKILL_TEXT, 'Step 2: smoke.'), true);
  assert.equal(anchorExists(SKILL_TEXT, 'Step 2: smoke'), true);
  assert.equal(anchorExists(SKILL_TEXT, 'Step 2: smoke (paraphrased).'), false);
  assert.equal(anchorExists(SKILL_TEXT, '   '), false);
  assert.equal(anchorExists(SKILL_TEXT, ''), false);
});

test('T5: pickCandidate — 取最老的未处理提案，已见过的跳过', () => {
  const ps = [
    { id: 'b', status: 'proposed', createdAt: '2026-09-20' },
    { id: 'a', status: 'proposed', createdAt: '2026-09-01' },
    { id: 'x', status: 'applied', createdAt: '2026-08-01' },
  ];
  assert.equal(pickCandidate(ps)?.id, 'a');
  assert.equal(pickCandidate(ps, new Set(['a']))?.id, 'b');
  assert.equal(pickCandidate(ps, new Set(['a', 'b'])), null);
});

// ── runOnce 行为 ────────────────────────────────────────────────────────

test('T6: kill-switch=off → 直接 skipped，不碰任何服务', async () => {
  const ctx = makeCtx({});
  apply(ctx);
  const out = await ctx.provided['agint.evolutionDriver'].runOnce({ env: { AGINT_EVOLUTION_DRIVER: 'off' } });
  assert.equal(out.skipped, true);
  assert.match(out.reason, /off/);
});

test('T7: agint.evolve / agint.mutator 缺失 → skipped + degraded 计数（不抛）', async () => {
  const ctx = makeCtx({});
  apply(ctx);
  const d = ctx.provided['agint.evolutionDriver'];
  const a = await d.runOnce({ env: {} });
  assert.equal(a.skipped, true);
  const ctx2 = makeCtx({ 'agint.evolve': fakeEvolve([]) });
  apply(ctx2);
  const b = await ctx2.provided['agint.evolutionDriver'].runOnce({ env: {} });
  assert.equal(b.skipped, true);
  assert.equal(ctx2.provided['agint.evolutionDriver'].status().degraded, 1);
});

test('T8: 全流程通 —— propose → validate → ingest → 发 proposed 事件', async () => {
  const ctx = makeCtx({
    'agint.evolve': fakeEvolve([{ id: 'c1', title: 'plugin-preflight 补 fixture', category: 'skill', status: 'proposed', createdAt: '2026-09-01', body: '' }]),
    'agint.mutator': fakeMutator(),
    'agint.population': fakePopulation(),
  });
  const events = busRecorder(ctx);
  apply(ctx);
  const d = ctx.provided['agint.evolutionDriver'];
  const out = await d.runOnce({
    env: {},
    inject: {
      skillNames: ['plugin-preflight', 'github-push'],
      fs: { readSkill: async () => SKILL_TEXT },
      llm: GOOD_LLM,
    },
  });
  assert.equal(out.skipped, false, JSON.stringify(out));
  assert.equal(out.skill, 'plugin-preflight');
  assert.equal(out.variantId, 'v_1');
  assert.equal(events.length, 1);
  assert.equal(events[0].topic, 'evolution.mutation.proposed');
  assert.equal(events[0].payload.commitEnabled, false); // 默认不 commit
  const st = d.status();
  assert.equal(st.proposed, 1);
  assert.equal(st.ingested, 1);
});

test('T9: 幻觉闸门 —— oldText 不在原文 ⇒ 绝不 propose（不写入编造的变异）', async () => {
  const mut = fakeMutator();
  const ctx = makeCtx({
    'agint.evolve': fakeEvolve([{ id: 'c1', title: 'plugin-preflight 改点东西', status: 'proposed', createdAt: '2026-09-01', body: '' }]),
    'agint.mutator': mut,
    'agint.population': fakePopulation(),
  });
  apply(ctx);
  const out = await ctx.provided['agint.evolutionDriver'].runOnce({
    env: {},
    inject: {
      skillNames: ['plugin-preflight'],
      fs: { readSkill: async () => SKILL_TEXT },
      llm: async () => ({ ok: true, value: { applicable: true, targetSkill: 'plugin-preflight', oldText: 'Step 9: 不存在的段落', newText: 'x', rationale: '' } }),
    },
  });
  assert.equal(out.skipped, true);
  assert.equal(mut.calls.propose.length, 0, '幻觉 oldText 不应进入 propose');
});

test('T10: validate 不通过 → 不 ingest，发 rejected 事件', async () => {
  const pop = fakePopulation();
  const ctx = makeCtx({
    'agint.evolve': fakeEvolve([{ id: 'c1', title: 'plugin-preflight 补 fixture', status: 'proposed', createdAt: '2026-09-01', body: '' }]),
    'agint.mutator': fakeMutator({ validateOk: false }),
    'agint.population': pop,
  });
  const events = busRecorder(ctx);
  apply(ctx);
  const out = await ctx.provided['agint.evolutionDriver'].runOnce({
    env: {},
    inject: { skillNames: ['plugin-preflight'], fs: { readSkill: async () => SKILL_TEXT }, llm: GOOD_LLM },
  });
  assert.equal(out.skipped, true);
  assert.equal(pop.calls.length, 0);
  assert.equal(events[0].topic, 'evolution.mutation.rejected');
});

test('T11: LLM 判定不适用 / LLM 不可用 → 跳过且不写任何东西', async () => {
  const mut = fakeMutator();
  const ctx = makeCtx({
    'agint.evolve': fakeEvolve([{ id: 'c1', title: 'plugin-preflight 太虚了', status: 'proposed', createdAt: '2026-09-01', body: '' }]),
    'agint.mutator': mut,
    'agint.population': fakePopulation(),
  });
  apply(ctx);
  const base = { env: {}, inject: { skillNames: ['plugin-preflight'], fs: { readSkill: async () => SKILL_TEXT } } };
  const a = await ctx.provided['agint.evolutionDriver'].runOnce({ ...base, inject: { ...base.inject, llm: async () => ({ ok: true, value: { applicable: false, rationale: '需要新建文件' } }) } });
  const b = await ctx.provided['agint.evolutionDriver'].runOnce({ ...base, inject: { ...base.inject, llm: async () => ({ ok: false, reason: 'agents unavailable' }) } });
  assert.equal(a.skipped, true);
  assert.equal(b.skipped, true);
  assert.equal(mut.calls.propose.length, 0);
});

test('T12: 定位不到目标技能 → 换候选，不硬凑（无候选则 skipped）', async () => {
  const mut = fakeMutator();
  const ctx = makeCtx({
    'agint.evolve': fakeEvolve([{ id: 'c1', title: '重构存储层', status: 'proposed', createdAt: '2026-09-01', body: '跟任何技能都无关' }]),
    'agint.mutator': mut,
    'agint.population': fakePopulation(),
  });
  apply(ctx);
  const out = await ctx.provided['agint.evolutionDriver'].runOnce({
    env: {},
    inject: { skillNames: ['plugin-preflight'], fs: { readSkill: async () => SKILL_TEXT }, llm: GOOD_LLM },
  });
  assert.equal(out.skipped, true);
  assert.equal(mut.calls.propose.length, 0);
});

test('T13: status() 反映计数与开关，seen 去重（同一候选不重复处理）', async () => {
  const ctx = makeCtx({
    'agint.evolve': fakeEvolve([{ id: 'c1', title: 'plugin-preflight 补 fixture', status: 'proposed', createdAt: '2026-09-01', body: '' }]),
    'agint.mutator': fakeMutator(),
    'agint.population': fakePopulation(),
  });
  apply(ctx);
  const d = ctx.provided['agint.evolutionDriver'];
  const inj = { skillNames: ['plugin-preflight'], fs: { readSkill: async () => SKILL_TEXT }, llm: GOOD_LLM };
  await d.runOnce({ env: {}, inject: inj });
  const second = await d.runOnce({ env: {}, inject: inj });
  assert.equal(second.skipped, true, '同一候选不应被处理两次');
  const st = d.status();
  assert.equal(st.runs, 2);
  assert.equal(st.proposed, 1);
  assert.equal(st.killSwitch, 'on');
  assert.equal(st.commitEnabled, false);
});

test('T14: 事件总线不可用时主流程照走（观测失败不影响变异）', async () => {
  const ctx = makeCtx({
    'agint.evolve': fakeEvolve([{ id: 'c1', title: 'plugin-preflight 补 fixture', status: 'proposed', createdAt: '2026-09-01', body: '' }]),
    'agint.mutator': fakeMutator(),
    'agint.population': fakePopulation(),
    // 故意不注入 agint.eventBus.publish
  });
  apply(ctx);
  const out = await ctx.provided['agint.evolutionDriver'].runOnce({
    env: {},
    inject: { skillNames: ['plugin-preflight'], fs: { readSkill: async () => SKILL_TEXT }, llm: GOOD_LLM },
  });
  assert.equal(out.skipped, false);
  assert.equal(out.proposalId, 'mp_1');
});

console.log('\nagint-evolution-driver smoke: 全部用例通过（T1–T14）');
