/**
 * agint-aesthetic-oracle §8.1 LLM 输出层测试（v0.7 无降级）。
 *
 * 覆盖：
 *   宿主契约：startActivation 优先、旧 start 兼容、三种病因分开报
 *   超时双保险：result 永不落地也能返回、dispose 必跑
 *   无降级：L1/L2/L3 失败抛 OracleLlmError（不再返回 heuristic-degraded）
 *   内容闸门：无 advice / 无 auditIds / 无 body 返回 skipped，不调用 LLM
 *   topics schema：只允许 template / llm
 *
 * 不依赖真 LLM：全部走假 ctx。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OracleLlmError, spawnOracleLlm,
  l1EnhanceAdvice, l2DeepDive, l3PolishProposal,
} from '../lib/llm-enhance.js';

const SELECTION = { provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' };

/** 造一个最小假宿主。startActivation 可替换；subagents 传 null = 服务缺席。 */
function makeCtx({
  result = { stopReason: 'completed', structured: { advice: 'a', evidence: 'e' } },
  startActivation = null,
  subagents = undefined,
  agents = undefined,
  selection = SELECTION,
  onCreate = null,
} = {}) {
  const calls = { activation: [], legacy: [], create: [] };
  const defaultActivation = async (spec) => {
    calls.activation.push(spec);
    return {
      childId: 'child-1',
      result: Promise.resolve(typeof result === 'function' ? result(spec) : result),
      dispose: async () => { calls.childDisposed = true; },
    };
  };
  const subagentSvc = subagents === undefined
    ? {
      getProvider: () => ({ name: 'spawn' }),
      startActivation: startActivation ?? defaultActivation,
    }
    : subagents;
  const agentsSvc = agents === undefined
    ? {
      create: async (opts) => {
        calls.create.push(opts);
        onCreate?.();
        return { agent: { id: 'parent-1' }, dispose: async () => { calls.parentDisposed = true; } };
      },
    }
    : agents;
  const ctx = {
    get(k) {
      if (k === 'agents') return agentsSvc;
      if (k === 'subagents') return subagentSvc;
      if (k === 'agentDefaultModel') return selection === null ? null : { currentSelection: () => selection };
      return null;
    },
  };
  return { ctx, calls };
}

const baseArgs = {
  system: 'sys',
  user: 'usr',
  schema: { type: 'object', additionalProperties: false, required: ['advice'], properties: { advice: { type: 'string' } } },
  timeoutMs: 1000,
  label: 'test-label',
};

// ── 宿主契约 ────────────────────────────────────────────────────────────────

test('spawnOracleLlm: 优先 startActivation，request 带 parent/preset/model/outputSchema', async () => {
  const { ctx, calls } = makeCtx();
  const r = await spawnOracleLlm(ctx, baseArgs);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { advice: 'a', evidence: 'e' });

  assert.equal(calls.activation.length, 1);
  const spec = calls.activation[0];
  assert.equal(spec.provider, 'spawn');
  assert.equal(spec.label, 'test-label');
  assert.equal(spec.delivery, 'caller');
  assert.ok(spec.signal instanceof AbortSignal);
  assert.equal(spec.request.parent.id, 'parent-1');
  assert.equal(spec.request.agentPreset, 'agint');
  assert.deepEqual(spec.request.agentOptions, SELECTION);
  assert.equal(spec.request.outputSchema, baseArgs.schema);
  assert.deepEqual(spec.request.prompt, [{ type: 'text', text: 'sys\n\nusr' }]);

  // parent agent 也必须带 preset + 同一路由（空壳会话 + MiniMax 400 的旧坑）
  assert.equal(calls.create[0].meta.agentPreset, 'agint');
  assert.deepEqual(calls.create[0].agentOptions, SELECTION);
  assert.equal(calls.parentDisposed, true, 'parent handle 必须 dispose');
  assert.equal(calls.childDisposed, true, 'activation 必须 dispose');
});

