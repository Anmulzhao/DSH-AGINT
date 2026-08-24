#!/usr/bin/env node
/**
 * eval/run-counterfactual-stress.mjs — Sprint 7 子任务 #6 反事实成功率压测
 *
 * 读取 eval/scenarios/agint-diagnosis-counterfactual.scenario.json，对
 * 每条 fixture 跑 plugins/agint-diagnosis/lib/index.js 的真
 * `agint.diagnosis.counterfactual` service（mock ctx）。
 *
 * 成功率定义（设计稿 §二.4）：
 *   successRate > 0 → 反事实命中（wouldSucceed=true）
 *   successRate == 0 → 反事实未命中（wouldSucceed=false）
 *   UNCERTAIN → successRate=0.3 → wouldSucceed=true（兜底也算）
 *
 * 验收门槛（设计稿 §三）：
 *   - 路线图目标 ≥70%
 *   - 首次发布软门槛 ≥50%
 *
 * 用法：
 *   node eval/run-counterfactual-stress.mjs
 * 退出码：0 = 成功率 ≥ 软门槛（50%），1 = 失败。
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGINT_ROOT = resolve(__dirname, '..');
const SCENARIO_FILE = join(__dirname, 'scenarios', 'agint-diagnosis-counterfactual.scenario.json');

const SOFT_THRESHOLD = 0.5; // 设计稿 §三：首次发布软门槛
const ROADMAP_TARGET = 0.7; // 设计稿 §三：路线图目标

// ── 加载 scenario JSON ───────────────────────────────────────────────────

const raw = await readFile(SCENARIO_FILE, 'utf8');
const scenario = JSON.parse(raw);
const fixtures = Array.isArray(scenario.fixtures) ? scenario.fixtures : [];
if (fixtures.length < 10) {
  console.error(`[FAIL] scenario.fixtures 必须 ≥10 条，实得 ${fixtures.length}`);
  process.exit(1);
}

// ── 加载 plugin + 真 counterfactual service ──────────────────────────────

const pluginMod = await import(`${AGINT_ROOT}/plugins/agint-diagnosis/lib/index.js`);

// 把 fixture 写进 mock evolution（queryFailures 返回整表）+ mock memory（空）
function makeMockCtx(failures) {
  const services = {};
  return {
    services,
    ctx: {
      storageDomain: {
        open: async () => ({
          table: () => ({ entries: () => [], put: async () => undefined }),
          close: async () => undefined,
        }),
      },
      get: (name) => {
        if (name === 'agint.evolution') {
          return { queryFailures: async () => failures };
        }
        if (name === 'agint.memory') {
          // 空 memory → use-prev-prompt 走 fallback 路径
          return { search: async () => [] };
        }
        return null;
      },
      provide(name, fn) { services[name] = fn; },
      effect() { return () => undefined; },
    },
  };
}

// ── 构造 10 条种子失败（保 cold-start 守门过） ────────────────────────────

const seedFailures = Array.from({ length: 10 }, (_, i) => ({
  id: `seed-${i}`,
  pattern: `seed pattern ${i}`,
  evidence: '',
  severity: 'medium',
  category: 'other',
  occurrences: 1,
}));

// ── 主循环：每条 fixture 跑 counterfactual ────────────────────────────────

const rows = [];
let hits = 0;

console.log(`\n[agint-diagnosis counterfactual stress] ${fixtures.length} fixtures\n`);
console.log(`${'fixture'.padEnd(38)} ${'strategy'.padEnd(20)} ${'successRate'.padStart(11)}  wouldSucceed`);
console.log('─'.repeat(85));

for (const fix of fixtures) {
  const allFailures = [
    ...seedFailures,
    {
      id: fix.id,
      pattern: fix.failurePattern,
      evidence: fix.evidence,
      severity: fix.severity,
      category: fix.category,
      occurrences: fix.occurrences ?? 1,
    },
  ];
  const { ctx, services } = makeMockCtx(allFailures);
  pluginMod.apply(ctx);
  const cf = services['agint.diagnosis.counterfactual'];
  if (typeof cf !== 'function') {
    console.error(`[FAIL] counterfactual service 未注册`);
    process.exit(1);
  }

  let successRate = 0;
  let errorMsg = '';
  try {
    const r = await cf({
      failureId: fix.id,
      modifiedStrategy: fix._strategy,
      trajectory: fix.trajectory,
    });
    successRate = r.successRate;
  } catch (err) {
    errorMsg = (err && err.message) ? err.message : String(err);
  }

  const wouldSucceed = successRate > 0; // 含 0.3 兜底
  if (wouldSucceed) hits += 1;
  const status = errorMsg ? `ERR ${errorMsg.slice(0, 30)}` : successRate.toFixed(3);
  console.log(`${fix.id.padEnd(38)} ${fix._strategy.padEnd(20)} ${status.padStart(11)}  ${wouldSucceed ? '✓' : '✗'}`);
  rows.push({ fixture: fix.id, strategy: fix._strategy, successRate, wouldSucceed, errorMsg });
}

const successRatePct = hits / fixtures.length;
console.log('─'.repeat(85));
console.log(`\n[summary] wouldSucceed: ${hits}/${fixtures.length} = ${(successRatePct * 100).toFixed(1)}%`);
console.log(`  软门槛（首次发布）≥${(SOFT_THRESHOLD * 100).toFixed(0)}%：${successRatePct >= SOFT_THRESHOLD ? '✓ PASS' : '✗ FAIL'}`);
console.log(`  路线图目标     ≥${(ROADMAP_TARGET * 100).toFixed(0)}%：${successRatePct >= ROADMAP_TARGET ? '✓ PASS' : '✗ FAIL (诚实目标，按设计稿标注未达标)'}`);

process.exit(successRatePct >= SOFT_THRESHOLD ? 0 : 1);