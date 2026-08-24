#!/usr/bin/env node
// agint-diagnosis / root-cause-classifier unit test.
// `node test/root-cause-classifier.test.mjs` 一行能跑（node --test 模式）。
//
// 覆盖（子任务 #3 交付要求）：
//   - 6 类根因各 1 个正向用例（每类命中 ≥2 条特征 → 唯一胜出）
//   - UNCERTAIN 兜底（命中 0 类）
//   - 并列情形（≥2 类命中 ≥2 特征 → 取字典序前 + evidence.tied 标注）
//   - 边界：cold-start 抛错（service 层），表满抛错（service 层）
//   - evidence.scores 7-key 完整
//   - 内部 _classify* 函数直接验（细节回归用）
//   - ≥10 用例（设计稿 §三 验收 + eval 子任务基础）

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classify,
  _classifyPromptDeficiency,
  _classifyToolGap,
  _classifyKnowledgeGap,
  _classifyReasoningError,
  _classifyPlanningFailure,
  _classifyEnvironmentShift,
  ROOT_CAUSE_KINDS,
} from '../lib/root-cause-classifier.js';

// ── fixture helpers ─────────────────────────────────────────────────────

function fixture(steps) {
  return steps.map((s) => (typeof s === 'string' ? { pattern: s } : s));
}

// ── Case 1: PROMPT_DEFICIENCY 正向 ──────────────────────────────────────

test('classify: PROMPT_DEFICIENCY (≥2 features)', () => {
  const traj = fixture([
    { pattern: '调用旧 prompt 段落 A' },                       // 特征 1: prompt
    { pattern: '再次使用 prompt 段落 A' },                     // 特征 1: prompt 重复
    { pattern: 'prompt 版本 v3 变更后立即出现失败' },           // 特征 2
    { pattern: '同一 prompt 跨任务反复失败 occurrences=3' },   // 特征 3
    { pattern: '同上 prompt 跨任务又失败 occurrences=2' },     // 特征 3 累加
  ]);
  const r = classify(traj);
  assert.equal(r.rootCause, 'PROMPT_DEFICIENCY');
  assert.ok(r.confidence > 0, 'confidence > 0');
  assert.ok(r.evidence.matchedFeatures.length >= 2);
  // scores 7-key 完整
  assert.equal(Object.keys(r.evidence.scores).length, 7);
});

// ── Case 2: TOOL_GAP 正向 ───────────────────────────────────────────────

test('classify: TOOL_GAP (≥2 features)', () => {
  const traj = fixture([
    { pattern: 'tool not found: fetch_weather_api' },           // 特征 1
    { pattern: '错误信号 ENOENT / tool_missing detected' },    // 特征 2
    { pattern: '重试时绕过该工具，success 通过' },              // 特征 3
  ]);
  const r = classify(traj);
  assert.equal(r.rootCause, 'TOOL_GAP');
  assert.ok(r.evidence.matchedFeatures.length >= 2);
});

// ── Case 3: KNOWLEDGE_GAP 正向 ──────────────────────────────────────────

test('classify: KNOWLEDGE_GAP (≥2 features)', () => {
  const traj = fixture([
    { pattern: '读 wiki miss: 没有该条目' },                    // 特征 1
    { pattern: 'memory miss: domain term 专有名词' },           // 特征 2
    { pattern: '人工补充 wiki 后同任务可过 success' },          // 特征 3
  ]);
  const r = classify(traj);
  assert.equal(r.rootCause, 'KNOWLEDGE_GAP');
});

// ── Case 4: REASONING_ERROR 正向 ────────────────────────────────────────

test('classify: REASONING_ERROR (≥2 features)', () => {
  const traj = fixture([
    { pattern: '推理链含逻辑矛盾 self.reference 自指' },        // 特征 1
    { pattern: '同前提推出矛盾结论 opposite conclusion' },       // 特征 2
    { pattern: 'chain.consistency=false 自评失败' },           // 特征 3
  ]);
  const r = classify(traj);
  assert.equal(r.rootCause, 'REASONING_ERROR');
});

// ── Case 5: PLANNING_FAILURE 正向 ──────────────────────────────────────

test('classify: PLANNING_FAILURE (≥2 features)', () => {
  const traj = fixture([
    { pattern: '子任务顺序颠倒 out of order reorder' },          // 特征 1
    { pattern: '同目标重做 redo again 又失败' },                 // 特征 2 部分
    { pattern: '再次重做 redo again 无进展 no progress stuck' }, // 特征 2 完成
    { pattern: '重新拆分 replan 后一步通过 passed success' },    // 特征 3
  ]);
  const r = classify(traj);
  assert.equal(r.rootCause, 'PLANNING_FAILURE');
});

