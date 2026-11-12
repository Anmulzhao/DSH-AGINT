#!/usr/bin/env node
// agint-skill-autocreate smoke — `node test/smoke.mjs` 一行能跑。
//
// 不挂 Cordis、不真打开 storage domain。只验证：
//   - 导出契约（name / inject / apply / ConfigSchema）
//   - FROZEN schema（TaskPattern / Candidate / AuditLog）校验与拒绝
//   - LIMITS 与设计稿 §4 一致
//   - storage spec shape（域名/5 表/版本）
//   - pack 函数元数据注入
//   - **2026-11-12 假上限修复**：audit_log 滚动清理真的删行 + *.pruned 事件 +
//     删除 API 兜底失败可见（warn + 指标计数）；task_patterns 真 prune
//   - 门禁脚本 bin/check-t-del-callers.mjs 0 命中（exit 0）

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as schema from '../lib/schema.js';
import * as storage from '../lib/storage.js';
import * as plugin from '../lib/index.js';

test('导出契约：name / inject / apply / ConfigSchema', () => {
  assert.equal(plugin.name, 'agint-skill-autocreate');
  assert.deepEqual(plugin.inject, ['storageDomain']);
  assert.equal(typeof plugin.apply, 'function');
  assert.ok(plugin.ConfigSchema);
  // 默认配置 = 设计稿 §8.1
  const c = plugin.ConfigSchema.parse({});
  assert.equal(c.min_occurrence_count, 3);
  assert.equal(c.param_similarity_threshold, 0.8);
  assert.equal(c.weekly_deploy_budget, 20);
  assert.equal(c.auto_create_enabled, true);
  assert.equal(c.require_human_approval, false);
  assert.equal(c.aggregate_cron, '45 4 * * *');
});

test('FROZEN 枚举与设计稿状态机一致', () => {
  assert.deepEqual([...schema.CANDIDATE_STATUSES], [
    'PENDING_EVAL',
    'PHASE1_PASS', 'PHASE2_PASS', 'PHASE3_PASS',
    // 'REJECTED' 是 Sprint 14 的裸值：磁盘上还有 5 条老记录用它（未迁移）。
    // Sprint 15 拆成三种带后缀的拒因后，domain open 会报 "does not match its schema"，
    // 故把裸值作为兼容项加回枚举（语义等价 REJECTED_STATIC）。详见 lib/schema.js 注释。
    'REJECTED',
    'REJECTED_STATIC', 'REJECTED_SANDBOX', 'REJECTED_EVAL',
    'QUEUED_FOR_RELEASE', 'BUDGET_WAIT',
    'RELEASED', 'STABLE', 'ROLLED_BACK',
  ]);
  assert.deepEqual([...schema.PATTERN_STATUSES], [
    'active', 'candidate', 'proposed', 'released', 'dismissed',
  ]);
});

test('LIMITS：patterns 500 / candidates 200 / releases 100 / audit 1000', () => {
  assert.equal(storage.LIMITS.TASK_PATTERNS, 500);
  assert.equal(storage.LIMITS.CANDIDATES, 200);
  assert.equal(storage.LIMITS.RELEASES, 100);
  assert.equal(storage.LIMITS.AUDIT_LOG, 1000);
});

test('storage spec：agint_skill_autocreate 域 + 5 表 + version 1', () => {
  assert.equal(storage.spec.name, 'agint_skill_autocreate');
  assert.equal(storage.spec.version, 1);
  const tables = Object.keys(storage.spec.tables ?? storage.spec.config?.tables ?? {});
  if (tables.length) {
    for (const t of ['task_patterns', 'candidates', 'proposals', 'releases', 'audit_log']) {
      assert.ok(tables.includes(t), `缺表 ${t}`);
    }
  }
});