test('spawnOracleLlm: 旧宿主只有 start() 时走兼容分支', async () => {
  const { ctx, calls } = makeCtx({
    subagents: {
      getProvider: () => ({ name: 'spawn' }),
      start: async (provider, spec) => {
        calls.legacy.push({ provider, spec });
        return { result: Promise.resolve({ stopReason: 'completed', structured: { advice: 'legacy' } }), dispose: async () => {} };
      },
    },
  });
  const r = await spawnOracleLlm(ctx, baseArgs);
  assert.equal(r.ok, true);
  assert.equal(r.value.advice, 'legacy');
  assert.equal(calls.legacy.length, 1);
  assert.equal(calls.legacy[0].provider, 'spawn');
  assert.equal(calls.legacy[0].spec.label, 'test-label');
  assert.equal(calls.legacy[0].spec.outputSchema, baseArgs.schema);
});

test('spawnOracleLlm: service/method/provider 三种病因分开报，不再一句“不可用”', async () => {
  const noAgents = await spawnOracleLlm({ get: (k) => (k === 'subagents' ? {} : null) }, baseArgs);
  assert.match(noAgents.reason, /agents service missing/);

  const noSubagents = await spawnOracleLlm({ get: (k) => (k === 'agents' ? { create: async () => ({}) } : null) }, baseArgs);
  assert.match(noSubagents.reason, /subagents service missing/);

  const noMethod = await spawnOracleLlm({
    get: (k) => (k === 'agents' ? { create: async () => ({ agent: {} }) } : k === 'subagents' ? {} : null),
  }, baseArgs);
  assert.match(noMethod.reason, /subagents method missing \(startActivation=false, start=false\)/);

  const noProvider = await spawnOracleLlm({
    get: (k) => {
      if (k === 'agents') return { create: async () => ({ agent: {} }) };
      if (k === 'subagents') return { getProvider: () => null, startActivation: async () => ({}) };
      return null;
    },
  }, baseArgs);
  assert.match(noProvider.reason, /spawn provider not registered/);
});

test('spawnOracleLlm: result 永不落地时由 timeoutGuard 返回，且 activation 被 dispose', async () => {
  const never = new Promise(() => {});
  const { ctx, calls } = makeCtx({
    startActivation: async (spec) => {
      calls.activation.push(spec);
      return { childId: 'child-hang', result: never, dispose: async () => { calls.childDisposed = true; } };
    },
  });
  const t0 = Date.now();
  const r = await spawnOracleLlm(ctx, { ...baseArgs, timeoutMs: 30 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /timeout after 30ms/);
  assert.ok(Date.now() - t0 < 1000, '超时必须及时返回');
  assert.equal(calls.childDisposed, true, '超时也必须 dispose');
  assert.equal(calls.parentDisposed, true);
});

test('spawnOracleLlm: stopReason 非 completed / structured 缺失都算失败', async () => {
  const badStop = makeCtx({ result: { stopReason: 'error', diagnostic: 'boom' } });
  const r1 = await spawnOracleLlm(badStop.ctx, baseArgs);
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /stopReason=error \(boom\)/);

  const noStructured = makeCtx({ result: { stopReason: 'completed' } });
  const r2 = await spawnOracleLlm(noStructured.ctx, baseArgs);
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /structured output missing/);
});

// ── L1 / L2 / L3：成功与无降级失败 ─────────────────────────────────────────

test('l1EnhanceAdvice: 成功返回 mode=llm', async () => {
  const { ctx } = makeCtx({ result: { stopReason: 'completed', structured: { advice: '人话建议', evidence: '人话证据' } } });
  const r = await l1EnhanceAdvice(ctx, {
    templateAdvice: '机械建议', templateEvidence: '机械证据', worstKey: 'noise', value: 0.2,
  });
  assert.deepEqual(r, { mode: 'llm', advice: '人话建议', evidence: '人话证据' });
});

test('l1EnhanceAdvice: LLM 不可用抛 OracleLlmError，不回落模板', async () => {
  await assert.rejects(
    l1EnhanceAdvice({ get: () => null }, {
      templateAdvice: '机械建议', templateEvidence: '机械证据', worstKey: 'noise', value: 0.2,
    }),
    (err) => err instanceof OracleLlmError
      && err.code === 'ORACLE_LLM_UNAVAILABLE'
      && err.stage === 'L1'
      && /agents service missing/.test(err.message),
  );
});

