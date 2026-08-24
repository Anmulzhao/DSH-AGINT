/**
 * agint-diagnosis: storage domain 声明 + entry schema + LIMITS helpers。
 *
 * 设计（设计稿 §2.1 / §2.2）：
 *   - storage domain 名：agint_diagnosis（与 agint / agint_evolution /
 *     agint_rules / agint_metrics 互斥）
 *   - 三张表：annotations / clusters / reports
 *   - 上限：200 / 50 / 50（设计稿 §2.2）
 *
 * Entry 字段设计：
 *   - annotations/clusters/reports 的「业务字段」严格按设计稿 FROZEN schema
 *     （见 ./schema.js）
 *   - 额外 metadata：id / kind / createdAt，供存储引擎需要 + 衰减 hook 接入
 *     （storage 内部约定，不污染 FROZEN 服务契约）
 *   - FROZEN Service 出口（簇 annotate/cluster/report）只暴露 FROZEN 字段，
 *     storage ↔ service 之间的 metadata 转换全部在 lib/index.js 内完成
 */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import {
  AnnotationSchema,
  ClusterSchema,
  DiagnosisReportSchema,
  LIMITS,
} from './schema.js';

// ── storage entry schema（带 metadata）────────────────────────────────────
//
// 这里的 schema 是 storage 层 KV record 的形态：包含 FROZEN 业务字段 +
// storage 内部 metadata。FROZEN Service 接口会剥掉 metadata，只把业务
// 字段返回给调用方。

const annotationEntrySchema = AnnotationSchema.extend({
  id: z.string().min(1),
  kind: z.literal('annotation'),
  createdAt: z.string(),
});

const clusterEntrySchema = ClusterSchema.extend({
  id: z.string().min(1),
  kind: z.literal('cluster'),
  createdAt: z.string(),
});

const reportEntrySchema = DiagnosisReportSchema.extend({
  id: z.string().min(1),
  kind: z.literal('report'),
});

// ── storage domain spec ──────────────────────────────────────────────────

const name = 'agint-diagnosis';

const spec = defineDomain({
  name: 'agint_diagnosis',
  version: 1,
  tables: {
    annotations: { valueSchema: annotationEntrySchema },
    clusters: { valueSchema: clusterEntrySchema },
    reports: { valueSchema: reportEntrySchema },
  },
});

// ── 上限 helper（owner：lib/index.js 引用）────────────────────────────────

const TABLE_TO_LIMIT_KEY = {
  annotations: 'ANNOTATIONS',
  clusters: 'CLUSTERS',
  reports: 'REPORTS',
};

/**
 * 上限检查：返回 null 表示 OK；返回 `{ table, count, limit, _warn }` 表示超限 warn。
 * 设计稿 §五：超限不抛错、不自动 prune——给老板手动留口子
 * （与 agint-evolution-memory 同策略）。
 */
function checkLimit(table, count) {
  const key = TABLE_TO_LIMIT_KEY[table];
  const cap = key ? LIMITS[key] : undefined;
  if (typeof cap === 'number' && count > cap) {
    return { table, count, limit: cap, _warn: `${table} count ${count} > limit ${cap}` };
  }
  return null;
}

// ── 工具函数：随机 id / ISO now ──────────────────────────────────────────

function randomId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `d-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso() {
  return new Date().toISOString();
}

// ── entry 从 FROZEN 业务字段包成 storage record ──────────────────────────

function packAnnotation(business) {
  return annotationEntrySchema.parse({
    id: randomId(),
    kind: 'annotation',
    createdAt: nowIso(),
    ...business,
  });
}

function packCluster(business) {
  return clusterEntrySchema.parse({
    id: randomId(),
    kind: 'cluster',
    createdAt: nowIso(),
    ...business,
  });
}

function packReport(business) {
  return reportEntrySchema.parse({
    id: randomId(),
    kind: 'report',
    ...business,
  });
}

// ── 把 storage record 剥回 FROZEN 业务字段（Service 出口用）───────────────

function unpackAnnotation(entry) {
  return {
    failureId: entry.failureId,
    rootCause: entry.rootCause,
    confidence: entry.confidence,
    evidence: entry.evidence,
  };
}

function unpackCluster(entry) {
  return {
    pattern: entry.pattern,
    count: entry.count,
    sampleFailureIds: entry.sampleFailureIds,
  };
}

function unpackReport(entry) {
  return {
    windowDays: entry.windowDays,
    generatedAt: entry.generatedAt,
    annotationCount: entry.annotationCount,
    clusterCount: entry.clusterCount,
    rootCauseDistribution: entry.rootCauseDistribution,
  };
}

export {
  name,
  spec,
  LIMITS,
  checkLimit,
  packAnnotation,
  packCluster,
  packReport,
  unpackAnnotation,
  unpackCluster,
  unpackReport,
  randomId,
  nowIso,
  annotationEntrySchema,
  clusterEntrySchema,
  reportEntrySchema,
};
