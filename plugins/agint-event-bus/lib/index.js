/**
 * agint-event-bus v0.7.0 — Cordis 入口
 *
 * 对外 3 Service（设计稿 Sprint12 §A1-A3）：
 *   agint.eventBus.publish   (input | envelope) → PublishResult
 *   agint.eventBus.subscribe (Subscription + handler) → Unsubscribe
 *   agint.eventBus.inspect   (filter) → EventLogEntry[]
 *
 * 监听：tools/post-execute（占位，便于未来挂 event-bus 上 audit trace）
 *
 * 资源管理（AGENTS.md 红线 / PLUGIN-SPEC 维度 5）：
 *   - 订阅表 / ring buffer 在 dispose 时由 disposeBus 清空
 *   - 监听器 dispose 由 ctx.on 自动管理
 *   - 不持有 ambient timer；delivery 内的 setTimeoutPromise 必须 caller dispose
 *
 * 不变量：
 *   - 不主动 evaluate self；评估走 agint.qualityEval 跨插件（self-evaluation forbidden）
 *   - sync 全局上限 3（yaml constraints）；超出即抛
 */
import { publish, subscribe, inspect, inspectSummary, metricsSnapshot, disposeBus } from './bus.js';
import { listDeadletters } from './deadletter.js';
import { EventEnvelopeSchema } from './schemas.js';
import { z } from 'zod';
import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
const name = 'agint-event-bus';
const inject = ['storageDomain', 'agint.evolution'];
/** sync 订阅硬上限（设计稿 §A2.6 + schema yaml constraints） */
export const SYNC_GLOBAL_LIMIT = 3;
// ── 存储域声明（对齐 dsh-storage-domain defineDomain API） ─────────────
// events 表 value：{ envelope, payloadPreview, occurredAt, traceId }
// deadletter 表 value：死信条目（id = `${envelope.id}:${sub.id}`）
const EventRecordSchema = z.object({
  envelope: EventEnvelopeSchema,
  payloadPreview: z.unknown(),
  occurredAt: z.string(),
  traceId: z.string(),
}).passthrough();
const DeadletterEntrySchema = z.object({
  id: z.string().min(1),
  envelope: EventEnvelopeSchema,
  payloadPreview: z.unknown(),
  subscriber: z.string(),
  subscriptionId: z.string(),
  reason: z.string().default(''),
  attempts: z.number().int().default(0),
  sync: z.boolean().default(false),
  recordedAt: z.string(),
  ttl: z.number().int().default(604800000),
}).passthrough();
const spec = defineDomain({
  name: 'agint_event_bus',
  version: 1,
  tables: {
    events: { valueSchema: EventRecordSchema },
    deadletter: { valueSchema: DeadletterEntrySchema },
  },
});
/**
 * Cordis apply(ctx)。
 *
 * ctx 期望能力（host 平面提供；缺失时软降级）：
 *   - ctx.storageDomain.open({name: 'agint_event_bus'}) ⇒ {table('events') / table('deadletter') / close}
 *   - ctx.get('agint.evolution').logBuffered ⇒ 复用 EvolutionLogBuffer
 *   - ctx.get('agint.qualitySandbox').pendingReview ⇒ sync 超时降级
 *   - ctx.get('agint.metrics').inc ⇒ 健康度计数
 *   - ctx.on / ctx.effect / ctx.provide ⇒ cordis 基础
 */
