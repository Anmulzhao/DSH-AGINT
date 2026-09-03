/**
 * lib/storage.js — agint-self-model v0.7.1 存储域声明 + entry schema + pack/unpack
 *
 * 设计稿 Sprint13 §4.2（独占域 agint_self_model，4 表）：
 *   - capability_map      200  能力图谱（CAN/CANNOT/UNCERTAIN + last_verified_at）
 *   - reasoning_profile   100  推理模式画像
 *   - resource_baseline    50  资源感知基线（p50/p90）
 *   - calibration_log     100  校准日志（误差护栏数据源）
 *
 * 上限对齐 diagnosis（200/50/50 量级）；超限不抛错、不自动 prune（与
 * agint-diagnosis / agint-evolution-memory 同策略，给人工留口子）。
 *
 * 容错：host 平面 ctx.storageDomain.open 不可用时降级为内存 Map（smoke /
 * 单元测试 / 仓库轻量环境可用），不影响契约。降级时 _memory=true。
 */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import {
  CapabilityEntrySchema,
  ReasoningAspectSchema,
  ResourceMetricSchema,
  LIMITS,
} from './schema.js';

export const DOMAIN_NAME = 'agint_self_model';

// ── storage entry schema（带 metadata）────────────────────────────────────
// 业务字段严格按 FROZEN schema；额外 id / kind / createdAt 为 storage 内部
// metadata，不污染 FROZEN Service 出口（剥回在 unpack* 完成）。

const capabilityEntrySchema = CapabilityEntrySchema.extend({
  id: z.string().min(1),
  kind: z.literal('capability'),
  createdAt: z.string(),
});

const reasoningEntrySchema = z.object({
  id: z.string().min(1),
  kind: z.literal('reasoning'),
  aspect: ReasoningAspectSchema,
  key: z.string().min(1),
  count: z.number().int().min(0),
  recentEvidence: z.string(),
  createdAt: z.string(),
});

const resourceEntrySchema = z.object({
  id: z.string().min(1),
  kind: z.literal('resource'),
  metric: ResourceMetricSchema,
  p50: z.number(),
  p90: z.number(),
  sampleCount: z.number().int().min(0),
  window: z.string(),
  createdAt: z.string(),
});

const calibrationEntrySchema = z.object({
  id: z.string().min(1),
  kind: z.literal('calibration'),
  calibratedAt: z.string(),
  trigger: z.string(),
  domain: z.string().min(1),
  predicted: z.number(),
  actual: z.number(),
  error: z.number().min(0),
  samples: z.number().int().min(0),
  createdAt: z.string(),
});

// ── storage domain spec ──────────────────────────────────────────────────

export const spec = defineDomain({
  name: DOMAIN_NAME,
  version: 1,
  tables: {
    capability_map: { valueSchema: capabilityEntrySchema },
    reasoning_profile: { valueSchema: reasoningEntrySchema },
    resource_baseline: { valueSchema: resourceEntrySchema },
    calibration_log: { valueSchema: calibrationEntrySchema },
  },
});

// ── 内存兜底 Table（host storageDomain 不可用时使用）──────────────────────

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

// ── 上限 helper（owner：lib/index.js 引用）────────────────────────────────

const TABLE_TO_LIMIT_KEY = {
  capability_map: 'CAPABILITY_MAP',
  reasoning_profile: 'REASONING_PROFILE',
  resource_baseline: 'RESOURCE_BASELINE',
  calibration_log: 'CALIBRATION_LOG',
};

/**
 * 上限检查：返回 null 表示 OK；返回 { table, count, limit, _warn } 表示超限 warn。
 */
export function checkLimit(table, count) {
  const key = TABLE_TO_LIMIT_KEY[table];
  const cap = key ? LIMITS[key] : undefined;
  if (typeof cap === 'number' && count > cap) {
    return { table, count, limit: cap, _warn: `${table} count ${count} > limit ${cap}` };
  }
  return null;
}

// ── 工具函数：随机 id / ISO now ──────────────────────────────────────────

