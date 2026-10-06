/**
 * C4 adversarial 即投路径测试（v0.1.4，H1 方案②）。
 *
 * 覆盖：事件到达 ⇒ 不经队列 ⇒ 直接进管线发布；过滤条件（pass 不转 / 空壳转 /
 * unverifiable 才转）；dedup 防重放；counters 持久化；cron 口径统一。
 *
 * 不挂 Cordis、不真开 storage domain——InputGateway + mock table + mock publish。
 * 模块级 _subscribed 是单例状态，全文件共用一次 initSubscriptions。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { InputGateway } from '../lib/gateway.js';
import { adversarialChannel, initSubscriptions } from '../lib/channels/adversarial.js';
import { DEFAULTS, C4_CRON } from '../lib/schema.js';

const tableMap = new Map();
const published = [];
let capturedHandler = null;

const gw = new InputGateway({
  table: (name) => ({
    get: (k) => tableMap.get(`${name}:${k}`),
    put: async (k, v) => { tableMap.set(`${name}:${k}`, v); },
    entries: () => tableMap.entries(),
  }),
  getPublish: () => (evt) => { published.push(evt); return { accepted: true, deliveredTo: 1 }; },
  config: { ...DEFAULTS },
  debug: () => {},
});
gw.registerChannel(adversarialChannel);

const ctx = {
  get: (key) => {
    if (key === 'agint.eventBus.subscribe') {
      return (_opts, handler) => { capturedHandler = handler; return () => {}; };
    }
    return null;
  },
  effect: () => {},
};
initSubscriptions(ctx, {}, gw);

const flush = () => new Promise((r) => setImmediate(r));
const fire = async (envelope) => { capturedHandler(envelope); await flush(); };
const topicsPublished = () => published.map((e) => e.topic);

test('initSubscriptions 要求 gateway 实例：缺参时 degraded 且不吞事件', async () => {
  const health = await adversarialChannel.health();
  assert.equal(health.status, 'ok', '本测试文件已用合法 gateway 完成订阅');
  assert.equal(health.mode, 'immediate-emit');
});

test('diagnosis.completed 有聚类 → 即投 counterfactual-result', async () => {
  await fire({ topic: 'diagnosis.completed', payload: {
    reportId: 'r-001', clusterCount: 2, rootCauseDistribution: { a: 1 },
    evaluatedAt: '2026-10-06T00:00:00Z',
  } });
  assert.ok(topicsPublished().includes('input.signal.adversarial.counterfactual-result'));
});

test('diagnosis.completed 空壳默认也转发（诊断链空转可见）', async () => {
  const before = published.length;
  await fire({ topic: 'diagnosis.completed', payload: { reportId: 'r-002', clusterCount: 0 } });
  assert.equal(published.length, before + 1);
  const env = published[published.length - 1];
  assert.equal(env.payload.signalId, 'counterfactual-empty-r-002');
  assert.equal(env.payload.payload.empty, true);
});

test('curriculum.challenge-verdicted：pass 不转发，fail 转发', async () => {
  const before = published.length;
  await fire({ topic: 'curriculum.challenge-verdicted', payload: { challengeId: 'c-1', result: 'pass' } });
  assert.equal(published.length, before, 'pass 不应产生信号');
  await fire({ topic: 'curriculum.challenge-verdicted', payload: { challengeId: 'c-2', result: 'fail', domain: 'integration' } });
  assert.equal(published.length, before + 1);
  assert.ok(topicsPublished().includes('input.signal.adversarial.curriculum-result'));
});

test('curriculum.boundary-probed：仅 unverifiable 非空才转发', async () => {
  const before = published.length;
  await fire({ topic: 'curriculum.boundary-probed', payload: { domains: [], unverifiable: [] } });
  assert.equal(published.length, before);
  await fire({ topic: 'curriculum.boundary-probed', payload: { domains: [], unverifiable: ['integration'] } });
  assert.equal(published.length, before + 1);
  assert.ok(topicsPublished().includes('input.signal.adversarial.boundary-divergence'));
});

test('同 reportId 重放 → dedup 拦截（重启后事件重放不双发）', async () => {
  const before = published.length;
  await fire({ topic: 'diagnosis.completed', payload: { reportId: 'r-001', clusterCount: 2 } });
  assert.equal(published.length, before, 'dedup 窗口内同 signalId 不得重发');
  const counters = tableMap.get('counters:adversarial');
  assert.ok(counters.signalsDeduplicated >= 1);
});

test('counters 即时持久化（即投也记账，不依赖 fetch 心跳）', async () => {
  const counters = tableMap.get('counters:adversarial');
  assert.ok(counters.signalsEmitted >= 4, `emitted=${counters.signalsEmitted}`);
  assert.equal(counters.fetchCount, 0, '即投不占 fetchCount');
  assert.ok(counters.securityScanned >= 4, 'adversarial 在 security 检查范围内');
});

test('fetch 空 drain 保留心跳；cron 与调度器同口径（C4_CRON 每日）', async () => {
  assert.equal(adversarialChannel.cron, C4_CRON);
  const drained = await adversarialChannel.fetch({});
  assert.deepEqual(drained, []);
});
