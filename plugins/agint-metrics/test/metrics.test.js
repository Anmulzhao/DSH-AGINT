/**
 * agint-metrics unit tests — pure computeMetrics() against fake sources.
 * Run: node --test packages/agint-metrics/test/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, METRIC_DEFS, UNCOLLECTED } from '../lib/metrics.js';

const fakeCron = {
  health: () => ({
    healthy: false,
    issues: [{ id: 'memory-decay', reason: 'overdue by 30240 min' }],
    jobs: [
      { id: 'memory-decay', overdueMs: 30240 * 60_000 },
      { id: 'wiki-lint', overdueMs: 0 },
      { id: 'evolve-review', overdueMs: 0 },
    ],
  }),
};

const fakeRules = {
  audit: () => ({
    rules: [],
    totals: { hits: 10, denies: 1, asks: 1, advisories: 8 },
  }),
  lint: async () => [{ ruleId: 'a', kind: 'duplicate-pattern' }, { ruleId: 'b', kind: 'invalid-pattern' }],
};

const fakeWiki = {
  lint: async () => ({
    checked: 7,
    brokenLinks: [{ from: 'a.md', target: 'b.md' }],
    contradictions: ['c.md'],
    orphans: ['d.md'],
    healthy: false,
  }),
};

const fakeMemory = {
  stats: async () => ({
    total: 17,
    byType: { lesson: 8, decision: 5, preference: 1, pattern: 3 },
    byLevel: { L1: 12, L2: 3, L3: 2 },
    avgConfidence: 0.62,
  }),
};

test('METRIC_DEFS covers the computable PLAN metrics', () => {
  const keys = METRIC_DEFS.map((d) => d.key);
  for (const k of ['cron.staleJobs', 'cron.maxOverdueDays', 'rules.hits', 'rules.blocked',
    'rules.adherencePct', 'rules.lintIssues', 'wiki.brokenLinks', 'wiki.contradictions',
    'wiki.orphans', 'memory.total', 'memory.avgConfidence']) {
    assert.ok(keys.includes(k), `missing metric key ${k}`);
  }
});

test('UNCOLLECTED honestly lists the session-log metrics', () => {
  const keys = UNCOLLECTED.map((d) => d.key);
  assert.ok(keys.includes('flattery.rate'));
  assert.ok(keys.includes('tasks.stepsMedian'));
});

test('computeMetrics with all sources returns expected values', async () => {
  const recs = await computeMetrics({ cron: fakeCron, rules: fakeRules, wiki: fakeWiki, memory: fakeMemory });
  const byKey = new Map(recs.map((r) => [r.key, r]));

  // cron
  assert.equal(byKey.get('cron.staleJobs').value, 1);
  assert.equal(byKey.get('cron.maxOverdueDays').value, 21); // 30240 min = 21 days
  // rules
  assert.equal(byKey.get('rules.hits').value, 10);
  assert.equal(byKey.get('rules.blocked').value, 2);
  assert.equal(byKey.get('rules.adherencePct').value, 80); // (10-2)/10
  assert.equal(byKey.get('rules.lintIssues').value, 2);
  // wiki
  assert.equal(byKey.get('wiki.brokenLinks').value, 1);
  assert.equal(byKey.get('wiki.contradictions').value, 1);
  assert.equal(byKey.get('wiki.orphans').value, 1);
  // memory
  assert.equal(byKey.get('memory.total').value, 17);
  assert.equal(byKey.get('memory.avgConfidence').value, 0.62);
});

test('computeMetrics skips rules.adherencePct when there is no gate activity', async () => {
  const quietRules = {
    audit: () => ({ rules: [], totals: { hits: 0, denies: 0, asks: 0, advisories: 0 } }),
    lint: async () => [],
  };
  const recs = await computeMetrics({ cron: fakeCron, rules: quietRules });
  const keys = recs.map((r) => r.key);
  assert.ok(!keys.includes('rules.adherencePct'), 'adherencePct must be omitted when hits === 0');
  assert.ok(keys.includes('rules.blocked'));
});

test('computeMetrics tolerates missing / unhealthy sources', async () => {
  const recs = await computeMetrics({});
  assert.equal(recs.length, 0);

  const broken = {
    cron: { health: () => { throw new Error('boom'); } },
    rules: { audit: () => { throw new Error('boom'); } },
    wiki: { lint: async () => { throw new Error('boom'); } },
    memory: { stats: async () => { throw new Error('boom'); } },
  };
  const recs2 = await computeMetrics(broken);
  assert.equal(recs2.length, 0);
});

test('computeMetrics handles sync and async source methods uniformly', async () => {
  const mixed = {
    cron: { health: () => ({ healthy: true, issues: [], jobs: [] }) },
    rules: { audit: () => ({ rules: [], totals: { hits: 3, denies: 0, asks: 0, advisories: 3 } }), lint: () => [] },
    wiki: { lint: async () => ({ checked: 0, brokenLinks: [], contradictions: [], orphans: [], healthy: true }) },
    memory: { stats: () => ({ total: 0, byType: {}, byLevel: {}, avgConfidence: 0 }) },
    eventBus: { metricsSnapshot: async () => ({ deadletterCount: 0, syncSubscriptions: 0 }) },
  };
  const recs = await computeMetrics(mixed);
  assert.equal(recs.length, METRIC_DEFS.length); // every computable key present
  const byKey = new Map(recs.map((r) => [r.key, r]));
  assert.equal(byKey.get('rules.adherencePct').value, 100);
  assert.equal(byKey.get('memory.avgConfidence').value, 0);
});
