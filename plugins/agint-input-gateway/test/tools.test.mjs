/**
 * tools.js 真调测试：mock ctx + mock service，实际调用 execute()。
 *
 * 契约：gateway.getStatus() 是 async 方法（v0.1.1 security 面 / getChannelStatus 均 await）。
 * 2026-09-29 真实运行验收抓出：input_gateway_status 的 execute 漏 await svc.getStatus()，
 * 把 Promise 序列化成 {} → enabled=undefined channels=undefined。
 * 本测试 mock 复刻 async 契约：若 execute 再漏 await，result.enabled 断言变红。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as tools from '../lib/tools.js';
import { assertToolCallable } from './_stub-storage-domain.mjs';

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

test('input_gateway_status: execute() 拿到真实状态（async getStatus 必须 await）', async () => {
  // 关键：getStatus 是 async 契约——execute 漏 await 会把 Promise 序列化成 {}，enabled/channelCount 断言变红
  const mockService = {
    getStatus: async () => ({
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

// ── 2026-10-28 追加（提案 `846f4fbb` 单元 3）：output.render 也要真调一次 ────────
//
// 上面那条只调了 execute。真宿主是「先校验 schema、再调 output.render」
// （dsh-tools/lib/index.js:846 / :856）⇒ 只写 schema 不写 render 的工具
// **注册成功、execute 也正常**，缺陷晚到渲染那一刻才炸
// （upstream-watch v0.3.0 现场：`output.render failed: userRender is not a function`）。
// ⛔ 光有 execute 的测试，这类缺陷一条都抓不到。

test('所有 6 个工具的 output.render 都存在且能真调一次', async () => {
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
    const args = { channelId: 'self-observation', quota: 10 };
    // tolerateRuntimeError=true：这里验的是**契约**（入口名 / render 在不在），
    // 业务逻辑错误由上面那些用例负责。
    const { error, renderError } = await assertToolCallable(tool, { args, tolerateRuntimeError: true });
    assert.ok(
      !(error instanceof TypeError && /userExecute is not a function/.test(error?.message ?? '')),
      `${tool.name} 的入口不是 execute（真宿主会抛 userExecute is not a function）`,
    );
    assert.ok(
      !(renderError instanceof TypeError && /userRender is not a function/.test(renderError?.message ?? '')),
      `${tool.name} 缺 output.render（真宿主会抛 userRender is not a function）`,
    );
  }
});
