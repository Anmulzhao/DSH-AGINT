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

test('状态枚举 = Sprint14 §3.3 四态（pinned 是状态不是标志位）', () => {
  assert.deepEqual([...schema.SKILL_STATES], ['active', 'stale', 'archived', 'pinned']);
  assert.deepEqual([...schema.MANAGED_SOURCES], ['auto', 'manual']);
  assert.deepEqual([...schema.UNMANAGED_SOURCES], ['bundled', 'hub', 'external']);
});

test('LIMITS：skill_states 200 / curation_actions 500 / reports 52 / audit 1000', () => {
  assert.equal(schema.LIMITS.SKILL_STATES, 200);
  assert.equal(schema.LIMITS.CURATION_ACTIONS, 500);
  assert.equal(schema.LIMITS.REPORTS, 52);
  assert.equal(schema.LIMITS.AUDIT_LOG, 1000);
});

test('storage spec：agint_curator 域 + 4 表 + version 1', () => {
  assert.equal(storage.spec.name, 'agint_curator');
  assert.equal(storage.spec.version, 1);
  const tables = Object.keys(storage.spec.tables ?? storage.spec.config?.tables ?? {});
  if (tables.length) {
    for (const t of ['skill_states', 'curation_actions', 'reports', 'audit_log']) {
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
