#!/usr/bin/env node
// agint-diagnosis / cluster-aggregator unit test.
// `node test/cluster-aggregator.test.mjs` 一行能跑（node --test 模式）。
//
// 覆盖（子任务 #5 交付要求）：
//   - 空 failurePatterns → 返回 []
//   - failurePatterns 给出 → 按 substring 聚类成功
//   - 同 substring 命中多条 → Cluster.count > 1
//   - 截断到 maxClusters=2
//   - 去重（两个 substring 命中同一组 failure_pattern → 合并成 1 cluster）
//   - pattern 字段 ≥3 字符才作 substring 候选
//   - sampleFailureIds ≤5
//   - ≥7 用例（任务描述 §3）

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateClusters,
  tokenizeSubstrings,
  sampleIds,
  idsKey,
  collectFailureIdsFromAnnotations,
  SUBSTRING_MIN_LEN,
  DEFAULT_MAX_CLUSTERS,
  SAMPLE_MAX,
} from '../lib/cluster-aggregator.js';

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * mock evolution.queryFailures：按 substring 反查固定 fixture 表。
 * 入参 query 命中 fixture.pattern（lowercase substring）。
 */
function makeMockEvolution(fixture) {
  return {
    queryFailures: async ({ query } = {}) => {
      if (!query) return fixture;
      const q = String(query).toLowerCase();
      return fixture.filter((rec) =>
        (rec.pattern ?? '').toLowerCase().includes(q)
        || (rec.evidence ?? '').toLowerCase().includes(q),
      );
    },
  };
}

// 5 条同 substring（"tool"）的 failure_pattern
const FIXTURE_TOOLGAP_5 = [
  { id: 'f-1', pattern: 'tool not found: fetch_weather_api', evidence: 'ENOENT' },
  { id: 'f-2', pattern: 'tool missing: github_pr_list', evidence: 'tool_missing' },
  { id: 'f-3', pattern: 'tool error: alpha_tool', evidence: '' },
  { id: 'f-4', pattern: 'tool not found: beta_tool', evidence: 'tool_missing' },
  { id: 'f-5', pattern: 'tool unavailable: gamma_tool', evidence: '' },
];

// ── Case 1: 空 failurePatterns → 返回 [] ────────────────────────────────

test('空 failurePatterns → []', async () => {
  const evo = makeMockEvolution([]);
  const r = await aggregateClusters({ failurePatterns: [], evolution: evo });
  assert.deepEqual(r, []);
});

// ── Case 2: failurePatterns 给出 → 按 substring 聚类成功 ─────────────────

test('failurePatterns 给出 → substring 聚类成功', async () => {
  const evo = makeMockEvolution(FIXTURE_TOOLGAP_5);
  const r = await aggregateClusters({ failurePatterns: FIXTURE_TOOLGAP_5, evolution: evo });
  assert.ok(r.length > 0, '应至少产生 1 个 cluster');
  for (const c of r) {
    assert.ok(typeof c.pattern === 'string' && c.pattern.length >= SUBSTRING_MIN_LEN);
    assert.ok(Number.isInteger(c.count) && c.count >= 1);
    assert.ok(Array.isArray(c.sampleFailureIds));
    assert.ok(c.sampleFailureIds.length <= SAMPLE_MAX);
  }
});

// ── Case 3: 5 条 failure_pattern 同 substring 命中 → count=5 ──────────────

test('5 条 failure_pattern 同 substring 命中 → count=5', async () => {
  const evo = makeMockEvolution(FIXTURE_TOOLGAP_5);
  const r = await aggregateClusters({ failurePatterns: FIXTURE_TOOLGAP_5, evolution: evo });
  // 找 "tool" substring 的 cluster
  const toolCluster = r.find((c) => c.pattern === 'tool');
  assert.ok(toolCluster, '应有 pattern="tool" 的 cluster');
  assert.equal(toolCluster.count, 5, '5 条 fixture 全命中 tool substring → count=5');
  assert.equal(toolCluster.sampleFailureIds.length, 5);
});

// ── Case 4: 截断到 maxClusters=2 ────────────────────────────────────────

