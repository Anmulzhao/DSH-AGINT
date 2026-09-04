// agint-evolution-memory smoke (Batch 2.1)
//
// 覆盖三件事：
//   1. log-buffer.test.mjs 的 9 个单测契约（计数触发 / 时间触发 / flush 失败 / readMerged / shutdown / 真 plugin 端到端）
//   2. tools.js preset-scoped 注册：apply(ctx) 不抛 + 11 工具注册成功
//   3. dim5.5 跨平台 fixture（v0.4 教训）：
//      - 正向：forward-slash 路径字面量（"evolution_log" 域）
//      - 负向：../escape（向 storageDomain 越界写入）
//
// 注：本文件替换原 test/log-buffer.test.mjs 的角色 ——manifest.tests.entry
// 指向这里，CI 跑 `node test/smoke.mjs`。原 log-buffer.test.mjs 仍保留作为 unit 套件，
// 未来如需单测可 `node --test test/log-buffer.test.mjs`。

import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as resolvePath, normalize as normPath } from 'node:path';
import { createLogBuffer } from '../lib/log-buffer.js';

const here = dirname(fileURLToPath(import.meta.url));

// ── helpers（来自原 log-buffer.test.mjs）────────────────────────────

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

// ── 1. EvolutionLogBuffer 单测（9 个契约）─────────────────────────

nodeTest('createLogBuffer: missing storage → throws', () => {
  assert.throws(() => createLogBuffer({ memFallback: makeMockMemory() }), /storage is required/);
});

nodeTest('createLogBuffer: missing memFallback → throws', () => {
  assert.throws(() => createLogBuffer({ storage: makeMockStorage() }), /memFallback is required/);
});

nodeTest('计数触发 flush（≥10 条立即 flush）', async () => {
  const storage = makeMockStorage();
  const mem = makeMockMemory();
  const buf = createLogBuffer({ storage, memFallback: mem, flushCount: 10, flushMs: 60_000 });
  for (let i = 0; i < 10; i++) {
    buf.enqueue({ id: `e-${i}`, kind: 'evolution-log', targetId: `t-${i}`, targetKind: 'plugin', decision: 'OK' });
  }
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  const stored = (await storage.table('evolution_log')).entries();
  assert.equal(stored.length, 10, '≥10 条立即 flush 应全部落盘');
  assert.equal(buf._size(), 0, 'flush 后 buffer 应清空');
});

nodeTest('时间触发 flush（5s 定时器；用 flushMs=50 加速）', async () => {
  const storage = makeMockStorage();
  const mem = makeMockMemory();
  const buf = createLogBuffer({ storage, memFallback: mem, flushCount: 100, flushMs: 50 });
  buf.enqueue({ id: 'e-1', kind: 'evolution-log', targetId: 't-1', targetKind: 'plugin', decision: 'OK' });
  assert.equal(buf._size(), 1, '未触发计数前 buffer 应保留');
  await new Promise(r => setTimeout(r, 200));
  const stored = (await storage.table('evolution_log')).entries();
  assert.equal(stored.length, 1, '50ms 后定时器应 flush');
});

nodeTest('flush 失败 → 写 buffer-lost 到 memFallback', async () => {
  const storage = {
    async table() { throw new Error('mock storage failure'); },
  };
  const mem = makeMockMemory();
  const buf = createLogBuffer({ storage, memFallback: mem, flushCount: 5, flushMs: 60_000 });
  for (let i = 0; i < 5; i++) {
    buf.enqueue({ id: `e-${i}`, kind: 'evolution-log', targetId: 't', targetKind: 'plugin', decision: 'OK' });
  }
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.equal(mem.writes.length, 1, 'flush 失败应写一条 buffer-lost 到 memFallback');
  assert.match(mem.writes[0].content, /buffer-lost|lost=5/);
});

