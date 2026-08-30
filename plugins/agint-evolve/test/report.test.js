/**
 * agint-evolve unit tests — pure findingsFromSnapshot() + buildReport().
 * Run: node --test packages/agint-evolve/test/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findingsFromSnapshot, buildReport } from '../lib/report.js';

const healthySnapshot = {
  collectedAt: '2026-08-17T03:45:00.000Z',
  memory: { total: 17, byType: { lesson: 8, decision: 5, preference: 1, pattern: 3 }, byLevel: { L1: 12 }, avgConfidence: 0.62 },
  wiki: { checked: 7, brokenLinks: [], contradictions: [], orphans: [], healthy: true },
  cron: { healthy: true, issues: [], jobs: [{ id: 'memory-decay' }, { id: 'wiki-lint' }, { id: 'evolve-review' }] },
  rules: { totals: { hits: 10, denies: 0, asks: 0, advisories: 10 }, fired: [], lintIssues: [] },
};

test('healthy snapshot yields a single ok finding', () => {
  const findings = findingsFromSnapshot(healthySnapshot);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, 'ok');
  assert.equal(findings[0].key, 'all.healthy');
});

test('stale cron job surfaces as a warn finding', () => {
  const snapshot = {
    ...healthySnapshot,
    cron: {
      healthy: false,
      issues: [{ id: 'memory-decay', reason: 'overdue by 30240 min' }],
      jobs: [],
    },
  };
  const findings = findingsFromSnapshot(snapshot);
  const stale = findings.find((f) => f.key === 'cron.stale');
  assert.ok(stale, 'expected a cron.stale finding');
  assert.equal(stale.level, 'warn');
  assert.match(stale.message, /memory-decay/);
});

test('wiki problems surface as warn/info findings', () => {
  const snapshot = {
    ...healthySnapshot,
    wiki: {
      checked: 7,
      brokenLinks: [{ from: 'a.md', target: 'b.md' }],
      contradictions: ['c.md'],
      orphans: ['d.md', 'e.md'],
      healthy: false,
    },
  };
  const findings = findingsFromSnapshot(snapshot);
  assert.equal(findings.find((f) => f.key === 'wiki.brokenLinks').level, 'warn');
  assert.equal(findings.find((f) => f.key === 'wiki.contradictions').level, 'warn');
  assert.equal(findings.find((f) => f.key === 'wiki.orphans').level, 'info');
  assert.match(findings.find((f) => f.key === 'wiki.orphans').message, /2 个/);
});

test('rule redundancy and gate blocking produce findings', () => {
  const snapshot = {
    ...healthySnapshot,
    rules: {
      totals: { hits: 10, denies: 2, asks: 1, advisories: 7 },
      fired: [],
      lintIssues: [{ ruleId: 'a', kind: 'duplicate-pattern' }],
    },
  };
  const findings = findingsFromSnapshot(snapshot);
  const lint = findings.find((f) => f.key === 'rules.lint');
  assert.equal(lint.level, 'warn');
  assert.match(lint.message, /1 个/);
  const blocked = findings.find((f) => f.key === 'rules.blocked');
  assert.equal(blocked.level, 'info');
  assert.match(blocked.message, /3\/10/);
});

test('no gate activity is reported as an info finding', () => {
  const snapshot = {
    ...healthySnapshot,
    rules: { totals: { hits: 0, denies: 0, asks: 0, advisories: 0 }, fired: [], lintIssues: [] },
  };
  const findings = findingsFromSnapshot(snapshot);
  const noActivity = findings.find((f) => f.key === 'rules.noActivity');
  assert.ok(noActivity);
  assert.equal(noActivity.level, 'info');
});

test('memory bloat and low confidence produce findings', () => {
  const bloat = findingsFromSnapshot({ ...healthySnapshot, memory: { total: 80, byType: {}, avgConfidence: 0.5 } });
  assert.equal(bloat.find((f) => f.key === 'memory.bloat').level, 'info');

  const lowConf = findingsFromSnapshot({ ...healthySnapshot, memory: { total: 5, byType: {}, avgConfidence: 0.3 } });
  assert.equal(lowConf.find((f) => f.key === 'memory.confidence').level, 'warn');
});

test('worsening count metrics produce trend warnings; adherence improvement does not', () => {
  const snapshot = {
    ...healthySnapshot,
    metrics: {
      asOf: '2026-08-17T03:45:00.000Z',
      count: 2,
      metrics: [
        { key: 'cron.staleJobs', label: '失效任务', value: 2, unit: 'count', ts: 'x', delta: 1 },       // worsening
        { key: 'rules.adherencePct', label: '遵守率', value: 90, unit: 'pct', ts: 'x', delta: 5 },      // improving
      ],
    },
  };
  const findings = findingsFromSnapshot(snapshot);
  assert.ok(findings.find((f) => f.key === 'trend.cron.staleJobs'), 'expected trend.cron.staleJobs');
  assert.ok(!findings.find((f) => f.key === 'trend.rules.adherencePct'), 'adherencePct is not a worsening trend');
});

test('buildReport renders all sections with routing rules', () => {
  const findings = findingsFromSnapshot(healthySnapshot);
  const md = buildReport({ date: '2026-08-17', snapshot: healthySnapshot, findings, notes: '本周关注门禁噪音' });
  assert.match(md, /^# 智进周复盘 2026-08-17/m);
  assert.match(md, /## 一、数据快照/);
  assert.match(md, /## 二、自动发现/);
  assert.match(md, /## 三、改进提案/);
  assert.match(md, /## 四、备注/);
  assert.match(md, /本周关注门禁噪音/);
  assert.match(md, /路由规范/);
  assert.match(md, /教训.*agint-memory/s);
  assert.match(md, /知识.*agint-wiki/s);
  assert.match(md, /\| 记忆 \|/);
  assert.match(md, /\| 规则门禁 \|/);
});

test('buildReport renders A10 eventBus rows (sync subscriptions + deadletter rate)', () => {
  const snapshot = {
    ...healthySnapshot,
    metrics: {
      asOf: '2026-08-30T00:00:00.000Z',
      count: 2,
      metrics: [
        { key: 'eventBus.syncSubscriptions', label: 'sync 订阅数', value: 1, unit: 'count', ts: 'x', delta: 0 },
        { key: 'eventBus.deadletterRate', label: '死信率', value: 1.5, unit: '', ts: 'x', delta: 0, meta: JSON.stringify({ deadletterCount: 3, publishedCount: 200 }) },
      ],
    },
  };
  const md = buildReport({ date: '2026-08-30', snapshot, findings: [], notes: '' });
  assert.match(md, /Event Bus sync 订阅数/);
  assert.match(md, /1 个（上限 3）/);
  assert.match(md, /Event Bus 死信率/);
  assert.match(md, /1\.5%/);
  assert.match(md, /死信 3 \/ 发布 200/);
});

test('buildReport handles a fully unavailable snapshot', () => {
  const findings = findingsFromSnapshot({});
  assert.equal(findings[0].key, 'all.healthy');
  const md = buildReport({ date: '2026-08-17', snapshot: {}, findings, notes: '' });
  assert.match(md, /数据源.*全部不可用/s);
});
