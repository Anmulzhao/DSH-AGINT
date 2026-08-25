/**
 * agint-mutator: storage domain 声明 + entry schema + LIMITS helpers。
 *
 * 设计稿 §2.1 / §2.6：domain agint_mutator + 三表 proposals / commits / findings
 * + LIMITS 100 / 50 / 100。业务字段按 FROZEN schema；storage 只补 metadata。
 * 注：MutationProposalSchema 自身已含 kind（PROMPT_MUTATION 等）——不能再
 * extend `kind: literal('proposal')` 会冲突。
 *
 * 哈希链（commit / rollback 子任务 #4 用）：
 *   preimageHash  proposal 提交前快照（propose 时算）
 *   postimageHash commit 成功后快照
 *   restoredHash  rollback 后内容哈希（应等于 preimageHash）
 *
 * Sprint 8 #4 扩展（commits 表；commit/rollback 子任务）：
 *   - commitEntrySchema 加 targetPath / preimageContent / audit 字段
 *     targetPath = plugins/${pluginId}/${subdir}/${id}.${ext}（决策 D8）
 *     preimageContent ≤ LIMITS.PREIMAGE_BYTES（决策 D7）
 *     audit = AuditSchema（设计稿 §二.1 commit 步骤 4）
 *   - 唯一索引 checkPendingUnique 不变（设计稿 §二.6 v2）
 */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import {
  MutationProposalSchema, CommitSchema, FindingSchema, AuditSchema, LIMITS,
} from './schema.js';

// storage entry schema — 仅补 metadata；业务字段已由 FROZEN schema 覆盖
// Sprint 8 #4：加可选 _targetPlugin / _failureContext 内部字段（不污染 unpackProposal 形态）；
// 设计稿 §二.2 + 决策 D8：targetPath = plugins/<targetPlugin>/<subdir>/<id>.<ext>。
// FROZEN 提案契约没 targetPlugin 字段，caller 需通过 mutation 来源接口（#5 子任务）或
// propose() 的可选 input.targetPlugin 传入；mutator 不在 proposal schema 上硬塞（避免 FROZEN 破环）。
const proposalEntrySchema = MutationProposalSchema.extend({
  _targetPlugin: z.string().min(1).optional(),
  _failureContext: z.record(z.unknown()).optional(),
});
// Sprint 8 #4：commits 表扩 targetPath / preimageContent / audit（决策 D7+D8）
// id 字段加上（CommitSchema 没 id，packCommit 注入的 id 被 zod strip；不加 id → unpackCommit commitId 变 undefined）
const commitEntrySchema = CommitSchema.extend({
  id: z.string().min(1),
  proposalId: z.string().min(1),
  preimageHash: z.string().min(1),
  // 决策 D7：preimageContent 完整存（≤ 5MB），不依赖 git
  preimageContent: z.string().min(0).max(LIMITS.PREIMAGE_BYTES, `preimageContent ≤ ${LIMITS.PREIMAGE_BYTES} 字节（决策 D7 5MB 上限）`),
  // 决策 D8：targetPath 派生，写表留个清晰溯源
  targetPath: z.string().min(1),
  // AuditSchema（设计稿 §二.1 commit 步骤 4）
  audit: AuditSchema,
});
const findingEntrySchema = FindingSchema.extend({});
// metrics_log 表 schema（设计稿 §二.6 v2）：变异成功率指标本地兜底（commit/rollback 时写 mutation.success/failure/rollback）
const metricsLogEntrySchema = z.object({
  id: z.string().min(1),
  eventType: z.enum(['mutation.success', 'mutation.failure', 'mutation.rollback', 'mutation.policy_reject']),
  proposalId: z.string().optional(),
  commitId: z.string().optional(),
  source: z.string().min(1).optional(), // attribution-driven / dream-random / evolution-reversed
  kind: z.string().min(1).optional(),   // PROMPT_MUTATION / TOOL_SYNTHESIS / STRATEGY_REWRITE
  atomicScope: z.string().min(1).optional(),
  reason: z.string().optional(),        // 失败/拒绝原因
  policyDecision: z.enum(['AUTO_DEPLOY', 'PENDING_REVIEW', 'REJECT', 'ABSTAIN']).optional(),
  createdAt: z.string(),
});

const name = 'agint-mutator';

const spec = defineDomain({
  name: 'agint_mutator', version: 2, // v2：加 metrics_log 表 + proposals 唯一索引
  tables: {
    proposals: {
      valueSchema: proposalEntrySchema,
      // 唯一索引：同一 atomicScope 下只允许 1 条 status='PENDING'（设计稿 §二.6 v2，老板审核 P2）
      // 注：defineDomain 索引 DSL 视 dsh-storage-domain 版本而定；这里声明 _indexes 描述供运行时校验
      _indexes: [{ name: 'uniq_atomicScope_pending', columns: ['atomicScope', 'status'], unique: true, partial: "status = 'PENDING'" }],
    },
    commits: { valueSchema: commitEntrySchema },
    findings: { valueSchema: findingEntrySchema },
    metrics_log: { valueSchema: metricsLogEntrySchema },
  },
});

