#!/usr/bin/env node
// agint-diagnosis smoke test — `node test/smoke.mjs` 一行能跑。
//
// 5 个 smoke 用例（覆盖子任务要求的 3 个语义组：Service 接口注册 +
// FROZEN schema 校验 + storage 三表存在且空）。
//
// 设计：本 smoke 不挂载 Cordis 也不真打开 storage domain
// （`ctx.storageDomain.open()` 必须在 dsh 进程内）。只验证：
//   - FROZEN service entry / inject / 导出
//   - FROZEN enum + 3 schema 校验
//   - storage spec shape + LIMITS + checkLimit + pack/unpack round-trip
//
// 真正的 open(domain) + put/get 由子任务 #3 起的算法实现侧配 eval 场景覆盖。

import test from 'node:test';
import assert from 'node:assert/strict';

import * as schema from '../lib/schema.js';
import * as storage from '../lib/storage.js';
import * as plugin from '../lib/index.js';

// ── Case 1: FROZEN enum RootCauseKind（7 类 + 拒非法） ─────────────────

test('FROZEN enum RootCauseKind', () => {
  const expected = [
    'PROMPT_DEFICIENCY',
    'TOOL_GAP',
    'KNOWLEDGE_GAP',
    'REASONING_ERROR',
    'PLANNING_FAILURE',
    'ENVIRONMENT_SHIFT',
    'UNCERTAIN',
  ];
  assert.deepEqual([...schema.ROOT_CAUSE_KINDS], expected);
  for (const k of expected) {
    assert.ok(schema.RootCauseKindSchema.safeParse(k).success, `RootCauseKindSchema 应接受 ${k}`);
  }
  assert.equal(schema.RootCauseKindSchema.safeParse('SOMETHING_ELSE').success, false);
  // isConfidentRootCause 兜底语义
  assert.equal(schema.isConfidentRootCause('UNCERTAIN'), false);
  for (const k of expected.slice(0, 6)) {
    assert.equal(schema.isConfidentRootCause(k), true);
  }
});

// ── Case 2: 3 个 FROZEN data schema（Annotation / Cluster / Report） ─────

test('FROZEN AnnotationSchema / ClusterSchema / DiagnosisReportSchema', () => {
  // Annotation：4 字段 + 嵌套 RootCauseKind + confidence ∈ [0,1]
  const anno = {
    failureId: 'f-1',
    rootCause: 'TOOL_GAP',
    confidence: 0.7,
    evidence: 'tool not found: foo',
  };
  assert.equal(schema.AnnotationSchema.safeParse(anno).success, true);
  assert.equal(schema.AnnotationSchema.safeParse({ ...anno, failureId: '' }).success, false);
  assert.equal(schema.AnnotationSchema.safeParse({ ...anno, confidence: 1.5 }).success, false);
  assert.equal(schema.AnnotationSchema.safeParse({ ...anno, confidence: -0.1 }).success, false);
  assert.equal(schema.AnnotationSchema.safeParse({ ...anno, rootCause: 'WUT' }).success, false);

  // Cluster：pattern + count ≥1 + sampleFailureIds
  const cluster = {
    pattern: 'tool not found',
    count: 3,
    sampleFailureIds: ['f-1', 'f-2', 'f-3'],
  };
  assert.equal(schema.ClusterSchema.safeParse(cluster).success, true);
  assert.equal(schema.ClusterSchema.safeParse({ ...cluster, count: 0 }).success, false);
  assert.equal(schema.ClusterSchema.safeParse({ ...cluster, pattern: '' }).success, false);

  // DiagnosisReport：windowDays + generatedAt + counts + 7-key 分布（漏 key 即拒）
  const report = {
    windowDays: 7,
    generatedAt: '2026-08-25T00:00:00.000Z',
    annotationCount: 42,
    clusterCount: 5,
    rootCauseDistribution: {
      PROMPT_DEFICIENCY: 10,
      TOOL_GAP: 8,
      KNOWLEDGE_GAP: 5,
      REASONING_ERROR: 7,
      PLANNING_FAILURE: 4,
      ENVIRONMENT_SHIFT: 3,
      UNCERTAIN: 5,
    },
  };
  assert.equal(schema.DiagnosisReportSchema.safeParse(report).success, true);
  const missingKey = { ...report, rootCauseDistribution: { ...report.rootCauseDistribution } };
  delete missingKey.rootCauseDistribution.UNCERTAIN;
  assert.equal(schema.DiagnosisReportSchema.safeParse(missingKey).success, false);

  // emptyRootCauseDistribution：7 key 全 0
  const dist = schema.emptyRootCauseDistribution();
  assert.deepEqual(Object.keys(dist).sort(), [...schema.ROOT_CAUSE_KINDS].sort());
  for (const v of Object.values(dist)) assert.equal(v, 0);
});

