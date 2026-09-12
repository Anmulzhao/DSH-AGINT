/**
 * agint-compress-guard — P3-1 记忆压缩检查点机制 v0.1.0（设计稿 v0.3，Sprint 20 实施）。
 *
 * 一句话：**压缩可以发生，上下文不许消失**（M4，fail-closed）。
 *
 * 三条通路（设计稿 §5.3 接线梯子 v0.3）：
 *   B 档（唯一主战场）：ctx.on('session/event') 过滤 compaction/start|summary|end|prune，
 *     消费 compactionId / shadowedSeqs / shadowedTokenCount 做事后精确补偿。
 *     事件已 grep 核实（dsh-session known-event-types.js + dsh-compaction-basic）。
 *   C 档（显式入口）：Service checkpoint() —— 梦境/周复盘/离线补录显式调用；
 *     p1-kind + messages 时 raw 快照委托 agint.memoryProvider.runPreCompressCheckpoint。
 *   P1-1 提取（Q6 单一入口）：InsightProvider(apiVersion=2) 注册进 P1-1 registry，
 *     不自动激活（shadow 观察档；激活 = 老板拍板后 active_provider → 'compress-guard'）。
 *   （A 档已从设计移出——Hermes 证明不碰压缩引擎也能达成 M4，§〇ter 第 8 条。）
 *
 * 恢复双通道（Q4）：compress_recall 工具（§6.1）+ 记忆查询 miss 兜底一次
 * （§6.2，装饰 agint.memory.search，单次、单向、不回写记忆库）。
 *
 * 诚实边界（v0.1.0 标定期）：
 *   - 2026-09-13 R10 探针实测本机 155 会话 / 140,109 事件中 **0 次 compaction**——
 *     双源零流量时 stats() 返回 NO_SOURCE_REACHED 显式报警（不变量 6），不假装在工作。
 *   - `memory.pre-compress-checkpoint` 载荷不含 checkpointId（§5.1 缺口），
 *     已按设计稿授权对 P1-1 做最小 PR 补齐（< 5 行）；PR 生效前 P1-1 路径
 *     洞察以 linkPending 落库，search 默认不可见，stats 报 pendingInsights。
 *
 * Loader row（cordis.patch.yml，由老板走 safe-update 挂载）：
 *   - insert:
 *       - id: agint-compress-guard
 *         name: ./plugins/agint-compress-guard/lib/index.js
 *         config: {}
 */

import { ConfigSchema } from './schema.js';
import {
  PLUGIN_NAME,
  spec,
  packCounters,
  packConfig,
  emptyCounters,
  checkLimit,
  pruneOldest,
} from './storage.js';
import { GuardEngine } from './engine.js';
import { createInsightProvider } from './provider-bridge.js';
import { mapToMemoryType } from './extractors.js';
import {
  TOPICS_SUBSCRIBED,
  SESSION_COMPACTION_EVENTS,
  FALLBACK_LRU_SIZE,
} from './schema.js';

const name = PLUGIN_NAME;

// 硬依赖：自己的域 + agint.memory（provider 委托目标 + 兜底注入点）。
// event-bus / memory-provider 是软依赖（ctx.get 探测，缺失降级不炸）。
const inject = ['storageDomain', 'agint.memory'];

