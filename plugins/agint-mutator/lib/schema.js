/**
 * agint-mutator: FROZEN schema definitions.
 * 设计稿 wiki/AGINT/sprint-8-设计稿-2026-08.md §2.1 / §2.2 / §2.3。
 *
 * 变更走 L0 治理：人类多签 + 7 天影子 + major 版本。
 * 未做（决策 D2，留 Sprint 10+）：
 *   PIPELINE_REORDER    牵涉插件装载 / 重启（产线操作红线段）
 *   ARCHITECTURE_PATCH  超出 mutation 概念边界
 *
 * Sprint 8 #4 扩展（不破 FROZEN 设计，仅 §2.1 接口契约补全 + D-QAF 度量）：
 *   - 增 AuditSchema / SandboxResultKindSchema / PolicyDecisionKindSchema
 *   - 扩 CommitSchema 加 policyDecision + audit（设计稿 §二.1 显式要求）
 *   - 扩 RollbackResultSchema 加 audit
 *
 * Sprint 8 #4: 新增 LIMITS.PREIMAGE_BYTES = 5MB（决策 D7）
 */

import { z } from 'zod';

// FROZEN enum：3 类变异（决策 D2 精简）
export const MutationKindSchema = z.enum(['PROMPT_MUTATION', 'TOOL_SYNTHESIS', 'STRATEGY_REWRITE']);
export const MUTATION_KINDS = Object.freeze(['PROMPT_MUTATION', 'TOOL_SYNTHESIS', 'STRATEGY_REWRITE']);
export const REJECTED_KINDS = Object.freeze(['PIPELINE_REORDER', 'ARCHITECTURE_PATCH']);

// FROZEN enum：3 条来源 + 3 个 atomicScope（设计稿 §二.3 不变量 1）
export const MutationSourceSchema = z.enum(['attribution-driven', 'dream-random', 'evolution-reversed']);
export const MUTATION_SOURCES = Object.freeze(['attribution-driven', 'dream-random', 'evolution-reversed']);
export const AtomicScopeSchema = z.enum(['prompt', 'tool', 'strategy']);
export const ATOMIC_SCOPES = Object.freeze(['prompt', 'tool', 'strategy']);

// FROZEN enum：proposal 状态机（设计稿 §二.1 v2，commit/rollback 用）
export const MutationStatusSchema = z.enum(['PENDING', 'COMMITTED', 'ROLLED_BACK', 'REJECTED']);
export const MUTATION_STATUSES = Object.freeze(['PENDING', 'COMMITTED', 'ROLLED_BACK', 'REJECTED']);

// FROZEN enum：PROMPT_MUTATION diff 策略（设计稿 §二.2.1 v2）
export const DiffStrategySchema = z.enum(['unified_diff', 'line_replace']);
export const DIFF_STRATEGIES = Object.freeze(['unified_diff', 'line_replace']);

// FROZEN enum：STRATEGY_REWRITE ordering（设计稿 §二.2.1 v2）
export const OrderingStrategySchema = z.enum(['before', 'after', 'replace']);
export const ORDERING_STRATEGIES = Object.freeze(['before', 'after', 'replace']);

// FROZEN payload 形态（设计稿 §二.2 表 + §二.2.1 v2 字段类型 FROZEN）
const PromptMutationPayloadSchema = z.object({
  promptId: z.string().regex(/^[a-z][a-z0-9-]{2,30}$/, 'promptId 必须匹配 ^[a-z][a-z0-9-]{2,30}$'),
  oldText: z.string().min(1).max(102400, 'oldText ≤100KB'),
  newText: z.string().min(1).max(102400, 'newText ≤100KB'),
  diffStrategy: DiffStrategySchema,
});
const ToolSynthesisPayloadSchema = z.object({
  toolName: z.string().regex(/^[a-z][a-z0-9-]{2,30}$/, 'toolName 必须匹配 ^[a-z][a-z0-9-]{2,30}$'),
  signature: z.string().min(1), // JSON Schema 字符串形态（参考 agint-quality-sdk PromptManifestSchema 思路）
  stubs: z.array(z.string().min(1).max(10240, 'stubs 单项 ≤10KB')).min(1, 'stubs ≥1'),
  intent: z.string().min(1).max(500, 'intent ≤500 字符'),
});
const StrategyRewritePayloadSchema = z.object({
  strategyId: z.string().regex(/^[a-z][a-z0-9-]{2,30}$/, 'strategyId 必须匹配 ^[a-z][a-z0-9-]{2,30}$'),
  oldSteps: z.array(z.string().min(1)).min(1),
  newSteps: z.array(z.string().min(1)).min(1),
  ordering: OrderingStrategySchema,
});
export const MutationPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('PROMPT_MUTATION'), payload: PromptMutationPayloadSchema }),
  z.object({ kind: z.literal('TOOL_SYNTHESIS'), payload: ToolSynthesisPayloadSchema }),
  z.object({ kind: z.literal('STRATEGY_REWRITE'), payload: StrategyRewritePayloadSchema }),
]);

