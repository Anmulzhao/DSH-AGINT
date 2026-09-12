// 四类边测试（§3.2）—— 每类边的判定、阈值、证据与丢弃计数。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRelatedEdges, buildCoUseEdges, buildSimilarEdges, overlapEdgeFromEvent,
  buildOfflineOverlapEdges, filterValidEdges,
} from '../lib/edges.js';
import { CONFIDENCE_BY_TYPE, EDGE_TYPES, EVIDENCE_REQUIRED_KEYS, validateEdge } from '../lib/schema.js';
import { makePresetsDir, rec, cleanup } from './_helpers.mjs';
import { scanNodes } from '../lib/collect.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-13T00:00:00Z');

function node(skillName, relatedSkills = [], extra = {}) {
  return {
    skillName, dirName: skillName, presets: ['p1'], path: `${skillName}/SKILL.md`,
    description: '', tools: [], triggers: [], relatedSkills,
    declarations: { [`${skillName}/SKILL.md`]: relatedSkills }, createdAt: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

test('related 边：声明即边（零阈值）；目标不存在 → 丢弃并计数（不静默）', () => {
  const nodes = [node('alpha', ['beta', 'ghost']), node('beta', [])];
  const { edges, droppedRelatedTargets } = buildRelatedEdges(nodes);
  assert.equal(edges.length, 1);
  assert.equal(droppedRelatedTargets, 1);
  assert.equal(edges[0].type, 'related');
  assert.equal(edges[0].confidence, 'high');
  assert.equal(edges[0].weight, 1);
  assert.equal(edges[0].evidence.method, 'declared');
  assert.equal(edges[0].evidence.field, 'related_skills');
  assert.match(edges[0].evidence.declaredIn, /alpha\/SKILL\.md$/);
});

test('related 边：无向存储（字典序小者为 src）+ 双向一致性检查（单向声明记 asymmetric）', () => {
  const a2b = buildRelatedEdges([node('zeta', ['alpha']), node('alpha', [])]).edges;
  assert.equal(a2b.length, 1);
  assert.equal(a2b[0].src, 'alpha');   // 字典序小者
  assert.equal(a2b[0].dst, 'zeta');
  assert.equal(a2b[0].asymmetric, true); // alpha 未反向声明

  const mutual = buildRelatedEdges([node('a', ['b']), node('b', ['a'])]).edges;
  assert.equal(mutual.length, 1);       // 双向声明仍只有一条边（去重）
  assert.equal(mutual[0].asymmetric, false);
});

test('related 边：自引用声明被忽略；同一对多份预设声明去重', () => {
  assert.equal(buildRelatedEdges([node('a', ['a'])]).edges.length, 0);
  const dup = buildRelatedEdges([node('a', ['b']), node('b', ['a', 'a'])]).edges;
  assert.equal(dup.length, 1);
});

test('overlap 边（路径 A）：归一化 curator.overlap-detected 载荷，dims/3 为权重', () => {
  const payload = {
    skillA: 'alpha', skillB: 'beta',
    similarity: { desc: 0.9, tools: 0.8, triggers: 0.1, descHit: true, toolsHit: true, triggersHit: false, dimsMet: 2 },
  };
  const e = overlapEdgeFromEvent(payload, new Set(['alpha', 'beta']));
  assert.ok(e);
  assert.equal(e.type, 'overlap');
  assert.equal(e.confidence, 'medium');
  assert.equal(e.weight, +(2 / 3).toFixed(3));
  assert.equal(e.evidence.source, 'curator.overlap-detected');
  assert.equal(e.evidence.similarity.dimsMet, 2);
});

test('overlap 边：载荷不合法 / 节点不在全集 → null（调用方计 droppedEdges）', () => {
  assert.equal(overlapEdgeFromEvent(null, new Set(['a'])), null);
  assert.equal(overlapEdgeFromEvent({ skillA: 'a' }, new Set(['a'])), null);
  assert.equal(overlapEdgeFromEvent({ skillA: 'a', skillB: 'a', similarity: {} }, new Set(['a'])), null);
  assert.equal(
    overlapEdgeFromEvent({ skillA: 'a', skillB: 'nowhere', similarity: { dimsMet: 2 } }, new Set(['a'])),
    null,
  );
});

test('overlap 边（路径 B）：离线重算直接复用 curator 阈值常量（引用不复制）', () => {
  // 三维中只有描述维可能命中（tools/triggers 为空 → 恒 0 分）→ dimsMet 上限 1 < 2 → 恒 0 条
  const subjects = [
    { skillName: 'a', description: 'same text here', triggers: [], tools: [] },
    { skillName: 'b', description: 'same text here', triggers: [], tools: [] },
  ];
  assert.equal(buildOfflineOverlapEdges(subjects).length, 0);
  // 补齐 tools/triggers 后同一对就能达标（这正是 §六bis.3 前置条件①要解锁的东西）
  const fixed = [
    { skillName: 'a', description: 'same text here', triggers: ['x', 'y'], tools: ['t1', 't2'] },
    { skillName: 'b', description: 'same text here', triggers: ['x', 'y'], tools: ['t1', 't2'] },
  ];
  const got = buildOfflineOverlapEdges(fixed);
  assert.equal(got.length, 1);
  assert.equal(got[0].evidence.source, 'offline-recompute');
});

test('co_use 边：同窗口共现须覆盖 ≥3 个不同会话才建边', () => {
  // co_use 的输入是**调用序列**（collectSkillCalls 输出），不是原始 tool-stats 记录
  const call = (sid, ts, skillName) => ({ ts, sessionId: sid, skillName, ok: true, fingerprint: null });
  const session = (sid) => [call(sid, NOW, 'alpha'), call(sid, NOW + 60_000, 'beta')];
  // 2 个会话 → 不建边（§六bis 实测全历史最多 2 对 × 各 1 次 → 预期 0 条）
  const two = [...session('s1'), ...session('s2')];
  assert.equal(buildCoUseEdges(two, { windowMs: 30 * 60_000, minSessions: 3 }).length, 0);
  // 3 个会话 → 建边
  const three = [...two, ...session('s3')];
  const edges = buildCoUseEdges(three, { windowMs: 30 * 60_000, minSessions: 3 });
  assert.equal(edges.length, 1);
  assert.equal(edges[0].type, 'co_use');
  assert.equal(edges[0].confidence, 'high');
  assert.equal(edges[0].evidence.sessions, 3);
  assert.equal(edges[0].evidence.window, '30m');
  assert.deepEqual(edges[0].evidence.sessionIds.sort(), ['s1', 's2', 's3']);
});

test('co_use 边：同一会话内共现 N 次只算 1 个会话；超窗口不共现', () => {
  const call = (sid, ts, skillName) => ({ ts, sessionId: sid, skillName, ok: true, fingerprint: null });
  const same = [
    call('s1', NOW, 'alpha'), call('s1', NOW + 1000, 'beta'),
    call('s1', NOW + 2000, 'alpha'), call('s1', NOW + 3000, 'beta'),
  ];
  assert.equal(buildCoUseEdges(same, { windowMs: 30 * 60_000, minSessions: 3 }).length, 0);

  const farApart = [call('s1', NOW, 'alpha'), call('s1', NOW + 45 * 60_000, 'beta')];
  assert.equal(buildCoUseEdges(farApart, { windowMs: 30 * 60_000, minSessions: 1 }).length, 0);
});

test('similar 边：默认阈值 0.70 下真实描述产出 0 条（不是 bug，是算术结果）', () => {
  const nodes = [
    node('a', [], { description: 'push code to github using git' }),
    node('b', [], { description: 'write memory notes after each task' }),
    node('c', [], { description: 'compose cordis plugin rows carefully' }),
  ];
  assert.equal(buildSimilarEdges(nodes, { threshold: 0.7 }).length, 0);
  // 阈值下调且描述完全一致时才会出现（说明函数本身可用，只是默认阈值在当前数据上是空集）
  const same = buildSimilarEdges([node('a', [], { description: 'x y z' }), node('b', [], { description: 'x y z' })], { threshold: 0.5 });
  assert.equal(same.length, 1);
  assert.equal(same[0].confidence, 'low');
  assert.equal(same[0].evidence.method, 'metadata');
  assert.equal(same[0].evidence.jaccard, 1);
});

test('validateEdge：无 evidence / 空 evidence / 自环 / 未知类型 / 缺必备键 → 全部拒绝', () => {
  const base = { edgeId: 'e1', src: 'a', dst: 'b', type: 'related', evidence: { method: 'declared', field: 'related_skills', declaredIn: 'a/SKILL.md' } };
  assert.equal(validateEdge(base).ok, true);
  assert.equal(validateEdge({ ...base, evidence: undefined }).ok, false);
  assert.equal(validateEdge({ ...base, evidence: {} }).ok, false);
  assert.equal(validateEdge({ ...base, dst: 'a' }).ok, false);
  assert.equal(validateEdge({ ...base, type: 'nope' }).ok, false);
  assert.equal(validateEdge({ ...base, evidence: { method: 'declared' } }).ok, false); // 缺 field/declaredIn
  assert.equal(validateEdge(null).ok, false);

  // 四类边都有必备键清单（§九「声明-计算分工」）
  assert.deepEqual([...EDGE_TYPES].sort(), ['co_use', 'overlap', 'related', 'similar']);
  for (const t of EDGE_TYPES) assert.ok(Array.isArray(EVIDENCE_REQUIRED_KEYS[t]) && EVIDENCE_REQUIRED_KEYS[t].length > 0);
});

test('filterValidEdges：非法边被丢弃并给出原因，合法边保留', () => {
  const good = { edgeId: 'e1', src: 'a', dst: 'b', type: 'co_use', evidence: { method: 'x', sessions: 3, window: '30m', sessionIds: [] } };
  const bad = { edgeId: 'e2', src: 'a', dst: 'b', type: 'co_use', evidence: {} };
  const { edges, dropped, reasons } = filterValidEdges([good, bad]);
  assert.equal(edges.length, 1);
  assert.equal(dropped, 1);
  assert.match(reasons[0], /^e2: /);
});

test('confidence 映射（§3.2）：related=high / co_use=high / overlap=medium / similar=low', () => {
  assert.deepEqual(
    { ...CONFIDENCE_BY_TYPE },
    { related: 'high', overlap: 'medium', co_use: 'high', similar: 'low' },
  );
});

test('端到端：扫描真实目录形状 → related 边落盘（补元数据即出边，不依赖流量）', async () => {
  const dir = makePresetsDir({
    p1: [
      { name: 'alpha', related_skills: ['beta'] },
      { name: 'beta', related_skills: ['alpha', 'gamma'] },
      { name: 'gamma' },
    ],
  });
  try {
    const { nodes } = await scanNodes(dir);
    const { edges, droppedRelatedTargets } = buildRelatedEdges(nodes);
    assert.equal(droppedRelatedTargets, 0);
    assert.equal(edges.length, 2); // alpha↔beta, beta↔gamma
    assert.equal(edges.every((e) => e.type === 'related' && e.confidence === 'high'), true);
    assert.equal(edges.every((e) => validateEdge(e).ok), true);
  } finally { cleanup(dir); }
});
