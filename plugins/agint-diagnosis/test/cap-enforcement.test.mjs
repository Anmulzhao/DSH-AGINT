/**
 * agint-diagnosis 表满守门（cap）行为测试 —— 2026-09-26
 * Run: node plugins/agint-diagnosis/test/cap-enforcement.test.mjs
 *
 * 背景（为什么这个文件存在）：
 *   宿主 dsh-storage-domain 的 table API 是
 *       entries()  → 迭代器（`[...records.entries()][Symbol.iterator]()`）
 *       size       → getter（官方提供的计数入口）
 *   而 AGINT 全线写成了 `X.entries().length` —— 迭代器没有 `.length`，
 *   表达式恒为 `undefined`，于是
 *       `if (X.entries().length >= CAP) throw`  **永不触发**（caps 形同虚设）
 *       `{ reports: X.entries().length }`        **恒为 undefined**（stats 报表失真）
 *
 *   2026-09-26 的现场：reports 表堆到 66,480 条，而 cap 是 50。
 *
 * 本测试的要点是 **mock 必须忠实**：entries() 返回迭代器、size 是 getter。
 *   此前的 mock 返回数组（`[...m.entries()]`）且不提供 size，导致
 *   「断言表满必抛错」的用例在**生产必然失效**的情况下依然通过 ——
 *   这正是该 bug 存活 26 小时的原因（"验收脚本会骗人"）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const plugin = require('../lib/index.js');

const NOW = Date.now();
const iso = (d) => new Date(NOW - d * 86400_000).toISOString();

/** 忠实复刻宿主 table API：entries() = 迭代器；size = getter。 */
function faithfulTable(map) {
  return {
    get size() { return map.size; },
    entries() { return [...map.entries()][Symbol.iterator](); },
    put: async (k, v) => { map.set(k, v); },
    get: async (k) => map.get(k),
    delete: async (k) => { map.delete(k); },
  };
}

function makeCtx({ reports = 0, annotations = 0, clusters = 0, failures = 20 } = {}) {
  const stores = { annotations: new Map(), clusters: new Map(), reports: new Map() };
  for (let i = 0; i < reports; i += 1) {
    stores.reports.set(`r-${i}`, {
      id: `r-${i}`, kind: 'report', windowDays: 7, generatedAt: iso(1),
      annotationCount: 0, clusterCount: 0,
      rootCauseDistribution: {
        PROMPT_DEFICIENCY: 0, TOOL_GAP: 0, KNOWLEDGE_GAP: 0, REASONING_ERROR: 0,
        PLANNING_FAILURE: 0, ENVIRONMENT_SHIFT: 0, UNCERTAIN: 0,
      },
    });
  }
  for (let i = 0; i < annotations; i += 1) {
    stores.annotations.set(`a-${i}`, {
      id: `a-${i}`, kind: 'annotation', failureId: `f-${i}`, rootCause: 'TOOL_GAP',
      confidence: 0.5, evidence: '{}', createdAt: iso(1),
    });
  }
  for (let i = 0; i < clusters; i += 1) {
    stores.clusters.set(`c-${i}`, {
      id: `c-${i}`, kind: 'cluster', pattern: `p-${i}`, count: 2,
      sampleFailureIds: ['f-0', 'f-1'], createdAt: iso(1),
    });
  }
  const failurePatterns = new Array(failures).fill(0).map((_, i) => ({
    id: `fp-${i}`, pattern: `p-${i}`, evidence: 'e', severity: 'low', occurrences: 1, category: 'cat',
  }));
  const services = {};
  plugin.apply({
    storageDomain: {
      open: async () => ({
        table: (name) => faithfulTable(stores[name] || new Map()),
        close: async () => undefined,
      }),
    },
    get: (n) => {
      if (n === 'agint.evolution') return { queryFailures: async () => failurePatterns };
      return null; // wiki / memory / bus 全软降级
    },
    provide: (n, f) => { services[n] = f; },
    effect: () => () => undefined,
  });
  return { services };
}

// ── Case 0: mock 忠实性自证 ───────────────────────────────────────────

test('【前提】忠实 mock 下 entries().length 恒为 undefined（旧写法在此必然失效）', () => {
  const m = new Map([['k', 1]]);
  const t = faithfulTable(m);
  assert.equal(t.entries().length, undefined, 'entries() 是迭代器，没有 .length');
  assert.equal(t.size, 1, 'size 是官方计数入口');
  // 对照：数组式 mock 会让 .length 成立 —— 这正是旧测试"假阳性"的来源
  assert.equal([...t.entries()].length, 1);
});

// ── Case 1: reports cap = 50 ─────────────────────────────────────────

test('reports 表满 50 → report() 抛错（cap 真的会触发）', async () => {
  const { services } = makeCtx({ reports: 50 });
  await assert.rejects(
    () => services['agint.diagnosis.report']({ windowDays: 7 }),
    /reports table full \(cap 50\)/,
  );
});

test('reports 表 49 条 → report() 正常返回（未越界不误杀）', async () => {
  const { services } = makeCtx({ reports: 49 });
  const r = await services['agint.diagnosis.report']({ windowDays: 7 });
  assert.equal(r.windowDays, 7);
  assert.equal(typeof r.generatedAt, 'string');
});

// ── Case 2: annotations cap = 200 ────────────────────────────────────

test('annotations 表满 200 → annotate() 抛错（且晚于 cold-start 守门）', async () => {
  const { services } = makeCtx({ annotations: 200, failures: 20 });
  await assert.rejects(
    () => services['agint.diagnosis.annotate']({ failureId: 'f-0' }),
    /annotations table full \(cap 200\)/,
  );
});

test('annotations 未满 + 冷启动满足 → annotate() 正常返回', async () => {
  const { services } = makeCtx({ annotations: 3, failures: 20 });
  const r = await services['agint.diagnosis.annotate']({ failureId: 'f-0' });
  assert.equal(typeof r.rootCause, 'string');
});

// ── Case 3: clusters cap = 50 ────────────────────────────────────────

test('clusters 表满 50 → cluster() 抛错', async () => {
  const { services } = makeCtx({ clusters: 50, failures: 20 });
  await assert.rejects(
    () => services['agint.diagnosis.cluster']({ failureIds: ['f-0'] }),
    /clusters table full \(cap 50\)/,
  );
});

// ── Case 4: stats 不再返回 undefined ─────────────────────────────────

test('stats() 返回真实计数（旧写法下恒为 undefined）', async () => {
  const { services } = makeCtx({ reports: 7, annotations: 3, clusters: 2 });
  const s = await services['agint.diagnosis.stats']();
  assert.equal(s.reports, 7);
  assert.equal(s.annotations, 3);
  assert.equal(s.clusters, 2);
  assert.equal(typeof s.reports, 'number');
});