// ── Case 3: storage spec 三表存在 + LIMITS 200/50/50（设计稿 §2.2） ────

test('storage spec: agint_diagnosis 域 + 3 表 + LIMITS', () => {
  assert.equal(storage.spec.name, 'agint_diagnosis');
  assert.equal(storage.spec.version, 1);
  const tables = Object.keys(storage.spec.tables).sort();
  assert.deepEqual(tables, ['annotations', 'clusters', 'reports']);
  assert.equal(schema.LIMITS.ANNOTATIONS, 200);
  assert.equal(schema.LIMITS.CLUSTERS, 50);
  assert.equal(schema.LIMITS.REPORTS, 50);
});

// ── Case 4: storage 守门与 pack/unpack round-trip ──────────────────────

test('storage checkLimit + pack/unpack annotation round-trip', () => {
  // checkLimit:超限 warn，不抛错；未超 / 未知表名 → null
  assert.equal(storage.checkLimit('annotations', 50), null);
  assert.equal(storage.checkLimit('whatever', 99999), null);
  const w1 = storage.checkLimit('annotations', 201);
  assert.ok(w1 && w1.limit === 200 && /annotations/.test(w1._warn));
  const w2 = storage.checkLimit('clusters', 51);
  assert.ok(w2 && w2.limit === 50);
  const w3 = storage.checkLimit('reports', 51);
  assert.ok(w3 && w3.limit === 50);

  // pack / unpack：FROZEN 业务字段来去无失；metadata 自动注入
  const business = {
    failureId: 'f-42',
    rootCause: 'REASONING_ERROR',
    confidence: 0.6,
    evidence: 'inferred',
  };
  const entry = storage.packAnnotation(business);
  assert.equal(entry.kind, 'annotation');
  assert.ok(entry.id.length > 0);
  assert.ok(entry.createdAt.length > 0);
  assert.deepEqual(storage.unpackAnnotation(entry), business);
});

// ── Case 5: plugin entry name/inject + FROZEN 导出（PLUGIN-SPEC §1） ────

test('plugin entry: name / inject 严格按 PLUGIN-SPEC', () => {
  assert.equal(plugin.name, 'agint-diagnosis');
  assert.deepEqual(plugin.inject, ['storageDomain']);
  for (const k of ['RootCauseKindSchema', 'AnnotationSchema', 'ClusterSchema', 'DiagnosisReportSchema']) {
    assert.ok(plugin[k], `${k} 已从 lib/index.js 重新导出，方便 host-side 算法实现引用`);
  }
});

// ── Case 6 (子任务 #3 追加): annotate 已接通 + 算法 smoke ─────────────
//
// 验证：
//   1) `agint.diagnosis.annotate` 服务已注册（不再抛 not implemented）
//   2) cold-start 守门工作（mock 无 agint.evolution → 直接抛 cold-start）
//   3) 算法路径走通：mock evolution + 20 条 failure_pattern → 真实算法分类
//
// 本 smoke 不真挂 cordis storage domain；只用 mock ctx 验证算法契约。

import { classify } from '../lib/root-cause-classifier.js';

