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
import { publish, subscribe, inspect, inspectSummary, metricsSnapshot, subscriptionsSummary, deliveryByTopic, deliveryHistory, disposeBus } from './bus.js';
import { listDeadletters, sweepExpiredDeadletters } from './deadletter.js';
import { EventEnvelopeSchema } from './schemas.js';
import { attachHostBridge } from './host-bridge.js';
import { applyMigration, resolveStoragesRoot } from './migrate.js';
import { z } from 'zod';
import { defineDomain } from '@deepseek-ai/dsh-storage-domain';

/**
 * 迁移/保留窗口（天）：切换 per-record 时只搬窗口内的记录，窗口外的历史
 * 由保留策略负责清掉 —— 搬过去再删是白费 IO。
 * ⚠️ 与 `agint.eventBus.prune` 的默认窗口保持一致（同一口径，不各写一个数）。
 */
const MIGRATION_MAX_AGE_DAYS = 30;

/**
 * 永不删除的 topic 前缀（决策与审计类事件，不是遥测）。
 * 事件表一旦开始按时间淘汰，这些必须留下 —— 决策链断不得。
 */
const PINNED_TOPIC_PREFIXES = [
  'evolution.', 'restart.', 'diagnosis.', 'quality.', 'mount.',
];
const name = 'agint-event-bus';
// fix-20260904-2338：打破 cordis 循环依赖。
//   原 `['storageDomain', 'agint.evolution']` 与 agint-evolution-memory
//   互为 provider/consumer（event-bus 提供 agint.eventBus.* 给 evolution-memory，
//   evolution-memory 提供 agint.evolution 给 event-bus），导致 8 个插件永久 PENDING。
//   运行期 `agint.evolution` 仅用于可选的 `ctx.get(...)?.logBuffered(entry)` 软降级，
//   不声明为硬依赖也不影响功能（bus 自身有 agint_event_bus 域 + deadletter 自洽）。
const inject = ['storageDomain'];
/** sync 订阅硬上限（设计稿 §A2.6 + schema yaml constraints） */
export const SYNC_GLOBAL_LIMIT = 3;
// ── 存储域声明（对齐 dsh-storage-domain defineDomain API） ─────────────
// events 表 value：{ envelope, deliveries? }
//   2026-11-12（结构性冗余清理）：写入不再写 payloadPreview 与顶层
//   topic/source/occurredAt/traceId —— 它们全是 envelope 内同名字段的副本
//   （payloadPreview 还是 payload 的副本），全仓零读取方。
//   ⚠️ 存量行（single 布局旧文件）仍带这些字段 ⇒ 全部声明为 optional，
//   读侧（bus.js deliveryHistory）一律 envelope 优先 + 顶层兜底，两种形态都读得通。
//   ⚠️ src/index.ts 与本文件已漂移（src 还是旧版 storageDomain.open API，无
//   defineDomain spec）—— EventRecordSchema 只存在于本文件，勿跑 build 覆盖。
// deadletter 表 value：死信条目（key = `${envelope.id}__${sub.id}`，见下）
const EventRecordSchema = z.object({
    envelope: EventEnvelopeSchema,
    // ↓ 全部 optional：存量行有 / 新写入没有，两种形态都要能解析。
    //   payloadPreview：payload 的副本（≤200 字符原样，否则截断），零读取方。
    payloadPreview: z.unknown().optional(),
    occurredAt: z.string().optional(),
    traceId: z.string().optional(),
    topic: z.string().optional(),
    source: z.string().optional(),
    // 2026-10-05（评审 3.3 方案 A）：顶层 deliveries = { [subscriber]: status }。
    // 存的是 publish 路径的**终态**（DELIVERED / DEAD_LETTERED / PENDING / FAILED），
    // 取自内存 ring 那份的浅拷贝。optional：存量 21,803 行没有此字段，永远补不回，
    // 读侧必须把「无此字段」判成 unknown 而不是 0。
    // ⚠️ deliveries **必须保留**：它是跨重启 per-topic 投递数的唯一来源
    //   （deliveryHistory 靠它算 coverage）。
    deliveries: z.record(z.string(), z.string()).optional(),
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
    // 2026-11-12：切到 per-record 布局。
    //
    // 为什么切：`single` 布局每次 put 都**整份原子重写文件**
    // （@deepseek-ai/dsh-storage-json/lib/index.js:166-170）。events 表已涨到
    // 28.6 MB / 3 万余行 ⇒ 每写一条事件重写 28.6 MB。本机实测
    // （/tmp/agint_bloat/scale_bench.mjs，单条 630 B）：
    //   N=300  single 11.57 ms/条 → per-record 7.69 ms/条
    //   N=3000 single 26.08 ms/条 → per-record 4.76 ms/条
    //   N=6000 single 34.79 ms/条 → per-record 6.51 ms/条
    // single 的每条写成本随规模线性增长，per-record 恒定 ⇒ 生产规模外推
    // 每条写 45 ms → 6.5 ms（7×），日磁盘写 18.3 GB → 约 1.2 MB。
    //
    // 为什么**不改 dsh 源码**：改 node_modules 是 AGINT 明令禁止的越界，且会被
    // npm 升级静默覆盖（patches/dsh-builtin-toggles/README.md，2026-10-21 老板令）。
    // layout 是域声明的**公开能力**（DomainSpec.layout，dsh-storage-domain
    // lib/types/spec.d.ts:43），AGINT 侧声明即可。
    //
    // ⚠️ 回滚路径：把这一行改回 'single' 即可。single 读 <storages>/agint_event_bus.json，
    // per-record 读 <storages>/agint_event_bus/ 目录 ⇒ **两者可共存于磁盘**，
    // 旧文件原地保留就是回滚备份。
    layout: 'per-record',
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
function apply(ctx, config = {}) {
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
    // ── 启动期写入代理表（2026-11-12，评估报告 §五 步骤 0）────────────────
    //
    // ⛔ 修复前这里用的是 stubTable()（纯内存 Map），open 成功后 **整体替换**
    //    `busCtx.tables = { events: tblEvents, deadletter: tblDead }`。而 publish
    //    在 :162 就已 provide、宿主事件桥在 :170 就同步 attach —— 于是启动最初
    //    那几百毫秒内发布的事件全部写进 stub，open 完成后 stub 连同里面的事件
    //    一起被丢弃：**进过 ring（published 有数）、events 表却永远查不到**。
    //
    //    2026-11-11 生产实测：15:29:36 启动，ring 内 skills-change published 13 /
    //    delivered 0 / subscribers []，而 events 表 15:29:36 之后该 topic 落盘 0 行；
    //    同一窗口其它 topic 落盘 1750 条（说明总线没坏，只有启动瞬间的写入丢了）。
    //
    // 修法：表句柄**引用不变**，open 成功后把真实表 attach 进去，并把启动期
    // 暂存的写入按原顺序补刷。零改动 bus.js / 存储 schema / 存量 31k 行数据。
    const earlyEvents = createBufferingTable();
    const earlyDeadletter = createBufferingTable();
    const busCtx = {
        tables: {
            events: earlyEvents,
            deadletter: earlyDeadletter,
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
    // ── 启动前补迁（2026-11-12，切换 per-record 布局的零丢失保证）──────────
    //
    // ⛔ **必须发生在 `ctx.storageDomain.open(spec)` 之前**。
    // dsh 的 domain 在 open() 时做一次 loadAll() 把介质读进内存，之后内存与磁盘
    // 不再自动同步（只有 put/delete 更新两边）。若在 open 之后补迁，会造成
    // 「文件里有、内存里没有」的分叉：那些事件在读侧（deliveryHistory 等）查不到，
    // prune 也删不到它们 —— 等于「迁移了但等于没迁」。
    //
    // 幂等：水位线文件记录已迁到的位置 + 源文件 mtime/size。源文件没变 ⇒ 直接跳过
    // （避免每次启动都重读 28.6 MB 旧文件）。源文件变了（迁移脚本跑完后宿主又写了
    // 新事件）⇒ 只补迁 occurredAt > 水位线的那些，通常只有几十条，毫秒级完成。
    //
    // 失败处理：补迁失败**不许**阻塞 open —— 记 warn 后继续，历史数据缺席但总线可用
    // （宁可少历史，不可少总线）。
    try {
        const storageRoot = resolveStoragesRoot();
        if (storageRoot) {
            const mig = applyMigration({
                storageRoot,
                maxAgeDays: MIGRATION_MAX_AGE_DAYS,
                dryRun: false,
            });
            if (mig.migrated > 0 || mig.unchanged) {
                console.info(
                    `[agint-event-bus] 启动前补迁：迁入 ${mig.migrated} 条、跳过 ${mig.skipped} 条` +
                    `、失败 ${mig.failed} 条（窗口 ${MIGRATION_MAX_AGE_DAYS} 天，共 ${mig.totalRows} 行）`,
                );
            }
        }
    }
    catch (err) {
        console.warn(`[agint-event-bus] 启动前补迁失败（不影响总线可用性）：${err?.message ?? err}`);
    }
    // ── 打开 storageDomain（事件表 + 死信表；失败软降级为 stub） ──
    // open 返回 Promise：用 .then(onOk, onErr) 双回调处理，避免 async rejection
    // 逃逸成 unhandled rejection / fatal load failure。
    // ⚠️ 两条分支都必须把代理表 settle：成功 → attach(真实表) 补刷启动期写入；
    //    失败 → degrade() 放行挂起的 put（软降级为内存态，绝不永久挂起 publish）。
    let storageHandle = null;
    ctx.storageDomain.open(spec).then(
        (handle) => {
            if (handle && typeof handle.table === 'function') {
                // dsh-storage-domain 的真实句柄：通过 table(name) 拿 handle
                const tblEvents = handle.table('events');
                const tblDead = handle.table('deadletter');
                if (tblEvents && tblDead) {
                    earlyEvents.attach(tblEvents);
                    earlyDeadletter.attach(tblDead);
                    // 真实死信表刚挂上：立即清一轮（apply 时的首轮 sweep 只扫到 stub 空表）
                    void sweepExpiredDeadletters(busCtx).catch(() => { });
                } else {
                    earlyEvents.degrade();
                    earlyDeadletter.degrade();
                }
                storageHandle = handle;
                disposers.push(() => {
                    try {
                        handle.close?.();
                    }
                    catch { /* ignore */ }
                });
            } else {
                earlyEvents.degrade();
                earlyDeadletter.degrade();
            }
        },
        () => {
            // 软降级：保留暂存（事件仍进 ring 且可被 inspect 读到），
            // 但不落盘 —— 与修复前 stub 的语义一致，只是不再"必然丢且不可见"。
            earlyEvents.degrade();
            earlyDeadletter.degrade();
        },
    );
    // ── 死信 reaper（2026-10-07 补，S8）────────────────────────────────────
    // 「7 天保留」此前只写 ttl 字段、全仓无消费者——纸面约定，死信表无界增长。
    // 启动清一轮 + 每 24h 一轮；ctx.effect 保证 dispose 清 timer（PLUGIN-SPEC 维度 5）。
    const DEADLETTER_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
    const sweepOnce = () => {
        void sweepExpiredDeadletters(busCtx).catch(() => { });
    };
    sweepOnce();
    const sweepTimer = setInterval(sweepOnce, DEADLETTER_SWEEP_INTERVAL_MS);
    ctx.effect(() => clearInterval(sweepTimer));
    // ── 注册 3 Service ──
    ctx.provide('agint.eventBus.publish', (input) => publish(busCtx, input));
    // ── B1（2026-11-02）：宿主事件 → 总线 ──────────────────────────────────
    // 接 domain/changed（白名单域）与 workflow/end，理由与约束见 host-bridge.js 头注释。
    //
    // ⚠️ 挂在 provide 之后：桥接要用 publish，而 publish 依赖 busCtx，此处都已就绪。
    // ⚠️ 关掉的方式：config.hostBridge === false（H5）。不发新版、不改代码即可止血 ——
    //    一旦某个域意外变成高频写，改配置 + 重启比追一次发版快。
    if (config.hostBridge !== false) {
        disposers.push(attachHostBridge(ctx, {
            publish: (input) => publish(busCtx, input),
            metrics: busCtx.metrics,
        }));
    }
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
    // 订阅 → 投递对差（评审 3.3 缺口，2026-10-04 补；与 src/index.ts 同步，K78）：
    // 只读出口，给家族面板 v2 与排障用。此前订阅表是模块级 Map 且无查询接口。
    // ⚠️ 计数只覆盖本进程生命周期（重启清零），面板须照此口径措辞。
    ctx.provide('agint.eventBus.subscriptions', () => subscriptionsSummary());
    // topic → 投递聚合（评审 3.3 缺口，2026-10-05 补；与 src/index.ts 同步，K78）：
    // 解决面板事件链表「一行一 topic、投递列却拿不到数」的口径错位。
    // ⚠️ 口径：ring 窗口内（本进程 + 最近 2000 条发布），重启清零。
    //   `ring.full === true` 时更早的投递记录已被 FIFO 淘汰，面板须照此措辞。
    ctx.provide('agint.eventBus.deliveryByTopic', () => deliveryByTopic());
    // 跨重启口径的同名聚合（评审 3.3 方案 A，2026-10-05 补；与 src/index.ts 同步，K78）：
    // 读 events 表 ⇒ 全历史有效。**但 2026-10-05 之前的存量行没有 deliveries 字段，
    // 永远补不回** —— 故每行带 `coverage`（full / partial / legacyOnly），
    // legacyOnly 的投递数是 unknown 不报数。软降级：读失败返回 state:'error' + reason。
    ctx.provide('agint.eventBus.deliveryHistory', async () => {
        try {
            return await deliveryHistory(busCtx);
        }
        catch (err) {
            return {
                generatedAt: new Date().toISOString(),
                scope: 'events-table',
                state: 'error',
                reason: err instanceof Error ? err.message : String(err ?? 'unknown'),
                scanned: 0,
                withDeliveries: 0,
                legacyRows: 0,
                totals: { rows: 0, delivered: 0, deadLettered: 0, deliveryAttempts: 0 },
                topics: [],
                unknownDeliveryTopics: [],
            };
        }
    });
    // ── 保留窗口：events 表按时间淘汰（30 天默认）──────────────────────────
    //
    // 为什么需要：events 表此前**只增不删**（全仓无任何针对该表的 delete），
    // 实测 28.6 MB / 3 万余行，且每写一条事件都重写整份文件。
    //
    // 契约：`ctx.provide('agint.eventBus.prune', async (opts) => {...})`
    //   opts.maxAgeDays（默认 30）/ opts.dryRun（默认 false = 真删）
    //   返回 `{ removed, kept, wouldRemove, dryRun }`
    // 消费方：`plugins/agint-cron` 的 storage-prune job 用 ctx.get 调用；取不到就跳过。
    //
    // ⛔ 决策与审计类 topic 永不删（PINNED_TOPIC_PREFIXES）—— 事件表淘汰的
    // 是遥测，不是决策链。删决策事件等于毁掉进化闭环的证据。
    ctx.provide('agint.eventBus.prune', async (opts = {}) => {
        const maxAgeDays = Number.isFinite(opts?.maxAgeDays) ? opts.maxAgeDays : MIGRATION_MAX_AGE_DAYS;
        const dryRun = opts?.dryRun === true;
        const handle = storageHandle;
        if (!handle || typeof handle.table !== 'function') {
            return { removed: 0, kept: null, wouldRemove: 0, dryRun, skipped: 'storage-not-ready' };
        }
        let table;
        try { table = handle.table('events'); }
        catch { return { removed: 0, kept: null, wouldRemove: 0, dryRun, skipped: 'events-table-unavailable' }; }
        if (!table || typeof table.entries !== 'function') {
            return { removed: 0, kept: null, wouldRemove: 0, dryRun, skipped: 'events-table-unavailable' };
        }
        const cutoff = Date.now() - maxAgeDays * 86_400_000;
        const victims = [];
        let total = 0;
        for (const [key, rec] of table.entries()) {
            total++;
            const topic = String(rec?.envelope?.topic ?? rec?.topic ?? '');
            if (topic && PINNED_TOPIC_PREFIXES.some((p) => topic.startsWith(p))) continue;
            const at = rec?.envelope?.occurredAt ?? rec?.occurredAt;
            const ts = Date.parse(String(at ?? ''));
            if (!Number.isFinite(ts) || ts >= cutoff) continue;
            victims.push(key);
        }
        if (dryRun) {
            return { removed: 0, kept: total - victims.length, wouldRemove: victims.length, dryRun: true };
        }
        let removed = 0;
        if (victims.length > 0 && typeof table.deleteMany === 'function') {
            try {
                removed = await table.deleteMany(victims);
            }
            catch (err) {
                return {
                    removed: 0, kept: null, wouldRemove: victims.length, dryRun,
                    skipped: `delete-failed: ${err?.message ?? err}`,
                };
            }
        }
        // 留痕：prune 本身也是一件「发生了的事」，发一条事件（不递归触发 prune）。
        try {
            const pub = typeof ctx.get === 'function' ? ctx.get('agint.eventBus.publish') : null;
            if (typeof pub === 'function') {
                await pub({
                    topic: 'events.pruned',
                    payload: { removed, freedRows: victims.length, maxAgeDays, kept: total - removed },
                });
            }
        }
        catch { /* 留痕失败不阻断主流程 */ }
        return { removed, kept: total - removed, wouldRemove: victims.length, dryRun: false };
    });
    // ── umbrella 键（2026-09-24 补）────────────────────────────────────────
    // cordis 的 service store 是**扁平的**：provide('agint.eventBus.publish') 之后，
    // ctx.get('agint.eventBus') 恒为 undefined，且不报错。后果是全仓每个消费方
    // 都得自己写「先试全名、再试伞键」的回退链 —— 漏写一处就静默降级：
    //   · agint-mount 10 处 mount.* 发布曾因此全部降级到 ctx.emitEvent，生产 0 条
    //     （2026-09-20 取证，见 docs/known-limitations/event-bus-shadow-publish-gap.md）
    //   · agint-evolution-memory / agint-quality-sandbox 同样只能靠回退链活
    // 补这个 umbrella 键是**纯加法**：现有全名子键一个不动，已有回退链也不会误判
    // （它们先试全名、命中即返回）。收益是以后新消费方不用再写回退链。
    // ⚠️ 本文件是 tsc 产物 —— 同步改 src/index.ts，否则下次 build 会静默回退（K78）。
    ctx.provide('agint.eventBus', {
        publish: (input) => publish(busCtx, input),
        subscribe: (rawSub, handler) => subscribe(rawSub, handler),
        inspect: (filter) => inspect((filter ?? {})),
        inspectSummary: (filter) => inspectSummary((filter ?? {})),
        deadletters: async () => {
            try {
                return await listDeadletters(busCtx);
            }
            catch { return []; }
        },
        metricsSnapshot: async () => metricsSnapshot(busCtx),
        subscriptions: () => subscriptionsSummary(),
        deliveryByTopic: () => deliveryByTopic(),
        deliveryHistory: async () => {
            try {
                return await deliveryHistory(busCtx);
            }
            catch (err) {
                return {
                    generatedAt: new Date().toISOString(),
                    scope: 'events-table',
                    state: 'error',
                    reason: err instanceof Error ? err.message : String(err ?? 'unknown'),
                    scanned: 0,
                    withDeliveries: 0,
                    legacyRows: 0,
                    totals: { rows: 0, delivered: 0, deadLettered: 0, deliveryAttempts: 0 },
                    topics: [],
                    unknownDeliveryTopics: [],
                };
            }
        },
    });
    ctx.provide('agint.eventBus.metricsSnapshot', async () => {
        // A10 尾巴（Sprint 13 / s12-09 收口）：死信率分子 + 分母 + sync 订阅数。
        // 分母 publishedCount 由 bus.js 维护 —— v0.7.0 缺失导致
        // metrics.js 的 eventBus.deadletterRate 恒为 0 或直接不 push。
        // 实现下沉到 bus.metricsSnapshot（可单测）；软降级→0。
        return metricsSnapshot(busCtx);
    });
    // 注意：不要注册 tools/post-execute 空监听 —— 该事件是 waterfall，
    // 不调 next() 会令瀑布结果为 undefined，dsh-tools 读 decision.kind 抛错，
    // 所有工具调用失败。event-bus 不消费工具结果，不监听。
}
/**
 * 启动期写入代理表（2026-11-12）。
 *
 * 职责：在 `storageDomain.open()` 完成前接住所有 put —— 既不丢（补刷到真实表），
 * 也不让 publish 永久挂起（open 失败时 degrade 放行）。
 *
 * 语义三条，别改：
 *  1. **表句柄引用不变**：调用方（bus.js 的 busCtx.tables）拿到的始终是同一个
 *     对象，attach 只换内部 target，不换对象 —— 这正是修复「整体替换丢写入」的关键。
 *  2. 未 settle 时 put 返回**挂起的 Promise**：等补刷完成才 resolve，这样 publish
 *     返回时事件已落盘（或已明确降级），不制造「看着成功其实没写」的假绿。
 *  3. open 失败只 degrade 不强抛：与修复前 stub 软降级一致，且 staging 仍可被
 *     inspect / deliveryHistory 读到 ⇒ 「没落盘」与「没发生」两件事不再同形。
 *
 * events 表主键是 envelope.id（UUID，唯一）、deadletter 主键也是唯一 id，
 * 故补刷与 attach 之后的新 put 不存在同键覆盖顺序问题，无需额外串行化。
 */
function createBufferingTable() {
    const staging = new Map();
    const waiters = [];
    let target = null;
    let settled = false;
    const release = () => { for (const r of waiters.splice(0)) r(); };
    return {
        get: async (id) => (target ? target.get(id) : (staging.get(id) ?? null)),
        put: async (id, value) => {
            if (target) return target.put(id, value);
            staging.set(id, value);
            if (settled) return; // 已降级：留内存副本即可，不挂起
            return new Promise((resolve) => waiters.push(resolve));
        },
        delete: async (id) => {
            staging.delete(id);
            if (target) return target.delete(id);
            return undefined;
        },
        entries: () => (target ? target.entries() : staging.entries()),
        size: () => {
            if (!target) return Promise.resolve(staging.size);
            return typeof target.size === 'function' ? target.size() : Promise.resolve(target.size ?? 0);
        },
        /** open 成功：换上真实表并按插入顺序补刷启动期写入 */
        attach(real) {
            target = real;
            settled = true;
            const batch = [...staging.entries()];
            staging.clear();
            void (async () => {
                for (const [id, value] of batch) {
                    try { await real.put(id, value); }
                    catch { /* 单条失败不阻断后续；bus.js 侧另有写失败可见性 */ }
                }
            })().finally(release);
        },
        /** open 失败：软降级，放行所有挂起的 put（不落盘、不挂起） */
        degrade() {
            settled = true;
            release();
        },
    };
}

/** 纯内存 TableHandle stub（保留给 smoke / 单元测试直接构造 ctx 用）。 */
export function stubTable() {
    const t = createBufferingTable();
    t.degrade();
    return t;
}
/**
 * 配置（2026-11-02 起非空）。
 *
 * hostBridge：宿主事件桥（B1）的开关。默认开；`false` 时彻底不订阅宿主事件。
 * 为什么留这个开关而不是写死：桥接接的是**别人的**事件源，量级由宿主决定不由我们决定。
 * 一旦某个域意外变成高频写（宿主改实现、或我们新挂插件），改配置 + 重启比追一次发版快。
 * ⛔ 别把它做成「节流参数」——节流会让计数失真，而 metrics 正是靠计数看「哪天突然停写」。
 */
export const Config = z.object({
    hostBridge: z.boolean().optional(),
});
export { apply, inject, name };
