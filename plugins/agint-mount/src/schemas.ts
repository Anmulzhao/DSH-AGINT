/**
 * agint-mount — zod 校验层（FROZEN MountResult + 内部入参）
 *
 * FROZEN 边界：
 *   - MountResultSchema 字段 = 设计稿 Sprint11 §4.2 字面，一字不动
 *   - phase enum 7 值（PREPARED / INSTALLED / RESTART_REQUESTED / ACTIVATED / HEALTHY / DISABLED / ROLLED_BACK）
 *   - contractCheck 三项布尔均为必填
 *
 * 内部 schema（非 FROZEN，可演进）：
 *   - MountRequestSchema     mount.request 入参：proposal + verdict
 *   - RollbackRequestSchema  mount.rollback 入参：ticketId + reason
 *   - ProbeResultSchema      健康探针单次结果
 *   - ArtifactManifestSchema 挂载产物的 manifest 草稿（PREPARE 阶段写入）
 */

// 关闭：host 端 zod 由 package.json peerDependency 引入；test 里只 import lib/schemas.js 即可
import { z } from 'zod';

/**
 * MountResultSchema — FROZEN L0，对齐 schemas/mount-result.schema.yaml。
 * Sprint 11 内禁改；改走 L0 治理。
 */
export const PhaseSchema = z.enum([
  'PREPARED',
  'INSTALLED',
  'RESTART_REQUESTED',
  'ACTIVATED',
  'HEALTHY',
  'DISABLED',
  'ROLLED_BACK',
]);
export const PHASES = Object.freeze([
  'PREPARED', 'INSTALLED', 'RESTART_REQUESTED', 'ACTIVATED',
  'HEALTHY', 'DISABLED', 'ROLLED_BACK',
]);

export const ContractCheckSchema = z.object({
  signatureDiff: z.boolean(),
  domainIsolation: z.boolean(),
  dependencyWhitelist: z.boolean(),
});

export const MountResultSchema = z.object({
  ticketId: z.string().min(1),
  proposalId: z.string().min(1),
  phase: PhaseSchema,
  contractCheck: ContractCheckSchema,
  activatedAt: z.string().nullable(),
});

/** 终态判定：HEALTHY / DISABLED / ROLLED_BACK 不再流转 */
export const TERMINAL_PHASES = Object.freeze(new Set([
  'HEALTHY', 'DISABLED', 'ROLLED_BACK',
]));

export function isTerminalPhase(p: string): boolean {
  return TERMINAL_PHASES.has(p as any);
}

/**
 * MutationProposal 节选（orchestrator 不直接 import mutator 类型，松耦合）。
 * 实际使用中由 caller 传完整 proposal；这里只声明 orchestrator 关心的最小字段。
 */
export const ProposalSubsetSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['PROMPT_MUTATION', 'TOOL_SYNTHESIS', 'STRATEGY_REWRITE']),
  source: z.enum(['attribution-driven', 'dream-random', 'evolution-reversed']),
  payload: z.unknown().optional(),
}).passthrough();

/**
 * SandboxVerdict 节选（同上，松耦合）。
 */
export const VerdictSubsetSchema = z.object({
  ok: z.boolean(),
  mode: z.enum(['verify', 'explore']).optional(),
  reason: z.string().optional(),
}).passthrough();

/** mount.request 入参 */
export const MountRequestSchema = z.object({
  proposal: ProposalSubsetSchema,
  verdict: VerdictSubsetSchema,
});

/** mount.rollback 入参（人类否决权入口） */
export const RollbackRequestSchema = z.object({
  ticketId: z.string().min(1),
  reason: z.string().min(1).default('manual'),
});

/** 健康探针单次结果 */
export const ProbeResultSchema = z.object({
  ticketId: z.string().min(1),
  at: z.string(),
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
});

/** 挂载产物的 manifest 草稿（PREPARE 阶段写入 staging） */
export const ArtifactManifestSchema = z.object({
  name: z.string().regex(/^agint-[a-z][a-z0-9-]+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  main: z.string().min(1),
  declaredStorageDomains: z.array(z.string()).default([]),
  declaredDependencies: z.array(z.string()).default([]),
});

/** 4 态路径判定（设计稿 spike：A 路径只走 3 态，B 路径走 4 态） */
export function needsInstall(deps: readonly string[]): boolean {
  return deps.length > 0;
}
