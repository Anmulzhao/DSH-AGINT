/**
 * eval/e2e/sprint12-event-bus.mjs — Sprint 12 A6/A7 事件边集成 e2e。
 *
 * 不依赖 dsh 启动（mock ctx）。跑法：node eval/e2e/sprint12-event-bus.mjs
 * 退出码: 0 全过, 1 任一 fail.
 *
 * 覆盖（T1 影子期，直连保留）：
 *   A6 diagnosis.completed：真 agint-diagnosis.report() 经真 agint-event-bus publish
 *     → 真 agint-mutator 订阅 handler 收到 → 观测计数 +1
 *   A7 metrics.snapshot：真 agint-metrics._flushSnapshotOnce() 经真 bus publish
 *     → eventBus.inspect 可见 metrics.snapshot envelope（source=agint-metrics）
 */

import { makeMockCtx } from '../scenarios/driver.js';

const AGINT_ROOT = process.cwd();

let pass = 0;
let fail = 0;
const counts = (ok) => (ok ? pass++ : fail++);

async function step(name, fn) {
  process.stdout.write(`▶ ${name}... `);
  try { await fn(); counts(true); console.log('✓'); return true; }
  catch (err) { counts(false); console.log(`✗ ${err.message}`); return false; }
}

function makeTable() {
  const maps = new Map();
  const get = (name) => {
    if (!maps.has(name)) maps.set(name, new Map());
    return maps.get(name);
  };
  const table = (name) => ({
    put: async (id, value) => { get(name).set(id, value); return true; },
    get: async (id) => get(name).get(id) ?? null,
    delete: async (id) => { get(name).delete(id); return true; },
    entries: () => get(name).entries(),
  });
  return { table, maps };
}

// ── A6: diagnosis.completed publish + mutator subscribe via real bus ──
async function runA6() {
  const ctx = makeMockCtx();
  const busMod = await import(`${AGINT_ROOT}/plugins/agint-event-bus/lib/bus.js`);
  busMod.disposeBus();

  // mock 上游（diagnosis 需 evolution；mutator 需 evolution）
  const evoStore = { evolution_log: new Map(), failure_pattern: new Map(), success_template: new Map() };
  ctx.provide('agint.evolution', {
    logPhase4: async (e) => { evoStore.evolution_log.set(e?.targetId ?? 'x', e); return e; },
    logPhase4Buffered: async (e) => { evoStore.evolution_log.set(e?.targetId ?? 'x', e); return e; },
    addFailure: async (e) => { evoStore.failure_pattern.set(e?.pattern ?? 'x', e); return e; },
    addSuccess: async (e) => { evoStore.success_template.set(e?.pattern ?? 'x', e); return e; },
    queryFailures: async () => [], queryTemplates: async () => [],
    getLogRange: async () => [], stats: async () => ({ evolution_log: evoStore.evolution_log.size }),
    logBuffered: async () => ({}),
  });
  ctx.provide('agint.wiki', { write: async () => undefined });
  ctx.provide('agint.memory', { write: async (r) => ({ id: `m-${Date.now()}`, ...r }), read: async () => null, search: async () => ({ items: [] }) });

  // 真 event-bus apply（提供 publish/subscribe/inspect 3 个 single service）
  const ebIndex = await import(`${AGINT_ROOT}/plugins/agint-event-bus/lib/index.js`);
  ebIndex.apply(ctx, {});
  await new Promise((r) => setTimeout(r, 30));

  // 真 mutator apply（订阅 diagnosis.completed）
  const mutatorMod = await import(`${AGINT_ROOT}/plugins/agint-mutator/lib/index.js`);
  mutatorMod.apply(ctx, {});
  await new Promise((r) => setTimeout(r, 30));

  // 真 diagnosis apply（report() 会 publish diagnosis.completed）
  const diagMod = await import(`${AGINT_ROOT}/plugins/agint-diagnosis/lib/index.js`);
  diagMod.apply(ctx, {});
  await new Promise((r) => setTimeout(r, 30));

  // 触发 report()（需要 annotations + aggregateReport 数据 —— 用诊断 domain 写入）
  const diagDomain = await ctx.storageDomain.open({ name: 'agint_diagnosis', version: 1 });
  const diagTable = diagDomain.table('annotations');
  const now = Date.now();
  for (const [i, rc] of ['TOOL_GAP', 'TOOL_GAP', 'PROMPT_DEFICIENCY'].entries()) {
    await diagTable.put(`a-${i}`, {
      failureId: `f-${i}`, rootCause: rc, confidence: 0.7, evidence: '...', kind: 'annotation',
      createdAt: new Date(now - (i + 1) * 86400_000).toISOString(),
    });
  }

  const report = ctx.get('agint.diagnosis.report');
  if (typeof report !== 'function') throw new Error('missing agint.diagnosis.report');
  const r = await report({ windowDays: 7 });

  // 校验 mutator 观测计数 = 1（真订阅收到 diagnosis.completed）
  const countSvc = ctx.get('agint.mutator._diagnosisCompletedObservationCount');
  const mutatorObserved = countSvc() >= 1;

  // 校验 envelope 落 inspect（topic=diagnosis.completed, source=agint-diagnosis）
  const inspectSvc = ctx.get('agint.eventBus.inspect');
  const events = inspectSvc && typeof inspectSvc === 'function' ? inspectSvc({}) : [];
  const diagEvents = (events ?? []).filter((e) => e.topic === 'diagnosis.completed');
  const envelopeOk = diagEvents.length >= 1
    && diagEvents[0].source === 'agint-diagnosis'
    && diagEvents[0].deliveries?.['agint-mutator'] === 'DELIVERED';

  counts(mutatorObserved && envelopeOk && r.windowDays === 7);
  if (!(mutatorObserved && envelopeOk)) {
    throw new Error(`A6 fail: mutatorObserved=${mutatorObserved} envelopeOk=${envelopeOk} diagEvents=${diagEvents.length}`);
  }
}

