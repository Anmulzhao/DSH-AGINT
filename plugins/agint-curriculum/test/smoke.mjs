#!/usr/bin/env node
// agint-curriculum smoke — `node test/smoke.mjs` 一行能跑。
//
// 不挂 Cordis、不真打开 storage domain。只验证：
//   - 导出契约（name / inject / apply / ConfigSchema）
//   - FROZEN schema（Challenge / Attempt / DifficultyState / AuditLog）校验
//   - 枚举与 LIMITS 与 Sprint14 §4.7 / §4.6 一致
//   - storage spec shape（域名/4 表/版本）
//   - D4 数据源黑名单常量与过滤函数（curriculum 持副本）
//   - pack 函数元数据注入 + sessionId 前缀（D1）

import test from 'node:test';
import assert from 'node:assert/strict';

import * as schema from '../lib/schema.js';
import * as storage from '../lib/storage.js';
import * as plugin from '../lib/index.js';
import { generateChallenge } from '../lib/challenge-gen.js';
import { judge } from '../lib/verdict.js';
import { probeDomains } from '../lib/boundary-probe.js';

test('导出契约：name / inject / apply / ConfigSchema', () => {
  assert.equal(plugin.name, 'agint-curriculum');
  assert.deepEqual(plugin.inject, ['storageDomain']);
  assert.equal(typeof plugin.apply, 'function');
  assert.ok(plugin.ConfigSchema);
  const c = plugin.ConfigSchema.parse({});
  assert.equal(c.stale_reverify_days, 30);
  assert.equal(c.generation_batch_limit, 5);
  assert.equal(c.challenge_cooldown_hours, 24);
  assert.equal(c.difficulty_window_days, 28);
  assert.equal(c.difficulty_min_samples, 5);
  assert.equal(c.pass_floor, 0.40);
  assert.equal(c.pass_ceiling, 0.70);
  assert.equal(c.force_promote_streak, 3);
  assert.equal(c.force_demote_streak, 3);
  assert.equal(c.require_evidence, true);
  assert.equal(c.auto_execute_enabled, false);       // §4.5：Sprint 14 恒 false
  assert.equal(c.self_model_writeback, true);        // §4.9
});

test('枚举 = Sprint14 §4.7 / §4.6 / §5.2 B-3', () => {
  assert.deepEqual([...schema.DIFFICULTY_LEVELS], ['D1', 'D2', 'D3', 'D4', 'D5']);
  assert.deepEqual([...schema.TEMPLATE_DOMAINS], ['codegen', 'reasoning', 'planning', 'tool-use']);
  assert.deepEqual([...schema.VERDICT_RESULTS], ['pass', 'fail']);
  assert.ok(schema.CHALLENGE_STATUSES.includes('open'));
  assert.ok(schema.CHALLENGE_STATUSES.includes('passed'));
  assert.ok(schema.CHALLENGE_STATUSES.includes('failed'));
  assert.ok(schema.CHALLENGE_STATUSES.includes('unverifiable'));
});

test('LIMITS：challenges 200 / attempts 500 / difficulty_state 100 / audit 1000', () => {
  assert.equal(schema.LIMITS.CHALLENGES, 200);
  assert.equal(schema.LIMITS.ATTEMPTS, 500);
  assert.equal(schema.LIMITS.DIFFICULTY_STATE, 100);
  assert.equal(schema.LIMITS.AUDIT_LOG, 1000);
});

test('storage spec：agint_curriculum 域 + 4 表 + version 1', () => {
  assert.equal(storage.spec.name, 'agint_curriculum');
  assert.equal(storage.spec.version, 1);
  const tables = Object.keys(storage.spec.tables ?? storage.spec.config?.tables ?? {});
  if (tables.length) {
    for (const t of ['challenges', 'attempts', 'difficulty_state', 'audit_log']) {
      assert.ok(tables.includes(t), `缺表 ${t}`);
    }
  }
});

