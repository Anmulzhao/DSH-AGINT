/**
 * Sprint 12 / A5 — policy.deployed / policy.rolledback shadow dispatcher.
 *
 * Loaded by driver.js when scenario_kind === 'event-bus-policy-deployed-rolledback-shadow'.
 *
 * Topology:
 *   1. reset bus module state (avoid s12-01..04,06 residual)
 *   2. mock upstream services (evo / memory / quality / metrics / toolStats / rules / storageDomain)
 *   3. real event-bus apply(ctx)
 *   4. real agint-quality-policy apply(ctx) — registers decide() that publishes on AUTO_DEPLOY / REJECT+rollback
 *   5. real agint-quality-report apply(ctx) — subscribes policy.deployed / policy.rolledback → console + memory audit
 *   6. real agint-metrics apply(ctx) — subscribes → writes agint_metrics counter
 *   7. pre-seed committeeStorage prodSnapshots so pickRollbackTarget has a target
 *   8. call policy.decide(autoDeployTarget) — expect 1 policy.deployed envelope + report audit + metrics counter
 *   9. call policy.decide(rejectTarget) 5 times to satisfy committee.shouldRollback(minSample=5, triggerPct=0.5) —
 *      expect ≥1 policy.rolledback envelope with rollbackTarget field (not null)
 *
 * Returns { ok, detail } with full diagnostics.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

// Derive repo root from this file's own location instead of hardcoding the
// original dev machine's path (that broke every other environment).
const AGINT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export async function policyDeployedRolledbackShadowBranch(input, ctx) {
  try {
    const busMod = await import(`${pathToFileURL(AGINT_ROOT).href}/plugins/agint-event-bus/lib/bus.js`);
    busMod.disposeBus();
  } catch { /* ignore */ }

  // ── 1. mock upstream services ──
  const evoStore = { evolution_log: new Map(), failure_pattern: new Map(), success_template: new Map() };
  ctx.provide('agint.evolution', {
    logPhase4: async (entry) => { evoStore.evolution_log.set(entry?.targetId ?? 'x', entry); return { ...entry }; },
    logPhase4Buffered: async (entry) => { evoStore.evolution_log.set(entry?.targetId ?? 'x', entry); return { ...entry }; },
    addFailure: async (entry) => { evoStore.failure_pattern.set(entry?.pattern ?? 'x', entry); return { ...entry }; },
    addSuccess: async (entry) => { evoStore.success_template.set(entry?.pattern ?? 'x', entry); return { ...entry }; },
    queryFailures: async () => [],
    queryTemplates: async () => [],
    getLogRange: async () => [],
    stats: async () => ({ evolution_log: evoStore.evolution_log.size, failure_pattern: evoStore.failure_pattern.size, success_template: evoStore.success_template.size }),
    logBuffered: async () => ({}),
  });
  const reportMemoryAuditLog = [];
  ctx.provide('agint.memory', {
    write: async (rec) => { reportMemoryAuditLog.push(rec); return { id: `audit-${reportMemoryAuditLog.length}`, ...rec }; },
    read: async () => null,
    search: async () => ({ items: reportMemoryAuditLog }),
  });
  ctx.provide('agint.quality', {
    getConfig: () => ({ thresholds: { autoDeploy: 90, pendingReview: 75 } }),
    setConfig: async (p) => p,
    validatePatch: () => ({ ok: true, violations: [] }),
    getLayer: () => 'L2-implementation',
  });
  ctx.provide('agint.toolStats', { failureRate: async () => ({ tool: 'm', failureRate: 0, calls: 0 }), summary: async () => ({ calls: 0, errors: 0 }) });
  ctx.provide('agint.rules', { audit: () => ({ totals: { hits: 0, denies: 0, asks: 0, advisories: 0 } }), lint: async () => [] });
  ctx.provide('agint.cron', null);
  ctx.provide('agint.wiki', null);

  // ── 2. storageDomain mock（替换 ctx.storageDomain 与 ctx.provide('agint.storageDomain')）──
  // metrics.apply 走 ctx.storageDomain.open() —— 必须替换 ctx.storageDomain 字段，
  // 不能仅 ctx.provide('agint.storageDomain')，否则 plugin 仍读旧 mock。
  const metricsCounterTable = new Map();
  const tableStub = () => ({
    get: async (id) => metricsCounterTable.get(id) ?? null,
    put: async (id, value) => { metricsCounterTable.set(id, value); },
    delete: async (id) => { metricsCounterTable.delete(id); },
    entries: () => metricsCounterTable.entries(),
    size: async () => metricsCounterTable.size,
  });
  const storageDomainMock = {
    open: async () => ({
      table: () => tableStub(),
      close: async () => {},
    }),
  };
  ctx.storageDomain = storageDomainMock;
  ctx.provide('agint.storageDomain', storageDomainMock);

  // ── 3. real event-bus ──
  const eventBusMod = await import(`${pathToFileURL(AGINT_ROOT).href}/plugins/agint-event-bus/lib/index.js`);
  eventBusMod.apply(ctx, {});

  // ── 4. real quality-policy (registers decide with publish on AUTO_DEPLOY / REJECT+rollback) ──
  const policyMod = await import(`${pathToFileURL(AGINT_ROOT).href}/plugins/agint-quality/agint-quality-policy/lib/index.js`);
  policyMod.apply(ctx, {});

  // ── 5. real quality-report (subscribes policy.deployed / policy.rolledback) ──
  const reportMod = await import(`${pathToFileURL(AGINT_ROOT).href}/plugins/agint-quality/agint-quality-report/lib/index.js`);
  reportMod.apply(ctx, {});
  await new Promise((r) => setTimeout(r, 10));

  // ── 6. real metrics (subscribes → writes agint_metrics counter) ──
  const metricsMod = await import(`${pathToFileURL(AGINT_ROOT).href}/plugins/agint-metrics/lib/index.js`);
  metricsMod.apply(ctx, {});
  await new Promise((r) => setTimeout(r, 30)); // wait for storageDomain.open to resolve + subscription attach

  const policy = ctx.get('agint.qualityPolicy');
  const subscribe = ctx.get('agint.eventBus.subscribe');
  const inspect = ctx.get('agint.eventBus.inspect');
  if (!policy || !subscribe || !inspect) {
    return { ok: false, detail: `missing services: policy=${!!policy} subscribe=${!!subscribe} inspect=${!!inspect}` };
  }

  // ── 7. pre-seed committeeStorage prodSnapshots so pickRollbackTarget has a target ──
  // access internal storage via committee service exposed by policy
  const committee = policy.committee;
  if (!committee) return { ok: false, detail: 'policy.committee not exposed' };
  committee.saveProdSnapshot({ policyId: 'prev-policy-v1', config: { thresholds: { autoDeploy: 80 } } });

  // ── 7b. 守「policy 不走伞键」：劫持单 service 接口计数，断言调用数为 0 ──
  //
  // ⛔⛔ 2026-10-04 改测法（此前测的是错的东西，导致本单元长期假 fail）。
  //
  // 旧测法：`umbrellaKeyCalled = !!(ctx.get('agint.eventBus')?.publish)`，
  // 然后断言它为 false。这测的是「**伞键存不存在 publish**」，
  // 而断言想守的是「**policy 有没有走伞键**」—— 两件事。
  //
  // 为何旧测法必然红：event-bus 后来主动补了
  // `ctx.provide('agint.eventBus', { publish, subscribe, inspect, ... })`
  // （plugins/agint-event-bus/lib/index.js:167，纯加法 —— 让 mutator/population
  // 免写回退链）。⇒ 伞键**有** publish 是当前设计的**正确行为**，
  // 旧断言却把它当缺陷 ⇒ 每跑必红。
  //
  // 新测法守同一条约定，但方式可靠：劫持 policy 会去取的那个
  // **单 service 接口** `agint.eventBus.publish`，断言 policy 全程没碰它。
  // policy 的实际写法是 `ctx.get('agint.eventBus.publish')`
  // （policyEvents.js:108，且是**每次 publish 时才 get**，不在 apply 时缓存）
  // ⇒ 在 decide 之前替换 ctx 上的该键即可完整捕获。
  //
  // ⚠️ 必须**代理转发**而不是替换成空实现：policy 仍要通过它真发布，
  // 否则 policyDeployedEnvelopes / metricsCounterRecords 等另外 11 项断言全崩。
  // 这里只加一层计数 + 标记，不改行为。
  //
  // 同时给**伞键对象**的 publish 也加计数 —— 只有两侧都数，才能真的区分
  // 「policy 走单 service 接口」与「policy 走伞键对象」：
  //   期望态：publishSvcCallCount > 0 且 umbrellaPublishCallCount === 0
  //   违规态：umbrellaPublishCallCount > 0（policy 抄近路走伞键）
  // 伞键整体替换成代理对象，保留 publish/subscribe/inspect 原行为供其他插件用。
  const realPublishSvc = ctx.get('agint.eventBus.publish');
  const realUmbrella = ctx.get('agint.eventBus');
  let publishSvcCallCount = 0;
  let umbrellaPublishCallCount = 0;
  ctx.provide('agint.eventBus.publish', async (envelope) => {
    publishSvcCallCount += 1;
    return realPublishSvc(envelope);
  });
  if (realUmbrella && typeof realUmbrella === 'object') {
    ctx.provide('agint.eventBus', {
      ...realUmbrella,
      publish: async (envelope) => {
        umbrellaPublishCallCount += 1;
        return realUmbrella.publish(envelope);
      },
    });
  }

  // ── 8. AUTO_DEPLOY path: expect 1 policy.deployed envelope ──
  const autoDeployDecision = await policy.decide({ results: [input.autoDeployTarget] });

  // ── 9. REJECT path × 5 to trigger rollback (minSample=5, triggerPct=0.5) ──
  // appendHistory 用 ts (ms precision) 作为 Map key——同 ms 多次 decide 会 overwrite。
  // 间隔 2ms 保证 5 条 history entries 都落库（A5 不改 committee.appendHistory 行为）。
  const rejectDecisions = [];
  for (let i = 0; i < 5; i++) {
    const d = await policy.decide({ results: [input.rejectTarget] });
    rejectDecisions.push(d);
    await new Promise((r) => setTimeout(r, 2));
  }

  // ── 10. wait microtask for async handlers ──
  await new Promise((r) => setTimeout(r, 100));

  const allEnvelopes = inspect({}); // all
  const policyDeployedEnvelopes = allEnvelopes.filter((e) => e?.topic === 'policy.deployed');
  const policyRolledbackEnvelopes = allEnvelopes.filter((e) => e?.topic === 'policy.rolledback');
  const metricsCounterRecords = [...metricsCounterTable.values()];

  // inspect 返回 EventLogEntry 含 payloadPreview（≤200 字符 = 完整 payload），
  // 不含 raw payload。policy.* 两个 payload 都 < 200 字符，preview 等于 payload。
  const deployedPayload0 = policyDeployedEnvelopes[0]?.payloadPreview ?? policyDeployedEnvelopes[0]?.payload ?? null;
  const rolledbackPayload0 = policyRolledbackEnvelopes[0]?.payloadPreview ?? policyRolledbackEnvelopes[0]?.payload ?? null;

  const checks = {
    policyDeployedEnvelopes: policyDeployedEnvelopes.length === 1,
    policyRolledbackEnvelopes: policyRolledbackEnvelopes.length >= 1,
    reportMemoryAuditHasPolicyDeployed: reportMemoryAuditLog.some((e) => String(e.content ?? '').includes('policy.deployed')),
    reportMemoryAuditHasPolicyRolledback: reportMemoryAuditLog.some((e) => String(e.content ?? '').includes('policy.rolledback')),
    metricsDeployedCounterRecords: metricsCounterRecords.filter((r) => r.key === 'policy.deployedCount').length >= 1,
    metricsRolledbackCounterRecords: metricsCounterRecords.filter((r) => r.key === 'policy.rolledbackCount').length >= 1,
    deployedSourceIsPolicy: policyDeployedEnvelopes.length > 0 && policyDeployedEnvelopes.every((e) => e.source === 'agint-quality-policy'),
    rolledbackSourceIsPolicy: policyRolledbackEnvelopes.length > 0 && policyRolledbackEnvelopes.every((e) => e.source === 'agint-quality-policy'),
    deployedPayloadTargetIdMatches: deployedPayload0?.targetId === input.autoDeployTarget.targetId,
    rolledbackPayloadHasRollbackTargetField: rolledbackPayload0 != null && Object.prototype.hasOwnProperty.call(rolledbackPayload0, 'rollbackTarget') === true,
    directDecideReturnPathPreserved: autoDeployDecision?.kind === 'AUTO_DEPLOY' && rejectDecisions.every((d) => d?.kind === 'REJECT'),
    // 「policy 不走伞键」的正确测法：policy 必须走**单 service 接口**
    // `agint.eventBus.publish`（policyEvents.js:108），且**不**经伞键对象发布。
    // 旧测法问的是「伞键存不存在 publish」—— 那是设计**主动提供**的纯加法能力，
    // 拿它的有无当判据 ⇒ 每跑必红（详见上方 7b 注释）。
    // ⛔ 断言不删：约定仍要守，只是换成两侧计数这个可观测的测法。
    publishDoesNotUseUmbrellaKey: publishSvcCallCount > 0 && umbrellaPublishCallCount === 0,
  };

  const ok = Object.values(checks).every(Boolean);
  return {
    ok,
    detail: JSON.stringify({
      checks,
      policyDeployedEnvelopesCount: policyDeployedEnvelopes.length,
      policyRolledbackEnvelopesCount: policyRolledbackEnvelopes.length,
      firstDeployedPayload: policyDeployedEnvelopes[0]?.payloadPreview ?? policyDeployedEnvelopes[0]?.payload ?? null,
      firstRolledbackPayload: policyRolledbackEnvelopes[0]?.payloadPreview ?? policyRolledbackEnvelopes[0]?.payload ?? null,
      autoDeployDecisionKind: autoDeployDecision?.kind,
      rejectDecisionKinds: rejectDecisions.map((d) => d?.kind),
      reportMemoryAuditCount: reportMemoryAuditLog.length,
      reportMemoryAuditSample: reportMemoryAuditLog.slice(0, 3).map((e) => e.content),
      metricsCounterRecordsCount: metricsCounterRecords.length,
      metricsCounterKeys: [...new Set(metricsCounterRecords.map((r) => r.key))],
      // 两个计数都要进 detail：红了要能一眼看出是「压根没走单 service 接口」
      // （publishSvcCallCount=0，说明 policy 换了别的发布路径）还是
      // 「抄近路走了伞键」（umbrellaPublishCallCount>0）。
      publishSvcCallCount,
      umbrellaPublishCallCount,
      sources: policyDeployedEnvelopes.map((e) => e?.source).concat(policyRolledbackEnvelopes.map((e) => e?.source)),
    }),
  };
}