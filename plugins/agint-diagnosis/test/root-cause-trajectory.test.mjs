/**
 * 归因链路修复测试（2026-11-18，提案 49ac5e58 后续）。
 *
 * 取证（改前实跑，plugins/agint-diagnosis）：
 *   A) failureId 命中 failure_pattern 表 + 调用方显式 3 步 trajectory => UNCERTAIN conf=0
 *   B) 同一份 trajectory，failureId 不在表内                       => TOOL_GAP   conf=1
 *   C) 不传 trajectory，failureId 命中表内                          => UNCERTAIN conf=0
 * ⇒ 根因：服务层「failure_pattern 单行 > 入参 trajectory」的取值顺序，
 *   把调用方手里最真实的失败步骤序列丢弃了；6 类投票只看到 1 步 ⇒ 恒 UNCERTAIN。
 *
 * 另修：sandbox.failed 自动归因路径写不进表（rootCause 小写 + evidence 数组，
 *   而 FROZEN AnnotationSchema 要大写枚举 + string）⇒ 那条路径一行都没写出去过。
 *
 * Run: node plugins/agint-diagnosis/test/root-cause-trajectory.test.mjs
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

function makeCtx({ failures = [] } = {}) {
  const stores = {
    annotations: new Map(),
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
      if (name === 'agint.evolution') return { queryFailures: async () => failures };
      return null;
    },
    provide(name, fn) { services[name] = fn; },
    effect() { return () => undefined; },
  });
  return { services, stores };
}

/** 命中 3 个 TOOL_GAP 特征的步骤序列。 */
const TOOL_TRAJ = [
  { pattern: 'tool not found: foo' },
  { pattern: 'ENOENT tool_missing' },
  { pattern: '绕过该工具 success' },
];

const SEEDS = new Array(11).fill(0).map((_, i) => ({ id: `seed-${i}`, pattern: `p-${i}` }));

// ── 修复 1：显式 trajectory 优先于 failure_pattern 单行 ─────────────────

test('annotate: failureId 命中表内时，显式 trajectory 仍被采用（修前恒 UNCERTAIN）', async () => {
  const failures = [
    { id: 'evt-1', pattern: 'executor-run-failed', evidence: 'no actionable candidate', severity: 'high', occurrences: 3 },
    ...SEEDS,
  ];
  const { services } = makeCtx({ failures });
  const r = await services['agint.diagnosis.annotate']({ failureId: 'evt-1', trajectory: TOOL_TRAJ });
  assert.equal(r.rootCause, 'TOOL_GAP', '显式 trajectory 必须压过单行兜底');
  assert.ok(r.confidence > 0, 'confidence 应大于 0');
  const ev = JSON.parse(r.evidence);
  assert.equal(ev.trajectorySource, 'explicit', 'evidence 应记下证据来源');
  assert.equal(ev.trajectorySteps, 3);
});

test('annotate: 不传 trajectory 时退回单行兜底，来源记为 failure_pattern', async () => {
  const failures = [
    { id: 'evt-1', pattern: 'executor-run-failed', evidence: 'no actionable candidate' },
    ...SEEDS,
  ];
  const { services } = makeCtx({ failures });
  const r = await services['agint.diagnosis.annotate']({ failureId: 'evt-1' });
  assert.equal(r.rootCause, 'UNCERTAIN', '单步证据判不出根因时应诚实落 UNCERTAIN');
  const ev = JSON.parse(r.evidence);
  assert.equal(ev.trajectorySource, 'failure_pattern');
  assert.equal(ev.trajectorySteps, 1);
});

test('annotate: 显式 trajectory 为空数组时仍走单行兜底（空证据不覆盖已有证据）', async () => {
  const failures = [
    { id: 'evt-1', pattern: 'executor-run-failed', evidence: 'no actionable candidate' },
    ...SEEDS,
  ];
  const { services } = makeCtx({ failures });
  const r = await services['agint.diagnosis.annotate']({ failureId: 'evt-1', trajectory: [] });
  const ev = JSON.parse(r.evidence);
  assert.equal(ev.trajectorySource, 'failure_pattern');
});

// ── 修复 2：sandbox.failed 自动归因路径写表必须成功 ───────────────────

test('analyzeFailedSmoke: rootCause 归一到 FROZEN 大写枚举，evidence 为 string，写表成功', async () => {
  const { services, stores } = makeCtx({ failures: SEEDS });
  const r = await services['agint.diagnosis.analyzeFailedSmoke']({
    target: { path: 'plugins/agint-foo', name: 'agint-foo' },
    mode: 'smoke',
    reason: 'plugin-not-found',
    failedChecks: [{ name: 'plugin-exports', detail: 'no export' }],
    durationMs: 12,
  });
  assert.equal(r.rootCause, 'PLANNING_FAILURE', 'reason=plugin-not-found → PLANNING_FAILURE（大写枚举）');
  assert.equal(r.written, true, `写表应成功，writeError=${r.writeError ?? 'null'}`);
  assert.equal(r.writeError, null);
  assert.equal(stores.annotations.size, 1, 'annotations 表应新增 1 行');
  const row = [...stores.annotations.values()][0];
  assert.match(row.rootCause, /^[A-Z_]+$/, 'rootCause 必须是 FROZEN 枚举形态');
  assert.equal(typeof row.evidence, 'string', 'evidence 必须是 string（schema 要求）');
});

test('analyzeFailedSmoke: reason 为空串时归一到 unknown 且仍能写入', async () => {
  const { services, stores } = makeCtx({ failures: SEEDS });
  const r = await services['agint.diagnosis.analyzeFailedSmoke']({ target: { path: 'x' }, reason: '' });
  assert.equal(r.reason, 'unknown');
  assert.equal(r.rootCause, 'UNCERTAIN', '无 reason 时应诚实落 UNCERTAIN');
  assert.equal(r.written, true, `写表应成功，writeError=${r.writeError ?? 'null'}`);
  assert.equal(stores.annotations.size, 1);
});
