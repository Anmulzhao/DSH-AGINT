// LLM 模型选择单一真源：agint-upstream-watch 段 2 判读侧契约测试（2026-11-15）。
//
// 段 1 事实是确定性代码，段 2 结论才调模型。这里锁死：段 2 交给宿主的
// agentOptions 必须来自宿主 agentDefaultModel.currentSelection()，且服务缺席时
// 只影响「结论有没有」，不影响事实落库路径（不降级原则不变）。
//
// 全程 mock ctx，不调真模型、不依赖网络。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveLlmSelection,
  judgeFacts,
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
} from '../lib/judge.js';

const HOST = { provider: 'host-provider', model: 'Host-Model', reasoningEffort: 'xhigh' };

const FACTS = {
  tag: 'dsh-v1.0.0',
  targetVersion: '1.0.0',
  installedVersion: '0.9.0',
  agintTestedVersion: '0.9.0',
  level: 'patch',
  preStageChange: 'none',
  versionTracks: {},
  body: { entryCount: 1, tagCounts: {}, breakingHits: 0, breakingSamples: [] },
  impactSummary: {},
  semanticSummary: {},
  // condenseFacts() 会 .map 这两个字段；不给会让 prompt 构造先抛，
  // 端到端就退成了「只在 agents.create 处收尾」，证明力不足。
  depFace: [],
  semanticDeltas: [],
};

/** selection=null 表示宿主服务缺席。startActivation 返回 error 让判读提前收尾，
 *  我们只关心 agents.create 记下的 agentOptions。 */
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
  assert.deepEqual(resolveLlmSelection(ctx, {}), { ...HOST, source: 'host' });
  assert.equal(resolveLlmSelection(ctx, { provider: 'p', model: 'M' }).provider, 'p');
  const { ctx: noHost } = fakeCtx(null);
  assert.deepEqual(resolveLlmSelection(noHost, {}), {
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    source: 'fallback',
  });
});

test('resolveLlmSelection：宿主取值抛错 ⇒ 兜底（段 1 事实不受影响）', () => {
  const ctx = { get: () => ({ currentSelection: () => { throw new Error('gone'); } }) };
  assert.equal(resolveLlmSelection(ctx, {}).source, 'fallback');
});

test('judgeFacts：agentOptions 用宿主模型（不是签名上的 DEFAULT_*）', async () => {
  const { ctx, created, started } = fakeCtx(HOST);
  const out = await judgeFacts(ctx, FACTS, { provider: '', model: '' });
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].agentOptions, {
    provider: HOST.provider,
    model: HOST.model,
    reasoningEffort: HOST.reasoningEffort,
  });
  // 宿主 dsh 0.2.2-rc.1（2026-11-13）起 SubagentActivationSpec 移除嵌套 request，
  // agentOptions 与 parent/prompt 一样摊在 spec 顶层（见 upstream-watch.test.mjs 契约用例）。
  assert.equal(started[0].request, undefined);
  assert.equal(started[0].agentOptions.model, HOST.model);
  assert.equal(out.ok, false, 'stopReason=error 必须 failed，不许造结论');
});

test('judgeFacts：显式指定模型优先；宿主缺席仍只产 failed 不产结论', async () => {
  const { ctx: explicit, created: c1 } = fakeCtx(HOST);
  await judgeFacts(explicit, FACTS, { provider: 'explicit-p', model: 'Explicit-M' });
  assert.equal(c1[0].agentOptions.provider, 'explicit-p');

  const { ctx: noHost, created: c2 } = fakeCtx(null);
  const out = await judgeFacts(noHost, FACTS, {});
  assert.equal(c2[0].agentOptions.provider, DEFAULT_PROVIDER);
  assert.equal(out.ok, false);
  assert.equal(out.verdict, undefined, '⛔ 失败时不带 verdict');
});
