/**
 * agint-trajectory 事件订阅单测（§5.1，Sprint 18 T3 + v0.3 降级路径）。
 *
 * 重点：
 *   1. 事件 → 轨迹的映射（真实 payload 形状，取自各插件的 publish 代码）
 *   2. **降级路径**：event-bus 不可用/订阅失败 → degraded，退回显式 record()
 *   3. diagnosis.completed 走归因回填而不是新记轨迹
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUBSCRIPTIONS, SUBSCRIBED_TOPICS, mapEvent, mapAttribution, attachSubscriptions,
} from '../lib/subscribers.js';
import * as plugin from '../lib/index.js';
import { createFakeDomain, mount } from './_helpers.mjs';

test('订阅清单：只列设计稿核实的事件，且 mode 为 async（不占 sync 配额）', () => {
  const topics = [...SUBSCRIBED_TOPICS];
  assert.deepEqual(topics, [
    'dream.completed',
    'evolution.proposed',
    'evolution.evaluated',
    'diagnosis.completed',
    'evo-orch.task-started',
    'evo-orch.task-completed',
  ]);
  for (const s of SUBSCRIPTIONS) assert.ok(['record', 'attribution'].includes(s.role));
  // 不订阅已核实不存在的事件（v0.1 事故：虚构 5 个事件）
  for (const ghost of ['evolution.mutator.proposed', 'evolution.sandbox.verified', 'mount.activated', 'eval.completed', 'subagent.ended']) {
    assert.ok(!topics.includes(ghost), `不应订阅不存在的事件 ${ghost}`);
  }
});

test('mapEvent(dream.completed)：真实 payload → dream 成功轨迹', () => {
  const env = {
    topic: 'dream.completed', version: 1, source: 'agint-dream',
    payload: {
      sweepId: '1762000000000', completedAt: '2026-11-03T02:00:00Z', apply: false,
      durationMs: 60000, countCandidates: 5, countGated: 1, countPromoted: 2, diaryPath: '/tmp/d.md',
    },
  };
  const r = mapEvent(env);
  assert.equal(r.source, 'dream');
  assert.equal(r.kind, 'success');
  assert.equal(r.via, 'event');
  assert.equal(r.taskRef.cronJob, 'night-dream');
  assert.equal(r.durationMs, 60000);
  assert.equal(r.startedAt, '2026-11-03T01:59:00.000Z');
  assert.ok(r.steps[0].content.includes('promoted=2'));
});

test('mapEvent(evolution.evaluated)：VETOED → failure，但不猜 errorClass', () => {
  const env = {
    topic: 'evolution.evaluated', payload: { targetId: 'v-7', decision: 'VETOED', scores: { composite: -0.2 }, findings: [] },
  };
  const r = mapEvent(env);
  assert.equal(r.source, 'evolution');
  assert.equal(r.kind, 'failure');
  assert.equal(r.taskRef.variantId, 'v-7');
  assert.equal(r.outcome.errorClass ?? null, null, 'errorClass 留给 diagnosis 回填');
  assert.match(r.outcome.errorMsg, /VETOED/);
});

test('mapEvent(evo-orch.task-completed)：status 非成功 → failure + 关联键', () => {
  const env = {
    topic: 'evo-orch.task-completed',
    payload: { batchId: 'b1', taskId: 't9', status: 'failed', durationMs: 5000 },
  };
  const r = mapEvent(env);
  assert.equal(r.source, 'subagent');
  assert.equal(r.kind, 'failure');
  assert.equal(r.taskRef.subagentTaskId, 't9');
  assert.equal(r.taskRef.batchId, 'b1');
  assert.equal(r.durationMs, 5000);
});

test('mapEvent：未知 topic / attribution 类 → null（不记轨迹）', () => {
  assert.equal(mapEvent({ topic: 'whatever' }), null);
  assert.equal(mapEvent({ topic: 'diagnosis.completed', payload: { errorClass: 'TOOL_GAP' } }), null);
  assert.equal(mapEvent(null), null);
});

test('mapAttribution：抽 errorClass / attributionId / 关联键；空则 null', () => {
  const a = mapAttribution({ topic: 'diagnosis.completed', payload: { errorClass: 'TOOL_GAP', diagnosisId: 'd1', trajectoryId: 'traj_x' } });
  assert.deepEqual(a, { errorClass: 'TOOL_GAP', attributionId: 'd1', trajectoryId: 'traj_x', sessionId: null });
  assert.equal(mapAttribution({ topic: 'diagnosis.completed', payload: {} }), null);
});

test('attachSubscriptions 降级：subscribe 缺失 / 抛错 → degraded（退回显式调用）', () => {
  const a = attachSubscriptions({ subscribeFn: null, onEnvelope: async () => {} });
  assert.equal(a.degraded, true);
  assert.equal(a.subscribed.length, 0);
  assert.match(a.reason, /unavailable/);

  const b = attachSubscriptions({
    subscribeFn: () => { throw new Error('bus down'); },
    onEnvelope: async () => {},
  });
  assert.equal(b.degraded, true);
  assert.match(b.reason, /bus down/);
});

test('attachSubscriptions 正常：全量订阅 + async 模式 + 返回 unsubscribe', async () => {
  let seen = null;
  const off = () => {};
  const r = attachSubscriptions({
    subscribeFn: (sub, handler) => { seen = sub; return off; },
    onEnvelope: async () => {},
  });
  assert.equal(r.degraded, false);
  assert.deepEqual(r.subscribed, [...SUBSCRIBED_TOPICS]);
  assert.equal(seen.mode, 'async', '不占 SYNC_GLOBAL_LIMIT=3 配额');
  assert.equal(seen.subscriber, 'agint-trajectory');
  assert.equal(typeof r.unsubscribe, 'function');
});

test('端到端：事件经 handler 落盘（via=event），降级配置下不订阅', async () => {
  const domain = createFakeDomain();
  const h = await mount(plugin, { sampleRates: { task: 1, dream: 1 }, enableEventSubscribe: true }, { domain });
  // 先标定 + 切 live（标定样本要有内容，否则体积样本恒 0 → 报告不 ready）
  for (let i = 0; i < 2; i++) {
    await h.service.record({ source: 'task', steps: [{ seq: 0, role: 'human', content: 'hi' }] });
  }
  h.service.calibration();
  h.service.setRecordMode('live');
  assert.equal(h.subscribed.length, 1, '装配了一次订阅');

  await h.subscribed[0].handler({
    topic: 'dream.completed', version: 1, source: 'agint-dream',
    payload: { sweepId: 's1', completedAt: new Date().toISOString(), durationMs: 1000, countPromoted: 1 },
  });
  const list = await h.service.list({ source: 'dream', limit: 5 });
  assert.equal(list.length, 1);
  assert.equal(list[0].via, 'event');

  // enableEventSubscribe=false → 不订阅，退回显式调用
  const off = await mount(plugin, { enableEventSubscribe: false }, { domain: createFakeDomain() });
  assert.equal(off.subscribed.length, 0);
  assert.match((await off.service.state()).bus.reason, /disabled by config/);
});

test('端到端：diagnosis.completed 回填最近失败轨迹（不猜：无匹配则跳过）', async () => {
  const domain = createFakeDomain();
  const h = await mount(plugin, { sampleRates: { task: 1 } }, { domain });
  for (let i = 0; i < 2; i++) {
    await h.service.record({ source: 'task', steps: [{ seq: 0, role: 'human', content: 'hi' }] });
  }
  h.service.calibration();
  h.service.setRecordMode('live');
  const r = await h.service.record({
    source: 'task', kind: 'failure', taskRef: { sessionId: 's42' }, steps: [],
  });
  await h.subscribed[0].handler({
    topic: 'diagnosis.completed',
    payload: { errorClass: 'PLANNING_FAILURE', diagnosisId: 'd-7', sessionId: 's42' },
  });
  const t = await h.service.get(r.id);
  assert.equal(t.outcome.errorClass, 'PLANNING_FAILURE');
  assert.equal(t.outcome.attributionId, 'd-7');

  // 无匹配的 session → 不动任何数据
  await h.subscribed[0].handler({
    topic: 'diagnosis.completed', payload: { errorClass: 'TOOL_GAP', sessionId: 'nope' },
  });
  assert.equal((await h.service.get(r.id)).outcome.errorClass, 'PLANNING_FAILURE');
});