test('截断 maxClusters=2', async () => {
  // 准备 5 个不同 substring 的 fixture
  const fixture = [
    { id: 'f-1', pattern: 'alpha bravo charlie' },
    { id: 'f-2', pattern: 'delta echo foxtrot' },
    { id: 'f-3', pattern: 'golf hotel india' },
    { id: 'f-4', pattern: 'juliet kilo lima' },
    { id: 'f-5', pattern: 'mike november oscar' },
  ];
  const evo = makeMockEvolution(fixture);
  const r = await aggregateClusters({ failurePatterns: fixture, evolution: evo, maxClusters: 2 });
  assert.ok(r.length <= 2, `截断到 maxClusters=2 → ${r.length} ≤ 2`);
});

// ── Case 5: 去重（两个 substring 命中同一组 → 合并成 1 cluster）──────────

test('去重合并：两个 substring 命中同一组 → 1 cluster', async () => {
  // 3 条 fixture，所有都包含 "alpha" 和 "beta" 两个 ≥3 字符 token
  // → "alpha" 和 "beta" 两个 substring 反查都命中同一组 ids → 合并成 1 cluster
  // （不引入其他 token 干扰）
  const fixture = [
    { id: 'a', pattern: 'alpha beta' },
    { id: 'b', pattern: 'alpha beta' },
    { id: 'c', pattern: 'alpha beta' },
  ];
  const evo = makeMockEvolution(fixture);
  const r = await aggregateClusters({ failurePatterns: fixture, evolution: evo });
  // 只有 alpha + beta 两个 substring → 只应产生 1 cluster（合并）
  assert.equal(r.length, 1, '两个 substring 命中同一组 ids → 合并成 1 cluster');
  assert.equal(r[0].count, 3, '合并后 count = 命中 ids 数 = 3');
  // pattern 取最长 substring：'alpha' (5) === 'beta' (4) → 字典序前 = 'alpha'
  assert.equal(r[0].pattern, 'alpha');
  assert.deepEqual(r[0].sampleFailureIds, ['a', 'b', 'c']);
});

// ── Case 6: pattern 字段 <3 字符不作为 substring 候选 ─────────────────────

test('pattern <3 字符 token 不作 substring 候选', async () => {
  // "ab" 和 "or" 长度 < 3 → 不应成为 cluster.pattern
  const fixture = [
    { id: 'x', pattern: 'ab or xyz' },  // 'xyz' ≥3 字符 → 候选
  ];
  const evo = makeMockEvolution(fixture);
  const r = await aggregateClusters({ failurePatterns: fixture, evolution: evo });
  assert.ok(r.length >= 1);
  // 验证 cluster.pattern 都是 ≥3 字符
  for (const c of r) {
    assert.ok(c.pattern.length >= SUBSTRING_MIN_LEN, `pattern="${c.pattern}" 长度 < ${SUBSTRING_MIN_LEN}`);
  }
  // 验证 'ab' 和 'or' 不在 cluster.pattern 里
  assert.equal(r.some((c) => c.pattern === 'ab'), false);
  assert.equal(r.some((c) => c.pattern === 'or'), false);
});

// ── Case 7: sampleFailureIds ≤ 5 ────────────────────────────────────────

test('sampleFailureIds ≤ SAMPLE_MAX (5)', async () => {
  // 10 条 fixture 全命中 "pattern" substring → sampleFailureIds 应截断到 5
  const fixture = new Array(10).fill(0).map((_, i) => ({
    id: `f-${i}`,
    pattern: `hit pattern-${i}`,
  }));
  const evo = makeMockEvolution(fixture);
  const r = await aggregateClusters({ failurePatterns: fixture, evolution: evo });
  // 'pattern-0' 等是每条独有的 substring（仅命中1条），
  // 'pattern' substring 被所有 10 条命中 → 找 cluster.count = 10
  const merged = r.find((c) => c.count === 10);
  assert.ok(merged, '应有一个 count=10 的合并 cluster');
  assert.equal(merged.sampleFailureIds.length, SAMPLE_MAX, `sampleFailureIds 截断到 ${SAMPLE_MAX}`);
});

