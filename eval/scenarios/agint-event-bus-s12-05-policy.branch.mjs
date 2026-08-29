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

const AGINT_ROOT = '/home/anmul/projects/AGINT';

export async function policyDeployedRolledbackShadowBranch(input, ctx) {
  try {
    const busMod = await import(`${AGINT_ROOT}/plugins/agint-event-bus/lib/bus.js`);
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
  const eventBusMod = await import(`${AGINT_ROOT}/plugins/agint-event-bus/lib/index.js`);
  eventBusMod.apply(ctx, {});

  // ── 4. real quality-policy (registers decide with publish on AUTO_DEPLOY / REJECT+rollback) ──
  const policyMod = await import(`${AGINT_ROOT}/plugins/agint-quality/agint-quality-policy/lib/index.js`);
  policyMod.apply(ctx, {});

  // ── 5. real quality-report (subscribes policy.deployed / policy.rolledback) ──
  const reportMod = await import(`${AGINT_ROOT}/plugins/agint-quality/agint-quality-report/lib/index.js`);
  reportMod.apply(ctx, {});
  await new Promise((r) => setTimeout(r, 10));

  // ── 6. real metrics (subscribes → writes agint_metrics counter) ──
  const metricsMod = await import(`${AGINT_ROOT}/plugins/agint-metrics/lib/index.js`);
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

  // ── 7b. probe umbrella key (must NOT be used) ──
  // umbrellaKeyCalled: if anyone (mutator / population / future) calls ctx.get('agint.eventBus').publish,
  // it would be undefined — we track by checking the bus's own provide registered services
  const umbrella = ctx.get('agint.eventBus');
  const umbrellaKeyCalled = !!(umbrella && typeof umbrella.publish === 'function');

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
    publishDoesNotUseUmbrellaKey: !umbrellaKeyCalled,
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
      umbrellaKeyCalled,
      sources: policyDeployedEnvelopes.map((e) => e?.source).concat(policyRolledbackEnvelopes.map((e) => e?.source)),
    }),
  };
}