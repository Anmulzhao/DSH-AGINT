/**
 * agint-curriculum: storage domain 声明 + entry pack/unpack。
 *
 * Sprint14 §4.7：storage domain `agint_curriculum`（独占，schemaVersion 1），
 * 4 张表：challenges / attempts / difficulty_state / audit_log。
 *
 * 上限策略对齐 agint-skill-autocreate / agint-curator：超限 warn 不 prune；
 * 只有 audit_log 自动滚动清理最旧的。
 */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import {
  ChallengeSchema,
  AttemptSchema,
  DifficultyStateSchema,
  AuditLogSchema,
  LIMITS,
} from './schema.js';

// ── storage entry schema（业务字段 + storage metadata）───────────────────

const challengeEntrySchema = ChallengeSchema.extend({
  id: z.string().min(1),
  kind: z.literal('challenge'),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const attemptEntrySchema = AttemptSchema.extend({
  id: z.string().min(1),
  kind: z.literal('attempt'),
});

const difficultyEntrySchema = DifficultyStateSchema.extend({
  id: z.string().min(1),
  kind: z.literal('difficulty_state'),
});

const auditLogEntrySchema = AuditLogSchema.extend({
  id: z.string().min(1),
  kind: z.literal('audit_log'),
});

// ── domain spec ──────────────────────────────────────────────────────────

const name = 'agint-curriculum';

const spec = defineDomain({
  name: 'agint_curriculum',
  version: 1,
  tables: {
    challenges: { valueSchema: challengeEntrySchema },
    attempts: { valueSchema: attemptEntrySchema },
    difficulty_state: { valueSchema: difficultyEntrySchema },
    audit_log: { valueSchema: auditLogEntrySchema },
  },
});

// ── 上限检查 ─────────────────────────────────────────────────────────────

const TABLE_TO_LIMIT_KEY = {
  challenges: 'CHALLENGES',
  attempts: 'ATTEMPTS',
  difficulty_state: 'DIFFICULTY_STATE',
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

function nowIso() {
  return new Date().toISOString();
}

/** 日期前缀 id：形如 clg_20260914_ab12cd */
function datedId(prefix) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const c = globalThis.crypto;
  const rand = c && typeof c.randomUUID === 'function'
    ? c.randomUUID().replace(/-/g, '').slice(0, 6)
    : Math.random().toString(36).slice(2, 8);
  return `${prefix}_${day}_${rand}`;
}

/** 建议的挑战执行 sessionId（D1：curriculum- 前缀，下游黑名单过滤） */
function challengeSessionId(challengeId) {
  return `curriculum-${challengeId}`;
}

// ── pack：业务字段 → storage record（补 metadata）────────────────────────

function packChallenge(business, existing) {
  const now = nowIso();
  return challengeEntrySchema.parse({
    id: existing?.id ?? datedId('clg'),
    kind: 'challenge',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...business,
  });
}

function packAttempt(business) {
  return attemptEntrySchema.parse({
    id: datedId('att'),
    kind: 'attempt',
    ...business,
  });
}

function packDifficulty(business, existing) {
  const now = nowIso();
  return difficultyEntrySchema.parse({
    id: existing?.id ?? `df_${business.domain}`,
    kind: 'difficulty_state',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
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
  nowIso,
  datedId,
  challengeSessionId,
  packChallenge,
  packAttempt,
  packDifficulty,
  packAudit,
  challengeEntrySchema,
  attemptEntrySchema,
  difficultyEntrySchema,
  auditLogEntrySchema,
};
