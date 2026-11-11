/**
 * agint-evolution-memory: 研究日志 evidence 写入通道回归测试
 *
 * 背景（2026-11-11 生产实测）：
 *   agint_evolution.evolution_log 有 283 条，evidence 全为空串，recalls 全为 0。
 *   决策写进去了，「上一轮为什么这么判」没写进去。下一代改进器读不到诊断，
 *   跨代研究状态有行无内容 —— 这正是 RSI-Env 𝒫_t 与 AGINT 的真实差距。
 *
 *   baseFields 早有 evidence 槽位（z.string().default('')），缺的是
 *   logPhase4 / logPhase4Buffered 把它从调用方搬进来的通道。
 *
 * 本文件同时是 negative control：不传 evidence 时必须保持向后兼容（''），
 * 不允许为了「看起来有数据」而填占位值（Γ 规则 1：预测绝不填补缺失证据）。
 *
 * Run: node --test plugins/agint-evolution-memory/test/log-phase4-evidence.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const libIndex = join(here, '..', 'lib', 'index.js');

function makeCtx() {
  const tables = {};
  const services = new Map();
  const tableHandle = (name) => {
    if (!tables[name]) tables[name] = new Map();
    return {
      put: async (id, value) => { tables[name].set(id, value); return true; },
      get: (id) => tables[name].get(id) ?? null,
      delete: async (id) => { tables[name].delete(id); return true; },
      entries: () => Array.from(tables[name].values()),
      size: () => tables[name].size,
    };
  };
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
  };
  return { ctx, tables };
}

async function mount() {
  const mod = await import(`file://${libIndex.replace(/\\/g, '/')}`);
  const { ctx, tables } = makeCtx();
  await mod.apply(ctx);
  return { svc: ctx.get('agint.evolution'), tables };
}

const base = { targetId: 'research-log-1', targetKind: 'plugin', decision: 'PENDING_REVIEW' };

test('logPhase4: 字符串 evidence 原样落盘', async () => {
  const { svc, tables } = await mount();
  const diagnostic = 'exitReason=llm-unavailable; failures=2; policyDecision=REJECT';
  const r = await svc.logPhase4({ ...base, evidence: diagnostic });
  assert.equal(r.evidence, diagnostic, '返回值必须带诊断');
  const stored = Array.from(tables.evolution_log.values());
  assert.equal(stored.length, 1);
  assert.equal(stored[0].evidence, diagnostic, '落盘行必须带诊断，不能只剩决策枚举');
});

test('logPhase4: 对象 evidence 序列化成可检索文本', async () => {
  const { svc, tables } = await mount();
  const diagnostic = {
    reason: 'policy-pending:default-gating',
    triggeredBy: ['effective-delta-unmeasured:token-unmeasured'],
    perTarget: [{ targetId: 't1', kind: 'PENDING_REVIEW', score: 71.4 }],
  };
  await svc.logPhase4({ ...base, evidence: diagnostic });
  const stored = Array.from(tables.evolution_log.values())[0];
  assert.equal(typeof stored.evidence, 'string');
  assert.deepEqual(JSON.parse(stored.evidence), diagnostic, '结构化归因必须可无损还原');
});

test('negative control: 不传 evidence 时保持空串，不填占位值', async () => {
  const { svc, tables } = await mount();
  const r = await svc.logPhase4({ ...base });
  assert.equal(r.evidence, '', '没核过就是没核过，不得伪装成已核');
  assert.equal(Array.from(tables.evolution_log.values())[0].evidence, '');
});

test('logPhase4Buffered: 缓冲路径同样携带 evidence，flush 后不丢', async () => {
  const { svc, tables } = await mount();
  const diagnostic = 'stage=proposed; origin=driver; reason=anchor-missing';
  await svc.logPhase4Buffered({ ...base, evidence: diagnostic });
  await svc.flushLogBufferNow();
  const stored = Array.from(tables.evolution_log?.values() ?? []);
  assert.equal(stored.length, 1, 'flush 后应恰好一行');
  assert.equal(stored[0].evidence, diagnostic, '降级/缓冲路径不得吞掉诊断');
});

test('logPhase4: 循环引用诊断不抛错，退回空串并留「没核过」语义', async () => {
  const { svc } = await mount();
  const cyclic = { self: null };
  cyclic.self = cyclic;
  const r = await svc.logPhase4({ ...base, evidence: cyclic });
  assert.equal(r.evidence, '', '不可序列化 ⇒ 空串，不是崩溃，也不是编造');
});
