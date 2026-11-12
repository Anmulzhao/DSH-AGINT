#!/usr/bin/env node
// agint-curator smoke — `node test/smoke.mjs` 一行能跑。
//
// 不挂 Cordis、不真打开 storage domain。只验证：
//   - 导出契约（name / inject / apply / ConfigSchema）
//   - FROZEN schema（SkillState / CurationAction / Report / AuditLog）校验
//   - 状态枚举与 LIMITS 与 Sprint14 §3.2 / P0-2 §12.1 一致
//   - storage spec shape（域名/4 表/版本）
//   - D3/D4 数据源黑名单常量与过滤函数
//   - pack 函数元数据注入

import test from 'node:test';
import assert from 'node:assert/strict';

import * as schema from '../lib/schema.js';
import * as storage from '../lib/storage.js';
import * as plugin from '../lib/index.js';
import { evaluateSkill } from '../lib/state-engine.js';

test('导出契约：name / inject / apply / ConfigSchema', () => {
  assert.equal(plugin.name, 'agint-curator');
  assert.deepEqual(plugin.inject, ['storageDomain']);
  assert.equal(typeof plugin.apply, 'function');
  assert.ok(plugin.ConfigSchema);
  const c = plugin.ConfigSchema.parse({});
  assert.equal(c.stale_after_days, 30);
  assert.equal(c.archive_after_days, 90);
  assert.equal(c.new_skill_protection_days, 14);   // Sprint14 §3.4 A-16
  assert.equal(c.reactivate_within_days, 7);
  assert.equal(c.weekly_archive_budget, 10);
  assert.equal(c.auto_curation_enabled, true);
  assert.equal(c.dry_run_default, false);
  assert.equal(c.weekly_cron, '0 2 * * 0');          // 周日 02:00，早于 evolve-review 03:45
  assert.deepEqual(c.protected_skills, ['plan', 'memory-discipline', 'causal-reasoning']);
});

test('状态枚举 = Sprint14 §3.3 四态 + Sprint15 §3.2 quality_declining', () => {
  assert.deepEqual([...schema.SKILL_STATES], ['active', 'stale', 'archived', 'pinned', 'quality_declining']);
  assert.deepEqual([...schema.MANAGED_SOURCES], ['auto', 'manual']);
  assert.deepEqual([...schema.UNMANAGED_SOURCES], ['bundled', 'hub', 'external']);
});

test('LIMITS：skill_states 200 / curation_actions 500 / reports 52 / audit 1000 / overlap 200', () => {
  assert.equal(schema.LIMITS.SKILL_STATES, 200);
  assert.equal(schema.LIMITS.CURATION_ACTIONS, 500);
  assert.equal(schema.LIMITS.REPORTS, 52);
  assert.equal(schema.LIMITS.AUDIT_LOG, 1000);
  assert.equal(schema.LIMITS.OVERLAP_CANDIDATES, 200);
});

test('storage spec：agint_curator 域 + 5 表 + version 2（Sprint 15 增 overlap_candidates）', () => {
  assert.equal(storage.spec.name, 'agint_curator');
  assert.equal(storage.spec.version, 2);
  const tables = Object.keys(storage.spec.tables ?? storage.spec.config?.tables ?? {});
  if (tables.length) {
    for (const t of ['skill_states', 'curation_actions', 'reports', 'audit_log', 'overlap_candidates']) {
      assert.ok(tables.includes(t), `缺表 ${t}`);
    }
  }
});

test('D4：数据源黑名单常量形状 + isExcludedRecord 判定', () => {
  assert.equal(schema.DATA_SOURCE_BLACKLIST_VERSION, '2026-09-14.v1');
  assert.deepEqual([...schema.EXCLUDED_DATA_SOURCES.sessionIdPrefixes], ['curriculum-']);
  assert.deepEqual([...schema.EXCLUDED_DATA_SOURCES.sourceTags], ['curriculum']);

  assert.equal(schema.isExcludedRecord({ sessionId: 'curriculum-abc', tool: 'x' }), true);
  assert.equal(schema.isExcludedRecord({ sessionId: 's1', source: 'curriculum' }), true);
  // 向后兼容：旧记录无这两个字段 → 照常处理
  assert.equal(schema.isExcludedRecord({ sessionId: 's1', tool: 'x' }), false);
  assert.equal(schema.isExcludedRecord(null), false);
  assert.equal(schema.isExcludedRecord({}), false);
});

