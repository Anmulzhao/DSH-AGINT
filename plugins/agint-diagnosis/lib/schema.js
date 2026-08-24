/**
 * agint-diagnosis: FROZEN schema definitions.
 *
 * 严格按设计稿 `wiki/AGINT/sprint-7-设计稿-2026-08.md` §2.1 / §2.5 落地。
 * 4 个 FROZEN schema（不要改字段名 / 不要改 enum 顺序）：
 *   - RootCauseKindSchema       enum 7 类根因 + UNCERTAIN 兜底
 *   - AnnotationSchema          { failureId, rootCause, confidence, evidence }
 *   - ClusterSchema             { pattern, count, sampleFailureIds }
 *   - DiagnosisReportSchema     { windowDays, generatedAt, annotationCount, clusterCount, rootCauseDistribution }
 *
 * 变更流程：任何 FROZEN schema 字段调整必须先经人类多签 + 设计稿修订
 * （设计稿 §七 L0 治理）。
 *
 * Storage domain：agint_diagnosis（三表 annotations/clusters/reports，
 * LIMITS 同设计稿 §2.2：200/50/50）。
 *
 * 本文件导出的「FROZEN schema」即 Service 入参 / 出参契约；storage entry
 * 的内部 metadata（id / kind / createdAt）在 storage.js 内部定义，不混入
 * FROZEN 层。
 */

import { z } from 'zod';

// ── FROZEN enum ──────────────────────────────────────────────────────────

/**
 * RootCauseKindSchema（FROZEN，7 类枚举）。
 * - 6 类根因 + UNCERTAIN 兜底
 * - 判定算法按特征投票（设计稿 §2.3）
 * - UNCERTAIN 兜底写 agint-memory，不进 failure_pattern（设计稿 §2.2 / §八）
 */
export const RootCauseKindSchema = z.enum([
  'PROMPT_DEFICIENCY',
  'TOOL_GAP',
  'KNOWLEDGE_GAP',
  'REASONING_ERROR',
  'PLANNING_FAILURE',
  'ENVIRONMENT_SHIFT',
  'UNCERTAIN',
]);

export const ROOT_CAUSE_KINDS = Object.freeze([
  'PROMPT_DEFICIENCY',
  'TOOL_GAP',
  'KNOWLEDGE_GAP',
  'REASONING_ERROR',
  'PLANNING_FAILURE',
  'ENVIRONMENT_SHIFT',
  'UNCERTAIN',
]);

/** 是否「可信 6 类」之一（非兜底）。 */
export function isConfidentRootCause(kind) {
  return kind !== 'UNCERTAIN';
}

// ── FROZEN AnnotationSchema（设计稿 §2.1 入参 / 出参契约）───────────────

/**
 * AnnotationSchema（FROZEN）。
 * 字段对齐设计稿原文（§2.1 + §2.2 输出侧）：
 *   failureId   来自 agint-evolution-memory failure_pattern.id
 *   rootCause   FROZEN enum 7 类
 *   confidence  0..1，判定算法给出（启发式估计，docs 明示）
 *   evidence    支撑判定的关键特征引用（trajectory 片段 / pattern 文本）
 */
export const AnnotationSchema = z.object({
  failureId: z.string().min(1),
  rootCause: RootCauseKindSchema,
  confidence: z.number().min(0).max(1),
  evidence: z.string(),
});

// ── FROZEN ClusterSchema（设计稿 §2.1 + §2.5）───────────────────────────

/**
 * ClusterSchema（FROZEN）。
 * 字段对齐设计稿原文：
 *   pattern              聚类依据的子串（来自 failure_pattern.pattern）
 *   count                本聚类下失败条目数
 *   sampleFailureIds     样本 failureId 列表（保留原始 evidence 链接）
 */
export const ClusterSchema = z.object({
  pattern: z.string().min(1),
  count: z.number().int().min(1),
  sampleFailureIds: z.array(z.string().min(1)),
});

// ── FROZEN DiagnosisReportSchema（设计稿 §2.1 + §验收）──────────────────

/**
 * DiagnosisReportSchema（FROZEN）。
 * 字段对齐设计稿原文：
 *   windowDays               报告覆盖窗口（天数）
 *   generatedAt              报告生成时间 ISO 字符串
 *   annotationCount          该窗口内 annotation 数
 *   clusterCount             该窗口内 cluster 数
 *   rootCauseDistribution    map<RootCauseKind, count>，7 个 key 一项不缺
 */
export const RootCauseDistributionSchema = z.record(
  RootCauseKindSchema,
  z.number().int().min(0),
);

export const DiagnosisReportSchema = z.object({
  windowDays: z.number().int().min(1).max(365),
  generatedAt: z.string(),
  annotationCount: z.number().int().min(0),
  clusterCount: z.number().int().min(0),
  rootCauseDistribution: RootCauseDistributionSchema,
});

// ── 上限常量（设计稿 §2.2 + 验收 §三）───────────────────────────────────

export const LIMITS = Object.freeze({
  ANNOTATIONS: 200,
  CLUSTERS: 50,
  REPORTS: 50,
});

// ── helpers（不修改 FROZEN 契约）────────────────────────────────────────

/** 校验一个对象是否是合法 Annotation；返回 boolean 而非抛错。 */
export function isAnnotation(value) {
  return AnnotationSchema.safeParse(value).success;
}

/** 7 类根因的零分布表（写 DiagnosisReportDistribution 时初始化用）。 */
export function emptyRootCauseDistribution() {
  const out = {};
  for (const k of ROOT_CAUSE_KINDS) out[k] = 0;
  return out;
}
