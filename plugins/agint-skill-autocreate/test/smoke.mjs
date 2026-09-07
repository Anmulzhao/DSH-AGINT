#!/usr/bin/env node
// agint-skill-autocreate smoke — `node test/smoke.mjs` 一行能跑。
//
// 不挂 Cordis、不真打开 storage domain。只验证：
//   - 导出契约（name / inject / apply / ConfigSchema）
//   - FROZEN schema（TaskPattern / Candidate / AuditLog）校验与拒绝
//   - LIMITS 与设计稿 §4 一致
//   - storage spec shape（域名/5 表/版本）
//   - pack 函数元数据注入

import test from 'node:test';
import assert from 'node:assert/strict';

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
  assert.equal(c.weekly_deploy_budget, 3);
  assert.equal(c.auto_create_enabled, true);
  assert.equal(c.require_human_approval, false);
  assert.equal(c.aggregate_cron, '45 4 * * *');
});

test('FROZEN 枚举与设计稿状态机一致', () => {
  assert.deepEqual([...schema.CANDIDATE_STATUSES], [
    'PENDING_EVAL',
    'PHASE1_PASS', 'PHASE2_PASS', 'PHASE3_PASS',
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
