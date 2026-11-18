/**
 * diagnosis_annotate 入参形状 + 错误信息可诊断性测试（提案 49ac5e58 改动 1~3）。
 *
 * 背景（2026-11-17 取证）：
 *   1. 参数名断层：工具层传 { event:{id}, category, notes }，旧服务层只读
 *      input.failureId ⇒ 必抛 "failureId is required"，标注入口完全不可用。
 *   2. cold-start 死锁：错误信息只说「需先喂失败种子」，没写当前 N/10 与
 *      喂种子路径（evolution_addFailure），也无 failureId 找不到的区分。
 *   3. category：工具 schema 必填却被服务层静默丢弃（分类器只吃 trajectory）。
 *
 * 本文件只验证 1~3，不碰「标注时写 failure_pattern」红线（提案第 4 项需老板裁定）。
 *
 * Run: node plugins/agint-diagnosis/test/annotate-input-shape.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const plugin = require('../lib/index.js');

/** 忠实 mock：entries() 迭代器 + size getter（宿主 dsh-storage-domain 语义）。 */
function faithfulTable(map) {
  return {
    get size() { return map.size; },
    entries() { return [...map.entries()][Symbol.iterator](); },
    put: async (k, v) => { map.set(k, v); },
    get: async (k) => map.get(k),
  };
}

/** 构造 ctx：failurePatterns 为可查询的失败样本，返回 services + 写入表。 */
function makeCtx({ failures = [], annotations = [] } = {}) {
  const stores = {
    annotations: new Map(annotations.map((a, i) => [`a-${i}`, a])),
    clusters: new Map(),
    reports: new Map(),
  };
  const services = {};
  plugin.apply({
    storageDomain: {
      open: async () => ({
        table: (name) => faithfulTable(stores[name] || new Map()),
        close: async () => undefined,
      }),
    },
    get: (name) => {
      if (name === 'agint.evolution') {
        return { queryFailures: async () => failures };
      }
      return null;
    },
    provide(name, fn) { services[name] = fn; },
    effect() { return () => undefined; },
  });
  return { services, stores };
}

const TOOL_TRAJ = [
  { pattern: 'tool not found: foo' },
  { pattern: 'ENOENT tool_missing' },
  { pattern: '绕过该工具 success' },
];

// ── 改动 1：event.id 兜底解析 ─────────────────────────────────────────

test('annotate: 只传 event.id（无 failureId）可越过 failureId required 校验', async () => {
  const failures = [
    { id: 'evt-1', pattern: TOOL_TRAJ[0].pattern, evidence: 'e', severity: 'medium', occurrences: 1 },
    ...new Array(11).fill(0).map((_, i) => ({ id: `seed-${i}`, pattern: `p-${i}` })),
  ];
  const { services } = makeCtx({ failures });
  const r = await services['agint.diagnosis.annotate']({
    event: { id: 'evt-1', source: 'smoke', error: 'tool not found' },
    trajectory: TOOL_TRAJ,
  });
  // 从 event.id 解析出来的 failureId 应被写入 annotation
  assert.equal(r.failureId, 'evt-1', 'failureId 应回退取 event.id');
  assert.equal(typeof r.rootCause, 'string');
});

test('annotate: 显式 failureId 优先于 event.id', async () => {
  const failures = [
    { id: 'explicit', pattern: TOOL_TRAJ[0].pattern },
    ...new Array(11).fill(0).map((_, i) => ({ id: `seed-${i}`, pattern: `p-${i}` })),
  ];
  const { services } = makeCtx({ failures });
  const r = await services['agint.diagnosis.annotate']({
    failureId: 'explicit',
    event: { id: 'event-should-lose' },
    trajectory: TOOL_TRAJ,
  });
  assert.equal(r.failureId, 'explicit', '显式 failureId 优先');
});

test('annotate: 两者都没有 → 报 required，错误信息写明两种可传形状', async () => {
  const { services } = makeCtx({ failures: new Array(12).fill({ id: 'x' }) });
  await assert.rejects(
    () => services['agint.diagnosis.annotate']({ event: { source: 'smoke' } }),
    /failureId is required.*event\.id/,
  );
});

// ── 改动 2：cold-start 错误信息可诊断 ─────────────────────────────────

test('annotate: 样本不足时错误信息含当前 N/10 与 evolution_addFailure', async () => {
  const { services } = makeCtx({ failures: new Array(5).fill({ id: 'x', pattern: 'p' }) });
  await assert.rejects(
    () => services['agint.diagnosis.annotate']({ failureId: 'f-1', trajectory: [] }),
    (err) => {
      assert.match(err.message, /cold-start: failure_pattern 样本数 5 < 10/);
      assert.match(err.message, /当前 5\/10/);
      assert.match(err.message, /evolution_addFailure/);
      return true;
    },
  );
});

test('annotate: failureId 找不到时错误信息先报 not found，同时保留 cold-start 诊断', async () => {
  const failures = [
    { id: 'known-id', pattern: 'p' },
    ...new Array(4).fill(0).map((_, i) => ({ id: `seed-${i}`, pattern: `p-${i}` })),
  ];
  const { services } = makeCtx({ failures });
  await assert.rejects(
    () => services['agint.diagnosis.annotate']({ failureId: 'MISSING', trajectory: [] }),
    (err) => {
      assert.match(err.message, /failureId "MISSING" 未在 failure_pattern 表中找到/);
      // 兼容既有断言正则：cold-start 子串仍在
      assert.match(err.message, /cold-start: failure_pattern 样本数 5 < 10/);
      return true;
    },
  );
});

// ── 改动 3：category 不再被静默丢弃 ───────────────────────────────────

test('annotate: 调用方 category/notes 记入 evidence（审计留痕，不参与投票）', async () => {
  // failureId 不在 pattern 表 → 走 input.trajectory 兜底，让 6 类投票有充分特征
  const failures = new Array(12).fill(0).map((_, i) => ({ id: `seed-${i}`, pattern: `p-${i}` }));
  const { services } = makeCtx({ failures });
  const r = await services['agint.diagnosis.annotate']({
    failureId: 'direct-traj',
    event: { id: 'evt-2' },
    category: 'ENVIRONMENT_SHIFT', // 故意与真实投票结果 TOOL_GAP 相反
    notes: '人工怀疑是工具缺失',
    trajectory: TOOL_TRAJ,
  });
  const ev = JSON.parse(r.evidence);
  assert.equal(ev.hintCategory, 'ENVIRONMENT_SHIFT', 'category 应记入 evidence.hintCategory');
  assert.equal(ev.analystNotes, '人工怀疑是工具缺失', 'notes 应记入 evidence.analystNotes');
  assert.equal(r.rootCause, 'TOOL_GAP', '实际判定仍由特征投票决定，不受相反的 hint 影响');
});
