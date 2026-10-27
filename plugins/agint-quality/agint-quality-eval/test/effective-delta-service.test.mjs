/**
 * test/effective-delta-service.test.mjs — 服务面接线（2026-10-26，D2 收口）
 *
 * 纯函数测过 ≠ 服务面接上了。本仓栽过太多次「字段落了/函数写了，主路径没人调」
 * （见 capability-boundary.md §4 F8 的「假接」），所以这里真 apply 一遍插件，
 * 从 `agint.qualityEvaluator.effectiveDelta()` 走完整链路：
 *
 *   ctx.get('agint.toolStats') → resourceWindow(当期) → resourceWindow(基线) → 判定
 *
 * 四条：
 *   1) 服务面存在该方法（不是只加了个 lib 文件）
 *   2) 两个窗口参数正确（offsetDays = 0 / = windowDays，同 days）
 *   3) toolStats 缺席 ⇒ unknown + tool-stats-unavailable（不抛、不编结论）
 *   4) ⛔ 60s TTL 缓存：连调两次只读一轮盘（决策路径会按 target 连调）
 *
 * Run: node --test plugins/agint-quality/agint-quality-eval/test/effective-delta-service.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(resolve(__dirname, '../lib/index.js')).href);

/** 最小 cordis ctx：provide/get/on/effect/tools/loader 够 apply 跑起来。 */
function makeCtx({ toolStats = null } = {}) {
  const services = new Map();
  if (toolStats) services.set('agint.toolStats', toolStats);
  return {
    services,
    get: (k) => services.get(k) ?? null,
    provide: (k, v) => services.set(k, v),
    on: () => {},
    effect: (fn) => { try { fn(); } catch { /* ignore */ } },
    tools: { register: () => {} },
    loader: { entries: () => [] },
  };
}

/** 当期比基线完成率高、资源涨一点 ⇒ effective。 */
function makeToolStats() {
  const calls = [];
  const win = (over = {}) => ({
    records: 10, tasks: 10, completedTasks: 8, completionRate: 0.8,
    steps: 10, durationMs: 1000,
    tokens: { sum: 1000, measured: 10, coverage: 1, source: 'tokenMeter' },
    ...over,
  });
  return {
    calls,
    async resourceWindow({ days, offsetDays }) {
      calls.push({ days, offsetDays });
      return offsetDays === 0 ? win({ completedTasks: 9, completionRate: 0.9, tokens: { sum: 1100, measured: 10, coverage: 1, source: 'tokenMeter' } }) : win();
    },
  };
}

test('服务面：agint.qualityEvaluator.effectiveDelta 真的注册了', () => {
  const ctx = makeCtx();
  mod.apply(ctx, {});
  const ev = ctx.get('agint.qualityEvaluator');
  assert.equal(typeof ev.effectiveDelta, 'function', '不是只加了 lib/effectiveDelta.js —— 服务面必须能调到');
});

test('两个窗口参数正确：当期 offsetDays=0，基线 offsetDays=windowDays', async () => {
  const toolStats = makeToolStats();
  const ctx = makeCtx({ toolStats });
  mod.apply(ctx, {});
  const r = await ctx.get('agint.qualityEvaluator').effectiveDelta({ windowDays: 7 });
  assert.equal(r.verdict, 'effective');
  assert.equal(r.value, 1);
  assert.deepEqual(toolStats.calls, [{ days: 7, offsetDays: 0 }, { days: 7, offsetDays: 7 }]);
});

test('toolStats 缺席 ⇒ unknown + tool-stats-unavailable（不抛、不编结论）', async () => {
  const ctx = makeCtx();
  mod.apply(ctx, {});
  const r = await ctx.get('agint.qualityEvaluator').effectiveDelta({});
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reason, 'tool-stats-unavailable');
  assert.match(r.line, /未判定|unknown/);
});

test('⛔ 60s TTL 缓存：连调两次只读一轮盘（origin 仍按调用方标注）', async () => {
  const toolStats = makeToolStats();
  const ctx = makeCtx({ toolStats });
  mod.apply(ctx, {});
  const ev = ctx.get('agint.qualityEvaluator');
  const a = await ev.effectiveDelta({ windowDays: 7, origin: 'weekly' });
  const b = await ev.effectiveDelta({ windowDays: 7, origin: 'policy' });
  assert.equal(toolStats.calls.length, 2, '第二次应命中缓存，不再读盘');
  assert.equal(a.origin, 'weekly');
  assert.equal(b.origin, 'policy', 'origin 是标注，不能被缓存吃掉');
  assert.equal(a.verdict, b.verdict);
});
