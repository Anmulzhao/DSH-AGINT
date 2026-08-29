// eval/scenarios/mocks/agint-mount-ctx.mjs — Sprint 12 B7 mount ctx 工厂
// driver.js 调用 mountCtxFor({ input }) → { ctx, mocks }
export function makeMountCtx({ upstream = {}, realCheckPlugin = null } = {}) {
  // 1. qualityStatic（优先级：upstream.staticCheck → realCheckPlugin → fallback 全 true）
  const staticCalls = { count: 0 };
  const staticMock = {
    check: async (fixture) => {
      staticCalls.count++;
      if (upstream.staticCheck) return upstream.staticCheck;
      if (realCheckPlugin) { const real = await realCheckPlugin(fixture); if (real) return real; }
      return { ok: true, contractCheck: { signatureDiff: true, domainIsolation: true, dependencyWhitelist: true } };
    },
  };

  // 2. qualitySandbox
  const sandboxCalls = { count: 0, lastTarget: null };
  const sandboxMock = {
    backendHealth: async () => upstream.sandboxHealth ?? {
      ctxSandboxAvailable: true, inProcessFallbackEnabled: true, timeoutMs: 30000, memoryMb: 512,
    },
    runSmoke: async ({ target }) => {
      sandboxCalls.count++;
      sandboxCalls.lastTarget = target;
      return upstream.sandboxSmoke ?? { ok: true, mode: 'in-process', checks: [{ name: 'service-resolves', ok: true }] };
    },
  };

  // 3. population
  const populationCalls = { count: 0, lastOrigin: null };
  const populationMock = {
    register: async (artifact) => {
      populationCalls.count++;
      populationMock._registeredArtifacts.push(artifact);
      populationMock.lastOrigin = artifact?.origin ?? null;
      return { ok: true, individualId: `ind-${populationCalls.count}` };
    },
    _registeredArtifacts: [],
  };

  // 4. evolution（failures 累加 occurrences）
  const evoStore = { evolution_log: new Map(), failure_pattern: new Map(), success_template: new Map() };
  const evolutionMock = {
    logPhase4: async (e) => { evoStore.evolution_log.set(e.targetId + ':' + e.decision, e); return { ok: true }; },
    logPhase4Buffered: async (e) => { evoStore.evolution_log.set(e.targetId + ':' + e.decision, e); return { ok: true, queued: true }; },  // Sprint 12 A1：与真 plugin 对齐
    addFailure: async (e) => {
      const existing = evoStore.failure_pattern.get(e.pattern);
      if (existing) existing.occurrences = (existing.occurrences ?? 1) + 1;
      else evoStore.failure_pattern.set(e.pattern, { ...e, occurrences: 1 });
      return { ok: true };
    },
  };

  // 5. wiki + evolveReview（共享 wikiReceipts）
  const wikiReceipts = [];
  const wikiMock = { write: async (entry) => { wikiReceipts.push(entry); return { slug: entry.path }; } };
  const evolveReviewMock = {
    report: async (entry) => {
      const path = 'reviews/' + (entry.id ?? 'mount') + '.md';
      wikiReceipts.push({ path, content: JSON.stringify(entry) });
      return { ok: true, path };
    },
  };

  // 6. healthProbe（前 N 次强制失败）
  const probeCalls = { count: 0, results: [] };
  const healthProbeMock = {
    probe: async (pluginId) => {
      probeCalls.count++;
      const ok = probeCalls.count > (upstream.healthProbeFailures ?? 0);
      const r = { pluginId, ok, at: new Date().toISOString(), latencyMs: 12 };
      probeCalls.results.push(r);
      return r;
    },
  };

  // 7. baselineGate（Sprint 12 B3：接 agint.evolve.baselineGate 真 service）
  // - 真 service 通道：默认开启；mock 通道（baselineMock / baselineFrozen）可选保留
  //   给 test 不依赖 cron 的场景（self-test 与旧 dispatch 仍走 mock）
  // - driver.js mount dispatcher 已切到 ctx.get('agint.evolve').baselineGate('mount')
  // - 这里只把 mock 注入 'agint.baselineSuite'（保留兼容），不再依赖 baselineFrozen 闭包
  const baselineFrozen = upstream.baselineFrozen ?? false; // 兼容旧 fixture
  const baselineMock = {
    run: async () => {
      const r = upstream.baselineResult ?? { passRate: 1.0, passed: 10, total: 10, frozen: false };
      if (r.passRate < 0.95) { r.frozen = true; }
      return r;
    },
    isFrozen: () => baselineFrozen,
  };

  // 7b. agint.evolve mock（baselineGate 通道）——
  //     driver dispatcher 调 ctx.get('agint.evolve').baselineGate('mount') 时使用。
  //     默认行为：upstream.baselineGateResult ?? { frozen:baselineFrozen, lastRunAt:..., source:'mock' }
  //     这样 happy-path（frozen=false）与 baseline-regression-fails-rollback-and-freeze
  //     （frozen=true）都能在 driver mock ctx 下断言通过。
  const evolveMock = {
    baselineGate: async (channel = 'mount') => {
      if (upstream.baselineGateResult) return upstream.baselineGateResult;
      return {
        frozen: baselineFrozen,
        lastRunAt: upstream.baselineGateLastRunAt ?? new Date().toISOString(),
        since: null,
        source: 'mock:mount-ctx',
        channel,
      };
    },
    recordBaselineRun: async (input) => ({
      id: 'mock-' + Date.now(),
      channel: input?.channel ?? 'mount',
      passRate: input?.passRate ?? 1.0,
      passed: input?.passed ?? 0,
      total: input?.total ?? 0,
      frozen: (input?.passRate ?? 1.0) < 0.95,
      source: input?.source ?? 'mock:mount-ctx',
      ranAt: new Date().toISOString(),
    }),
    listBaselineHistory: async () => [],
  };

  // 8. mountFs（staging 状态追踪）
  const stagingState = { prepared: [], cleaned: [] };
  const fsMock = {
    prepare: async (fixture) => {
      const id = 'stg-' + stagingState.prepared.length;
      stagingState.prepared.push({ id, fixture });
      return { stagingId: id };
    },
    activate: async (stagingId) => ({ ok: true, stagingId }),
    cleanup: async (stagingId) => { stagingState.cleaned.push(stagingId); return { ok: true }; },
  };

  // 8b. eventBus（Sprint 12 A1 T1 影子期）────────────────
  // 默认 absent：publish/subscribe 都是 null → upstream 不注入时 = 软降级
  //   真实 agint-population.publishProposed 走 ctx.get('agint.eventBus') → null
  //   → { published: false, reason: 'eventBus-unavailable', directPathUnaffected: true }
  // 显式注入：upstream.eventBus = 'available' / 'mock-with-publish-tracking'
  //   → 拿到完整 mock，dispatcher 与 scenario 可断言 published/deadLettered/subscribers
  const eventBusCalls = { published: 0, deadLettered: 0, subscribers: new Map(), envelopes: [] };
  const eventBusMock = {
    publish: async (input) => {
      const env = (input && typeof input === 'object' && input.topic)
        ? input
        : (input?.envelope ?? {});
      eventBusCalls.published++;
      eventBusCalls.envelopes.push(env);
      const subs = eventBusCalls.subscribers.get(env.topic) ?? [];
      let delivered = 0;
      for (const [, handler] of subs) {
        try { Promise.resolve(handler(env)).catch(() => {}); delivered++; } catch { /* ignore */ }
      }
      return {
        accepted: true,
        envelopeId: env.id ?? ('env-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)),
        traceId: env.traceId ?? ('tr-' + Date.now()),
        deliveredTo: delivered,
        deadLettered: 0,
      };
    },
    subscribe: (sub, handler) => {
      const sub0 = sub ?? {};
      const subscriber = sub0.subscriber ?? 'anonymous';
      const topics = Array.isArray(sub0.topics) ? sub0.topics : (sub0.topic ? [sub0.topic] : []);
      for (const t of topics) {
        const arr = eventBusCalls.subscribers.get(t) ?? [];
        arr.push([subscriber, handler]);
        eventBusCalls.subscribers.set(t, arr);
      }
      return () => {
        for (const t of topics) {
          const arr = eventBusCalls.subscribers.get(t) ?? [];
          eventBusCalls.subscribers.set(t, arr.filter(([s]) => s !== subscriber));
        }
      };
    },
    inspect: async () => eventBusCalls.envelopes.slice(),
    _mock: true,
    _calls: eventBusCalls,
  };

  const eventBusProvider = (upstream.eventBus === 'available' || upstream.eventBus === 'mock-with-publish-tracking')
    ? eventBusMock
    : { publish: null, subscribe: null, inspect: null, _absent: true };

  // 提供 ctx（独立轻量实现，避免与 driver.js 主 makeMockCtx 耦合）
  const provides = new Map([
    ['agint.qualityStatic', staticMock], ['agint.qualitySandbox', sandboxMock],
    ['agint.population', populationMock], ['agint.evolution', evolutionMock],
    ['agint.wiki', wikiMock], ['agint.evolveReview', evolveReviewMock],
    ['agint.healthProbe', healthProbeMock], ['agint.baselineSuite', baselineMock],
    ['agint.evolve', evolveMock], // Sprint 12 B3: baselineGate 通道
    ['agint.mountFs', fsMock], ['agint.eventBus', eventBusProvider],
  ]);
  const ctx = {
    effect() {},
    provide(k, v) { provides.set(k, v); },
    get(k) { return provides.get(k) ?? null; },
    on() {},
    setInterval() { return { dispose() {} }; },
  };

  const mocks = {
    staticCalls, sandboxCalls, populationCalls, populationMock,
    evoStore, wikiReceipts, evolveReviewMock,
    probeCalls, healthProbeMock,
    baselineFrozen, // Sprint 12 B3: 兼容旧 fixture（值类型，非闭包）
    stagingState, fsMock,
    eventBusCalls, eventBusMock,
  };
  return { ctx, mocks };
}

/** driver.js 直调入口 */
export function mountCtxFor({ input, override = {} } = {}) {
  const upstream = { ...(input?.upstream ?? {}), ...override };
  return makeMountCtx({ upstream, realCheckPlugin: override.realCheckPlugin ?? null });
}

// ── 工厂自检（仅本文件作为 main 运行时触发）──────────────────
async function happyPathSelfTest() {
  const { ctx } = makeMountCtx({});
  const keys = ['agint.qualityStatic','agint.qualitySandbox','agint.population',
    'agint.evolution','agint.wiki','agint.evolveReview',
    'agint.healthProbe','agint.baselineSuite','agint.evolve','agint.mountFs'];
  for (const k of keys) if (ctx.get(k) === null) throw new Error(`missing: ${k}`);
  const a = makeMountCtx({ upstream: { staticCheck: { ok: false, reason: 'inj' } } });
  if ((await a.ctx.get('agint.qualityStatic').check({})).reason !== 'inj') throw new Error('staticCheck inject');
  const a2 = makeMountCtx({ realCheckPlugin: async () => ({ ok: true, contractCheck: { signatureDiff: false, domainIsolation: true, dependencyWhitelist: true } }) });
  if ((await a2.ctx.get('agint.qualityStatic').check({})).contractCheck.signatureDiff !== false) throw new Error('realCheckPlugin hook');
  await a.ctx.get('agint.population').register({ origin: 'synthesized', proposalId: 'p' });
  if (a.mocks.populationMock.lastOrigin !== 'synthesized') throw new Error('origin');
  const b = makeMountCtx({ upstream: { healthProbeFailures: 1 } });
  await b.ctx.get('agint.healthProbe').probe('p'); await b.ctx.get('agint.healthProbe').probe('p');
  if (b.mocks.probeCalls.count !== 2) throw new Error('probe count');
  // Sprint 12 B3: baselineGate 通道断言（替代旧 baselineMock 闭包）
  const c1 = makeMountCtx({ upstream: { baselineGateResult: { frozen: true, lastRunAt: '2026-01-01', since: null, source: 'test' } } });
  const gate = await c1.ctx.get('agint.evolve').baselineGate('mount');
  if (gate.frozen !== true) throw new Error('baselineGate frozen=true');
  // 旧 baselineMock.run 仍可触发 frozen=true 但不写闭包（兼容）
  const c2 = makeMountCtx({ upstream: { baselineResult: { passRate: 0.5, passed: 5, total: 10 } } });
  const r = await c2.ctx.get('agint.baselineSuite').run();
  if (r.frozen !== true) throw new Error('baselineMock.run frozen=true');
  const d = makeMountCtx({});
  const { stagingId } = await d.ctx.get('agint.mountFs').prepare({ id: 'f' });
  await d.ctx.get('agint.mountFs').cleanup(stagingId);
  if (d.mocks.stagingState.prepared.length !== 1 || d.mocks.stagingState.cleaned.length !== 1) throw new Error('staging');
  const e = makeMountCtx({});
  await e.ctx.get('agint.evolution').addFailure({ pattern: 'p1', category: 'c' });
  await e.ctx.get('agint.evolution').addFailure({ pattern: 'p1', category: 'c' });
  if ([...e.mocks.evoStore.failure_pattern.values()][0].occurrences !== 2) throw new Error('occurrences');
  const f = makeMountCtx({});
  await f.ctx.get('agint.evolveReview').report({ id: 'm1' });
  if (f.mocks.wikiReceipts.length !== 1) throw new Error('wikiReceipts');
  console.log('[agint-mount-ctx] self-test PASS (10 services + 7 closures)');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  happyPathSelfTest().then(
    () => process.exit(0),
    (err) => { console.error('[agint-mount-ctx] self-test FAIL:', err.message); process.exit(1); }
  );
}
