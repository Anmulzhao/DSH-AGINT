/**
 * contract 锁测试（Phase 1 交付物 1 §2.4.2 接线层）。
 *
 * 覆盖两段：
 *   A. 存储层（agint-evolution-memory）：contract_locks 表 + 三个 Service
 *   B. 接线层（agint-evolution-driver）：锁预测 → 落表 → 发事件 → 归档校验
 *
 * mock 范式复用 `agint-compress-guard/test/_helpers.mjs`（内存版 storage domain），
 * 不挂 Cordis、不开真实域 —— 与全仓 smoke 同策略。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTable, makeDomain, makeEventBus } from '../../agint-compress-guard/test/_helpers.mjs';
import { contractLockEntrySchema, LIMITS } from '../../agint-evolution-memory/lib/schema.js';
import { createContractManager, CONTRACT_LOCK_TOPIC } from '../lib/contract-manager.js';

// ── A. 存储层 ──────────────────────────────────────────────────────────

test('contractLockEntrySchema: 接受合法锁记录', () => {
  const e = contractLockEntrySchema.parse({
    hypothesisLock: `sha256:${'a'.repeat(64)}`,
    lockAlgorithm: 'sha256',
    contractId: 'EVO-2026-001',
    lockedAt: '2026-10-02T04:15:00Z',
    predictionSource: 'DEFAULT_RULE',
    lockEventId: 'evt_1',
  });
  assert.equal(e.contractId, 'EVO-2026-001');
  assert.equal(e.lockAlgorithm, 'sha256');
});

test('contractLockEntrySchema: lockEventId / predictionSource 可缺省为 null', () => {
  const e = contractLockEntrySchema.parse({
    hypothesisLock: `sha256:${'b'.repeat(64)}`,
    lockAlgorithm: 'sha256',
    contractId: 'EVO-2026-002',
    lockedAt: '2026-10-02T04:15:00Z',
  });
  assert.equal(e.lockEventId, null);
  assert.equal(e.predictionSource, null);
});

test('⛔ contractLockEntrySchema: 非 sha256 前缀的锁被拒（防换算法绕过校验）', () => {
  for (const bad of [`md5:${'a'.repeat(32)}`, `${'a'.repeat(64)}`, 'sha256:xyz', `sha256:${'A'.repeat(64)}`]) {
    assert.throws(() => contractLockEntrySchema.parse({
      hypothesisLock: bad,
      lockAlgorithm: 'sha256',
      contractId: 'C',
      lockedAt: 'T',
    }), undefined, `未拦截 ${bad}`);
  }
});

test('⛔ contractLockEntrySchema: lockAlgorithm 是封闭 enum', () => {
  assert.throws(() => contractLockEntrySchema.parse({
    hypothesisLock: `sha256:${'a'.repeat(64)}`,
    lockAlgorithm: 'md5',
    contractId: 'C',
    lockedAt: 'T',
  }));
});

test('⛔ contractLockEntrySchema: predictionSource 是封闭 enum（脏值拒绝）', () => {
  for (const s of ['LLM_GUESS', 'knowledge_base', '', null]) {
    const e = contractLockEntrySchema.safeParse({
      hypothesisLock: `sha256:${'a'.repeat(64)}`,
      lockAlgorithm: 'sha256',
      contractId: 'C',
      lockedAt: 'T',
      predictionSource: s ?? undefined,
    });
    if (s === null) assert.equal(e.success, true, '显式 null 允许（无预测来源）');
    else assert.equal(e.success, false, `未拦截 ${s}`);
  }
});

test('LIMITS.CONTRACT_LOCKS 已定义且为正', () => {
  assert.ok(Number.isInteger(LIMITS.CONTRACT_LOCKS) && LIMITS.CONTRACT_LOCKS > 0);
});

// ── 测试用的存储层替身（复刻 recordContractLock 的不可覆盖语义）────────

/**
 * 用真实的 schema + 真实的不可覆盖逻辑搭一个 in-memory 替身。
 * 刻意**不 mock 掉覆盖检查** —— 那是本测试要守的核心行为。
 */
function makeLockStore() {
  const t = makeTable();
  return {
    table: t,
    async recordContractLock({ contractId, hypothesisLock, lockedAt, predictionSource = null, lockEventId = null }) {
      if (t.get(contractId)) throw new Error('contract-lock-already-exists');
      const entry = contractLockEntrySchema.parse({
        hypothesisLock, lockAlgorithm: 'sha256', contractId, lockedAt,
        predictionSource: predictionSource ?? null, lockEventId: lockEventId ?? null,
      });
      await t.put(entry.contractId, entry);
      return { ...entry };
    },
    async getContractLock(id) {
      const r = t.get(id);
      return r ? { ...r } : null;
    },
    async listContractLocks() {
      return [...t.entries()].map(([, v]) => ({ ...v }));
    },
  };
}

