/**
 * agint-evolution-memory: Frozen 基准集快照（Phase 0.1 / Sprint 19）
 *
 * 覆盖的是**写入侧纪律**，不是哈希数学（哈希在 bin/lib/scenario-tier.test.mjs）：
 *   纪律 1 只增不改     → 同 setId 二次写入抛错，表内行数不变
 *   纪律 2 不静默补默认 → 缺 source / hash 形状非法 ⇒ 抛，不落盘
 *   纪律 3 缺失≠通过    → get 返回 null、verify 返回 UNKNOWN，绝不 ok:true
 *   纪律 4 只 warn 不删 → 超上限仍保留全部行
 *   纪律 5 空集合法     → 首期还没分配 Frozen 就是空，空不是异常
 *
 * 表句柄形状对齐宿主真实 API（dsh-storage-domain/lib/index.js:229-260 的
 * KvTableImpl）：`entries()` 返回 **[key, value] 迭代器**、`get` 返回存活对象、
 * `size` 是 getter、**没有 has()**。mock 偏离这个形状测试就失真。
 *
 * Run: node --test plugins/agint-evolution-memory/test/frozen-set.test.mjs
 *
 * ## SELF_PROOF（红绿自证记录，2026-10-03）
 *
 * 下面每条判据都做过「放宽 ⇒ 必须变红」的实验，实测结果记在这里：
 *   1. 去掉 setId 去重检查      → 红 1（只增不改被绕过）
 *   2. hash 正则放宽成任意串    → 红 1（形状门失效）
 *   3. verify 缺失改成 ok:true  → 红 1（假防线）
 *   4. 超限改成真删行           → 红 1（历史被抹）
 *   5. list 排序去掉            → 红 1（H5 序列核对依赖升序）
 * ⚠️ 跑自证必须用 `node --test --test-reporter=tap`：非 TTY 子进程下 node --test
 *    会退化成 spec reporter（只打印 ✔），脚本读不到 `not ok` 就会误判「没红」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFrozenSetService, deriveSetId, diffFrozenIds } from '../lib/frozen-set.js';
import { LIMITS } from '../lib/schema.js';

const FIXED_NOW = () => '2026-10-03T11:00:00.000Z';
const HASH_A = 'sha256:' + 'a'.repeat(64);
const HASH_B = 'sha256:' + 'b'.repeat(64);

/** 忠实仿宿主表句柄的内存表，并记录写次数。 */
function makeTable() {
  const records = new Map();
  const writes = [];
  return {
    records,
    writes,
    entries: () => [...records.entries()][Symbol.iterator](),
    keys: () => [...records.keys()][Symbol.iterator](),
    get: (k) => records.get(k),
    get size() { return records.size; },
    async put(k, v) { writes.push(k); records.set(k, v); return true; },
  };
}

function makeService(opts = {}) {
  const table = opts.table ?? makeTable();
  const warns = [];
  const bumps = [];
  const svc = createFrozenSetService({
    getTable: opts.getTable ?? (async () => table),
    now: opts.now ?? FIXED_NOW,
    warn: (msg) => warns.push(msg),
    bump: (key) => bumps.push(key),
  });
  return { svc, table, warns, bumps };
}

function payload(over = {}) {
  return {
    capturedAt: '2026-10-03T11:00:00.000Z',
    tieringVersion: '1.0',
    frozenUnitIds: ['u1', 'u2'],
    frozenAggregateHash: HASH_A,
    inventoryTotalUnits: 123,
    failCount: 6,
    h1EvolutionMinFail: 4,
    h3FrozenFailProbeCap: 2,
    source: 'bin/anchor-frozen-set.mjs',
    ...over,
  };
}

test('01 record：落盘并回填 frozenCount（由名单长度推导，不信任 caller）', async () => {
  const { svc, table } = makeService();
  const e = await svc.record(payload({ frozenUnitIds: ['a', 'b', 'c'] }));
  assert.equal(e.setId, 'frozen-2026-10-03T11-00-00-000Z');
  assert.equal(e.frozenCount, 3);
  assert.equal(table.writes.length, 1);
  assert.equal(table.records.get(e.setId).frozenAggregateHash, HASH_A);
});

test('02 record：setId 缺省由 capturedAt 推导，显式给则以显式为准', async () => {
  const { svc } = makeService();
  const a = await svc.record(payload());
  // 字面量钉格式：`2026-10-03T11:00:00.000Z` 的 `:` 与 `.` 各换成一个 `-`
  assert.equal(a.setId, 'frozen-2026-10-03T11-00-00-000Z');
  assert.equal(deriveSetId('2026-10-03T11:00:00.000Z'), a.setId);
  const b = await svc.record(payload({ capturedAt: '2026-10-04T09:00:00.000Z', setId: 'frozen-manual' }));
  assert.equal(b.setId, 'frozen-manual');
  assert.equal(b.capturedAt, '2026-10-04T09:00:00.000Z');
});

test('03 只增不改：同 setId 二次写入抛 frozen-set-already-exists，表内行数不变', async () => {
  const { svc, table } = makeService();
  await svc.record(payload());
  await assert.rejects(
    () => svc.record(payload({ frozenAggregateHash: HASH_B })),
    /frozen-set-already-exists/,
  );
  assert.equal(table.records.size, 1);
  // 关键：旧值没被新 hash 盖掉 —— 盖掉就等于篡改不留痕
  assert.equal(table.records.get('frozen-2026-10-03T11-00-00-000Z').frozenAggregateHash, HASH_A);
});

