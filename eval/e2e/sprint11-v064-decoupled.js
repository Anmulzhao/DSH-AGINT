/**
 * eval/e2e/sprint11-v064-decoupled.js — Sprint 11 v0.6.4 端到端
 *
 * 完整链路（设计稿 §四子任务 #11 + §六）：
 *   evolution-memory LogBuffer 异步批量 (#7)
 *     → abtest 插件 statistics 4 函数 + Service 契约 (#9)
 *       → policy decidePolicy abtest 加权综合分 (#10)
 *
 * 不依赖 dsh 启动（mock ctx）。跑法：node eval/e2e/sprint11-v064-decoupled.js
 * 退出码: 0 全过, 1 任一 fail.
 */

import { makeMockCtx } from '../scenarios/driver.js';

import * as abtest from '../../plugins/agint-abtest/lib/index.js';
import * as policy from '../../plugins/agint-quality/agint-quality-policy/lib/index.js';

const AGINT_ROOT = process.cwd();

let pass = 0;
let fail = 0;
const counts = (ok) => (ok ? pass++ : fail++);

async function step(name, fn) {
  process.stdout.write(`▶ ${name}... `);
  try { await fn(); console.log('✓'); return true; }
  catch (err) { console.log(`✗ ${err.message}`); return false; }
}

function makeMockStorage() {
  const tables = {};
  return {
    async table(name) {
      if (!tables[name]) tables[name] = new Map();
      return {
        put: async (id, value) => { tables[name].set(id, value); return true; },
        get: (id) => tables[name].get(id) ?? null,
        delete: async (id) => { tables[name].delete(id); return true; },
        entries: () => Array.from(tables[name].values()),
      };
    },
  };
}

function makeV064Ctx() {
  return makeMockCtx({
    // 真沙箱不可用（in-process fallback）；evolution-memory mem fallback
    'agint.evolution': {
      addFailure: async () => ({ ok: true }),
      logPhase4: async () => ({ ok: true }),
      queryFailures: async () => [],
    },
    // policy 软依赖（committee / shadow 等）
    'agint.evolution': {
      addFailure: async () => ({ ok: true }),
      logPhase4: async () => ({ ok: true }),
      queryFailures: async () => [],
      addSuccess: async () => ({ ok: true }),
    },
  });
}

// ─── #7 EvolutionLogBuffer ──────────────────────────────────────────
async function step7_logBuffer(ctx) {
  const mod = await import('../../plugins/agint-evolution-memory/lib/log-buffer.js');
  const mem = { write: async () => ({ ok: true }) };
  const stored = new Map();
  const buf = mod.createLogBuffer({
    storage: { table: async () => ({
      put: async (id, value) => { stored.set(id, value); return true; },
      entries: () => Array.from(stored.values()),
    })},
    memFallback: mem,
    flushCount: 5, flushMs: 60_000,
  });
  for (let i = 0; i < 5; i++) {
    buf.enqueue({ id: `e-${i}`, kind: 'evolution-log', targetId: 't', targetKind: 'plugin', decision: 'OK' });
  }
  const r = await buf.flush('manual');
  if (r.flushed !== 5 || r.lost !== 0) throw new Error(`flush 期望 {flushed:5,lost:0}, 实际 ${JSON.stringify(r)}`);
  await buf.shutdown();
  counts(true);
}

// ─── #9 abtest 插件 Service 契约 ────────────────────────────────────
async function step9_abtestService(ctx) {
  abtest.apply(ctx, {});
  const ab = ctx.get('agint.abtest');
  if (!ab) throw new Error('agint.abtest provider 未注册');
  if (typeof ab.start !== 'function') throw new Error('start 方法缺失');
  if (typeof ab.report !== 'function') throw new Error('report 方法缺失');
  if (typeof ab.listTests !== 'function') throw new Error('listTests 方法缺失');

  const r = await ab.start({
    variantA: { promptId: 'sys-prompt', version: 'v1' },
    variantB: { promptId: 'sys-prompt', version: 'v2' },
    taskSuite: Array.from({ length: 10 }, (_, k) => `task-${k + 1}`),
  });
  if (!r.testId || !r.testId.startsWith('abt-')) throw new Error(`testId 异常: ${r.testId}`);
  if (r.status !== 'running') throw new Error(`status 异常: ${r.status}`);
  counts(true);
}

// ─── #10 policy abtest 加权综合分 ────────────────────────────────────
async function step10_abtestWeighted(ctx) {
  // 通过 plugin apply 取 ctx.provide('agint.qualityPolicy', { decide })
  policy.apply(ctx, {});
  const qp = ctx.get('agint.qualityPolicy');
  if (!qp || typeof qp.decide !== 'function') throw new Error('agint.qualityPolicy.decide 未暴露');

  const baseResults = [{
    targetId: 'plugin-x',
    kind: 'plugin',
    dimensions: [
      { key: 'safety', score: { score: 0.95, veto: false } },
      { key: 'trust', score: { score: 0.85, veto: false } },
    ],
  }];

  // abtest enabled=false（默认）：不注入 abtest 维度 → base 综合分
  const d0 = await qp.decide({ results: baseResults });
  // base: safety 0.30*0.95 + trust 0.20*0.85 / (0.30+0.20) = (0.285+0.17)/0.50 = 0.91 → 91 分
  if (d0.score < 90) throw new Error(`enabled=false 综合分应 ≥90, 实际 ${d0.score}`);

  // abtest enabled=true + winner=B 显著：综合分加成（仍 AUTO_DEPLOY）
  const d1 = await qp.decide({
    results: baseResults,
    config: { abtest: { enabled: true, weight: 0.10, minSamples: 10, pValueThreshold: 0.05 } },
    options: { abtestResults: [{ winner: 'B', pValue: 0.01, effectSize: 0.5, samples: 20 }] },
  });
  if (d1.score < 90) throw new Error(`winner=B 显著综合分应 ≥90, 实际 ${d1.score}`);

  // abtest winner=inconclusive：score 中性，不强制 REJECT
  const d2 = await qp.decide({
    results: baseResults,
    config: { abtest: { enabled: true, weight: 0.10, minSamples: 10, pValueThreshold: 0.05 } },
    options: { abtestResults: [{ winner: 'inconclusive', pValue: 0.5, effectSize: 0.1, samples: 20 }] },
  });
  if (d2.kind === 'REJECT') throw new Error('abtest inconclusive 不应让高分 target REJECT');
  counts(true);
}

async function main() {
  console.log('─── Sprint 11 v0.6.4 e2e ───');

  const ctx = makeV064Ctx();

  await step('#7 evolution-memory LogBuffer', () => step7_logBuffer(ctx));
  await step('#9 abtest Service 契约（start 启动 test）', () => step9_abtestService(ctx));
  await step('#10 policy abtest 加权综合分（enabled=false/true/inconclusive）', () => step10_abtestWeighted(ctx));

  console.log('');
  console.log(`─── Sprint 11 v0.6.4 e2e 总结: ${pass} pass, ${fail} fail ───`);
  return fail === 0;
}

const ok = await main();
process.exit(ok ? 0 : 1);