function apply(ctx, config) {
  const cfg = ConfigSchema.parse(config ?? {});
  let domain = null;
  let domainError = null;
  let disposed = false;
  const runtimeOverrides = new Map();

  // lifecycle：disposer 关自己的域（AGENTS.md 挂载红线）
  ctx.effect(() => () => {
    disposed = true;
    for (const d of disposers) {
      try { d(); } catch { /* ignore */ }
    }
    if (domain) return domain.close();
    return undefined;
  });

  /** dispose 队列：B 档监听 / 兜底装饰还原 / event-bus 退订 */
  const disposers = [];

  const ready = ctx.storageDomain.open(spec).then(
    (d) => {
      if (disposed) { void d.close().catch(() => {}); return null; }
      domain = d;
      return d;
    },
    (error) => { domainError = error; return null; },
  );

  const table = async (tableName) => {
    if (disposed) throw new Error(`${name}: disposed`);
    if (domainError) throw domainError;
    const d = await ready;
    if (!d) throw new Error(`${name}: domain unavailable`);
    return d.table(tableName);
  };

  const effectiveConfig = () => {
    const merged = { ...cfg };
    for (const [k, v] of runtimeOverrides) merged[k] = v;
    // config 表的持久化覆盖（setEnabled 等）优先于 manifest/runtime
    if (persistedConfig) Object.assign(merged, persistedConfig);
    if (merged.enabled === false && persistedConfig?.enabled === undefined) merged.enabled = false;
    return merged;
  };

  const debug = (msg) => {
    if (effectiveConfig().debug_mode) console.log(`[${name}] ${msg}`);
  };

  // ── 事件总线（软依赖，缺失降级为仅计数）────────────────────────────────
  async function publishEvent(topic, payload) {
    const p = typeof ctx.get === 'function' ? ctx.get('agint.eventBus.publish') : null;
    if (typeof p !== 'function') return false;
    try {
      await p({ topic, version: 1, source: name, payload });
      return true;
    } catch (e) {
      if (!disposed) console.error(`[${name}] publish ${topic} failed:`, e?.message ?? e);
      return false;
    }
  }

  /** config 表持久化覆盖（setEnabled 落库；进程内缓存避免每次读表） */
  let persistedConfig = null;
  async function loadPersistedConfig() {
    try {
      const t = await table('config');
      const rec = t.get('config');
      if (rec) {
        persistedConfig = {
          enabled: rec.enabled,
          shadowMode: rec.shadowMode,
          llmExtractEnabled: rec.llmExtractEnabled,
          maxInsightsPerCompress: rec.maxInsightsPerCompress,
          fallbackEnabled: rec.fallbackEnabled,
        };
      }
    } catch { /* 域未就绪 / 不可用 → 用 manifest 默认 */ }
  }

  const engine = new GuardEngine({
    table,
    config: effectiveConfig,
    memoryProvider: typeof ctx.get === 'function' ? ctx.get('agint.memoryProvider') : null,
    publish: publishEvent,
    debug,
  });

  // ── Service 出口（FROZEN 6 + 非 FROZEN 2，§4.1/§4.2）────────────────────

  async function checkpoint(input) {
    return engine.checkpoint(input ?? {});
  }
  async function extract(input) {
    return engine.extract(input ?? {});
  }
  async function search(opts) {
    return engine.search(opts ?? {});
  }
  async function recall(opts) {
    return engine.recall(opts ?? {});
  }
  async function stats() {
    return engine.stats();
  }
  async function setEnabled(enabled) {
    const r = await engine.setEnabled(enabled);
    await loadPersistedConfig();
    return r;
  }
  async function setLlmExtract(enabled) {
    const r = await engine.setLlmExtract(enabled);
    await loadPersistedConfig();
    return r;
  }
  async function reindex(offset) {
    return engine.reindex(offset);
  }

  /** 运行时配置读 + 有限 patch（内存态，对齐 P1-1 configApi 风格） */
  const configApi = (patch) => {
    if (patch == null) return { ...effectiveConfig(), overrides: Object.fromEntries(runtimeOverrides) };
    const allowed = new Set(['shadowMode', 'fallbackEnabled', 'extractTimeoutMs', 'recoveryProbeMs', 'debug_mode']);
    const rejected = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!allowed.has(k) || v === undefined) { rejected.push(k); continue; }
      runtimeOverrides.set(k, v);
    }
    return { ...effectiveConfig(), overrides: Object.fromEntries(runtimeOverrides), rejected };
  };

  ctx.provide('agint.compressGuard', {
    // FROZEN 6（§4.1）
    checkpoint, extract, search, recall, stats, setEnabled,
    // 非 FROZEN 2（§4.2）
    setLlmExtract, reindex,
    // 辅助
    config: configApi,
  });

  // ── 挂载后异步初始化（不阻塞 cordis fiber）──────────────────────────────

  void ready.then(async () => {
    if (disposed) return;
    await loadPersistedConfig();
    await initCounters();
    wireBuiltinTier();          // B 档：宿主会话压缩事件
    wireEventBusSubscriptions(); // P1-1 路径审计 + pending 回填
    wireProviderBridge();        // Q6：apiVersion=2 provider 注册（不激活）
    wireFallback();              // §6.2：记忆查询 miss 兜底（默认开）
  }).catch((e) => {
    console.error(`[${name}] init failed:`, e?.message ?? e);
  });

  async function initCounters() {
    const t = await table('counters');
    if (!t.get('counters')) {
      const entry = packCounters(emptyCounters(), null);
      await t.put(entry.id, entry);
    }
    const c = await table('config');
    if (!c.get('config')) {
      const entry = packConfig({
        enabled: cfg.enabled,
        shadowMode: cfg.shadowMode,
        llmExtractEnabled: cfg.llmExtractEnabled,
        maxInsightsPerCompress: cfg.maxInsightsPerCompress,
        fallbackEnabled: cfg.fallbackEnabled,
      }, null);
      await c.put(entry.id, entry);
    }
  }

  // ── B 档：session/event 过滤 compaction/*（唯一主战场）──────────────────

  function wireBuiltinTier() {
    if (typeof ctx.on !== 'function') {
      console.warn(`[${name}] ctx.on 不可用，B 档未接线（C 档仍可用）`);
      return;
    }
    let off;
    try {
      off = ctx.on('session/event', (session, event) => {
        try {
          handleSessionEvent(session, event);
        } catch (e) {
          // fail-open：宿主事件流里绝不抛（不变量 3 的镜像）
          debug(`[b-tier] handler error: ${e?.message ?? e}`);
        }
      });
    } catch (e) {
      console.error(`[${name}] ctx.on(session/event) 失败: ${e?.message ?? e}`);
      return;
    }
    if (typeof off === 'function') disposers.push(off);
  }

  /** B 档事件处理（同步、只做脏标记/计数/编排触发，不做重活，§5.1 设计原则） */
  function handleSessionEvent(session, event) {
    const type = String(event?.type ?? '');
    if (!SESSION_COMPACTION_EVENTS.includes(type)) return;
    const sessionId = session?.id ?? session?.sessionId ?? null;

    if (type === 'compaction/start') {
      // 仅置脏标记（§5.1）；end.error 非空 → 等价 BLOCKED 告警在 end 分支处理
      return;
    }
    if (type === 'compaction/prune') {
      void bumpQuiet({ hostCompactionsSeen: 0 });
      return;
    }
    if (type === 'compaction/summary') {
      const data = event?.data ?? {};
      // B 档主力（§5.3）：compactionId / shadowedSeqs / shadowedTokenCount 全消费
      void engine.checkpoint({
        kind: 'host-compaction',
        id: data.compactionId ?? null,
        text: typeof data.summary === 'string' ? data.summary : '',
        shadowedSeqs: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : [],
        shadowedTokenCount: Number.isFinite(data.shadowedTokenCount) ? data.shadowedTokenCount : 0,
        sessionId,
      }).then((r) => {
        debug(`[b-tier] compaction/summary → ${r.status} insights=${r.insightsExtracted}`);
        void bumpQuiet({ hostCompactionsSeen: 1 });
      }).catch((e) => debug(`[b-tier] checkpoint failed: ${e?.message ?? e}`));
      return;
    }
    if (type === 'compaction/end') {
      const err = event?.data?.error;
      if (err) {
        // §5.1：end.error 非空 → 记等价 BLOCKED 告警
        void engine.publish('compress-guard.blocked', {
          checkpointRef: { kind: 'host-compaction', id: event?.data?.compactionId ?? null },
          reason: `compaction/end error: ${String(err).slice(0, 300)}`,
        }).catch(() => {});
      }
    }
  }

  /** 静默计数（B 档热路径不打扰主流程） */
  async function bumpQuiet(delta) {
    try { await engine.bumpCounters(delta); } catch { /* ignore */ }
  }

  // ── 事件总线订阅：P1-1 路径审计 + pending 回填（§5.1）────────────────────

  function wireEventBusSubscriptions() {
    const subscribe = typeof ctx.get === 'function'
      ? ctx.get('agint.eventBus.subscribe')
      : null;
    if (typeof subscribe !== 'function') {
      console.warn(`[${name}] agint.eventBus.subscribe 不可用，P1-1 路径审计降级为仅计数`);
      return;
    }

    // ① memory.pre-compress-checkpoint：计数 + guard_log 审计 + checkpointId 回填
    try {
      const off1 = subscribe(
        {
          subscriber: name,
          topics: ['memory.pre-compress-checkpoint'],
          mode: 'async',
          timeoutMs: 5000,
        },
        async (envelope) => {
          const payload = envelope?.payload ?? {};
          try {
            await engine.bumpCounters({ p1CheckpointsSeen: 1 });
            // 最小 PR（P1-1 manager.js）生效后载荷带 checkpointId/sessionId；
            // 生效前 id 为 null → 仅计数，洞察仍以 linkPending 存在。
            const checkpointId = typeof payload.checkpointId === 'string' ? payload.checkpointId : null;
            await linkPendingInsights(checkpointId, payload.sessionId ?? null);
            await engine.checkpoint({
              kind: 'p1-checkpoint',
              id: checkpointId,
              text: '',
              runRawSnapshot: false,
              sessionId: payload.sessionId ?? null,
            });
          } catch (e) {
            debug(`[p1-tier] pre-compress-checkpoint 处理失败: ${e?.message ?? e}`);
          }
        },
      );
      if (typeof off1 === 'function') disposers.push(off1);
    } catch (e) {
      console.error(`[${name}] subscribe(memory.pre-compress-checkpoint) failed:`, e?.message ?? e);
    }

    // ② memory.provider-activated：provider 切换后健康探测（§5.1）
    try {
      const off2 = subscribe(
        {
          subscriber: name,
          topics: ['memory.provider-activated'],
          mode: 'async',
          timeoutMs: 5000,
        },
        async () => {
          debug('[p1-tier] provider-activated → 健康探测：compressGuard stats 可读即健康');
          try { await engine.stats(); } catch { /* 探测失败不炸事件流 */ }
        },
      );
      if (typeof off2 === 'function') disposers.push(off2);
    } catch (e) {
      console.error(`[${name}] subscribe(memory.provider-activated) failed:`, e?.message ?? e);
    }
  }

  /** P1-1 事件回填：把 linkPending 洞察挂上 checkpointId（短窗竞态可容忍，§5.1） */
  async function linkPendingInsights(checkpointId, sessionId) {
    if (!checkpointId) return;
    const t = await table('insights');
    // 先收集再写（避免迭代中 put 的未定义行为）
    const pending = [];
    for (const [id, rec] of t.entries()) {
      if (rec.linkPending !== true || rec.supersededBy) continue;
      // 只挂最近 10 分钟内的 pending（防止旧积压误挂）
      const at = Date.parse(rec.source?.checkpointRef?.extractedAt ?? '');
      if (!Number.isFinite(at) || Date.now() - at > 10 * 60_000) continue;
      if (sessionId && rec.source?.checkpointRef?.sessionId && rec.source.checkpointRef.sessionId !== sessionId) continue;
      pending.push(id);
    }
    for (const id of pending) {
      const rec = t.get(id);
      if (!rec || rec.linkPending !== true) continue;
      await t.put(id, {
        ...rec,
        linkPending: false,
        source: {
          ...rec.source,
          checkpointRef: { ...rec.source.checkpointRef, id: checkpointId },
        },
      });
    }
  }

  // ── Q6：InsightProvider(apiVersion=2) 注册（不激活，shadow 观察档）───────

  function wireProviderBridge() {
    const memoryProvider = typeof ctx.get === 'function' ? ctx.get('agint.memoryProvider') : null;
    if (!memoryProvider || typeof memoryProvider.registerProvider !== 'function') {
      console.warn(`[${name}] agint.memoryProvider 不可用，onPreCompress 单一入口未注册（C 档/B 档不受影响）`);
      return;
    }
    try {
      const provider = createInsightProvider({
        engine,
        memory: ctx['agint.memory'],
        config: effectiveConfig,
        debug,
      });
      const r = memoryProvider.registerProvider(provider);
      if (!r.registered) {
        console.error(`[${name}] provider 注册失败: ${r.reason}`);
      } else {
        debug('[provider] 已注册进 P1-1 registry（未激活；转正 = active_provider → compress-guard）');
      }
    } catch (e) {
      console.error(`[${name}] provider-bridge 组装失败: ${e?.message ?? e}`);
    }
  }

  // ── §6.2 检索兜底：装饰 agint.memory.search（单次、单向、不回写）─────────

  function wireFallback() {
    const memory = ctx['agint.memory'];
    if (!memory || typeof memory.search !== 'function') return;
    if (effectiveConfig().fallbackEnabled === false) return;

    const original = memory.search.bind(memory);
    /** 兜底 LRU：同一 query 只兜底一次（单次不回写，切断自我污染回路） */
    const fallbackLru = new Set();
    const lruOrder = [];

    memory.search = async function patchedSearch(query, opts = {}) {
      const results = await original(query, opts);
      if (!Array.isArray(results) || results.length > 0) return results;
      if (disposed) return results;
      if (effectiveConfig().enabled === false || effectiveConfig().fallbackEnabled === false) return results;

      const q = String(query ?? '').trim().toLowerCase();
      if (!q) return results;
      if (fallbackLru.has(q)) return results;
      // 记 LRU（§6.2 单次）
      fallbackLru.add(q);
      lruOrder.push(q);
      while (lruOrder.length > FALLBACK_LRU_SIZE) {
        const old = lruOrder.shift();
        fallbackLru.delete(old);
      }

      // 追加一次洞察检索（单向：结果不回写记忆库、不再触发二级兜底）
      try {
        const insights = await engine.search({ keyword: q, limit: 3 });
        if (insights.length === 0) {
          await engine.bumpCounters({ recallMisses: 1 }).catch(() => {});
          return results;
        }
        await engine.bumpCounters({ recallHits: 1 }).catch(() => {});
        const t = await table('insights');
        const synthetic = [];
        for (const ins of insights) {
          // 价值审计（§6.3）：recallCount 进 stats
          const cur = t.get(ins.id);
          if (cur) await t.put(ins.id, { ...cur, recallCount: (cur.recallCount ?? 0) + 1, lastRecalledAt: nowIsoSafe() });
          synthetic.push({
            id: ins.id,
            type: mapToMemoryType(ins.type),
            level: 'long',
            content: `[来源：压缩洞察 ${ins.id}] ${ins.content}`,
            evidence: `compress-guard checkpointRef=${ins.source?.checkpointRef?.kind}:${ins.source?.checkpointRef?.id ?? 'pending'}`,
            source: 'compress-guard',
          });
        }
        debug(`[fallback] query miss → 注入 ${synthetic.length} 条压缩洞察（单次不回写）`);
        return [...results, ...synthetic];
      } catch (e) {
        debug(`[fallback] 兜底失败: ${e?.message ?? e}`);
        return results;
      }
    };

    disposers.push(() => {
      try { memory.search = original; } catch { /* ignore */ }
    });
  }

  function nowIsoSafe() {
    return new Date().toISOString();
  }
}

export { ConfigSchema, apply, inject, name };
