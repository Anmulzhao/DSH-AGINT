// 插件 apply() 集成单测：B 档事件接线 / 事件总线订阅 / provider 桥 / 兜底装饰。
// 不挂真实 Cordis —— mock ctx（_helpers.mjs），行为契约与 host 一致。

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import * as plugin from '../lib/index.js';
import { makeCtx, makeEventBus, makeMemory, makeMemoryProvider } from './_helpers.mjs';

const TEXT = '老板拍板：P3-1 采用 B 档接线。最终配置：端口 3080。';

function makePluginCtx({ memorySearch, memoryProvider, eventBus, config = {} } = {}) {
  const memory = makeMemory(memorySearch);
  const mp = memoryProvider ?? makeMemoryProvider();
  const bus = eventBus ?? makeEventBus();
  const ctx = makeCtx({ memory, memoryProvider: mp, eventBus: bus });
  plugin.apply(ctx, config);
  return { ctx, memory, mp, bus };
}

/** 等待插件异步 init（ready.then 链）完成 */
async function settle(ms = 30) {
  await new Promise((r) => setTimeout(r, ms));
}

test('apply 契约：提供 agint.compressGuard 且 FROZEN 6 Service 齐全', async () => {
  const { ctx } = makePluginCtx();
  await settle();
  const svc = ctx.services['agint.compressGuard'];
  assert.ok(svc);
  for (const m of ['checkpoint', 'extract', 'search', 'recall', 'stats', 'setEnabled']) {
    assert.equal(typeof svc[m], 'function', `FROZEN Service ${m} 缺失`);
  }
  for (const m of ['setLlmExtract', 'reindex']) {
    assert.equal(typeof svc[m], 'function', `非 FROZEN Service ${m} 缺失`);
  }
});

test('B 档：session/event compaction/summary → host-compaction 编排 + hostCompactionsSeen', async () => {
  const { ctx } = makePluginCtx();
  await settle();
  // 模拟宿主 post-commit feed（载荷形状 = dsh-compaction-basic session.append 实测）
  ctx.emit('session/event', { id: 'session-abc' }, {
    type: 'compaction/summary',
    data: {
      compactionId: 'compaction-1',
      summary: TEXT,
      shadowedSeqs: [3, 4],
      shadowedTokenCount: 900,
    },
  });
  await settle(60);
  const svc = ctx.services['agint.compressGuard'];
  const s = await svc.stats();
  assert.equal(s.sourceHealth.hostCompactionsSeen, 1);
  assert.equal(s.status, 'OK');
  assert.ok(s.coverage.insights >= 1, 'B 档应从 summary 提取洞察');
  // 其它 compaction 事件不触发编排
  ctx.emit('session/event', { id: 'session-abc' }, { type: 'compaction/start', data: { compactionId: 'c2' } });
  ctx.emit('session/event', { id: 'session-abc' }, { type: 'user/message', data: {} });
  await settle(40);
  const s2 = await svc.stats();
  assert.equal(s2.sourceHealth.hostCompactionsSeen, 1);
});

test('B 档：compaction/end 带 error → compress-guard.blocked 告警事件', async () => {
  const { ctx, bus } = makePluginCtx();
  await settle();
  ctx.emit('session/event', { id: 's' }, {
    type: 'compaction/end',
    data: { compactionId: 'c-err', error: 'llm timeout' },
  });
  await settle(60);
  const blocked = bus.envelopes.find((e) => e.topic === 'compress-guard.blocked');
  assert.ok(blocked, 'end.error 必须等价 BLOCKED 告警（§5.1）');
  assert.ok(blocked.payload.reason.includes('llm timeout'));
});

