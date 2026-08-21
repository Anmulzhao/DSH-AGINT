/**
 * agint-quality-sdk/lib/schema.js — Prompt Manifest 契约（Sprint 5.1）
 *
 * ## 设计原则
 *   - Prompt 是 dsh host-plane 的可版本化资产, 需要 manifest + 模板 + 测试 三件套
 *   - manifest 是 FROZEN: 字段名 / 类型 / required 字段永不修改, 需人类多签
 *
 * ## FROZEN 字段（v0.5.0）
 *   - name / version / description / kind (system|user|tool-result)
 *   - variables: 模板参数声明（必须是命名变量, 不能是裸字符串）
 *   - regressionTests: 至少 N 个回归测试用例（老板拍板 N=5）
 *   - contractRef: 指向 quality-contract plugin 的哪个 seam
 *
 * ## ADJUSTABLE 字段（v0.5.0）
 *   - maxTokens / modelHint: 运行时调参
 *   - tags: 分类
 */

// Use zod from sibling plugin dir (avoids redundant install). See install.sh for npm layout.
import { z } from '../../agint-quality/node_modules/zod/index.js';

/**
 * 单个变量的声明: 必须先声明再用, 防止拼错
 */
export const PromptVariableSchema = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'variable name must be snake/camel identifier'),
  description: z.string().default(''),
  required: z.boolean().default(true),
  /** 类型: string | number | enum */
  type: z.enum(['string', 'number', 'enum']).default('string'),
  /** enum 类型的可选值 */
  enum: z.array(z.string()).optional(),
  defaultValue: z.unknown().optional(),
}).strict();
/** @frozen */

/**
 * 回归测试用例: input + expectedOutputContains (substring 匹配)
 * 老板拍板 (P3 哲学护栏): Prompt 变更必带 ≥5 个回归测试
 */
export const PromptRegressionTestSchema = z.object({
  name: z.string().min(1),
  inputs: z.record(z.unknown()),
  /** 期望输出包含的字符串数组 (任一命中即可) */
  expectedOutputContains: z.array(z.string()).default([]),
  /** 期望输出不能包含的字符串数组 (注入风险兜底) */
  expectedOutputNotContains: z.array(z.string()).default([]),
}).strict();
/** @frozen */

/**
 * Prompt Manifest (FROZEN 主结构)
 */
export const PromptManifestSchema = z.object({
  // ── FROZEN 顶层 ─────────────────────────────────────────────────
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'name must be kebab-case'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be semver'),
  description: z.string().min(10),
  /** 模板类型: system 提示 / user 输入 / tool 输出 */
  kind: z.enum(['system', 'user', 'tool-result', 'mixed']),
  author: z.string().default('agint'),

  // ── FROZEN 变量 + 测试 ──────────────────────────────────────────
  variables: z.array(PromptVariableSchema).default([]),
  /** 老板拍板: 必须 ≥ 5 条 (Phase 4 提示集) */
  regressionTests: z.array(PromptRegressionTestSchema).min(5, 'regression tests must be ≥ 5 per Phase 4 standard'),
  /** 指向 quality-contract 的 seam 名 (Phase 5 起注入 contract) */
  contractRef: z.enum(['QualityEvaluator', 'QualityPolicy', 'QualityReporter', 'QualityLifecycle']).default('QualityReporter'),

  // ── ADJUSTABLE 运行时配置 ───────────────────────────────────────
  maxTokens: z.number().int().positive().default(2048),
  modelHint: z.string().default('default'),
  tags: z.array(z.string()).default([]),

  // ── 模板路径 (生成器自动写入) ────────────────────────────────────
  templatePath: z.string().optional(),

}).strict();
/** @frozen 顶层字段集 */

/** Prompt Manifest 所需最少字段集 (生成器生成 manifest 时用) */
export const REQUIRED_FROZEN_FIELDS = ['name', 'version', 'description', 'kind', 'regressionTests', 'contractRef'];

/**
 * Validate a manifest. Returns { ok, violations }
 */
export function validateManifest(manifest) {
  const result = PromptManifestSchema.safeParse(manifest);
  if (result.success) {
    return { ok: true, violations: [], data: result.data };
  }
  return {
    ok: false,
    violations: result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    data: null,
  };
}

/**
 * Manifest version bump rule: minor for new variables; major for breaking schema changes.
 * 在 prompt-engine / sdk-cli / report 三件套沟通时给出 hint.
 */
export const VERSION_POLICY = {
  major: 'renaming FROZEN fields, schema-breaking',
  minor: 'new variables, new optional sections, new sample plugins',
  patch: 'wording tweaks, default value updates, bug fixes',
};
