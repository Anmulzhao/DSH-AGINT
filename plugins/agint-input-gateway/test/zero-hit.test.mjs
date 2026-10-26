// 零命中告警测试（2026-10-14）。
//
// 为什么需要它（两个真实案例，都是本次会话撞到的）：
//   1. self-observation 的 streak 判据因 `else { break; }` 恒不触发，而
//      health() 报 5 个检测器全 active、force_fetch 报 ok=true in=0 —— 静默失明。
//   2. 修复后 force_fetch 报 in=1 emitted=1，说明「产得出信号」才是真健康。
//
// 判据是「本次有没有真的产出信号」，不是「有没有跑」—— 后者永远 ok。
//
// ⛔ 纪律：不写占位断言。全部走真实 InputGateway.fetchChannel() 端到端，
//   用 gateway.test.mjs 同款的 makeGateway 工厂（契约复刻，非自造）。

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

const goodSignal = {
  signalId: 's1',
  signalType: 'tool.anomaly',
  source: 'test',
  payload: { detection: 'consecutive_failures', tool: 'pwsh', consecutiveFailures: 5 },
  confidence: 0.9,
  relevance: 0.9,
};

function channelReturning(signals) {
  return {
    id: 'test-channel',
    type: CHANNEL_TYPES.SELF_OBSERVATION,
    cron: '0 2 * * *',
    async fetch() { return signals; },
  };
}

test('取证：fetch 成功但产出 0 条 ⇒ 计入零命中，不是记为「跑过了」', async () => {
  const { gw } = makeGateway();
  gw.registerChannel(channelReturning([]));
  const r = await gw.fetchChannel('test-channel');
  assert.equal(r.ok, true, 'fetch 本身成功');
  assert.equal(r.in, 0);

  const st = await gw.getChannelStatus('test-channel');
  assert.equal(st.zeroHit.consecutiveZeroHit, 1);
  assert.equal(st.zeroHit.status, 'ok', '第 1 次不该告警（阈值 3）');
});

test('⛔ 连续 3 次零命中 ⇒ status=degraded 且带排查方向', async () => {
  const { gw } = makeGateway();
  gw.registerChannel(channelReturning([]));
  for (let i = 0; i < 3; i++) await gw.fetchChannel('test-channel');

  const st = await gw.getChannelStatus('test-channel');
  assert.equal(st.zeroHit.consecutiveZeroHit, 3);
  assert.equal(st.zeroHit.status, 'degraded');
  assert.match(st.zeroHit.reason, /静默失明/, `reason 要给排查方向，实得 ${st.zeroHit.reason}`);
});

test('产出信号 ⇒ 计数归零 + lastNonZeroAt 落时间戳', async () => {
  const { gw } = makeGateway();
  gw.registerChannel(channelReturning([{ ...goodSignal }]));
  await gw.fetchChannel('test-channel');
  let st = await gw.getChannelStatus('test-channel');
  assert.equal(st.zeroHit.consecutiveZeroHit, 0);
  assert.ok(st.zeroHit.lastNonZeroAt, '有信号时要落 lastNonZeroAt');

  // 再来两次零命中，仍不该告警（已归零）
  gw._channels.set('test-channel', channelReturning([]));
  await gw.fetchChannel('test-channel');
  await gw.fetchChannel('test-channel');
  st = await gw.getChannelStatus('test-channel');
  assert.equal(st.zeroHit.consecutiveZeroHit, 2);
  assert.equal(st.zeroHit.status, 'ok');
});

test('kill-switch：zeroHitAlert=false ⇒ 只记数不告警', async () => {
  const { gw } = makeGateway();
  gw.registerChannel(channelReturning([]));
  // 直接改 channel_state 上的开关（生产由 setQuota 同类写操作配置）
  const state = gw._channelState.get('test-channel');
  state.zeroHitAlert = false;
  for (let i = 0; i < 5; i++) await gw.fetchChannel('test-channel');

  const st = await gw.getChannelStatus('test-channel');
  assert.equal(st.zeroHit.consecutiveZeroHit, 5, '计数照常累加');
  assert.equal(st.zeroHit.status, 'ok', 'kill-switch 生效时不告警');
  assert.equal(st.zeroHit.enabled, false);
});

test('阈值可调：zeroHitAlertThreshold=2 ⇒ 第 2 次就告警', async () => {
  const { gw } = makeGateway();
  gw.registerChannel(channelReturning([]));
  const state = gw._channelState.get('test-channel');
  state.zeroHitAlertThreshold = 2;
  await gw.fetchChannel('test-channel');
  await gw.fetchChannel('test-channel');

  const st = await gw.getChannelStatus('test-channel');
  assert.equal(st.zeroHit.threshold, 2);
  assert.equal(st.zeroHit.status, 'degraded');
});

test('⛔ 零命中告警不得阻断 fetch（告警杀死被告警对象是自伤）', async () => {
  const { gw } = makeGateway();
  gw.registerChannel(channelReturning([]));
  for (let i = 0; i < 5; i++) await gw.fetchChannel('test-channel');

  const r = await gw.fetchChannel('test-channel');
  assert.equal(r.ok, true, 'degraded 状态下 fetch 仍须返回成功');
  const st = await gw.getChannelStatus('test-channel');
  assert.equal(st.zeroHit.status, 'degraded');
});

test('状态落在 channel_state（跨重启不丢，内存计数等于摆设）', async () => {
  const { gw } = makeGateway();
  gw.registerChannel(channelReturning([]));
  await gw.fetchChannel('test-channel');
  const state = gw._channelState.get('test-channel');
  assert.equal(state.consecutiveZeroHit, 1, '计数必须写在持久化的 channel_state 上');
});

test('存量记录无 zeroHit 字段 ⇒ 按初始态处理（fail-open，不得炸）', async () => {
  const { gw } = makeGateway();
  gw.registerChannel(channelReturning([]));
  // 模拟生产存量记录：没有 consecutiveZeroHit / lastNonZeroAt 字段
  const state = gw._channelState.get('test-channel');
  delete state.consecutiveZeroHit;
  delete state.lastNonZeroAt;
  await gw.fetchChannel('test-channel');

  const st = await gw.getChannelStatus('test-channel');
  assert.equal(st.zeroHit.consecutiveZeroHit, 1, '缺失字段按 0 起步，不得 undefined/NaN');
});

test('安全不回退：emit 成功时不告警（防「永远在告警」的反向失明）', async () => {
  const { gw } = makeGateway();
  gw.registerChannel(channelReturning([{ ...goodSignal }]));
  for (let i = 0; i < 4; i++) {
    gw._channels.set('test-channel', channelReturning([{ ...goodSignal, signalId: 's' + i }]));
    await gw.fetchChannel('test-channel');
  }
  const st = await gw.getChannelStatus('test-channel');
  assert.equal(st.zeroHit.status, 'ok');
  assert.equal(st.zeroHit.consecutiveZeroHit, 0);
});
