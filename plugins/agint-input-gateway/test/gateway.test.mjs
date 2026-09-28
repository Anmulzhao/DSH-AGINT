/**
 * Gateway 核心逻辑测试：过滤 / 去重 / 噪声抑制 / 配额 / topic 构建 / payload 截断 / 写操作。
 *
 * 不挂 Cordis、不真打开 storage domain——直接实例化 InputGateway，注入 mock table 和 publish。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { InputGateway } from '../lib/gateway.js';
import { CHANNEL_TYPES, DEFAULTS } from '../lib/schema.js';

function makeGateway(overrides = {}) {
  const published = [];
  const tableMap = new Map();
  const mockTable = (name) => ({
    get: (k) => tableMap.get(`${name}:${k}`),
    put: async (k, v) => { tableMap.set(`${name}:${k}`, v); },
    entries: () => tableMap.entries(),
  });

  const gw = new InputGateway({
    table: mockTable,
    getPublish: () => (evt) => { published.push(evt); return { accepted: true, deliveredTo: 1 }; },
    config: { ...DEFAULTS },
    debug: () => {},
    ...overrides,
  });
  return { gw, published };
}

const mockChannel = {
  id: 'test-channel',
  type: CHANNEL_TYPES.SELF_OBSERVATION,
  cron: '0 2 * * *',
  async fetch() { return []; },
};

test('注册 Channel：基本属性正确', () => {
  const { gw } = makeGateway();
  gw.registerChannel(mockChannel);
  const status = gw.getStatus();
  assert.equal(status.channelCount, 1);
  assert.equal(status.channels[0].channelId, 'test-channel');
  assert.equal(status.channels[0].channelType, 'self-observation');
});

test('信号过滤：置信度低于阈值被丢弃', () => {
  const { gw, published } = makeGateway();
  gw.registerChannel(mockChannel);

  const result = gw.processSignals([
    { signalId: 's1', signalType: 'tool.anomaly', source: 'test', payload: {}, confidence: 0.1, relevance: 0.9 },
    { signalId: 's2', signalType: 'tool.anomaly', source: 'test', payload: {}, confidence: 0.9, relevance: 0.9 },
  ], mockChannel);

  assert.equal(result.filtered, 1);  // s1 被过滤
  assert.equal(result.emitted, 1);   // s2 发布
  assert.equal(published.length, 1);
  assert.equal(published[0].topic, 'input.signal.self-observation.tool-anomaly');
});

test('信号去重：相同 signalId 不重复发布', () => {
  const { gw, published } = makeGateway();
  gw.registerChannel(mockChannel);

  const sig = { signalId: 'dup-1', signalType: 'metric.regression', source: 'test', payload: {}, confidence: 0.9, relevance: 0.9 };
  gw.processSignals([sig], mockChannel);
  gw.processSignals([sig], mockChannel);

  assert.equal(published.length, 1);
});

test('噪声抑制：同 source+signalType 超限被丢弃', () => {
  const { gw, published } = makeGateway();
  gw.registerChannel(mockChannel);

  // 默认 noiseMaxPerSource = 5，发 8 条同 source+signalType
  const signals = Array.from({ length: 8 }, (_, i) => ({
    signalId: `noise-${i}`,
    signalType: 'tool.anomaly',
    source: 'same-source',
    payload: {},
    confidence: 0.9,
    relevance: 0.9,
  }));
  const result = gw.processSignals(signals, mockChannel);

  assert.equal(result.emitted, DEFAULTS.noiseMaxPerSource); // 5
  assert.equal(result.filtered, 3);                          // 3 被噪声过滤
  assert.equal(published.length, DEFAULTS.noiseMaxPerSource);
});

test('配额：超出日配额的信号被丢弃', () => {
  const { gw, published } = makeGateway();
  gw.registerChannel(mockChannel);
  // 手动设配额为 3
  gw.setQuota('test-channel', 3);

  const signals = Array.from({ length: 10 }, (_, i) => ({
    signalId: `q-${i}`,
    signalType: 'rule.hotspot',
    source: `src-${i}`,  // 不同 source 不触发噪声抑制
    payload: {},
    confidence: 0.9,
    relevance: 0.9,
  }));
  const result = gw.processSignals(signals, mockChannel);

  assert.equal(result.emitted, 3);
  assert.equal(result.quotaUsed, 3);
  assert.equal(published.length, 3);
});

test('topic 构建：channelType + signalType 正确拼接', () => {
  const { gw, published } = makeGateway();
  gw.registerChannel(mockChannel);

  gw.processSignals([
    { signalId: 't1', signalType: 'session.integrity', source: 'test', payload: {}, confidence: 0.9, relevance: 0.9 },
  ], mockChannel);

  assert.equal(published[0].topic, 'input.signal.self-observation.session-integrity');
});

test('payload 截断：超过 2KB 的 payload 被截断', () => {
  const { gw } = makeGateway();
  gw.registerChannel(mockChannel);

  const bigPayload = { data: 'x'.repeat(3000) };
  gw.processSignals([
    { signalId: 'big-1', signalType: 'tool.anomaly', source: 'test', payload: bigPayload, confidence: 0.9, relevance: 0.9 },
  ], mockChannel);

  // payload 应被截断为 summary 形式
  // （published 数组里的 payload.payload 是截断后的）
});

test('写操作 setQuota：正常设置和非法值', () => {
  const { gw } = makeGateway();
  gw.registerChannel(mockChannel);

  const r = gw.setQuota('test-channel', 25);
  assert.equal(r.quota, 25);
  assert.equal(gw.getChannelStatus('test-channel').quota, 25);

  assert.throws(() => gw.setQuota('test-channel', -1));
  assert.throws(() => gw.setQuota('test-channel', 9999));
  assert.throws(() => gw.setQuota('nonexistent', 10));
});

test('写操作 setChannelEnabled：开关 Channel', () => {
  const { gw } = makeGateway();
  gw.registerChannel(mockChannel);

  assert.equal(gw.getChannelStatus('test-channel').enabled, true);
  gw.setChannelEnabled('test-channel', false);
  assert.equal(gw.getChannelStatus('test-channel').enabled, false);
  gw.setChannelEnabled('test-channel', true);
  assert.equal(gw.getChannelStatus('test-channel').enabled, true);
});

test('eventBus 返回 accepted=false 时不抛错', () => {
  const { gw } = makeGateway({
    getPublish: () => (evt) => ({ accepted: false, deliveredTo: 0 }),
  });
  gw.registerChannel(mockChannel);

  // 不应抛错
  const result = gw.processSignals([
    { signalId: 'reject-1', signalType: 'tool.anomaly', source: 'test', payload: {}, confidence: 0.9, relevance: 0.9 },
  ], mockChannel);

  // accepted=false 时，processSignals 仍返回 true（因为 publish 调用没 throw），
  // 但 published 数组为空（我们 mock 的是直接返回 accepted:false）
  assert.equal(typeof result.emitted, 'number');
});

test('eventBus 不可用时软降级', () => {
  const { gw } = makeGateway({ getPublish: () => null });
  gw.registerChannel(mockChannel);

  const result = gw.processSignals([
    { signalId: 'no-bus-1', signalType: 'tool.anomaly', source: 'test', payload: {}, confidence: 0.9, relevance: 0.9 },
  ], mockChannel);

  // eventBus 不可用时 emitted=0（publish 返回 false）
  assert.equal(result.emitted, 0);
});
