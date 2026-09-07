/**
 * agint-memory-provider: storage domain 声明 + entry pack + 上限滚动清理。
 *
 * 设计稿 §4.1：storage domain `agint_memory_provider`（与 agint /
 * agint_evolution / agint_skill_autocreate / agint_diagnosis 互斥），5 张表：
 *   provider_config / activation_log / fallback_events /
 *   pre_compress_checkpoints / audit_log
 *
 * fallback_events / pre_compress_checkpoints 在 Sprint 16 写入；本 Sprint 先建
 * 表（避免后续 schemaVersion 破环性变更，与 skill-autocreate 预置
 * proposals/releases 同策略）。
 *
 * ⚠️ 存储域契约（dsh-storage-domain lib/types/domain.d.ts）：
 *   - 表 API 是 get / entries / keys / size / put / delete / update
 *     —— **没有 `del`**（既有 agint-skill-autocreate 的 delOf 兜底恒走 reject
 *     分支，本插件不复用该写法）。
 *   - 返回的记录是存储对象本身（无防御性拷贝），**禁止原地修改**；
 *     要改必须整条 put/update。故本模块所有对外返回都走浅拷贝。
 */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import {
  ProviderConfigSchema,
  ActivationLogSchema,
  FallbackEventSchema,
  PreCompressCheckpointSchema,
  AuditLogSchema,
  LIMITS,
  ROLLING_TABLES,
} from './schema.js';

// ── storage entry schema（业务字段 + storage metadata）──────────────────

const providerConfigEntrySchema = ProviderConfigSchema.extend({
  id: z.string().min(1),
  kind: z.literal('provider_config'),
});

const activationLogEntrySchema = ActivationLogSchema.extend({
  id: z.string().min(1),
  kind: z.literal('activation_log'),
});

const fallbackEventEntrySchema = FallbackEventSchema.extend({
  id: z.string().min(1),
  kind: z.literal('fallback_event'),
});

const preCompressCheckpointEntrySchema = PreCompressCheckpointSchema.extend({
  id: z.string().min(1),
  kind: z.literal('pre_compress_checkpoint'),
});

const auditLogEntrySchema = AuditLogSchema.extend({
  id: z.string().min(1),
  kind: z.literal('audit_log'),
});

// ── domain spec ──────────────────────────────────────────────────────────

const name = 'agint-memory-provider';

const spec = defineDomain({
  name: 'agint_memory_provider',
  version: 1,
  tables: {
    provider_config: { valueSchema: providerConfigEntrySchema },
    activation_log: { valueSchema: activationLogEntrySchema },
    fallback_events: { valueSchema: fallbackEventEntrySchema },
    pre_compress_checkpoints: { valueSchema: preCompressCheckpointEntrySchema },
    audit_log: { valueSchema: auditLogEntrySchema },
  },
});

// ── 上限检查（§4：ROLLING_TABLES 滚动清理最旧，其余仅 warn）──────────────

const TABLE_TO_LIMIT_KEY = Object.freeze({
  provider_config: 'PROVIDER_CONFIG',
  activation_log: 'ACTIVATION_LOG',
  fallback_events: 'FALLBACK_EVENTS',
  pre_compress_checkpoints: 'PRE_COMPRESS_CHECKPOINTS',
  audit_log: 'AUDIT_LOG',
});

function limitOf(tableName) {
  const key = TABLE_TO_LIMIT_KEY[tableName];
  return key ? LIMITS[key] : undefined;
}

function checkLimit(tableName, count) {
  const cap = limitOf(tableName);
  if (typeof cap === 'number' && count > cap) {
    return { table: tableName, count, limit: cap, _warn: `${tableName} count ${count} > limit ${cap}` };
  }
  return null;
}

/** 该表超限是否自动滚动清理（§4.3 / §4.4 / §4.6） */
function isRolling(tableName) {
  return ROLLING_TABLES.includes(tableName);
}

/**
 * 滚动清理：按 timestamp 升序删最旧的，直到不超过上限。
 * 只对 ROLLING_TABLES 生效；其余表仅返回 warn 不动数据。
 * @returns {Promise<number>} 实际删除条数
 */
async function pruneOldest(t, tableName) {
  const cap = limitOf(tableName);
  if (typeof cap !== 'number' || !isRolling(tableName)) return 0;
  const overflow = t.size - cap;
  if (overflow <= 0) return 0;
  const sorted = [...t.entries()].sort(
    (a, b) => String(a[1].timestamp).localeCompare(String(b[1].timestamp)),
  );
  let removed = 0;
  for (const [key] of sorted.slice(0, overflow)) {
    // delete 返回 false 表示记录已不存在，不算删除
    if (await t.delete(key)) removed += 1;
  }
  return removed;
}

// ── 工具函数 ─────────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

/** 日期前缀 id：<prefix>_YYYYMMDD_<6 位随机>（与 skill-autocreate 同风格） */
function datedId(prefix) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const c = globalThis.crypto;
  const rand = c && typeof c.randomUUID === 'function'
    ? c.randomUUID().replace(/-/g, '').slice(0, 6)
    : Math.random().toString(36).slice(2, 8);
  return `${prefix}_${day}_${rand}`;
}

// ── pack：业务字段 → storage record（补 metadata）────────────────────────

/** provider_config 以 providerName 派生稳定 id（§4.2：每个 provider 一条） */
function providerConfigId(providerName) {
  return `pc_${String(providerName).replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

function packProviderConfig(business, existing) {
  return providerConfigEntrySchema.parse({
    id: existing?.id ?? providerConfigId(business.providerName),
    kind: 'provider_config',
    updatedAt: nowIso(),
    ...business,
  });
}

function packActivationLog(business) {
  return activationLogEntrySchema.parse({
    id: datedId('al'),
    kind: 'activation_log',
    timestamp: nowIso(),
    ...business,
  });
}

function packFallbackEvent(business) {
  return fallbackEventEntrySchema.parse({
    id: datedId('fe'),
    kind: 'fallback_event',
    timestamp: nowIso(),
    ...business,
  });
}

function packCheckpoint(business) {
  return preCompressCheckpointEntrySchema.parse({
    id: datedId('pcc'),
    kind: 'pre_compress_checkpoint',
    timestamp: nowIso(),
    ...business,
  });
}

function packAudit(business) {
  return auditLogEntrySchema.parse({
    id: datedId('audit'),
    kind: 'audit_log',
    timestamp: nowIso(),
    ...business,
  });
}

export {
  name,
  spec,
  LIMITS,
  ROLLING_TABLES,
  checkLimit,
  limitOf,
  isRolling,
  pruneOldest,
  nowIso,
  datedId,
  providerConfigId,
  packProviderConfig,
  packActivationLog,
  packFallbackEvent,
  packCheckpoint,
  packAudit,
  providerConfigEntrySchema,
  activationLogEntrySchema,
  fallbackEventEntrySchema,
  preCompressCheckpointEntrySchema,
  auditLogEntrySchema,
};
