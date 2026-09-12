/**
 * agint-compress-guard 测试共用：内存版 storage domain + mock ctx。
 * 不挂 Cordis、不开真实域（与 skill-graph / memory-provider smoke 同策略）。
 */

/**
 * 内存版表：实现 storage domain 表 API 契约。
 * ⚠️ get / entries / keys / size 是**同步**（与 dsh-storage-domain 真实契约一致，
 * P1-1 setConfig 即同步用 `t.get(key)`）；put / delete / update 是 async。
 */
export function makeTable() {
  const m = new Map();
  return {
    get(k) { return m.get(k); },
    async put(k, v) { m.set(k, v); return true; },
    async delete(k) { return m.delete(k); },
    async update(k, patch) {
      const cur = m.get(k);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      m.set(k, next);
      return next;
    },
    entries() { return [...m.entries()]; },
    keys() { return [...m.keys()]; },
    get size() { return m.size; },
  };
}

/** 内存版 domain：按表名惰性建表 */
export function makeDomain() {
  const tables = new Map();
  return {
    async table(name) {
      if (!tables.has(name)) tables.set(name, makeTable());
      return tables.get(name);
    },
    tableSync(name) {
      if (!tables.has(name)) tables.set(name, makeTable());
      return tables.get(name);
    },
    async close() { tables.clear(); },
  };
}

/**
 * mock cordis ctx：
 *   - storageDomain.open → makeDomain()
 *   - effect(fn) → 收集 disposer（dispose() 手动触发）
 *   - on(event, handler) → 记录监听（emit() 手动触发）
 *   - get(name) → 软依赖注册表（register(name, svc)）
 *   - provide(name, svc) → 服务出口捕获（services[name]）
 */
export function makeCtx({ memory, memoryProvider, eventBus } = {}) {
  const services = {};
  const softDeps = new Map();
  if (eventBus?.publish) softDeps.set('agint.eventBus.publish', eventBus.publish);
  if (eventBus?.subscribe) softDeps.set('agint.eventBus.subscribe', eventBus.subscribe);
  if (memoryProvider) softDeps.set('agint.memoryProvider', memoryProvider);

  const listeners = new Map();
  const effects = [];
  const domain = makeDomain();

  return {
    domain,
    services,
    listeners,
    effects,
    // cordis inject 语义：硬依赖服务以属性形态挂在 ctx 上
    ...(memory ? { 'agint.memory': memory } : {}),
    storageDomain: { open: async () => domain },
    provide(name, svc) { services[name] = svc; },
    effect(fn) { const d = fn(); if (typeof d === 'function') effects.push(d); },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return () => listeners.get(event)?.delete(handler);
    },
    get(name) { return softDeps.get(name); },
    /** 手动触发宿主事件（B 档测试用） */
    emit(event, ...args) {
      const set = listeners.get(event);
      if (!set) return;
      for (const h of [...set]) h(...args);
    },
    dispose() { for (const d of effects) { try { d(); } catch { /* ignore */ } } },
  };
}

/** mock 事件总线：subscribe 登记 + publish 广播（记录所有信封供断言） */
export function makeEventBus() {
  const subs = [];
  const envelopes = [];
  return {
    subs,
    envelopes,
    async publish(input) {
      envelopes.push(input);
      const topic = input.topic;
      for (const s of subs) {
        if (s.sub.topics.includes(topic)) {
          await s.handler({ topic, version: 1, source: input.source, payload: input.payload });
        }
      }
      return { ok: true };
    },
    subscribe(sub, handler) {
      subs.push({ sub, handler });
      return () => {
        const i = subs.findIndex((s) => s.handler === handler);
        if (i >= 0) subs.splice(i, 1);
      };
    },
  };
}

/** mock agint.memory（search 可注入结果；write 记录调用供「不回写」断言） */
export function makeMemory(searchImpl) {
  const writes = [];
  return {
    writes,
    async search(query, opts) { return searchImpl ? searchImpl(query, opts) : []; },
    async write(input) { writes.push(input); return { ok: true }; },
  };
}

/**
 * mock agint.memoryProvider：
 *   - registerProvider 记录注册的 provider
 *   - runPreCompressCheckpoint 行为可编程（failAt 序列 / 正常返回）
 */
export function makeMemoryProvider({ failTimes = 0 } = {}) {
  let calls = 0;
  const registered = [];
  return {
    registered,
    calls: () => calls,
    registerProvider(p) {
      registered.push(p);
      return { registered: true, name: p.name };
    },
    async runPreCompressCheckpoint(messages) {
      calls += 1;
      if (calls <= failTimes) {
        return { ok: false, abortCompress: true, status: 'failed', checkpointId: null, reason: 'injected failure' };
      }
      return {
        ok: true, abortCompress: false, status: 'success', insight: '',
        providerName: 'builtin', apiVersion: 1, durationMs: 1,
        checkpointId: `pcc_test_${String(calls).padStart(6, '0')}`,
      };
    },
  };
}