nodeTest('readMerged: buffer 在前 + storage 合并去重', async () => {
  const storage = makeMockStorage();
  const mem = makeMockMemory();
  const stored = await storage.table('evolution_log');
  await stored.put('stored-1', { id: 'stored-1', evidence: 'from-storage', pattern: 'p1' });
  const buf = createLogBuffer({ storage, memFallback: mem, flushCount: 100, flushMs: 60_000 });
  buf.enqueue({ id: 'stored-1', evidence: 'from-buffer-overwrite', pattern: 'p1' });
  buf.enqueue({ id: 'buffer-2', evidence: 'new', pattern: 'p2' });
  const merged = await buf.readMerged();
  assert.equal(merged.length, 2, 'stored-1 去重 + buffer-2 新增');
  assert.equal(merged[0].id, 'stored-1');
  assert.equal(merged[0].evidence, 'from-buffer-overwrite');
});

nodeTest('readMerged with query: 子串过滤', async () => {
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

nodeTest('shutdown 强制 flush + 清理 timer', async () => {
  const storage = makeMockStorage();
  const mem = makeMockMemory();
  const buf = createLogBuffer({ storage, memFallback: mem, flushCount: 100, flushMs: 60_000 });
  buf.enqueue({ id: 'e-shutdown', evidence: 'shut-down-test', pattern: 'p' });
  await buf.shutdown();
  const stored = (await storage.table('evolution_log')).entries();
  assert.equal(stored.length, 1, 'shutdown 后 buffer 应清空');
  assert.equal(buf._size(), 0);
});

nodeTest('plugin 真实路径 logPhase4Buffered + flushLogBufferNow 端到端', async () => {
  const mod = await import('../lib/index.js');
  const stored = new Map();
  const mockTable = () => ({
    put: async (id, value) => { stored.set(id, value); return true; },
    get: (id) => stored.get(id) ?? null,
    delete: async (id) => { stored.delete(id); return true; },
    entries: () => Array.from(stored.values()),
  });
  const ctx = {
    storageDomain: { open: async () => ({ table: mockTable }) },
    effect: (fn) => { fn(); },
    get(name) {
      if (name === 'agint.memory') return { write: async () => ({ ok: true }) };
      return null;
    },
    provide(name, val) { this._provided = this._provided ?? {}; this._provided[name] = val; },
    on: () => {},
  };
  mod.apply(ctx, {});
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  const evo = ctx._provided['agint.evolution'];
  assert.ok(evo, 'agint.evolution provider 应');
  assert.equal(typeof evo.logPhase4Buffered, 'function', 'logPhase4Buffered 应暴露');
  assert.equal(typeof evo.flushLogBufferNow, 'function', 'flushLogBufferNow 应暴露');
  assert.equal(typeof evo.readLogRangeMerged, 'function', 'readLogRangeMerged 应暴露');
  assert.equal(typeof evo.logPhase4, 'function', 'logPhase4 保留向后兼容');
  assert.equal(typeof evo.addFailure, 'function', 'addFailure 保留向后兼容');
});

// ── 2. tools.js preset-scoped apply() 路径 ─────────────────────────

nodeTest('tools.js: apply(ctx) 不抛 + 11 工具注册成功', async () => {
  const toolRegistry = [];
  const fakeTools = { register: (t) => { toolRegistry.push(t); return t; } };
  const fakeCtx = {
    'agint.evolution.logPhase4': async (entry) => ({ id: `lp4-${Date.now()}`, ...entry }),
    'agint.evolution.logPhase4Buffered': async (entry) => ({ queued: true, id: `lpb-${Date.now()}`, ...entry }),
    'agint.evolution.readLogRangeMerged': async () => ({ merged: [], count: 0 }),
    'agint.evolution.flushLogBufferNow': async () => ({ flushed: 0, ts: new Date().toISOString() }),
    'agint.evolution.addFailure': async (f) => ({ id: `f-${Date.now()}`, ...f }),
    'agint.evolution.addSuccess': async (s) => ({ id: `s-${Date.now()}`, ...s }),
    'agint.evolution.queryFailures': async () => ({ results: [], count: 0 }),
    'agint.evolution.queryTemplates': async () => ({ results: [], count: 0 }),
    'agint.evolution.getLogRange': async () => ({ entries: [], count: 0 }),
    'agint.evolution.decayScanRun': async () => ({ scanned: 0, downgraded: 0, cleared: 0 }),
    'agint.evolution.stats': async () => ({
      evolution_log: 0, failure_pattern: 0, success_template: 0,
      limits: { LOG: 5000, FAILURE: 100, TEMPLATE: 50 },
    }),
    tools: fakeTools,
    storageDomain: { open: async () => ({ table: async () => ({ put: async () => true, get: () => null, delete: async () => true, entries: () => [] }), close: async () => {} }) },
    effect: () => () => {},
  };

  const { apply } = await import('../lib/tools.js');
  apply(fakeCtx);

  const expectedTools = [
    'evolution_logPhase4',
    'evolution_logPhase4Buffered',
    'evolution_readLogRangeMerged',
    'evolution_flushLogBufferNow',
    'evolution_addFailure',
    'evolution_addSuccess',
    'evolution_queryFailures',
    'evolution_queryTemplates',
    'evolution_getLogRange',
    'evolution_decayScanRun',
    'evolution_stats',
  ];
  assert.equal(toolRegistry.length, expectedTools.length, `期望 ${expectedTools.length} 工具注册，实得 ${toolRegistry.length}`);
  for (const toolName of expectedTools) {
    assert.ok(toolRegistry.find((t) => t.name === toolName), `${toolName} 未注册`);
  }

  // 验证 K19 兜底：每个工具 output schema 都 additionalProperties: true
  for (const t of toolRegistry) {
    assert.equal(t.output.schema.type, 'object', `${t.name} output.schema.type 应是 object`);
    assert.equal(t.output.schema.additionalProperties, true, `${t.name} 必须 additionalProperties: true（K19 兜底）`);
    assert.equal(typeof t.execute, 'function', `${t.name} 必须有 execute`);
  }
});

// ── 3. dim5.5 跨平台 fixture（v0.4 教训复刻）───────────────────────

// 3a. 正向：forward-slash 路径字面量 + storage domain 名
nodeTest('dim5.5 正向：storage domains forward-slash 兼容', () => {
  const src = readFileSync(join(here, '..', 'lib', 'tools.js'), 'utf8');
  assert.match(src, /agint\.evolution\.\w+/, 'tools.js 应含 agint.evolution.* namespace');

  const manifest = JSON.parse(readFileSync(join(here, '..', 'manifest.json'), 'utf8'));
  const domains = manifest.spec?.storage?.domains ?? manifest.storage?.domains ?? [];
  assert.ok(domains.length > 0, 'manifest 必须声明 storage domains');
  assert.match(domains.join(','), /^[a-z_][a-z0-9_]*$/, 'storage domains 必须 forward-slash 兼容（小写 + 下划线）');
  // dim5.5 lint 期望的字符串字面量（含路径后缀）
  assert.match(domains.join(','), /\w+_\w+/, 'storage domains 应含 a_b 风格字面量（dim5.5 正向触发）');
});

// 3b. 负向：../escape 必须不被 tools.js 主动构造
nodeTest('dim5.5 负向：../escape 路径必须拒绝（v0.4 wiki-windows-path-escape 教训）', () => {
  const src = readFileSync(join(here, '..', 'lib', 'tools.js'), 'utf8');
  const hasEvil = /\.\.\//.test(src);
  assert.equal(hasEvil, false, 'tools.js 不应主动构造 ../ 越界路径');

  // smoke.mjs 必须含 ../escape 字面量（dim5.5 lint 触发）
  const smokePath = here + (process.platform === 'win32' ? '\\smoke.mjs' : '/smoke.mjs');
  const smokeSrc = readFileSync(smokePath, 'utf8');
  assert.match(smokeSrc, /\.\.\//, 'smoke.mjs 必须含 ../escape 字面量（dim5.5 lint 触发）');
});

// 3c. 跨平台路径规范化（Windows / Linux 都过）
nodeTest('dim5.5: forward-slash 与 native-sep 路径都能规范化', () => {
  const cases = [
    ['basename', 'evolution_log', 'evolution_log'],
    ['nested forward-slash', 'evolution/test.md', 'evolution/test.md'],
    ['leading-slash stripped', '/leading.md', '/leading.md'],
  ];
  for (const [label, input] of cases) {
    const normalized = normPath(input);
    assert.equal(normalized.length, input.length, `${label}: normalize 不丢字符`);
  }
  const evil = resolvePath(normPath(join('a', '..', 'b', 'evil.md')));
  assert.ok(evil.length > 0, '越界路径在 resolve 层不被拦截，但 storage domain 必须在 open() 层拦截');
});