test('checkLimit：超限返回 warn 形态，未超返回 null', () => {
  assert.equal(storage.checkLimit('task_patterns', 100), null);
  const w = storage.checkLimit('task_patterns', 501);
  assert.ok(w && w._warn);
  assert.equal(storage.checkLimit('nonexistent', 99999), null);
});

test('pack 函数：注入 id/kind/createdAt metadata 且过 entry schema', () => {
  const pattern = storage.packTaskPattern({
    toolSequence: ['terminal'],
    paramSignature: { terminal: 'command:str' },
    description: 'x',
    occurrenceCount: 3,
    firstSeenAt: '2026-09-07T00:00:00Z',
    lastSeenAt: '2026-09-07T00:00:00Z',
    successRate: 1,
  });
  assert.match(pattern.id, /^tp_\d{8}_/);
  assert.equal(pattern.kind, 'task_pattern');

  const cand = storage.packCandidate({
    sourcePatternId: pattern.id,
    source: 'auto',
    triggerEvent: 'daily-aggregate',
    skillDraft: {
      name: 'x', description: 'y', template: 'shell-automation',
      frontmatter: { name: 'x', description: 'y', triggers: [], tools: ['terminal'] },
      body: '## 适用场景\nx',
    },
    estimatedBenefit: {
      successRateImprovement: 0.1, timeSavingsPct: 0.2, tokenSavingsPct: 0.2, harmIncrementEstimate: 0.4,
    },
  });
  assert.match(cand.id, /^sc_\d{8}_/);
  assert.equal(cand.status, 'PENDING_EVAL');

  const audit = storage.packAudit({
    actor: 'system', action: 'candidate_created',
    targetType: 'candidate', targetId: cand.id, details: {},
  });
  assert.equal(audit.kind, 'audit_log');
});

test('datedId：同日前缀稳定 + 随机后缀', () => {
  const a = storage.datedId('tp');
  const b = storage.datedId('tp');
  assert.equal(a.slice(0, 10), b.slice(0, 10));
  assert.notEqual(a, b);
});

// ── 2026-11-12：假上限修复的取证用例 ───────────────────────────────────────
//
// 背景：宿主 storage 表 API 只有 delete(key)/deleteMany(keys)（**没有 del**），
// 而本插件此前用的是 `del`（恒 undefined ⇒ 抛错被空 catch 吞 ⇒ 一条都删不掉），
// 且计数用迭代器的 `.length`（undefined）⇒ 上限检查恒不触发。
// 这两条合起来 = **滚动清理从未真的发生过**（假上限）。
//
// 本组用例锁四件事：
//   ① audit_log 超上限后行数**真的下降**（不是只 warn）
//   ② 删除真的发生了（被 seed 的最旧行确实消失）
//   ③ 删了要留痕（发出 *.pruned 事件）
//   ④ 表 API 没有 delete 时，兜底失败**可见**（warn + storage.pruneFailed 计数），
//      不许被空 catch 吞掉

/** 内存版 storage 表：**镜像宿主 API 的真实形状**（entries 是迭代器、有 size、有 delete） */
function fakeTable({ withDelete = true } = {}) {
  const m = new Map();
  const t = {
    put: async (k, v) => { m.set(k, v); },
    entries: () => [...m.entries()][Symbol.iterator](),
    get size() { return m.size; },
    _map: m,
  };
  if (withDelete) {
    t.delete = async (k) => m.delete(k);
    t.deleteMany = async (keys) => { let n = 0; for (const k of keys) if (m.delete(k)) n += 1; return n; };
  }
  return t;
}

function fakeDomain({ withDelete = true } = {}) {
  const tables = new Map();
  return {
    close: async () => {},
    table: (name) => {
      if (!tables.has(name)) tables.set(name, fakeTable({ withDelete }));
      return tables.get(name);
    },
  };
}