test('§9.4 自我评估禁止：策展相关技能自动 protected', () => {
  assert.equal(schema.isSelfProtecting('skill-curator'), true);
  assert.equal(schema.isSelfProtecting('策展助手'), true);
  assert.equal(schema.isSelfProtecting('memory-discipline'), false);
});

test('state-engine 是纯函数：同输入同输出且不改入参', () => {
  const skill = {
    skillName: 'x', state: 'active', source: 'manual', protected: false,
    createdAt: '2026-01-01T00:00:00Z',
    usage: { useCount: 1, lastUsedAt: '2026-01-01T00:00:00Z' },
  };
  const cfg = plugin.ConfigSchema.parse({});
  const nowMs = Date.parse('2026-09-07T00:00:00Z');
  const snapshot = JSON.stringify(skill);
  const a = evaluateSkill({ skill, config: cfg, nowMs });
  const b = evaluateSkill({ skill, config: cfg, nowMs });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(skill), snapshot);
});

test('pack 函数：注入 id/kind/createdAt metadata 且过 entry schema', () => {
  const st = storage.packSkillState({
    skillName: 'demo', state: 'active', stateChangedAt: '2026-09-07T00:00:00Z',
  });
  assert.match(st.id, /^ss_\d{8}_/);
  assert.equal(st.kind, 'skill_state');

  const act = storage.packCurationAction({
    action: 'archive', skillName: 'demo', details: { fromState: 'stale', toState: 'archived' },
  });
  assert.match(act.id, /^ca_\d{8}_/);
  assert.equal(act.result, 'success');

  const rep = storage.packReport({
    week: '2026-W37', generatedAt: '2026-09-07T00:00:00Z',
    summary: { totalSkillsChecked: 1, newlyStale: 0, newlyArchived: 0, reactivated: 0, pinned: 0, protected: 0, skipped: 0 },
  });
  assert.equal(rep.id, 'rep_2026-W37');
  assert.equal(rep.kind, 'curation_report');

  const audit = storage.packAudit({
    actor: 'system', action: 'archived', targetType: 'skill_state', targetId: st.id, details: {},
  });
  assert.equal(audit.kind, 'audit_log');
});

test('isoWeek：ISO 周标签形如 2026-W37', () => {
  assert.equal(storage.isoWeek(new Date('2026-09-07T00:00:00Z')), '2026-W37');
  assert.match(storage.isoWeek(new Date('2026-01-01T00:00:00Z')), /^2026-W\d{2}$/);
});

// ── 2026-11-12：假上限修复的取证用例 ───────────────────────────────────────
//
// 宿主 storage 表 API 只有 delete(key)/deleteMany(keys)（**没有 del**），
// 而本插件此前用的是 `del`（恒 undefined ⇒ `if (del)` 整块跳过 ⇒ 永不删除），
// 且计数用迭代器的 `.length`（undefined）⇒ 上限检查恒不触发。
// 合起来 = **滚动清理从未真的发生过**。
//
// 本组用例锁：① 超上限后行数真的下降 ② 被删的行确实消失
//            ③ 删了要留痕（*.pruned 事件）④ 删除 API 缺失时失败可见（指标计数）

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

/** 预填 audit_log 到上限（1000 行） */
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
  plugin.apply(ctx, {});
  const svc = ctx._provided['agint.curator'];
  const t = ctx._domain.table('audit_log');
  await seedAuditLog(t, 1000);
  assert.equal(t.size, 1000);

  await svc.pause();
  await svc.pause();
  await svc.pause();

  assert.equal(t.size, 1000, 'audit_log 必须被压回上限（修复前会涨到 1003）');
  assert.equal(t._map.has('seed_0'), false, '最旧的 seed 行必须真的消失');
  assert.equal(t._map.has('seed_999'), true, '较新的行不该被删');
  const pruned = ctx._published.filter((e) => String(e.topic).endsWith('.pruned'));
  assert.ok(pruned.length >= 1, '必须发出 *.pruned 事件');
  assert.ok(pruned[0].payload.removed >= 1);
  assert.equal(ctx._metrics['storage.pruneFailed'], undefined);
});

test('表 API 没有 delete 时：兜底失败可见（不抛错 + 指标计数）', async () => {
  const ctx = mockCtx({ withDelete: false });
  plugin.apply(ctx, {});
  const svc = ctx._provided['agint.curator'];
  const t = ctx._domain.table('audit_log');
  await seedAuditLog(t, 1000);

  await svc.pause();   // 不抛错

  assert.equal(ctx._metrics['storage.pruneFailed'], 1, '删除失败必须计入 storage.pruneFailed');
  assert.equal(t.size, 1001, '删不掉就是删不掉，不许假装删了');
});