test('04 形状门：hash 不是 sha256:<64hex> ⇒ 抛，且不落盘', async () => {
  const { svc, table } = makeService();
  await assert.rejects(() => svc.record(payload({ frozenAggregateHash: 'not-a-hash' })));
  await assert.rejects(() => svc.record(payload({ frozenAggregateHash: 'sha256:abc' })));
  assert.equal(table.records.size, 0);
});

test('05 必填门：缺 source（provenance）⇒ 抛，不落盘', async () => {
  const { svc, table } = makeService();
  await assert.rejects(() => svc.record(payload({ source: undefined })));
  assert.equal(table.records.size, 0);
});

test('06 空集合法：首期还没分配 Frozen 时名单为空，不是异常', async () => {
  const { svc } = makeService();
  const e = await svc.record(payload({ frozenUnitIds: [], frozenCount: 0 }));
  assert.deepEqual(e.frozenUnitIds, []);
  assert.equal(e.frozenCount, 0);
});

test('07 get：找不到返回 null（缺失≠通过，由 caller 判）', async () => {
  const { svc } = makeService();
  assert.equal(await svc.get('nope'), null);
  assert.equal(await svc.get(''), null);
  const e = await svc.record(payload());
  assert.equal((await svc.get(e.setId)).frozenAggregateHash, HASH_A);
});

test('08 list：按 capturedAt 升序（H5 序列核对依赖这个顺序）', async () => {
  const { svc } = makeService();
  for (const d of ['2026-10-05T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-03T00:00:00.000Z']) {
    await svc.record(payload({ capturedAt: d }));
  }
  const ids = (await svc.list()).map((r) => r.capturedAt);
  assert.deepEqual(ids, ['2026-10-01T00:00:00.000Z', '2026-10-03T00:00:00.000Z', '2026-10-05T00:00:00.000Z']);
});

test('09 verify：hash 一致 ⇒ INTACT', async () => {
  const { svc } = makeService();
  const e = await svc.record(payload());
  const r = await svc.verify({ setId: e.setId, frozenAggregateHash: HASH_A });
  assert.deepEqual(r, { ok: true, code: 'INTACT' });
});

test('10 verify：hash 变了 ⇒ TAMPERED，且带上 expected/actual 便于归因', async () => {
  const { svc } = makeService();
  const e = await svc.record(payload());
  const r = await svc.verify({ setId: e.setId, frozenAggregateHash: HASH_B });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TAMPERED');
  assert.equal(r.expected, HASH_A);
  assert.equal(r.actual, HASH_B);
});

test('11 verify：快照不存在 ⇒ UNKNOWN（⛔ 不许判成通过）', async () => {
  const { svc } = makeService();
  const r = await svc.verify({ setId: 'nope', frozenAggregateHash: HASH_A });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNKNOWN');
});

test('12 verify：缺 hash / 缺 setId ⇒ 显式报错，不静默放过', async () => {
  const { svc } = makeService();
  assert.equal((await svc.verify({ setId: 'x' })).code, 'MISSING_HASH');
  assert.equal((await svc.verify({ frozenAggregateHash: HASH_A })).code, 'MISSING_SET_ID');
});

test('13 verify：底层取表抛错 ⇒ UNKNOWN，不把异常吞成通过', async () => {
  const { svc } = makeService({ getTable: async () => { throw new Error('domain down'); } });
  const r = await svc.verify({ setId: 'x', frozenAggregateHash: HASH_A });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNKNOWN');
  assert.match(r.detail, /domain down/);
});

test('14 diffFrozenIds：只增不减 ⇒ ok；减了 ⇒ ok=false 且列出被删的', () => {
  assert.deepEqual(diffFrozenIds(['a', 'b'], ['a', 'b', 'c']), { ok: true, removed: [], added: ['c'] });
  const d = diffFrozenIds(['a', 'b', 'c'], ['a', 'c']);
  assert.equal(d.ok, false);
  assert.deepEqual(d.removed, ['b']);
  assert.deepEqual(d.added, []);
});

test('15 超上限：只 warn 不删（删历史 = 自毁防篡改基线）', async () => {
  const { svc, table, warns } = makeService();
  const n = LIMITS.BENCHMARK_FROZEN_SETS + 1;
  for (let i = 0; i < n; i++) {
    await svc.record(payload({
      capturedAt: new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString(),
    }));
  }
  assert.equal(table.records.size, n);
  assert.ok(warns.some((w) => w.includes('只告警不删除')), `应有一条 warn，实得：${JSON.stringify(warns)}`);
});

test('16 工厂守卫：getTable / now 不是函数 ⇒ 立即抛 TypeError', () => {
  assert.throws(() => createFrozenSetService({ getTable: null, now: FIXED_NOW }), TypeError);
  assert.throws(() => createFrozenSetService({ getTable: async () => makeTable(), now: null }), TypeError);
});

test('17 表句柄形状忠实性：entries() 必须是 [key, value] 迭代器（宿主无 has()）', async () => {
  const { svc, table } = makeService();
  await svc.record(payload());
  const it = table.entries();
  const first = it.next().value;
  assert.ok(Array.isArray(first) && first.length === 2, 'entries() 必须产出 [key, value]');
  assert.equal(typeof first[0], 'string');
  assert.equal(first[1].frozenAggregateHash, HASH_A);
  assert.equal(typeof table.has, 'undefined', '宿主 KvTableImpl 没有 has()');
});
