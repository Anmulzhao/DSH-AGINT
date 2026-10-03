/**
 * prediction-locker 单测（Phase 1.1 支点 1a）。
 *
 * 这一层的全部价值在两件事，测试就只围着它们转：
 *   A. **永不抛** —— 主循环敢把它放在 commit 之前的唯一前提。
 *   B. **锁是真的能验** —— 落表的 hypothesisLock 必须能用 Ledger 条目里
 *      那几段字段重算回来（否则 1b 的归档校验永远判红，等于锁了个死结）。
 *
 * mock 复刻真实契约：bus 返回 `{accepted, envelopeId}`（bus.js:163-169）、
 * recordContractLock 的不可覆盖语义（evolution-memory/lib/index.js:397）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPredictionLocker,
  buildLockHypothesis,
  PREDICTION_LOCK_STATUS,
} from '../lib/prediction-locker.js';
import { computeHypothesisLock, verifyHypothesisLock } from '../lib/predictor.js';
import { buildLedgerEntry } from '../lib/ledger-writer.js';

const NOW = '2026-10-03T09:00:00.000Z';
const CONTRACT_ID = 'p-1';

// ── 替身 ────────────────────────────────────────────────────────────────

function makeLockStore({ throws = null } = {}) {
  const store = new Map();
  const calls = [];
  return {
    store,
    calls,
    recordContractLock: async (input) => {
      calls.push(input);
      if (throws) throw new Error(throws);
      const { contractId } = input;
      if (store.has(contractId)) throw new Error('contract-lock-already-exists');
      const entry = {
        contractId,
        hypothesisLock: input.hypothesisLock,
        lockAlgorithm: 'sha256',
        lockedAt: input.lockedAt,
        predictionSource: input.predictionSource ?? null,
        lockEventId: input.lockEventId ?? null,
      };
      store.set(contractId, entry);
      return { ...entry };
    },
    getContractLock: async (id) => (store.has(id) ? { ...store.get(id) } : null),
  };
}

function makeBus() {
  const published = [];
  return {
    published,
    publish: async (input) => {
      const accepted = typeof input?.topic === 'string' && typeof input?.source === 'string';
      const envelopeId = `env-${published.length + 1}`;
      published.push({ ...input, envelopeId, accepted });
      return accepted ? { accepted: true, envelopeId } : { accepted: false };
    },
  };
}

function makeCtx({ evolution = null, bus = null, getThrows = false } = {}) {
  const ctx = {
    get: (name) => {
      if (getThrows) throw new Error(`ctx.get(${name}) 挂了`);
      if (name === 'agint.evolution') return evolution;
      if (name === 'agint.eventBus.publish') return bus?.publish ?? null;
      return null;
    },
  };
  return ctx;
}

function recorder() {
  const warns = [];
  return { warns, warn: (msg, extra) => warns.push({ msg, extra }) };
}

const baseInput = {
  contractId: CONTRACT_ID,
  mutationType: 'PROMPT_MUTATION',
  targetMetric: 'SUCCESS_RATE',
  changedComponents: ['agint-demo'],
};

// ── A. 成功形状 ─────────────────────────────────────────────────────────

test('锁定成功：DEFAULT_RULE 预测入库 + 凭证齐全（locked 只在这一条路径上出现）', async () => {
  const store = makeLockStore();
  const bus = makeBus();
  const { warn, warns } = recorder();
  const locker = createPredictionLocker(makeCtx({ evolution: store, bus }), { warn, now: () => NOW });

  const r = await locker.lock(baseInput);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.locked, true);
  assert.equal(r.status, PREDICTION_LOCK_STATUS.LOCKED);
  assert.equal(r.predictedDelta, 1.0, 'DEFAULT_RULE 表 DR-PROMPT-SUCCESS 的值');
  assert.equal(r.predictionSource, 'DEFAULT_RULE');
  assert.equal(r.confidence, 0.2);
  assert.equal(r.createdAt, NOW, 'createdAt 用注入的时间源（可复现才有可比对）');
  assert.match(r.hypothesisLock, /^sha256:[0-9a-f]{64}$/);
  assert.equal(warns.length, 0, '成功不该留 warn');

  // 落表形状
  assert.equal(store.store.size, 1);
  const row = store.store.get(CONTRACT_ID);
  assert.equal(row.lockedAt, NOW);
  assert.equal(row.predictionSource, 'DEFAULT_RULE');
  assert.equal(row.lockEventId, 'env-1', '锁事件的 envelopeId 必须进表（接不回总线的事件等于没发）');

  // 事件形状：单参数 + 字面 topic
  assert.equal(bus.published.length, 1);
  assert.equal(bus.published[0].topic, 'evolution.contract.locked');
  assert.equal(bus.published[0].source, 'agint-evolution-driver');
  assert.equal(bus.published[0].payload.contractId, CONTRACT_ID);
  assert.equal(bus.published[0].payload.hypothesisLock, r.hypothesisLock);
});

test('⛔ 落盘的 hash 可复原：只用 Ledger 条目里那几段字段重算必须逐字节相同', async () => {
  const store = makeLockStore();
  const locker = createPredictionLocker(makeCtx({ evolution: store, bus: makeBus() }), { now: () => NOW });
  const r = await locker.lock(baseInput);

  // 模拟 1b 归档时手里只有的一切：Ledger 条目 + contract_locks 行
  const entry = buildLedgerEntry({
    proposal: { id: CONTRACT_ID, kind: 'PROMPT_MUTATION' },
    variant: { variant_id: 'v-1', generation: 1, expected_effect: { metric: 'SUCCESS_RATE' } },
    outcome: { decision: 'AUTO_DEPLOY', path: 'plugins/agint-demo/lib/index.js', timestamp: NOW },
    prediction: r,
  }).entry;
  const row = store.store.get(CONTRACT_ID);

  const recomputed = computeHypothesisLock({
    contractId: entry.contractId,
    createdAt: row.lockedAt,
    hypothesis: {
      ...buildLockHypothesis({
        mutationType: entry.summary.mutationType,
        targetMetric: entry.summary.targetMetric,
        changedComponents: entry.summary.changedPlugins,
      }),
      predictedDelta: entry.summary.predictedDelta,
      predictionSource: entry.summary.predictionSource,
    },
  });
  assert.equal(recomputed, row.hypothesisLock, '复原不回来的锁 = 1b 一跑就假判篡改');

  const v = verifyHypothesisLock({
    storedLock: row.hypothesisLock,
    hypothesis: JSON.parse(JSON.stringify({
      mutationType: entry.summary.mutationType,
      targetMetric: entry.summary.targetMetric,
      changedComponents: entry.summary.changedPlugins.map((p) => ({ pluginName: p })),
      predictedDelta: entry.summary.predictedDelta,
      predictionSource: entry.summary.predictionSource,
    })),
    contractId: entry.contractId,
    createdAt: row.lockedAt,
  });
  assert.equal(v.ok, true, `verifyHypothesisLock 判红：${v.reason}`);
});

test('⛔ 内容动一个字就必须判篡改（锁的语义没被接线稀释）', async () => {
  const store = makeLockStore();
  const locker = createPredictionLocker(makeCtx({ evolution: store, bus: makeBus() }), { now: () => NOW });
  const r = await locker.lock(baseInput);
  const row = store.store.get(CONTRACT_ID);
  const v = verifyHypothesisLock({
    storedLock: row.hypothesisLock,
    hypothesis: {
      mutationType: 'PROMPT_MUTATION',
      targetMetric: 'SUCCESS_RATE',
      changedComponents: [{ pluginName: 'agint-demo' }],
      predictedDelta: 1.5, // 事后改掉预测值
      predictionSource: 'DEFAULT_RULE',
    },
    contractId: CONTRACT_ID,
    createdAt: NOW,
  });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'CONTRACT_TAMPERED');
});

test('bus 不可用时锁定仍然落表（观测失败不阻断信任根），lockEventId 留 null', async () => {
  const store = makeLockStore();
  const { warn, warns } = recorder();
  const locker = createPredictionLocker(makeCtx({ evolution: store, bus: null }), { warn, now: () => NOW });
  const r = await locker.lock(baseInput);
  assert.equal(r.ok, true);
  assert.equal(r.lockEventId, null, '发不出事件就是真缺，不能编一个 id');
  assert.equal(store.store.get(CONTRACT_ID).lockEventId, null);
  assert.equal(warns.length, 0, '这条路径是设计允许的降级，不额外告警');
});

// ── B. 永不抛：四类跳过 ─────────────────────────────────────────────────

test('生产实况：metric=unspecified ⇒ NO_PREDICTION_AVAILABLE 且**不写锁行**', async () => {
  const store = makeLockStore();
  const locker = createPredictionLocker(makeCtx({ evolution: store, bus: makeBus() }), { now: () => NOW });
  const r = await locker.lock({ ...baseInput, targetMetric: 'unspecified' });
  assert.equal(r.ok, false);
  assert.equal(r.status, PREDICTION_LOCK_STATUS.NO_PREDICTION);
  assert.equal(store.calls.length, 0, '无预测就不许占一行锁（表里的"覆盖"必须是真覆盖）');
  assert.equal(r.detail.targetMetric, 'unspecified', '跳过要说清卡在哪个指标上');
  assert.ok(Array.isArray(r.detail.attempts) && r.detail.attempts.length === 3,
    '三级降级链每一级的原因都要留（否则 L1 缺省值会被误读成系统预测能力）');
});

test('锁服务不可用 ⇒ LOCK_UNAVAILABLE + warn，不抛', async () => {
  const { warn, warns } = recorder();
  const locker = createPredictionLocker(makeCtx({ evolution: null }), { warn, now: () => NOW });
  const r = await locker.lock(baseInput);
  assert.equal(r.ok, false);
  assert.equal(r.status, PREDICTION_LOCK_STATUS.UNAVAILABLE);
  assert.equal(warns.length, 1, '通道不可用必须可见（纪律 3）');
  assert.match(warns[0].msg, /跳过锁定/);
});

test('落表抛错（非"已锁"）⇒ LOCK_FAILED + warn，不抛', async () => {
  const store = makeLockStore({ throws: 'STORAGE_DOMAIN_READONLY' });
  const { warn, warns } = recorder();
  const locker = createPredictionLocker(makeCtx({ evolution: store, bus: makeBus() }), { warn, now: () => NOW });
  const r = await locker.lock(baseInput);
  assert.equal(r.ok, false);
  assert.equal(r.status, PREDICTION_LOCK_STATUS.FAILED);
  assert.match(r.reason, /STORAGE_DOMAIN_READONLY/);
  assert.equal(warns.length, 1);
  assert.match(warns[0].msg, /锁定失败/);
});

test('同 contractId 重跑 ⇒ ALREADY_LOCKED，不重复写、不抛', async () => {
  const store = makeLockStore();
  const { warn, warns } = recorder();
  const locker = createPredictionLocker(makeCtx({ evolution: store, bus: makeBus() }), { warn, now: () => NOW });
  const first = await locker.lock(baseInput);
  const second = await locker.lock(baseInput);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.status, PREDICTION_LOCK_STATUS.ALREADY_LOCKED);
  assert.equal(second.locked, undefined, '重放不得再产出"已锁"凭证 —— 否则 Ledger 会二次入链同一份预测');
  assert.equal(store.store.size, 1, '不可覆盖语义没被外壳削弱');
  assert.match(warns.at(-1).msg, /已锁过/);
});

test('contractId 缺失 ⇒ NO_CONTRACT_ID，不碰任何依赖', async () => {
  let touched = 0;
  const ctx = { get: () => { touched += 1; return makeLockStore(); } };
  const locker = createPredictionLocker(ctx, { now: () => NOW });
  const r = await locker.lock({ mutationType: 'PROMPT_MUTATION', targetMetric: 'SUCCESS_RATE' });
  assert.equal(r.ok, false);
  assert.equal(r.status, PREDICTION_LOCK_STATUS.NO_CONTRACT_ID);
  assert.equal(touched, 0);
});

test('依赖取用本身抛错 ⇒ 外壳兜住成 LOCK_FAILED（永不抛是硬契约）', async () => {
  const { warn, warns } = recorder();
  const locker = createPredictionLocker(makeCtx({ getThrows: true }), { warn, now: () => NOW });
  const r = await locker.lock(baseInput);
  assert.equal(r.ok, false);
  assert.equal(r.status, PREDICTION_LOCK_STATUS.FAILED);
  assert.match(r.reason, /ctx\.get/);
  assert.match(warns.at(-1).msg, /意外抛错/);
});

test('空输入（无参调用）不炸：返回 NO_CONTRACT_ID', async () => {
  const locker = createPredictionLocker(makeCtx({}), {});
  const r = await locker.lock();
  assert.equal(r.ok, false);
  assert.equal(r.status, PREDICTION_LOCK_STATUS.NO_CONTRACT_ID);
});

// ── C. hypothesis 形状（可复原性的来源）────────────────────────────────

test('buildLockHypothesis 只含三个字段，且 changedComponents 归一成 {pluginName}', () => {
  const h = buildLockHypothesis({
    mutationType: 'TOOL_SYNTHESIS',
    targetMetric: 'TOKEN_EFFICIENCY',
    changedComponents: ['agint-a', { pluginName: 'agint-b' }, {}, null],
  });
  assert.deepEqual(Object.keys(h).sort(), ['changedComponents', 'mutationType', 'targetMetric']);
  assert.deepEqual(h.changedComponents, [{ pluginName: 'agint-a' }, { pluginName: 'agint-b' }],
    '字符串与对象两种写法都收；没有名字的条目丢掉（空 pluginName 会污染类比桶）');
  assert.deepEqual(buildLockHypothesis({ mutationType: 'X', targetMetric: null }).changedComponents, []);
  assert.equal(buildLockHypothesis({ mutationType: 'X', targetMetric: null }).targetMetric, null);
});

test('同一输入两次锁定得到同一个 hash（纯函数没被时钟之外的东西污染）', async () => {
  const a = createPredictionLocker(makeCtx({ evolution: makeLockStore(), bus: makeBus() }), { now: () => NOW });
  const b = createPredictionLocker(makeCtx({ evolution: makeLockStore(), bus: makeBus() }), { now: () => NOW });
  const ra = await a.lock(baseInput);
  const rb = await b.lock(baseInput);
  assert.equal(ra.hypothesisLock, rb.hypothesisLock);
});