test('annotate 已注册（不再 not implemented）+ 算法路径 smoke', async () => {
  // 1) 算法本体 smoke：6 类各 1 个 fixture
  const cases = [
    { name: 'PROMPT', traj: [{ pattern: '旧 prompt 段落 A' }, { pattern: '又用 prompt 段落 A' }, { pattern: 'prompt 版本变更' }], expect: 'PROMPT_DEFICIENCY' },
    { name: 'TOOL', traj: [{ pattern: 'tool not found: x' }, { pattern: 'ENOENT tool_missing' }, { pattern: '绕过该工具 success' }], expect: 'TOOL_GAP' },
    { name: 'KNOWLEDGE', traj: [{ pattern: 'wiki miss' }, { pattern: 'memory miss 专有名词' }, { pattern: '补 wiki 后 success' }], expect: 'KNOWLEDGE_GAP' },
    { name: 'REASONING', traj: [{ pattern: '逻辑矛盾 self.reference' }, { pattern: '矛盾结论 opposite conclusion' }, { pattern: 'chain.consistency=false' }], expect: 'REASONING_ERROR' },
    { name: 'PLANNING', traj: [{ pattern: '顺序颠倒 reorder' }, { pattern: '重做 redo 无进展' }, { pattern: '重新拆分 replan success' }], expect: 'PLANNING_FAILURE' },
    { name: 'ENV', traj: [{ pattern: '5xx timeout' }, { pattern: '4xx rate limit' }, { pattern: 'outage 外部事件 status page' }, { pattern: 'retry 幂等 success' }], expect: 'ENVIRONMENT_SHIFT' },
  ];
  for (const c of cases) {
    const r = classify(c.traj);
    assert.equal(r.rootCause, c.expect, `${c.name} 应判为 ${c.expect}，实得 ${r.rootCause}`);
    assert.equal(Object.keys(r.evidence.scores).length, 7, `${c.name} scores 7-key 完整`);
  }

  // 2) UNCERTAIN 兜底 smoke
  const u = classify([{ pattern: '正常 success' }, { pattern: '也正常' }]);
  assert.equal(u.rootCause, 'UNCERTAIN');

  // 3) service annotate 已注册（不再抛 not implemented）
  const services = {};
  const written = [];
  const fakeCtx = {
    storageDomain: {
      open: async () => ({
        table: () => ({
          entries: () => [], // annotations 空
          put: async (id, entry) => { written.push({ id, entry }); },
        }),
        close: async () => undefined,
      }),
    },
    get: (name) => {
      if (name === 'agint.evolution') {
        // 20 条 failure_pattern → 越过 cold-start
        return { queryFailures: async () => new Array(20).fill({ id: 'x', pattern: 'p', severity: 'medium' }) };
      }
      return null;
    },
    provide(name, fn) { services[name] = fn; },
    effect() { return () => undefined; },
  };
  plugin.apply(fakeCtx);
  const annotate = services['agint.diagnosis.annotate'];
  assert.ok(typeof annotate === 'function', 'annotate 已注册为 function（不再抛 not implemented）');
  const result = await annotate({
    failureId: 'f-smoke',
    trajectory: [{ pattern: 'tool not found: foo' }, { pattern: 'ENOENT tool_missing' }, { pattern: '绕过该工具 success' }],
  });
  assert.equal(result.rootCause, 'TOOL_GAP');
  assert.equal(written.length, 1, '成功路径写入了 1 条 annotation');
});

// ── Case 7 (子任务 #4 追加): counterfactual 已注册 + 算法路径 smoke ─────
//
// 验证：
//   1) `agint.diagnosis.counterfactual` 服务已注册（不再抛 not implemented）
//   2) mock evolution.queryFailures（含 1 条 TOOL_GAP fixture + 9 条种子 → 越过 cold-start）
//   3) 返回 successRate ∈ [0, 1] + divergentSteps 非空 string[]

