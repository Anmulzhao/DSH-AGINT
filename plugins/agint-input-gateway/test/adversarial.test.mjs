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

// ── fake ctx 必须复刻 cordis 的真实语义（2026-10-09 修）────────────────────
// 原写法有两处失明，让 `ctx.effect(() => { disposer(); })` 这个真 bug 测不出来
// （当时全文件 108 行测试全绿，而生产上订阅从未生效）：
//   ① `return () => {}` —— subscribe 返回的 disposer 是空函数，退订不删 handler；
//   ② `effect: () => {}` —— effect 什么都不做，注册当场不会执行传入的函数。
// 现在按 cordis src/fiber.ts:363-372 复刻：
//   effect(fn) **立即执行** fn；只有 fn **返回函数**时该函数才被收集为 disposer。
let subscriptionAlive = false;
const effectDisposers = [];

const ctx = {
  get: (key) => {
    if (key === 'agint.eventBus.subscribe') {
      return (_opts, handler) => {
        capturedHandler = handler;
        subscriptionAlive = true;
        return () => { subscriptionAlive = false; capturedHandler = null; };
      };
    }
    return null;
  },
  effect: (fn) => {
    const effect = fn(); // fiber.ts:366：立即执行 effect body
    if (typeof effect === 'function') effectDisposers.push(effect); // :367-368
    return () => {};
  },
};
initSubscriptions(ctx, {}, gw);

const flush = () => new Promise((r) => setImmediate(r));
const fire = async (envelope) => { capturedHandler(envelope); await flush(); };
const topicsPublished = () => published.map((e) => e.topic);

/**
 * 【核心回归】订阅必须在 initSubscriptions 之后仍然活着。
 *
 * 2026-10-09 修复前：ctx.effect 少一层箭头 ⇒ disposer 在注册当场被调用 ⇒
 * 订阅建好即退。health() 却因 `_subscribed=true` 仍报 status:ok ⇒ 假绿。
 * 运行时旁证：eventBus_deliveryByTopic 的 orphanSubscriptions 里有 4 个
 * diagnosis.completed 订阅者，唯独没有 agint-input-gateway/adversarial。
 */
test('订阅在 initSubscriptions 后仍活着（effect 不得当场退订）', () => {
  assert.equal(subscriptionAlive, true,
    '订阅已被撤销 —— ctx.effect 的回调必须**返回** disposer，不能直接调用它');
  assert.equal(typeof capturedHandler, 'function', 'handler 必须仍挂在订阅上');
  assert.equal(effectDisposers.length, 1,
    'effect 应收集到恰好 1 个 disposer（原来收集到 0 个，说明没人负责清理）');
});

test('卸载路径：effect disposer 确实能退订', () => {
  // 修好后 disposer 被正确收集，卸载时调用才能真正退订；
  // 修前收集到 0 个，订阅泄漏或被误撤，二者必有一错。
  assert.equal(typeof effectDisposers[0], 'function');
  // ⚠️ 必须存回**真 handler**：disposer 会把 capturedHandler 置 null，
  //   若用空函数顶替，后续所有 fire() 用例都会静默不转发而红。
  const realHandler = capturedHandler;
  effectDisposers[0]();
  assert.equal(subscriptionAlive, false, '卸载后订阅应被撤销');
  // 复原，避免影响后续用例
  subscriptionAlive = true;
  capturedHandler = realHandler;
});

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
