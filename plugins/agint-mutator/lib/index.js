/**
 * agint-mutator v0.6.1 — 变异构造器。
 * 子任务 #3 交付：propose Service + 3 类 _propose* 构造器 + 入参校验 + payload 二次校验 +
 * preimageHash + LIMITS.PROPOSALS=100 守门 + 写 proposals 表。
 * 子任务 #4 交付（本文件增量）：
 *   - validate 4 约束：原子性 / 可证伪 / 回滚条件 / 必填字段 + payload 形态
 *     （不通过：抛错 + 写 findings 表 + 返回 { ok: false, findings }）
 *   - commit 沙箱闭环：8 步内部流程（读 PENDING → 定位 targetPath → 写 postimage →
 *     写 commits 表 → runSmoke verify → qualityPolicy.decide() → AUTO_DEPLOY/PENDING_REVIEW
 *     写 mutation.success / REJECT/ABSTAIN 恢复 preimage + 写 mutation.failure + 抛错）
 *   - rollback 闭环：5 步（读 commits → SHA-256 校验 preimageContent → 恢复 targetPath
 *     → 计算 restoredHash + 写 mutation.rollback → proposal.status='ROLLED_BACK'）
 *   - metrics 三事件：mutation.success / mutation.failure / mutation.rollback（metrics_log 本地表）
 *
 * 设计原则（§六 + §八）：
 *   - 不调真 LLM；payload 文本由人类 owner 编辑
 *   - 软依赖缺失抛错（mutation 关键路径，不静默）
 *   - targetPlugin 不在 FROZEN proposal schema → 通过 ProposeInputSchema 选填字段透传，
 *     storage entry 用内部 _targetPlugin 存，unpackProposal 不暴露（FROZEN view 不破环）
 *   - commit/rollback 的目标文件 IO 走 _io 抽象（默认 node:fs/promises；测试可注入 stub）
 *   - 不动 D-QAF FROZEN 契约（设计稿 §七 L0 治理）
 */

import {
  spec, checkLimit, packProposal, packCommit, packFinding,
  unpackProposal, unpackCommit, unpackFinding,
  packMetricsLog, unpackMetricsLog,
  checkPendingUnique, getInternalField,
  randomId, nowIso, contentHash, contentByteLength,
} from './storage.js';
import * as nodeFs from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import {
  MutationProposalSchema, MutationPayloadSchema, MutationKindSchema, MUTATION_KINDS,
  AtomicScopeSchema, ATOMIC_SCOPES, MutationSourceSchema, MUTATION_SOURCES,
  // v2 新增 3 个 FROZEN enum（设计稿 §二.1 v2）
  MutationStatusSchema, MUTATION_STATUSES,
  DiffStrategySchema, DIFF_STRATEGIES,
  OrderingStrategySchema, ORDERING_STRATEGIES,
  CommitSchema, RollbackResultSchema,
  // Sprint 8 #4 加：audit + sandbox / policy result enum（设计稿 §2.1）
  AuditSchema, SandboxResultKindSchema, PolicyDecisionKindSchema,
  LIMITS,
} from './schema.js';
import { z } from 'zod';

const name = 'agint-mutator';

// 硬依赖：storageDomain。软依赖 4 个走 ctx.get（不阻塞挂载）：
//   agint.evolution（failure_pattern）/ agint.diagnosis（annotations）/
//   agint.dream（REM）/ agint.qualitySandbox（verify）。
const inject = ['storageDomain'];

const Config = {};

// ── 入参 schema（设计稿 §二.1：propose input 形态） ─────────────────────
// 业务 payload 字段由 caller 传（fixture / 人类 owner）；软依赖仅做「服务可用」守门。
const PromptPayloadInputSchema = z.object({
  promptId: z.string().min(1), oldText: z.string(), newText: z.string(), diffStrategy: z.string().min(1),
});
const ToolPayloadInputSchema = z.object({
  toolName: z.string().min(1), signature: z.string().min(1), stubs: z.array(z.string()), intent: z.string().min(1),
});
const StrategyPayloadInputSchema = z.object({
  strategyId: z.string().min(1),
  oldSteps: z.array(z.string().min(1)).min(1),
  newSteps: z.array(z.string().min(1)).min(1),
  ordering: z.string().min(1),
});

const ProposeInputSchema = z.object({
  source: MutationSourceSchema,
  failureId: z.string().min(1),
  rootCause: z.string().min(1), // 路由只看 PROMPT_DEFICIENCY / TOOL_GAP / PLANNING_FAILURE
  expectedEffect: z.string().min(1),
  rollbackCondition: z.string().min(1),
  atomicScope: AtomicScopeSchema,
  promptPayload: PromptPayloadInputSchema.optional(),
  toolPayload: ToolPayloadInputSchema.optional(),
  strategyPayload: StrategyPayloadInputSchema.optional(),
  windowDays: z.number().int().positive().optional(),
  // Sprint 8 #4：targetPlugin 是 mutation 落点的关键信息（设计稿 §二.2 + 决策 D8）。
  // FROZEN propose() 签名无此字段，但 zod 允许 caller 透传非 schema 字段；
  // 用 .passthrough() 等价——这里用 .optional() 让 caller 可选填；commit 拿不到时抛错。
  targetPlugin: z.string().regex(/^agint-[a-z][a-z0-9-]*$/, 'targetPlugin 必须匹配 agint-<kebab-case>').optional(),
  failureContext: z.record(z.unknown()).optional(),
});

