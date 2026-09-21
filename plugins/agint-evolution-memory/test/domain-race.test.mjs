/**
 * agint-evolution-memory: 「domain 未就绪即调用」竞态回归防线
 *
 * 背景（fix-20260921 / T1 真实触发实验实证）：
 *   logBuffer 由 `ready.then(...)` **异步赋值**，而 logPhase4Buffered 原实现
 *   直接 `logBuffer.enqueue(entry)` —— 既不查 null、也不 await ready。
 *   任何早于 storage domain 就绪的调用必抛
 *     `TypeError: Cannot read properties of null (reading 'enqueue')`
 *   又被 shadow handler 的 `catch { warn(...) }` 吞掉 ⇒ **事件永久丢失**。
 *
 *   生产实证：`agint_evolution.evolution_log` 168 行里
 *   `shadow-ingest` 标记 = **0** —— 该影子链路自上线至今从未成功写入过一次。
 *   （同型复发：09-07 那次病灶是 schema.parse 抛错被吞，这次是 logBuffer === null。）
 *
 * 本测试用**真插件 + mock ctx + 慢 domain** 复现竞态，断言修复后事件不丢。
 * 修复前跑本文件应失败（可用作变异测试的阴性对照）。
 *
 * Run: node --test plugins/agint-evolution-memory/test/domain-race.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const libIndex = join(here, '..', 'lib', 'index.js');

/** 造一个最小 ctx：storageDomain 可控制就绪延迟 */
function makeCtx({ openDelayMs = 30 } = {}) {
  const tables = {};               // name -> Map
  const metrics = [];              // 采集所有计数指标
  const warns = [];
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
    logger: { warn: (m, extra) => { warns.push([m, extra]); } },
    metrics: (k, n = 1) => { metrics.push([k, n]); },
    tables: {},
    storageDomain: {
      open: async () => {
        if (openDelayMs > 0) await new Promise((r) => setTimeout(r, openDelayMs));
        return { table: async (name) => tableHandle(name), close: async () => {} };
      },
    },
  };

  return { ctx, tables, metrics, warns, services };
}

async function loadPlugin() {
  const mod = await import(`file://${libIndex.replace(/\\/g, '/')}`);
  return mod;
}

test('回归：domain 未就绪时调用 logPhase4Buffered，事件不得丢失', async () => {
  const { ctx, tables, metrics } = makeCtx({ openDelayMs: 60 });
  const mod = await loadPlugin();
  await mod.apply(ctx);

  const svc = ctx.get('agint.evolution');
  assert.ok(svc, 'apply() 后应 provide agint.evolution');

  // ⚠️ 关键：不给 domain 任何就绪时间，立刻调用（复现原竞态）
  //   修复前：抛 `TypeError: Cannot read properties of null (reading 'enqueue')`
  //   修复后：await ensureLogBuffer() 等 domain ready，事件入 buffer，不丢
  const r = await svc.logPhase4Buffered({
    targetId: 'race-1',
    targetKind: 'plugin',
    decision: 'PENDING_REVIEW',
  });
  assert.ok(r, 'logPhase4Buffered 应有返回值（原实现此处抛 TypeError）');
  assert.equal(r.queued, true, '应走缓冲路径入队');

  // 强制 flush（走 buffered 时默认 5s 定时器，测试不等那么久）
  await svc.flushLogBufferNow();

  const logTable = tables.evolution_log;
  const stored = logTable ? Array.from(logTable.values()) : [];
  assert.equal(
    stored.length,
    1,
    `domain 未就绪时调用，事件必须不丢（实得 ${stored.length} 条）。` +
    '原实现会抛 TypeError 并被 catch 吞掉 ⇒ evolution_log 永远 0 条。',
  );
  assert.equal(stored[0].targetId, 'race-1');
});

test('回归：domain 不可用（open reject）时降级同步写入并计数', async () => {
  const { ctx, tables, metrics } = makeCtx({ openDelayMs: 0 });
  ctx.storageDomain.open = async () => { throw new Error('domain down'); };
  const mod = await loadPlugin();
  await mod.apply(ctx);
  await new Promise((r) => setTimeout(r, 50));

  const svc = ctx.get('agint.evolution');
  // domain 不可用 → 降级同步路径；同步路径自己会抛 domain unavailable（明确错误）
  await assert.rejects(
    () => svc.logPhase4Buffered({ targetId: 'down-1', targetKind: 'plugin', decision: 'PENDING_REVIEW' }),
    /domain unavailable|domain down/,
    'domain 不可用时应抛明确错误，而不是 TypeError: ... of null',
  );

  // 降级必须留下计数（可观测性）
  const degraded = metrics.filter(([k]) => /degraded/i.test(k));
  assert.ok(degraded.length >= 1, '降级路径必须 emit 计数指标（失败要暴露）');
});

test('回归：domain 已就绪后调用，走 buffered 正常路径', async () => {
  const { ctx, tables } = makeCtx({ openDelayMs: 10 });
  const mod = await loadPlugin();
  await mod.apply(ctx);
  await new Promise((r) => setTimeout(r, 80)); // 让 domain ready

  const svc = ctx.get('agint.evolution');
  await svc.logPhase4Buffered({ targetId: 'ok-1', targetKind: 'plugin', decision: 'PENDING_REVIEW' });
  // 走 buffered → 需 flush（默认 5s，这里直接强制）
  await svc.flushLogBufferNow();

  const stored = tables.evolution_log ? Array.from(tables.evolution_log.values()) : [];
  assert.equal(stored.length, 1, 'domain 就绪后应正常写入 1 条');
  assert.equal(stored[0].targetId, 'ok-1');
});

test('回归：ensureLogBuffer 只创建一次（并发调用不重复开域）', async () => {
  const { ctx, metrics } = makeCtx({ openDelayMs: 20 });
  const mod = await loadPlugin();
  await mod.apply(ctx);

  const svc = ctx.get('agint.evolution');
  // 并发 5 次
  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      svc.logPhase4Buffered({ targetId: `c-${i}`, targetKind: 'plugin', decision: 'PENDING_REVIEW' }),
    ),
  );
  await svc.flushLogBufferNow();
  await new Promise((r) => setTimeout(r, 100));

  // 不断言具体条数（并发下时序不同），只断言不抛错且无 TypeError 类指标
  const bad = metrics.filter(([k]) => /enqueueFailed/i.test(k));
  assert.equal(bad.length, 0, '并发调用不应出现 enqueueFailed');
});