// ── Case 6: ENVIRONMENT_SHIFT 正向 ─────────────────────────────────────

test('classify: ENVIRONMENT_SHIFT (≥2 features)', () => {
  // 4 步里 ≥2 步出现 4xx/5xx → 占比 50% ≥ 30%（特征 1）
  const traj = fixture([
    { pattern: 'GET /api/x 5xx status 500 external api timeout' },
    { pattern: 'POST /api/y 4xx status 429 rate limit http error' },
    { pattern: 'outage 外部事件 status page 公告' },            // 特征 2
    { pattern: '重试 retry + 幂等 idempotent → success 通过' }, // 特征 3
  ]);
  const r = classify(traj);
  assert.equal(r.rootCause, 'ENVIRONMENT_SHIFT');
});

// ── Case 7: UNCERTAIN 兜底（命中 0 类） ─────────────────────────────────

test('classify: UNCERTAIN when no class matches', () => {
  const traj = fixture([
    { pattern: '正常执行无异常' },
    { pattern: '完成 success' },
  ]);
  const r = classify(traj);
  assert.equal(r.rootCause, 'UNCERTAIN');
  assert.equal(r.confidence, 0);
  assert.equal(r.evidence.matchedFeatures.length, 0);
});

// ── Case 8: UNCERTAIN 兜底（命中 1 条特征但都 <2） ─────────────────────

test('classify: UNCERTAIN when all classes hit only 1 feature', () => {
  const traj = fixture([
    { pattern: '提到 prompt' },                // PROMPT 命中 1
    { pattern: 'tool not found 单条' },         // TOOL 命中 1
    { pattern: '无该条目 wiki miss' },          // KNOWLEDGE 命中 1
  ]);
  const r = classify(traj);
  assert.equal(r.rootCause, 'UNCERTAIN');
  assert.equal(r.confidence, 0);
  assert.ok(r.evidence.note.includes('UNCERTAIN'));
});

// ── Case 9: 并列情形（≥2 类命中 ≥2 特征） ───────────────────────────────

test('classify: tied → lexicographically smaller wins, evidence.tied set', () => {
  // 同时让 TOOL_GAP 和 KNOWLEDGE_GAP 命中 ≥2 特征
  // 字典序：KNOWLEDGE_GAP < TOOL_GAP，应取 KNOWLEDGE_GAP
  const traj = fixture([
    { pattern: 'tool not found: fetch_foo' },                       // TOOL 特征 1
    { pattern: 'ENOENT / tool_missing detected' },                 // TOOL 特征 2
    { pattern: 'wiki miss + memory miss: 专有名词' },              // KNOWLEDGE 特征 1+2
    { pattern: '人工补充 wiki 后通过 success' },                   // KNOWLEDGE 特征 3
  ]);
  const r = classify(traj);
  // 字典序前者
  assert.equal(r.rootCause, 'KNOWLEDGE_GAP');
  assert.deepEqual(r.evidence.tied, ['TOOL_GAP']);
  assert.ok(r.evidence.note.includes('并列'));
});

// ── Case 10: scores 是 7-key map（schema 完整性回归） ───────────────────

test('classify: evidence.scores 是 7-key ROOT_CAUSE_KINDS map', () => {
  const traj = fixture([{ pattern: '正常' }]);
  const r = classify(traj);
  for (const k of ROOT_CAUSE_KINDS) {
    assert.ok(Object.prototype.hasOwnProperty.call(r.evidence.scores, k), `scores 缺 ${k}`);
    assert.equal(typeof r.evidence.scores[k], 'number');
    assert.ok(r.evidence.scores[k] >= 0);
  }
});

// ── Case 11: 内部 _classify* 回归（不通过主入口） ─────────────────────

test('_classifyToolGap: 3 特征全中 → confidence=1', () => {
  const traj = fixture([
    { pattern: 'tool not found: x' },
    { pattern: 'ENOENT tool_missing error' },
    { pattern: '绕过该工具 without this tool → success' },
  ]);
  const r = _classifyToolGap(traj);
  assert.equal(r.matchedFeatures.length, 3);
  assert.equal(r.confidence, 1);
});

// ── Case 12: trajectory 为空 / 非数组容错 ─────────────────────────────

test('classify: trajectory 为空数组 → UNCERTAIN 不抛错', () => {
  const r = classify([]);
  assert.equal(r.rootCause, 'UNCERTAIN');
  assert.equal(r.confidence, 0);
});

