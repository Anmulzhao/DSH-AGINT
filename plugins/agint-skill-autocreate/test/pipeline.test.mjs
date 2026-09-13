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
  let domain = null;
  return {
    storageDomain: { open: async () => { if (!domain) domain = fakeDomain(); return domain; } },
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

test('Sprint 16 方法（release/rollback）已实装：参数缺失显式抛错（详细测试见 release.test.mjs）', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'autocreate-'));
  try {
    const { svc } = setupCtx(tmp);
    await assert.rejects(() => svc.release({}), /id is required/);
    await assert.rejects(() => svc.rollback({ skillName: 'x' }), /reason is required/);
    assert.equal(typeof svc.releaseQueue, 'function');
    assert.equal(typeof svc.observe, 'function');
    assert.equal(typeof svc.listReleases, 'function');
    const releases = await svc.listReleases({});
    assert.deepEqual(releases, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ═══════════════ Sprint 15 评估层集成（T4–T8）═══════════════════════════
// 真实 quality-static checker（真实 staging 物化 + 真实 SKILL.md），
// sandbox/evaluator/evolution 走 mock；DSH_HOME 指向临时目录，不碰真实 ~/.dsh。

import { readFileSync } from 'node:fs';
import * as qualityStaticPlugin from '../../agint-quality-static/lib/index.js';
import { SKILL_FAMILY_ENABLED } from '../../agint-quality-static/lib/static-profile.js';

const DSH_HOME_BACKUP = process.env.DSH_HOME;

function setupEvalCtx(tmpDir, options = {}) {
  const events = [];
  // 真实 quality-static service（T8 关键：真实 staging 物化 + 真实 checker 族）
  const qsCtx = mockCtx({});
  qualityStaticPlugin.apply(qsCtx, {});
  const qualityStatic = qsCtx._provided['agint.qualityStatic'];
  const qualitySandbox = {
    runSmoke: async ({ target }) => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
  };
  const qualityEvaluator = options.evalMode === 'fail'
    ? { evaluate: async () => { throw new Error('evaluator down (simulated)'); } }
    : { evaluate: async (target) => ({ id: target.id, kind: target.kind, scores: { composite: 71.4 }, findings: [] }) };
  const evolutionLogs = [];
  const evolution = {
    logPhase4: async (entry) => { evolutionLogs.push(entry); return { ok: true }; },
  };
  const skills = {
    list: async () => (typeof options.existingSkills === 'function' ? await options.existingSkills() : (options.existingSkills ?? [])),
  };
  const ctx = mockCtx({
    'agint.eventBus.publish': async (envelope) => { events.push(envelope); },
    'agint.qualityStatic': qualityStatic,
    'agint.qualitySandbox': qualitySandbox,
    'agint.qualityEvaluator': qualityEvaluator,
    'agint.evolution': evolution,
    'skills': skills,
  });
  const jsonlPath = join(tmpDir, `stats_${Math.random().toString(36).slice(2)}.jsonl`);
  const records = [
    ...taskRecords({ sessionId: 'e1', turn: 1, path: 'a/x.md' }),
    ...taskRecords({ sessionId: 'e2', turn: 1, path: 'b/y.md' }),
    ...taskRecords({ sessionId: 'e3', turn: 2, path: 'c/z.md' }),
  ];
  writeFileSync(jsonlPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  process.env.DSH_HOME = tmpDir;
  plugin.apply(ctx, { jsonlPath, aggregate_window_hours: 24 });
  return { ctx, events, svc: ctx._provided['agint.skillAutocreate'], evolutionLogs, qualityStatic };
}

test('T8 核心验收：内容完全正常的候选走完 Phase1-3 → QUEUED_FOR_RELEASE（71.4 不死锁，闭环闭合）', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'autocreate-eval-'));
  try {
    const { svc, events, evolutionLogs, ctx } = setupEvalCtx(tmp);
    const detected = await svc.detect({});
    assert.equal(detected.candidatesCreated, 1);
    const candId = detected.candidateIds[0];

    const out = await svc.triggerEval({ id: candId });
    assert.equal(out.finalStatus, 'QUEUED_FOR_RELEASE', '终态必须 QUEUED_FOR_RELEASE（进入发布队列、闭环不中断），而非 REJECTED_EVAL（T8 红线：71.4 不死锁）');
    assert.equal(out.composite, 71.4);
    assert.equal(out.compositeTrusted, false);
    assert.equal(out.evidenceLevel, 'E0', '无 scripts → E0');
    assert.equal(out.provisional, true);
    assert.ok(out.rankingScore > 0);

    // 候选终态 + 中间态逐阶段落盘可观测（evalResults 三阶段全齐）
    const cand = await svc.getCandidate(candId);
    assert.equal(cand.status, 'QUEUED_FOR_RELEASE', '候选必须进入 QUEUED_FOR_RELEASE 才能被 releaseQueue 接走（B 闭环第三断点修复）');
    assert.equal(cand.evalResults.phase1.status, 'pass');
    assert.equal(cand.evalResults.phase2.status, 'skipped');
    assert.equal(cand.evalResults.phase3.hardGatePassed, true);

    // 事件：phase1/2/3-passed（skipped 不发 phase2 事件）
    const topics = events.map((e) => e.topic);
    assert.ok(topics.includes('skill-autocreate.phase1-passed'));
    assert.ok(topics.includes('skill-autocreate.phase2-passed') === false, 'skipped 不发 phase2-passed');
    assert.ok(topics.includes('skill-autocreate.phase3-passed'));

    // proposals 表写入（§7.2 字段：rankingScore/evidenceLevel/provisional/status）
    const d = await ctx.storageDomain.open();
    const propEntries = [...d.table('proposals').entries()].map(([, v]) => v);
    assert.equal(propEntries.length, 1);
    assert.equal(propEntries[0].candidateId, candId);
    assert.equal(propEntries[0].status, 'QUEUED_FOR_RELEASE');
    assert.equal(propEntries[0].provisional, true);
    assert.equal(propEntries[0].evidenceLevel, 'E0');
    assert.equal(propEntries[0].rankingScore, out.rankingScore);

    // evolution：phase3-provisional 记录
    assert.ok(evolutionLogs.length === 1);
    assert.equal(evolutionLogs[0].targetKind, 'skill');
    assert.equal(evolutionLogs[0].decision, 'PENDING_REVIEW');
    assert.ok(evolutionLogs[0].tags.includes('phase3-provisional'));
  } finally {
    process.env.DSH_HOME = DSH_HOME_BACKUP;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('T4/T5：去重拦截（与现有技能同名 → REJECTED_STATIC dedup）', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'autocreate-eval-'));
  try {
    // 候选名 detect 后才确定：existingSkills 用延迟函数（先空后注入）
    let candName = null;
    const { svc, events } = setupEvalCtx(tmp, {
      existingSkills: () => (candName ? [{ name: candName }] : []),
    });
    const detected = await svc.detect({});
    const candId = detected.candidateIds[0];
    const cand = await svc.getCandidate(candId);
    candName = cand.skillDraft.name; // 触发第二次 triggerEval 时命中同名去重

    const out = await svc.triggerEval({ id: candId });
    assert.equal(out.finalStatus, 'REJECTED_STATIC');
    assert.equal(out.rejected, 'dedup');
    assert.equal(out.matchedName, candName);
    assert.ok(events.some((e) => e.topic === 'skill-autocreate.phase1-rejected'));
  } finally {
    process.env.DSH_HOME = DSH_HOME_BACKUP;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('T4：attempts 超限转人工；非 PENDING_EVAL 拒绝评估', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'autocreate-eval-'));
  try {
    const { svc, ctx } = setupEvalCtx(tmp);
    const detected = await svc.detect({});
    const candId = detected.candidateIds[0];

    // ① attempts 超限：直接把候选 evalAttempts 提到上限（同一 domain 可共享）
    const d = await ctx.storageDomain.open();
    const cdTable = d.table('candidates');
    const entry = [...cdTable.entries()].find(([, v]) => v.id === candId);
    await cdTable.put(candId, { ...entry[1], evalAttempts: 3 });
    const out = await svc.triggerEval({ id: candId });
    assert.equal(out.skipped, true);
    assert.match(out.reason, /转人工/);
    // 超限后候选仍 PENDING_EVAL（留给人工）
    assert.equal((await svc.getCandidate(candId)).status, 'PENDING_EVAL');

    // ② 非 PENDING_EVAL 拒绝：人工拒绝后状态离开，再触发必须报错
    await svc.rejectCandidate({ id: candId, reason: '误报' });
    await assert.rejects(() => svc.triggerEval({ id: candId }), /仅 PENDING_EVAL 可评估/);
  } finally {
    process.env.DSH_HOME = DSH_HOME_BACKUP;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('T4：evaluator 抛错 → REJECTED_EVAL 可重试（非终态，attempts+1 + cooldown）', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'autocreate-eval-'));
  try {
    const { svc, events } = setupEvalCtx(tmp, { evalMode: 'fail' });
    const detected = await svc.detect({});
    const candId = detected.candidateIds[0];

    const out = await svc.triggerEval({ id: candId });
    assert.equal(out.finalStatus, 'PENDING_EVAL', '评估失败保持可重试状态');
    assert.equal(out.retryable, true);
    assert.equal(out.attempts, 1);
    assert.ok(out.cooldownUntil > new Date().toISOString());
    assert.match(out.reason, /evaluator down/);

    const cand = await svc.getCandidate(candId);
    assert.equal(cand.status, 'PENDING_EVAL', '失败不落终态');
    assert.equal(cand.evalAttempts, 1);
    assert.ok(cand.cooldownUntil);
    assert.equal(cand.evalResults.phase3.status, 'reject');
    assert.ok(events.some((e) => e.topic === 'skill-autocreate.phase3-rejected'));
  } finally {
    process.env.DSH_HOME = DSH_HOME_BACKUP;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('T6：listCandidates 支持 evidenceLevel / provisional 过滤', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'autocreate-eval-'));
  try {
    const { svc } = setupEvalCtx(tmp);
    await svc.detect({});
    const cands = await svc.listCandidates({});
    await svc.triggerEval({ id: cands[0].id });

    const e0 = await svc.listCandidates({ evidenceLevel: 'E0' });
    assert.equal(e0.length, 1, 'E0 过滤命中已评估候选');
    const e1 = await svc.listCandidates({ evidenceLevel: 'E1' });
    assert.equal(e1.length, 0);
    const prov = await svc.listCandidates({ provisional: true });
    assert.equal(prov.length, 1);
  } finally {
    process.env.DSH_HOME = DSH_HOME_BACKUP;
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── B4（2026-09-13）：评估桥 evaluateQueue 自动推进 PENDING_EVAL → QUEUED_FOR_RELEASE ──
// 此前生产里没有任何 cron / 事件自动调用 triggerEval（只被人工 tools.js 与测试调用），
// 候选永远卡在 PENDING_EVAL；evaluateQueue 桥接后，detect → eval → queue 在单日 cron 内闭合。
test('B4 评估桥 evaluateQueue：PENDING_EVAL 自动推进到 QUEUED_FOR_RELEASE（闭环闭合）', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'autocreate-evalq-'));
  try {
    const { svc } = setupEvalCtx(tmp);
    const detected = await svc.detect({});
    assert.equal(detected.candidatesCreated, 1);
    const candId = detected.candidateIds[0];
    const before = await svc.getCandidate(candId);
    assert.equal(before.status, 'PENDING_EVAL', 'detect 后候选停在 PENDING_EVAL，等评估桥推进');

    const res = await svc.evaluateQueue();
    assert.equal(res.attempted, 1);
    assert.equal(res.evaluated, 1);
    assert.equal(res.queued, 1, '候选应被推进到 QUEUED_FOR_RELEASE（第三断点修复后）');

    const after = await svc.getCandidate(candId);
    assert.equal(after.status, 'QUEUED_FOR_RELEASE', '评估桥必须把候选送到发布队列，否则发布层无从接走');
  } finally {
    process.env.DSH_HOME = DSH_HOME_BACKUP;
    rmSync(tmp, { recursive: true, force: true });
  }
});
