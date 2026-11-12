// 测试辅助：内存版 storage domain + mock ctx + self-model 快照构造。
// 不挂 Cordis、不碰真实 ~/.dsh。

export function fakeTable() {
  const m = new Map();
  return {
    put: async (k, v) => { if (v === undefined) m.delete(k); else m.set(k, v); },
    entries: () => [...m.entries()],
    // 宿主表 API 的真实形状（@deepseek-ai/dsh-storage-domain/lib/types/domain.d.ts:70,86）：
    // 只有 delete(key)/deleteMany(keys)，**没有 del**。mock 必须与真实一致 ——
    // 否则「调用了宿主没有的 del」在测试里永远是绿的（2026-11-12 假上限的成因之一）。
    delete: async (k) => m.delete(k),
    deleteMany: async (keys) => { let n = 0; for (const k of keys) if (m.delete(k)) n += 1; return n; },
    get size() { return m.size; },
    _map: m,
  };
}

export function fakeDomain() {
  const tables = new Map();
  return {
    close: async () => {},
    table: (name) => {
      if (!tables.has(name)) tables.set(name, fakeTable());
      return tables.get(name);
    },
  };
}

export function mockCtx(services = {}) {
  const provided = {};
  const effects = [];
  return {
    storageDomain: { open: async () => fakeDomain() },
    get: (key) => services[key] ?? null,
    provide: (key, val) => { provided[key] = val; },
    effect: (fn) => effects.push(fn),
    _provided: provided,
    _effects: effects,
  };
}

/** 构造 self-model snapshot 的最小样本（capabilities + calibrationSummary） */
export function makeSnapshot(capabilities = [], calibrationSummary = {}) {
  return {
    capabilities,
    reasoningProfile: [],
    resourceBaseline: [],
    calibrationSummary: {
      domains: calibrationSummary.domains ?? 0,
      maxError: calibrationSummary.maxError ?? 0,
      miscalibrated: calibrationSummary.miscalibrated ?? [],
    },
  };
}

/** 构造一条能力条目（CapabilityEntrySchema 兼容） */
export function makeCapability(domain, status, { lastVerifiedAt, updatedAt } = {}) {
  return {
    domain,
    capability: domain,
    status,
    confidence: 0.5,
    evidenceRefs: [],
    lastVerifiedAt: lastVerifiedAt ?? '2026-09-07T00:00:00.000Z',
    updatedAt: updatedAt ?? '2026-09-07T00:00:00.000Z',
  };
}
