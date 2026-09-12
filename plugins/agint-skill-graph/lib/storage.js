/**
 * agint-skill-graph: storage domain 声明 + entry pack/unpack。
 *
 * 上游设计 §3.1：独立域 `agint_skill_graph`（独占，schemaVersion 1），三张表：
 *   usage_stats  技能级统计（每技能一行，周更全量刷新）
 *   skill_edges  边表（edgeId 主键，同 src/dst/type 覆盖写）
 *   graph_meta   全局元数据（单行）
 *
 * 上限策略对齐 curator / autocreate：超限 warn 不 prune。
 * dsh-storage-json **版本不匹配无自动迁移**（curator v0.2.0 教训）→ 首版一次定够。
 */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

import { DOMAIN_NAME, SCHEMA_VERSION, UsageStatsSchema, SkillEdgeSchema, GraphMetaSchema } from './schema.js';

// ── storage entry schema（业务字段 + storage metadata）───────────────────

export const usageStatsEntrySchema = UsageStatsSchema.extend({
  id: z.string().min(1),
  kind: z.literal('usage_stats'),
  createdAt: z.string(),
});

export const skillEdgeEntrySchema = SkillEdgeSchema.extend({
  id: z.string().min(1),
  kind: z.literal('skill_edge'),
  updatedAt: z.string(),
});

export const graphMetaEntrySchema = GraphMetaSchema.extend({
  id: z.string().min(1),
  kind: z.literal('graph_meta'),
  createdAt: z.string(),
});

export const spec = defineDomain({
  name: DOMAIN_NAME,
  version: SCHEMA_VERSION,
  tables: {
    usage_stats: { valueSchema: usageStatsEntrySchema },
    skill_edges: { valueSchema: skillEdgeEntrySchema },
    graph_meta: { valueSchema: graphMetaEntrySchema },
  },
});

export const META_ID = 'graph_meta';

// ── 上限检查（超限 warn 不 prune）────────────────────────────────────────

const TABLE_TO_LIMIT_KEY = {
  usage_stats: 'usage_stats',
  skill_edges: 'skill_edges',
};

export function checkLimit(table, count, limits) {
  const key = TABLE_TO_LIMIT_KEY[table];
  const cap = key ? limits?.[key] : undefined;
  if (typeof cap === 'number' && count > cap) {
    return { table, count, limit: cap, _warn: `${table} count ${count} > limit ${cap}` };
  }
  return null;
}

// ── 工具函数 ─────────────────────────────────────────────────────────────

export function nowIso() {
  return new Date().toISOString();
}

/** ISO 周标签：2026-W37（与 curator reports 表同口径） */
export function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ── pack：业务字段 → storage record（补 metadata）────────────────────────

export function packUsageStats(business, existing) {
  const now = nowIso();
  return usageStatsEntrySchema.parse({
    id: existing?.id ?? business.skillName,
    kind: 'usage_stats',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...business,
  });
}

export function packEdge(edge) {
  return skillEdgeEntrySchema.parse({
    id: edge.edgeId,
    kind: 'skill_edge',
    updatedAt: nowIso(),
    ...edge,
  });
}

export function packMeta(business, existing) {
  const now = nowIso();
  // 剥掉 storage metadata 后再 spread，否则会把旧的 updatedAt 带回来（覆盖成过期值）
  const { id: _id, kind: _kind, createdAt: _c, updatedAt: _u, ...rest } = business ?? {};
  return graphMetaEntrySchema.parse({
    id: META_ID,
    kind: 'graph_meta',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...rest,
  });
}

/** 空元数据（表为空 / 首次运行） */
export function emptyMeta() {
  return packMeta({});
}