test('l1EnhanceAdvice: 空 templateAdvice 是内容闸门，返回 skipped 且不调 LLM', async () => {
  const { ctx, calls } = makeCtx();
  const r = await l1EnhanceAdvice(ctx, {
    templateAdvice: '', templateEvidence: '', worstKey: 'noise', value: 0.2,
  });
  assert.equal(r.mode, 'skipped');
  assert.equal(calls.activation.length, 0);
});

test('l1EnhanceAdvice: 结构化输出为空也抛错（不拿模板顶替）', async () => {
  const { ctx } = makeCtx({ result: { stopReason: 'completed', structured: { advice: ' ', evidence: '' } } });
  await assert.rejects(
    l1EnhanceAdvice(ctx, { templateAdvice: '建议', templateEvidence: '证据', worstKey: 'noise', value: 0.2 }),
    /L1: structured output has empty advice\/evidence/,
  );
});

test('l2DeepDive: 无 auditIds 返回 skipped，不调 LLM', async () => {
  const { ctx, calls } = makeCtx();
  const r = await l2DeepDive(ctx, {
    worstKey: 'noise', value: 0.232, threshold: 0.30, auditIds: [], adviceCtx: {},
  });
  assert.equal(r.mode, 'skipped');
  assert.match(r.reason, /no auditIds/);
  assert.equal(calls.activation.length, 0);
});

test('l2DeepDive: 成功返回 mode=llm；失败抛 OracleLlmError(L2)', async () => {
  const ok = makeCtx({ result: { stopReason: 'completed', structured: { narrative: '行级归因', pattern: '旧决策堆积' } } });
  const r = await l2DeepDive(ok.ctx, {
    worstKey: 'noise', value: 0.232, threshold: 0.30, auditIds: ['mem-0', 'mem-1'], adviceCtx: {},
  });
  assert.deepEqual(r, { mode: 'llm', narrative: '行级归因', pattern: '旧决策堆积' });

  const bad = makeCtx({ result: { stopReason: 'error', diagnostic: 'down' } });
  await assert.rejects(
    l2DeepDive(bad.ctx, { worstKey: 'noise', value: 0.232, threshold: 0.30, auditIds: ['mem-0'], adviceCtx: {} }),
    (err) => err instanceof OracleLlmError && err.stage === 'L2',
  );
});

test('l3PolishProposal: 成功返回 mode=llm；失败抛 OracleLlmError(L3)', async () => {
  const ok = makeCtx({ result: { stopReason: 'completed', structured: { body: '润色后的正文' } } });
  const r = await l3PolishProposal(ok.ctx, { title: 't', templateBody: '模板正文', deepDive: {} });
  assert.deepEqual(r, { mode: 'llm', body: '润色后的正文' });

  const bad = makeCtx({ result: { stopReason: 'error' } });
  await assert.rejects(
    l3PolishProposal(bad.ctx, { title: 't', templateBody: '模板正文' }),
    (err) => err instanceof OracleLlmError && err.stage === 'L3',
  );
});

test('l3PolishProposal: 空模板正文直接抛错（不写空提案）', async () => {
  const { ctx, calls } = makeCtx();
  await assert.rejects(
    l3PolishProposal(ctx, { title: 't', templateBody: '' }),
    /L3: template body missing/,
  );
  assert.equal(calls.activation.length, 0);
});

// ── topics schema：不再接受 heuristic-degraded ──────────────────────────────

test('topics schema: mode 缺省 = template；llm 合法；heuristic-degraded 拒收', async () => {
  const { validateTopicPayload } = await import('../lib/topics.js');
  const base = {
    kind: 'daily', asOf: '2026-09-29T00:00:00Z', score: 52.4,
    verdict: 'flat', worstKey: 'noise', lines: ['a', 'b'], text: 'a\nb',
  };
  assert.equal(validateTopicPayload('oracle.daily', base).ok, true);
  assert.equal(validateTopicPayload('oracle.daily', { ...base, mode: 'llm' }).ok, true);
  assert.equal(validateTopicPayload('oracle.daily', { ...base, mode: 'template' }).ok, true);
  assert.equal(validateTopicPayload('oracle.daily', { ...base, mode: 'heuristic-degraded' }).ok, false);
});