function mockCtx({ withDelete = true } = {}) {
  const provided = {};
  const published = [];
  const metrics = {};
  const domain = fakeDomain({ withDelete });
  return {
    storageDomain: { open: async () => domain },
    get: (key) => (key === 'agint.eventBus.publish'
      ? async (envelope) => { published.push(envelope); return { accepted: true }; }
      : null),
    provide: (key, val) => { provided[key] = val; },
    effect: () => {},
    metrics: (key, delta) => { metrics[key] = (metrics[key] ?? 0) + delta; },
    _provided: provided,
    _published: published,
    _metrics: metrics,
    _domain: domain,
  };
}

function boot(ctx) {
  plugin.apply(ctx, {
    jsonlPath: '/nonexistent/stats.jsonl',
    session_source: 'tool_stats',
    semantic_window_enabled: false,
  });
  return ctx._provided['agint.skillAutocreate'];
}

/** 预填 audit_log 到上限（1000 行），行 id 可寻址 */
async function seedAuditLog(t, count = 1000) {
  const base = Date.parse('2026-01-01T00:00:00Z');
  for (let i = 0; i < count; i += 1) {
    await t.put(`seed_${i}`, {
      id: `seed_${i}`,
      kind: 'audit_log',
      timestamp: new Date(base + i * 1000).toISOString(),
      actor: 'system',
      action: 'seed',
      targetType: 'x',
      targetId: 'x',
      details: {},
      reason: null,
    });
  }
}

test('audit_log 超上限后真删行（行数不增）+ 发 *.pruned 事件', async () => {
  const ctx = mockCtx();
  const svc = boot(ctx);
  const t = ctx._domain.table('audit_log');
  await seedAuditLog(t, 1000);
  assert.equal(t.size, 1000);

  await svc.pause();
  await svc.pause();
  await svc.pause();

  // ① 行数被压回上限（修复前：只 warn ⇒ 会涨到 1003）
  assert.equal(t.size, 1000, 'audit_log 必须被压回上限（修复前会涨到 1003）');
  // ② 最旧的行确实被删了（不是只记 warn）
  assert.equal(t._map.has('seed_0'), false, '最旧的 seed 行必须真的消失');
  assert.equal(t._map.has('seed_999'), true, '较新的行不该被删');
  // ③ 留痕：发了 *.pruned 事件，payload 含 removed
  const pruned = ctx._published.filter((e) => String(e.topic).endsWith('.pruned'));
  assert.ok(pruned.length >= 1, '必须发出 *.pruned 事件');
  assert.ok(pruned[0].payload.removed >= 1, 'payload.removed 必须 ≥ 1');
  // 删除成功时不该有失败计数
  assert.equal(ctx._metrics['storage.pruneFailed'], undefined);
});

test('表 API 没有 delete 时：兜底失败可见（不抛错 + 指标计数），不静默吞掉', async () => {
  const ctx = mockCtx({ withDelete: false });
  const svc = boot(ctx);
  const t = ctx._domain.table('audit_log');
  await seedAuditLog(t, 1000);

  // 不抛错（兜底 reject 被 deleteRow 接住）
  await svc.pause();

  // 失败被记成可观测计数，而不是消失在空 catch 里
  assert.equal(ctx._metrics['storage.pruneFailed'], 1, '删除失败必须计入 storage.pruneFailed');
  // 行没被删（没有 delete 方法就是删不掉）——但也不许假装删了
  assert.equal(t.size, 1001);
});

