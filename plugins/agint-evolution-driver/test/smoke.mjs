import test from 'node:test';
import assert from 'node:assert/strict';

import {
  apply,
  isDisabled,
  isCommitEnabled,
  resolveTargetSkill,
  resolveTargetAsset,
  extractRepoPaths,
  resolveRepoRoot,
  commitToRepo,
  anchorExists,
  slugifyPromptId,
  pickCandidate,
  spawnLlm,
  DEFAULT_AGENT_PRESET,
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
  // ⛔ 契约：`agint.eventBus.publish` 是**单参数** (input) => publish(busCtx, input)，
  // input = { topic, source, payload }。2026-09-27 三参数调用被静默丢弃过一轮，
  // 这里按真实签名实现：传错形态 input.topic 会是 undefined，用例立刻变红。
  ctx.services['agint.eventBus.publish'] = async (input) => {
    out.push({ topic: input?.topic, source: input?.source, payload: input?.payload });
    return { accepted: typeof input?.topic === 'string' && typeof input?.source === 'string' };
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
test('T25: repo 目标全链路，commit 默认开且发 committed 事件', async () => {
  const SKILL_TEXT = '# demo\nhello world\n';
  const calls = [];
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
  const fakePopulation = { ingest: async () => ({ variant_id: 'v1', policy_decision: 'ALLOW', stage: 'shadow' }) };
  const agents = { create: async () => { throw new Error('should not spawn (llm injected)'); } };
  const subagents = { start: async () => { throw new Error('should not spawn (llm injected)'); } };

  const ctx = makeCtx({
    'agint.evolve': fakeEvolve,
    'agint.mutator': fakeMutator,
    'agint.population': fakePopulation,
    agents,
    subagents,
  });
  const events = busRecorder(ctx);
  apply(ctx, { repoRoot: '/fake/repo' });
  const out = await ctx.provided['agint.evolutionDriver'].runOnce({
    env: {},
    inject: {
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
      fs: {
        scanRepo: async () => ['lib/service.js', 'README.md'],
        readRepo: async (p) => (p === 'lib/service.js' ? 'hello world\n' : null),
        writeRepo: async (p, text) => {
          calls.push(['write', p, text]);
        },
      },
    },
  });
  assert.equal(out.skipped, false);
  assert.deepEqual(out.target, { type: 'repo', id: 'lib/service.js' });
  // v0.2.3 起 promptId 走 slugifyPromptId（mutator 正则要求 kebab slug）
  assert.deepEqual(calls[0], ['propose', 'service-js']);
  assert.equal(calls[1][0], 'write');
  assert.equal(calls[1][2], 'hello AGINT world\n');
  const topics = events.map((e) => e.topic);
  assert.ok(topics.includes('evolution.mutation.proposed'));
  assert.ok(topics.includes('evolution.mutation.committed'));
  const committed = events.find((e) => e.topic === 'evolution.mutation.committed');
  assert.equal(committed.payload.path, 'lib/service.js');
  assert.equal(committed.payload.proposalId, 'p1');
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

console.log('\nagint-evolution-driver smoke: 全部用例通过（T1–T29）');