export function randomId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `sm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

// ── pack（FROZEN 业务字段 → storage record）─────────────────────────────

export function packCapability(business) {
  return capabilityEntrySchema.parse({
    id: randomId(),
    kind: 'capability',
    createdAt: nowIso(),
    ...business,
  });
}

export function packReasoning(business) {
  return reasoningEntrySchema.parse({
    id: randomId(),
    kind: 'reasoning',
    createdAt: nowIso(),
    ...business,
  });
}

export function packResource(business) {
  return resourceEntrySchema.parse({
    id: randomId(),
    kind: 'resource',
    createdAt: nowIso(),
    ...business,
  });
}

export function packCalibration(business) {
  return calibrationEntrySchema.parse({
    id: randomId(),
    kind: 'calibration',
    createdAt: nowIso(),
    ...business,
  });
}

// ── unpack（storage record → FROZEN 业务字段；Service 出口用）────────────

export function unpackCapability(entry) {
  return {
    domain: entry.domain,
    capability: entry.capability,
    status: entry.status,
    confidence: entry.confidence,
    evidenceRefs: entry.evidenceRefs,
    lastVerifiedAt: entry.lastVerifiedAt,
    updatedAt: entry.updatedAt,
  };
}

export function unpackReasoning(entry) {
  return {
    aspect: entry.aspect,
    key: entry.key,
    count: entry.count,
    recentEvidence: entry.recentEvidence,
  };
}

export function unpackResource(entry) {
  return {
    metric: entry.metric,
    p50: entry.p50,
    p90: entry.p90,
    sampleCount: entry.sampleCount,
    window: entry.window,
  };
}

export function unpackCalibration(entry) {
  return {
    domain: entry.domain,
    predicted: entry.predicted,
    actual: entry.actual,
    error: entry.error,
    samples: entry.samples,
  };
}

// ── openStore：优先真实 storageDomain，降级内存 ──────────────────────────

/**
 * 把真实 dsh-storage-domain TableHandle 适配成 MemTable 兼容接口。
 * 差异：真实 size 是 getter（非函数）、无 clear()；此处统一为
 * async size() / async clear()，使上层（capability / calibration 等）无感知。
 */
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

/**
 * 打开 agint_self_model 存储域，返回 4 张表句柄。
 * 句柄接口（与 diagnosis / event-bus 对齐）：put(id, v) / get(id) /
 * delete(id) / entries() / size() / values() / clear()。
 *
 * @param {object} ctx cordis ctx（可选；缺则纯内存）
 * @returns {{ tables: {capabilityMap, reasoningProfile, resourceBaseline, calibrationLog}, close: Function, _memory?: boolean }}
 */
export function openStore(ctx) {
  const memTables = {
    capabilityMap: new MemTable(),
    reasoningProfile: new MemTable(),
    resourceBaseline: new MemTable(),
    calibrationLog: new MemTable(),
  };
  const store = {
    tables: memTables,
    close: () => {},
    _memory: true,
  };
  // 真实 storageDomain.open 是异步的：就绪后热切换为真实表（经 adaptTable 适配）。
  // 就绪前 / 失败时保持内存降级，不影响契约；绝不让 async rejection 逃逸成 fatal。
  if (ctx && typeof ctx.storageDomain?.open === 'function') {
    ctx.storageDomain.open(spec).then(
      (handle) => {
        if (handle && typeof handle.table === 'function') {
          store.tables = {
            capabilityMap: adaptTable(handle.table('capability_map')),
            reasoningProfile: adaptTable(handle.table('reasoning_profile')),
            resourceBaseline: adaptTable(handle.table('resource_baseline')),
            calibrationLog: adaptTable(handle.table('calibration_log')),
          };
          store.close = () => { try { handle.close?.(); } catch { /* ignore */ } };
          store._memory = false;
        }
      },
      () => { /* 降级内存（不 fatal） */ },
    );
  }
  return store;
}

export {
  capabilityEntrySchema,
  reasoningEntrySchema,
  resourceEntrySchema,
  calibrationEntrySchema,
};
