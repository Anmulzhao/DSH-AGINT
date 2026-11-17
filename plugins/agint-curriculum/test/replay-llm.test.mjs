/**
 * 方案 3 LLM 语义判据测试（提案 10d2d87f 选项 2 拍板，2026-11-18）。
 * 全部走 mock agents/subagents，不调真模型（不碰 network、不依赖宿主）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReplayPrompt,
  normalizeLlmVerdict,
  spawnReplayLlm,
  judgeReplayWithLlm,
  REPLAY_OUTPUT_SCHEMA,
  MAX_HISTORY_IN_PROMPT,
} from '../lib/replay-llm.js';
import { ConfigSchema } from '../lib/schema.js';
import * as plugin from '../lib/index.js';
import { mockCtx, makeSnapshot, makeCapability } from './_helpers.mjs';

const SNAP = makeSnapshot([makeCapability('integration', 'UNCERTAIN', { lastVerifiedAt: '2026-08-01T00:00:00Z' })]);

const HISTORY = [
  { id: 'a1', challengeId: 'c1', domain: 'integration', level: 'D1', prompt: '把表单调用 API 拆解成步骤', evidence: { steps: ['先发请求', '再处理错误', '最后重试'] }, verifiedAt: '2026-11-01T00:00:00.000Z' },
  { id: 'a2', challengeId: 'c2', domain: 'planning', level: 'D2', prompt: '规划一次发布', evidence: { steps: ['列清单', '排顺序', '执行'] }, verifiedAt: '2026-11-02T00:00:00.000Z' },
];

// ── 纯函数层 ────────────────────────────────────────────────────────────

test('schema 是宿主受限子集：无 minimum/pattern/maxLength', () => {
  const s = JSON.stringify(REPLAY_OUTPUT_SCHEMA);
  for (const bad of ['minimum', 'maximum', 'pattern', 'maxLength', 'minLength']) {
    assert.equal(s.includes(`"${bad}"`), false, `${bad} 不应出现在 output schema`);
  }
  assert.equal(REPLAY_OUTPUT_SCHEMA.properties.confidence.type, 'string');
  assert.ok(Array.isArray(REPLAY_OUTPUT_SCHEMA.properties.confidence.enum));
});

test('buildReplayPrompt 带当前题面+步骤+历史编号，且截断到预算', () => {
  const { user, history } = buildReplayPrompt({
    challenge: { prompt: '当前题面X' },
    evidence: { steps: ['第一步', '第二步'] },
    priorPasses: HISTORY,
  });
  assert.match(user, /当前题面X/);
  assert.match(user, /第一步/);
  assert.match(user, /1\. 题面：把表单调用 API/);
  assert.equal(history.length, 2);
  const many = Array.from({ length: 10 }, (_, i) => ({ ...HISTORY[0], id: `a${i}` }));
  assert.equal(buildReplayPrompt({ priorPasses: many }).history.length, MAX_HISTORY_IN_PROMPT);
});

test('normalizeLlmVerdict：高置信等价 → 回放；低置信/不等价 → 不回放', () => {
  const high = normalizeLlmVerdict({ isEquivalent: true, confidence: 'high', rationale: '同义改写', matchedIndex: '1' });
  assert.equal(high.accepted, true);
  assert.equal(high.isReplay, true);
  assert.equal(high.matchedIndex, '1');

  const low = normalizeLlmVerdict({ isEquivalent: true, confidence: 'low', rationale: '也许', matchedIndex: '1' });
  assert.equal(low.accepted, false);
  assert.equal(low.isReplay, false, '低置信不升级为回放（避免误杀）');

  const notEq = normalizeLlmVerdict({ isEquivalent: false, confidence: 'high', rationale: '不同解法', matchedIndex: 'none' });
  assert.equal(notEq.isReplay, false);

  const garbage = normalizeLlmVerdict({ isEquivalent: true, confidence: 'high', matchedIndex: '99' });
  assert.equal(garbage.matchedIndex, null, '非法 matchedIndex 归一化掉');
});

test('normalizeLlmVerdict：threshold=medium 时 medium 也接受', () => {
  const r = normalizeLlmVerdict({ isEquivalent: true, confidence: 'medium', matchedIndex: '2' }, 'medium');
  assert.equal(r.isReplay, true);
});

// ── 调用层：mock agents/subagents ────────────────────────────────────────

function mockLlmCtx(structured, { stopReason = 'completed', createError = null } = {}) {
  const disposals = [];
  const agent = { id: 'agent-x' };
  const agents = {
    create: async () => {
      if (createError) throw new Error(createError);
      return { agent, dispose: async () => { disposals.push('handle'); } };
    },
  };
  const subagents = {
    getProvider: () => ({ kind: 'spawn' }),
    startActivation: async (spec) => {
      assert.equal(spec.parent, agent, 'parent 必须是 handle.agent');
      assert.equal(spec.delivery, 'caller', 'delivery=caller');
      assert.ok(spec.agentPreset, 'agentPreset 不能省');
      assert.ok(spec.agentOptions?.model, 'agentOptions.model 不能省');
      assert.equal(spec.outputSchema, REPLAY_OUTPUT_SCHEMA);
      return {
        result: Promise.resolve({ stopReason, structured }),
        dispose: async () => { disposals.push('activation'); },
      };
    },
  };
  return { ctx: mockCtx({ agents, subagents }), disposals };
}

test('spawnReplayLlm：completed + structured → ok:true；资源被 dispose', async () => {
  const { ctx, disposals } = mockLlmCtx({ isEquivalent: true, confidence: 'high', rationale: 'r', matchedIndex: '1' });
  const r = await spawnReplayLlm(ctx, { system: 's', user: 'u', timeoutMs: 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.value.isEquivalent, true);
  await new Promise((res) => setTimeout(res, 0));
  assert.ok(disposals.includes('handle') && disposals.includes('activation'), 'handle+activation 都 dispose');
});

test('spawnReplayLlm：无 agents 服务 → 降级 ok:false，不抛', async () => {
  const r = await spawnReplayLlm(mockCtx(), { system: 's', user: 'u' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /agents service missing/);
});

test('spawnReplayLlm：stopReason!=completed → 降级 ok:false', async () => {
  const { ctx } = mockLlmCtx(undefined, { stopReason: 'error' });
  const r = await spawnReplayLlm(ctx, { system: 's', user: 'u' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /stopReason=error/);
});

test('judgeReplayWithLlm：等价高置信 → isReplay + 映射 matchedAttemptId', async () => {
  const { ctx } = mockLlmCtx({ isEquivalent: true, confidence: 'high', rationale: '换说法但同一套步骤', matchedIndex: '1' });
  const r = await judgeReplayWithLlm(ctx, {
    challenge: { prompt: '当前题面X' },
    evidence: { steps: ['再次发请求', '处理异常', '重试一次'] },
    priorPasses: HISTORY,
  });
  assert.equal(r.called, true);
  assert.equal(r.ok, true);
  assert.equal(r.isReplay, true);
  assert.equal(r.matchedAttemptId, 'a1');
});

test('judgeReplayWithLlm：服务缺失 → 降级 isReplay=false 且不抛', async () => {
  const r = await judgeReplayWithLlm(mockCtx(), {
    challenge: { prompt: 'X' }, evidence: { steps: ['a', 'b'] }, priorPasses: HISTORY,
  });
  assert.equal(r.ok, false);
  assert.equal(r.isReplay, false);
  assert.ok(r.reason);
});

test('judgeReplayWithLlm：enabled=false → 不调用（called=false）', async () => {
  const r = await judgeReplayWithLlm(mockCtx(), {
    challenge: {}, evidence: {}, priorPasses: HISTORY, config: { enabled: false },
  });
  assert.equal(r.called, false);
  assert.equal(r.reason, 'disabled');
});

// ── 配置默认值 ──────────────────────────────────────────────────────────

test('ConfigSchema：replay_llm 默认 true，可关闭回退零 LLM', () => {
  assert.equal(ConfigSchema.parse({}).replay_llm, true);
  assert.equal(ConfigSchema.parse({}).replay_llm_min_confidence, 'high');
  assert.equal(ConfigSchema.parse({ replay_llm: false }).replay_llm, false);
});

// ── 集成：submit 路径在确定性未命中时调 LLM 并升级 replay ────────────────

function bootWithLlm(structured, cfg = {}) {
  const { ctx } = mockLlmCtx(structured);
  const full = mockCtx({
    'agint.selfModel': {
      snapshot: async () => SNAP,
      update: async () => ({ ok: true, updatedDomains: [] }),
    },
    'agint.eventBus.publish': async () => ({ ok: true }),
  });
  // 把 LLM mock 服务合进 full.ctx 的 services（通过覆盖 get）
  const origGet = full.get;
  full.get = (k) => (ctx.get(k) ?? origGet(k));
  plugin.apply(full, cfg);
  return { svc: full._provided['agint.curriculum'] };
}

test('集成：两道不同题面的 pass，LLM 判语义等价 → 第 2 次 replay=llm-equivalent 且不计成功', async () => {
  // 关掉确定性 prompt 去重与指纹， isolating 方案 3 效果
  const { svc } = bootWithLlm(
    { isEquivalent: true, confidence: 'high', rationale: '两步是同一解法的换说法', matchedIndex: '1' },
    { replay_fingerprint: false, replay_prompt_dedup: false },
  );
  await svc.config({ challenge_cooldown_hours: 0, dedup_window_days: 0 });
  await svc.generate({ domain: 'integration', force: true });
  await svc.generate({ domain: 'integration', force: true });
  const list = (await svc.list({ domain: 'integration' }));
  assert.ok(list.length >= 2, `需要 2 道题，实际 ${list.length}`);
  // 两次 steps 语义等价（换说法），但含 integration D1 必需关键词「请求」「错误」以确保 judge=pass
  const stepsA = ['先发请求拿到数据', '再处理错误分支', '最后兜底重试'];
  const stepsB = ['发起请求并取得结果', '随后处理异常错误', '最终执行兜底重试'];
  const first = await svc.submit({ challengeId: list[0].id, evidence: { steps: stepsA } });
  assert.equal(first.result, 'pass');
  assert.equal(first.replay, false, '首 pass 无历史可比，不回放');
  const second = await svc.submit({ challengeId: list[1].id, evidence: { steps: stepsB } });
  assert.equal(second.result, 'pass');
  assert.equal(second.replay, true, 'LLM 判等价 → 升级回放');
  assert.equal(second.replayKind, 'llm-equivalent');
  assert.equal(second.countedForSuccess, false, '不计能力成功');
  assert.equal(second.replayLlm?.isReplay, true);
});

test('集成：replay_llm=false → 不调 LLM，换说法双 pass 都计成功', async () => {
  const { svc } = bootWithLlm(
    { isEquivalent: true, confidence: 'high', rationale: 'x', matchedIndex: '1' },
    { replay_fingerprint: false, replay_prompt_dedup: false, replay_llm: false },
  );
  await svc.config({ challenge_cooldown_hours: 0, dedup_window_days: 0 });
  await svc.generate({ domain: 'integration', force: true });
  await svc.generate({ domain: 'integration', force: true });
  const pool = (await svc.list({ domain: 'integration' }));
  assert.ok(pool.length >= 2, `需要 2 道题，实际 ${pool.length}`);
  const first = await svc.submit({ challengeId: pool[0].id, evidence: { steps: ['先发请求拿到数据', '再处理错误分支', '最后兜底重试'] } });
  const second = await svc.submit({ challengeId: pool[1].id, evidence: { steps: ['发起请求并取得结果', '随后处理异常错误', '最终执行兜底重试'] } });
  assert.equal(first.result, 'pass');
  assert.equal(second.result, 'pass');
  assert.equal(first.replay, false);
  assert.equal(second.replay, false, 'LLM 关闭 → 不升级回放');
  assert.equal(second.countedForSuccess, true);
});