// FROZEN MutationProposalSchema（设计稿 §2.1 v2：加 status 状态机字段）
export const MutationProposalSchema = z.object({
  id: z.string().min(1),
  kind: MutationKindSchema,
  source: MutationSourceSchema,
  atomicScope: AtomicScopeSchema,
  status: MutationStatusSchema.default('PENDING'),
  failureId: z.string().min(1),
  rootCause: z.string().min(1),
  payload: z.unknown(), // 形态由 MutationPayloadSchema 二次校验（子任务 #3）
  expectedEffect: z.string().min(1),
  rollbackCondition: z.string().min(1),
  preimageHash: z.string().min(1),
  createdAt: z.string(),
});

// ── Sprint 8 #4 扩：audit / sandbox / policy 决策字段 ──────────────────

// FROZEN enum：sandbox verify 结果 6 值（设计稿 §二.1 commit 步骤 5）
export const SandboxResultKindSchema = z.enum(['ok', 'fail', 'timeout', 'unsupported', 'sandbox-unavailable', 'unknown']);
export const SANDBOX_RESULT_KINDS = Object.freeze(['ok', 'fail', 'timeout', 'unsupported', 'sandbox-unavailable', 'unknown']);

// FROZEN enum：policy 决策 4 值（设计稿 §二.1 commit 步骤 6，与 contract.DecisionKind 对齐）
export const PolicyDecisionKindSchema = z.enum(['AUTO_DEPLOY', 'PENDING_REVIEW', 'REJECT', 'ABSTAIN']);
export const POLICY_DECISION_KINDS = Object.freeze(['AUTO_DEPLOY', 'PENDING_REVIEW', 'REJECT', 'ABSTAIN']);

// AuditSchema：commits 表 audit 字段（设计稿 §二.1 commit 步骤 4）
export const AuditSchema = z.object({
  proposalId: z.string().min(1),
  commitId: z.string().min(1),
  kind: MutationKindSchema,
  source: MutationSourceSchema,
  timestamp: z.string().min(1),
  sandboxResult: SandboxResultKindSchema,
  rollbackTrigger: z.string().min(1),
});

// Sprint 8 #4 扩展：CommitSchema 加 policyDecision + audit（设计稿 §2.1 显式定义 commit 返回值）
export const CommitSchema = z.object({
  ok: z.literal(true),
  commitId: z.string().min(1),
  postimageHash: z.string().min(1),
  committedAt: z.string(),
  policyDecision: PolicyDecisionKindSchema,
  audit: AuditSchema,
});

// FindingSchema（保留原 4 字段：id / proposalId / severity / message / createdAt）
export const FindingSchema = z.object({
  id: z.string().min(1), proposalId: z.string().min(1),
  severity: z.enum(['info', 'warn', 'error']), message: z.string().min(1), createdAt: z.string(),
});

// Sprint 8 #4 扩展：RollbackResultSchema 加 audit
export const RollbackResultSchema = z.object({
  ok: z.literal(true),
  restoredHash: z.string().min(1),
  commitId: z.string().min(1),
  audit: AuditSchema,
});

// LIMITS（设计稿 §二.6 v2 + §验收 §三.2；proposals/commits/findings 与 diagnosis 200/50/50 体例对齐但调小；metrics_log 为变异成功率指标本地兜底）
// Sprint 8 #4 加 PREIMAGE_BYTES = 5MB（决策 D7：preimageContent 完整存 ≤5MB）
export const LIMITS = Object.freeze({
  PROPOSALS: 100,
  COMMITS: 50,
  FINDINGS: 100,
  METRICS_LOG: 200,
  PREIMAGE_BYTES: 5 * 1024 * 1024, // 5MB
});

export function isMutationProposal(value) { return MutationProposalSchema.safeParse(value).success; }