test('D4：数据源黑名单常量形状 + isExcludedRecord 判定（curriculum 持副本）', () => {
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

test('pack 函数：注入 id/kind/metadata 且过 entry schema；sessionId 带 curriculum- 前缀（D1）', () => {
  const ch = storage.packChallenge({
    domain: 'codegen', templateType: 'codegen', level: 'D1', status: 'open',
    prompt: 'p', passCriteria: 'c',
    verifySpec: { type: 'exit-code-output', expected: null, minLength: 1 },
    sessionId: 'curriculum-clg_x',
    attemptCount: 0,
  });
  assert.match(ch.id, /^clg_\d{8}_/);
  assert.equal(ch.kind, 'challenge');

  const att = storage.packAttempt({
    challengeId: 'clg_x', domain: 'codegen', templateType: 'codegen', level: 'D1',
    result: 'pass', evidence: { exitCode: 0, output: 'ok' }, verifiedAt: '2026-09-08T00:00:00Z',
  });
  assert.match(att.id, /^att_\d{8}_/);
  assert.equal(att.kind, 'attempt');

  const df = storage.packDifficulty({ domain: 'codegen' });
  assert.equal(df.id, 'df_codegen');
  assert.equal(df.kind, 'difficulty_state');

  const audit = storage.packAudit({ actor: 'system', action: 'x', targetType: 'challenge', targetId: 'clg_x', details: {} });
  assert.equal(audit.kind, 'audit_log');
});

test('challengeSessionId：固定 curriculum- 前缀（D1 隔离基础）', () => {
  assert.equal(storage.challengeSessionId('clg_1'), 'curriculum-clg_1');
  assert.ok(schema.isExcludedRecord({ sessionId: storage.challengeSessionId('clg_1') }));
});

test('generateChallenge：确定性 + 必带 verifySpec（C1）', () => {
  const a = generateChallenge('codegen', 'D2', { sessionId: 's1' });
  const b = generateChallenge('codegen', 'D2', { sessionId: 's1' });
  assert.deepEqual(a, b);
  assert.ok(a.verifySpec?.type);
  assert.ok(a.passCriteria.length > 0);
  assert.throws(() => generateChallenge('unknown-domain', 'D1', {}), /无模板/);
});

test('verdict：C3 无 evidence → fail；C2 自评只进 notes', () => {
  const challenge = generateChallenge('reasoning', 'D1', { sessionId: 's1' });
  const v = judge(challenge, { selfAssessment: '我做得很好' });
  assert.equal(v.result, 'fail');
  assert.match(v.reason, /无 evidence/);
  assert.equal(v.notes, '我做得很好');   // C2：自评剥离进 notes
});

test('boundary-probe：UNCERTAIN 域优先 + miscalibrated 加权 + CAN 复验', () => {
  const snap = {
    capabilities: [
      { domain: 'codegen', status: 'UNCERTAIN', lastVerifiedAt: '2026-08-01T00:00:00Z' },
      { domain: 'planning', status: 'CAN', lastVerifiedAt: '2026-01-01T00:00:00Z' },
      { domain: 'reasoning', status: 'CAN', lastVerifiedAt: '2026-01-01T00:00:00Z' },
      { domain: 'custom-domain', status: 'UNCERTAIN', lastVerifiedAt: '2026-08-01T00:00:00Z' },
    ],
    calibrationSummary: { domains: 4, maxError: 0.2, miscalibrated: ['planning'] },
  };
  const nowMs = Date.parse('2026-09-08T00:00:00Z');
  const { domains, unverifiable } = probeDomains(snap, { staleReverifyDays: 30, nowMs });
  // planning：miscalibrated（权重 2）× 250 天未验证 → 排最前
  assert.equal(domains[0].domain, 'planning');
  // reasoning：CAN 250 天未复验（权重 1）→ 也在待练列表
  assert.ok(domains.map((d) => d.domain).includes('reasoning'));
  assert.ok(domains.map((d) => d.domain).includes('codegen'));
  // custom-domain 无模板 → unverifiable（C1/Q5 诚实留白）
  assert.ok(unverifiable.map((d) => d.domain).includes('custom-domain'));
  assert.ok(!domains.map((d) => d.domain).includes('custom-domain'));
});
