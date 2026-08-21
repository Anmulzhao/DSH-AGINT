/**
 * eval/e2e/sprint4-closed-loop.js — Sprint 4.5 端到端闭环
 *
 * 链路: cron trigger → dream sweep → memory write → metrics collect →
 *      evolve addFailure → eval evaluate → policy decide → report generate
 *
 * 跑法: node eval/e2e/sprint4-closed-loop.js
 * 不依赖 dsh 启动 (用真 plugin + mock ctx).
 *
 * 期望退出码: 全部 PASS → 0, 任一 FAIL → 1。
 */

import { makeMockCtx } from '../scenarios/driver.js';

// ── 所有 plugin imports ─────────────────────────────────────────────
import * as qualityContract from '../../plugins/agint-quality/agint-quality-contract/lib/index.js';
import * as qualityEval      from '../../plugins/agint-quality/agint-quality-eval/lib/index.js';
import * as qualityPolicy    from '../../plugins/agint-quality/agint-quality-policy/lib/index.js';
import * as qualityReport    from '../../plugins/agint-quality/agint-quality-report/lib/index.js';

// ── helper: make richer mock ctx for e2e ────────────────────────────
function makeE2ECtx() {
  const ctx = makeMockCtx();

  // memory
  const memoryStore = [];
  ctx.provide('agint.memory', {
    write: async (rec) => { const id = `m-${memoryStore.length+1}`; memoryStore.push({id, ...rec}); return {id, ...rec}; },
    search: async () => ({ items: memoryStore }),
  });

  // toolStats (字段名对齐 evaluators.js 期望: failureRate, not rate)
  ctx.provide('agint.toolStats', {
    failureRate: async () => ({ tool: 'agint-quality-report', failureRate: 0.02, calls: 200 }),
    summary: async () => ({ items: [{ tool: 'agint-quality-report', calls: 200, avgLatencyMs: 120, errors: 4 }] }),
  });

  // rules
  ctx.provide('agint.rules', {
    list: async () => ({ items: [{ id: 'r1', tool: 'agint-quality-report', action: 'deny', level: 'L3' }] }),
    audit: () => ({ totals: { hits: 0, denies: 0, asks: 0, advisories: 0 } }),
  });

  // metrics
  ctx.provide('agint.metrics', {
    summary: async () => ({ keys: ['agint-quality-policy.decision', 'agint-quality-report.generate'] }),
    collect: async () => ({ count: 2 }),
  });

  // evolution (真实)
  const evoStore = { evolution_log: new Map(), failure_pattern: new Map(), success_template: new Map() };
  ctx.provide('agint.evolution', {
    logPhase4: async (e) => { evoStore.evolution_log.set(e.id ?? `${e.targetId}-${Date.now()}`, e); return {...e}; },
    addFailure: async (e) => { evoStore.failure_pattern.set(e.id ?? `${e.pattern}`, e); return {...e}; },
    addSuccess: async (e) => { evoStore.success_template.set(e.id ?? `${e.template}`, e); return {...e}; },
    queryFailures: async () => [...evoStore.failure_pattern.values()].map((e,id)=>({id,...e})),
    queryTemplates: async () => [...evoStore.success_template.values()].map((e,id)=>({id,...e})),
    getLogRange: async () => [...evoStore.evolution_log.values()].map((e,id)=>({id,...e})),
    stats: async () => ({ evolution_log: evoStore.evolution_log.size, failure_pattern: evoStore.failure_pattern.size, success_template: evoStore.success_template.size }),
  });

  // wiki
  const wikiStore = [];
  ctx.provide('agint.wiki', {
    write: async (entry) => { const slug = `wiki-${wikiStore.length+1}`; wikiStore.push({slug, ...entry}); return {slug, ...entry}; },
  });

  // skills list (评估 enumerator)
  ctx.provide('skills', {
    list: async () => ({ items: [{ name: 'agint-smoke-skill', version: '0.0.0' }] }),
  });

  ctx._stores = { memoryStore, evoStore, wikiStore };
  return ctx;
}

