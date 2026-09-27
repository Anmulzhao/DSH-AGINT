/**
 * agint-metrics 扩展块测试 — Day 0（美的神谕层方案 C）。
 * Run: node --test plugins/agint-metrics/test/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { METRIC_DEFS, METRIC_DEFS_BASE } from '../lib/metrics.js';
import {
  METRIC_DEFS_EXT, computeMetricsExt, makeSkillsFsSource, defaultSkillRoots,
} from '../lib/metrics-ext.js';

test('METRIC_DEFS = 基础 13 + 扩展 4 = 17，且新 key 全部在册', () => {
  assert.equal(METRIC_DEFS_BASE.length, 13);
  assert.equal(METRIC_DEFS_EXT.length, 4);
  assert.equal(METRIC_DEFS.length, 17);
  const keys = METRIC_DEFS.map((d) => d.key);
  for (const k of [
    'autocreate.candidatesRejected', 'skills.totalBytes',
    'evolution.logCount7d', 'evolution.logCount30d',
  ]) {
    assert.ok(keys.includes(k), `missing metric key ${k}`);
  }
  // 基础 13 key 不受扩展影响（引用同一数组元素，顺序保持）
  assert.deepEqual(METRIC_DEFS.slice(0, 13), METRIC_DEFS_BASE);
});

test('computeMetricsExt：三个 source 全健康时 4 key 齐全', async () => {
  const fakeAutocreate = {
    stats: async () => ({
      candidates: { total: 42, byStatus: { REJECTED: 37, RELEASED: 3, ROLLED_BACK: 2 } },
    }),
  };
  const fakeEvolution = {
    getLogRange: async ({ fromDate }) => {
      const now = Date.now();
      // 前 5 条落在近 7 天内，其余 168 条落在 7~30 天之间（仍在 30 天窗内）；
      // 另有 2 条 oracle 审计条目（神谕层自己的日志）——§3.5 硬规则：必须被排除
      return Array.from({ length: 175 }, (_, i) => ({
        ts: new Date(i < 5 ? now - i * 1000 : now - 10 * 86_400_000 - i * 1000).toISOString(),
        targetKind: i >= 173 ? 'oracle-daily' : 'skill',
      }));
    },
  };
  const tmp = mkdtempSync(join(tmpdir(), 'agint-metrics-ext-'));
  try {
    mkdirSync(join(tmp, 'skills-a', 'demo-skill'), { recursive: true });
    writeFileSync(join(tmp, 'skills-a', 'demo-skill', 'SKILL.md'), 'x'.repeat(1000));
    mkdirSync(join(tmp, 'skills-b', 'nested', 'deep'), { recursive: true });
    writeFileSync(join(tmp, 'skills-b', 'nested', 'deep', 'SKILL.md'), 'y'.repeat(2000));
    const skillsFs = makeSkillsFsSource([join(tmp, 'skills-a'), join(tmp, 'skills-b')]);

    const recs = await computeMetricsExt({ skillAutocreate: fakeAutocreate, evolution: fakeEvolution, skillsFs });
    const byKey = new Map(recs.map((r) => [r.key, r]));
    assert.equal(byKey.size, 4);
    assert.equal(byKey.get('autocreate.candidatesRejected').value, 37);
    assert.equal(byKey.get('skills.totalBytes').value, 3000);
    assert.equal(byKey.get('skills.totalBytes').meta && JSON.parse(byKey.get('skills.totalBytes').meta).fileCount, 2);
    // 173 条系统日志（175 − 2 条 oracle），oracle 审计条目不进活跃度
    assert.equal(byKey.get('evolution.logCount30d').value, 173);
    assert.equal(byKey.get('evolution.logCount7d').value, 5);
    const meta30 = JSON.parse(byKey.get('evolution.logCount30d').meta);
    assert.equal(meta30.excludedOracle, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('§3.5 硬规则：oracle-* 条目一律不计入活跃度（任意 oracle 前缀形态）', async () => {
  const now = Date.now();
  const fakeEvolution = {
    getLogRange: async () => [
      { ts: new Date(now).toISOString(), targetKind: 'oracle-daily' },
      { ts: new Date(now).toISOString(), targetKind: 'oracle-weekly' },
      { ts: new Date(now).toISOString(), targetKind: 'oracle-monthly-2026-09' }, // 防御：未来若出现更长的形态
      { ts: new Date(now).toISOString(), targetKind: 'plugin' },
    ],
  };
  const recs = await computeMetricsExt({ evolution: fakeEvolution });
  const byKey = new Map(recs.map((r) => [r.key, r]));
  assert.equal(byKey.get('evolution.logCount30d').value, 1);
  assert.equal(byKey.get('evolution.logCount7d').value, 1);
  assert.equal(JSON.parse(byKey.get('evolution.logCount30d').meta).excludedOracle, 3);
});

test('computeMetricsExt：stats 缺席时退化 listCandidates 自数（AC-0b 防御路径）', async () => {
  const fakeAutocreate = {
    listCandidates: async () => [
      { status: 'REJECTED' }, { status: 'REJECTED' }, { status: 'RELEASED' }, { status: 'ROLLED_BACK' },
    ],
  };
  const recs = await computeMetricsExt({ skillAutocreate: fakeAutocreate });
  const byKey = new Map(recs.map((r) => [r.key, r]));
  assert.equal(byKey.get('autocreate.candidatesRejected').value, 2);
});

test('computeMetricsExt：任一 source 缺席 / 抛错 → 对应 key 跳过，其余照常（AC-0b）', async () => {
  const broken = {
    skillAutocreate: { stats: async () => { throw new Error('boom'); } },
    evolution: { getLogRange: async () => { throw new Error('boom'); } },
    skillsFs: makeSkillsFsSource(['Z:/definitely/not/exist-' + Date.now()]),
  };
  const recs = await computeMetricsExt(broken);
  assert.equal(recs.length, 0);

  const partial = {
    skillAutocreate: { stats: async () => ({ candidates: { total: 1, byStatus: { REJECTED: 1 } } }) },
    evolution: { getLogRange: async () => { throw new Error('boom'); } },
  };
  const recs2 = await computeMetricsExt(partial);
  assert.deepEqual(recs2.map((r) => r.key), ['autocreate.candidatesRejected']);
});

test('computeMetrics 全链路：基础 source + 扩展 source 同跑，17 key 中可算的都出现', async () => {
  const { computeMetrics } = await import('../lib/metrics.js');
  const mixed = {
    cron: { health: () => ({ healthy: true, issues: [], jobs: [] }) },
    rules: {
      audit: () => ({ rules: [], totals: { hits: 3, denies: 0, asks: 0, advisories: 3 } }),
      lint: () => [{ ruleId: 'a', kind: 'duplicate-pattern', with: 'b' }],
      list: async () => [1, 2, 3, 4, 5], // rulesTotal = 5
    },
    wiki: { lint: async () => ({ checked: 9, brokenLinks: [], contradictions: [], orphans: ['o1'], healthy: false }) },
    memory: {
      stats: () => ({ total: 3, byType: {}, byLevel: {}, avgConfidence: 0.8 }),
      list: async () => [
        { id: 'm1', confidence: 0.9, evidence: 'https://x' },
        { id: 'm2', confidence: 0.5, evidence: '' },
        { id: 'm3', confidence: 1.0, evidence: '  ' }, // 空白也算无证据
      ],
    },
    eventBus: { metricsSnapshot: async () => ({ deadletterCount: 0, syncSubscriptions: 0 }) },
    skillAutocreate: { stats: async () => ({ candidates: { total: 2, byStatus: { REJECTED: 2 } } }) },
    evolution: { getLogRange: async () => [{ ts: new Date().toISOString() }] },
    // 根存在但目录为空 → value 0 是真实读数（空 roots 数组才会被跳过）
    skillsFs: { measure: () => ({ totalBytes: 0, fileCount: 0, roots: ['fake-root'], missingRoots: [] }) },
  };
  const recs = await computeMetrics(mixed);
  const byKey = new Map(recs.map((r) => [r.key, r]));

  // value 一律不变（AC-0a 的守卫面）
  assert.equal(byKey.get('rules.lintIssues').value, 1);
  assert.equal(byKey.get('wiki.orphans').value, 1);
  assert.equal(byKey.get('memory.total').value, 3);
  assert.equal(byKey.get('memory.avgConfidence').value, 0.8);
  assert.equal(byKey.get('autocreate.candidatesRejected').value, 2);
  assert.equal(byKey.get('evolution.logCount7d').value, 1);
  assert.equal(byKey.get('evolution.logCount30d').value, 1);
  assert.equal(byKey.get('skills.totalBytes').value, 0);

  // meta 增补（派生原料）
  const lintMeta = JSON.parse(byKey.get('rules.lintIssues').meta);
  assert.equal(lintMeta.rulesTotal, 5);
  const orphanMeta = JSON.parse(byKey.get('wiki.orphans').meta);
  assert.equal(orphanMeta.total, 9);
  const memMeta = JSON.parse(byKey.get('memory.total').meta);
  assert.deepEqual(memMeta.noEvidence.ids, ['m2', 'm3']);
  assert.equal(memMeta.noEvidence.count, 2);
  // m3 evidence 是空白串 → 按无证据处理；Σ(conf×compliance) 只算 m1 = 0.9；/3 = 0.3
  assert.ok(Math.abs(memMeta.avgConfXCompliance - 0.3) < 1e-6, `got ${memMeta.avgConfXCompliance}`);
});

test('computeMetricsExt：skills 根全部不存在 → key 缺席（记 0 会伪造"很美"）', async () => {
  const recs = await computeMetricsExt({ skillsFs: makeSkillsFsSource([]) });
  assert.deepEqual(recs.map((r) => r.key), []);
  const recs2 = await computeMetricsExt({
    skillsFs: makeSkillsFsSource(['Z:/definitely/not/exist-' + Date.now()]),
  });
  assert.deepEqual(recs2.map((r) => r.key), []);
});

test('defaultSkillRoots：DSH_HOME 下两根存在才返回', () => {
  const roots = defaultSkillRoots({ DSH_HOME: 'Z:/no-such-home-' + Date.now() });
  assert.deepEqual(roots, []);
});