// ── 内部 helper ────────────────────────────────────────────────────────

// 根据 rootCause 决定 MutationKind（设计稿 §二.2 表，宽松匹配）
function pickKind(rootCause) {
  if (typeof rootCause !== 'string') return null;
  if (/^PROMPT_DEFICIENCY/i.test(rootCause)) return 'PROMPT_MUTATION';
  if (/^TOOL_GAP/i.test(rootCause)) return 'TOOL_SYNTHESIS';
  if (/^PLANNING_FAILURE/i.test(rootCause)) return 'STRATEGY_REWRITE';
  return null;
}

function pickPayload(input, kind) {
  if (kind === 'PROMPT_MUTATION') return input.promptPayload;
  if (kind === 'TOOL_SYNTHESIS') return input.toolPayload;
  if (kind === 'STRATEGY_REWRITE') return input.strategyPayload;
  return null;
}

// 软依赖：ctx.get 返回 null 立即抛错（mutation 关键路径，不静默）
function softDepOrThrow(ctx, serviceName, missingMsg) {
  const svc = ctx && typeof ctx.get === 'function' ? ctx.get(serviceName) : null;
  if (!svc) throw new Error(`propose: ${serviceName} service 不可用（${missingMsg}）`);
  return svc;
}

// ── 3 类 mutation 构造器本体（设计稿 §二.2 + §八：不调真 LLM） ──────────
// 独立可测：export 出去供 test/propose.test.mjs 直接调用。
// 表驱动：每个 kind 对应 (软依赖校验、payload 字段抽取、可选副作用)。
const PROPOSERS = {
  PROMPT_MUTATION: { softDep: 'agint.diagnosis', check: 'queryAnnotations', field: 'promptPayload', fields: ['promptId','oldText','newText','diffStrategy'], probe: null },
  TOOL_SYNTHESIS: { softDep: 'agint.evolution', check: 'queryFailures', field: 'toolPayload', fields: ['toolName','signature','stubs','intent'], probe: (d) => d.queryFailures({ category: 'integration', limit: 1 }) },
  STRATEGY_REWRITE: { softDep: 'agint.diagnosis', check: 'report', field: 'strategyPayload', fields: ['strategyId','oldSteps','newSteps','ordering'], probe: null },
};

function _checkDep(spec, dep) {
  if (!dep || typeof dep[spec.check] !== 'function') {
    throw new Error(`propose: ${spec.softDep}.${spec.check} ${spec.softDep === 'agint.diagnosis' ? 'queryAnnotations' : spec.check} 不可用`);
  }
}

function _extractPayload(spec, input) {
  const p = input[spec.field];
  if (!p) throw new Error(`propose: input.${spec.field} 缺失`);
  const out = {}; for (const f of spec.fields) out[f] = p[f]; return out;
}

function _proposePromptMutation(input, diagnosis) {
  const s = PROPOSERS.PROMPT_MUTATION; _checkDep(s, diagnosis);
  return _extractPayload(s, input);
}
function _proposeStrategyRewrite(input, diagnosis) {
  const s = PROPOSERS.STRATEGY_REWRITE; _checkDep(s, diagnosis);
  return _extractPayload(s, input);
}
async function _proposeToolSynthesis(input, evolution) {
  const s = PROPOSERS.TOOL_SYNTHESIS; _checkDep(s, evolution);
  try { if (s.probe) await s.probe(evolution); } catch (_e) { /* fixture 吞错 */ }
  return _extractPayload(s, input);
}

function placeholder(fnName, subTask, info) {
  return () => {
    throw new Error(`not implemented: ${fnName} (${subTask}); ${info}`);
  };
}

