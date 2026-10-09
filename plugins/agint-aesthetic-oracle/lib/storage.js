/**
 * lib/storage.js — agint-aesthetic-oracle v0.1.0 存储域声明 + openStore。
 *
 * 独占域 agint_aesthetic_oracle（3 表，schemaVersion 1）：
 *   - oracle_state       单行 'latest'：kill-switch / 沉默模式 / 连续失败计数 /
 *                        配额计数器 / 首周基线 / lastGood 缓存（§6.3 与 §5.4 的状态面）
 *   - oracle_broadcasts  每次广播一行：kind / asOf / score / 三问结果 / 行数字节 /
 *                        发布与审计落账标记（基线由前 7 条 daily 派生）
 *   - oracle_cards       dashboard 订阅卡片（key=topic，每 topic 最新事件快照；
 *                        独立成表——与广播主链分写，杜绝单行多写者竞态）
 *
 * 神谕层的写白名单（方案 §9.1）只有两张**别人的**表：evolution_log（审计）+
 * agint_evolve 提案表（weekly，status 锁 proposed）。本域是它自己的状态面，
 * 不在白名单语义内（每个插件都有权持有自己的存储域）。
 *
 * 容错：host storageDomain.open 不可用时降级内存 Map（smoke / 单测可用），
 * 与 agint-self-model/lib/storage.js 同款纪律。
 */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

export const DOMAIN_NAME = 'agint_aesthetic_oracle';

// ── 表 schema ──────────────────────────────────────────────────────────────

// 三个复合面先声明为独立 shape，再用 .default(() => shape.parse({})) 挂进状态行
// —— ⛔ 不能写 .default({})：zod v3 的 default 值**原样落盘、不过内层 parse**，
// 实测（2026-09-27）会把 silenceMode/baseline 存成裸 {}，下游全靠 falsy 侥幸。

/** §6.2 沉默模式面。 */
const silenceModeShape = z.object({
  active: z.boolean().default(false),
  since: z.string().nullable().default(null),
  reason: z.string().default(''),
  /** 24h 告警只发一次的防重标记 */
  alerted: z.boolean().default(false),
});

/** §5.4 配额计数面（跨重启持久；周期翻转时清零）。
 *  violations = §6.3「单日配额违规」计数（≥3 → 自动沉默 + 告警）；
 *  alerts = oracle.alert 独立日配额（防告警风暴，与常规广播分开计）。 */
const quotaShape = z.object({
  date: z.string().default(''),
  daily: z.number().int().min(0).default(0),
  weekly: z.number().int().min(0).default(0),
  weeklyKey: z.string().default(''),
  monthly: z.number().int().min(0).default(0),
  monthlyKey: z.string().default(''),
  bytes: z.number().int().min(0).default(0),
  violations: z.number().int().min(0).default(0),
  alerts: z.number().int().min(0).default(0),
});

/** §3.6 基线面（2026-10-09 起两代口径并存，见 method 字段）：
 *  - `first-week-mean`：建基时前 7 条有效 daily 的**均值**（2026-09-27 ~ 10-06 用）。
 *    ⚠ 已知缺陷：若建基窗口内某维数据源缺席（如 skills 文件系统不可达），该维
 *      落 null 且**永不修复**——Q1 判定时该维直接不参与。
 *  - `rolling-4w-median`：近 4 周有效 daily 的**中位数**（提案 6be656fd，
 *    老板 2026-10-09 拍板方案 D「一次性重定基，不滚动」）。
 *
 * sampleCounts 记录每维参与中位数的**样本数 n**——各维 n 可以不同（生产实测
 * noise 11 / confidence 10 / redundancy 4 / bloat 4，见 AGENT 汇报 2026-10-09），
 * 把 n 落进数据是刻意的：没有 n，读者无从判断某维基线由几个样本支撑。
 */
const baselineShape = z.object({
  establishedAt: z.string().nullable().default(null),
  score: z.number().nullable().default(null),
  composites: z.record(z.string(), z.number().nullable()).default({}),
  /** 建基口径（v1 存量行无此字段 = first-week-mean）。 */
  method: z.string().default('first-week-mean'),
  /** 重定基时刻（D 方案下一次性，之后不再自动滚动）。 */
  rebaselinedAt: z.string().nullable().default(null),
  /** 每维样本数（method=rolling-4w-median 时有值）。 */
  sampleCounts: z.record(z.string(), z.number().nullable()).default({}),
  /** 窗口天数（rolling-4w-median = 28）。 */
  windowDays: z.number().int().nullable().default(null),
});

/** §6.1 缓存回退面：最近一次成功广播的原子值快照（Day 2-3）。
 *  ⛔ 为什么不用 metrics.series()：summary() 与 series() 读同一张表，
 *  summary 挂 = series 挂，metrics 侧的「series 缓存」没有独立生存性。
 *  真正可回退的缓存 = 神谕层自己落盘的快照（消费侧视角），最多信 7 天。 */
const lastGoodShape = z.object({
  asOf: z.string().default(''),
  atomic: z.record(z.string(), z.number().nullable()).default({}),
  adviceCtx: z.record(z.string(), z.unknown()).default({}),
  activity: z.number().nullable().default(null),
  savedAt: z.string().default(''),
});

/** GUI dashboard 卡片行（Day 2-3）：oracle 订阅 oracle.* 4 topic，每 topic
 *  一行（key=topic）。UI 壳（dsh web）不可注入，卡片状态面 + cards() 查询是
 *  AGINT 侧的落地。独立成表、不进 state.latest——广播主链与订阅回写在同一
 *  状态行上会互相覆盖（实测 2026-09-27 竞态），分表后各写各的 key。 */