test('存储层: 落锁后可读回，字段完整', async () => {
  const s = makeLockStore();
  const lock = `sha256:${'c'.repeat(64)}`;
  await s.recordContractLock({ contractId: 'EVO-1', hypothesisLock: lock, lockedAt: 'T1', predictionSource: 'ANALOGY', lockEventId: 'evt_x' });
  const got = await s.getContractLock('EVO-1');
  assert.equal(got.hypothesisLock, lock);
  assert.equal(got.predictionSource, 'ANALOGY');
  assert.equal(got.lockEventId, 'evt_x');
  assert.equal(got.lockedAt, 'T1');
});

test('⛔ 存储层: 同 contractId 二次锁定必须抛错（不可覆盖）', async () => {
  const s = makeLockStore();
  const lock = `sha256:${'d'.repeat(64)}`;
  await s.recordContractLock({ contractId: 'EVO-1', hypothesisLock: lock, lockedAt: 'T1' });
  await assert.rejects(
    () => s.recordContractLock({ contractId: 'EVO-1', hypothesisLock: `sha256:${'e'.repeat(64)}`, lockedAt: 'T2' }),
    /contract-lock-already-exists/,
    '重算 hash 覆盖旧值 = 篡改不留痕，必须拒绝',
  );
  // 旧锁必须原样保留
  assert.equal((await s.getContractLock('EVO-1')).hypothesisLock, lock);
});

test('存储层: 缺失返回 null（缺失≠通过，由 caller 判红）', async () => {
  const s = makeLockStore();
  assert.equal(await s.getContractLock('NOPE'), null);
  assert.equal(await s.getContractLock(''), null);
  assert.equal(await s.getContractLock(undefined), null);
});

test('存储层: listContractLocks 列出全部', async () => {
  const s = makeLockStore();
  for (const id of ['A', 'B', 'C']) {
    await s.recordContractLock({ contractId: id, hypothesisLock: `sha256:${'a'.repeat(64)}`, lockedAt: 'T' });
  }
  assert.equal((await s.listContractLocks()).length, 3);
  assert.equal(s.table.size, 3);
});

test('存储层: 缺必填字段一律拒绝（fail-closed）', async () => {
  const s = makeLockStore();
  const lock = `sha256:${'a'.repeat(64)}`;
  await assert.rejects(() => s.recordContractLock({ hypothesisLock: lock, lockedAt: 'T' }), /contractId/);
  await assert.rejects(() => s.recordContractLock({ contractId: 'X', lockedAt: 'T' }), /hypothesisLock/);
  await assert.rejects(() => s.recordContractLock({ contractId: 'X', hypothesisLock: lock }), /lockedAt/);
});

// ── B. 接线层 ──────────────────────────────────────────────────────────

/** 组一个带内存域 + mock 总线的 ctx，返回 manager 与观测句柄。 */
function makeManager({ withEvolution = true, withBus = true } = {}) {
  const store = makeLockStore();
  const bus = makeEventBus();
  const services = new Map();
  if (withEvolution) services.set('agint.evolution', store);
  if (withBus) services.set('agint.eventBus.publish', bus.publish);
  const ctx = {
    get(name) { return services.get(name) ?? null; },
  };
  return { manager: createContractManager(ctx), store, bus, services };
}

const INPUT = {
  contractId: 'EVO-2026-001',
  createdAt: '2026-10-02T04:15:00Z',
  hypothesis: {
    summary: '记忆检索精度优化',
    targetMetric: 'SUCCESS_RATE',
    changedComponents: [{ pluginName: 'agint-memory', filesChanged: ['r.js'], changeType: 'MODIFY' }],
  },
  mutationType: 'PROMPT_MUTATION',
  targetMetric: 'SUCCESS_RATE',
};