// ── main pipeline ──────────────────────────────────────────────
async function runPipeline() {
  console.log('Sprint 4.5 端到端闭环: cron → dream → memory → metrics → evolve → eval → policy → report\n');
  const ctx = makeE2ECtx();
  const log = [];

  // 1. cron 模拟触发 (owner)
  log.push('1️⃣  cron trigger: 模拟周调度触发 night-dream + quality-eval-weekly');
  await new Promise((r) => setTimeout(r, 5));

  // 2. dream sweep 写入 memory (engram 推荐 → memory.promote)
  log.push('2️⃣  dream sweep: 模拟 REM 阶段评估结果 → memory.write (decision entries)');
  const memory = ctx.get('agint.memory');
  await memory.write({
    type: 'decision',
    content: '[agint.dream] sweep 2026-08-20 → 3 candidates promoted',
    evidence: 'agint-dream:rem-phase',
  });
  await memory.write({
    type: 'decision',
    content: '[agint.dream] deep-phase → 1 success template added',
    evidence: 'agint-dream:deep-phase',
  });

  // 3. metrics collect
  log.push('3️⃣  metrics collect: collect() → indicator update');
  const metrics = ctx.get('agint.metrics');
  const metricSnap = await metrics.collect();
  log.push(`    metrics.collect 返回 count=${metricSnap.count ?? 'n/a'}`);

  // 4. evolve addFailure (regression detected)
  log.push('4️⃣  evolve addFailure: baseline regression:warn → evo.addFailure');
  const evo = ctx.get('agint.evolution');
  await evo.addFailure({
    pattern: 'regression:warn',
    category: 'integration',
    severity: 'medium',
    evidence: '{"delta":-0.06,"baselineRate":0.95,"currentRate":0.89}',
  });

  // 5. eval evaluate (Phase 2 sandbox gate)
  log.push('5️⃣  eval evaluate: 装载 quality-eval plugin + evaluate(target)');
  qualityContract.apply(ctx, {});
  qualityEval.apply(ctx, {});
  await new Promise((r) => setTimeout(r, 50));
  const evaluator = ctx.get('agint.qualityEvaluator');
  if (!evaluator) throw new Error('agint.qualityEvaluator not registered');

  // sandbox mock (跳过)
  ctx.provide('agint.qualitySandbox', {
    runSmoke: async () => ({ ok: true, mode: 'in-process', checks: [] }),
    backendHealth: async () => ({ ctxSandboxAvailable: true, inProcessFallbackEnabled: true }),
  });

  const target = {
    id: 'agint-quality-report',
    kind: 'plugin',
    version: '0.4.0',
    path: '/home/anmul/projects/AGINT/plugins/agint-quality/agint-quality-report',
    tags: ['d-qaf', 'phase-4'],
  };
  const result = await evaluator.evaluate(target);
  log.push(`    evaluate(${target.id}) → dimensions=${result.dimensions.length} findings=${result.findings.length} durationMs=${result.durationMs}`);

  // 6. policy decide
  log.push('6️⃣  policy decide: 装载 quality-policy plugin + decide({results:[result]})');
  qualityPolicy.apply(ctx, {});
  await new Promise((r) => setTimeout(r, 20));
  const policy = ctx.get('agint.qualityPolicy');
  const decision = await policy.decide({ results: [result] });
  log.push(`    decide → kind=${decision.kind} score=${decision.score} reason="${decision.reason}"`);
  log.push(`    policyId=${decision.policyId} perTarget=${JSON.stringify(decision.perTarget)}`);

  // 7. 反和谐检测 (Sprint 4.2 链路)
  log.push('7️⃣  false-harmony detect: detectFalseHarmony({results:[result]})');
  const harmonyReport = await policy.detectFalseHarmony({ results: [result] });
  log.push(`    harmony → report=${harmonyReport.report} patterns=${JSON.stringify(harmonyReport.patterns)}`);

  // 8. committee append + query history (Sprint 4.3 链路)
  log.push('8️⃣  committee history: appendHistory + queryHistory');
  const committee = policy.committee;
  await committee.appendHistory({ decision, policyId: decision.policyId });
  const history = committee.queryHistory({ policyId: decision.policyId, limit: 10 });
  log.push(`    history.size=${history.length}`);

  // 9. report generate + persist (Sprint 4.4 链路)
  log.push('9️⃣  report generate: qualityReport.generate + persist to wiki + memory');
  qualityReport.apply(ctx, {});
  const reporter = ctx.get('agint.qualityReporter');
  const reportReceipt = await reporter.generateAndPersist({
    results: [result],
    decision,
    meta: { harmonyDetectorReport: harmonyReport },
  });
  log.push(`    markdown_len=${reportReceipt.markdown.length} wiki=${!!reportReceipt.wiki} memory=${!!reportReceipt.memory}`);
  log.push(`    decision in report=${reportReceipt.json.decision?.kind} summary=${JSON.stringify(reportReceipt.json.summary)}`);

  // 10. final sanity
  log.push('🔟 sanity 检查: 副作用痕迹（evo log/ failure / wiki / memory）全');
  const evoStats = await evo.stats();
  const wikiCount = ctx._stores.wikiStore.length;
  const memoryCount = ctx._stores.memoryStore.length;
  log.push(`    evo.evolution_log=${evoStats.evolution_log} evo.failure_pattern=${evoStats.failure_pattern} wiki=${wikiCount} memory=${memoryCount}`);

  // 输出
  for (const line of log) console.log(line);

  // 断言: 关键副作用存在
  const checks = [
    { name: 'contract-applied', ok: !!ctx.get('agint.quality') },
    { name: 'evaluator-applied', ok: !!evaluator },
    { name: 'evaluate-returned-result', ok: !!result && Array.isArray(result.dimensions) },
    { name: 'policy-decision-kind-valid', ok: ['AUTO_DEPLOY', 'PENDING_REVIEW', 'REJECT', 'ABSTAIN'].includes(decision.kind) },
    { name: 'history-contains-appended', ok: history.length >= 1 },
    { name: 'report-generated-markdown', ok: !!reportReceipt.markdown && reportReceipt.markdown.length > 100 },
    { name: 'report-persisted-wiki', ok: !!reportReceipt.wiki },
    { name: 'report-persisted-memory', ok: !!reportReceipt.memory },
    { name: 'evo-evolution_log-written', ok: evoStats.evolution_log > 0 },
    { name: 'evo-failure-pattern-written', ok: evoStats.failure_pattern > 0 },
  ];

  console.log('\n=== 验证 ===');
  let pass = 0;
  let fail = 0;
  for (const c of checks) {
    const status = c.ok ? '✓ PASS' : '✗ FAIL';
    console.log(`${status}  ${c.name}`);
    if (c.ok) pass++; else fail++;
  }
  console.log(`\n=== ${pass} passed, ${fail} failed (of ${checks.length}) ===`);
  process.exit(fail === 0 ? 0 : 1);
}

runPipeline().catch((err) => {
  console.error('E2E pipeline threw:', err);
  process.exit(2);
});