test('counterfactual 已注册（不再 not implemented）+ 算法路径 smoke', async () => {
  const toolGapFixture = {
    id: 'f-cf-toolgap',
    pattern: 'tool not found: smoke_tool',
    evidence: 'ENOENT tool_missing',
    severity: 'medium',
    category: 'integration',
    occurrences: 1,
  };
  const all = [
    toolGapFixture,
    ...new Array(9).fill(0).map((_, i) => ({
      id: `seed-${i}`, pattern: `seed ${i}`, severity: 'medium', category: 'other', occurrences: 1, evidence: '',
    })),
  ];

  const services = {};
  const fakeCtx = {
    storageDomain: {
      open: async () => ({
        table: () => ({ entries: () => [], put: async () => undefined }),
        close: async () => undefined,
      }),
    },
    get: (name) => {
      if (name === 'agint.evolution') return { queryFailures: async () => all };
      if (name === 'agint.memory') return { search: async () => [] };
      return null;
    },
    provide(name, fn) { services[name] = fn; },
    effect() { return () => undefined; },
  };
  plugin.apply(fakeCtx);
  const cf = services['agint.diagnosis.counterfactual'];
  assert.ok(typeof cf === 'function', 'counterfactual 已注册为 function（不再抛 not implemented）');

  const r = await cf({ failureId: 'f-cf-toolgap', modifiedStrategy: 'skip-tool' });
  assert.equal(typeof r.successRate, 'number');
  assert.ok(r.successRate >= 0 && r.successRate <= 1, `successRate=${r.successRate} 越界`);
  assert.ok(Array.isArray(r.divergentSteps) && r.divergentSteps.length >= 1, 'divergentSteps 非空且 ≥1');
});

// ── Case 8 (子任务 #5 追加): cluster 已注册 + 算法路径 smoke ────────────
//
// 验证：
//   1) `agint.diagnosis.cluster` 服务已注册（不再抛 not implemented）
//   2) mock evolution.queryFailures 返回 ≥1 条 fixture
//   3) cluster 返回 Cluster[]：FROZEN 字段（pattern/count/sampleFailureIds）

test('cluster 已注册（不再 not implemented）+ 算法路径 smoke', async () => {
  const fixture = [
    { id: 'f-c-1', pattern: 'tool not found: a', evidence: '', severity: 'medium', category: 'integration', occurrences: 1 },
    { id: 'f-c-2', pattern: 'tool missing: b', evidence: '', severity: 'medium', category: 'integration', occurrences: 1 },
    { id: 'f-c-3', pattern: 'tool error: c', evidence: '', severity: 'medium', category: 'integration', occurrences: 1 },
  ];

  const services = {};
  const fakeCtx = {
    storageDomain: {
      open: async () => ({
        // annotations 空（failureIds 未给时，cluster 应回退到 annotations 全集 → 空集）
        // clusters / reports 也是空
        table: () => ({ entries: () => [], put: async () => undefined }),
        close: async () => undefined,
      }),
    },
    get: (name) => {
      if (name === 'agint.evolution') {
        return { queryFailures: async ({ query } = {}) => {
          if (!query) return fixture;
          const q = String(query).toLowerCase();
          return fixture.filter((rec) => rec.pattern.toLowerCase().includes(q));
        } };
      }
      return null;
    },
    provide(name, fn) { services[name] = fn; },
    effect() { return () => undefined; },
  };
  plugin.apply(fakeCtx);
  const cluster = services['agint.diagnosis.cluster'];
  assert.ok(typeof cluster === 'function', 'cluster 已注册为 function（不再抛 not implemented）');

  // failureIds 给定 → 算法路径走通
  const r = await cluster({ failureIds: ['f-c-1', 'f-c-2', 'f-c-3'] });
  assert.ok(Array.isArray(r), 'cluster 返回数组');
  assert.ok(r.length >= 1, '应至少产生 1 个 cluster（"tool" substring 命中全部 3 条）');
  const toolCluster = r.find((c) => c.pattern === 'tool');
  assert.ok(toolCluster, '应有 pattern="tool" 的 cluster');
  assert.equal(toolCluster.count, 3);
  assert.deepEqual(toolCluster.sampleFailureIds, ['f-c-1', 'f-c-2', 'f-c-3']);
});

