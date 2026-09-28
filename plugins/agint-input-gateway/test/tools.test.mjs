/**
 * tools.js 真调测试：mock ctx + mock service，实际调用 execute()。
 *
 * 这个测试捕捉的 bug：getStatus() 是同步方法，tools 层错用 .then 导致崩溃。
 * smoke.mjs 只做字符串 includes 断言，抓不到这种运行时错误。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as tools from '../lib/tools.js';

function makeMockCtx(mockService) {
  const registered = [];
  return {
    registered,
    ctx: {
      tools: {
        register: (tool) => { registered.push(tool); },
      },
      'agint.inputGateway': mockService,
    },
  };
}

test('input_gateway_status: execute() 不崩溃（同步 service 不用 .then）', async () => {
  // 关键：getStatus 返回同步对象（不是 Promise）——这就是触发 bug 的条件
  const mockService = {
    getStatus: () => ({
      gateway: 'agint-input-gateway',
      enabled: true,
      channelCount: 1,
      channels: [{
        channelId: 'self-observation',
        channelType: 'self-observation',
        enabled: true,
        quota: 50,
        lastFetchAt: null,
        lastFetchDurationMs: null,
        lastError: null,
        counters: { fetchCount: 0, signalsEmitted: 0, signalsFiltered: 0, errorCount: 0 },
      }],
      config: {},
    }),
    getChannelStatus: () => ({}),
    forceFetch: async () => ({ ok: true }),
    setQuota: () => ({ channelId: 'x', quota: 10 }),
    setChannelEnabled: () => ({ channelId: 'x', enabled: true }),
  };

  const { ctx, registered } = makeMockCtx(mockService);
  tools.apply(ctx);

  const statusTool = registered.find((t) => t.name === 'input_gateway_status');
  assert.ok(statusTool, 'input_gateway_status 已注册');

  // 真调 execute()——如果 getStatus 返回同步值而 execute 用 .then，这里会崩
  const result = await statusTool.execute({});
  assert.equal(result.enabled, true);
  assert.equal(result.channelCount, 1);
  assert.equal(result.channels[0].channelId, 'self-observation');
});

test('input_gateway_channel_status: execute() 正常', async () => {
  const mockService = {
    getStatus: () => ({}),
    getChannelStatus: (id) => ({ channelId: id, channelType: 'self-observation', enabled: true, quota: 50, lastFetchAt: null, lastError: null, counters: {} }),
    forceFetch: async () => ({ ok: true }),
    setQuota: () => ({}),
    setChannelEnabled: () => ({}),
  };
  const { ctx, registered } = makeMockCtx(mockService);
  tools.apply(ctx);

  const tool = registered.find((t) => t.name === 'input_gateway_channel_status');
  const result = await tool.execute({ channelId: 'self-observation' });
  assert.equal(result.channelId, 'self-observation');
});

test('所有 6 个工具的 execute() 都不抛同步/异步错配错误', async () => {
  const mockService = {
    getStatus: () => ({ enabled: true, channelCount: 0, channels: [] }),
    getChannelStatus: (id) => ({ channelId: id }),
    forceFetch: async (id) => ({ ok: true, channelId: id }),
    setQuota: (id, q) => ({ channelId: id, quota: q }),
    setChannelEnabled: (id, e) => ({ channelId: id, enabled: e }),
  };
  const { ctx, registered } = makeMockCtx(mockService);
  tools.apply(ctx);

  assert.equal(registered.length, 6, '应有 6 个工具');

  for (const tool of registered) {
    try {
      const args = { channelId: 'self-observation', quota: 10 };
      const result = await tool.execute(args);
      assert.ok(result !== undefined, `${tool.name} execute() 返回了结果`);
    } catch (e) {
      assert.fail(`${tool.name} execute() 抛错: ${e.message}`);
    }
  }
});
