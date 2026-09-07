/**
 * agint-curator: storage domain 声明 + entry pack/unpack。
 *
 * Sprint14 §3.2：storage domain `agint_curator`（独占，schemaVersion 1），
 * 4 张表：skill_states / curation_actions / reports / audit_log。
 *
 * 上限策略对齐 agint-skill-autocreate：超限 warn 不 prune；只有 audit_log
 * 自动滚动清理最旧的。
 */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import {
  SkillStateSchema,
  CurationActionSchema,
  CurationReportSchema,
  AuditLogSchema,
  OverlapCandidateSchema,
  LIMITS,
} from './schema.js';

// ── storage entry schema（业务字段 + storage metadata）───────────────────

const skillStateEntrySchema = SkillStateSchema.extend({
  id: z.string().min(1),
  kind: z.literal('skill_state'),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const curationActionEntrySchema = CurationActionSchema.extend({
  id: z.string().min(1),
  kind: z.literal('curation_action'),
});

const reportEntrySchema = CurationReportSchema.extend({
  id: z.string().min(1),
  kind: z.literal('curation_report'),
});

const auditLogEntrySchema = AuditLogSchema.extend({
  id: z.string().min(1),
  kind: z.literal('audit_log'),
});

// Sprint 15：overlap_candidates 表（P0-2 §4.4）
const overlapCandidateEntrySchema = OverlapCandidateSchema.extend({
  id: z.string().min(1),
  kind: z.literal('overlap_candidate'),
  detectedAt: z.string(),
});

// ── domain spec ──────────────────────────────────────────────────────────

const name = 'agint-curator';

const spec = defineDomain({
  name: 'agint_curator',
  version: 2, // Sprint 15：增 overlap_candidates 表 + skill_states.quality
  tables: {
    skill_states: { valueSchema: skillStateEntrySchema },
    curation_actions: { valueSchema: curationActionEntrySchema },
    reports: { valueSchema: reportEntrySchema },
    audit_log: { valueSchema: auditLogEntrySchema },
    overlap_candidates: { valueSchema: overlapCandidateEntrySchema },
  },
});

// ── 上限检查 ─────────────────────────────────────────────────────────────

const TABLE_TO_LIMIT_KEY = {
  skill_states: 'SKILL_STATES',
  curation_actions: 'CURATION_ACTIONS',
  reports: 'REPORTS',
  audit_log: 'AUDIT_LOG',
  overlap_candidates: 'OVERLAP_CANDIDATES',
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

/** 日期前缀 id：形如 ss_20260914_ab12cd */
function datedId(prefix) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const c = globalThis.crypto;
  const rand = c && typeof c.randomUUID === 'function'
    ? c.randomUUID().replace(/-/g, '').slice(0, 6)
    : Math.random().toString(36).slice(2, 8);
  return `${prefix}_${day}_${rand}`;
}

/** ISO 周标签：2026-W37（Sprint14 §3.2 reports 表按周） */
function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ── pack：业务字段 → storage record（补 metadata）────────────────────────

function packSkillState(business, existing) {
  const now = nowIso();
  return skillStateEntrySchema.parse({
    id: existing?.id ?? datedId('ss'),
    kind: 'skill_state',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...business,
  });
}

function packCurationAction(business) {
  return curationActionEntrySchema.parse({
    id: datedId('ca'),
    kind: 'curation_action',
    timestamp: nowIso(),
    actor: business?.actor ?? 'system',
    ...business,
  });
}

function packReport(business, existing) {
  return reportEntrySchema.parse({
    id: existing?.id ?? `rep_${business.week}`,
    kind: 'curation_report',
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

/** Sprint 15：重叠候选对 → 记录（每周覆盖同对旧记录，避免堆积） */
function packOverlapCandidate(business) {
  return overlapCandidateEntrySchema.parse({
    id: datedId('oc'),
    kind: 'overlap_candidate',
    detectedAt: nowIso(),
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
  isoWeek,
  packSkillState,
  packCurationAction,
  packReport,
  packAudit,
  packOverlapCandidate,
  skillStateEntrySchema,
  curationActionEntrySchema,
  reportEntrySchema,
  auditLogEntrySchema,
  overlapCandidateEntrySchema,
};