// 上限检查：返回 null 表示 OK；返回 `{ table, count, limit, _warn }` 表示超限 warn
// 设计稿 §五：超限不抛错、不自动 prune——给老板手动留口子（与兄弟插件同策略）
const TABLE_TO_LIMIT_KEY = { proposals: 'PROPOSALS', commits: 'COMMITS', findings: 'FINDINGS', metrics_log: 'METRICS_LOG' };
function checkLimit(table, count) {
  const cap = TABLE_TO_LIMIT_KEY[table] ? LIMITS[TABLE_TO_LIMIT_KEY[table]] : undefined;
  if (typeof cap === 'number' && count > cap) {
    return { table, count, limit: cap, _warn: `${table} count ${count} > limit ${cap}` };
  }
  return null;
}

function randomId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `m-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso() { return new Date().toISOString(); }

// SHA-256 兜底：拿不到 crypto.subtle 时退化到 djb2。
// 仅用于 preimageHash / postimageHash 演示性占位——子任务 #4 commit/rollback 会换更严格实现。
async function contentHash(input) {
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  const c = globalThis.crypto;
  if (c && c.subtle && typeof c.subtle.digest === 'function') {
    const buf = await c.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `djb2-${(h >>> 0).toString(16)}`;
}

// contentByteLength：用于 commit 时 preimageContent ≤ 5MB 守门（决策 D7）
function contentByteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

function packProposal(business) {
  // Sprint 8 #4：把内部 _targetPlugin / _failureContext 透传；不在 unpackProposal 里返回（FROZEN view）
  const entry = { id: randomId(), ...business, createdAt: business.createdAt || nowIso() };
  return proposalEntrySchema.parse(entry);
}
function packCommit(business) {
  // commit 用 business.commitId 作 entry.id（FROZEN：commitId 是 commit 主键；不另造 id 避免双 UUID）
  if (!business.commitId) business = { ...business, commitId: randomId() };
  return commitEntrySchema.parse({ id: business.commitId, ...business });
}
function packFinding(business) {
  return findingEntrySchema.parse({ id: randomId(), ...business, createdAt: business.createdAt || nowIso() });
}
function packMetricsLog(business) {
  return metricsLogEntrySchema.parse({ id: randomId(), ...business, createdAt: business.createdAt || nowIso() });
}
function unpackProposal(e) {
  // FROZEN view（设计稿 §2.1 MutationProposal 形态）；不暴露 _targetPlugin / _failureContext
  return { id: e.id, kind: e.kind, source: e.source, atomicScope: e.atomicScope,
    status: e.status, failureId: e.failureId, rootCause: e.rootCause, payload: e.payload,
    expectedEffect: e.expectedEffect, rollbackCondition: e.rollbackCondition,
    preimageHash: e.preimageHash, createdAt: e.createdAt };
}
function unpackCommit(e) {
  // Sprint 8 #4 扩：返回 { ok, commitId, postimageHash, committedAt, policyDecision, audit, proposalId, preimageHash, preimageContent, targetPath }
  return {
    ok: true, commitId: e.id, postimageHash: e.postimageHash, committedAt: e.committedAt,
    policyDecision: e.policyDecision, audit: e.audit,
    proposalId: e.proposalId, preimageHash: e.preimageHash,
    preimageContent: e.preimageContent, targetPath: e.targetPath,
  };
}
function unpackFinding(e) { return { id: e.id, proposalId: e.proposalId, severity: e.severity, message: e.message, createdAt: e.createdAt }; }
function unpackMetricsLog(e) {
  // 只返回 schema 校验通过的字段，避免 undefined 噪声污染调用方 deepEqual
  return {
    id: e.id, eventType: e.eventType, createdAt: e.createdAt,
    ...(e.proposalId !== undefined && { proposalId: e.proposalId }),
    ...(e.commitId !== undefined && { commitId: e.commitId }),
    ...(e.source !== undefined && { source: e.source }),
    ...(e.kind !== undefined && { kind: e.kind }),
    ...(e.atomicScope !== undefined && { atomicScope: e.atomicScope }),
    ...(e.reason !== undefined && { reason: e.reason }),
    ...(e.policyDecision !== undefined && { policyDecision: e.policyDecision }),
  };
}

// 唯一索引校验（设计稿 §二.6 v2：atomicScope + status='PENDING' 不允许重复）
// 纯函数：传入现有 entries 数组 + 新 proposal 业务对象，返回 null OK 或 {conflict} 冲突
function checkPendingUnique(entries, business) {
  if (business.status && business.status !== 'PENDING') return null; // 非 PENDING 不参与唯一约束
  for (const e of entries) {
    if (e.atomicScope === business.atomicScope && e.status === 'PENDING') {
      return { conflict: { existingId: e.id, atomicScope: e.atomicScope, status: e.status } };
    }
  }
  return null;
}

// Sprint 8 #4：内部读 _targetPlugin / _failureContext（commit 落点推导用，不暴露给 caller）
function getInternalField(entry, field) {
  if (!entry || typeof entry !== 'object') return undefined;
  return entry[field];
}

export {
  name, spec, LIMITS, checkLimit, randomId, nowIso, contentHash, contentByteLength,
  packProposal, packCommit, packFinding, packMetricsLog,
  unpackProposal, unpackCommit, unpackFinding, unpackMetricsLog,
  checkPendingUnique,
  getInternalField,
  proposalEntrySchema, commitEntrySchema, findingEntrySchema, metricsLogEntrySchema,
};
