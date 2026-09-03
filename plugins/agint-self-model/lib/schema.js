/**
 * lib/schema.js — agint-self-model v0.7.1 FROZEN schema + 常量
 *
 * 设计稿 Sprint13 §4.3（严格对齐 self-model.schema.yaml）：
 *   - CapabilityEntry 7 字段：domain / capability / status / confidence /
 *     evidenceRefs / lastVerifiedAt / updatedAt
 *   - status enum FROZEN：['CAN', 'CANNOT', 'UNCERTAIN']
 *   - lastVerifiedAt 必填（空字符串硬抛错，对齐 event-bus sync reason 惯例）
 *   - SelfModelSnapshot 4 块
 *   - CalibrationResult 5 字段
 *
 * FROZEN：与 yaml 同时冻结；变更走 L0 治理（人类多签 + 影子 + major）。
 *
 * 本文件是「存储域独占（agint_self_model，4 表）」的 schema 来源
 * （设计稿 §4.2）；上限对齐 diagnosis（200/50/50 量级）。
 */

import { z } from 'zod';

// ── FROZEN enum ──────────────────────────────────────────────────────────

/** 能力三态（FROZEN；D7 真实 > 讨好） */
export const CapabilityStatusSchema = z.enum(['CAN', 'CANNOT', 'UNCERTAIN']);

/** update 触发器（FROZEN；设计稿 §4.3） */
export const UpdateTriggerSchema = z.enum([
  'task-completed',
  'task-failed',
  'diagnosis-completed',
  'dream-completed',
  'weekly',
]);

export const UPDATE_TRIGGERS = Object.freeze([
  'task-completed',
  'task-failed',
  'diagnosis-completed',
  'dream-completed',
  'weekly',
]);

// ── FROZEN CapabilityEntry ───────────────────────────────────────────────

export const CapabilityEntrySchema = z.object({
  domain: z.string().min(1),
  capability: z.string().min(1),
  status: CapabilityStatusSchema,
  confidence: z.number().min(0).max(1),
  evidenceRefs: z.array(z.string()),
  // 必填：空字符串硬抛错（对齐 event-bus sync reason 惯例）
  lastVerifiedAt: z.string().min(1, {
    message: 'lastVerifiedAt is required (empty string hard-throws)',
  }),
  updatedAt: z.string(),
});

// ── FROZEN SelfModelSnapshot ─────────────────────────────────────────────

export const ReasoningAspectSchema = z.enum([
  'strategy-preference',
  'error-condition',
  'chain-break',
  'bias',
]);

export const ResourceMetricSchema = z.enum([
  'context-window',
  'tool-cost-ms',
  'tool-cost-token',
  'latency-ms',
  'knowledge-cutoff',
]);

export const SelfModelSnapshotSchema = z.object({
  capabilities: z.array(CapabilityEntrySchema),
  reasoningProfile: z.array(z.object({
    aspect: ReasoningAspectSchema,
    key: z.string().min(1),
    count: z.number().int().min(0),
    recentEvidence: z.string(),
  })),
  resourceBaseline: z.array(z.object({
    metric: ResourceMetricSchema,
    p50: z.number(),
    p90: z.number(),
    sampleCount: z.number().int().min(0),
    window: z.string(),
  })),
  calibrationSummary: z.object({
    domains: z.number().int().min(0),
    maxError: z.number().min(0),
    miscalibrated: z.array(z.string()),
  }),
});

// ── FROZEN CalibrationResult ─────────────────────────────────────────────

export const CalibrationResultSchema = z.object({
  domain: z.string().min(1),
  predicted: z.number(),
  actual: z.number(),
  error: z.number().min(0),
  samples: z.number().int().min(0),
});

// ── 上限常量（设计稿 §4.2：对齐 diagnosis 200/50/50 量级）─────────────────

export const LIMITS = Object.freeze({
  CAPABILITY_MAP: 200,
  REASONING_PROFILE: 100,
  RESOURCE_BASELINE: 50,
  CALIBRATION_LOG: 100,
});

// ── 校准护栏常量（设计稿 §4.6）───────────────────────────────────────────

/** 校准误差红线：任一域误差 > 10% → miscalibration 告警 */
export const CALIBRATION_ERROR_THRESHOLD = 0.10;

/** cold-start 守门：域内样本 < 10 → UNCERTAIN，不计误差（对齐 diagnosis counterfactual） */
export const COLD_START_SAMPLES = 10;

/** 滚动窗口默认 28 天 */
export const DEFAULT_CALIBRATION_WINDOW_DAYS = 28;

// ── helpers（不修改 FROZEN 契约）────────────────────────────────────────

/** 校验一个对象是否是合法 CapabilityEntry；返回 boolean 而非抛错。 */
export function isCapabilityEntry(value) {
  return CapabilityEntrySchema.safeParse(value).success;
}

/** 校验 SelfModelSnapshot；返回 boolean。 */
export function isSelfModelSnapshot(value) {
  return SelfModelSnapshotSchema.safeParse(value).success;
}

/** 校验 CalibrationResult；返回 boolean。 */
export function isCalibrationResult(value) {
  return CalibrationResultSchema.safeParse(value).success;
}
