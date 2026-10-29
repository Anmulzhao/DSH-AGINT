import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute, resolve as pathResolve } from 'node:path';

import {
  apply,
  isDisabled,
  isCommitEnabled,
  resolveTargetSkill,
  resolveTargetAsset,
  extractRepoPaths,
  normalizeRepoPath,
  matchRepoFile,
  resolveRepoRoot,
  resolveLlmTimeout,
  resolveTargetAssets,
  commitToRepo,
  restoreFromPreimage,
  verifyTargetFile,
  recordFailure,
  anchorExists,
  slugifyPromptId,
  findFabricatedEntities,
  pickCandidate,
  spawnLlm,
  DEFAULT_AGENT_PRESET,
  classifyFailureKind,
} from '../lib/index.js';

// 1a 归档复原断言用（T25f）：hash 纯函数 + 锁定用的 hypothesis 形状
import { computeHypothesisLock } from '../lib/predictor.js';
import { buildLockHypothesis } from '../lib/prediction-locker.js';
import { EXPECTED_EFFECT_CODE, EXPECTED_EFFECT_SKILL } from '../lib/expected-effect.js';
import { buildExcerpt, extractAnchors } from '../lib/excerpt.js';
import { analyzeProposalScope } from '../lib/scope.js';

/**
 * 建一个真实的临时仓库根（v0.2.8）。
 *
 * 之前 T25/T25c 用 `inj.fs` 虚拟文件系统，commitToRepo 走注入分支不碰磁盘；
 * 但 v0.2.8 的 `verifyTargetFile` 要按扩展名真的去跑 `bash -n` / `node --check`，
 * 虚拟 fs 满足不了（'/fake/repo' 在磁盘上不存在 ⇒ statSync 直接失败）。
 * 改用真实 tmpdir 后，语法检查、preimage 备份、回滚全都是真跑真验。
 */
async function makeRepo(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agint-driver-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return root;
}

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
  // ⛔ 契约：`agint.eventBus.publish` 是**单参数** (input) => publish(busCtx, input)，
  // input = { topic, source, payload }。2026-09-27 三参数调用被静默丢弃过一轮，
  // 这里按真实签名实现：传错形态 input.topic 会是 undefined，用例立刻变红。
  ctx.services['agint.eventBus.publish'] = async (input) => {
    const accepted = typeof input?.topic === 'string' && typeof input?.source === 'string';
    const envelopeId = `env-${out.length + 1}`;
    out.push({ topic: input?.topic, source: input?.source, payload: input?.payload, envelopeId });
    // ⛔ 真实 bus 的返回形状（agint-event-bus/lib/bus.js:164-169）：accepted:true 时带
    // envelopeId。driver 用它填 Ledger 的 references.eventBusIds —— mock 不给就是假契约，
    // 「链上引用接不上真实事件」这类错永远测不出来。
    return accepted
      ? { accepted: true, envelopeId, deliveredTo: [], deadLettered: [] }
      : { accepted: false };
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
      // 形状取自生产副本 agint_population.json 的 variants 行（2026-10-03 实测 7 行）。
      // ⛔ 别退回 { variant_id, policy_decision, stage } 三字段：Ledger 入链要读
      // generation（→ GEN-###）与 expected_effect.metric（→ targetMetric），
      // mock 少给字段就等于把「实时条目写不进去」这条真故障测不出来。
      return {
        variant_id: `v_${calls.length}`,
        mutation_kind: 'PROMPT_MUTATION',
        generation: 0,
        expected_effect: { metric: 'unspecified', direction: 'increase', window: '7d' },
        policy_decision: 'PENDING_REVIEW',
        stage: 'PENDING_REVIEW',
      };
    },
  };
}

/**
 * agint.evolution 的契约复刻：真实 provide 里 Ledger 是一个命名空间
 * （plugins/agint-evolution-memory/lib/index.js:557 `ledger: { append, ... }`），
 * append 的返回是 `{ entry, idempotent }`（lib/ledger.js:262）。
 * 这里按同一形状给，并把入链条目留在 `ledger.entries` 供断言。
 */
