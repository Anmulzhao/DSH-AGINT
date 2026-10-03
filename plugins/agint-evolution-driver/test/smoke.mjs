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
  resolveRepoRoot,
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
} from '../lib/index.js';

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

/** 假 agents/subagents，记录 create 的参数与 start 的返回 */
function fakeRuntime({ result = { stopReason: 'completed', structured: { applicable: false } } } = {}) {
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
    start: async (name, request) => {
      started.push({ name, request });
      return { result: Promise.resolve(result), dispose: async () => {} };
    },
  };
  return { agents, subagents, created, started };
}

test('T17: agents.create 必须带 meta.agentPreset —— 缺了 child 就没有模型路由', async () => {
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
});

test('T19b: provider/model 优先取自宿主服务 agentDefaultModel（不硬编码模型名）', async () => {
  const rt = fakeRuntime();
  const ctx = makeCtx({
    agents: rt.agents,
    subagents: rt.subagents,
    agentDefaultModel: { currentSelection: () => ({ provider: 'host-provider', model: 'Host-Model' }) },
  });
  await spawnLlm(ctx, { system: 's', user: 'u', schema: { type: 'object' } });
  const opts = rt.created[0].agentOptions;
  assert.equal(opts.provider, 'host-provider', '应用宿主默认 provider');
  assert.equal(opts.model, 'Host-Model', '应用宿主默认 model');
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
    const fakeMutator = {
      propose: async (input) => {
        calls.push(['propose', input.promptPayload.promptId]);
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

console.log('\nagint-evolution-driver smoke: 全部用例通过（T1–T35）');
