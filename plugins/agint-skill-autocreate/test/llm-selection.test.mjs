// LLM 模型选择单一真源：本插件侧的契约测试（2026-11-15 收敛）。
//
// 锁死三件事：
//   ① 优先级 = 显式入参 > 宿主 agentDefaultModel.currentSelection() > 离线兜底常量
//   ② 宿主服务缺席 / 取值抛错都按「没有选择」处理，绝不把插件启动拖垮
//   ③ **端到端**：judgeViaLLM 真正交给宿主的 agentOptions 用的是宿主模型，
//      而不是函数签名上那几个 DEFAULT_* 常量（单测只测常量解析证明不了这件事）
//
// 全程 mock ctx，不调真模型、不依赖网络。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveLlmSelection,
  judgeViaLLM,
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
} from '../lib/llm-verdict.js';

const HOST = { provider: 'host-provider', model: 'Host-Model', reasoningEffort: 'xhigh' };

const PATTERN = {
  id: 'tp_1',
  toolSequence: ['file_read', 'file_write'],
  paramSignature: { file_read: 'path:str', file_write: 'path:str' },
  sampleArgs: { file_read: { path: 'a/x.md' } },
  occurrenceCount: 4,
  successRate: 1,
  description: '批量改 md 的固定流程',
};

/** selection=null 表示宿主服务缺席；selection 为对象表示服务返回该选择。 */
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

// ── ① 优先级 ──────────────────────────────────────────────────────────────

test('resolveLlmSelection：宿主当前选择是运行时真源', () => {
  const { ctx } = fakeCtx(HOST);
  assert.deepEqual(resolveLlmSelection(ctx, {}), { ...HOST, source: 'host' });
});

test('resolveLlmSelection：显式入参优先于宿主选择', () => {
  const { ctx } = fakeCtx(HOST);
  const out = resolveLlmSelection(ctx, { provider: 'explicit-p', model: 'Explicit-M' });
  assert.equal(out.provider, 'explicit-p');
  assert.equal(out.model, 'Explicit-M');
  assert.equal(out.reasoningEffort, HOST.reasoningEffort);
});

test('resolveLlmSelection：宿主服务缺席 ⇒ 离线兜底常量', () => {
  const { ctx } = fakeCtx(null);
  assert.deepEqual(resolveLlmSelection(ctx, {}), {
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    source: 'fallback',
  });
});

test('resolveLlmSelection：宿主取值抛错也按缺席处理', () => {
  const ctx = { get: () => ({ currentSelection: () => { throw new Error('service gone'); } }) };
  assert.equal(resolveLlmSelection(ctx, {}).source, 'fallback');
});

// ── ③ 端到端：真正交给宿主的 agentOptions ─────────────────────────────────

test('judgeViaLLM：生产路径用宿主模型，不是 DEFAULT_* 死常量', async () => {
  const { ctx, created, started } = fakeCtx(HOST);
  const out = await judgeViaLLM({ ctx, pattern: PATTERN, provider: '', model: '' });
  assert.equal(created.length, 1, '应当建了临时 parent');
  assert.deepEqual(created[0].agentOptions, {
    provider: HOST.provider,
    model: HOST.model,
    reasoningEffort: HOST.reasoningEffort,
  });
  assert.equal(started[0].agentOptions.model, HOST.model);
  assert.equal(started[0].request, undefined, '宿主 0.2.2-rc.1 起不再接受嵌套 request');
  assert.equal(out.meta.provider, HOST.provider, '报告值必须是生效值');
});

test('judgeViaLLM：调用方显式指定模型时不被宿主覆盖', async () => {
  const { ctx, created } = fakeCtx(HOST);
  await judgeViaLLM({ ctx, pattern: PATTERN, provider: 'explicit-p', model: 'Explicit-M' });
  assert.equal(created[0].agentOptions.provider, 'explicit-p');
  assert.equal(created[0].agentOptions.model, 'Explicit-M');
});

test('judgeViaLLM：宿主服务缺席时行为不变（仍落兜底常量）', async () => {
  const { ctx, created } = fakeCtx(null);
  await judgeViaLLM({ ctx, pattern: PATTERN, provider: '', model: '' });
  assert.equal(created[0].agentOptions.provider, DEFAULT_PROVIDER);
  assert.equal(created[0].agentOptions.model, DEFAULT_MODEL);
});