export const cardSchema = z.object({
  topic: z.string(),
  envelopeId: z.string(),
  occurredAt: z.string(),
  receivedAt: z.string(),
  payload: z.unknown(),
});

const oracleStateSchema = z.object({
  id: z.literal('latest'),
  kind: z.literal('oracle-state'),
  /** kill-switch（老板 oracle_pause；§6.4——只静默自己，不碰任何别的插件） */
  paused: z.boolean().default(false),
  pausedReason: z.string().default(''),
  pausedAt: z.string().nullable().default(null),
  /** §6.2 沉默模式：连续 3 次广播失败（重试后）→ 只写审计不开口 */
  silenceMode: silenceModeShape.default(() => silenceModeShape.parse({})),
  consecutiveFailures: z.number().int().min(0).default(0),
  /** §5.4 配额计数器（跨重启持久；周期翻转时清零）。
   *  violations = §6.3「单日配额违规」计数（≥3 → 自动沉默 + 告警）；
   *  alerts = oracle.alert 独立日配额（防告警风暴，与常规广播分开计）。 */
  quota: quotaShape.default(() => quotaShape.parse({})),
  /** §3.6 首周基线：前 7 条 daily 广播的均值；建立后 Δ 全部相对基线 */
  baseline: baselineShape.default(() => baselineShape.parse({})),
  /** §6.1 缓存回退面（Day 2-3）：最近一次成功广播的原子值快照，最多信 7 天 */
  lastGood: lastGoodShape.default(() => lastGoodShape.parse({})),
  updatedAt: z.string(),
});

const oracleBroadcastSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['daily', 'weekly', 'monthly', 'alert']),
  ts: z.string(),
  /** 数据时间戳（metrics asOf；§5 硬规则：广播首行必须透出，禁止反向触发采集） */
  asOf: z.string().default(''),
  score: z.number().nullable().default(null),
  verdict: z.string().default(''),
  worstKey: z.string().default(''),
  /** 四复合指标快照（基线均值的数据源；na 维存 null） */
  composites: z.record(z.string(), z.number().nullable()).default({}),
  lines: z.number().int().min(0).default(0),
  bytes: z.number().int().min(0).default(0),
  published: z.boolean().default(false),
  auditLogged: z.boolean().default(false),
  truncated: z.boolean().default(false),
  /** 未真广播的行（skipped/dropped/silenced/error）——失败也要留下痕迹 */
  outcome: z.string().default('ok'),
  detail: z.string().default(''),
  /** weekly 提案数（Day 4-5；本次广播成功提交到 agint_evolve.proposal 的条数） */
  proposals: z.number().int().min(0).default(0),
});

const spec = defineDomain({
  name: DOMAIN_NAME,
  version: 1,
  tables: {
    oracle_state: { valueSchema: oracleStateSchema },
    oracle_broadcasts: { valueSchema: oracleBroadcastSchema },
    oracle_cards: { valueSchema: cardSchema },
  },
});

// ── 内存兜底（host storageDomain 不可用时）──────────────────────────────────

class MemTable {
  constructor() { this.m = new Map(); }
  async put(id, v) { this.m.set(id, v); return v; }
  async get(id) { return this.m.get(id) ?? null; }
  async delete(id) { this.m.delete(id); return true; }
  entries() { return this.m.entries(); }
  async size() { return this.m.size; }
  async values() { return [...this.m.values()]; }
  async clear() { this.m.clear(); return true; }
}

function adaptTable(handle) {
  return {
    put(id, v) { return handle.put(id, v); },
    get(id) { return handle.get(id) ?? null; },
    delete(id) { return handle.delete(id); },
    entries() { return handle.entries(); },
    async size() { return handle.size; },
    async values() { return [...handle.entries()].map(([, v]) => v); },
    async clear() {
      for (const [k] of handle.entries()) { await handle.delete(k); }
      return true;
    },
  };
}

export function openStore(ctx) {
  const memTables = {
    state: new MemTable(),
    broadcasts: new MemTable(),
    cards: new MemTable(),
  };
  const store = { tables: memTables, close: () => {}, _memory: true };
  if (ctx && typeof ctx.storageDomain?.open === 'function') {
    try {
      ctx.storageDomain.open(spec).then(
        (handle) => {
          if (handle && typeof handle.table === 'function') {
            store.tables = {
              state: adaptTable(handle.table('oracle_state')),
              broadcasts: adaptTable(handle.table('oracle_broadcasts')),
              cards: adaptTable(handle.table('oracle_cards')),
            };
            store.close = () => { try { handle.close?.(); } catch { /* ignore */ } };
            store._memory = false;
          }
        },
        () => { /* 降级内存（不 fatal） */ },
      );
    } catch { /* open 同步抛（mock ctx）→ 内存兜底 */ }
  }
  return store;
}

// ── 状态行 helper ──────────────────────────────────────────────────────────

export function randomId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `oracle-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

/** 读单行状态；首读即初始化（幂等）。已有记录也过一遍 parse——
 *  补齐后加字段的 default（旧记录平滑升级），并 strip 意外字段。 */
export async function loadState(stateTable) {
  const cur = await stateTable.get('latest');
  if (cur) return oracleStateSchema.parse(cur);
  const init = oracleStateSchema.parse({
    id: 'latest',
    kind: 'oracle-state',
    updatedAt: nowIso(),
  });
  await stateTable.put('latest', init);
  return init;
}

export { oracleStateSchema, oracleBroadcastSchema, spec };
