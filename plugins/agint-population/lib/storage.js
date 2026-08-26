/**
 * agint-population: storage domain 声明 + entry schema + LIMITS helpers.
 *
 * 设计（设计稿 §二.2 / §十）：
 *   - storage domain 名：agint_population（与 agint_diagnosis /
 *     agint_mutation / agint_evolution / agint / agint_rules /
 *     agint_metrics / agint_mem 互斥 — 7 个兄弟插件无重叠）
 *   - 四张表：variants (≤100) / fitness_history (≤500) /
 *     traffic_log (≤500) / generation_log (≤50)
 *   - schemaVersion: 1
 *
 * Entry 字段设计：
 *   - 业务字段严格按 FROZEN schema（见 ./schema.js）
 *   - 额外 metadata：id / kind / createdAt，供存储引擎需要 + 衰减 hook 接入
 *   - FROZEN Service 出口只暴露 FROZEN 业务字段，storage ↔ service 之间的
 *     metadata 转换在 lib/index.js 内完成
 */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import {
  VariantSchema,
  FitnessHistorySchema,
  TrafficLogSchema,
  GenerationLogSchema,
  LIMITS,
} from './schema.js';

// ── storage entry schema（带 metadata） ─────────────────────────────────────

const variantEntrySchema = VariantSchema.extend({
  id: zString(),
  kind: zLiteral('variant'),
});

const fitnessHistoryEntrySchema = FitnessHistorySchema.extend({
  id: zString(),
  kind: zLiteral('fitness_history'),
});

const trafficLogEntrySchema = TrafficLogSchema.extend({
  id: zString(),
  kind: zLiteral('traffic_log'),
});

const generationLogEntrySchema = GenerationLogSchema.extend({
  id: zString(),
  kind: zLiteral('generation_log'),
});

// zod 0 依赖 inline（storage.js 假设 zod 已通过 peer 引入，但本文件不直接 import zod 以保持 schema.js 为单一 FROZEN 来源）
// 这里我们只 import 它来定义 zString / zLiteral，但因为 storage entry 的 FROZEN 字段已经 VariantSchema.extend，
// 而 VariantSchema 已含 zod 校验 — 因此下方 packX() 自然走 schema.parse()，无需额外 zod 引用。
import { z } from 'zod';
function zString() { return z.string().min(1); }
function zLiteral(v) { return z.literal(v); }

// ── storage domain spec ──────────────────────────────────────────────────

const name = 'agint-population';

const spec = defineDomain({
  name: 'agint_population',
  version: 1,
  tables: {
    variants: { valueSchema: variantEntrySchema },
    fitness_history: { valueSchema: fitnessHistoryEntrySchema },
    traffic_log: { valueSchema: trafficLogEntrySchema },
    generation_log: { valueSchema: generationLogEntrySchema },
  },
});

// ── 上限 helper（owner：lib/index.js 引用） ─────────────────────────────────

const TABLE_TO_LIMIT_KEY = {
  variants: 'VARIANTS',
  fitness_history: 'FITNESS_HISTORY',
  traffic_log: 'TRAFFIC_LOG',
  generation_log: 'GENERATION_LOG',
};

/**
 * 上限检查：返回 null 表示 OK；返回 `{ table, count, limit, _warn }` 表示超限 warn。
 * 设计稿 §五：超限不抛错、不自动 prune —— 给老板手动留口子
 * （与 agint-diagnosis / agint-evolution-memory 同策略）。
 */
function checkLimit(table, count) {
  const key = TABLE_TO_LIMIT_KEY[table];
  const cap = key ? LIMITS[key] : undefined;
  if (typeof cap === 'number' && count > cap) {
    return { table, count, limit: cap, _warn: `${table} count ${count} > limit ${cap}` };
  }
  return null;
}

// ── 工具函数：随机 id / ISO now ──────────────────────────────────────────────

function randomId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `pop-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso() {
  return new Date().toISOString();
}

// ── entry 从 FROZEN 业务字段包成 storage record ─────────────────────────────

function packVariant(business) {
  return variantEntrySchema.parse({
    id: randomId(),
    kind: 'variant',
    ...business,
  });
}

function packFitnessHistory(business) {
  return fitnessHistoryEntrySchema.parse({
    id: randomId(),
    kind: 'fitness_history',
    ...business,
  });
}

function packTrafficLog(business) {
  return trafficLogEntrySchema.parse({
    id: randomId(),
    kind: 'traffic_log',
    ...business,
  });
}

function packGenerationLog(business) {
  return generationLogEntrySchema.parse({
    id: randomId(),
    kind: 'generation_log',
    ...business,
  });
}

// ── 把 storage record 剥回 FROZEN 业务字段（Service 出口用） ──────────────────
// 注：variant 不剥，因为 variant 本身就是 Service 出口的主表形态（区别于 diagnosis 的 annotation / cluster / report）
// 这里仍保留 unpack* 以保持 API 一致性 + 防止未来扩展。

function unpackVariant(entry) {
  const { id: _id, kind: _kind, ...rest } = entry;
  return rest;
}

function unpackFitnessHistory(entry) {
  const { id: _id, kind: _kind, ...rest } = entry;
  return rest;
}

function unpackTrafficLog(entry) {
  const { id: _id, kind: _kind, ...rest } = entry;
  return rest;
}

function unpackGenerationLog(entry) {
  const { id: _id, kind: _kind, ...rest } = entry;
  return rest;
}

export {
  name,
  spec,
  LIMITS,
  checkLimit,
  packVariant,
  packFitnessHistory,
  packTrafficLog,
  packGenerationLog,
  unpackVariant,
  unpackFitnessHistory,
  unpackTrafficLog,
  unpackGenerationLog,
  randomId,
  nowIso,
  variantEntrySchema,
  fitnessHistoryEntrySchema,
  trafficLogEntrySchema,
  generationLogEntrySchema,
  // 重导出 schema 字段方便 host-side 实现引用
  VariantSchema,
  FitnessHistorySchema,
  TrafficLogSchema,
  GenerationLogSchema,
};
