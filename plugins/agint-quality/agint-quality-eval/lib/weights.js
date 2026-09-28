/**
 * agint-quality-eval weights —— 行动 #5（2026-09-28）：权重外置可配置。
 *
 * 把写死在 evaluators.js 的 DIMENSION_WEIGHTS 演进为：
 *   `内置默认（DIMENSION_WEIGHTS）→ 外部配置（插件 patch config / 运行时
 *   setDimensionWeights）可覆盖 → 校验 → 解析为完整权重表`。
 *
 * 消费方：
 *   - quality-eval 侧：compositeScore(evalResult, weights)（默认仍用内置表）；
 *   - policy 侧：decidePolicy 的 config.dimensionWeights（已在 decide.js 支持覆盖）。
 *
 * 边界：
 *   - 权重只影响综合分，不影响 safety/trust 一票否决（veto 阈值独立）。
 *   - 缺失维度键 = 用内置默认（partial 覆盖）；非法值（<0 或 >1 或非数字）→ 校验失败。
 */

import { z } from '../../node_modules/zod/index.js';
import { DIMENSION_WEIGHTS } from './evaluators.js';

/** 内置默认权重（evaluators.js 的 DIMENSION_WEIGHTS 快照，单一事实源不变）。 */
export const DEFAULT_DIMENSION_WEIGHTS = { ...DIMENSION_WEIGHTS };

/** 维度键集合（与 DIMENSION_KEYS 对齐；promptStatic 仅 prompt target 计入）。 */
export const WEIGHT_KEYS = Object.freeze(Object.keys(DEFAULT_DIMENSION_WEIGHTS));

/**
 * 权重 patch schema：partial —— 只允许覆盖部分维度，缺失键回退内置默认。
 * 值域 [0, 1]（权重即相对重要性；综合分 = 100 * Σ(w·s) / Σw）。
 */
export const WEIGHTS_SCHEMA = z.object(
  Object.fromEntries(
    WEIGHT_KEYS.map((k) => [k, z.number().min(0).max(1).optional()]),
  ),
);

/**
 * 校验权重 patch。
 * @param {object|null|undefined} patch
 * @returns {{ valid: boolean, issues: string[] }}
 */
export function validateWeights(patch) {
  if (patch === null || patch === undefined) return { valid: true, issues: [] };
  if (typeof patch !== 'object' || Array.isArray(patch)) {
    return { valid: false, issues: ['dimensionWeights must be an object'] };
  }
  const issues = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!WEIGHT_KEYS.includes(k)) {
      issues.push(`unknown dimension key "${k}" (allowed: ${WEIGHT_KEYS.join(', ')})`);
      continue;
    }
    if (typeof v !== 'number' || Number.isNaN(v) || v < 0 || v > 1) {
      issues.push(`dimension "${k}" weight must be a number in [0, 1], got ${JSON.stringify(v)}`);
    }
  }
  return { valid: issues.length === 0, issues };
}

/**
 * 解析权重 patch → 完整权重表（内置默认 + patch 覆盖）。
 * patch 非法时：不抛 —— 返回内置默认并附带 issues（调用方自行决定是否采用）。
 * @param {object|null|undefined} patch
 * @returns {{ weights: Record<string, number>, issues: string[], fallbackToDefault: boolean }}
 */
export function resolveWeights(patch) {
  const checked = validateWeights(patch);
  if (!checked.valid) {
    return { weights: { ...DEFAULT_DIMENSION_WEIGHTS }, issues: checked.issues, fallbackToDefault: true };
  }
  const weights = { ...DEFAULT_DIMENSION_WEIGHTS };
  if (patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) weights[k] = v;
    }
  }
  return { weights, issues: [], fallbackToDefault: false };
}

/** 快速合并：给调用方一个可直接传给 compositeScore 的权重表。 */
export function mergedWeights(patch) {
  return resolveWeights(patch).weights;
}
