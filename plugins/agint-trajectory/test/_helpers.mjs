/**
 * agint-trajectory/test/_helpers.mjs — 测试夹具。
 *
 * 不挂 Cordis、不开真 storage domain：用内存 KV 模拟 domain 的
 * get/entries/put/delete/size 契约（对齐 @deepseek-ai/dsh-storage-domain 的
 * KvTableImpl），因此可以完整跑 Service 行为（含 fail-open 注错）。
 */

/** 内存 domain：三张表，put 可注入故障 */
export function createFakeDomain({ failPutFor = null } = {}) {
  const tables = new Map();
  const closed = { value: false };
  const stats = { puts: 0, deletes: 0 };
  return {
    stats,
    closed,
    table(tableName) {
      if (!tables.has(tableName)) tables.set(tableName, new Map());
      const m = tables.get(tableName);
      return {
        get(key) {
          return m.has(key) ? m.get(key) : null;
        },
        entries() {
          return [...m.entries()][Symbol.iterator]();
        },
        keys() {
          return [...m.keys()][Symbol.iterator]();
        },
        get size() {
          return m.size;
        },
        async put(key, value) {
          if (failPutFor && (failPutFor === true || failPutFor === tableName)) {
            stats.puts++;
            throw new Error('injected write failure');
          }
          stats.puts++;
          m.set(key, value);
        },
        async delete(key) {
          stats.deletes++;
          return m.delete(key);
        },
        async update(key, fn) {
          const cur = m.get(key);
          if (cur === undefined) throw new Error('missing-key');
          const next = fn(cur);
          m.set(key, next);
          return next;
        },
      };
    },
    async close() {
      closed.value = true;
    },
  };
}

/**
 * mock cordis ctx。
 * @param {object} opts
 * @param {object} opts.domain 内存 domain
 * @param {object} [opts.services] ctx.get(key) 的返回值
 */
export function createCtx({ domain = createFakeDomain(), services = {} } = {}) {
  const effects = [];
  const provides = {};
  const published = [];
  const subscribed = [];
  const ctx = {
    storageDomain: { open: async () => domain },
    effect(fn) {
      effects.push(fn);
    },
    provide(key, value) {
      provides[key] = value;
    },
    get(key) {
      if (key === 'agint.eventBus.publish') {
        return async (envelope) => {
          published.push(envelope);
          return { envelopeId: `env_${published.length}` };
        };
      }
      if (key === 'agint.eventBus.subscribe') {
        return (sub, handler) => {
          subscribed.push({ sub, handler });
          return () => ({ off: true });
        };
      }
      return services[key] ?? null;
    },
  };
  return { ctx, effects, provides, published, subscribed };
}

/** apply 插件并等微任务（ready.then 里的 loadState / 订阅装配完成） */
export async function mount(plugin, config = {}, ctxOpts = {}) {
  const h = createCtx(ctxOpts);
  plugin.apply(h.ctx, config);
  await flush();
  return { ...h, service: h.provides['agint.trajectory'] };
}

export async function flush(times = 3) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

/** 内存 fs（writeExport 注入用） */
export function createMemFs() {
  const files = new Map();
  return {
    files,
    async mkdir() {},
    async writeFile(path, data) {
      files.set(path, data);
    },
    async readFile(path) {
      if (!files.has(path)) throw new Error(`ENOENT ${path}`);
      return files.get(path);
    },
  };
}
