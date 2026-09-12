// 查询层测试（§4.1 FROZEN Service 内核 + §六 recommend 降级链 + §九「零数据诚实」）。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeCoverage, computeHealth, isStale, neighbors, clusters, recommend, intentMatch,
} from '../lib/query.js';
import { DEFAULT_WEIGHTS, normalizeWeights } from '../lib/schema.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-13T00:00:00Z');

const E = (type, a, b, weight = 0.5, evidence = {}) => ({
  edgeId: `edge_${a}_${b}_${type}`,
  src: a <= b ? a : b,
  dst: a <= b ? b : a,
  type, weight, confidence: 'high', evidence,
});

const nodes = [
  { skillName: 'alpha', description: 'push code to github', triggers: ['github', 'push'] },
  { skillName: 'beta', description: 'git commit and push', triggers: ['git'] },
  { skillName: 'gamma', description: 'write memory notes', triggers: ['memory'] },
];

test('coverage：同时暴露 nodesWithEdges 与 nodesWithUsage 两个分母（§12.5 开放问题 6）', () => {
  const usage = [
    { skillName: 'alpha', calls: 2 },
    { skillName: 'beta', calls: 0 },
    { skillName: 'gamma', calls: 5 },
  ];
  const c = computeCoverage(usage, [E('related', 'alpha', 'beta', 1, { method: 'declared' })], 3);
  assert.equal(c.nodes, 3);
  assert.equal(c.nodesWithEdges, 2);
  assert.equal(c.nodesWithUsage, 2);
  assert.equal(c.ratio, 0.6667);
  assert.equal(c.usageRatio, 0.6667);
});

test('health：零边 → EMPTY；coverage < 0.3 → SPARSE；否则 OK', () => {
  assert.equal(computeHealth([], { ratio: 0 }), 'EMPTY');
  assert.equal(computeHealth([E('related', 'a', 'b')], { ratio: 0 }), 'EMPTY');
  assert.equal(computeHealth([E('related', 'a', 'b')], { ratio: 0.2 }), 'SPARSE');
  assert.equal(computeHealth([E('related', 'a', 'b')], { ratio: 0.8 }), 'OK');
});

test('isStale：14 天未刷新 → true；无时间戳 → true', () => {
  assert.equal(isStale(null, NOW), true);
  assert.equal(isStale(new Date(NOW - 13 * DAY).toISOString(), NOW), false);
  assert.equal(isStale(new Date(NOW - 15 * DAY).toISOString(), NOW), true);
});

test('neighbors：无向命中两侧 + 按 weight 降序 + type 过滤 + minWeight', () => {
  const edges = [
    E('related', 'alpha', 'beta', 1, { method: 'declared' }),
    E('co_use', 'alpha', 'gamma', 0.4, { method: 'session-cooccurrence' }),
    E('overlap', 'beta', 'gamma', 0.66, { method: 'curator-event' }),
  ];
  const all = neighbors(edges, 'gamma');
  assert.deepEqual(all.map((e) => e.type), ['overlap', 'co_use']); // 0.66 > 0.4
  assert.equal(neighbors(edges, 'gamma', { type: 'co_use' }).length, 1);
  assert.equal(neighbors(edges, 'gamma', { minWeight: 0.5 }).length, 1);
  assert.equal(neighbors(edges, 'beta')[0].src, 'alpha'); // beta 侧也能查到无向边
  assert.deepEqual(neighbors(edges, ''), []);
});

test('clusters：连通分量 + 每条边证据随簇返回（M4「结果带证据」）', () => {
  const edges = [
    E('related', 'alpha', 'beta', 1, { method: 'declared', field: 'related_skills', declaredIn: 'alpha/SKILL.md' }),
    E('related', 'beta', 'gamma', 1, { method: 'declared', field: 'related_skills', declaredIn: 'beta/SKILL.md' }),
    E('related', 'solo', 'other', 1, { method: 'declared' }),
  ];
  const cs = clusters(edges, { type: 'related', minSize: 2 });
  assert.equal(cs.length, 2);
  const big = cs[0];
  assert.equal(big.members.length, 3);
  assert.deepEqual(big.members, ['alpha', 'beta', 'gamma']);
  assert.equal(big.evidence.length, 2);
  assert.ok(big.evidence.every((e) => e.evidence && Object.keys(e.evidence).length > 0));
  // 单成员不成簇
  assert.equal(clusters([E('related', 'a', 'a')], { type: 'related', minSize: 2 }).length, 0);
});