// ── Case 9 (子任务 #5 追加): report 已注册 + 7-key 分布正确 ─────────────
//
// 验证：
//   1) `agint.diagnosis.report` 服务已注册（不再抛 not implemented）
//   2) mock annotations 表注入 5 条（3 TOOL_GAP + 2 PROMPT_DEFICIENCY）
//   3) mock wiki / memory 写失败容错（让 wiki.write 抛错 + memory.write 抛错）
//   4) report 返回 FROZEN 字段：windowDays / generatedAt / annotationCount / clusterCount / rootCauseDistribution

test('report 已注册（不再 not implemented）+ 7-key 分布正确 + wiki/memory 写容错', async () => {
  const now = Date.now();
  const annotations = [
    { failureId: 'f-r-1', rootCause: 'TOOL_GAP', confidence: 0.7, evidence: '...', kind: 'annotation', createdAt: new Date(now - 1 * 86400_000).toISOString() },
    { failureId: 'f-r-2', rootCause: 'TOOL_GAP', confidence: 0.7, evidence: '...', kind: 'annotation', createdAt: new Date(now - 2 * 86400_000).toISOString() },
    { failureId: 'f-r-3', rootCause: 'TOOL_GAP', confidence: 0.7, evidence: '...', kind: 'annotation', createdAt: new Date(now - 3 * 86400_000).toISOString() },
    { failureId: 'f-r-4', rootCause: 'PROMPT_DEFICIENCY', confidence: 0.6, evidence: '...', kind: 'annotation', createdAt: new Date(now - 4 * 86400_000).toISOString() },
    { failureId: 'f-r-5', rootCause: 'PROMPT_DEFICIENCY', confidence: 0.6, evidence: '...', kind: 'annotation', createdAt: new Date(now - 5 * 86400_000).toISOString() },
  ];

  const services = {};
  const wikiWrites = [];
  const memoryWrites = [];
  const fakeCtx = {
    storageDomain: {
      open: async () => {
        const store = { annotations, clusters: [], reports: [] };
        return {
          table: (name) => ({
            entries: () => {
              const m = store[name];
              if (!m) return [];
              return m.map((rec, i) => [`k-${name}-${i}`, rec]);
            },
            put: async (id, entry) => { store[name] = store[name] || []; store[name].push(entry); },
          }),
          close: async () => undefined,
        };
      },
    },
    get: (name) => {
      if (name === 'agint.evolution') {
        // report 调 cluster 子调用时也会调 queryFailures——空表（不报 cluster）
        return { queryFailures: async () => [] };
      }
      if (name === 'agint.wiki') {
        return {
          write: async (p, c) => {
            wikiWrites.push({ path: p, bytes: c.length });
            throw new Error('mock wiki write failure');  // 容错测试：wiki 写失败不阻断 report
          },
        };
      }
      if (name === 'agint.memory') {
        return {
          write: async (input) => {
            memoryWrites.push(input);
            throw new Error('mock memory write failure');  // 容错测试：memory 写失败不阻断 report
          },
        };
      }
      return null;
    },
    provide(name, fn) { services[name] = fn; },
    effect() { return () => undefined; },
  };
  plugin.apply(fakeCtx);
  const report = services['agint.diagnosis.report'];
  assert.ok(typeof report === 'function', 'report 已注册为 function（不再抛 not implemented）');

  // 应不抛错（wiki/memory 写失败被容错）
  const r = await report({ windowDays: 7 });
  assert.equal(r.windowDays, 7);
  assert.equal(r.annotationCount, 5);
  assert.equal(typeof r.generatedAt, 'string');
  // 7-key 分布完整（UNCERTAIN=0 仍出现）
  assert.equal(Object.keys(r.rootCauseDistribution).length, 7);
  assert.equal(r.rootCauseDistribution.TOOL_GAP, 3);
  assert.equal(r.rootCauseDistribution.PROMPT_DEFICIENCY, 2);
  assert.equal(r.rootCauseDistribution.UNCERTAIN, 0);
  // wiki/memory 写失败被容错：调用了但 report 仍正常返回
  assert.ok(wikiWrites.length >= 1, 'wiki.write 被调用过');
  assert.ok(memoryWrites.length >= 1, 'memory.write 被调用过');
});