test('事件总线：memory.pre-compress-checkpoint → p1CheckpointsSeen + checkpointId 回填 pending', async () => {
  const { ctx, bus } = makePluginCtx();
  await settle();
  const svc = ctx.services['agint.compressGuard'];

  // ① onPreCompress 路径先落 pending 洞察（id=null, linkPending=true）
  const r = await svc.checkpoint({
    kind: 'p1-checkpoint', id: null, messages: [{ role: 'user', content: TEXT }], runRawSnapshot: false,
  });
  assert.equal(r.status, 'PASSED');
  assert.equal(r.checkpointId, null);
  const s0 = await svc.stats();
  assert.ok(s0.coverage.pendingInsights >= 1, '载荷缺口期间洞察以 linkPending 落库');

  // ② P1-1（打了最小 PR 后）发布事件，带 checkpointId → 回填
  bus.publish({
    topic: 'memory.pre-compress-checkpoint', source: 'agint-memory-provider',
    payload: { providerName: 'builtin', status: 'success', messagesCompressed: 2, abortCompress: false, apiVersion: 2, checkpointId: 'pcc_20260913_abc123', sessionId: null },
  });
  await settle(60);
  const s1 = await svc.stats();
  assert.equal(s1.sourceHealth.p1CheckpointsSeen, 1);
  assert.equal(s1.coverage.pendingInsights, 0, '事件回填后 pending 清零');
  const hits = await svc.search({ keyword: '拍板' });
  assert.ok(hits.some((h) => h.source.checkpointRef.id === 'pcc_20260913_abc123'));
});

test('Q6 provider 桥：注册进 P1-1 registry，apiVersion=2，onPreCompress 落洞察返回散文', async () => {
  const { ctx, mp } = makePluginCtx();
  await settle();
  assert.equal(mp.registered.length, 1, 'provider 必须注册进 P1-1 registry（单一入口）');
  const p = mp.registered[0];
  assert.equal(p.name, 'compress-guard');
  assert.equal(p.preCompressCheckpointApiVersion, 2, 'apiVersion 必须 = 2（Q6/fail-closed 生效前提）');
  assert.equal(p.isAvailable(), true);
  assert.deepEqual(p.getToolSchemas(), []);

  // onPreCompress：提取 + 落库 + 返回散文（补 P1-1 insightLength 的正文漏点）
  const prose = await p.onPreCompress([{ role: 'user', content: TEXT }]);
  assert.ok(typeof prose === 'string' && prose.length > 0);
  assert.ok(prose.includes('拍板'));

  // 软降级：无文本 → 返回 ''（不抛，raw 检查点由 P1-1 自己落）
  const empty = await p.onPreCompress([{ role: 'user', content: '今天天气不错。' }]);
  assert.equal(empty, '');
});

test('Q6 provider 桥：prefetch 委托 agint.memory.search（激活后召回行为与 builtin 一致）', async () => {
  const { ctx, mp } = makePluginCtx({
    memorySearch: async () => [{ type: 'lesson', level: 'long', content: '记忆条目' }],
  });
  await settle();
  const p = mp.registered[0];
  const ctxStr = await p.prefetch('记忆', {});
  assert.ok(ctxStr.includes('记忆条目'));
  assert.equal(p.recallStatus().count, 1);
  // 空查询 → ''（不注入无关旧记忆，BuiltinProvider 同策略）
  assert.equal(await p.prefetch('', {}), '');
});

test('§6.2 兜底：memory.search 0 命中 → 注入洞察一次（带来源标注），同 query 第二次不注入', async () => {
  const { ctx, memory } = makePluginCtx({ memorySearch: async () => [] });
  await settle();
  const svc = ctx.services['agint.compressGuard'];
  // 先放一条洞察进域
  await svc.checkpoint({ kind: 'host-compaction', id: 'c1', text: '老板拍板：B 档是唯一主战场。', shadowedSeqs: [1] });

  const first = await memory.search('B 档', {});
  assert.equal(first.length, 1, 'miss → 兜底注入 1 条');
  assert.ok(first[0].content.startsWith('[来源：压缩洞察 ins_'), '必须标注来源（§6.1）');
  assert.equal(first[0].source, 'compress-guard');

  const second = await memory.search('B 档', {});
  assert.equal(second.length, 0, '同 query 单次语义：第二次不再兜底（切断自我污染回路）');

  // 不回写记忆库（§2.2 非目标）
  assert.equal(memory.writes.length, 0);
});

