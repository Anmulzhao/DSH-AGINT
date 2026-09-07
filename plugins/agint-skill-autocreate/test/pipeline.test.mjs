// pipeline 集成测试：mock ctx + 内存版 storage domain + 临时 JSONL
// 走通「读 tool-stats → 聚合 → 检测 → 候选生成 → 事件 + audit」端到端。
// 不挂 Cordis、不碰真实 ~/.dsh。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as plugin from '../lib/index.js';

// ── 内存版 storage domain（put/entries/del 最小实现）────────────────────
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

function mockCtx(services = {}) {
  const provided = {};
  const effects = [];
  return {
    storageDomain: { open: async () => fakeDomain() },
    get: (key) => services[key] ?? null,
    provide: (key, val) => { provided[key] = val; },
    effect: (fn) => effects.push(fn),
    _provided: provided,
    _effects: effects,
  };
}

// ── 构造模拟数据：同一 (session, turn) 形态的任务重复 3 次 ────────────────
const NOW = Date.now();
let seq = 0;
function taskRecords({ sessionId, turn, path }) {
  const base = NOW - 3600_000 + (seq += 10);
  return [
    { ts: base, sessionId, turn, tool: 'file_read', ok: true, latencyMs: 100, args: { path } },
    { ts: base + 200, sessionId, turn, tool: 'file_write', ok: true, latencyMs: 150, args: { path } },
  ];
}

function setupCtx(tmpDir) {
  const events = [];
  const ctx = mockCtx({
    'agint.eventBus.publish': async (envelope) => { events.push(envelope); },
  });
  const jsonlPath = join(tmpDir, `stats_${Math.random().toString(36).slice(2)}.jsonl`);
  const records = [
    ...taskRecords({ sessionId: 's1', turn: 1, path: 'a/x.md' }),
    ...taskRecords({ sessionId: 's2', turn: 1, path: 'b/y.md' }),
    ...taskRecords({ sessionId: 's3', turn: 2, path: 'c/z.md' }),
    // 噪声：形态不同的任务，不成模式
    { ts: NOW - 3600_000, sessionId: 's9', turn: 1, tool: 'terminal', ok: true, latencyMs: 10, args: { command: 'echo hi' } },
  ];
  writeFileSync(jsonlPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  plugin.apply(ctx, { jsonlPath, aggregate_window_hours: 24 });
  return { ctx, events, svc: ctx._provided['agint.skillAutocreate'] };
}

test('端到端：检测到重复模式 + 生成候选 + 发事件 + 写 audit', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'autocreate-'));
  try {
    const { svc, events } = setupCtx(tmp);
    const result = await svc.detect({});

    assert.equal(result.tasks, 4);
    assert.equal(result.patternsUpserted, 2); // file_read→file_write 模式 + terminal 单发
    assert.equal(result.newRepeatPatterns, 1);
    assert.equal(result.candidatesCreated, 1);
    const cand = await svc.getCandidate(result.candidateIds[0]);
    assert.equal(cand.status, 'PENDING_EVAL');
    assert.equal(cand.source, 'auto');
    assert.equal(cand.skillDraft.template, 'file-processing');

    // pattern 已回链 + 状态 candidate
    const patterns = await svc.listPatterns({});
    const linked = patterns.find((p) => p.linkedCandidateId === cand.id);
    assert.ok(linked);
    assert.equal(linked.status, 'candidate');

    // 事件：pattern-detected + candidate-created
    const topics = events.map((e) => e.topic);
    assert.ok(topics.includes('skill-autocreate.pattern-detected'));
    assert.ok(topics.includes('skill-autocreate.candidate-created'));
    assert.equal(events[0].source, 'agint-skill-autocreate');
    assert.equal(events[0].version, 1);

    // audit 落了关键动作（pattern_detected + candidate_created）
    const stats = await svc.stats();
    assert.equal(stats.candidates.byStatus.PENDING_EVAL, 1);
    assert.ok(stats.auditLogEntries >= 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('增量检测：第二次跑不重复生成候选', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'autocreate-'));
  try {
    const { svc } = setupCtx(tmp);
    const first = await svc.detect({});
    assert.equal(first.candidatesCreated, 1);
    const second = await svc.detect({});
    assert.equal(second.candidatesCreated, 0); // 已回链，不重复
    assert.equal(second.newRepeatPatterns, 0); // 已跨过阈值不再重复报
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('auto_create_enabled=false：只检测不建候选', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'autocreate-'));
  try {
    const ctx = mockCtx({});
    const jsonlPath = join(tmp, 'stats.jsonl');
    const records = [
      ...taskRecords({ sessionId: 's1', turn: 1, path: 'a.md' }),
      ...taskRecords({ sessionId: 's2', turn: 1, path: 'b.md' }),
      ...taskRecords({ sessionId: 's3', turn: 1, path: 'c.md' }),
    ];
    writeFileSync(jsonlPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    plugin.apply(ctx, { jsonlPath, auto_create_enabled: false });
    const svc = ctx._provided['agint.skillAutocreate'];
    const result = await svc.detect({});
    assert.equal(result.newRepeatPatterns, 1);
    assert.equal(result.candidatesCreated, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('pause/resume + 运行时 config + 人工拒绝', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'autocreate-'));
  try {
    const { svc } = setupCtx(tmp);
    await svc.detect({});

    // pause → detect 跳过
    await svc.pause('human:boss');
    const pausedResult = await svc.detect({});
    assert.equal(pausedResult.skipped, true);
    // force 可绕过
    const forced = await svc.detect({ force: true });
    assert.equal(forced.skipped, undefined);
    await svc.resume('human:boss');

    // 运行时 config：只允许 §8.2 子集
    const cfg = svc.config({ weekly_deploy_budget: 5, jsonlPath: '/hack' });
    assert.equal(cfg.weekly_deploy_budget, 5);
    assert.notEqual(cfg.jsonlPath, '/hack'); // 子集外字段不改

    // 人工拒绝：候选 REJECTED + pattern dismissed + audit
    const cands = await svc.listCandidates({});
    const rejected = await svc.rejectCandidate({ id: cands[0].id, reason: '误报', actor: 'human:boss' });
    assert.equal(rejected.status, 'REJECTED_STATIC');
    assert.equal(rejected.rejectionReason, '误报');
    const patterns = await svc.listPatterns({});
    assert.ok(patterns.find((p) => p.status === 'dismissed' && p.linkedCandidateId === null));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Sprint 15/16 方法显式抛 not implemented，绝不静默', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'autocreate-'));
  try {
    const { svc } = setupCtx(tmp);
    for (const fn of ['triggerEval', 'release', 'rollback']) {
      await assert.rejects(() => svc[fn]({}), /未实现/);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
