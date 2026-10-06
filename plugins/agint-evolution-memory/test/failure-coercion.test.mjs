/**
 * agint-evolution-memory: addFailure 值域归一化测试（方案 B，v0.6.14）。
 *
 * 背景（docs/立项-失败供料通道修复-20261006.md）：全仓 14 个 addFailure 写入点里
 * 7 个传越界 category/severity。旧行为 `.parse()` 抛错，调用方多数 catch{} 静默吞
 * ⇒ 真实失败无声丢行（diagnosis 供料饿死的根因之一）。新行为：映射表归位、未知落
 * other、coercedFrom 留痕、不抛。
 *
 * Run: node --test plugins/agint-evolution-memory/test/failure-coercion.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const libIndex = join(here, '..', 'lib', 'index.js');

function makeCtx() {
  const tables = {};
  const consoleWarns = [];
  const services = new Map();
  const tableHandle = (name) => {
    if (!tables[name]) tables[name] = new Map();
    return {
      put: async (id, value) => { tables[name].set(id, value); return true; },
      get: (id) => tables[name].get(id) ?? null,
      delete: async (id) => { tables[name].delete(id); return true; },
      // 真 storage-domain 语义：迭代 [id, rec] 对（生产码 for (const [id, rec] of …)）
      entries: () => tables[name].entries(),
      get size() { return tables[name].size; },
    };
  };
  const origWarn = console.warn;
  console.warn = (...a) => { consoleWarns.push(a.join(' ')); };
  const ctx = {
    get: (k) => services.get(k),
    provide: (k, v) => { services.set(k, v); },
    effect: (fn) => { try { fn(); } catch { /* noop */ } return () => {}; },
    logger: { warn: () => {} },
    metrics: () => {},
    tables: {},
    storageDomain: {
      open: async () => ({ table: async (name) => tableHandle(name), close: async () => {} }),
    },
    tools: { register: () => {} },
  };
  const ensureTable = (name) => { if (!tables[name]) tables[name] = new Map(); return tables[name]; };
  return { ctx, tables, consoleWarns, ensureTable, restore: () => { console.warn = origWarn; } };
}

async function svc(env) {
  const mod = await import(`file://${libIndex.replace(/\\/g, '/')}`);
  await mod.apply(env.ctx);
  const s = env.ctx.get('agint.evolution');
  assert.ok(s, 'apply 后应 provide agint.evolution');
  await new Promise((r) => setTimeout(r, 30)); // 等 domain ready
  return s;
}

test('合法值透传：category/severity 在枚举内 ⇒ 原样落库，无 coercedFrom 无 warn', async () => {
  const env = makeCtx();
  try {
    const s = await svc(env);
    const r = await s.addFailure({ pattern: 'ok-1', category: 'integration', severity: 'high', evidence: 'e' });
    assert.equal(r.category, 'integration');
    assert.equal(r.severity, 'high');
    assert.ok(!r.coercedFrom, '合法值不该有归一化留痕');
    assert.equal(env.consoleWarns.length, 0);
  } finally { env.restore(); }
});

test('映射表：mount+critical ⇒ integration+high，coercedFrom 记双原值', async () => {
  const env = makeCtx();
  try {
    const s = await svc(env);
    const r = await s.addFailure({ pattern: 'mount-disabled:t1', category: 'mount', severity: 'critical' });
    assert.equal(r.category, 'integration');
    assert.equal(r.severity, 'high');
    assert.match(r.coercedFrom, /category:mount→integration/);
    assert.match(r.coercedFrom, /severity:critical→high/);
    assert.ok(env.consoleWarns.some((w) => w.includes('值域归一化')), '归一化必须打可见告警');
  } finally { env.restore(); }
});

test('self-model→correctness 映射在位（校准失准供料落对桶）', async () => {
  const env = makeCtx();
  try {
    const s = await svc(env);
    const r = await s.addFailure({ pattern: 'self-model-miscalibration:codegen', category: 'self-model', severity: 'low' });
    assert.equal(r.category, 'correctness');
    assert.equal(r.severity, 'low', '合法 severity 不动');
    assert.match(r.coercedFrom, /category:self-model→correctness/);
  } finally { env.restore(); }
});

test('未知值兜底：未列入映射表的 category ⇒ other + (未知值) 标注，不抛错', async () => {
  const env = makeCtx();
  try {
    const s = await svc(env);
    const r = await s.addFailure({ pattern: 'who-dis', category: 'brand-new-thing', severity: 'ultra' });
    assert.equal(r.category, 'other');
    assert.equal(r.severity, 'medium');
    assert.match(r.coercedFrom, /brand-new-thing→other\(未知值\)/);
    assert.match(r.coercedFrom, /ultra→medium\(未知值\)/);
  } finally { env.restore(); }
});

test('去重优先于归一化：同 pattern 已有行 ⇒ 只 occ++，不新增行、不改原 category', async () => {
  const env = makeCtx();
  try {
    const s = await svc(env);
    await s.addFailure({ pattern: 'dup-pat', category: 'integration', severity: 'high' });
    const r2 = await s.addFailure({ pattern: 'dup-pat', category: 'mount', severity: 'critical' });
    assert.equal(r2._deduped, true);
    assert.equal(r2.category, 'integration', '去重命中走原行，不该被归一化重写');
    assert.equal(r2.occurrences, 2);
    assert.equal(Array.from(env.tables.failure_pattern.values()).length, 1);
  } finally { env.restore(); }
});

test('旧记录兼容：无 coercedFrom 字段的历史行照读（schema optional）', async () => {
  const env = makeCtx();
  try {
    const s = await svc(env);
    const fp = env.ensureTable('failure_pattern');
    fp.set('legacy-1', {
      id: 'legacy-1', kind: 'failure-pattern', pattern: 'policy-reject',
      category: 'integration', severity: 'medium', occurrences: 125,
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    });
    const r = await s.addFailure({ pattern: 'policy-reject', category: 'governance' });
    assert.equal(r._deduped, true, 'legacy 行应参与去重（字段缺失不拒读）');
  } finally { env.restore(); }
});
