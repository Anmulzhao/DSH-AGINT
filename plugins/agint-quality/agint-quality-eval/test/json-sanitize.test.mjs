// 回归用例：quality_eval_status 在首次评估之后报 invalid output。
//
// 取证（2026-10-14 实测）：
//   1. 触发 quality_eval_run_now 之前：quality_eval_status 正常返回
//      （lastRun=<never>，因为 lastRun 是 null）。
//   2. 触发之后：quality_eval_status 报
//      `invalid output: value is not lossless JSON`，稳定复现。
// 根因：lib/scheduler.js:58 `const at = new Date()` —— lastRun.at 是 Date 对象，
//   Date 不是 JSON 原生类型 ⇒ 宿主 lossless-JSON 校验拒绝整个返回值。
//   未跑过评估时 lastRun=null，所以这个 bug 只在首次评估之后才现形。
//
// ⛔ 纪律（Playbook §3.5）：mock 复刻真实契约。这里用真实 scheduler 产出的
//   lastRun 形状（{ at: Date, result, error }）喂给真实 tools 的 execute 路径。

import test from 'node:test';
import assert from 'node:assert/strict';

// tools.js 需要 @deepseek-ai/dsh-tools；本机仓库缺该包，用同一套替身机制。
// 与 agint-input-gateway / agint-evolve 的 test/_stub-register.mjs 同型。

const mod = await import('../lib/tools.js');
const { apply, inject, name } = mod;

test('取证：tools 模块导出 name / inject / apply', () => {
  assert.equal(name, 'agint-quality-eval-tools');
  assert.ok(Array.isArray(inject), 'inject 必须是数组');
  assert.ok(inject.includes('agint.qualityEvaluator'));
});

/** 造一个最小 ctx，捕获注册的工具描述（含 output.schema 与 execute）。 */
function captureTools(evaluator) {
  const out = new Map();
  const ctx = {
    tools: {
      register(desc) { out.set(desc.name, desc); },
    },
    'agint.qualityEvaluator': evaluator,
  };
  const res = apply(ctx, {});
  return { tools: out, res };
}

/** 判定一个值是否是纯 JSON（宿主 lossless 校验的语义）。 */
function isLosslessJson(v, seen = new Set()) {
  if (v === null) return true;
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return true;
  if (t === 'number') return Number.isFinite(v); // NaN/Infinity 不合法
  if (t !== 'object') return false;               // Date/Error/function/undefined 不合法
  if (seen.has(v)) return true;
  seen.add(v);
  if (Array.isArray(v)) return v.every((x) => isLosslessJson(x, seen));
  return Object.values(v).every((x) => isLosslessJson(x, seen));
}

test('⛔ 修复后：lastRun 含 Date 时，execute 返回值仍是纯 JSON', async () => {
  const ranAt = new Date('2026-10-14T15:11:32.738Z');
  const evaluator = {
    nextFire: () => new Date('2026-10-17T20:30:00.000Z'),
    lastRun: () => ({ at: ranAt, result: { evaluated: 1, persisted: 1 }, error: null }),
    weights: { trust: 0.2 },
    dimensionKeys: ['trust'],
  };
  const { tools } = captureTools(evaluator);
  const tool = tools.get('quality_eval_status');
  assert.ok(tool, 'quality_eval_status 必须被注册');

  const value = await tool.execute({});
  assert.ok(
    isLosslessJson(value),
    `返回值必须是纯 JSON（含 Date 会被宿主拒），实得 lastRun.at=${value.lastRun?.at}`,
  );
  assert.equal(value.lastRun.at, '2026-10-14T15:11:32.738Z', 'Date 应归一化成 ISO 字符串');
});

test('未跑过评估（lastRun=null）时照常返回 null', async () => {
  const { tools } = captureTools({
    nextFire: () => null,
    lastRun: () => null,
    weights: {},
    dimensionKeys: [],
  });
  const value = await tools.get('quality_eval_status').execute({});
  assert.equal(value.lastRun, null);
  assert.equal(value.nextFire, null);
  assert.ok(isLosslessJson(value));
});

test('error 是 Error 实例时也被压成纯 JSON', async () => {
  const { tools } = captureTools({
    nextFire: () => new Date(),
    lastRun: () => ({ at: new Date(), result: null, error: new Error('boom') }),
    weights: {},
    dimensionKeys: [],
  });
  const value = await tools.get('quality_eval_status').execute({});
  assert.ok(isLosslessJson(value), `Error 必须被压平，实得 ${JSON.stringify(value.lastRun?.error)}`);
  assert.equal(value.lastRun.error.message, 'boom');
});

test('安全不回退：render 对 lastRun=null 走 <never> 分支', async () => {
  const { tools } = captureTools({
    nextFire: () => new Date('2026-10-17T20:30:00.000Z'),
    lastRun: () => null,
    weights: { trust: 0.2 },
    dimensionKeys: ['trust'],
  });
  const tool = tools.get('quality_eval_status');
  const text = tool.output.render({}, await tool.execute({}))[0].text;
  assert.match(text, /<never>/, 'render 必须在 lastRun 为空时印 <never>');
});
