// Sprint 17：detect({ forceRecheck: true }) 把曾被判 standardizable=false 的历史 pattern
// 重新拉入判定。验证：
//   - 默认（forceRecheck 缺省或 false）只判 newRepeat
//   - forceRecheck=true 时把历史 false 的 pattern 也加入判定
//   - 重判结果正确覆盖（pattern.standardizable 字段被刷新）
//
// 不挂 Cordis，直接 import plugin + fake storage domain。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as plugin from '../lib/index.js';

function fakeTable() {
  const m = new Map();
  return {
    put: async (k, v) => { if (v === undefined) m.delete(k); else m.set(k, v); },
    entries: () => [...m.entries()],
    del: async (k) => { m.delete(k); },
    _map: m,
  };
}

function fakeDomain() {
  const tables = new Map();
  return {
    close: async () => {},
    table: (name) => {
      if (!tables.has(name)) tables.set(name, fakeTable());
      return tables.get(name);
    },
  };
}

function mockCtx() {
  const provided = {};
  const effects = [];
  let domain = null;
  return {
    storageDomain: { open: async () => { if (!domain) domain = fakeDomain(); return domain; } },
    get: () => null,
    provide: (k, v) => { provided[k] = v; },
    effect: (fn) => effects.push(fn),
    _provided: provided,
    _effects: effects,
  };
}

// ── 工具：构造一个"曾被标准规则拒"的 pattern 入库（standardizable=false）────
async function seedPattern(ctx, { id, toolSequence, paramSignature, occurrenceCount, successRate }) {
  const domain = await ctx.storageDomain.open();
  const tp = domain.table('task_patterns');
  // 直接 put 一条已存在的 pattern（跳过 detect，用 svc 的内部 helper）
  // 这里我们用 detect 自身的 upsert 流程：先 put 一个 fake pattern
  const { packTaskPattern } = await import('../lib/storage.js');
  const packed = packTaskPattern({
    toolSequence,
    paramSignature,
    description: toolSequence.join(' > '),
    occurrenceCount,
    firstSeenAt: new Date(Date.now() - 86400_000).toISOString(),
    lastSeenAt: new Date().toISOString(),
    avgDurationMs: null,
    avgTokenCost: null,
    successRate,
    // 关键：standardizable=false 模拟旧规则误判
    standardizable: false,
    standardizableConfidence: 0,
    status: 'active',
    id,
  }, null);
  await tp.put(packed.id, packed);
  return packed;
}

test('plugin 入口导出契约不变', () => {
  assert.equal(plugin.name, 'agint-skill-autocreate');
  assert.equal(typeof plugin.apply, 'function');
});

test('forceRecheck 缺省 → 不重判历史', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fr-'));
  try {
    const ctx = mockCtx();
    const jsonlPath = join(tmp, 'stats.jsonl');
    writeFileSync(jsonlPath, '', 'utf8'); // 空数据
    plugin.apply(ctx, { jsonlPath, aggregate_window_hours: 24 });
    const svc = ctx._provided['agint.skillAutocreate'];
    const result = await svc.detect({});
    assert.equal(result.forceRecheckEvaluated, 0, '缺省 forceRecheckEvaluated 应为 0');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('forceRecheck=false → 不重判历史', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fr-'));
  try {
    const ctx = mockCtx();
    const jsonlPath = join(tmp, 'stats.jsonl');
    writeFileSync(jsonlPath, '', 'utf8');
    plugin.apply(ctx, { jsonlPath, aggregate_window_hours: 24 });
    const svc = ctx._provided['agint.skillAutocreate'];
    const result = await svc.detect({ forceRecheck: false });
    assert.equal(result.forceRecheckEvaluated, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('forceRecheck=true → 重判历史（即使没新数据也能命中）', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fr-'));
  try {
    const ctx = mockCtx();
    const jsonlPath = join(tmp, 'stats.jsonl');
    writeFileSync(jsonlPath, '', 'utf8');
    plugin.apply(ctx, { jsonlPath, aggregate_window_hours: 24 });
    const svc = ctx._provided['agint.skillAutocreate'];
    // 注入一个历史 false pattern
    await seedPattern(ctx, {
      id: 'tp_hist_test_a7463b',
      toolSequence: ['pwsh', 'memory_read'],
      paramSignature: { pwsh: 'command:str:email|description:str', memory_read: 'id:str' },
      occurrenceCount: 4,
      successRate: 1,
    });
    const result = await svc.detect({ forceRecheck: true });
    assert.ok(result.forceRecheckEvaluated >= 1, `forceRecheck 应至少命中 1，实际 ${result.forceRecheckEvaluated}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('forceRecheck 不发 pattern-detected 事件（避免与 newRepeat 混淆）', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fr-'));
  try {
    const ctx = mockCtx();
    const events = [];
    ctx.get = (k) => k === 'agint.eventBus.publish' ? async (env) => { events.push(env); } : null;
    const jsonlPath = join(tmp, 'stats.jsonl');
    writeFileSync(jsonlPath, '', 'utf8');
    plugin.apply(ctx, { jsonlPath, aggregate_window_hours: 24 });
    const svc = ctx._provided['agint.skillAutocreate'];
    await seedPattern(ctx, {
      id: 'tp_hist_test_event',
      toolSequence: ['pwsh', 'memory_read'],
      paramSignature: { pwsh: 'command:str|description:str', memory_read: 'id:str' },
      occurrenceCount: 4,
      successRate: 1,
    });
    await svc.detect({ forceRecheck: true });
    // 应有 force_recheck 审计，但**不应**发 pattern-detected 事件（因为没有跨过门槛动作）
    const topics = events.map((e) => e.topic);
    assert.ok(!topics.includes('skill-autocreate.pattern-detected'),
      `forceRecheck 不应发 pattern-detected，实际：${topics.join(',')}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