test('recommend：零边 → INSUFFICIENT_DATA + degraded，items 仍返回纯 intentMatch 列表（不硬编 0 条）', () => {
  const r = recommend({ intent: 'github push code' }, {
    nodes, usageList: nodes.map((n) => ({ skillName: n.skillName, calls: 0, successRate: null, lastUsedAt: null })),
    edges: [], lastFullScanAt: new Date(NOW).toISOString(), nowMs: NOW, mode: 'list',
  });
  assert.equal(r.status, 'INSUFFICIENT_DATA');
  assert.equal(r.degraded, true);
  assert.equal(r.health, 'EMPTY');
  assert.equal(r.items.length, 3);
  assert.match(r.degradedReason, /edges=0/);
  assert.ok(r.unavailableTerms.some((t) => t.startsWith('neighborBoost')));
  assert.ok(r.unavailableTerms.some((t) => t.startsWith('successRate')));
  // list 模式不打分（§六主方案）
  assert.equal(r.items.every((i) => i.score === undefined), true);
  // 每个 item 都带可解释 reason
  assert.equal(r.items.every((i) => typeof i.reason === 'string' && i.reason.length > 0), true);
});

test('recommend：有边 + 有 context 时 neighborBoost 生效；score 模式下排序可用', () => {
  const edges = [E('related', 'alpha', 'beta', 1, { method: 'declared' }), E('related', 'alpha', 'gamma', 0.9, { method: 'declared' })];
  const r = recommend({ intent: 'push', context: { usedSkills: ['alpha'] } }, {
    nodes, usageList: nodes.map((n) => ({ skillName: n.skillName, calls: 1, successRate: null, lastUsedAt: new Date(NOW).toISOString() })),
    edges, lastFullScanAt: new Date(NOW).toISOString(), nowMs: NOW, mode: 'score',
  });
  assert.equal(r.status, 'OK');
  assert.equal(r.degraded, false);
  const beta = r.items.find((i) => i.skillName === 'beta');
  assert.equal(beta.terms.neighborBoost, 1);
  assert.ok(beta.score > 0);
  // recency：刚用过 → 衰减 < 1 且 > 0.9
  assert.ok(beta.terms.recency > 0.9 && beta.terms.recency < 1.0001);
});

test('recommend：权重配置损坏 → 回退默认权重并标记 fallback（§六降级链 2）', () => {
  const r = recommend({ intent: 'x' }, {
    nodes, usageList: [], edges: [], nowMs: NOW, mode: 'list',
    weights: { intentMatch: 'nonsense', neighborBoost: -1, successRate: NaN, recency: 0 },
  });
  assert.equal(r.weightFallback, true);
  assert.deepEqual(r.weights, { ...DEFAULT_WEIGHTS });

  // normalizeWeights 自身：合法权重会被归一化到和为 1
  const ok = normalizeWeights({ intentMatch: 4, neighborBoost: 3, successRate: 2, recency: 1 });
  assert.equal(ok.fallback, false);
  assert.ok(Math.abs(Object.values(ok.weights).reduce((a, b) => a + b, 0) - 1) < 1e-9, '归一化后权重和应为 1');
  // 全 0 → 回退
  assert.equal(normalizeWeights({ intentMatch: 0, neighborBoost: 0, successRate: 0, recency: 0 }).fallback, true);
});

test('recommend：图数据 14 天未刷新 → stale=true（§六降级链 3）', () => {
  const r = recommend({ intent: 'x' }, {
    nodes, usageList: [], edges: [], lastFullScanAt: new Date(NOW - 20 * DAY).toISOString(), nowMs: NOW, mode: 'list',
  });
  assert.equal(r.stale, true);
  const fresh = recommend({ intent: 'x' }, {
    nodes, usageList: [], edges: [], lastFullScanAt: new Date(NOW - 1 * DAY).toISOString(), nowMs: NOW, mode: 'list',
  });
  assert.equal(fresh.stale, false);
});

test('recommend：禁止项 —— 结果不写回统计（返回对象是纯读快照，不改入参）', () => {
  const usageList = [{ skillName: 'alpha', calls: 3, successRate: null, lastUsedAt: null }];
  const snapshot = JSON.stringify(usageList);
  recommend({ intent: 'push' }, { nodes, usageList, edges: [], nowMs: NOW, mode: 'list' });
  assert.equal(JSON.stringify(usageList), snapshot);
});

test('intentMatch：规则关键词命中率（无 triggers 时只用 description）', () => {
  assert.equal(intentMatch('', nodes[0]), 0);
  assert.equal(intentMatch('github', nodes[0]), 1);
  assert.ok(intentMatch('github push', nodes[0]) >= 0.5);
  assert.equal(intentMatch('github', { skillName: 'z', description: '', triggers: [] }), 0);
});
