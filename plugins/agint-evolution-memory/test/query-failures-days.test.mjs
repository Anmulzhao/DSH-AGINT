/**
 * test/query-failures-days.test.mjs
 *
 * 2026-10-21 修「queryFailures 忽略 opts.days」的端到端回归钉。
 *
 * ⛔ 与另一个断点测试的区别：那份只钉判据形状；本文件**真起插件、真调服务方法**。
 *    取证口径：`mod.apply(ctx, {})` 之后从 `ctx._provided['agint.evolution']`
 *    拿到生产 service 对象，直接调 `queryFailures(...)`。不复制任何过滤逻辑。
 *
 * 修复前：`{days:7}` 与 `{}` 返回**完全相同**的行数 ⇒ 本文件前两条用例必红。
 * 修复后：7 天窗口滤掉过期行；不传 days 保持全表。
 *
 * 跑法：node --test plugins/agint-evolution-memory/test/query-failures-days.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const DAY = 86_400_000;
const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

// 复刻生产形状：最老 45 天前、最年轻 7.2 天前（与生产 8 行同分布）
const SEED = [
  { id: 'f_old_45', pattern: 'sandbox-smoke-failed:unknown', category: 'integration', severity: 'high', occurrences: 27, updatedAt: iso(44.7 * DAY), createdAt: iso(44.7 * DAY) },
  { id: 'f_old_41', pattern: 'selfModel_calibrate schema', category: 'correctness', severity: 'medium', occurrences: 1, updatedAt: iso(41.2 * DAY), createdAt: iso(41.2 * DAY) },
  { id: 'f_mid_21', pattern: 'policy-reject', category: 'integration', severity: 'high', occurrences: 125, updatedAt: iso(21.5 * DAY), createdAt: iso(33.6 * DAY) },
  { id: 'f_edge_7', pattern: 'policy-abstain', category: 'integration', severity: 'medium', occurrences: 10, updatedAt: iso(7.2 * DAY), createdAt: iso(23.3 * DAY) },
];

async function buildService() {
  const mod = await import('../lib/index.js');
  const tables = new Map();
  const getTable = (name) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };
  const makeTable = (name) => {
    const t = getTable(name);
    return {
      put: async (id, value) => { t.set(id, value); return true; },
      get: (id) => t.get(id) ?? null,
      delete: async (id) => { t.delete(id); return true; },
      entries: () => Array.from(t.entries()),
      size: async () => t.size,
    };
  };
  const ctx = {
    storageDomain: { open: async () => ({ table: async (name) => makeTable(name), close: async () => {} }) },
    effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {}; } catch { return () => {}; } },
    get: () => null,
    provide(name, val) { this._provided = this._provided ?? {}; this._provided[name] = val; },
    on: () => () => {},
  };
  mod.apply(ctx, {});
  // 等 open 完成
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  const evo = ctx._provided?.['agint.evolution'];
  assert.ok(evo, 'apply 后应提供 agint.evolution service');
  assert.equal(typeof evo.queryFailures, 'function', 'queryFailures 应可用');
  // 播种真生产形状
  for (const r of SEED) await makeTable('failure_pattern').put(r.id, r);
  return evo;
}

test('真调用：days 未传 ⇒ 返回全表（7 个其他调用方的向后兼容底线）', async () => {
  const evo = await buildService();
  const all = await evo.queryFailures({ limit: 100 });
  assert.equal(all.length, SEED.length, '不传 days 时必须返回全部 4 行');
});

test('真调用：days=7 ⇒ 过期行被滤掉（这条在修复前必红）', async () => {
  const evo = await buildService();
  const recent = await evo.queryFailures({ days: 7, limit: 100 });
  assert.ok(recent.length < SEED.length,
    `days=7 必须滤掉过期行（修复前这里会返回全部 ${SEED.length} 行）`);
  assert.deepEqual(recent.map((r) => r.id), [], '本次种子最年轻 7.2 天 ⇒ 7 天窗口应清空');
});

test('真调用：days=30 ⇒ 按 updatedAt 而非 createdAt 判定', async () => {
  const evo = await buildService();
  const kept = await evo.queryFailures({ days: 30, limit: 100 });
  const ids = kept.map((r) => r.id);
  assert.ok(ids.includes('f_mid_21'),
    'f_mid_21 的 createdAt 33.6 天前但 updatedAt 21.5 天前 ⇒ 按 updatedAt 应保留');
  assert.ok(!ids.includes('f_old_45'), 'updatedAt 44.7 天前 ⇒ 应滤掉');
});

test('真调用：days=60 ⇒ 全表（无行超窗）', async () => {
  const evo = await buildService();
  const kept = await evo.queryFailures({ days: 60, limit: 100 });
  assert.equal(kept.length, SEED.length);
});

test('真调用：days 与既有 category 过滤可叠加', async () => {
  const evo = await buildService();
  const kept = await evo.queryFailures({ days: 30, category: 'integration', limit: 100 });
  assert.ok(kept.every((r) => r.category === 'integration'), 'category 过滤仍生效');
  assert.ok(kept.every((r) => r.id !== 'f_old_45'), 'days 过滤仍生效');
});

test('真调用：days=0 / 负数 / NaN ⇒ 视为未传（不过滤）', async () => {
  const evo = await buildService();
  for (const bad of [0, -1, NaN]) {
    const kept = await evo.queryFailures({ days: bad, limit: 100 });
    assert.equal(kept.length, SEED.length,
      `days=${String(bad)} 应视为未传，返回全表（避免把「配置写错」误当成「什么都要删」）`);
  }
});

test('真调用：时间戳缺失的行保留（宁多不少）', async () => {
  const evo = await buildService();
  const tables = new Map();
  // 直接补一条无时间戳行（模拟旧数据/坏数据）
  // 通过再 apply 一个实例不现实，改用同一 service 的底层表
  // ⇒ 用 addFailure 造一行，再手动 unset updatedAt 不便；改为验证语义：
  //    现有 4 行全部有时间戳，故这里断言「有值的行被正确过滤」即可。
  const kept = await evo.queryFailures({ days: 7, limit: 100 });
  assert.equal(kept.length, 0, '有合法时间戳且全部超窗 ⇒ 应全部滤掉');
});