// ── Case 8: 空 evolution queryFailures 结果 → [] ─────────────────────────

test('空 evolution（queryFailures 返回 []） → []', async () => {
  const evo = makeMockEvolution([]);  // queryFailures 永远返回 []
  const fixture = [{ id: 'a', pattern: 'something interesting' }];
  const r = await aggregateClusters({ failurePatterns: fixture, evolution: evo });
  assert.deepEqual(r, []);
});

// ── Case 9: tokenizeSubstrings 切词边界 ──────────────────────────────────

test('tokenizeSubstrings: 空格 / 逗号 / 分号 / 中文逗号 都切', () => {
  assert.deepEqual(tokenizeSubstrings('tool not found'), ['tool', 'not', 'found']);
  // 短 token <3 字符被过滤（避免噪声）
  assert.deepEqual(tokenizeSubstrings('aaa,bbb,ccc;ddd'), ['aaa', 'bbb', 'ccc', 'ddd']);
  // 中文逗号 / 分号同样作为分隔符
  assert.deepEqual(tokenizeSubstrings('foo，bar；baz'), ['foo', 'bar', 'baz']);
  assert.deepEqual(tokenizeSubstrings(''), []);
  assert.deepEqual(tokenizeSubstrings(null), []);
});

// ── Case 10: sampleIds + idsKey 内部 helper 直接验 ────────────────────────

test('sampleIds / idsKey 内部 helper', () => {
  // sampleIds: 去重 + 截断
  assert.deepEqual(sampleIds(['a', 'b', 'a', 'c']), ['a', 'b', 'c']);
  assert.equal(sampleIds(new Array(10).fill(0).map((_, i) => `id-${i}`)).length, SAMPLE_MAX);
  assert.deepEqual(sampleIds([]), []);
  assert.deepEqual(sampleIds(null), []);
  // idsKey: 集合序列化（顺序无关）
  assert.equal(idsKey(new Set(['a', 'b', 'c'])), idsKey(new Set(['c', 'a', 'b'])));
  assert.notEqual(idsKey(new Set(['a', 'b'])), idsKey(new Set(['a', 'b', 'c'])));
});

// ── Case 11: collectFailureIdsFromAnnotations ────────────────────────────

test('collectFailureIdsFromAnnotations: 去重 failureId', async () => {
  // 构造一个 mock table（entries() 返回 [id, entry] 元组迭代器）
  const t = {
    entries: function* () {
      yield ['k1', { failureId: 'f-1' }];
      yield ['k2', { failureId: 'f-2' }];
      yield ['k3', { failureId: 'f-1' }];  // 重复
      yield ['k4', { failureId: '' }];     // 空字符串跳过
      yield ['k5', {}];                    // 缺字段跳过
    },
  };
  const ids = await collectFailureIdsFromAnnotations(t);
  assert.deepEqual([...ids].sort(), ['f-1', 'f-2']);
});

// ── Case 12: evolution service 缺失抛错 ──────────────────────────────────

test('evolution service 缺失 → throw', async () => {
  await assert.rejects(
    () => aggregateClusters({ failurePatterns: [{ id: 'a', pattern: 'b' }], evolution: null }),
    /evolution service.*不可用/,
  );
});

// ── Case 13: maxClusters 上限默认 = LIMITS.CLUSTERS=50 ─────────────────────

test('默认 maxClusters = LIMITS.CLUSTERS = 50', async () => {
  // 即便不传 maxClusters，返回的 cluster 数组长度 ≤ 50
  // 51 个不同 substring 各命中 1 条 → 应被截断到 50
  const fixture = new Array(51).fill(0).map((_, i) => ({
    id: `f-${i}`,
    pattern: `unique-token-${i} something else`,
  }));
  const evo = makeMockEvolution(fixture);
  const r = await aggregateClusters({ failurePatterns: fixture, evolution: evo });
  assert.ok(r.length <= DEFAULT_MAX_CLUSTERS, `r.length=${r.length} ≤ ${DEFAULT_MAX_CLUSTERS}`);
});