test('接线层: lockPrediction 落表 + 发事件 + 返回锁定用的 hypothesis', async () => {
  const { manager, store, bus } = makeManager();
  const { lock, prediction } = await manager.lockPrediction(INPUT);

  // 落表
  const rec = await store.getContractLock(INPUT.contractId);
  assert.ok(rec, '锁必须落表');
  assert.equal(rec.hypothesisLock, lock.hypothesisLock);
  // 发事件
  const locked = bus.envelopes.filter((e) => e.topic === CONTRACT_LOCK_TOPIC);
  assert.equal(locked.length, 1, '恰好发一次 locked 事件');
  assert.equal(locked[0].payload.contractId, INPUT.contractId);
  assert.equal(locked[0].payload.hypothesisLock, lock.hypothesisLock);
  // 返回值带锁定时用的 hypothesis（归档校验必须用同一份）
  assert.equal(prediction.hypothesis.contractId, undefined);
  assert.equal(typeof prediction.hypothesis.predictedDelta, 'number');
  assert.ok(prediction.predictionSource);
});

test('接线层: ⛔ 事件不可撤回 —— 事件先于表发出（表失败时外部已有见证）', async () => {
  const { manager, store, bus } = makeManager();
  await manager.lockPrediction(INPUT);
  // 复刻时序：先 publish 后 put。改 store 让 put 抛错，验证事件已发。
  const origPut = store.table.put.bind(store.table);
  store.table.put = async () => { throw new Error('disk full'); };
  await assert.rejects(() => manager.lockPrediction({ ...INPUT, contractId: 'EVO-2' }), /disk full/);
  store.table.put = origPut;
  assert.equal(bus.envelopes.filter((e) => e.topic === CONTRACT_LOCK_TOPIC).length, 2,
    '表写失败时事件仍已发出 ⇒ 存在一份外部见证');
  assert.equal(await store.getContractLock('EVO-2'), null, '表里确实没有（写入失败了）');
});

test('接线层: 事件 topic 用字面量（扫描器依赖，见 CONTRACT_LOCK_TOPIC 注释）', async () => {
  const { manager, bus } = makeManager();
  await manager.lockPrediction(INPUT);
  const e = bus.envelopes.find((x) => x.topic === 'evolution.contract.locked');
  assert.ok(e, 'publish 处必须写字面量 topic，否则 verify-event-topics 扫不到');
});

test('接线层: 总线不可用时仍能锁定（观测失败不阻断主流程）', async () => {
  const { manager, store } = makeManager({ withBus: false });
  const { lock } = await manager.lockPrediction(INPUT);
  assert.ok(lock.hypothesisLock);
  assert.equal((await store.getContractLock(INPUT.contractId)).lockEventId, null,
    '事件发不出时 lockEventId 为 null，可事后查');
});

test('⛔ 接线层: agint.evolution 不可用 ⇒ 抛错中止（不降级为无锁继续）', async () => {
  const { manager } = makeManager({ withEvolution: false });
  await assert.rejects(() => manager.lockPrediction(INPUT), /agint\.evolution 不可用/);
});

test('⛔ 接线层: 缺 createdAt ⇒ 抛错（纯函数不取时钟，caller 必须传）', async () => {
  const { manager } = makeManager();
  const { createdAt, ...noTime } = INPUT;
  await assert.rejects(() => manager.lockPrediction(noTime), /createdAt/);
});

test('⛔ 接线层: 缺 contractId / hypothesis ⇒ 抛错', async () => {
  const { manager } = makeManager();
  const { contractId, ...noId } = INPUT;
  await assert.rejects(() => manager.lockPrediction(noId), /contractId/);
  const { hypothesis, ...noHyp } = INPUT;
  await assert.rejects(() => manager.lockPrediction(noHyp), /hypothesis/);
});

test('接线层: 二次锁定同 contractId 被拒（锁不可覆盖，端到端生效）', async () => {
  const { manager } = makeManager();
  await manager.lockPrediction(INPUT);
  await assert.rejects(
    () => manager.lockPrediction({ ...INPUT, createdAt: '2026-10-03T04:15:00Z' }),
    /contract-lock-already-exists/,
  );
});

// ── 归档校验 ───────────────────────────────────────────────────────────

test('归档校验: 未篡改 ⇒ VERIFIED', async () => {
  const { manager } = makeManager();
  const { lock, prediction } = await manager.lockPrediction(INPUT);
  const r = await manager.verifyLock({ ...INPUT, hypothesis: prediction.hypothesis });
  assert.equal(r.verified, true);
  assert.equal(r.status, 'VERIFIED');
  assert.equal(r.reason, null);
  assert.equal(r.storedLock, lock.hypothesisLock);
});

