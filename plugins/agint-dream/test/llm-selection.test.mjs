// LLM 模型选择单一真源：agint-dream P1 consolidation 契约测试（2026-11-15）。
//
// 2026-11-15 前本插件只把「推理档位」接了宿主，provider/model 仍落死常量 ——
// 宿主换模型时 P1 会毫无报错地继续调旧 id。这里锁死两处：
//   ① resolveLlmSelection 三段式优先级
//   ② **端到端**：consolidate() 交给宿主的 agentOptions.provider/model 来自宿主选择
//
// 全程 mock ctx，不调真模型、不依赖网络。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveLlmSelection,
  consolidate,
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
} from '../lib/consolidation.js';

const HOST = { provider: 'host-provider', model: 'Host-Model', reasoningEffort: 'xhigh' };
const GATED = [{ key: 'k1', type: 'fact', text: '一条候选记忆', score: 0.8 }];

function fakeCtx(selection = null) {
  const created = [];
  const started = [];
  const agents = {
    create: async (opts) => {
      created.push(opts);
      return { agent: { id: 'mock-agent' }, dispose: async () => {} };
    },
  };
  const subagents = {
    getProvider: () => ({ name: 'spawn' }),
    startActivation: async (spec) => {
      started.push(spec);
      return {
        childId: 'mock-child',
        result: Promise.resolve({ stopReason: 'error', output: [] }),
        dispose: async () => {},
      };
    },
  };
  const services = {
    agents,
    subagents,
    agentDefaultModel: selection === null ? null : { currentSelection: () => selection },
  };
  return { ctx: { get: (k) => services[k] ?? null }, created, started };
}

test('resolveLlmSelection：显式 > 宿主选择 > 兜底常量', () => {
  const { ctx } = fakeCtx(HOST);
  assert.deepEqual(resolveLlmSelection(ctx, {}), {
    provider: HOST.provider, model: HOST.model, source: 'host',
  });
  assert.equal(resolveLlmSelection(ctx, { provider: 'p', model: 'M' }).model, 'M');
  const { ctx: noHost } = fakeCtx(null);
  assert.deepEqual(resolveLlmSelection(noHost, {}), {
    provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL, source: 'fallback',
  });
});

test('resolveLlmSelection：宿主取值抛错 ⇒ 兜底', () => {
  const ctx = { get: () => ({ currentSelection: () => { throw new Error('gone'); } }) };
  assert.equal(resolveLlmSelection(ctx, {}).source, 'fallback');
});

test('consolidate：provider/model 与档位都跟随宿主当前选择', async () => {
  const { ctx, created, started } = fakeCtx(HOST);
  const out = await consolidate({ ctx, gated: GATED, existing: [], day: 'd', provider: '', model: '' });
  assert.equal(created.length, 1);
  assert.equal(created[0].agentOptions.provider, HOST.provider);
  assert.equal(created[0].agentOptions.model, HOST.model);
  assert.equal(created[0].agentOptions.reasoningEffort, HOST.reasoningEffort);
  assert.equal(started[0].agentOptions.model, HOST.model);
  assert.equal(started[0].request, undefined, '宿主 0.2.2-rc.1 起不再接受嵌套 request');
  assert.equal(out.ok, false, 'stopReason=error 必须 failed，不许回落启发式');
});

test('consolidate：显式指定模型优先；宿主缺席行为不变', async () => {
  const { ctx: explicit, created: c1 } = fakeCtx(HOST);
  await consolidate({ ctx: explicit, gated: GATED, existing: [], day: 'd', provider: 'explicit-p', model: 'Explicit-M' });
  assert.equal(c1[0].agentOptions.provider, 'explicit-p');

  const { ctx: noHost, created: c2 } = fakeCtx(null);
  await consolidate({ ctx: noHost, gated: GATED, existing: [], day: 'd' });
  assert.equal(c2[0].agentOptions.provider, DEFAULT_PROVIDER);
  assert.equal(c2[0].agentOptions.model, DEFAULT_MODEL);
  assert.equal(c2[0].agentOptions.reasoningEffort, DEFAULT_REASONING_EFFORT);
});