test('§6.2 兜底：命中 0 条洞察时 recallMisses 计数；原生命中时不触发兜底', async () => {
  const { ctx, memory } = makePluginCtx({ memorySearch: async () => [] });
  await settle();
  const svc = ctx.services['agint.compressGuard'];
  await memory.search('查无洞察的关键词xyz', {});
  let s = await svc.stats();
  assert.equal(s.counters.recallMisses, 1);

  // 原生命中 → 不走兜底
  const memory2 = makeMemory(async () => [{ type: 'lesson', level: 'long', content: 'x' }]);
  const ctx2 = makeCtx({ memory: memory2, memoryProvider: makeMemoryProvider(), eventBus: makeEventBus() });
  plugin.apply(ctx2, {});
  await settle();
  await memory2.search('anything', {});
  const s2 = await ctx2.services['agint.compressGuard'].stats();
  assert.equal(s2.counters.recallMisses, 0);
  assert.equal(s2.counters.recallHits, 0, '原生命中不冒充兜底命中');
});

test('§6.2 兜底：enabled=false 或 fallbackEnabled=false 时不注入', async () => {
  const { ctx, memory } = makePluginCtx({ memorySearch: async () => [], config: { fallbackEnabled: false } });
  await settle();
  const svc = ctx.services['agint.compressGuard'];
  await svc.checkpoint({ kind: 'host-compaction', id: 'c1', text: '老板拍板：测试。', shadowedSeqs: [1] });
  const r = await memory.search('拍板', {});
  assert.equal(r.length, 0, 'fallbackEnabled=false 不兜底');
});

test('dispose：兜底装饰还原为原 search（must-dispose 生命周期红线）', async () => {
  const { ctx, memory } = makePluginCtx({ memorySearch: async () => [{ type: 'lesson', level: 'long', content: 'x' }] });
  await settle();
  assert.notEqual(memory.search.name, 'search', '已被装饰');
  ctx.dispose();
  assert.equal(memory.search.name, 'bound search', 'dispose 后还原为原函数');
});

test('dispose：事件总线退订（订阅表清空）', async () => {
  const { ctx, bus } = makePluginCtx();
  await settle();
  const before = bus.subs.length;
  assert.ok(before >= 2, '应订阅 2 个 topic');
  ctx.dispose();
  assert.equal(bus.subs.length, 0, 'dispose 后订阅表清空');
});

test('config 表持久化：setEnabled(false) 后生效配置跟随（runtime + 表双通道）', async () => {
  const { ctx } = makePluginCtx();
  await settle();
  const svc = ctx.services['agint.compressGuard'];
  await svc.setEnabled(false);
  const s = await svc.stats();
  assert.equal(s.config.enabled, false);
  await svc.setEnabled(true);
  const s2 = await svc.stats();
  assert.equal(s2.config.enabled, true);
});

test('checkpoint Service 熔断直通：DISABLED + counters 留痕', async () => {
  const { ctx } = makePluginCtx();
  await settle();
  const svc = ctx.services['agint.compressGuard'];
  await svc.setEnabled(false);
  const r = await svc.checkpoint({ kind: 'host-compaction', id: 'c', text: TEXT });
  assert.equal(r.status, 'DISABLED');
  assert.equal(r.disabled, true);
  const s = await svc.stats();
  assert.equal(s.counters.disabledPassThrough, 1);
});

test('configApi：非法 key 显式 rejected（不静默吞）', async () => {
  const { ctx } = makePluginCtx();
  await settle();
  const svc = ctx.services['agint.compressGuard'];
  const r = svc.config({ notAllowed: 1, shadowMode: false });
  assert.deepEqual(r.rejected, ['notAllowed']);
  assert.equal(r.shadowMode, false);
});
