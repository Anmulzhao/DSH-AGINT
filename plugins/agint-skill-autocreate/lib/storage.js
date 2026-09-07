/**
 * agint-skill-autocreate: storage domain 声明 + entry pack/unpack。
 *
 * 设计稿 §4.1：storage domain `agint_skill_autocreate`（与 agint /
 * agint_evolution / agint_diagnosis / agint_metrics 互斥），5 张表：
 *   task_patterns / candidates / proposals / releases / audit_log
 *
 * proposals / releases 表在 Sprint 14 先建（避免后续 schemaVersion 破环性
 * 变更），Sprint 15/16 才写入。
 */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import {
  TaskPatternSchema,
  CandidateSchema,
  AuditLogSchema,
  LIMITS,
} from './schema.js';

// ── storage entry schema（业务字段 + storage metadata）──────────────────

const taskPatternEntrySchema = TaskPatternSchema.extend({
  id: z.string().min(1),
  kind: z.literal('task_pattern'),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const candidateEntrySchema = CandidateSchema.extend({
  id: z.string().min(1),
  kind: z.literal('skill_candidate'),
  createdAt: z.string(),
});

// releases 表 Sprint 16 写入；schema 按设计稿 §4.4 预置（宽松，防过早 FROZEN）
const releaseEntrySchema = z.object({
  id: z.string().min(1),
  kind: z.literal('skill_release'),
  createdAt: z.string(),
  candidateId: z.string(),
  skillName: z.string(),
  version: z.string(),
  snapshot: z.record(z.any()).default({}),
  observationEndAt: z.string().nullable().default(null),
  observationMetrics: z.record(z.any()).nullable().default(null),
  status: z.enum(['OBSERVING', 'STABLE', 'ROLLED_BACK']).default('OBSERVING'),
  rollbackAt: z.string().nullable().default(null),
  rollbackReason: z.string().nullable().default(null),
});

// proposals 表 Sprint 15 写入（Phase 3 通过后转正）；§7.2 字段（rankingScore /
// evidenceLevel / provisional / status='QUEUED_FOR_RELEASE'）Sprint 15 扩展落地，
// 保持宽松（skillDraft / evalResults 为 record，防 schemaVersion 破环性变更）
const proposalEntrySchema = z.object({
  id: z.string().min(1),
  kind: z.literal('skill_proposal'),
  createdAt: z.string(),
  candidateId: z.string(),
  skillDraft: z.record(z.any()),
  evalResults: z.record(z.any()).default({}),
  // ── Sprint 15 §7.2（P0-1 输出 → P0-2 策展人排序消费）──
  rankingScore: z.number().nullable().default(null),
  evidenceLevel: z.enum(['E0', 'E1']).nullable().default(null),
  provisional: z.boolean().default(true),
  status: z.enum(['QUEUED_FOR_RELEASE']).default('QUEUED_FOR_RELEASE'),
  estimatedBenefit: z.record(z.any()).nullable().default(null),
});

const auditLogEntrySchema = AuditLogSchema.extend({
  id: z.string().min(1),
  kind: z.literal('audit_log'),
});

// ── domain spec ──────────────────────────────────────────────────────────

const name = 'agint-skill-autocreate';

const spec = defineDomain({
  name: 'agint_skill_autocreate',
  version: 1,
  tables: {
    task_patterns: { valueSchema: taskPatternEntrySchema },
    candidates: { valueSchema: candidateEntrySchema },
    proposals: { valueSchema: proposalEntrySchema },
    releases: { valueSchema: releaseEntrySchema },
    audit_log: { valueSchema: auditLogEntrySchema },
  },
});

// ── 上限检查（§4：超限 warn，不自动 prune；audit_log 例外滚动清理）────────

const TABLE_TO_LIMIT_KEY = {
  task_patterns: 'TASK_PATTERNS',
  candidates: 'CANDIDATES',
  proposals: 'CANDIDATES', // 设计稿未单列 proposals 上限，跟随 candidates
  releases: 'RELEASES',
  audit_log: 'AUDIT_LOG',
};

function checkLimit(table, count) {
  const key = TABLE_TO_LIMIT_KEY[table];
  const cap = key ? LIMITS[key] : undefined;
  if (typeof cap === 'number' && count > cap) {
    return { table, count, limit: cap, _warn: `${table} count ${count} > limit ${cap}` };
  }
  return null;
}

// ── 工具函数 ─────────────────────────────────────────────────────────────

function randomId(prefix) {
  const c = globalThis.crypto;
  const uuid = c && typeof c.randomUUID === 'function' ? c.randomUUID() : `d-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}_${uuid}` : uuid;
}

function nowIso() {
  return new Date().toISOString();
}

/** 日期前缀 id：设计稿示例形如 tp_20260907_001；这里用 tp_YYYYMMDD_<uuid 前 6 位> */
function datedId(prefix) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const c = globalThis.crypto;
  const rand = c && typeof c.randomUUID === 'function'
    ? c.randomUUID().replace(/-/g, '').slice(0, 6)
    : Math.random().toString(36).slice(2, 8);
  return `${prefix}_${day}_${rand}`;
}

// ── pack：业务字段 → storage record（补 metadata）────────────────────────

function packTaskPattern(business, existing) {
  const now = nowIso();
  return taskPatternEntrySchema.parse({
    id: existing?.id ?? datedId('tp'),
    kind: 'task_pattern',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...business,
  });
}

function packCandidate(business) {
  return candidateEntrySchema.parse({
    id: datedId('sc'),
    kind: 'skill_candidate',
    createdAt: nowIso(),
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
  checkLimit,
  randomId,
  nowIso,
  datedId,
  packTaskPattern,
  packCandidate,
  packAudit,
  taskPatternEntrySchema,
  candidateEntrySchema,
  releaseEntrySchema,
  proposalEntrySchema,
  auditLogEntrySchema,
};