function apply(ctx, _config = {}) {
    const disposers = [];
    // ── lifecycle: dispose 时清订阅表 + ring buffer ──
    ctx.effect(() => () => {
        try {
            disposeBus();
        }
        catch { /* ignore */ }
        for (const d of disposers) {
            try {
                d();
            }
            catch { /* ignore */ }
        }
    });
    // ── 构造 EventBusContext 适配层（连接 host 平面到模块函数） ──
    const busCtx = {
        tables: {
            events: stubTable(),
            deadletter: stubTable(),
        },
        logBuffered: async (entry) => {
            const evo = typeof ctx.get === 'function' ? ctx.get('agint.evolution') : null;
            if (evo?.logBuffered)
                return evo.logBuffered(entry);
        },
        pendingReview: async (input) => {
            const qs = typeof ctx.get === 'function' ? ctx.get('agint.qualitySandbox') : null;
            if (qs?.pendingReview)
                return qs.pendingReview(input);
        },
        metrics: (key, delta) => {
            const m = typeof ctx.get === 'function' ? ctx.get('agint.metrics') : null;
            if (m?.inc)
                return m.inc(key, delta);
        },
    };
    // ── 打开 storageDomain（事件表 + 死信表；失败软降级为 stub） ──
    // open 返回 Promise：用 .then(onOk, onErr) 双回调处理，避免 async rejection
    // 逃逸成 unhandled rejection / fatal load failure。
    let storageHandle = null;
    ctx.storageDomain.open(spec).then(
        (handle) => {
            if (handle && typeof handle.table === 'function') {
                // dsh-storage-domain 的真实句柄：通过 table(name) 拿 handle
                const tblEvents = handle.table('events');
                const tblDead = handle.table('deadletter');
                if (tblEvents && tblDead) {
                    busCtx.tables = { events: tblEvents, deadletter: tblDead };
                }
                storageHandle = handle;
                disposers.push(() => {
                    try {
                        handle.close?.();
                    }
                    catch { /* ignore */ }
                });
            }
        },
        () => {
            // 软降级：保留 stub（事件仅落在内存 ring + deadletter stub；不影响契约）
        },
    );
    // ── 注册 3 Service ──
    ctx.provide('agint.eventBus.publish', (input) => publish(busCtx, input));
    ctx.provide('agint.eventBus.subscribe', (rawSub, handler) => subscribe(rawSub, handler));
    ctx.provide('agint.eventBus.inspect', (filter) => inspect((filter ?? {})));
    ctx.provide('agint.eventBus.inspectSummary', (filter) => inspectSummary((filter ?? {})));
    // Sprint 13 / s12-09 断言②：死信可查询（辅助 Service，不进 FROZEN 3 Service 列表）。
    // 运维 / 排障 / 仪表盘需要列出 DLQ 内容；底层 listDeadletters 在 v0.7.0 已实现
    // 但未挂到 ctx，本 Sprint 补齐出口。软降级：读失败返回空数组。
    ctx.provide('agint.eventBus.deadletters', async () => {
        try {
            return await listDeadletters(busCtx);
        }
        catch { return []; }
    });
    ctx.provide('agint.eventBus.metricsSnapshot', async () => {
        // A10 尾巴（Sprint 13 / s12-09 收口）：死信率分子 + 分母 + sync 订阅数。
        // 分母 publishedCount 由 bus.js 维护 —— v0.7.0 缺失导致
        // metrics.js 的 eventBus.deadletterRate 恒为 0 或直接不 push。
        // 实现下沉到 bus.metricsSnapshot（可单测）；软降级→0。
        return metricsSnapshot(busCtx);
    });
    // ── 监听 tools/post-execute（占位；记录 publish 上下文事件） ──
    try {
        const off = ctx.on('tools/post-execute', () => { });
        if (typeof off === 'function')
            disposers.push(off);
    }
    catch { /* ignore：旧版 dsh 可能无此事件 */ }
}
/** 最小 TableHandle stub（host storageDomain 不可用时兜底；smoke / 单元测试可用） */
function stubTable() {
    const m = new Map();
    return {
        get: async (id) => m.get(id) ?? null,
        put: async (id, value) => { m.set(id, value); },
        delete: async (id) => { m.delete(id); },
        entries: () => m.entries(),
        size: async () => m.size,
    };
}
export const Config = z.object({});
export { apply, inject, name };