test('归档校验: ⛔ 篡改预测值 ⇒ CONTRACT_TAMPERED', async () => {
  const { manager } = makeManager();
  const { prediction } = await manager.lockPrediction(INPUT);
  const tampered = { ...prediction.hypothesis, predictedDelta: 99 };
  const r = await manager.verifyLock({ ...INPUT, hypothesis: tampered });
  assert.equal(r.verified, false);
  assert.equal(r.status, 'CONTRACT_TAMPERED');
  assert.equal(r.reason, 'CONTRACT_TAMPERED');
  assert.notEqual(r.recomputed, r.storedLock);
  assert.ok(r.recomputed, '仍返回重算值供人工取证');
});

test('归档校验: 漏传 predictedDelta（hypothesis 变了）⇒ 判篡改', async () => {
  const { manager } = makeManager();
  const { prediction } = await manager.lockPrediction(INPUT);
  const { predictedDelta, ...stripped } = prediction.hypothesis;
  const r = await manager.verifyLock({ ...INPUT, hypothesis: stripped });
  assert.equal(r.verified, false, '少一个字段也是 hypothesis 变了，必须判红');
});

test('归档校验: 无锁记录 ⇒ LOCK_MISSING（缺失≠通过）', async () => {
  const { manager } = makeManager();
  const r = await manager.verifyLock(INPUT);
  assert.equal(r.verified, false);
  assert.equal(r.status, 'LOCK_MISSING');
  assert.equal(r.reason, 'LOCK_MISSING');
  assert.equal(r.storedLock, null);
  assert.equal(r.recomputed, null);
});

test('归档校验: 改 createdAt ⇒ 判篡改；改 contractId ⇒ 查的是另一把锁 ⇒ LOCK_MISSING', async () => {
  const { manager } = makeManager();
  const { prediction } = await manager.lockPrediction(INPUT);

  // createdAt 参与摘要 ⇒ 同一把锁下改时间即篡改
  const b = await manager.verifyLock({ ...INPUT, createdAt: '2026-01-01T00:00:00Z', hypothesis: prediction.hypothesis });
  assert.equal(b.status, 'CONTRACT_TAMPERED');
  assert.equal(b.reason, 'CONTRACT_TAMPERED');

  // ⛔ contractId 是**主键**：改它等于去查另一条记录，不是「篡改同一把锁」。
  // 这不是漏洞而是正确行为 —— 攻击者改 contractId 只会让自己的锁查不到，
  // 想冒充就得真的去锁一个假 ID，而那会留下他自己的锁记录（contract_locks 里多一行）。
  // 报告口径：这类应记 LOCK_MISSING，由 Growth Report 显式呈现「该 Contract 无锁」。
  const a = await manager.verifyLock({ ...INPUT, contractId: 'EVO-OTHER', hypothesis: prediction.hypothesis });
  assert.equal(a.status, 'LOCK_MISSING');
  assert.equal(a.storedLock, null);
});

test('⛔ 归档校验: agint.evolution 不可用 ⇒ 抛错（不返回「通过」）', async () => {
  const { manager } = makeManager();
  await manager.lockPrediction(INPUT);
  const { manager: bare } = makeManager({ withEvolution: false });
  await assert.rejects(() => bare.verifyLock(INPUT), /agint\.evolution 不可用/);
});

test('getPredictionSource: 读出锁里记录的来源（报告需区分先验/类比/缺省）', async () => {
  const { manager } = makeManager();
  const { prediction } = await manager.lockPrediction(INPUT);
  assert.equal(await manager.getPredictionSource(INPUT.contractId), prediction.predictionSource);
  assert.equal(await manager.getPredictionSource('NOPE'), null);
});

test('端到端: 预测→锁定→篡改→检测 全链路', async () => {
  const { manager, store } = makeManager();
  const { lock, prediction } = await manager.lockPrediction(INPUT);

  // 1. 锁定成功且表里有唯一一条
  const all = await store.listContractLocks();
  assert.equal(all.length, 1);
  assert.equal(all[0].hypothesisLock, lock.hypothesisLock);

  // 2. 原样归档 ⇒ 通过
  assert.equal((await manager.verifyLock({ ...INPUT, hypothesis: prediction.hypothesis })).verified, true);

  // 3. 事后把预测改成 99 ⇒ 检出
  const bad = await manager.verifyLock({
    ...INPUT, hypothesis: { ...prediction.hypothesis, predictedDelta: 99 },
  });
  assert.equal(bad.status, 'CONTRACT_TAMPERED');

  // 4. ⛔ 不自动修复：表里的锁原样未动
  const after = await store.getContractLock(INPUT.contractId);
  assert.equal(after.hypothesisLock, lock.hypothesisLock, '校验失败后不得重写历史');
});
