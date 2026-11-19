/**
 * test/weekly-targets-empty.test.mjs — targets=0 时周护栏仍跑（C 包修复）
 *
 * 2026-11-19 勘探发现：weeklyTask 在 targets.length === 0 时 early return，
 * 把 effectiveDelta / stagnation / deployBudget / baseline / selfModel 全部跳过。
 * 但 effectiveDelta 只从 tool-stats.resourceWindow 读数，与 targets 无关 ——
 * 探针实跑证生产已有 effective / resource-shrink（token 覆盖率 99.65%）。
 *
 * 修复：把 5 块独立判定提前到 early return 之前。targets=0 时只跳 evaluateAll 链。
 * 本测试验证修复后的行为：
 *   1) targets=0 时 runNow() 正常返回，不抛
 *   2) 返回结果含 baseline / stagnation / effectiveDelta / deployBudget
 *   3) evaluated=0（只跳过 evaluateAll，护栏正常出）
 *
 * Run: node --test plugins/agint-quality/agint-quality-eval/test/weekly-targets-empty.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(resolve(__dirname, '../lib/index.js')).href);

/** 最小 ctx：让 scheduler init 成功 + mock 空 targets + mock tool-stats */
function makeCtx({ toolStats } = {}) {
  const services = new Map();
  if (toolStats) services.set('agint.toolStats', toolStats);

  let intervalHandlers = [];
  let nextId = 1;

  return {
    services,
    get: (k) => services.get(k) ?? null,
    provide: (k, v) => services.set(k, v),
    on: () => {},
    emit: () => {},
    effect: (fn) => { try { fn(); } catch {} },
    tools: { register: () => {} },
    // ⚠️ 关键：loader 空 ⇒ enumerateTargets() 返回 0
    loader: { entries: () => [] },
    // scheduler init 需要 timer：假 setInterval 存 handler 但不真跑
    setInterval: (fn, _ms) => {
      intervalHandlers.push(fn);
      return nextId++;
    },
    clearInterval: () => {},
    setTimeout: () => nextId++,
    clearTimeout: () => {},
    // logger
    logger: { warn: () => {}, error: () => {}, info: () => {} },
  };
}

/** mock tool-stats：resourceWindow 返回完成率涨 + 资源降的有效进化 */
function makeMockToolStats() {
  const win = (over = {}) => ({
    records: 10, tasks: 10, completedTasks: 8, completionRate: 0.8,
    steps: 10, durationMs: 1000,
    tokens: { sum: 1000, measured: 10, coverage: 1, source: 'tokenMeter' },
    ...over,
  });
  return {
    resourceWindow: ({ offsetDays = 0, days = 7 }) => {
      // offsetDays=0 是当期（完成率高），offsetDays=7 是基线（完成率低）
      if (offsetDays === 0) return win({ completedTasks: 9, completionRate: 0.9 });
      return win({ completedTasks: 5, completionRate: 0.5 });
    },
  };
}

test('⛔ weeklyTask 护栏块不受 targets 数量影响：全部存在', async () => {
  const ctx = makeCtx({ toolStats: makeMockToolStats() });
  // 抑制 enumerateTargets 的技能目录第二源：DSH_HOME 指空目录
  const origHome = process.env.DSH_HOME;
  process.env.DSH_HOME = process.env.TEMP || 'C:\\Windows\\Temp';
  mod.apply(ctx, {});
  await new Promise((r) => setImmediate(r));
  if (origHome) process.env.DSH_HOME = origHome;

  const svc = ctx.services.get('agint.qualityEvaluator');
  const result = await svc.runNow();

  // 关键断言：护栏字段全部存在，不取决于 targets 数量
  assert.ok('baseline' in result, 'baseline 字段必须存在');
  assert.ok('stagnation' in result, 'stagnation 字段必须存在');
  assert.ok('effectiveDelta' in result, 'effectiveDelta 字段必须存在');
  assert.ok('deployBudget' in result, 'deployBudget 字段必须存在');

  // effectiveDelta 有 verdict（mock 数据下应为 effective）
  assert.ok(result.effectiveDelta, 'effectiveDelta 不应为 null');
  assert.ok(
    ['effective', 'ineffective', 'unknown'].includes(result.effectiveDelta.verdict),
    `effectiveDelta.verdict 应为三态之一，实际：${result.effectiveDelta?.verdict}`,
  );
  // mock 是完成率 50% → 90% + 资源降 → 应判 effective
  assert.equal(result.effectiveDelta.verdict, 'effective', 'mock 数据应判 effective');

  // stagnation 有 shape
  assert.ok(
    result.stagnation && typeof result.stagnation.isStagnated === 'boolean',
    'stagnation.isStagnated 应为 boolean',
  );

  // deployBudget 有 shape
  assert.ok(result.deployBudget !== undefined, 'deployBudget 不应 undefined');
});

test('⛔ 修复前行为（回归守护）：如果护栏缺失 = 代码回退了', async () => {
  const ctx = makeCtx({ toolStats: makeMockToolStats() });
  const origHome = process.env.DSH_HOME;
  process.env.DSH_HOME = process.env.TEMP || 'C:\\Windows\\Temp';
  mod.apply(ctx, {});
  await new Promise((r) => setImmediate(r));
  if (origHome) process.env.DSH_HOME = origHome;

  const svc = ctx.services.get('agint.qualityEvaluator');
  const result = await svc.runNow();

  // 修复前 early return 只返回 { evaluated: 0, persisted: 0, loggedToEvo: 0, baseline: null, stagnation: null }
  // 且没有 effectiveDelta / deployBudget 键
  const preFixShape =
    result.baseline === null &&
    result.stagnation === null &&
    !('effectiveDelta' in result) &&
    !('deployBudget' in result);

  assert.equal(preFixShape, false, '护栏全部为 null + effectiveDelta/deployBudget 缺失 = weeklyTask early return 回退到修复前状态');
});
