// 单元测试用的 Cordis ctx mock + in-memory storage mock。
// 与 agint-diagnosis 同体例：单文件、不下沉（设计稿 §九 + Sprint 7/8 哲学对齐
// 「mock ctx 下沉」TODO 沿用）。

/**
 * 构造 in-memory storage table：Map-like — entries() 返回 [id, entry] tuples。
 * valueSchema 仅用于约束，不执行 parse（让单元测试能传不规范值以观察错误处理）。
 */
function makeTable() {
  const map = new Map();
  return {
    entries() { return map.entries(); },   // [id, entry] tuples (Map iterator)
    put(id, entry) { map.set(id, entry); },
    get(id) { return map.get(id) || null; },
    delete(id) { return map.delete(id); },
    _size() { return map.size; },
  };
}

/**
 * 构造 in-memory storage domain：open(spec) 返回带 4 张表的 handle。
 * handle.table(name) 返回一个共享的 table handle。
 */
export function makeStorageDomain(spec) {
  const tables = {};
  for (const tbl of Object.keys(spec.tables)) tables[tbl] = makeTable();
  const handle = {
    spec,
    table(name) {
      if (!tables[name]) throw new Error(`unknown table: ${name}`);
      return tables[name];
    },
    close() { return Promise.resolve(); },
  };
  return Promise.resolve(handle);
}

/**
 * 构造 ctx mock：effect / get / provide / storageDomain。
 *
 * softDeps: { 'agint.mutator': { rollback: async () => ({ ok: true, restoredHash: 'hash123' }) }, ... }
 *
 * providers: record 提供名 → 函数 — 跑完 apply 后可用 ctx._providers[svcName] 取
 */
export function makeCtx({ softDeps = {} } = {}) {
  const ctx = {
    _providers: {},
    _effects: [],
    _disposed: false,
    storageDomain: {
      open(specArg) { return makeStorageDomain(specArg); },
    },
    effect(fn) {
      const dispose = fn();
      this._effects.push(dispose);
      return () => { if (dispose) dispose(); this._disposed = true; };
    },
    get(key) { return softDeps[key] || null; },
    provide(name, fn) { this._providers[name] = fn; },
  };
  return ctx;
}

/** 测试辅助：UUID 兜底。 */
export function uuid() {
  try { return globalThis.crypto.randomUUID(); }
  catch { return `t-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }
}