function apply(ctx) {
  let domain = null, domainError = null, disposed = false;

  // lifecycle：副作用走 ctx.effect → graceful shutdown（设计稿 §八 + AGENTS.md 挂载红线）
  ctx.effect(() => () => {
    disposed = true;
    if (domain) return domain.close();
    return undefined;
  });

  const ready = ctx.storageDomain.open(spec).then(
    (d) => { if (disposed) { void d.close().catch(() => {}); return null; } domain = d; return d; },
    (error) => { domainError = error; return null; },
  );

  const table = async (n) => {
    if (disposed) throw new Error('agint-mutator: disposed');
    if (domainError) throw domainError;
    const d = await ready;
    if (!d) throw new Error('agint-mutator: domain unavailable');
    return d.table(n);
  };
  const t_proposals = () => table('proposals');
  const t_commits = () => table('commits');
  const t_findings = () => table('findings');
  const t_metrics = () => table('metrics_log');

  async function stats() {
    const p = await t_proposals(), c = await t_commits(), f = await t_findings(), m = await t_metrics();
    return {
      proposals: p.entries().length, commits: c.entries().length,
      findings: f.entries().length, metrics_log: m.entries().length, limits: LIMITS,
    };
  }

  // mutation 事件写入 metrics_log（设计稿 §二.6 v2：commit/rollback success/failure/rollback/policy_reject）
  // eventType ∈ { 'mutation.success' | 'mutation.failure' | 'mutation.rollback' | 'mutation.policy_reject' }
  async function logMetric(business) {
    const t = await t_metrics();
    const currentCount = t.entries().length;
    if (currentCount >= LIMITS.METRICS_LOG) {
      throw new Error(`metrics_log table full (cap ${LIMITS.METRICS_LOG}); #4 commit/rollback 需手动 prune`);
    }
    const entry = packMetricsLog(business);
    await t.put(entry.id, entry);
    return unpackMetricsLog(entry);
  }

  // ── FROZEN Service 出口（设计稿 §2.1） ────────────────────────────────

  /**
   * `agint.mutator.propose(input) → MutationProposal`
   * 子任务 #3 实现：3 类 mutation 构造器本体（设计稿 §二.2 表）。
   *
   * 流程：
   *   1) ProposeInputSchema.parse(input) — 缺字段抛 zod 错（expectedEffect / rollbackCondition 等）
   *   2) atomicScope → kind 路由（prompt→PROMPT_MUTATION / tool→TOOL_SYNTHESIS / strategy→STRATEGY_REWRITE）
   *   3) MutationPayloadSchema.parse({ kind, payload }) — payload 二次校验
   *   4) preimageHash = contentHash(JSON.stringify(payload))
   *   5) LIMITS 守门（proposals ≥ 100 抛错）
   *   6) packProposal(business) → t_proposals().put(id, entry)
   *   7) unpackProposal(entry) → 完整 MutationProposal 形态
   *
   * 红线：
   *   - 不调真 LLM（设计稿 §八）
   *   - payload 文本字段由 caller 提供（fixture / 人类 owner 编辑）
   *   - 软依赖缺失抛错，不静默跳过
   */
  async function propose(input) {
    // ── 1) 入参校验
    const parsed = ProposeInputSchema.safeParse(input);
    if (!parsed.success) {
      // 透传 zod 错误（含路径 + 消息），便于 caller 调试
      const issue = parsed.error.issues[0];
      const path = issue ? issue.path.join('.') : 'input';
      const msg = issue ? issue.message : 'invalid input';
      throw new Error(`propose: invalid input at ${path}: ${msg}`);
    }
    const validInput = parsed.data;

    // ── 2-4) 路由 + 二次校验 + 构造 payload
    const kind = validInput.atomicScope === 'prompt' ? 'PROMPT_MUTATION'
      : validInput.atomicScope === 'tool' ? 'TOOL_SYNTHESIS'
      : 'STRATEGY_REWRITE';

    // 校验业务 payload 形态（按 atomicScope）
    const payload = pickPayload(validInput, kind);
    if (!payload) {
      throw new Error(`propose: atomicScope='${validInput.atomicScope}' 但对应 payload 字段缺失`);
    }
    MutationPayloadSchema.parse({ kind, payload });

    // ── 5) preimageHash = contentHash(JSON.stringify(payload)) — contentHash 是 async
    const preimageHash = await contentHash(JSON.stringify(payload));

    // 软依赖缺失立即抛错（mutation 关键路径，不静默）
    const needDiagnosis = validInput.atomicScope === 'prompt' || validInput.atomicScope === 'strategy';
    if (needDiagnosis) {
      softDepOrThrow(ctx, 'agint.diagnosis',
        validInput.atomicScope === 'prompt' ? 'PROMPT_MUTATION 需要 queryAnnotations 读取 evidence' : 'STRATEGY_REWRITE 需要 report 读 windowDays 报告');
    }
    if (validInput.atomicScope === 'tool') {
      softDepOrThrow(ctx, 'agint.evolution', 'TOOL_SYNTHESIS 需要 queryFailures 读取 category=integration 失败模式');
    }

    // ── 6) LIMITS 守门
    const t = await t_proposals();
    const currentCount = t.entries().length;
    if (currentCount >= LIMITS.PROPOSALS) {
      throw new Error(`proposals table full (cap ${LIMITS.PROPOSALS})`);
    }

    // ── 7) 调 3 类构造器本体
    const diagnosis = ctx && typeof ctx.get === 'function' ? ctx.get('agint.diagnosis') : null;
    const evolution = ctx && typeof ctx.get === 'function' ? ctx.get('agint.evolution') : null;

    let finalPayload;
    if (kind === 'PROMPT_MUTATION') {
      finalPayload = _proposePromptMutation(validInput, diagnosis);
    } else if (kind === 'TOOL_SYNTHESIS') {
      finalPayload = await _proposeToolSynthesis(validInput, evolution);
    } else {
      finalPayload = _proposeStrategyRewrite(validInput, diagnosis);
    }

    // ── 8) packProposal → put → unpack
    const business = {
      kind,
      source: validInput.source,
      atomicScope: validInput.atomicScope,
      status: 'PENDING', // FROZEN MutationStatus 起点（设计稿 §二.1 v2）
      failureId: validInput.failureId,
      rootCause: validInput.rootCause,
      payload: finalPayload,
      expectedEffect: validInput.expectedEffect,
      rollbackCondition: validInput.rollbackCondition,
      preimageHash,
      // Sprint 8 #4：内部 _targetPlugin / _failureContext 不暴露给 unpackProposal(FROZEN view)
      _targetPlugin: validInput.targetPlugin,
      _failureContext: validInput.failureContext,
    };

    // ── 8.5) 唯一索引校验（设计稿 §二.6 v2：atomicScope + status='PENDING' 不允许重复）
    const existing = t.entries(); // 读 entries 是同步的（已在 table() 内同步）
    const conflict = checkPendingUnique(existing, business);
    if (conflict) {
      throw new Error(`propose: atomicScope='${business.atomicScope}' 已有 PENDING proposal（id=${conflict.conflict.existingId}）；同 scope 只允许 1 条 PENDING`);
    }

    const entry = packProposal(business);
    await t.put(entry.id, entry);
    return unpackProposal(entry);
  }

  // ── Sprint 8 #4：validate / commit / rollback ─────────────────────
  // 设计稿 §2.1 / §二.3；不调真 LLM；commit 默认 verify 沙箱（决策 D3）。
  // 4 约束（设计稿 §二.3 D4）：原子性 / 可证伪 / 回滚条件 / 必填+payload 形态。
  const VALIDATE_EXPECTED_RE = /^.+ (>=|<=|>|<|==) \d+%? (在|within) \d+ 天?$/;
  const VALIDATE_ROLLBACK_RE = /(regression|harm|manual)/;

  function _findingMessage(proposalId, severity, msg) {
    return { proposalId, severity, message: msg };
  }

  // 约束 1（原子性）：kind 与 atomicScope 一致
  function _checkAtomicity(proposal, findings) {
    const expectedKind = proposal.atomicScope === 'prompt' ? 'PROMPT_MUTATION'
      : proposal.atomicScope === 'tool' ? 'TOOL_SYNTHESIS'
      : proposal.atomicScope === 'strategy' ? 'STRATEGY_REWRITE' : null;
    if (!expectedKind) {
      findings.push(_findingMessage(proposal.id, 'error', `validate: 未知 atomicScope='${proposal.atomicScope}'（期望 prompt/tool/strategy）`));
      return false;
    }
    if (proposal.kind !== expectedKind) {
      findings.push(_findingMessage(proposal.id, 'error', `validate: 原子性违反 — kind='${proposal.kind}' 与 atomicScope='${proposal.atomicScope}' 不一致（期望 ${expectedKind}）`));
      return false;
    }
    return true;
  }
  // 约束 2（可证伪）：expectedEffect 匹配正则
  function _checkFalsifiable(proposal, findings) {
    if (typeof proposal.expectedEffect !== 'string'
      || proposal.expectedEffect.length === 0
      || !VALIDATE_EXPECTED_RE.test(proposal.expectedEffect)) {
      findings.push(_findingMessage(proposal.id, 'error', `validate: 可证伪违规 — expectedEffect='${proposal.expectedEffect || ''}' 不匹配 /^.+ (>=|<=|>|<|==) \\d+%? (在|within) \\d+ 天?$/`));
      return false;
    }
    return true;
  }
  // 约束 3（回滚条件）：rollbackCondition 含触发器
  function _checkRollback(proposal, findings) {
    if (typeof proposal.rollbackCondition !== 'string'
      || proposal.rollbackCondition.length === 0
      || !VALIDATE_ROLLBACK_RE.test(proposal.rollbackCondition)) {
      findings.push(_findingMessage(proposal.id, 'error', `validate: 回滚条件违规 — rollbackCondition='${proposal.rollbackCondition || ''}' 缺触发器（regression|harm|manual）`));
      return false;
    }
    return true;
  }
  // 约束 4（必填 + payload 形态）：按 FROZEN schema 校验 + 字段非空
  function _checkPayloadShape(proposal, findings) {
    if (typeof proposal.source !== 'string' || proposal.source.length === 0) {
      findings.push(_findingMessage(proposal.id, 'error', `validate: 必填 — source 缺失或空字符串`));
      return false;
    }
    // source 枚举校验（设计稿 §二.3 第 4 条 + §二.1 FROZEN enum MutationSource）
    if (MUTATION_SOURCES.indexOf(proposal.source) < 0) {
      findings.push(_findingMessage(proposal.id, 'error', `validate: 必填 — source='${proposal.source}' 不在 FROZEN MutationSource 枚举 { attribution-driven, dream-random, evolution-reversed }`));
      return false;
    }
    if (typeof proposal.atomicScope !== 'string' || proposal.atomicScope.length === 0) {
      findings.push(_findingMessage(proposal.id, 'error', `validate: 必填 — atomicScope 缺失或空字符串`));
      return false;
    }
    // atomicScope 枚举校验（设计稿 §二.3 第 4 条 + §二.1 FROZEN enum AtomicScope）
    if (ATOMIC_SCOPES.indexOf(proposal.atomicScope) < 0) {
      findings.push(_findingMessage(proposal.id, 'error', `validate: 必填 — atomicScope='${proposal.atomicScope}' 不在 FROZEN AtomicScope 枚举 { prompt, tool, strategy }`));
      return false;
    }
    // kind 枚举校验（设计稿 §二.3 第 4 条 + §二.1 FROZEN enum MutationKind）
    if (MUTATION_KINDS.indexOf(proposal.kind) < 0) {
      findings.push(_findingMessage(proposal.id, 'error', `validate: 必填 — kind='${proposal.kind}' 不在 FROZEN MutationKind 枚举 { PROMPT_MUTATION, TOOL_SYNTHESIS, STRATEGY_REWRITE }`));
      return false;
    }
    const parseRes = MutationPayloadSchema.safeParse({ kind: proposal.kind, payload: proposal.payload });
    if (!parseRes.success) {
      const issue = parseRes.error.issues[0];
      const path = issue ? issue.path.join('.') : 'payload';
      const msg = issue ? issue.message : 'invalid payload';
      findings.push(_findingMessage(proposal.id, 'error', `validate: payload 形态违规 at ${path}: ${msg}`));
      return false;
    }
    return true;
  }

  /**
   * `agint.mutator.validate(input) → { ok, findings }`
   * 设计稿 §二.3 + §2.1：4 条硬约束（原子性 / 可证伪 / 回滚条件 / 必填 + payload 形态）。
   * 不通过不抛错：写 findings 表 + 返回 { ok: false, findings: [...] }。
   * 不改 proposal.status（设计稿 §二.1 validate 注释：不改 proposal.status）。
   */
  async function validate(input) {
    const proposal = input && input.proposal;
    if (!proposal || !proposal.id) throw new Error('validate: 入参缺 proposal.id');
    const findings = [];
    const r1 = _checkAtomicity(proposal, findings);
    const r2 = _checkFalsifiable(proposal, findings);
    const r3 = _checkRollback(proposal, findings);
    const r4 = _checkPayloadShape(proposal, findings);
    const ok = r1 && r2 && r3 && r4;
    if (ok) return { ok: true, findings: [] };

    // 失败 findings 写入 findings 表（不抛错，不改 proposal.status）
    const tF = await t_findings();
    if (tF.entries().length >= LIMITS.FINDINGS) {
      throw new Error(`findings table full (cap ${LIMITS.FINDINGS}) — 请手动 prune`);
    }
    const written = [];
    for (const f of findings) {
      const entry = packFinding(f);
      await tF.put(entry.id, entry);
      written.push(unpackFinding(entry));
    }
    return { ok: false, findings: written };
  }

  // commit/rollback 文件落点派生（决策 D8：targetPath 硬编码 plugins/${pluginId}/${subdir}/${id}.${ext}）
  function deriveTargetPath(pluginId, proposal) {
    const p = proposal.payload;
    if (proposal.kind === 'PROMPT_MUTATION') {
      return `plugins/${pluginId}/prompts/${p.promptId}.md`;
    }
    if (proposal.kind === 'TOOL_SYNTHESIS') {
      return `plugins/${pluginId}/tools/${p.toolName}.js`;
    }
    if (proposal.kind === 'STRATEGY_REWRITE') {
      return `plugins/${pluginId}/strategies/${p.strategyId}.json`;
    }
    throw new Error(`commit: 未知 MutationKind='${proposal.kind}'`);
  }

  // postimage 生成（设计稿 §二.2 表：PROMPT_MUTATION/STRATEGY_REWRITE 整文件替换；TOOL_SYNTHESIS 新建文件）
  function generatePostimage(proposal) {
    const p = proposal.payload;
    if (proposal.kind === 'PROMPT_MUTATION') {
      return p.newText;
    }
    if (proposal.kind === 'TOOL_SYNTHESIS') {
      // 简单拼接（设计稿 §八：不调真 LLM；stubs = 人类 owner 编辑的源码片段）
      return [
        `// Auto-generated tool: ${p.toolName}`,
        `// Intent: ${p.intent}`,
        `// Signature: ${p.signature}`,
        ``,
        ...p.stubs,
        ``,
      ].join('\n');
    }
    if (proposal.kind === 'STRATEGY_REWRITE') {
      return JSON.stringify({
        strategyId: p.strategyId,
        ordering: p.ordering,
        steps: p.newSteps,
      }, null, 2);
    }
    throw new Error(`commit: 未知 MutationKind='${proposal.kind}'`);
  }

  // sandbox 结果 → SandboxResultKind（6 值）
  function classifySandboxResult(sandboxRunResult) {
    if (!sandboxRunResult) return 'unknown';
    if (sandboxRunResult.ok) return 'ok';
    const r = sandboxRunResult.reason;
    if (r === 'timeout') return 'timeout';
    if (r === 'sandbox-unavailable') return 'sandbox-unavailable';
    if (r === 'unsupported') return 'unsupported';
    return 'fail';
  }

  /**
   * `agint.mutator.commit(input) → { ok, commitId, postimageHash, committedAt, policyDecision, audit }`
   * 设计稿 §2.1：7 步
   *   1) 读 proposal
   *   2) 定位 targetPath + 读 preimage 内容
   *   3) 写 postimage 到 targetPath
   *   4) 写 preimageContent + postimageHash + audit 进 commits 表
   *   5) 进 sandbox verify 跑 D-QAF Phase 1-3
   *   6) D-QAF pass → 调 agint.qualityPolicy.decide() → policyDecision
   *   7) AUTO_DEPLOY/PENDING_REVIEW → mutation.success；REJECT/ABSTAIN → 恢复 preimage + mutation.failure + 抛错
   */
  async function commit(input) {
    if (!input || !input.proposalId) throw new Error('commit: 缺 proposalId');
    const proposalId = input.proposalId;
    // repoRoot 派生落点绝对路径；测试可注入；生产默认 process.cwd()
    const repoRoot = input.repoRoot || process.cwd();

    // ── 1) 读 proposal
    const tP = await t_proposals();
    const proposals = tP.entries();
    const proposalEntry = proposals.find((e) => e.id === proposalId);
    if (!proposalEntry) throw new Error(`commit: proposalId='${proposalId}' 在 proposals 表里查不到`);
    const proposal = unpackProposal(proposalEntry);
    if (proposal.status !== 'PENDING') {
      throw new Error(`commit: proposalId='${proposalId}' 当前 status='${proposal.status}'（仅 PENDING 可 commit）`);
    }
    // targetPlugin 解析优先级：commit() 的 input.pluginId（legacy/直接传）> proposal._targetPlugin（propose 透传）。
    // FROZEN Service 签名 commit({ proposalId }) 无 pluginId 字段；本实装接受 input.pluginId 作软兼容
    // （commit 是 mutation 关键路径，不静默；3 选 1：input.pluginId / proposal._targetPlugin / 抛错）。
    const targetPlugin = input.pluginId || getInternalField(proposalEntry, '_targetPlugin');
    if (!targetPlugin) {
      throw new Error(`commit: proposalId='${proposalId}' 缺 targetPlugin（caller 需在 commit() 传 input.pluginId 或在 propose() 透传 input.targetPlugin；mutator 不派生）`);
    }

    // ── 2) targetPath + preimage
    const targetPath = deriveTargetPath(targetPlugin, proposal);
    const absTarget = resolve(repoRoot, targetPath);
    let preimageContent = '';
    try {
      preimageContent = await nodeFs.readFile(absTarget, 'utf8');
    } catch (err) {
      if (proposal.kind !== 'TOOL_SYNTHESIS') {
        throw new Error(`commit: 读 preimage 失败（${targetPath}） — ${err.message}`);
      }
      // TOOL_SYNTHESIS 新建文件允许不存在
    }
    const preimageBytes = contentByteLength(preimageContent);
    if (preimageBytes > LIMITS.PREIMAGE_BYTES) {
      throw new Error(`commit: preimageContent ${preimageBytes} 字节超 LIMITS.PREIMAGE_BYTES=${LIMITS.PREIMAGE_BYTES}（决策 D7 5MB 上限）`);
    }
    // commits.preimageHash = SHA-256(实际文件内容)；proposal.preimageHash = payload 序列化 hash（设计稿 §2.1）
    // 两者不同：rollback 用 commits.preimageHash 校验 preimageContent 防篡改。
    const preimageContentHash = await contentHash(preimageContent);

    // ── 3) 写 postimage 到 targetPath
    const postimage = generatePostimage(proposal);
    await nodeFs.mkdir(dirname(absTarget), { recursive: true });
    await nodeFs.writeFile(absTarget, postimage, 'utf8');
    const postimageHash = await contentHash(postimage);
    const commitId = randomId();
    const committedAt = nowIso();

    // 软依赖：sandbox（决策 D3：默认 verify 模式）。mutation 关键路径，不静默。
    const sandbox = softDepOrThrow(ctx, 'agint.qualitySandbox', 'commit verify 必须 sandbox.runSmoke（决策 D3 默认 verify）；FROZEN Service 接口');
    // ── 5) sandbox verify
    const sandboxResult = await sandbox.runSmoke({
      target: { path: targetPath, name: `${targetPlugin}/${basename(targetPath)}` },
    });
    const sandboxKind = classifySandboxResult(sandboxResult);

    // 软依赖：policy
    const policy = softDepOrThrow(ctx, 'agint.qualityPolicy', 'commit 必须 policy.decide 拿决策（设计稿 §2.1 commit 步骤 6）');
    // ── 6) policy decide
    // 把 sandbox 结果合成 EvalResult 形态（policy 期望 results: EvalResult[]）
    const synthEval = {
      target: { id: targetPath, kind: 'plugin-postimage' },
      dimensions: sandboxResult.ok
        ? [
            { name: 'safety', score: { score: 1.0, veto: false } },
            { name: 'trust', score: { score: 1.0, veto: false } },
          ]
        : [
            { name: 'safety', score: { score: 0.0, veto: true } },
            { name: 'trust', score: { score: 0.0, veto: true } },
          ],
      ok: sandboxResult.ok,
      reason: sandboxResult.ok ? undefined : sandboxResult.reason,
    };
    const policyDecisionRaw = await policy.decide({ results: [synthEval] });
    const decision = policyDecisionRaw.kind; // AUTO_DEPLOY / PENDING_REVIEW / REJECT / ABSTAIN

    // audit 字段（设计稿 §2.1 commit 步骤 4 + rollbackTrigger=rollbackCondition 原字符串）
    const audit = {
      proposalId,
      commitId,
      kind: proposal.kind,
      source: proposal.source,
      timestamp: committedAt,
      sandboxResult: sandboxKind,
      rollbackTrigger: proposal.rollbackCondition,
    };

    // ── 4) 写 commits 表（不管 decision 都写，方便 rollback）
    const tC = await t_commits();
    if (tC.entries().length >= LIMITS.COMMITS) {
      throw new Error(`commits table full (cap ${LIMITS.COMMITS}) — 请手动 prune`);
    }
    const commitEntry = packCommit({
      ok: true, commitId, postimageHash, committedAt,
      policyDecision: decision, audit,
      proposalId, preimageHash: preimageContentHash,
      preimageContent, targetPath,
    });
    await tC.put(commitEntry.id, commitEntry);

    // ── 7) decision 处理
    if (decision === 'AUTO_DEPLOY' || decision === 'PENDING_REVIEW') {
      // proposal.status='COMMITTED' + mutation.success
      const updated = { ...proposalEntry, status: 'COMMITTED' };
      await tP.put(updated.id, updated);
      await logMetric({
        eventType: 'mutation.success', proposalId, commitId,
        source: proposal.source, kind: proposal.kind, atomicScope: proposal.atomicScope,
        policyDecision: decision,
      });
      return unpackCommit(commitEntry);
    }

    // REJECT / ABSTAIN → 恢复 preimage + proposal.status='REJECTED' + mutation.failure + 抛错
    await nodeFs.mkdir(dirname(absTarget), { recursive: true });
    if (proposal.kind === 'TOOL_SYNTHESIS' && preimageContent.length === 0) {
      try { await nodeFs.unlink(absTarget); }
      catch (err) {
        if (err.code !== 'ENOENT') {
          throw new Error(`commit: REJECT 恢复失败（TOOL_SYNTHESIS unlink）— ${err.message}`);
        }
      }
    } else if (preimageContent.length > 0) {
      await nodeFs.writeFile(absTarget, preimageContent, 'utf8');
    }
    const updatedRej = { ...proposalEntry, status: 'REJECTED' };
    await tP.put(updatedRej.id, updatedRej);
    await logMetric({
      eventType: 'mutation.failure', proposalId, commitId,
      source: proposal.source, kind: proposal.kind, atomicScope: proposal.atomicScope,
      reason: `policyDecision=${decision}${policyDecisionRaw.reason ? ':' + policyDecisionRaw.reason : ''}`,
      policyDecision: decision,
    });
    throw new Error(`commit: policyDecision=${decision}（proposal.status=REJECTED，preimage 已恢复）— ${policyDecisionRaw.reason || ''}`);
  }

  /**
   * `agint.mutator.rollback(input) → { ok, restoredHash, commitId, audit }`
   * 设计稿 §2.1：5 步
   *   1) 从 commits 表查 commit 记录
   *   2) SHA-256 校验 preimageContent 与 commits.preimageHash 一致（防外部篡改）
   *   3) 写 targetPath 恢复 preimage（TOOL_SYNTHESIS: preimageContent 为空 → unlink）
   *   4) 计算 restoredHash = SHA-256(恢复后内容)，与 preimageHash 比对
   *   5) proposal.status = 'ROLLED_BACK' + 写 mutation.rollback
   *
   * 失败语义：preimageHash 不匹配 / restoredHash ≠ preimageHash → 抛错 + 写 findings（不静默）。
   */
  async function rollback(input) {
    if (!input || !input.commitId) throw new Error('rollback: 缺 commitId');
    const commitId = input.commitId;
    const repoRoot = input.repoRoot || process.cwd();

    // ── 1) 从 commits 表查 commit 记录
    const tC = await t_commits();
    const commitsList = tC.entries();
    const commitEntry = commitsList.find((e) => e.id === commitId);
    if (!commitEntry) throw new Error(`rollback: commitId='${commitId}' 在 commits 表里查不到`);

    // preimageContent 字节守门（异常：commit 时不该过线）
    const preimageBytes = contentByteLength(commitEntry.preimageContent);
    if (preimageBytes > LIMITS.PREIMAGE_BYTES) {
      throw new Error(`rollback: commits.preimageContent ${preimageBytes} 字节超 LIMITS.PREIMAGE_BYTES=${LIMITS.PREIMAGE_BYTES}（异常状态，请检查历史写入）`);
    }

    // ── 2) SHA-256 校验
    const actualHash = await contentHash(commitEntry.preimageContent);
    if (actualHash !== commitEntry.preimageHash) {
      // 防篡改：写 findings + 抛错
      const tF = await t_findings();
      if (tF.entries().length >= LIMITS.FINDINGS) {
        throw new Error(`findings table full (cap ${LIMITS.FINDINGS}) — 请手动 prune`);
      }
      const fb = packFinding({
        proposalId: commitEntry.proposalId,
        severity: 'error',
        message: `rollback: SHA-256 校验失败 — commitId='${commitId}' commits.preimageContent 已篡改（actual=${actualHash.slice(0,16)}... 期望=${commitEntry.preimageHash.slice(0,16)}...）`,
      });
      await tF.put(fb.id, fb);
      throw new Error(`rollback: SHA-256 校验失败（不静默，已写 findings）— commitId='${commitId}'`);
    }

    // 查 proposal（决定 kind → 走 替换 / unlink 哪条路径）
    const tP = await t_proposals();
    const proposalEntry = tP.entries().find((e) => e.id === commitEntry.proposalId);
    if (!proposalEntry) throw new Error(`rollback: proposalId='${commitEntry.proposalId}' 查不到（commit 残留？）`);
    const proposal = unpackProposal(proposalEntry);

    // ── 3) 恢复 preimage
    const absTarget = resolve(repoRoot, commitEntry.targetPath);
    await nodeFs.mkdir(dirname(absTarget), { recursive: true });
    if (proposal.kind === 'TOOL_SYNTHESIS' && commitEntry.preimageContent.length === 0) {
      try { await nodeFs.unlink(absTarget); }
      catch (err) {
        if (err.code !== 'ENOENT') {
          throw new Error(`rollback: TOOL_SYNTHESIS unlink 失败 — ${err.message}`);
        }
      }
    } else {
      await nodeFs.writeFile(absTarget, commitEntry.preimageContent, 'utf8');
    }

    // ── 4) 计算 restoredHash + 与 preimageHash 比对
    let restoredContent = '';
    try {
      restoredContent = await nodeFs.readFile(absTarget, 'utf8');
    } catch (err) {
      if (proposal.kind !== 'TOOL_SYNTHESIS' || commitEntry.preimageContent.length !== 0) {
        throw new Error(`rollback: 读 restoredContent 失败（${commitEntry.targetPath}）— ${err.message}`);
      }
    }
    const restoredHash = await contentHash(restoredContent);
    if (restoredHash !== commitEntry.preimageHash) {
      const tF2 = await t_findings();
      if (tF2.entries().length >= LIMITS.FINDINGS) {
        throw new Error(`findings table full (cap ${LIMITS.FINDINGS}) — 请手动 prune`);
      }
      const fb2 = packFinding({
        proposalId: commitEntry.proposalId,
        severity: 'error',
        message: `rollback: restoredHash ≠ preimageHash — commitId='${commitId}' restoredHash=${restoredHash.slice(0,16)}... 期望=${commitEntry.preimageHash.slice(0,16)}...`,
      });
      await tF2.put(fb2.id, fb2);
      throw new Error(`rollback: restoredHash ≠ preimageHash（不静默，已写 findings） — commitId='${commitId}'`);
    }

    // ── 5) proposal.status = 'ROLLED_BACK' + mutation.rollback
    const updatedRb = { ...proposalEntry, status: 'ROLLED_BACK' };
    await tP.put(updatedRb.id, updatedRb);
    await logMetric({
      eventType: 'mutation.rollback',
      proposalId: commitEntry.proposalId,
      commitId,
      source: proposal.source,
      kind: proposal.kind,
      atomicScope: proposal.atomicScope,
    });

    // audit 复用 commit 的 audit，换 timestamp
    const audit = { ...commitEntry.audit, timestamp: nowIso() };
    return { ok: true, restoredHash, commitId, audit };
  }

  ctx.provide('agint.mutator.propose', propose);
  ctx.provide('agint.mutator.validate', validate);
  ctx.provide('agint.mutator.commit', commit);
  ctx.provide('agint.mutator.rollback', rollback);
  ctx.provide('agint.mutator.stats', stats);
  ctx.provide('agint.mutator.logMetric', logMetric); // #4 commit/rollback 调用入口
  ctx.provide('agint.mutator.checkLimit', checkLimit);
  ctx.provide('agint.mutator.limits', LIMITS);
  ctx.provide('agint.mutator.io', {
    packProposal, packCommit, packFinding, packMetricsLog,
    unpackProposal, unpackCommit, unpackFinding, unpackMetricsLog,
    randomId, nowIso, contentHash, checkPendingUnique,
  });
}

export {
  Config, apply, inject, name,
  MutationProposalSchema, MutationPayloadSchema, MutationKindSchema,
  AtomicScopeSchema, MutationSourceSchema,
  // v2 新增 3 个 FROZEN enum（设计稿 §二.1 v2）
  MutationStatusSchema, MUTATION_STATUSES,
  DiffStrategySchema, DIFF_STRATEGIES,
  OrderingStrategySchema, ORDERING_STRATEGIES,
  CommitSchema, RollbackResultSchema,
  ProposeInputSchema, LIMITS,
  // 3 类 mutation 构造器本体（独立可测）
  _proposePromptMutation, _proposeToolSynthesis, _proposeStrategyRewrite,
  // helper（独立可测）
  pickKind, pickPayload,
};