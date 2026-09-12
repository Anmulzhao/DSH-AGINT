/**
 * agint-compress-guard: storage domain 声明 + entry pack + 滚动清理。
 *
 * 独立域 `agint_compress_guard`（schemaVersion 1，设计稿 §3.1），4 表：
 *   insights / guard_log / counters / config
 *
 * 与 P1-1 的关系（Q3「分层不重建」）：raw 快照唯一事实源是 P1-1 的
 * pre_compress_checkpoints 表；本域只存 checkpointRef 引用 + 字节数，
 * 不复制 raw blob。raw 生命周期归 P1-1 管，prune 策略简单。
 *
 * ⚠️ 存储域契约（对齐 agint-memory-provider/lib/storage.js 头注）：
 *   - 表 API 是 get / entries / keys / size / put / delete / update（没有 del）
 *   - 返回记录是存储对象本身，**禁止原地修改**；对外一律浅拷贝
 */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import {
  InsightSchema,
  GuardLogSchema,
  CountersSchema,
  ConfigRecordSchema,
  LIMITS,
  ROLLING_TABLES,
  datedId,
  nowIso,
} from './schema.js';

const insightEntrySchema = InsightSchema.extend({
  id: z.string().min(1),
  kind: z.literal('insight'),
});

const guardLogEntrySchema = GuardLogSchema.extend({
  id: z.string().min(1),
  kind: z.literal('guard_log'),
});

const countersEntrySchema = CountersSchema.extend({
  id: z.literal('counters'),
  kind: z.literal('counters'),
  updatedAt: z.string().min(1),
});

const configEntrySchema = ConfigRecordSchema.extend({
  id: z.literal('config'),
  kind: z.literal('config'),
  updatedAt: z.string().min(1),
});

const PLUGIN_NAME = 'agint-compress-guard';

const spec = defineDomain({
  name: 'agint_compress_guard',
  version: 1,
  tables: {
    insights: { valueSchema: insightEntrySchema },
    guard_log: { valueSchema: guardLogEntrySchema },
    counters: { valueSchema: countersEntrySchema },
    config: { valueSchema: configEntrySchema },
  },
});

// ── 上限检查（guard_log 滚动清理；insights 只增不改仅 warn）───────────────

const TABLE_TO_LIMIT_KEY = Object.freeze({
  insights: 'INSIGHTS',
  guard_log: 'GUARD_LOG',
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

function isRolling(tableName) {
  return ROLLING_TABLES.includes(tableName);
}

/** 滚动清理：按 startedAt 升序删最旧，直到不超过上限。仅 guard_log 生效。 */
async function pruneOldest(t, tableName) {
  const cap = limitOf(tableName);
  if (typeof cap !== 'number' || !isRolling(tableName)) return 0;
  const overflow = t.size - cap;
  if (overflow <= 0) return 0;
  const sorted = [...t.entries()].sort(
    (a, b) => String(a[1].startedAt ?? a[1].id).localeCompare(String(b[1].startedAt ?? b[1].id)),
  );
  let removed = 0;
  for (const [key] of sorted.slice(0, overflow)) {
    if (await t.delete(key)) removed += 1;
  }
  return removed;
}

// ── pack：业务字段 → storage record（补 metadata，产出新对象）────────────

/** 洞察 id：ins_<date>_<8 位 hash>（设计稿 §3.1） */
function insightId(content, extractedAt) {
  const day = String(extractedAt ?? nowIso()).slice(0, 10).replace(/-/g, '');
  let h = 0;
  const s = String(content ?? '');
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  const hash = (h >>> 0).toString(16).padStart(8, '0');
  return `ins_${day}_${hash}`;
}

function packInsight(business) {
  const extractedAt = business.source?.checkpointRef?.extractedAt ?? nowIso();
  return insightEntrySchema.parse({
    id: insightId(business.content, extractedAt),
    kind: 'insight',
    recallCount: 0,
    lastRecalledAt: null,
    supersededBy: null,
    linkPending: false,
    retention: 'normal',
    ...business,
  });
}

function packGuardLog(business) {
  return guardLogEntrySchema.parse({
    id: datedId('gl'),
    kind: 'guard_log',
    note: null,
    ...business,
  });
}

export function emptyCounters() {
  return {
    extractFailures: 0,
    checkpointWriteFailures: 0,
    recallMisses: 0,
    recallHits: 0,
    p1CheckpointsSeen: 0,
    hostCompactionsSeen: 0,
    disabledPassThrough: 0,
    blockedShadowed: 0,
    recoveryProbes: 0,
  };
}

/** counters 单例：business 为增量 delta（与现有值合并由 engine 负责） */
function packCounters(business, existing) {
  return countersEntrySchema.parse({
    id: 'counters',
    kind: 'counters',
    updatedAt: nowIso(),
    ...(existing ?? emptyCounters()),
    ...business,
  });
}

function packConfig(business, existing) {
  return configEntrySchema.parse({
    id: 'config',
    kind: 'config',
    updatedAt: nowIso(),
    ...existing,
    ...business,
  });
}

export {
  PLUGIN_NAME,
  spec,
  LIMITS,
  ROLLING_TABLES,
  checkLimit,
  isRolling,
  pruneOldest,
  insightId,
  packInsight,
  packGuardLog,
  packCounters,
  packConfig,
  insightEntrySchema,
  guardLogEntrySchema,
};