// ── A7: metrics.snapshot publish via real bus (service._flushSnapshotOnce) ──
async function runA7() {
  const ctx = makeMockCtx();
  const busMod = await import(`${AGINT_ROOT}/plugins/agint-event-bus/lib/bus.js`);
  busMod.disposeBus();

  // 上游 sources：cron/rules/wiki/memory（computeMetrics 需要）
  ctx.provide('agint.cron', { health: () => ({ healthy: true, issues: [], jobs: [] }) });
  ctx.provide('agint.rules', { audit: () => ({ rules: [], totals: { hits: 0, denies: 0, asks: 0, advisories: 0 } }), lint: async () => [] });
  ctx.provide('agint.wiki', { stats: async () => ({ brokenLinks: 0, contradictions: 0, orphans: 0 }) });
  ctx.provide('agint.memory', { stats: async () => ({ total: 0, avgConfidence: 0 }), read: async () => null, write: async (r) => ({ id: 'm', ...r }) });

  // 真 event-bus + 真 metrics
  const ebIndex = await import(`${AGINT_ROOT}/plugins/agint-event-bus/lib/index.js`);
  ebIndex.apply(ctx, {});
  await new Promise((r) => setTimeout(r, 30));

  const metricsMod = await import(`${AGINT_ROOT}/plugins/agint-metrics/lib/index.js`);
  metricsMod.apply(ctx, {});
  await new Promise((r) => setTimeout(r, 30));

  const metrics = ctx.get('agint.metrics');
  const flush = metrics?._flushSnapshotOnce;
  if (typeof flush !== 'function') throw new Error('missing agint.metrics._flushSnapshotOnce');

  // 先 collect 一次（写表，让 summary 有数据），再 flush
  await metrics.collect();
  const fr = await flush();
  if (!fr || typeof fr !== 'object') throw new Error('flush returned non-object');

  // 校验 envelope 落 inspect（topic=metrics.snapshot, source=agint-metrics）
  await new Promise((r) => setTimeout(r, 30));
  const inspectSvc = ctx.get('agint.eventBus.inspect');
  const events = inspectSvc && typeof inspectSvc === 'function' ? inspectSvc({}) : [];
  const snapEvents = (events ?? []).filter((e) => e.topic === 'metrics.snapshot');
  const envelopeOk = snapEvents.length >= 1 && snapEvents[0].source === 'agint-metrics';
  counts(envelopeOk);
  if (!envelopeOk) throw new Error(`A7 fail: snapEvents=${snapEvents.length}`);
}

async function main() {
  console.log('Sprint 12 A6/A7 event-bus e2e');
  await step('A6 diagnosis.completed publish + mutator subscribe', runA6);
  await step('A7 metrics.snapshot publish', runA7);
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