test('task_patterns 超 500：prune 删掉超期的，活跃的不被删（宁可超限也不误删）', async () => {
  const ctx = mockCtx();
  const svc = boot(ctx);
  const prune = ctx._provided['agint.skillAutocreate.prunePatterns'];
  assert.equal(typeof prune, 'function', '必须以扁平子键提供（cordis service store 是扁平的）');

  const tp = ctx._domain.table('task_patterns');
  const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const fresh = new Date().toISOString();
  const seed = async (id, seenAt) => {
    await tp.put(id, storage.packTaskPattern({
      id,
      toolSequence: ['terminal'],
      paramSignature: { terminal: 'command:str' },
      description: `pattern ${id}`,
      occurrenceCount: 3,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      successRate: 1,
      status: 'active',
      linkedCandidateId: null,
      createdAt: seenAt,
      updatedAt: seenAt,
    }, { id, createdAt: seenAt }));
  };
  for (let i = 0; i < 5; i += 1) await seed(`stale_${i}`, old);      // 60 天前 → 超期
  for (let i = 0; i < 500; i += 1) await seed(`fresh_${i}`, fresh);  // 刚命中 → 活跃
  assert.equal(tp.size, 505);

  const res = await prune({ maxAgeDays: 30, maxCount: 500 });
  assert.equal(res.removed, 5, '只该删 5 条超期的');
  assert.ok(res.freedBytes > 0, '必须报出释放字节数');
  assert.equal(tp.size, 500);
  assert.equal(tp._map.has('stale_0'), false, '超期的必须被删');
  assert.equal(tp._map.has('fresh_0'), true, '活跃的绝不能被删');

  // 留痕事件
  const pruned = ctx._published.filter((e) => e.topic === 'skillAutocreate.patternsPruned');
  assert.ok(pruned.length >= 1, '必须发 skillAutocreate.patternsPruned');
  assert.equal(pruned[0].payload.removed, 5);
  assert.ok(pruned[0].payload.freedBytes > 0);
});

test('task_patterns 全活跃时超限：一条都不删（宁可超限也不误删）', async () => {
  const ctx = mockCtx();
  const svc = boot(ctx);
  const prune = ctx._provided['agint.skillAutocreate.prunePatterns'];
  const tp = ctx._domain.table('task_patterns');
  const fresh = new Date().toISOString();
  for (let i = 0; i < 505; i += 1) {
    await tp.put(`p_${i}`, storage.packTaskPattern({
      id: `p_${i}`,
      toolSequence: ['terminal'],
      paramSignature: { terminal: 'command:str' },
      description: `pattern p_${i}`,
      occurrenceCount: 3,
      firstSeenAt: fresh,
      lastSeenAt: fresh,
      successRate: 1,
      status: 'active',
      linkedCandidateId: null,
      createdAt: fresh,
      updatedAt: fresh,
    }, { id: `p_${i}`, createdAt: fresh }));
  }
  const res = await prune({ maxAgeDays: 30, maxCount: 500 });
  assert.equal(res.removed, 0, '全部活跃时不得删除');
  assert.equal(tp.size, 505);
  assert.equal(res.skipped, 'no-stale-patterns');
  assert.equal(svc, ctx._provided['agint.skillAutocreate']);
});

test('sampleArgs 长度上限：upsert 时压到 2 KB 内（不改字段名，只截断值）', () => {
  const huge = { terminal: { command: 'x'.repeat(50_000) } };
  const packed = storage.packTaskPattern({
    toolSequence: ['terminal'],
    paramSignature: { terminal: 'command:str' },
    sampleArgs: huge,
    description: 'x',
    occurrenceCount: 3,
    firstSeenAt: '2026-09-07T00:00:00Z',
    lastSeenAt: '2026-09-07T00:00:00Z',
    successRate: 1,
  });
  const size = JSON.stringify(packed).length;
  assert.ok(size <= storage.SAMPLE_ARGS_MAX_CHARS + 512, `压后仍过大：${size}`);
  assert.ok(packed.sampleArgs.terminal, '字段名不变');
  assert.ok(typeof packed.sampleArgs.terminal.command === 'string');
  assert.match(packed.sampleArgs.terminal.command, /truncated/, '截断必须带标记');
});

test('门禁：bin/check-t-del-callers.mjs 0 命中（exit 0）', () => {
  const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
  const r = spawnSync(process.execPath, [join(repoRoot, 'bin', 'check-t-del-callers.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, `check-t-del-callers 应 0 命中：\n${r.stdout}\n${r.stderr}`);
});
