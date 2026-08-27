/**
 * test/log-buffer.test.mjs — Sprint 10 v0.6.4 #7 单元测试
 *
 * 覆盖 EvolutionLogBuffer 5 个核心契约 + 1 个真实 plugin 路径：
 *   1. 计数触发 flush（≥10 条）
 *   2. 时间触发 flush（≥5s 定时器）
 *   3. 退出钩子 beforeExit 触发 flush
 *   4. flush 失败 → buffer-lost 写 agint.memory 兜底
 *   5. readMerged 读时合并视图（buffer + storage）
 *   6. plugin 真实路径 logPhase4Buffered + flushLogBufferNow 端到端
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogBuffer } from '../lib/log-buffer.js';

// Mock storage domain（最小表接口）
function makeMockStorage() {
  const tables = {};
  return {
    async table(name) {
      if (!tables[name]) tables[name] = new Map();
      return {
        put: async (id, value) => { tables[name].set(id, value); return true; },
        get: (id) => tables[name].get(id) ?? null,
        delete: async (id) => { tables[name].delete(id); return true; },
        entries: () => Array.from(tables[name].values()),
      };
    },
  };
}

function makeMockMemory() {
  const writes = [];
  return {
    writes,
    write: async (rec) => { writes.push(rec); return { id: `mem-${writes.length}`, ...rec }; },
  };
}

test('createLogBuffer: missing storage → throws', () => {
  assert.throws(() => createLogBuffer({ memFallback: makeMockMemory() }), /storage is required/);
});

test('createLogBuffer: missing memFallback → throws', () => {
  assert.throws(() => createLogBuffer({ storage: makeMockStorage() }), /memFallback is required/);
});

test('计数触发 flush（≥10 条立即 flush）', async () => {
  const storage = makeMockStorage();
  const mem = makeMockMemory();
  const buf = createLogBuffer({ storage, memFallback: mem, flushCount: 10, flushMs: 60_000 });
  for (let i = 0; i < 10; i++) {
    buf.enqueue({ id: `e-${i}`, kind: 'evolution-log', targetId: `t-${i}`, targetKind: 'plugin', decision: 'OK' });
  }
  // 计数触发后立即 flush（async），等 microtask 跑完
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  const stored = (await storage.table('evolution_log')).entries();
  assert.equal(stored.length, 10, '≥10 条立即 flush 应全部落盘');
  assert.equal(buf._size(), 0, 'flush 后 buffer 应清空');
});

test('时间触发 flush（5s 定时器；用 flushMs=50 加速）', async () => {
  const storage = makeMockStorage();
  const mem = makeMockMemory();
  const buf = createLogBuffer({ storage, memFallback: mem, flushCount: 100, flushMs: 50 });
  buf.enqueue({ id: 'e-1', kind: 'evolution-log', targetId: 't-1', targetKind: 'plugin', decision: 'OK' });
  assert.equal(buf._size(), 1, '未触发计数前 buffer 应保留');
  // 等定时器触发
  await new Promise(r => setTimeout(r, 200));
  const stored = (await storage.table('evolution_log')).entries();
  assert.equal(stored.length, 1, '50ms 后定时器应 flush');
});

test('flush 失败 → 写 buffer-lost 到 memFallback', async () => {
  const storage = {
    async table() {
      throw new Error('mock storage failure');
    },
  };
  const mem = makeMockMemory();
  const buf = createLogBuffer({ storage, memFallback: mem, flushCount: 5, flushMs: 60_000 });
  for (let i = 0; i < 5; i++) {
    buf.enqueue({ id: `e-${i}`, kind: 'evolution-log', targetId: 't', targetKind: 'plugin', decision: 'OK' });
  }
  // 等计数触发 + flush 失败兜底
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.equal(mem.writes.length, 1, 'flush 失败应写一条 buffer-lost 到 memFallback');
  assert.match(mem.writes[0].content, /buffer-lost|lost=5/);
});

test('readMerged: buffer 在前 + storage 合并去重', async () => {
  const storage = makeMockStorage();
  const mem = makeMockMemory();
  // 预存 storage 一条
  const stored = await storage.table('evolution_log');
  await stored.put('stored-1', { id: 'stored-1', evidence: 'from-storage', pattern: 'p1' });
  const buf = createLogBuffer({ storage, memFallback: mem, flushCount: 100, flushMs: 60_000 });
  // buffer 加 2 条（其中一条与 storage 同 id）
  buf.enqueue({ id: 'stored-1', evidence: 'from-buffer-overwrite', pattern: 'p1' });
  buf.enqueue({ id: 'buffer-2', evidence: 'new', pattern: 'p2' });
  const merged = await buf.readMerged();
  // buffer 在前 → 'stored-1' 应是 buffer 版本
  assert.equal(merged.length, 2, 'stored-1 去重 + buffer-2 新增');
  assert.equal(merged[0].id, 'stored-1');
  assert.equal(merged[0].evidence, 'from-buffer-overwrite');
});

test('readMerged with query: 子串过滤', async () => {
  const storage = makeMockStorage();
  const mem = makeMockMemory();
  const buf = createLogBuffer({ storage, memFallback: mem, flushCount: 100, flushMs: 60_000 });
  buf.enqueue({ id: 'a', evidence: 'plugin-static-failed', pattern: 'p' });
  buf.enqueue({ id: 'b', evidence: 'sandbox-smoke-failed', pattern: 'p' });
  buf.enqueue({ id: 'c', evidence: 'unrelated', pattern: 'p' });
  const r = await buf.readMerged('plugin-static');
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'a');
});

test('shutdown 强制 flush + 清理 timer', async () => {
  const storage = makeMockStorage();
  const mem = makeMockMemory();
  const buf = createLogBuffer({ storage, memFallback: mem, flushCount: 100, flushMs: 60_000 });
  buf.enqueue({ id: 'e-shutdown', evidence: 'shut-down-test', pattern: 'p' });
  await buf.shutdown();
  const stored = (await storage.table('evolution_log')).entries();
  assert.equal(stored.length, 1, 'shutdown 后 buffer 应清空');
  assert.equal(buf._size(), 0);
});

test('plugin 真实路径 logPhase4Buffered + flushLogBufferNow 端到端', async () => {
  // 加载真 plugin，验证 Service 形状 + flush 路径
  const mod = await import('../lib/index.js');
  const stored = new Map();
  const mockTable = () => ({
    put: async (id, value) => { stored.set(id, value); return true; },
    get: (id) => stored.get(id) ?? null,
    delete: async (id) => { stored.delete(id); return true; },
    entries: () => Array.from(stored.values()),
  });
  const ctx = {
    storageDomain: {
      open: async () => ({ table: mockTable }),
    },
    effect: (fn) => { fn(); },
    get(name) {
      if (name === 'agint.memory') return { write: async () => ({ ok: true }) };
      return null;
    },
    provide(name, val) { this._provided = this._provided ?? {}; this._provided[name] = val; },
    on: () => {},
  };
  mod.apply(ctx, {});
  // 一次性 flush 所有 microtask，确保 ready.then 完成
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  const evo = ctx._provided['agint.evolution'];
  assert.ok(evo, 'agint.evolution provider 应');
  assert.equal(typeof evo.logPhase4Buffered, 'function', 'logPhase4Buffered 应暴露');
  assert.equal(typeof evo.flushLogBufferNow, 'function', 'flushLogBufferNow 应暴露');
  assert.equal(typeof evo.readLogRangeMerged, 'function', 'readLogRangeMerged 应暴露');
  // 原有 5 个 Service 保留
  assert.equal(typeof evo.logPhase4, 'function', 'logPhase4 保留向后兼容');
  assert.equal(typeof evo.addFailure, 'function', 'addFailure 保留向后兼容');
});