function fakeEvolutionLog({ calls = [], ledgerThrows = null } = {}) {
  const appended = [];
  return {
    appended,
    addFailure: async (f) => { calls.push(['addFailure', f.pattern]); return { id: 'f1' }; },
    ledger: {
      append: async (entry) => {
        if (ledgerThrows) throw new Error(ledgerThrows);
        // 幂等键复刻：同 contractId 已有条目 ⇒ 返回既有那条、不新增（§4.3.4 纪律 5）
        const hit = appended.find((e) => e.contractId === entry.contractId);
        if (hit) return { entry: hit, idempotent: true };
        const stored = { ...entry, seq: appended.length + 1 };
        appended.push(stored);
        return { entry: stored, idempotent: false };
      },
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

test('T2: commit 默认开（2026-09-27 老板拍板开放改仓库代码）—— 显式 off 才关', () => {
  assert.equal(isCommitEnabled({}), true);
  assert.equal(isCommitEnabled({ AGINT_EVOLUTION_DRIVER_COMMIT: 'on' }), true);
  assert.equal(isCommitEnabled({ AGINT_EVOLUTION_DRIVER_COMMIT: 'OFF' }), false);
  assert.equal(isCommitEnabled({ AGINT_EVOLUTION_DRIVER_COMMIT: 'true' }), true);
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
  assert.equal(events[0].payload.commitEnabled, true); // 2026-09-27 起默认 commit（老板拍板）；本用例无 repoRoot ⇒ 不落盘只发事件
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

test('T11: LLM 判定不适用 → 跳过；LLM 不可用 → 中止并抛错（无降级）', async () => {
  const mut = fakeMutator();
  const ctx = makeCtx({
    'agint.evolve': fakeEvolve([{ id: 'c1', title: 'plugin-preflight 太虚了', status: 'proposed', createdAt: '2026-09-01', body: '' }]),
    'agint.mutator': mut,
    'agint.population': fakePopulation(),
  });
  apply(ctx);
  const base = { env: {}, inject: { skillNames: ['plugin-preflight'], fs: { readSkill: async () => SKILL_TEXT } } };
  const a = await ctx.provided['agint.evolutionDriver'].runOnce({ ...base, inject: { ...base.inject, llm: async () => ({ ok: true, value: { applicable: false, rationale: '需要新建文件' } }) } });
  assert.equal(a.skipped, true);

  // 失败用新 ctx：同一 ctx 的 state.seen 已吃掉 c1，第二轮会直接跳过而不调 LLM
  const mut2 = fakeMutator();
  const ctx2 = makeCtx({
    'agint.evolve': fakeEvolve([{ id: 'c1', title: 'plugin-preflight 太虚了', status: 'proposed', createdAt: '2026-09-01', body: '' }]),
    'agint.mutator': mut2,
    'agint.population': fakePopulation(),
  });
  apply(ctx2);
  await assert.rejects(
    ctx2.provided['agint.evolutionDriver'].runOnce({ ...base, inject: { ...base.inject, llm: async () => ({ ok: false, reason: 'agents service missing' }) } }),
    /llm unavailable: agents service missing/,
  );
  assert.equal(mut.calls.propose.length, 0, 'LLM 失败不得写任何变异');
  assert.equal(mut2.calls.propose.length, 0);
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
  assert.equal(st.commitEnabled, true);
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

test('T15: 零产出必发 evolution.cycle.summary 且带失败清单（唯一外部可读出口）', async () => {
  // 2026-09-27 教训：warn→stdout 常驻进程读不到、cron 持久化只写死 "ok"，
  // 结果「跑了 4 个子代理但零产出」在生产上完全无法归因。这条用例锁住出口。
  const ctx = makeCtx({
    'agint.evolve': fakeEvolve([{ id: 'c1', title: '无关提案', status: 'proposed', createdAt: '2026-09-01', body: '' }]),
    'agint.mutator': fakeMutator(),
    'agint.population': fakePopulation(),
  });
  const rec = busRecorder(ctx);
  apply(ctx);
  const out = await ctx.provided['agint.evolutionDriver'].runOnce({
    env: {},
    inject: { skillNames: [], fs: { readSkill: async () => SKILL_TEXT } }, // 无可用技能 ⇒ 定位失败
  });
  assert.equal(out.skipped, true);
  const s = rec.filter((e) => e.topic === 'evolution.cycle.summary');
  assert.equal(s.length, 1, '零产出也必须发 summary');
  assert.ok(s[0].payload.failuresTotal >= 1, 'summary 必须带失败清单');
  assert.ok(String(s[0].payload.failures[0]).includes('c1'), '失败清单要能定位到具体候选');
  assert.equal(s[0].payload.poolSize, 1);
});

test('T16: publish 必须按单参数契约调用（三参数会被 bus 静默丢弃）', async () => {
  // 2026-09-27 真实故障：`bus(topic, payload, {source})` 三参数 → bus.js 内部
  // `'id' in input` 对字符串抛 TypeError → catch 成 accepted:false 静默丢弃
  // ⇒ 两轮触发零 evolution.* 事件。这条用例把契约钉死。
  const ctx = makeCtx({
    'agint.evolve': fakeEvolve([{ id: 'c1', title: 'plugin-preflight 补 fixture', status: 'proposed', createdAt: '2026-09-01', body: '' }]),
    'agint.mutator': fakeMutator(),
    'agint.population': fakePopulation(),
  });
  const raw = [];
  ctx.services['agint.eventBus.publish'] = async (...args) => {
    raw.push(args);
    return { accepted: true };
  };
  apply(ctx);
  await ctx.provided['agint.evolutionDriver'].runOnce({
    env: {},
    inject: { skillNames: ['plugin-preflight'], fs: { readSkill: async () => SKILL_TEXT }, llm: GOOD_LLM },
  });
  assert.ok(raw.length >= 1, '至少发过一次事件');
  for (const args of raw) {
    assert.equal(args.length, 1, `publish 必须是单参数调用，实际 ${args.length} 个`);
    assert.equal(typeof args[0], 'object', 'publish 首参必须是 envelope 对象');
    assert.equal(typeof args[0].topic, 'string', 'input.topic 必填');
    assert.equal(args[0].source, 'agint-evolution-driver', 'input.source 必填（插件名）');
  }
});

// ── T17/T18：子代理 spawn 契约（2026-09-27 用 30 个空壳会话换来的两条硬约束）──

/** 假 agents/subagents：默认走新宿主 startActivation；legacy=true 只提供旧 start。 */
function fakeRuntime({ result = { stopReason: 'completed', structured: { applicable: false } }, legacy = false } = {}) {
  const created = [];
  const started = [];
  const agents = {
    create: async (options) => {
      created.push(options);
      return { agent: { id: 'fake-parent' }, dispose: async () => {} };
    },
  };
  const subagents = {
    getProvider: (name) => (name === 'spawn' ? { name } : undefined),
    ...(legacy
      ? {
        start: async (name, request) => {
          started.push({ name, request });
          return { result: Promise.resolve(result), dispose: async () => {} };
        },
      }
      : {
        startActivation: async (spec) => {
          started.push(spec);
          return { childId: 'fake-child', result: Promise.resolve(result), dispose: async () => {} };
        },
      }),
  };
  return { agents, subagents, created, started };
}

test('T17: agents.create 必须带 meta.agentPreset；startActivation request 也必须带 preset', async () => {
  const rt = fakeRuntime();
  const ctx = makeCtx({ agents: rt.agents, subagents: rt.subagents });
  await spawnLlm(ctx, { system: 's', user: 'u', schema: { type: 'object' } });

  assert.equal(rt.created.length, 1, '应创建一次 parent');
  const meta = rt.created[0].meta;
  assert.ok(meta, 'meta 必传');
  assert.equal(
    meta.agentPreset,
    DEFAULT_AGENT_PRESET,
    'meta.agentPreset 缺失 ⇒ child 的 agentPreset=null ⇒ modelSelection=null ⇒ 会话建得出但跑不动（30 个空壳的血债）',
  );
  // 新宿主契约：provider / label / delivery / request 四件套
  const spec = rt.started[0];
  assert.equal(spec.provider, 'spawn');
  assert.equal(spec.delivery, 'caller');
  assert.equal(spec.request.parent.id, 'fake-parent');
  assert.equal(spec.request.agentPreset, DEFAULT_AGENT_PRESET, 'request.agentPreset 是新契约的必填项');
  assert.deepEqual(spec.request.agentOptions, rt.created[0].agentOptions);
  assert.ok(spec.request.outputSchema, 'outputSchema 必须进 request');
});

test('T17b: 旧宿主只有 start() 时走兼容分支', async () => {
  const rt = fakeRuntime({ legacy: true });
  const ctx = makeCtx({ agents: rt.agents, subagents: rt.subagents });
  const out = await spawnLlm(ctx, { system: 's', user: 'u', schema: { type: 'object' } });
  assert.equal(out.ok, true);
  assert.equal(rt.started[0].name, 'spawn');
  assert.equal(rt.started[0].request.label, 'agint-evolution-driver mutation');
  assert.equal(rt.started[0].request.parent.id, 'fake-parent');
});

test('T18: 结果读 structured，不是 output —— 缺 structured 必须报出来而不是静默', async () => {
  // ① 有 structured ⇒ ok
  const ok = fakeRuntime({ result: { stopReason: 'completed', structured: { applicable: true } } });
  const ctxOk = makeCtx({ agents: ok.agents, subagents: ok.subagents });
  const r1 = await spawnLlm(ctxOk, { system: 's', user: 'u', schema: { type: 'object' } });
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.value, { applicable: true }, 'value 必须来自 result.structured');

  // ② 只有 output、没有 structured ⇒ 必须失败且说明原因（不能静默当"不适用"）
  const bad = fakeRuntime({ result: { stopReason: 'completed', output: [{ type: 'text', text: 'x' }] } });
  const ctxBad = makeCtx({ agents: bad.agents, subagents: bad.subagents });
  const r2 = await spawnLlm(ctxBad, { system: 's', user: 'u', schema: { type: 'object' } });
  assert.equal(r2.ok, false, '只有 output 没有 structured 必须判失败');
  assert.match(r2.reason, /structured output missing/);
});

// ── T19：agentOptions 是模型路由载体（第二个空壳根因，2026-09-27 二次取证）──
// 对照实证：dream child 跑通（modelSelection=minimax-cn/MiniMax-M3、outTok=409），
// driver child 空壳（modelSelection=null、surfaceTokens=0、outTok=0），两边 parent
// 字段完全一致 —— 唯一差异就是 dream 多传了 agentOptions:{provider, model}。
// ⇒ preset 管 persona/工具，provider+model 才是路由本身，两者都不可省。

test('T19a: agentOptions 必须带 provider/model —— 只给 agentPreset 仍是空壳', async () => {
  const rt = fakeRuntime();
  const ctx = makeCtx({ agents: rt.agents, subagents: rt.subagents });
  await spawnLlm(ctx, { system: 's', user: 'u', schema: { type: 'object' } });
  const opts = rt.created[0].agentOptions;
  assert.ok(opts, 'agentOptions 必传（缺 ⇒ child modelSelection=null ⇒ 空壳）');
  assert.ok(opts.provider, 'provider 必传');
  assert.ok(opts.model, 'model 必传');
  assert.ok(opts.reasoningEffort, 'reasoningEffort 必传（MiniMax 缺档位会 400）');
});

test('T19b: provider/model 优先取自宿主服务 agentDefaultModel（不硬编码模型名）', async () => {
  const rt = fakeRuntime();
  const ctx = makeCtx({
    agents: rt.agents,
    subagents: rt.subagents,
    agentDefaultModel: { currentSelection: () => ({ provider: 'host-provider', model: 'Host-Model', reasoningEffort: 'xhigh' }) },
  });
  await spawnLlm(ctx, { system: 's', user: 'u', schema: { type: 'object' } });
  const opts = rt.created[0].agentOptions;
  assert.equal(opts.provider, 'host-provider', '应用宿主默认 provider');
  assert.equal(opts.model, 'Host-Model', '应用宿主默认 model');
  assert.equal(opts.reasoningEffort, 'xhigh', '应用宿主默认推理档');
});

test('T19c: 显式入参覆盖宿主默认；宿主服务缺失时兜底到常量（不静默空壳）', async () => {
  const rt = fakeRuntime();
  const ctx = makeCtx({ agents: rt.agents, subagents: rt.subagents }); // 无 agentDefaultModel
  await spawnLlm(ctx, { system: 's', user: 'u', schema: { type: 'object' } });
  const fallback = rt.created[0].agentOptions;
  assert.ok(fallback.provider && fallback.model, '宿主服务缺失时必须兜底到常量，不能省 agentOptions');

  const rt2 = fakeRuntime();
  const ctx2 = makeCtx({
    agents: rt2.agents,
    subagents: rt2.subagents,
    agentDefaultModel: { currentSelection: () => ({ provider: 'host-p', model: 'Host-M' }) },
  });
  await spawnLlm(ctx2, { system: 's', user: 'u', schema: { type: 'object' }, provider: 'x-p', model: 'X-M' });
  assert.equal(rt2.created[0].agentOptions.provider, 'x-p', '显式入参优先于宿主默认');
  assert.equal(rt2.created[0].agentOptions.model, 'X-M');
});

// ── T20: extractRepoPaths —— 从提案文本提取反引号路径 ──────────────────────
test('T20: extractRepoPaths 提取反引号仓库路径并去重', () => {
  const text =
    '修复 `plugins/agint-metrics/lib/service.js` 的同名 spec bug，见 `docs/x.md` 和 `plugins/agint-metrics/lib/service.js`';
  const paths = extractRepoPaths(text);
  assert.deepEqual(paths, ['plugins/agint-metrics/lib/service.js', 'docs/x.md']);
  assert.deepEqual(extractRepoPaths('没有路径'), []);
});

// ── T20b: 命令式反引号 —— 2026-10-29「假完成」的根因（提案 d2b77b47）─────────
// 旧口径要求「整段反引号里只有一个路径」，正文里 `` `grep -niE 'x' plugins/a/lib/b.js` ``
// 这种写法整段漏掉 ⇒ 少认一个目标 ⇒ unitsTotal=1 ⇒ 只改 1/N 也判 complete ⇒ 标 applied。
// 这里用那条提案的**原文**当夹具，断言的正是「两个目标都要被认出来，且顺序是正文顺序」。

const T20B_REPO = [
  'plugins/agint-dream/lib/sweep.js',
  'plugins/agint-dream/lib/tools.js',
];

const T20B_BODY = [
  '提案 2f91b72b（commit 0ac21ca）已在 `plugins/agint-dream/lib/sweep.js:383` 的 `collectSessionSignals` 里采集了统计量。',
  '| tools.js output schema | 未声明 | `grep -niE \'assistant\' plugins/agint-dream/lib/tools.js` 命中 **0 行** |',
].join('\n');

test('T20b: 命令式反引号里的路径也要抽出来（假完成根因）', () => {
  const paths = extractRepoPaths(T20B_BODY);
  // 行号 `:383` 保留在**抽取层**（归一化在 normalizeRepoPath 里剥），与 2026-10-27 口径一致
  assert.deepEqual(paths, [
    'plugins/agint-dream/lib/sweep.js:383',
    'plugins/agint-dream/lib/tools.js',
  ], '两处目标都必须抽到，且顺序 = 正文顺序');
});

test('T20b2: resolveTargetAssets 对同一条正文给出 2 个目标（修前只有 1 个 ⇒ 假完成）', () => {
  const all = resolveTargetAssets({ title: '让统计量可见', body: T20B_BODY }, [], T20B_REPO);
  assert.deepEqual(all.map((t) => t.id), T20B_REPO,
    '少给一个目标 ⇒ scope 的 unitsTotal 就少算一个 ⇒ 改一半也判 complete');
});

test('T20c: 两类反引号混排时按首次出现位置排序，不是「命令里的排最后」', () => {
  const text = [
    '先看 `grep -n x plugins/a/lib/one.js`，它是要改的；',
    '再核对 `plugins/a/lib/two.js`；',
    '最后 `sed -i s/x/y/ plugins/a/lib/three.js` 收尾。',
  ].join('\n');
  assert.deepEqual(extractRepoPaths(text), [
    'plugins/a/lib/one.js',
    'plugins/a/lib/two.js',
    'plugins/a/lib/three.js',
  ]);
});

test('T20d: 命令里的裸文件名不当目标（含目录才收）', () => {
  // AGENTS.md / package.json 在正文里通常是「参考」，不是「要改的」
  const text = '按 `cat AGENTS.md` 与 `node -e "require(\'./package.json\')"` 的约定，改 `plugins/a/lib/x.js`';
  assert.deepEqual(extractRepoPaths(text), ['plugins/a/lib/x.js'],
    '命令里的裸文件名会让 unitsTotal 虚高，一律不收');
  // 但单独一句 `AGENTS.md` 是显式引用，原口径照旧收
  assert.deepEqual(extractRepoPaths('见 `AGENTS.md`'), ['AGENTS.md']);
});

test('T20e: 反引号外的裸文本不抓，URL 也不会变成目标', () => {
  assert.deepEqual(extractRepoPaths('改 plugins/a/lib/x.js 就行'), [],
    '没有反引号不算引用');
  assert.deepEqual(extractRepoPaths('见 `curl https://example.com/a.js`'), [],
    'URL 抽出来的 host 前缀不在仓库文件集里，由 resolveTargetAssets 过滤');
});

// ── T21: resolveTargetAsset —— 技能命中 > 仓库路径命中 > null ──────────────
test('T21: resolveTargetAsset 三级定位', () => {
  const repoFiles = ['plugins/agint-metrics/lib/service.js', 'README.md'];
  const skillHit = resolveTargetAsset(
    { title: '改进 plugin-preflight 技能', body: '' },
    ['plugin-preflight'],
    repoFiles,
  );
  assert.deepEqual(skillHit, { type: 'skill', id: 'plugin-preflight' });

  const repoHit = resolveTargetAsset(
    { title: '修 dsh-storage 同名 spec bug', body: '目标 `plugins/agint-metrics/lib/service.js`' },
    ['plugin-preflight'],
    repoFiles,
  );
  assert.deepEqual(repoHit, { type: 'repo', id: 'plugins/agint-metrics/lib/service.js' });

  assert.equal(resolveTargetAsset({ title: '改 agint-restart 护栏', body: '' }, ['plugin-preflight'], repoFiles), null);
  assert.equal(resolveTargetAsset({ title: 'x', body: 'y' }, [], []), null);
});

// ── T20b: normalizeRepoPath —— 部署位路径归一（2026-10-27 实机）────────────
//
// 实机那次：提案正文写面板里看到的 `~/.dsh/.agint-bundle/plugins/.../index.js:793`，
// 而 repoFiles 是仓库相对路径 ⇒ 求交恒空 ⇒ 一条真能改的提案被判 not-actionable。
test('T20b: 部署位路径 → 仓库相对路径', () => {
  assert.equal(
    normalizeRepoPath('~/.dsh/.agint-bundle/plugins/agint-evolve/lib/index.js:793'),
    'plugins/agint-evolve/lib/index.js', 'bundle 位 + 行号要一起剥掉');
  assert.equal(normalizeRepoPath('$DSH_HOME/.agint-bundle/plugins/agint-x/lib/i.js'), 'plugins/agint-x/lib/i.js');
  assert.equal(normalizeRepoPath('/home/u/.dsh/profiles/web/plugins/agint-x/lib/i.js'), 'plugins/agint-x/lib/i.js');
  assert.equal(
    normalizeRepoPath('/home/u/.dsh/profiles/web/node_modules/@agint/host/plugins/agint-x/lib/i.js'),
    'plugins/agint-x/lib/i.js', 'host 包位必须先剥，否则留下 node_modules 前缀');
  assert.equal(normalizeRepoPath('/home/u/projects/DSH-AGINT/plugins/agint-x/lib/i.js'), 'plugins/agint-x/lib/i.js');
  assert.equal(normalizeRepoPath('plugins/agint-x/lib/i.js'), 'plugins/agint-x/lib/i.js', '已是仓库相对路径就别动');
  assert.equal(normalizeRepoPath('docs/x.md:107-167'), 'docs/x.md');
  assert.equal(normalizeRepoPath(''), '');
});

// ── T21b: 正文写部署位路径 ⇒ 仍能定位（实机 9d9697cf 那次失败）─────────────
test('T21b: 部署位路径的提案也能定位到仓库文件', () => {
  const repoFiles = ['plugins/agint-evolve/lib/index.js', 'plugins/agint-metrics/lib/service.js'];
  assert.deepEqual(
    resolveTargetAsset({ title: '修复提案台 schema', body: '根因在 `~/.dsh/.agint-bundle/plugins/agint-evolve/lib/index.js:793`，照改。' }, [], repoFiles),
    { type: 'repo', id: 'plugins/agint-evolve/lib/index.js' });
  assert.deepEqual(
    resolveTargetAsset({ title: 'x', body: '见 `/home/u/DSH-AGINT/plugins/agint-evolve/lib/index.js`' }, [], repoFiles),
    { type: 'repo', id: 'plugins/agint-evolve/lib/index.js' }, '绝对路径带仓库根也要认');
  // ⛔ 歧义（两个插件都有 lib/index.js）⇒ 不猜：改错文件比不改更糟
  assert.equal(
    matchRepoFile(['lib/index.js'], ['plugins/a/lib/index.js', 'plugins/b/lib/index.js']),
    null, '有歧义就返回 null');
  assert.equal(matchRepoFile(['plugins/agint-evolve/lib/index.js'], repoFiles), 'plugins/agint-evolve/lib/index.js');
});

// ── T22: isCommitEnabled 默认开（K51 + 2026-09-27 老板拍板）────────────────
test('T22: commit 默认开，显式 off 才关', () => {
  assert.equal(isCommitEnabled({}), true);
  assert.equal(isCommitEnabled({ AGINT_EVOLUTION_DRIVER_COMMIT: 'on' }), true);
  assert.equal(isCommitEnabled({ AGINT_EVOLUTION_DRIVER_COMMIT: 'OFF' }), false);
});

// ── T23: resolveRepoRoot —— env > config > null ───────────────────────────
test('T23: resolveRepoRoot 优先级', () => {
  assert.equal(resolveRepoRoot({ AGINT_EVOLUTION_DRIVER_REPO_ROOT: '/env/root' }, { repoRoot: '/cfg/root' }), '/env/root');
  assert.equal(resolveRepoRoot({}, { repoRoot: '/cfg/root' }), '/cfg/root');
  assert.equal(resolveRepoRoot({}, {}), null);
});

// ── T24: commitToRepo —— preimage 备份 + 唯一性 + denylist ─────────────────
test('T24: commitToRepo 落盘三保险', async () => {
  const { mkdtemp, readFile, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'evodriver-'));
  await writeFile(join(root, 'lib.js'), 'const a = 1;\nconst b = 2;\n', 'utf8');

  const okRes = await commitToRepo({
    repoRoot: root,
    relPath: 'lib.js',
    oldText: 'const b = 2;',
    newText: 'const b = 42;',
    now: new Date('2026-09-27T00:00:00Z'),
  });
  assert.equal(okRes.ok, true);
  assert.equal(await readFile(join(root, 'lib.js'), 'utf8'), 'const a = 1;\nconst b = 42;\n');
  const backup = await readFile(join(root, okRes.preimagePath), 'utf8');
  assert.equal(backup, 'const a = 1;\nconst b = 2;\n');

  // 多处命中拒绝
  await writeFile(join(root, 'dup.js'), 'x\nx\n', 'utf8');
  const dup = await commitToRepo({ repoRoot: root, relPath: 'dup.js', oldText: 'x', newText: 'y' });
  assert.equal(dup.ok, false);
  assert.match(dup.reason, /occurs 2 times/);

  // denylist：cordis.patch.yml 绝不碰
  const deny = await commitToRepo({ repoRoot: root, relPath: 'cordis.patch.yml', oldText: 'a', newText: 'b' });
  assert.equal(deny.ok, false);
  assert.match(deny.reason, /denylist/);

  // 目录穿越拒绝
  const evil = await commitToRepo({ repoRoot: root, relPath: '../evil.js', oldText: 'a', newText: 'b' });
  assert.equal(evil.ok, false);
});

// ── T25: runOnce 全链路 —— repo 目标 → LLM → propose → commit 事件 ─────────
test('T25: repo 目标全链路，commit 默认开且发 committed 事件（v0.2.8 真实 tmpdir）', async () => {
  // v0.2.8：真实磁盘仓库。内容必须是**合法 JS** —— 写入后验证会真的跑 `node --check`，
  // 用 'hello world' 这种裸文本会直接被语法检查判死（那正是 v0.2.7 的真实故障形态）。
  const repoRoot = await makeRepo({ 'lib/service.js': "export const greeting = 'hello world';\n" });
  try {
    const calls = [];
    let policySaw = null;
    const fakeEvolve = {
      listProposals: async () => [
        { id: 'c1', title: '修 metrics bug', body: '目标 `lib/service.js` 的超时', status: 'proposed' },
      ],
    };
    const proposeInputs = [];
    const fakeMutator = {
      propose: async (input) => {
        calls.push(['propose', input.promptPayload.promptId]);
        proposeInputs.push(input);
        return { id: 'p1', kind: 'PROMPT_MUTATION', status: 'PENDING' };
      },
      validate: async () => ({ ok: true, findings: [] }),
    };
    const fakePopulation = {
      ingest: async () => ({
        variant_id: 'v1', generation: 2, mutation_kind: 'PROMPT_MUTATION',
        expected_effect: { metric: 'SUCCESS_RATE', direction: 'increase', window: '7d' },
        policy_decision: 'PENDING_REVIEW', stage: 'shadow',
      }),
    };
    const agents = { create: async () => { throw new Error('should not spawn (llm injected)'); } };
    const subagents = { start: async () => { throw new Error('should not spawn (llm injected)'); } };
    const evolutionLog = fakeEvolutionLog({ calls });

    const ctx = makeCtx({
      'agint.evolve': fakeEvolve,
      'agint.mutator': fakeMutator,
      'agint.population': fakePopulation,
      'agint.evolution': evolutionLog,
      agents,
      subagents,
    });
    const events = busRecorder(ctx);
    apply(ctx, { repoRoot });
    const out = await ctx.provided['agint.evolutionDriver'].runOnce({
      env: {},
      inject: {
        // ⭐ v0.2.8 核心回归点：目标是**文件**，不该再走 runSmoke。
        // 2026-09-29 生产实跑证明 runSmoke 对任意文件恒返回 package-json-missing
        // （去 bin/plugin-check.sh/package.json 找插件清单），导致 commit 100% 被拒。
        // 这里让它一被调用就抛错 —— 若代码退回到 runSmoke，本用例会红。
        sandbox: { runSmoke: async () => { throw new Error('file target must NOT reach runSmoke'); } },
        // v0.2.9：mock 必须复刻真实 policy 的契约，否则测不出字段名错配。
        // 真 policy（decide.js:88/96）只按 `d.key` 取权重：`weights[d.key] ?? 0`
        // 在只给 name 时为 0 → den===0 → composite=null → 恒 REJECT。
        // v0.2.8 的 mock 固定返回 AUTO_DEPLOY，所以把 driver 传 `name` 这个 bug 放了过去，
        // 直到 2026-09-29 真实实跑才暴露（decision=REJECT 而 verifyOk=true）。
        policy: {
          decide: async ({ results }) => {
            const dims = results?.[0]?.dimensions ?? [];
            policySaw = results?.[0];
            const keyed = dims.some((d) => d.key === 'safety') && dims.some((d) => d.key === 'trust');
            return keyed
              ? { kind: 'AUTO_DEPLOY', reason: 'score-85' }
              : { kind: 'REJECT', reason: 'unknown-veto' };
          },
        },
        evolution: evolutionLog,
        llm: async () => ({
          ok: true,
          value: {
            applicable: true,
            targetSkill: 'lib/service.js',
            oldText: 'hello world',
            newText: 'hello AGINT world',
            rationale: 'test',
          },
        }),
        skillNames: [],
        // 只注入 scanRepo：目标解析需要它；读取与写入走真实磁盘，
        // 这样 preimage 备份与 node --check 才验的是真东西。
        fs: { scanRepo: async () => ['lib/service.js', 'README.md'] },
      },
    });
    assert.equal(out.skipped, false);
    assert.deepEqual(out.target, { type: 'repo', id: 'lib/service.js' });
    // v0.2.3 起 promptId 走 slugifyPromptId（mutator 正则要求 kebab slug）
    assert.deepEqual(calls[0], ['propose', 'service-js']);
    // v0.2.14：代码类目标声明`场景集通过率`（点名 R1 仪器），不再是那句对所有变异通用的谎话
    assert.equal(proposeInputs[0].expectedEffect, EXPECTED_EFFECT_CODE,
      'repo 目标的期望必须与 metric-resolver 能解析成 SUCCESS_RATE 的那句一致');
    // 真实文件确实被改写了，且改后仍是合法 JS
    const onDisk = await readFile(join(repoRoot, 'lib/service.js'), 'utf8');
    assert.equal(onDisk, "export const greeting = 'hello AGINT world';\n");
    const topics = events.map((e) => e.topic);
    assert.ok(topics.includes('evolution.mutation.proposed'));
    assert.ok(topics.includes('evolution.mutation.committed'));
    const committed = events.find((e) => e.topic === 'evolution.mutation.committed');
    assert.equal(committed.payload.path, 'lib/service.js');
    assert.equal(committed.payload.proposalId, 'p1');
    // 事件必须带验证结论，否则事后无从判断这处改动是否过了 D-QAF
    assert.equal(committed.payload.sandboxOk, true);
    assert.equal(committed.payload.policyDecision, 'AUTO_DEPLOY');
    // v0.2.8：verifyMode 证明走的是语法检查而非 runSmoke
    assert.equal(committed.payload.verifyMode, 'syntax:.js');
    // ⭐ v0.2.9：锁住交给 policy 的契约形状 —— dimensions 必须带 key，
    // 否则真 policy 的 computeComposite 取不到权重（weights[d.key] ?? 0 → 0）→ 恒 REJECT。
    assert.ok(policySaw, 'policy 必须被调用');
    assert.deepEqual(
      policySaw.dimensions.map((d) => d.key),
      ['safety', 'trust'],
      'dimensions 缺 key ⇒ policy 恒 REJECT（v0.2.8 实跑踩过）',
    );
    assert.deepEqual(policySaw.dimensions.map((d) => d.name), ['safety', 'trust'],
      'name 也要保留，兼容按 name 读旧结构的调用方');
    // ⭐ v0.2.10：返回值必须把 commit 阶段的决策以**值**交给调用方。
    // 此前它只在 publish 的事件里（事件未落盘），cron 侧只写 Object.keys(result)，
    // 于是「AUTO_DEPLOY 还是 PENDING_REVIEW」进程退出后无从查证。
    // 注意别和 out.policyDecision（提案阶段 variant.policy_decision）搞混。
    assert.equal(out.commit.ok, true);
    assert.equal(out.commit.policyDecision, 'AUTO_DEPLOY',
      'commit 成功分支此前不带 policyDecision —— 恰恰是成功时查不到');
    assert.equal(out.summary.policyDecision, 'AUTO_DEPLOY', 'summary 通道必须带出决策值');
    assert.equal(out.summary.policyReason, 'score-85',
      'policy 的 reason 才是排障抓手；此前 (await decide())?.kind 把 reason 丢掉了');
    assert.equal(out.summary.verifyMode, 'syntax:.js');
    assert.equal(out.summary.reverted, false);
    assert.equal(out.summary.proposalId, 'p1');

    // ── §4.3.4 接线（Sprint 22 #10）：AUTO_DEPLOY 必须入链 ────────────────────
    const appended = evolutionLog.appended;
    assert.equal(appended.length, 1, 'AUTO_DEPLOY 决策必须写出一条 ledger 条目');
    const le = appended[0];
    assert.equal(le.contractId, 'p1', 'contractId 取 proposal.id（幂等键）');
    assert.equal(le.generation, 'GEN-002', 'generation 由 variant.generation 补零而来');
    assert.equal(le.summary.decision, 'AUTO_DEPLOY');
    assert.equal(le.summary.mutationType, 'PROMPT_MUTATION', '取自 proposal.kind（FROZEN 同枚举）');
    assert.equal(le.summary.targetMetric, 'SUCCESS_RATE', '取自 variant.expected_effect.metric');
    assert.deepEqual(le.summary.changedPlugins, [],
      'lib/service.js 不在 plugins/ 下 ⇒ 不硬凑插件名（空数组=如实没有）');
    assert.ok(le.summary.hypothesisDigest.includes('target=lib-service-js')
      || le.summary.hypothesisDigest.includes('path='), `摘要要含定位信息：${le.summary.hypothesisDigest}`);
    // ⛔ 无证据字段必须是 null，不能是"看起来对"的值
    for (const k of ['predictedDelta', 'actualDelta', 'predictionQuality', 'predictionSource']) {
      assert.equal(le.summary[k], null, `summary.${k} 无证据 ⇒ null（§4.3.5 规则 3 同源纪律）`);
    }
    for (const k of ['contractHash', 'lockEventId', 'mountTicketId', 'abTestId', 'gitCommit']) {
      assert.equal(le.references[k], null, `references.${k} 无证据 ⇒ null`);
    }
    assert.equal(le.references.populationCandidateId, 'v1');
    assert.equal(le.references.preimagePath, committed.payload.preimagePath,
      'preimage 路径要能接上事件里那一份');
    assert.deepEqual(le.references.eventBusIds, [committed.envelopeId],
      'references.eventBusIds 必须接到真实 envelopeId');
    assert.equal(le.timestamp, le.timestamp, 'UTC 毫秒串（service 侧 assertUtcMillisIso 把关）');
    assert.match(le.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(le.reconstructed, undefined, '实时条目不带 reconstructed ⇒ 由 schema 默认 false');
    assert.equal(out.summary.ledgerSeq, 1, 'summary 通道要带出 seq（cron 落盘后唯一读得到）');
    assert.equal(out.summary.ledgerStatus, 'APPENDED');
    // 成功路径不应记录 failure
    assert.equal(calls.some((c) => c[0] === 'addFailure'), false);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('T25b: fail-closed —— sandbox/policy 不可用时不写仓库，只发 commit-skipped', async () => {
  const calls = [];
  const fakeEvolve = {
    listProposals: async () => [
      { id: 'c1', title: '修 metrics bug', body: '目标 `lib/service.js` 的超时', status: 'proposed' },
    ],
  };
  const fakeMutator = {
    propose: async () => ({ id: 'p1', kind: 'PROMPT_MUTATION', status: 'PENDING' }),
    validate: async () => ({ ok: true, findings: [] }),
  };
  const ctx = makeCtx({
    'agint.evolve': fakeEvolve,
    'agint.mutator': fakeMutator,
    'agint.population': { ingest: async () => ({ variant_id: 'v1', policy_decision: 'ALLOW', stage: 'shadow' }) },
    agents: { create: async () => { throw new Error('no spawn'); } },
    subagents: { start: async () => { throw new Error('no spawn'); } },
  });
  const events = busRecorder(ctx);
  apply(ctx, { repoRoot: '/fake/repo' });
  const out = await ctx.provided['agint.evolutionDriver'].runOnce({
    env: {},
    inject: {
      // 故意不注入 sandbox / policy
      llm: async () => ({
        ok: true,
        value: { applicable: true, targetSkill: 'lib/service.js', oldText: 'hello world', newText: 'hello AGINT world', rationale: 'test' },
      }),
      skillNames: [],
      fs: {
        scanRepo: async () => ['lib/service.js'],
        readRepo: async () => 'hello world\n',
        writeRepo: async (p, text) => { calls.push(['write', p, text]); },
      },
    },
  });
  assert.equal(out.skipped, false);
  // ⛔ 核心断言：一次 write 都不能发生 —— 没有验证能力就不许改仓库
  assert.equal(calls.filter((c) => c[0] === 'write').length, 0, 'fail-closed 失败：无验证通道却写了仓库');
  const topics = events.map((e) => e.topic);
  assert.ok(topics.includes('evolution.mutation.proposed'), 'proposed 仍应照常发');
  assert.ok(topics.includes('evolution.mutation.commit-skipped'), '必须发 commit-skipped 留痕');
  assert.ok(!topics.includes('evolution.mutation.committed'), '未验证不得发 committed');
});

// REJECT 与 ABSTAIN 在 driver 里走**同一条**分支（`decision === 'REJECT' || decision === 'ABSTAIN'`），
// 但 §4.3.4 末段的承诺是两者都入链 ⇒ 各跑一遍真实 tmpdir 回滚 + 真实入链，不靠"代码同路径"推断。
for (const rejectedKind of ['REJECT', 'ABSTAIN']) {
test(`T25c${rejectedKind === 'REJECT' ? '' : '-b'}: policy ${rejectedKind} → 从 preimage 真回滚（v0.2.8 真实 tmpdir），不发 committed，且必须入链`, async () => {
  // v0.2.8 改真实磁盘：v0.2.7 用虚拟 fs 时"回滚成功"只是断言了返回值，
  // 并没有证明文件真的被还原。这里跑真文件，真回滚。
  const ORIGINAL = "export const greeting = 'hello world';\n";
  const repoRoot = await makeRepo({ 'lib/service.js': ORIGINAL });
  try {
    const calls = [];
    const fakeEvolve = {
      listProposals: async () => [
        { id: 'c1', title: '修 metrics bug', body: '目标 `lib/service.js` 的超时', status: 'proposed' },
      ],
    };
    const fakeMutator = {
      propose: async () => ({ id: 'p1', kind: 'PROMPT_MUTATION', status: 'PENDING' }),
      validate: async () => ({ ok: true, findings: [] }),
    };
    const evolutionLog = fakeEvolutionLog({ calls });
    const ctx = makeCtx({
      'agint.evolve': fakeEvolve,
      'agint.mutator': fakeMutator,
      'agint.population': {
        ingest: async () => ({
          variant_id: 'v1', generation: 1, mutation_kind: 'PROMPT_MUTATION',
          expected_effect: { metric: 'SUCCESS_RATE', direction: 'increase', window: '7d' },
          policy_decision: 'PENDING_REVIEW', stage: 'shadow',
        }),
      },
      'agint.evolution': evolutionLog,
      agents: { create: async () => { throw new Error('no spawn'); } },
      subagents: { start: async () => { throw new Error('no spawn'); } },
    });
    const events = busRecorder(ctx);
    apply(ctx, { repoRoot });
    const out = await ctx.provided['agint.evolutionDriver'].runOnce({
      env: {},
      inject: {
        // 语法检查会通过（改后仍是合法 JS），拒它的只能是 policy —— 这才能证明
        // 「policy 决策 -> 回滚」这条链本身是通的，而不是被验证失败顺手拦下的。
        sandbox: { runSmoke: async () => { throw new Error('file target must NOT reach runSmoke'); } },
        policy: { decide: async () => ({ kind: rejectedKind, reason: 'veto' }) },
        evolution: evolutionLog,
        llm: async () => ({
          ok: true,
          value: { applicable: true, targetSkill: 'lib/service.js', oldText: 'hello world', newText: 'hello AGINT world', rationale: 'test' },
        }),
        skillNames: [],
        fs: { scanRepo: async () => ['lib/service.js'] },
      },
    });
    const topics = events.map((e) => e.topic);
    assert.ok(!topics.includes('evolution.mutation.committed'), '被拒不得发 committed');
    assert.ok(topics.includes('evolution.mutation.rolledback'), '必须发 rolledback 留痕');
    const rb = events.find((e) => e.topic === 'evolution.mutation.rolledback');
    assert.equal(rb.payload.policyDecision, rejectedKind);
    assert.equal(rb.payload.sandboxOk, true, '语法检查是通过的 —— 拒它的只能是 policy');
    assert.equal(rb.payload.reverted, true, '必须回滚成功');
    // ⭐ v0.2.8 真正的回滚断言：磁盘内容必须与改动前逐字节一致
    assert.equal(await readFile(join(repoRoot, 'lib/service.js'), 'utf8'), ORIGINAL,
      '回滚后磁盘内容必须与改动前完全一致 —— 仓库不能留下任何未验证改动');
    // 返回值要能区分「被拒」与「路径不合法」
    assert.equal(out.commit.ok, false);
    assert.equal(out.commit.reverted, true);
    // v0.2.8：失败原因必须留痕，且 pattern 要能区分「验证挂」与「policy 拒」
    const failure = calls.find((c) => c[0] === 'addFailure');
    assert.ok(failure, '被拒必须记 failure_pattern —— 否则事后查不到原因');
    assert.equal(failure[1], 'evolution-commit-rejected:policy');
    // ⭐ v0.2.10：被拒路径的 summary 同样要带出决策与回滚结果 ——
    // 「被拒了」必须能在重启后查成「被 policy 以某理由拒，且已回滚成功」。
    assert.equal(out.summary.policyDecision, rejectedKind);
    assert.equal(out.summary.policyReason, 'veto', 'policy 的 reason 也要落盘');
    assert.equal(out.summary.reverted, true);
    assert.equal(out.summary.verifyOk, true, '语法检查是通过的 —— 拒它的是 policy，摘要里要能看出这一点');
    assert.equal(out.summary.verifyMode, 'syntax:.js');

    // ── §4.3.4 接线（Sprint 22 #10）：REJECT / ABSTAIN 同样必须入链 ──────────
    // Ledger 记的是「进化发生过什么」，不是「进化成功过什么」。只记 AUTO_DEPLOY
    // 就等于在证据层把被拒的历史重新美化一遍（§4.3.4 末段）。
    assert.equal(evolutionLog.appended.length, 1, `${rejectedKind} 也必须写出一条 ledger 条目`);
    const le = evolutionLog.appended[0];
    assert.equal(le.summary.decision, rejectedKind);
    assert.equal(le.contractId, 'p1');
    assert.equal(le.generation, 'GEN-001');
    assert.ok(le.summary.hypothesisDigest.includes('exec=reverted'),
      `回滚结果必须固化进摘要（哈希保护）：${le.summary.hypothesisDigest}`);
    assert.deepEqual(le.references.eventBusIds, [rb.envelopeId]);
    assert.equal(out.summary.ledgerStatus, 'APPENDED');
    // 被拒路径本就该记一条 commit-rejected failure；ledger 写入成功 ⇒ 不能再多一条
    assert.equal(calls.filter((c) => c[0] === 'addFailure'
      && String(c[1]).startsWith('evolution-ledger-')).length, 0, 'ledger 写入成功时不该记 ledger 失败');
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
}

// ── v0.2.8：验证器与留痕的单元测试 ─────────────────────────────────────

// ── Phase 1.1 支点 1a：预测锁定接线（§2.4.2「锁定必须先于执行」）────────────

test('T25d: 1a —— 锁必须早于仓库写入与评估，predictedDelta 随锁流入 Ledger', async () => {
  const repoRoot = await makeRepo({ 'lib/service.js': "export const greeting = 'hello world';\n" });
  try {
    const calls = [];
    const order = [];
    const locks = new Map();
    const fakeEvolve = {
      listProposals: async () => [
        { id: 'c1', title: '修 metrics bug', body: '目标 `lib/service.js` 的超时', status: 'proposed' },
      ],
    };
    const fakeMutator = {
      propose: async () => ({ id: 'p1', kind: 'PROMPT_MUTATION', status: 'PENDING' }),
      validate: async () => ({ ok: true, findings: [] }),
    };
    const fakePopulation = {
      ingest: async () => ({
        variant_id: 'v1', generation: 1, mutation_kind: 'PROMPT_MUTATION',
        expected_effect: { metric: 'SUCCESS_RATE', direction: 'increase', window: '7d' },
        policy_decision: 'PENDING_REVIEW', stage: 'shadow',
      }),
    };
    const evolutionLog = fakeEvolutionLog({ calls });
    evolutionLog.recordContractLock = async (input) => {
      order.push('lock');
      // ⭐ 时序铁律的**直接**证据：被调用那一刻磁盘上还是原文。
      //    只比数组顺序证明不了"结果还没发生"——文件内容才证明得了。
      const disk = await readFile(join(repoRoot, 'lib/service.js'), 'utf8');
      assert.ok(disk.includes('hello world'), '锁定时改动尚未落盘 ⇒ 预测不可能是照着结果编的');
      if (locks.has(input.contractId)) throw new Error('contract-lock-already-exists');
      const row = {
        contractId: input.contractId,
        hypothesisLock: input.hypothesisLock,
        lockAlgorithm: 'sha256',
        lockedAt: input.lockedAt,
        predictionSource: input.predictionSource ?? null,
        lockEventId: input.lockEventId ?? null,
      };
      locks.set(input.contractId, row);
      return { ...row };
    };

    const ctx = makeCtx({
      'agint.evolve': fakeEvolve,
      'agint.mutator': fakeMutator,
      'agint.population': fakePopulation,
      'agint.evolution': evolutionLog,
      agents: { create: async () => { throw new Error('llm injected'); } },
      subagents: { start: async () => { throw new Error('llm injected'); } },
    });
    const events = busRecorder(ctx);
    apply(ctx, { repoRoot });
    const out = await ctx.provided['agint.evolutionDriver'].runOnce({
      env: {},
      inject: {
        sandbox: { runSmoke: async () => { throw new Error('file target must NOT reach runSmoke'); } },
        policy: {
          decide: async ({ results }) => {
            order.push('policy');
            const dims = results?.[0]?.dimensions ?? [];
            const keyed = dims.some((d) => d.key === 'safety') && dims.some((d) => d.key === 'trust');
            return keyed ? { kind: 'AUTO_DEPLOY', reason: 'score-85' } : { kind: 'REJECT', reason: 'unknown-veto' };
          },
        },
        evolution: evolutionLog,
        llm: async () => ({
          ok: true,
          value: {
            applicable: true, targetSkill: 'lib/service.js',
            oldText: 'hello world', newText: 'hello AGINT world', rationale: 'test',
          },
        }),
        skillNames: [],
        fs: { scanRepo: async () => ['lib/service.js'] },
      },
    });

    // ── 时序：锁在评估之前（order 里 lock 必须排第一）
    assert.deepEqual(order, ['lock', 'policy'], '锁定必须早于 verify/policy（§2.4.2）');
    // ── 锁定事件与表
    const lockEvent = events.find((e) => e.topic === 'evolution.contract.locked');
    assert.ok(lockEvent, '必须发 evolution.contract.locked');
    assert.equal(lockEvent.payload.contractId, 'p1');
    assert.match(lockEvent.payload.hypothesisLock, /^sha256:[0-9a-f]{64}$/);
    const row = locks.get('p1');
    assert.equal(row.predictionSource, 'DEFAULT_RULE');
    assert.equal(row.lockEventId, lockEvent.envelopeId,
      '表里的 lockEventId 必须接得上总线那条事件（读错字段名就恒为 null）');
    // ── 预测流入 Ledger
    assert.equal(evolutionLog.appended.length, 1);
    const le = evolutionLog.appended[0];
    assert.equal(le.summary.predictedDelta, 1.0, 'DEFAULT_RULE 表 DR-PROMPT-SUCCESS 的值');
    assert.equal(le.summary.predictionSource, 'DEFAULT_RULE');
    assert.equal(le.references.lockEventId, lockEvent.envelopeId);
    assert.equal(le.summary.actualDelta, null, 'actual 属 1b，本次不许带出');
    assert.equal(le.summary.predictionQuality, null, 'PQ 要等 actual 到位才算得出');
    assert.equal(le.references.contractHash, null, 'hypothesisLock ≠ contractHash');
    // ── 外部可读：summary 通道 + status 计数
    assert.equal(out.summary.prediction.status, 'LOCKED');
    assert.equal(out.summary.prediction.predictedDelta, 1.0);
    const st = ctx.provided['agint.evolutionDriver'].status();
    assert.equal(st.predictionLocked, 1);
    assert.equal(st.predictionSkipped, 0);
    // ── 主流程没被观测装置拖住：改动确实落盘、committed 事件照发
    const after = await readFile(join(repoRoot, 'lib/service.js'), 'utf8');
    assert.ok(after.includes('hello AGINT world'), '锁定成功不应阻断 commit');
    assert.ok(events.some((e) => e.topic === 'evolution.mutation.committed'));
    assert.equal(calls.some((c) => c[0] === 'addFailure'), false);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('T25e: 1a 生产实况 —— metric=unspecified 时无预测可锁，主流程照跑且链上留 null', async () => {
  const repoRoot = await makeRepo({ 'lib/service.js': "export const greeting = 'hello world';\n" });
  try {
    const calls = [];
    let lockCalls = 0;
    const fakeEvolve = {
      listProposals: async () => [
        { id: 'c1', title: '修 metrics bug', body: '目标 `lib/service.js` 的超时', status: 'proposed' },
      ],
    };
    const fakeMutator = {
      propose: async () => ({ id: 'p1', kind: 'PROMPT_MUTATION', status: 'PENDING' }),
      validate: async () => ({ ok: true, findings: [] }),
    };
    // 生产实况：mutator 的 expectedEffect 是**字符串**，population 只认对象
    // （agint-population/lib/index.js:173）⇒ metric 恒落 'unspecified'。
    const fakePopulation = {
      ingest: async () => ({
        variant_id: 'v1', generation: 1, mutation_kind: 'PROMPT_MUTATION',
        expected_effect: { metric: 'unspecified', direction: 'increase', window: '7d' },
        policy_decision: 'PENDING_REVIEW', stage: 'shadow',
      }),
    };
    const evolutionLog = fakeEvolutionLog({ calls });
    evolutionLog.recordContractLock = async () => { lockCalls += 1; return {}; };

    const ctx = makeCtx({
      'agint.evolve': fakeEvolve,
      'agint.mutator': fakeMutator,
      'agint.population': fakePopulation,
      'agint.evolution': evolutionLog,
      agents: { create: async () => { throw new Error('llm injected'); } },
      subagents: { start: async () => { throw new Error('llm injected'); } },
    });
    const events = busRecorder(ctx);
    apply(ctx, { repoRoot });
    const out = await ctx.provided['agint.evolutionDriver'].runOnce({
      env: {},
      inject: {
        sandbox: { runSmoke: async () => { throw new Error('file target must NOT reach runSmoke'); } },
        policy: { decide: async () => ({ kind: 'AUTO_DEPLOY', reason: 'score-85' }) },
        evolution: evolutionLog,
        llm: async () => ({
          ok: true,
          value: {
            applicable: true, targetSkill: 'lib/service.js',
            oldText: 'hello world', newText: 'hello AGINT world', rationale: 'test',
          },
        }),
        skillNames: [],
        fs: { scanRepo: async () => ['lib/service.js'] },
      },
    });

    assert.equal(lockCalls, 0, '无预测 ⇒ 不占一行锁（表里的"覆盖"必须是真覆盖）');
    assert.equal(events.some((e) => e.topic === 'evolution.contract.locked'), false);
    assert.equal(out.summary.prediction.status, 'NO_PREDICTION_AVAILABLE');
    assert.equal(out.summary.prediction.predictedDelta, null);
    const le = evolutionLog.appended[0];
    assert.equal(le.summary.targetMetric, 'unspecified', '指标缺失本身要如实入链');
    assert.equal(le.summary.predictedDelta, null);
    const st = ctx.provided['agint.evolutionDriver'].status();
    assert.equal(st.predictionLocked, 0);
    assert.equal(st.predictionSkipped, 1);
    assert.equal(out.commit.ok, true, '没有预测不影响进化本身（软失败外壳的意义）');
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('T25f: 1a 补片（方案②）—— variant 落兜底时从提案期望读出指标，锁真能落', async () => {
  const repoRoot = await makeRepo({ 'lib/service.js': "export const greeting = 'hello world';\n" });
  try {
    const calls = [];
    const order = [];
    const locks = new Map();
    const fakeEvolve = {
      listProposals: async () => [
        { id: 'c1', title: '修 metrics bug', body: '目标 `lib/service.js` 的超时', status: 'proposed' },
      ],
    };
    const fakeMutator = {
      // 生产真实形状：driver 传给 propose、mutator 原样带回的**字符串**期望
      //（index.js:591 'baseline 通过率 >= 95% 在 7 天'，FROZEN 契约要 string）。
      propose: async () => ({
        id: 'p1', kind: 'PROMPT_MUTATION', status: 'PENDING',
        expectedEffect: 'baseline 通过率 >= 95% 在 7 天',
      }),
      validate: async () => ({ ok: true, findings: [] }),
    };
    const fakePopulation = {
      // population 只认对象形式的 expectedEffect ⇒ 实时路径恒落这个兜底
      ingest: async () => ({
        variant_id: 'v1', generation: 1, mutation_kind: 'PROMPT_MUTATION',
        expected_effect: { metric: 'unspecified', direction: 'increase', window: '7d' },
        policy_decision: 'PENDING_REVIEW', stage: 'shadow',
      }),
    };
    const evolutionLog = fakeEvolutionLog({ calls });
    evolutionLog.recordContractLock = async (input) => {
      order.push('lock');
      const disk = await readFile(join(repoRoot, 'lib/service.js'), 'utf8');
      assert.ok(disk.includes('hello world'), '锁定时改动尚未落盘');
      if (locks.has(input.contractId)) throw new Error('contract-lock-already-exists');
      const row = { ...input, lockAlgorithm: 'sha256', lockedAt: input.lockedAt };
      locks.set(input.contractId, row);
      return { ...row };
    };

    const ctx = makeCtx({
      'agint.evolve': fakeEvolve,
      'agint.mutator': fakeMutator,
      'agint.population': fakePopulation,
      'agint.evolution': evolutionLog,
      agents: { create: async () => { throw new Error('llm injected'); } },
      subagents: { start: async () => { throw new Error('llm injected'); } },
    });
    const events = busRecorder(ctx);
    apply(ctx, { repoRoot });
    const out = await ctx.provided['agint.evolutionDriver'].runOnce({
      env: {},
      inject: {
        sandbox: { runSmoke: async () => { throw new Error('file target must NOT reach runSmoke'); } },
        policy: {
          decide: async () => { order.push('policy'); return { kind: 'AUTO_DEPLOY', reason: 'score-85' }; },
        },
        evolution: evolutionLog,
        llm: async () => ({
          ok: true,
          value: {
            applicable: true, targetSkill: 'lib/service.js',
            oldText: 'hello world', newText: 'hello AGINT world', rationale: 'test',
          },
        }),
        skillNames: [],
        fs: { scanRepo: async () => ['lib/service.js'] },
      },
    });

    assert.deepEqual(order, ['lock', 'policy'], '指标解析不改变时序：锁仍在评估之前');
    assert.equal(locks.size, 1, '方案②的意义就是让生产形态下真能落一行锁');

    const le = evolutionLog.appended[0];
    assert.equal(le.summary.targetMetric, 'SUCCESS_RATE',
      '条目用解析出的指标，而不是 variant 行里的 unspecified —— 否则与锁定的 hash 分叉');
    assert.equal(le.summary.predictedDelta, 1.0, 'DEFAULT_RULE 表 DR-PROMPT-SUCCESS');
    assert.equal(le.summary.predictionSource, 'DEFAULT_RULE');
    assert.ok(le.summary.hypothesisDigest.includes('expected SUCCESS_RATE increase within 7d'),
      `摘要要与 summary 同一个指标名：${le.summary.hypothesisDigest}`);

    // 出处落盘可查（不能靠读代码反推"这条预测建立在解析出的指标上"）
    assert.equal(out.summary.prediction.targetMetric, 'SUCCESS_RATE');
    assert.equal(out.summary.prediction.targetMetricSource, 'EXPECTED_EFFECT');
    assert.equal(out.summary.prediction.targetMetricReason, null);
    assert.equal(out.summary.prediction.status, 'LOCKED');

    // ⭐ 归档可复原：1b 只拿这条 Ledger 条目 + 表里的 lockedAt 就得重算出同一个 hash
    const row = locks.get('p1');
    const recomputed = computeHypothesisLock({
      contractId: le.contractId,
      createdAt: row.lockedAt,
      hypothesis: {
        ...buildLockHypothesis({
          mutationType: le.summary.mutationType,
          targetMetric: le.summary.targetMetric,
          changedComponents: le.summary.changedPlugins,
        }),
        predictedDelta: le.summary.predictedDelta,
        predictionSource: le.summary.predictionSource,
      },
    });
    assert.equal(recomputed, row.hypothesisLock,
      '复原不回来 = 锁作废（条目与锁定用了不同的 targetMetric 就会这样）');
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('T25g: 期望串也读不出指标 ⇒ 不锁、链上留 unspecified（不猜）', async () => {
  const repoRoot = await makeRepo({ 'lib/service.js': "export const greeting = 'hello world';\n" });
  try {
    const calls = [];
    let lockCalls = 0;
    const fakeEvolve = {
      listProposals: async () => [
        { id: 'c1', title: '修 metrics bug', body: '目标 `lib/service.js` 的超时', status: 'proposed' },
      ],
    };
    const fakeMutator = {
      propose: async () => ({
        id: 'p1', kind: 'PROMPT_MUTATION', status: 'PENDING',
        expectedEffect: '通过率 >= 95% 且延迟 <= 1s 在 7 天', // 两个指标 ⇒ 歧义
      }),
      validate: async () => ({ ok: true, findings: [] }),
    };
    const fakePopulation = {
      ingest: async () => ({
        variant_id: 'v1', generation: 1, mutation_kind: 'PROMPT_MUTATION',
        expected_effect: { metric: 'unspecified', direction: 'increase', window: '7d' },
        policy_decision: 'PENDING_REVIEW', stage: 'shadow',
      }),
    };
    const evolutionLog = fakeEvolutionLog({ calls });
    evolutionLog.recordContractLock = async () => { lockCalls += 1; return {}; };

    const ctx = makeCtx({
      'agint.evolve': fakeEvolve,
      'agint.mutator': fakeMutator,
      'agint.population': fakePopulation,
      'agint.evolution': evolutionLog,
      agents: { create: async () => { throw new Error('llm injected'); } },
      subagents: { start: async () => { throw new Error('llm injected'); } },
    });
    apply(ctx, { repoRoot });
    const out = await ctx.provided['agint.evolutionDriver'].runOnce({
      env: {},
      inject: {
        sandbox: { runSmoke: async () => { throw new Error('file target must NOT reach runSmoke'); } },
        policy: { decide: async () => ({ kind: 'AUTO_DEPLOY', reason: 'score-85' }) },
        evolution: evolutionLog,
        llm: async () => ({
          ok: true,
          value: {
            applicable: true, targetSkill: 'lib/service.js',
            oldText: 'hello world', newText: 'hello AGINT world', rationale: 'test',
          },
        }),
        skillNames: [],
        fs: { scanRepo: async () => ['lib/service.js'] },
      },
    });

    assert.equal(lockCalls, 0, '歧义 ⇒ 不猜指标 ⇒ 不落锁');
    assert.equal(out.summary.prediction.targetMetric, null);
    assert.equal(out.summary.prediction.targetMetricReason, 'METRIC_AMBIGUOUS');
    assert.equal(out.summary.prediction.status, 'NO_PREDICTION_AVAILABLE');
    const le = evolutionLog.appended[0];
    assert.equal(le.summary.targetMetric, 'unspecified', '指标缺失照原样入链（Sprint 22 同一条纪律）');
    assert.equal(le.summary.predictedDelta, null);
    assert.equal(out.commit.ok, true, '读不出指标不影响进化本身');
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('T25h: 技能类目标声明的是它自己能兑现的期望（不复用代码类那句）', async () => {
  const proposeInputs = [];
  let lockCalls = 0;
  const evolutionLog = fakeEvolutionLog({ calls: [] });
  evolutionLog.recordContractLock = async () => { lockCalls += 1; return {}; };
  const ctx = makeCtx({
    'agint.evolve': fakeEvolve([
      { id: 'c1', title: 'plugin-preflight 补 fixture', category: 'skill', status: 'proposed', createdAt: '2026-09-01', body: '' },
    ]),
    'agint.mutator': {
      propose: async (input) => {
        proposeInputs.push(input);
        return { id: 'p-skill', kind: 'PROMPT_MUTATION', status: 'PENDING', expectedEffect: input.expectedEffect };
      },
      validate: async () => ({ ok: true, findings: [] }),
    },
    'agint.population': fakePopulation(),
    'agint.evolution': evolutionLog,
  });
  apply(ctx);
  const out = await ctx.provided['agint.evolutionDriver'].runOnce({
    env: {},
    inject: {
      skillNames: ['plugin-preflight', 'github-push'],
      fs: { readSkill: async () => SKILL_TEXT },
      llm: GOOD_LLM,
    },
  });
  assert.equal(out.skipped, false, JSON.stringify(out));
  assert.equal(out.skill, 'plugin-preflight', '本用例走的就是 skill 目标分支');
  assert.equal(proposeInputs.length, 1);
  assert.equal(proposeInputs[0].expectedEffect, EXPECTED_EFFECT_SKILL,
    '技能类不得借用"通过率"——metric-resolver 会照词面把它锁成一条没人测的预测');
  assert.notEqual(proposeInputs[0].expectedEffect, EXPECTED_EFFECT_CODE);
  // 没有 repoRoot ⇒ 本轮不进 commit 分支，所以这里不锁是"没走到锁"而不是"锁被拒"；
  // 真正证明技能类不锁的是 test/expected-effect.test.mjs 的 METRIC_UNSTATED 断言。
  assert.equal(lockCalls, 0);
});

test('T26a: verifyTargetFile —— .sh 走 bash -n，改坏语法要判死', async () => {
  const repoRoot = await makeRepo({ 'bin/ok.sh': 'echo hello\n', 'bin/bad.sh': 'if [ -z "$1" ; then\n' });
  try {
    const sandbox = { runSmoke: async () => { throw new Error('must not reach runSmoke'); } };
    const good = await verifyTargetFile({ repoRoot, relPath: 'bin/ok.sh', sandbox });
    assert.equal(good.ok, true);
    assert.equal(good.mode, 'syntax:.sh');
    const bad = await verifyTargetFile({ repoRoot, relPath: 'bin/bad.sh', sandbox });
    assert.equal(bad.ok, false, '语法错误的 .sh 必须判死 —— 这是第 4 道闸的本职');
    assert.equal(bad.mode, 'syntax:.sh');
    assert.match(bad.reason, /exited \d+/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('T26b: verifyTargetFile —— .js 走 node --check；.md 跳过；目录仍走 runSmoke', async () => {
  const repoRoot = await makeRepo({
    // ⭐ bad.js 必须是 ESM 语法：`node --check` 对 `.js` 里的顶层 import/export 会漏检
    // （实测 `export const a = ;` 退出码 0），实现靠「复制成 .mjs 再检」兜住这一条。
    'lib/bad.js': 'export const a = ;\n',
    'lib/good.js': 'export const a = 1;\n',
    // 合法 CJS 必须仍然通过 —— 若无条件按 .mjs 检，require/module.exports 会被误判死
    'lib/cjs.js': "const fs = require('node:fs');\nmodule.exports = { fs };\n",
    'docs/notes.md': '# 标题\n随便写点什么\n',
    'plugins/demo/lib/index.js': 'export function apply() {}\n',
  });
  await writeFile(join(repoRoot, 'plugins/demo/package.json'),
    JSON.stringify({ name: 'demo', main: 'lib/index.js', type: 'module' }), 'utf8');
  try {
    const seen = [];
    const sandbox = { runSmoke: async (a) => { seen.push(a.target.path); return { ok: true, reason: undefined }; } };

    const good = await verifyTargetFile({ repoRoot, relPath: 'lib/good.js', sandbox });
    assert.equal(good.ok, true);
    assert.equal(good.mode, 'syntax:.js');

    const bad = await verifyTargetFile({ repoRoot, relPath: 'lib/bad.js', sandbox });
    assert.equal(bad.ok, false, 'ESM 语法错误的 .js 必须判死（node --check 直接检会漏）');
    assert.equal(bad.mode, 'syntax:.js');

    const cjs = await verifyTargetFile({ repoRoot, relPath: 'lib/cjs.js', sandbox });
    assert.equal(cjs.ok, true, '合法 CJS 不能被误判死');

    // 文档没有「语法可用」概念 —— 跳过而不是假装通过；最终去留交给 policy.decide
    const md = await verifyTargetFile({ repoRoot, relPath: 'docs/notes.md', sandbox });
    assert.equal(md.ok, true);
    assert.equal(md.skipped, true);
    assert.equal(md.mode, 'skip');
    assert.equal(seen.length, 0, '前四个都不该碰 runSmoke');

    // 目录 = 插件目录，runSmoke 唯一擅长的场景，保留
    const dir = await verifyTargetFile({ repoRoot, relPath: 'plugins/demo', sandbox });
    assert.equal(dir.mode, 'sandbox');
    assert.equal(seen.length, 1);

    // ⭐ v0.2.11：交给 runSmoke 的必须是 repoRoot 拼出的**绝对路径**。
    // 真实事故（v0.2.7，2026-09-29 05:26Z）：driver 传的是相对路径 commit.path，
    // 而 sandbox 内部 `const targetPath = resolve(target.path)`
    // （agint-quality-sandbox/lib/index.js:290，Node path.resolve 按 process.cwd() 解析）
    // —— 宿主 cwd 是 C:\Users\Administrator\Desktop，于是 bin/plugin-check.sh
    // 被验成 Desktop\bin\plugin-check.sh，failure_pattern 记 plugin-not-found。
    // 那次验的根本不是仓库里的文件，却一路走到了 policy。
    assert.ok(isAbsolute(seen[0]),
      `传给 runSmoke 的必须是绝对路径，实际是 ${JSON.stringify(seen[0])} —— 相对路径会被 sandbox 按 cwd 解析`);
    assert.equal(seen[0], join(repoRoot, 'plugins', 'demo'),
      '必须以 repoRoot 为基准拼，不能依赖 cwd');
    // 反向自查：同样的相对路径若落到 cwd 下，那里并没有这个目录。
    // 这条不是重复断言，是把「为什么绝对路径不可省」钉成可执行的判据。
    assert.notEqual(
      pathResolve('plugins/demo'),
      seen[0],
      '若两者相等，说明路径真的被 cwd 解析了（本测试运行 cwd 下不存在该目录时必红）',
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('T26c: verifyTargetFile —— 路径安全与不存在文件不静默通过', async () => {
  const repoRoot = await makeRepo({ 'lib/a.js': 'export const a = 1;\n' });
  try {
    const sandbox = { runSmoke: async () => ({ ok: true }) };
    const escape = await verifyTargetFile({ repoRoot, relPath: '../../etc/passwd', sandbox });
    assert.equal(escape.ok, false);
    assert.match(escape.reason, /unsafe path/);
    const missing = await verifyTargetFile({ repoRoot, relPath: 'lib/nope.js', sandbox });
    assert.equal(missing.ok, false, '不存在的文件不能当通过');
    assert.match(missing.reason, /stat failed/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('T26d: recordFailure —— 软依赖缺失不抛，evolve 抛错也不影响主流程', async () => {
  assert.deepEqual(await recordFailure({ evolve: null, pattern: 'x' }),
    { ok: false, reason: 'agint.evolution unavailable' });
  const boom = { addFailure: async () => { throw new Error('table full'); } };
  const r = await recordFailure({ evolve: boom, pattern: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'table full');
  const ok = { addFailure: async () => ({ id: 'f9' }) };
  assert.deepEqual(await recordFailure({ evolve: ok, pattern: 'x' }), { ok: true });
});

test('T28: slugifyPromptId —— repo 相对路径转 kebab slug，满足 mutator 正则', () => {
  const re = /^[a-z][a-z0-9-]{2,30}$/;
  // 常规：取末段
  assert.equal(slugifyPromptId('plugins/agint-metrics/lib/metrics.js'), 'metrics-js');
  assert.equal(slugifyPromptId('presets/agint/skills/plugin-preflight/SKILL.md'), 'skill-md');
  // 数字开头 → evo- 前缀兜底（正则要求首字符 [a-z]）
  const digit = slugifyPromptId('lib/2026-report.md');
  assert.match(digit, re);
  // 空值兜底
  assert.match(slugifyPromptId(''), re);
  assert.match(slugifyPromptId(null), re);
  // 超长截断后仍合规
  const long = slugifyPromptId('a/very/deeply/nested/path/with-an-extremely-long-filename-kept-for-compatibility.mjs');
  assert.match(long, re);
  assert.ok(long.length <= 31);
});

test('T29: validate 调用约定 —— 必传 { proposal } 整对象（mutator 读 input.proposal.id）', async () => {
  const mut = fakeMutator();
  const ctx = makeCtx({
    'agint.evolve': fakeEvolve([{ id: 'c1', title: 'plugin-preflight 补 fixture', status: 'proposed', createdAt: '2026-09-01', body: '' }]),
    'agint.mutator': mut,
    'agint.population': fakePopulation(),
  });
  apply(ctx);
  const out = await ctx.provided['agint.evolutionDriver'].runOnce({
    env: {},
    inject: { skillNames: ['plugin-preflight'], fs: { readSkill: async () => SKILL_TEXT }, llm: GOOD_LLM },
  });
  assert.equal(out.skipped, false, JSON.stringify(out));
  assert.equal(mut.calls.validate.length, 1);
  const arg = mut.calls.validate[0];
  assert.ok(arg && arg.proposal && typeof arg.proposal.id === 'string', 'validate 入参必须含 proposal.id');
  // promptId 也必须是合规 slug（fakeMutator 不校验，这里锁契约）
  assert.match(arg.proposal.promptPayload.promptId, /^[a-z][a-z0-9-]{2,30}$/);
});

// ── T30–T32: 实体存在性门（v0.2.4）—— 防内容级编造（agint-evolution-viz 事件）──

test('T30: findFabricatedEntities —— 结构化证据；文本提及不算数（K115）', () => {
  const repoFiles = [
    'lib/service.js', 'README.md', 'bin/check.sh', 'plugins/agint-metrics/lib/metrics.js',
  ];
  const codeText = 'const t = table("evolution_log"); // metrics_summary 由 agint-metrics 写入';
  // 编造实体落网：插件名不存在（即使代码文本「提到」它 —— 提及≠证据）；
  // 发明的表名不在生产代码里。
  assert.deepEqual(
    findFabricatedEntities('数据源见 `agint-evolution-viz` 与 `evolution_summary_log`。', {
      repoFiles,
      codeText: `${codeText} agint-evolution-viz`,
    }),
    ['agint-evolution-viz', 'evolution_summary_log'],
  );
  // 真实实体放行：插件目录在 repoFiles、表在代码索引、路径在 repoFiles
  assert.deepEqual(
    findFabricatedEntities(
      '跑 `bin/check.sh`，读 `evolution_log` / `metrics_summary`，代码见 `plugins/agint-metrics/lib/metrics.js`。',
      { repoFiles, codeText },
    ),
    [],
  );
  // 不可校验的 token（点路径/普通词/中文/IP）一律放行，压误报
  assert.deepEqual(
    findFabricatedEntities('检查 `manifest.spec.permissions`、`Hello World`、`连通性`、`192.168.1.88`。', {
      repoFiles,
      codeText,
    }),
    [],
  );
  // codeText=null（索引不可用）：snake 类放行；agint-* 结构化校验与路径校验照常硬卡
  assert.deepEqual(
    findFabricatedEntities('引用 `evolution_log`、`agint-evolution-viz` 与 `plugins/x/config.yml`。', {
      repoFiles,
      codeText: null,
    }),
    ['agint-evolution-viz', 'plugins/x/config.yml'],
  );
  // 非法入参
  assert.deepEqual(findFabricatedEntities(null, {}), []);
  assert.deepEqual(findFabricatedEntities('', {}), []);
});

test('T31: construct + entityGate —— newText 编造实体必须被拦在落盘前', async () => {
  const ctx = makeCtx({});
  apply(ctx);
  const svc = ctx.provided['agint.evolutionDriver'];
  const out = await svc.construct({
    candidate: { id: 'c9', title: 'x', body: '', status: 'proposed' },
    targetId: 'plugin-preflight',
    fileText: 'Step 2: smoke.\n',
    llm: async () => ({
      ok: true,
      value: {
        applicable: true,
        targetSkill: 'plugin-preflight',
        oldText: 'Step 2: smoke.',
        newText: 'Step 2: smoke. 数据源见 `agint-evolution-viz` 的 `evolution_log`。',
        rationale: 'adds reference',
      },
    }),
    entityGate: { repoFiles: [], getCodeIndex: async () => 'some unrelated code text' },
  });
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.match(out.reason, /entity gate/);
  assert.deepEqual(out.fabricated, ['agint-evolution-viz', 'evolution_log']);
});

test('T32: entityGate 放行真实实体；索引不可用（null）时 snake 类跳过不误杀', async () => {
  const ctx = makeCtx({});
  apply(ctx);
  const svc = ctx.provided['agint.evolutionDriver'];
  const good = {
    candidate: { id: 'c9', title: 'x', body: '', status: 'proposed' },
    targetId: 'plugin-preflight',
    fileText: 'Step 2: smoke.\n',
    llm: async () => ({
      ok: true,
      value: {
        applicable: true,
        targetSkill: 'plugin-preflight',
        oldText: 'Step 2: smoke.',
        newText: 'Step 2: smoke. 健康度读 `cron_health`，路径见 `lib/service.js`。',
        rationale: 'ok',
      },
    }),
  };
  // 真实实体 → 放行
  const pass = await svc.construct({
    ...good,
    entityGate: { repoFiles: ['lib/service.js'], getCodeIndex: async () => 'cron_health table lives here' },
  });
  assert.equal(pass.ok, true, JSON.stringify(pass));
  // 索引构建失败（null）→ snake 类放行（agint-*/路径类仍硬卡）
  const skip = await svc.construct({ ...good, entityGate: { repoFiles: ['lib/service.js'], getCodeIndex: async () => null } });
  assert.equal(skip.ok, true);
});

// ── T33–T35: checkEntities 服务扩展点（v0.2.5）—— 判据复用给别的插件 ──

test('T33: checkEntities —— 缺证据（门关 / 无 repoRoot）必须报 checked:false，不许假通过', async () => {
  const ctx = makeCtx({});
  apply(ctx);
  const svc = ctx.provided['agint.evolutionDriver'];

  const off = await svc.checkEntities('见 `agint-nope`', {
    env: { AGINT_EVOLUTION_DRIVER_ENTITY_GATE: 'off' },
    repoRoot: '/tmp/x',
  });
  assert.equal(off.checked, false);
  assert.match(off.reason, /off/);
  assert.deepEqual(off.fabricated, []);

  const noRoot = await svc.checkEntities('见 `agint-nope`', { env: {} });
  assert.equal(noRoot.checked, false);
  assert.match(noRoot.reason, /repoRoot/);
});

test('T34: checkEntities —— 复用同一份判据：拦编造、放真实（hermetic fs 注入）', async () => {
  const repoFiles = ['plugins/agint-metrics/lib/metrics.js', 'presets/agint/skills/plugin-preflight/SKILL.md'];
  const ctx = makeCtx({});
  apply(ctx);
  const svc = ctx.provided['agint.evolutionDriver'];
  const fsMock = {
    scanRepo: async () => repoFiles,
    codeIndex: async () => 'const t = table("evolution_log");',
  };

  const bad = await svc.checkEntities('数据源见 `agint-evolution-viz` 与 `evolution_nope_log`。', {
    env: {}, repoRoot: '/repo', fs: fsMock,
  });
  assert.equal(bad.checked, true);
  assert.deepEqual(bad.fabricated, ['agint-evolution-viz', 'evolution_nope_log']);

  const good = await svc.checkEntities('读 `evolution_log`，技能见 `plugin-preflight`。', {
    env: {}, repoRoot: '/repo', fs: fsMock,
  });
  assert.equal(good.ok, true);
  assert.deepEqual(good.fabricated, []);
  assert.equal(good.repoFiles, 2);
});

test('T35: checkEntities —— 门自己抛错时放行 + 留痕（观测装置不能变成新的单点故障）', async () => {
  const ctx = makeCtx({});
  apply(ctx);
  const svc = ctx.provided['agint.evolutionDriver'];
  const out = await svc.checkEntities('见 `agint-nope`', {
    env: {},
    repoRoot: '/repo',
    fs: { scanRepo: async () => { throw new Error('scan boom'); } },
  });
  assert.equal(out.checked, false);
  assert.match(out.reason, /scan boom/);
  assert.deepEqual(out.fabricated, []);
});

test('T36: 1b 接线 —— measureOutcomes 先验锁再量账：没仓库根就拒，计数器随结果动', async () => {
  const ctx = makeCtx({});
  apply(ctx);
  const svc = ctx.provided['agint.evolutionDriver'];
  assert.equal(typeof svc.measureOutcomes, 'function', 'cron outcome-measure 靠这个入口');

  // ① 没有仓库根（env 空 + config 空）⇒ 如实拒测，⛔ 不抛、不去猜一个仓库路径
  const none = await svc.measureOutcomes({ env: {} });
  assert.equal(none.ok, false);
  assert.equal(none.status, 'NO_REPOROOT');
  assert.deepEqual(none.results, []);

  // ② 计数器：一次测量 + 一次护栏未核 + 一次拒测
  const measurer = {
    measurePending: async ({ repoRoot, limit }) => {
      assert.equal(repoRoot, '/repo');
      assert.equal(limit, 2, 'limit 必须透传（成本闸门在调用侧可调）');
      return {
        ok: true, scanned: 5, measurable: 3, attempted: 2, deferred: 1,
        counts: { MEASURED: 1, CONCURRENT_WRITE: 1 },
        results: [
          { status: 'MEASURED', contractId: 'EVO-A', actualDelta: 27.3 },
          { status: 'CONCURRENT_WRITE', contractId: 'EVO-B', changedPath: 'plugins/x/lib/i.js', needsAttention: true },
        ],
      };
    },
  };
  const out = await svc.measureOutcomes({ repoRoot: '/repo', limit: 2, inject: { measurer } });
  assert.equal(out.repoRoot, '/repo', '返回值要能看出这次是照着哪个仓库量的');
  assert.equal(out.limit, 2);
  assert.equal(out.counts.MEASURED, 1);

  const st = svc.status();
  assert.equal(st.outcomeMeasured, 1);
  assert.equal(st.outcomeRefused, 1);
  assert.equal(st.outcomeAttention, 1, '护栏未核的条数必须单独看得见（静默 = 源码树带伤跑一周）');

  // ③ 先验锁再量账：sweep 结果要进返回值与计数器（§2.4.2 归档校验的调用点）
  const swept = [];
  const auditor = {
    sweep: async () => {
      swept.push(1);
      return {
        ok: true, status: 'AUDITED', checked: 3,
        counts: { VERIFIED: 1, CONTRACT_TAMPERED: 1, LOCK_ROW_MISSING: 1 },
        verdicts: [],
        tampered: [{ contractId: 'EVO-T1', status: 'CONTRACT_TAMPERED', storedLock: 'sha256:a', recomputed: 'sha256:b' }],
        orphanPredictions: [{ contractId: 'EVO-T2', seq: 9, predictedDelta: 2 }],
        unverifiable: [],
      };
    },
  };
  const measurer2 = { measurePending: async () => ({ ok: true, scanned: 0, measurable: 0, attempted: 0, deferred: 0, counts: {}, results: [] }) };
  const audited = await svc.measureOutcomes({ repoRoot: '/repo', inject: { measurer: measurer2, auditor } });
  assert.equal(swept.length, 1, 'sweep 在测量之前跑一次');
  assert.equal(audited.audit.checked, 3);
  assert.equal(audited.audit.tampered.length, 1);
  assert.equal(audited.audit.orphanPredictions.length, 1);
  const st2 = svc.status();
  assert.equal(st2.auditChecked, 3);
  assert.equal(st2.auditTampered, 2, '对不上 1 条 + 删行 1 条都算安全事件');
});

// ── T37: classifyFailureKind —— 确定性 vs 偶发（b 的判据层）──────────────
//
// 实机教训：自动执行失败后一律重试，但「定位不到目标 / LLM 判定不适用」这类
// 失败重试也不会变 —— 实机那次两次各 1 秒失败，产出逐字相同。
test('T37: classifyFailureKind 把「重试也不会变」与「偶发」分开', () => {
  assert.equal(classifyFailureKind('c1: no target asset resolved (mentioned:0 inRepo:0)'), 'deterministic');
  assert.equal(classifyFailureKind('c1: llm judged not applicable'), 'deterministic');
  assert.equal(classifyFailureKind('c1: validate rejected — atomicity violated'), 'deterministic');
  assert.equal(classifyFailureKind('c1: oldText not found in target file (hallucination guard)'), 'deterministic');
  assert.equal(classifyFailureKind('c1: llm unavailable: timeout'), 'transient');
  assert.equal(classifyFailureKind('c1: propose threw — ECONNRESET'), 'transient');
  assert.equal(classifyFailureKind('c1: 没见过的一条失败'), 'transient',
    '默认 transient —— 把偶发判成确定 = 提案永远不再自动跑；判错方向不对称');
  assert.equal(classifyFailureKind('c1: construct failed — llm unavailable: read failed'), 'transient',
    '显式 transient 标记优先于 deterministic');
});

// ── T38: 定向执行 ⇒ 确定性不可执行要说出来（b）────────────────────────────
//
// 实机那条 oracle 提案：正文自述「永不 auto-apply；是否执行由老板裁定」，
// 却因为面板默认 immediate 被排进队列 ⇒ driver 定位不到目标 ⇒ 两次各 1 秒失败。
// 定向模式下候选**就是那一条**，跑不出东西 = 这条提案没有可改的目标，
// 不是「暂时没候选」—— 两者混在一起，执行器就会一直重试。
test('T38: 定向执行定位不到目标 ⇒ deterministic=true + not-actionable', async () => {
  const fakeEvolve2 = {
    listProposals: async () => [],
    getProposal: async (id) => ({
      id,
      title: '美谕提案：决策确信度 扣 1.7 分',
      body: '建议：定向复核记忆条目 2d70d577 —— 该条无证据支撑。作为本周唯一候选提交人工复核；不改动、不删除、不自动生效。',
      status: 'approved',
      category: 'doc',
    }),
  };
  const ctx = makeCtx({
    'agint.evolve': fakeEvolve2,
    'agint.mutator': fakeMutator(),
    'agint.population': fakePopulation(),
  });
  apply(ctx);
  const out = await ctx.provided['agint.evolutionDriver'].runForProposal('p-x');
  assert.equal(out.skipped, true);
  assert.equal(out.deterministic, true, '定向模式下的「无可执行目标」是确定性的');
  assert.match(out.reason, /not-actionable/, '原因里要能看出「这不是偶发」');
  assert.match(out.reason, /no target asset resolved/, '也要带上真正的失败细节');
});

// ── T39: sweep 模式保持原语义（以后可能有新候选，不算确定性失败）──────────
test('T39: sweep 模式同样定位不到目标 ⇒ deterministic=false（仍可重试）', async () => {
  const ctx = makeCtx({
    'agint.evolve': fakeEvolve([{ id: 'c1', title: '改点东西', body: '没有目标文件', status: 'proposed', createdAt: '2026-09-01' }]),
    'agint.mutator': fakeMutator(),
    'agint.population': fakePopulation(),
  });
  apply(ctx);
  const out = await ctx.provided['agint.evolutionDriver'].runOnce({
    env: {},
    inject: { skillNames: [], fs: { readSkill: async () => SKILL_TEXT }, llm: GOOD_LLM },
  });
  assert.equal(out.skipped, true);
  assert.equal(out.deterministic, false, 'sweep 模式不等于确定性失败 —— 下一轮可能有新候选');
});

// ── T40: 2026-10-28 三处硬伤（cwd / 超时口径 / 提示词）──────────────────
// 案发：提案 2f91b72b 批准后连续两次 `timeout after 120000ms`。取证结论是
//   ① 孩子会话 cwd=process.cwd()（实机是 `~/桌面`）⇒ 15 次工具调用里 13 次在 ls/find 找仓库；
//   ② 提示只给 20000 字符，而目标 sweep.js 有 96.5KB，模型察觉截断后去读原文件；
//   ③ 120s 闸门在成功后仍会吞掉结果（错误统一成 llm unavailable，根因不可见）。
// 三条都要有用例压住，否则下次重构又会「顺手」退回去。

test('T40a: resolveLlmTimeout —— 默认 600s；env > config；脏值不许把闸门变成 0ms', () => {
  assert.equal(resolveLlmTimeout({}, {}), 600_000, '默认必须是 600s（120s 是实机失败值）');
  assert.equal(resolveLlmTimeout({}, { llmTimeoutMs: 300_000 }), 300_000);
  assert.equal(
    resolveLlmTimeout({ AGINT_EVOLUTION_DRIVER_TIMEOUT_MS: '900000' }, { llmTimeoutMs: 300_000 }),
    900_000,
    'env 优先级高于 patch config（排障时不想改挂载文件）',
  );
  for (const bad of ['', 'abc', '0', '-5', 'NaN', '  ']) {
    assert.equal(
      resolveLlmTimeout({ AGINT_EVOLUTION_DRIVER_TIMEOUT_MS: bad }, {}),
      600_000,
      `脏 env=${JSON.stringify(bad)} 必须回落默认值`,
    );
  }
});

test('T40b: construct —— cwd 显式下发；提示里写清工作目录与「别去找仓库」', async () => {
  const ctx = makeCtx({});
  apply(ctx);
  const svc = ctx.provided['agint.evolutionDriver'];
  let seen = null;
  const out = await svc.construct({
    candidate: { id: 'c1', title: 't', body: '', status: 'proposed' },
    targetId: 'plugins/agint-dream/lib/sweep.js',
    fileText: 'const a = 1;\n',
    cwd: '/repo/root',
    llm: async (args) => { seen = args; return { ok: false, reason: 'stub' }; },
  });
  assert.equal(out.llmFailure, true);
  assert.equal(seen.cwd, '/repo/root', 'cwd 必须传到 spawnLlm，不许它自己回落 process.cwd()');
  assert.equal(seen.timeoutMs, 600_000, '缺省超时走 resolveLlmTimeout（600s）');
  assert.match(seen.user, /## Working directory\n\/repo\/root/, '提示里必须有工作目录');
  assert.match(seen.user, /plugins\/agint-dream\/lib\/sweep\.js/, '提示里必须给出要读的精确相对路径');
  assert.match(seen.user, /Do not search the filesystem/, '必须封住「全盘找仓库」这条路');
  assert.match(seen.user, /structured-output/, '必须要求走结构化输出（否则父侧拿到空结果）');
});

test('T40c: construct —— 未给 cwd 时回落 patch config 的 repoRoot', async () => {
  const ctx = makeCtx({});
  apply(ctx, { repoRoot: '/cfg/root' });
  let seen = null;
  await ctx.provided['agint.evolutionDriver'].construct({
    candidate: { id: 'c1', title: 't', body: '', status: 'proposed' },
    targetId: 'plugins/x/lib/y.js',
    fileText: 'x\n',
    llm: async (args) => { seen = args; return { ok: false, reason: 'stub' }; },
  });
  assert.equal(seen.cwd, '/cfg/root');
});

test('T40d: spawnLlm —— meta.cwd 用传入的 cwd；缺省才回落 process.cwd()', async () => {
  const created = [];
  const ctx = makeCtx({
    agents: {
      create: async (opts) => { created.push(opts); return { agent: {}, dispose: async () => {} }; },
    },
    subagents: {
      getProvider: () => ({ ok: true }),
      startActivation: async () => ({
        result: Promise.resolve({ stopReason: 'completed', structured: { applicable: false } }),
        dispose: async () => {},
      }),
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash', reasoningEffort: 'high' }),
    },
  });
  const r1 = await spawnLlm(ctx, { system: 's', user: 'u', schema: {}, timeoutMs: 1000, cwd: '/repo/root' });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(created[0].meta.cwd, '/repo/root');
  assert.equal(created[0].meta.agentPreset, DEFAULT_AGENT_PRESET, 'preset 不能因为改 cwd 被顺手弄丢');

  await spawnLlm(ctx, { system: 's', user: 'u', schema: {}, timeoutMs: 1000 });
  assert.equal(created[1].meta.cwd, process.cwd(), '没给 cwd 时才回落进程 cwd');
});

// ── T41: excerpt —— 锚点窗口 + 结构大纲（2026-10-28 换掉「从头截断」）────────
// 背景：旧实现是 `fileText.slice(0, 20000)`。锚点落在 20000 字符之后 ⇒ 模型看不到
// 要改的那段，只能判 applicable=false 或先花轮次读文件。合成大文件那一例就是判据。

function bigFile(lines = 8000) {
  return Array.from({ length: lines }, (_, i) => `const pad${i + 1} = ${i + 1}; // filler filler filler`).join('\n');
}

test('T41a: 短文件 ⇒ 原文照给（mode=full），不做任何加工', () => {
  const text = 'export function a() {}\nexport function b() {}\n';
  const ex = buildExcerpt(text, { targetId: 'x.js', anchors: [], budget: 20_000 });
  assert.equal(ex.mode, 'full');
  assert.equal(ex.text, text, '全文模式必须逐字原样，一个字符都不能动');
});

test('T41b: 锚点在 20000 字符之后 —— 旧实现丢、新实现覆盖', () => {
  const text = bigFile(8000); // 约 397KB，8000 行
  const anchorLine = 6000;
  const anchorText = `const pad${anchorLine} = ${anchorLine}; // filler filler filler`;
  assert.equal(text.slice(0, 20_000).includes(anchorText), false, '前提：旧的头截断确实看不到它');

  const ex = buildExcerpt(text, {
    targetId: 'big.js',
    anchors: [{ kind: 'ident', value: `pad${anchorLine}` }],
    budget: 20_000,
  });
  assert.notEqual(ex.mode, 'full');
  assert.equal(ex.text.includes(anchorText), true, '锚点所在行必须在 excerpt 里');
  assert.ok(ex.chars <= 20_000, `excerpt 不许超预算，实际 ${ex.chars}`);
  assert.ok(ex.anchorHits >= 1);
  assert.equal(
    ex.ranges.some(([a, b]) => anchorLine >= a && anchorLine <= b),
    true,
    '区间表要能证明覆盖',
  );
});

test('T41c: 正文逐字 —— 不许给行首加行号（加了 oldText 必挂幻觉闸门）', () => {
  const text = bigFile(3000);
  const ex = buildExcerpt(text, {
    targetId: 'big.js',
    anchors: [{ kind: 'ident', value: 'pad1500' }],
    budget: 20_000,
  });
  const rawLines = new Set(text.split('\n'));
  // excerpt 里除标记行外，每一行都必须能在原文里逐字找到
  const suspicious = ex.text
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('⟪'))
    // 大纲行是 `  1234  decl padX` —— 它们的特征是以空格+数字开头，单独放过
    .filter((l) => !/^\s*\d+\s{2}(decl|#)/.test(l))
    .filter((l) => !rawLines.has(l));
  assert.deepEqual(suspicious, [], '出现无法在原文中逐字匹配的行 ⇒ 说明加了前缀/改了空白');
});

test('T41d: 无锚点命中 ⇒ 退化到大纲 + 头尾，不假装看全了', () => {
  const text = bigFile(3000);
  const ex = buildExcerpt(text, { targetId: 'big.js', anchors: [{ kind: 'ident', value: 'nothing_like_this' }], budget: 20_000 });
  assert.equal(ex.mode, 'outline');
  assert.match(ex.text, /excerpt of big\.js/);
  assert.match(ex.text, /outline \(top-level declarations/);
  assert.ok(ex.ranges.length >= 1, '至少要给头尾');
  assert.ok(ex.chars <= 20_000);
});

test('T41e: extractAnchors —— 只认反引号；`file:line` 变行锚点；太短的扔掉', () => {
  const anchors = extractAnchors(
    '问题在 `collectSessionSignals`（`lib/sweep.js:383`）里，`x` 这种太短的不算，`config.repoRoot` 算。',
  );
  const kinds = anchors.map((a) => `${a.kind}:${a.value}${a.line ? `:${a.line}` : ''}`);
  assert.ok(kinds.includes('ident:collectSessionSignals'), kinds.join(' | '));
  assert.ok(kinds.includes('line:lib/sweep.js:383'), kinds.join(' | '));
  assert.ok(kinds.includes('ident:config.repoRoot'), kinds.join(' | '));
  assert.equal(kinds.some((k) => k.endsWith(':x')), false, '1 个字符的标识符没有定位价值');
});

// ── T42: 目标候选顺序 —— 不再按「路径字符串长度」挑 ────────────────────────
// 案发：846f4fbb 正文有 5 条路径，matchRepoFile 挑**最长**那条，
// 恰好选中提案里写「已修好、不用动」的样板文件 ⇒ 整条提案被判死。

const T42_REPO = [
  'plugins/agint-upstream-watch/test/_stub-storage-domain.mjs', // 58 字符，正文里最先出现，且是最长的
  'plugins/agint-input-gateway/test/_stub-storage-domain.mjs', // 57
  'plugins/agint-evolve/test/_stub-dsh-tools.mjs', // 45
];

test('T42a: 多目标按文档顺序全给出来（旧的单值出口只能看到第一个）', () => {
  const candidate = {
    title: '收紧其余插件的 dsh-tools 测试替身',
    body: [
      '已修好的样板（本次已在 upstream-watch 落地）：`plugins/agint-upstream-watch/test/_stub-storage-domain.mjs`',
      '同类替身还有两处（本次未动）：',
      '- `plugins/agint-evolve/test/_stub-dsh-tools.mjs`',
      '- `plugins/agint-input-gateway/test/_stub-storage-domain.mjs`',
    ].join('\n'),
  };
  const all = resolveTargetAssets(candidate, [], T42_REPO);
  assert.deepEqual(all.map((t) => t.id), [
    'plugins/agint-upstream-watch/test/_stub-storage-domain.mjs',
    'plugins/agint-evolve/test/_stub-dsh-tools.mjs',
    'plugins/agint-input-gateway/test/_stub-storage-domain.mjs',
  ], '顺序必须是正文顺序，不是字符串长度顺序');
  assert.equal(matchRepoFile(extractRepoPaths(candidate.body), T42_REPO),
    'plugins/agint-upstream-watch/test/_stub-storage-domain.mjs',
    '旧的单值匹配确实会挑最长那条 —— 这就是当初选错的机制（保留此断言以免有人把它「优化」回来）');
});

test('T42b: 后缀兜底只在唯一时收；有歧义就丢（改错文件比不改更糟）', () => {
  const unique = resolveTargetAssets({ title: 'x', body: '见 `plugins/agint-evolve/lib/index.js`' }, [],
    ['plugins/agint-evolve/lib/index.js']);
  assert.deepEqual(unique.map((t) => t.id), ['plugins/agint-evolve/lib/index.js']);

  const ambiguous = resolveTargetAssets({ title: 'x', body: '改 `lib/index.js`' }, [],
    ['plugins/a/lib/index.js', 'plugins/b/lib/index.js']);
  assert.deepEqual(ambiguous, [], '两个候选 ⇒ 不猜');
});

// ── T43: 目标遍历 —— 「这个文件不该改」只换下一个，不再判死整条提案 ──────────

test('T43: 第一个目标答 applicable=false ⇒ 继续试第二个并落地（实机 846f4fbb 形状）', async () => {
  const repo = await makeRepo({
    'plugins/agint-upstream-watch/test/_stub-storage-domain.mjs': 'export const STUB_ALREADY_TIGHT = true;\n',
    'plugins/agint-evolve/test/_stub-dsh-tools.mjs':
      'export function defineTool(options) { return { ...options }; }\n',
    'plugins/agint-input-gateway/test/_stub-storage-domain.mjs': 'export function defineTool(desc) { return { ...desc }; }\n',
  });
  const seenPrompts = [];
  const targetOf = (user) => (/^## Target file: (.+)$/m.exec(user)?.[1] ?? '').trim();
  const llm = async ({ user }) => {
    seenPrompts.push(user);
    if (targetOf(user).includes('_stub-storage-domain.mjs')) {
      // 模型对「样板文件」的正确回答：这个文件不该改
      return { ok: true, value: { applicable: false, targetSkill: '', oldText: '', newText: '', rationale: 'already fixed here' } };
    }
    return {
      ok: true,
      value: {
        applicable: true,
        targetSkill: 'plugins/agint-evolve/test/_stub-dsh-tools.mjs',
        oldText: 'export function defineTool(options) { return { ...options }; }',
        newText: 'export function defineTool(options) { if (!options.execute) throw new Error("userExecute"); return { ...options }; }',
        rationale: 'tighten the stub',
      },
    };
  };
  const mutator = fakeMutator();
  const ctx = makeCtx({
    'agint.evolve': {
      listProposals: async () => [],
      getProposal: async (id) => ({
        id,
        title: '收紧其余插件的 dsh-tools 测试替身',
        body: '已修好的样板：`plugins/agint-upstream-watch/test/_stub-storage-domain.mjs`\n' +
          '同类还有：`plugins/agint-evolve/test/_stub-dsh-tools.mjs`\n' +
          '以及：`plugins/agint-input-gateway/test/_stub-storage-domain.mjs`',
        status: 'approved',
        category: 'plugin',
      }),
    },
    'agint.mutator': mutator,
    'agint.population': fakePopulation(),
  });
  apply(ctx, { repoRoot: repo });
  const out = await ctx.provided['agint.evolutionDriver'].runForProposal('p-walk', {
    env: {},
    inject: { skillNames: [], fs: { readSkill: async () => SKILL_TEXT }, llm },
  });

  assert.equal(out.skipped, false, JSON.stringify(out.failures ?? out.reason));
  assert.equal(seenPrompts.length, 2, '第一个目标被否 ⇒ 必须再试一个，且这里只需两次');
  assert.match(seenPrompts[0], /already|_stub-storage-domain/, '第一次问的是样板文件');
  assert.match(seenPrompts[1], /agint-evolve\/test\/_stub-dsh-tools\.mjs/, '第二次问的必须是真的该改的那个');
  assert.match(seenPrompts[1], /## Target 2 of 3/, '提示里要说明这是第几个目标 —— 否则模型会因「提案太大」拒答');
  assert.equal(mutator.calls.propose.length, 1, '只落一条变异，不能把两个目标都提交');
  const landed = mutator.calls.propose[0];
  assert.equal(landed.promptPayload.promptId, 'stub-dsh-tools-mjs',
    '落地的必须是 evolve 那个替身（promptId 由目标文件名 slug 而来；样板文件的 slug 是 stub-storage-domain-mjs）');
  assert.match(landed.promptPayload.newText, /userExecute/, '落地的正文要是「收紧后的替身」那段');
  assert.equal(out.target.id, 'plugins/agint-evolve/test/_stub-dsh-tools.mjs',
    '返回的 target 必须是第二个候选，不是第一个（第一个是样板文件）');

  // v0.9.0：这次「成功」只等于**一个原子单元**落地，不等于提案做完了。
  // 实机 846f4fbb 就是这样被标成 applied 的（3 个单元只落地 1 个，剩余单元无任何记账）。
  assert.ok(out.scope, 'driver 返回必须带范围记账 —— 调用方靠它决定能不能按「已落地」结案');
  assert.equal(out.scope.unitsTotal, 3, '正文解析出 3 个目标文件');
  assert.equal(out.scope.unitsApplied, 1, '只落地了一个单元');
  assert.deepEqual(out.scope.remainingUnits, ['plugins/agint-input-gateway/test/_stub-storage-domain.mjs'],
    'applied 之前被模型否掉的样板不算欠账；applied 之后的那个才是');
  assert.equal(out.scope.complete, false, '还有单元没覆盖 ⇒ 不许按已落地结案');
  assert.match(out.scope.note, /范围记账 1\/3/, 'note 要一眼能读出 1/3，而不是让读的人自己去翻提案正文');
});

test('T43b: 全部目标都否 ⇒ not-actionable，但错误里要列出每个目标的拒因', async () => {
  const repo = await makeRepo({
    'plugins/a/lib/x.js': 'const a = 1;\n',
    'plugins/b/lib/y.js': 'const b = 2;\n',
  });
  const llm = async () => ({
    ok: true,
    value: { applicable: false, targetSkill: '', oldText: '', newText: '', rationale: 'no anchor here' },
  });
  const ctx = makeCtx({
    'agint.evolve': {
      listProposals: async () => [],
      getProposal: async (id) => ({
        id, title: 't', status: 'approved', category: 'plugin',
        body: '见 `plugins/a/lib/x.js` 与 `plugins/b/lib/y.js`',
      }),
    },
    'agint.mutator': fakeMutator(),
    'agint.population': fakePopulation(),
  });
  apply(ctx, { repoRoot: repo });
  const out = await ctx.provided['agint.evolutionDriver'].runForProposal('p-none', {
    env: {},
    inject: { skillNames: [], fs: { readSkill: async () => SKILL_TEXT }, llm },
  });
  assert.equal(out.skipped, true);
  assert.equal(out.deterministic, true, '全部目标都改不动 ⇒ 重试也不会变');
  const joined = JSON.stringify(out);
  assert.match(joined, /plugins\/a\/lib\/x\.js: llm judged not applicable/, '第一个目标的拒因要在');
  assert.match(joined, /plugins\/b\/lib\/y\.js: llm judged not applicable/, '第二个的也要在');
});

// ── T44: 范围记账 —— 「改了一个文件」≠「提案做完了」 ─────────────────────────

test('T44a: 单目标 + 无新建要求 ⇒ complete=true（别把每条正常提案都记成欠账）', () => {
  const s = analyzeProposalScope({
    targets: [{ id: 'plugins/a/lib/x.js' }],
    body: '把 `plugins/a/lib/x.js` 里的常量抽出来。',
    appliedIndex: 0,
  });
  assert.equal(s.unitsTotal, 1);
  assert.equal(s.unitsApplied, 1);
  assert.deepEqual(s.remainingUnits, []);
  assert.equal(s.complete, true);
  assert.match(s.note, /范围记账 1\/1/);
  // ⛔ 阴性对照（这条最容易被写坏）：「抽」字出现在正文里就判 requiresNewAsset
  //    ⇒ 每条提了重构词的提案都会被记成 incomplete ⇒ 面板全是欠账 ⇒ 没人看。
  assert.equal(s.requiresNewAsset, false, '「抽出来」不等于「抽一份共用模块」');
});

test('T44b: applied 之前被否的目标不算欠账（模型当场答过 applicable=false）', () => {
  const s = analyzeProposalScope({
    targets: [{ id: 'sample.js' }, { id: 'real-a.js' }, { id: 'real-b.js' }],
    body: '见 `sample.js` `real-a.js` `real-b.js`',
    appliedIndex: 1,
  });
  assert.equal(s.unitsTotal, 3);
  assert.deepEqual(s.remainingUnits, ['real-b.js'], '排在被落地那个之前的已经被否掉了，不该再计一次欠账');
  assert.equal(s.complete, false);
});

test('T44c: 正文要求抽共用模块 ⇒ 多一个单元，光改一个文件不算完', () => {
  const s = analyzeProposalScope({
    targets: [{ id: 'plugins/a/test/_stub-tools.mjs' }],
    body: '先抽一份共用的替身（`plugins/_shared/test-stub-dsh-tools.mjs`），再逐个迁。\n改 `plugins/a/test/_stub-tools.mjs`。',
    appliedIndex: 0,
  });
  assert.equal(s.requiresNewAsset, true, '正文同时提到「抽一份共用」与共用地路径 ⇒ 必须判为真');
  assert.equal(s.unitsTotal, 2, '1 个目标文件 + 1 个待新建资产');
  assert.equal(s.complete, false, '即使所有目标文件都改了，共用模块没建 ⇒ 提案仍没做完');
  assert.match(s.reason, /抽共用模块|共用目录路径/);
});

test('T44d: 一个单元都没落地 ⇒ unitsApplied=0 且 complete=false', () => {
  const s = analyzeProposalScope({
    targets: [{ id: 'a.js' }],
    body: '见 `a.js`',
    appliedIndex: -1,
  });
  assert.equal(s.unitsApplied, 0);
  assert.deepEqual(s.remainingUnits, ['a.js']);
  assert.equal(s.complete, false);
});

test('T44e: 846f4fbb 实机形状 —— 只改 evolve 替身时必须留下另外两个单元的欠账', () => {
  const s = analyzeProposalScope({
    targets: [
      { id: 'plugins/agint-upstream-watch/test/_stub-storage-domain.mjs' },
      { id: 'plugins/agint-evolve/test/_stub-dsh-tools.mjs' },
      { id: 'plugins/agint-input-gateway/test/_stub-storage-domain.mjs' },
    ],
    body: '把替身抽一份共用的（`plugins/_shared/test-stub-dsh-tools.mjs`），'
      + '逐个迁 agint-evolve 与 agint-input-gateway 的替身，并加真调断言。',
    appliedIndex: 1,
  });
  assert.equal(s.unitsTotal, 4, '3 个目标文件 + 1 个待新建的共用模块');
  assert.equal(s.unitsApplied, 1);
  assert.deepEqual(s.remainingUnits, ['plugins/agint-input-gateway/test/_stub-storage-domain.mjs']);
  assert.equal(s.complete, false);
  assert.match(s.note, /范围记账 1\/4/);
});

test('T44f: 执行一次下来 partialScope 计数器随「部分覆盖」增加（假的已完成要能被数出来）', async () => {
  const repo = await makeRepo({
    'plugins/a/lib/x.js': 'const v = 1;\n',
    'plugins/b/lib/y.js': 'const v = 2;\n',
    'plugins/c/lib/z.js': 'const v = 3;\n',
  });
  const llm = async ({ user }) => (/## Target file: .*x\.js/m.test(user)
    ? { ok: true, value: { applicable: false, targetSkill: '', oldText: '', newText: '', rationale: 'not this one' } }
    : {
      ok: true,
      value: { applicable: true, targetSkill: '', oldText: 'const v = 2;', newText: 'const v = 22;', rationale: 'ok' },
    });
  const ctx = makeCtx({
    'agint.evolve': {
      listProposals: async () => [],
      getProposal: async (id) => ({
        id, title: 't', status: 'approved', category: 'plugin',
        body: '见 `plugins/a/lib/x.js`、`plugins/b/lib/y.js` 与 `plugins/c/lib/z.js`',
      }),
    },
    'agint.mutator': fakeMutator(),
    'agint.population': fakePopulation(),
  });
  apply(ctx, { repoRoot: repo });
  const svc = ctx.provided['agint.evolutionDriver'];
  await svc.runForProposal('p-partial', {
    env: {},
    inject: { skillNames: [], fs: { readSkill: async () => SKILL_TEXT }, llm },
  });
  assert.equal(svc.status().partialScope, 1,
    'status() 是成功路径唯一的结构化出口 —— 累计的部分覆盖次数必须从这里读得到');
});

console.log('\nagint-evolution-driver smoke: 全部用例通过（T1–T44）');