test('classify: trajectory 为非数组 → UNCERTAIN 不抛错', () => {
  const r = classify(null);
  assert.equal(r.rootCause, 'UNCERTAIN');
});

test('classify: 字符串步骤容错 → TOOL_GAP（3 特征全部命中）', () => {
  // 入参可以混 string 与 object
  // 3 条字符串步骤各命中 TOOL_GAP 的 1 个不同特征 → 3/3 → rootCause = TOOL_GAP
  const traj = ['tool not found: foo', 'ENOENT tool_missing', '绕过该工具 success'];
  const r = classify(traj);
  assert.equal(r.rootCause, 'TOOL_GAP');
  assert.equal(r.evidence.scores.TOOL_GAP, 3);
});

// ── Case 13: cold-start 抛错（service 层 mock） ────────────────────────

/** 构造一个可收集 provide 的 fakeCtx，并 mock 出 storage + evolution service。 */
function makeFakeCtx({ failurePatternCount = 0, annotationsCount = 0 } = {}) {
  const services = {};
  const annotationsEntries = new Array(annotationsCount).fill(0).map((_, i) => ({
    id: `pre-${i}`,
    kind: 'annotation',
    failureId: `f-${i}`,
    rootCause: 'TOOL_GAP',
    confidence: 0.5,
    evidence: '{}',
    createdAt: '2026-08-24T00:00:00.000Z',
  }));
  const ctx = {
    storageDomain: {
      open: async () => ({
        table: (name) => ({
          entries: () => (name === 'annotations' ? annotationsEntries : []),
          put: async () => undefined,
        }),
        close: async () => undefined,
      }),
    },
    get: (name) => {
      if (name === 'agint.evolution') {
        return {
          queryFailures: async () => new Array(failurePatternCount).fill({ id: 'x', pattern: 'p', severity: 'medium' }),
        };
      }
      return null;
    },
    provide(name, fn) { services[name] = fn; },
    effect() { return () => undefined; },
  };
  return { ctx, services };
}

test('service annotate: cold-start throws when failure_pattern < 10', async () => {
  const plugin = await import('../lib/index.js');
  const { ctx, services } = makeFakeCtx({ failurePatternCount: 3 });
  plugin.apply(ctx);
  const annotate = services['agint.diagnosis.annotate'];
  assert.ok(annotate, 'annotate service 应已注册');
  await assert.rejects(
    () => annotate({ failureId: 'f-1', trajectory: [] }),
    /cold-start.*failure_pattern.*样本数/,
  );
});

// ── Case 14: 表满抛错（service 层 mock，mock annotations 已 200 条） ───

test('service annotate: throws when annotations table full (cap 200)', async () => {
  const plugin = await import('../lib/index.js');
  const { ctx, services } = makeFakeCtx({ failurePatternCount: 20, annotationsCount: 200 });
  plugin.apply(ctx);
  const annotate = services['agint.diagnosis.annotate'];
  assert.ok(annotate, 'annotate service 应已注册');
  await assert.rejects(
    () => annotate({ failureId: 'f-new', trajectory: [] }),
    /annotations table full \(cap 200\)/,
  );
});

// ── Case 15: annotate 成功路径（mock 完整 ctx，验证返回 + 写入） ──────

test('service annotate: success path returns unpacked annotation + writes', async () => {
  const plugin = await import('../lib/index.js');
  const written = [];
  const { ctx, services } = makeFakeCtx({ failurePatternCount: 20 });
  // 覆盖 ctx 上的 put，收集写入
  ctx.storageDomain.open = async () => ({
    table: () => ({
      entries: () => [],
      put: async (id, entry) => { written.push({ id, entry }); },
    }),
    close: async () => undefined,
  });
  plugin.apply(ctx);
  const annotate = services['agint.diagnosis.annotate'];
  const result = await annotate({
    failureId: 'f-good',
    trajectory: [
      { pattern: 'tool not found: foo' },
      { pattern: 'ENOENT tool_missing' },
      { pattern: '绕过该工具 success' },
    ],
  });
  assert.equal(result.failureId, 'f-good');
  assert.equal(result.rootCause, 'TOOL_GAP');
  assert.ok(result.confidence > 0);
  assert.ok(typeof result.evidence === 'string');
  // 写入了 1 条
  assert.equal(written.length, 1);
  assert.equal(written[0].entry.kind, 'annotation');
  assert.equal(written[0].entry.failureId, 'f-good');
});