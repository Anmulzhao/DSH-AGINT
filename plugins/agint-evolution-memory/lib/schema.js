/**
 * agint-evolution-memory: schema definitions for the three entry kinds.
 *
 * 三类 entry 共享三个字段（让 decay.js 能统一处理）：
 *   - id       唯一 id（hex hash 或 UUID）
 *   - level    L1/L2/L3/L4（衰减等级）
 *   - confidence 0..1（被命中频率的对等分数）
 *
 * 加上各自专属字段。所有 entry 都有 lastRecall / updatedAt / createdAt
 * 字段，供 recencyIso() 计算。
 */

import { z } from 'zod';

// ── 通用 entry 字段 ───────────────────────────────────────────────────────

const baseFields = {
  id: z.string().min(1),
  level: z.enum(['L1', 'L2', 'L3', 'L4']).default('L1'),
  confidence: z.number().min(0).max(1).default(0.5),
  lastRecall: z.string().default(() => new Date().toISOString()),
  recalls: z.number().int().min(0).default(0),
  evidence: z.string().default(''),
  resolved: z.boolean().default(false),
  replacedBy: z.string().nullable().default(null),
  createdAt: z.string().default(() => new Date().toISOString()),
  updatedAt: z.string().default(() => new Date().toISOString()),
};

// ── Evolution log entry（Phase 4 完成后追加） ──────────────────────────────

/**
 * evolution-log entry: 一次 D-QAF Phase 4 决策的完整记录。
 * 设计：每次 evaluateAll + decide + generate 走完时调用 logPhase4() 写入一行。
 */
export const evolutionLogEntrySchema = z.object({
  ...baseFields,
  kind: z.literal('evolution-log'),
  ts: z.string().default(() => new Date().toISOString()),
  targetId: z.string().min(1),
  targetKind: z.enum(['plugin', 'skill', 'preset', 'composite']),
  decision: z.enum(['AUTO_DEPLOY', 'PENDING_REVIEW', 'REJECT', 'ABSTAIN']),
  scores: z.record(z.string(), z.number()).default({}),
  // 触发决策的具体 findings（指向 EvalResult.findings 的子集）
  findings: z.array(z.object({
    ruleId: z.string(),
    severity: z.enum(['low', 'medium', 'high']),
    detail: z.string().optional(),
  })).default([]),
  tags: z.array(z.string()).default([]),
});

// ── Failure pattern entry（REJECT 决策自动 / 周复盘手工归纳） ────────────

/**
 * failure-pattern entry: 一个"出过错的进化模式"。
 * examples:
 *   - pattern: "打破 L0-frozen 字段" → severity: high
 *   - pattern: "未通过 Phase 1 静态检查" → severity: medium
 * 自动写入触发器：每次 REJECT 决策由 agint-quality-policy 调 addFailure
 * （Sprint 3 接入）；周复盘时 evolve 归纳。
 */
export const failurePatternSchema = z.object({
  ...baseFields,
  kind: z.literal('failure-pattern'),
  pattern: z.string().min(1),       // 模式描述（短句）
  category: z.enum(['security', 'correctness', 'integration', 'perf', 'other']).default('other'),
  severity: z.enum(['low', 'medium', 'high']).default('medium'),
  occurrences: z.number().int().min(1).default(1),  // 累计出现次数
  // 自动去重：同 pattern 第二次 add 时 occurrences++ 而非新建条目
});

// ── Success template entry（周复盘蒸馏） ──────────────────────────────────

/**
 * success-template entry: 一个"被反复验证有效的进化策略"。
 * examples:
 *   - template: "先写 eval 场景再写 plugin" → confidence: 0.9
 *   - template: "agint-rules 先 deny 再逐步放" → confidence: 0.8
 * 写入触发器：周复盘时由 evolve 蒸馏；不会自动生成。
 */
export const successTemplateSchema = z.object({
  ...baseFields,
  kind: z.literal('success-template'),
  template: z.string().min(1),      // 模板描述（短句）
  // 蒸馏时的样本量（多少次 Phase 4 AUTO_DEPLOY 验证此模板有效）
  sampleSize: z.number().int().min(1).default(1),
  // 适用场景（plugin / skill / preset / 通用）
  appliesTo: z.array(z.string()).default([]),
});

// ── 上限常量（owner：plugin index.js 引用） ────────────────────────────────

export const LIMITS = {
  FAILURE_PATTERNS: 100,
  SUCCESS_TEMPLATES: 50,
  EVOLUTION_LOG_LINES_PER_DAY: 1000,
};

// ── 内容子串匹配（queryFailures / queryTemplates 用） ─────────────────────

export function matchesQuery(text, query) {
  if (!query) return true;
  const q = String(query).toLowerCase().trim();
  if (!q) return true;
  return text.toLowerCase().includes(q);
}
