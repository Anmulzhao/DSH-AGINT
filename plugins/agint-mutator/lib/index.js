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
import { withMutex } from './rollback-mutex.js';
import { runRollbackTransaction } from './rollback.js';
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

// 硬依赖：storageDomain + agint.eventBus.subscribe。
//   eventBus.subscribe 原为软依赖（ctx.get 一次性读取），但 loader 各行并行
//   初始化，行顺序不保证 provide 先于消费，导致启动时经常取不到而永久降级
//   （diagnosis.completed 影子观察失效）。改为 inject 让 DI 等待服务就绪。
// 软依赖 3 个走 ctx.get（不阻塞挂载）：
//   agint.evolution（failure_pattern）/ agint.diagnosis（annotations）/
//   agint.dream（REM）/ agint.qualitySandbox（verify）。
const inject = ['storageDomain', 'agint.eventBus.subscribe'];

// Sprint 8 #5 模块级 pure helpers（设计稿 §二.4，独立可测）
function _deriveTargetPlugin(c) {
  if (!c) return null; const m = c.metadata && typeof c.metadata === 'object' ? c.metadata : null;
  if (m && m.targetPlugin) return m.targetPlugin; if (c.targetPlugin) return c.targetPlugin;
  for (const x of [c.trajectory, c.pattern, c.summary, c.text, c.description, c.evidence, c.content, m && m.trajectory, m && m.pattern]) {
    if (typeof x !== 'string') continue; const r = x.match(/agint-[a-z][a-z0-9-]+/g); if (r) return r[0];
  } return null;
}
function _reversePayload(pat, tpl, kind) {
  if (!tpl) return null; const text = (pat && (pat.pattern || pat.evidence)) || (typeof pat === 'string' ? pat : ''); if (!text) return null;
  if (kind === 'TOOL_SYNTHESIS') {
    const s = Array.isArray(tpl.stubs) ? tpl.stubs.slice() : [];
    if (/太短|缺|missing/i.test(text)) s.push('// reverse: stub补全');
    else if (/太长|too.+long/i.test(text)) { tpl.stubs = s.slice(0, Math.max(1, Math.ceil(s.length / 2))); return tpl; }
    else s.push('// reverse: 拆函数 stub');
    tpl.stubs = s; return tpl;
  }
  if (kind === 'STRATEGY_REWRITE') { if (!Array.isArray(tpl.oldSteps) || tpl.oldSteps.length < 1) return null; tpl.newSteps = tpl.oldSteps.slice().reverse(); return tpl; }
  if (kind === 'PROMPT_MUTATION') {
    const nt = String(tpl.newText || ''); const ot = String(tpl.oldText || '');
    if (/太短|缺指令|missing/i.test(text)) tpl.newText = nt + '\n// reverse: 补全指令';
    else if (/太长|too.+long/i.test(text)) tpl.newText = nt.slice(0, Math.max(1, Math.ceil(nt.length / 2)));
    else tpl.newText = ot.slice(0, Math.max(1, Math.ceil(ot.length / 2))) || 'reversed';
    return tpl;
  } return null;
}
function _pickKindFromSeed(seed, pool, count) {
  const n = Math.max(1, Math.min(count || 1, pool.length)); let h = 0; const s = String(typeof seed === 'number' ? seed : Date.now());
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  const out = [], used = new Set();
  for (let i = 0; i < n && used.size < pool.length; i++) { h = ((h * 1103515245) + 12345) | 0; const idx = Math.abs(h) % pool.length; if (!used.has(idx)) { used.add(idx); out.push(pool[idx]); } }
  return out;
}
const _scopeToRoot = (s) => s === 'prompt' ? 'PROMPT_DEFICIENCY' : s === 'tool' ? 'TOOL_GAP' : 'PLANNING_FAILURE';
const _scopeOfKind = (k) => k === 'PROMPT_MUTATION' ? 'prompt' : k === 'TOOL_SYNTHESIS' ? 'tool' : 'strategy';
function _patternToKind(p) {
  const t = (((p && p.pattern) || '') + ' ' + ((p && p.evidence) || '')).toLowerCase();
  if (/tool|api|stub/.test(t)) return 'TOOL_SYNTHESIS';
  if (/plan|step|order/.test(t)) return 'STRATEGY_REWRITE';
  return 'PROMPT_MUTATION';
}
const SOURCE_STUBS = {
  PROMPT_MUTATION: { expectedEffect: 'baseline 通过率 >= 95% 在 7 天', rollbackCondition: 'regression → auto-rollback', payloadField: { promptPayload: { promptId: 'sys-prompt', oldText: 'old', newText: 'new', diffStrategy: 'unified_diff' } }, template: { promptId: 'sys-prompt', oldText: 'old', newText: 'new', diffStrategy: 'unified_diff' } },
  TOOL_SYNTHESIS: { expectedEffect: 'tool 调用成功率 >= 80% within 7 天', rollbackCondition: 'harm >10% → rollback', payloadField: { toolPayload: { toolName: 'stub-tool-name', signature: 'stub(c) -> P<R>', stubs: ['// stub'], intent: 'stub tool intent (5 + chars)' } }, template: { toolName: 'stub-tool-name', signature: 'stub(c) -> P<R>', stubs: ['// stub'], intent: 'stub tool intent (5 + chars)' } },
  STRATEGY_REWRITE: { expectedEffect: 'reorder 通过率 >= 80% within 7 天', rollbackCondition: 'manual rollback after 3 failures', payloadField: { strategyPayload: { strategyId: 'default-strategy', oldSteps: ['fetch_context','plan_subtasks','execute','verify'], newSteps: ['plan_subtasks','fetch_context','execute','verify'], ordering: 'replace' } }, template: { strategyId: 'default-strategy', oldSteps: ['fetch_context','plan_subtasks','execute','verify'], newSteps: ['plan_subtasks','fetch_context','execute','verify'], ordering: 'replace' } },
};

const Config = z.object({});

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
  PROMPT_MUTATION: { softDep: 'agint.diagnosis', check: 'annotate', field: 'promptPayload', fields: ['promptId','oldText','newText','diffStrategy'], probe: null },
  TOOL_SYNTHESIS: { softDep: 'agint.evolution', check: 'queryFailures', field: 'toolPayload', fields: ['toolName','signature','stubs','intent'], probe: (d) => d.queryFailures({ category: 'integration', limit: 1 }) },
  STRATEGY_REWRITE: { softDep: 'agint.diagnosis', check: 'report', field: 'strategyPayload', fields: ['strategyId','oldSteps','newSteps','ordering'], probe: null },
};

function _checkDep(spec, dep) {
  if (!dep || typeof dep[spec.check] !== 'function') {
    throw new Error(`propose: ${spec.softDep}.${spec.check} 不可用`);
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
    if (typeof _diagnosisCompletedUnsubscribe === 'function') {
      try { _diagnosisCompletedUnsubscribe(); } catch { /* ignore */ }
      _diagnosisCompletedUnsubscribe = null;
    }
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
      proposals: p.size, commits: c.size,
      findings: f.size, metrics_log: m.size, limits: LIMITS,
    };
  }

  // mutation 事件写入 metrics_log（设计稿 §二.6 v2：commit/rollback success/failure/rollback/policy_reject）
  // eventType ∈ { 'mutation.success' | 'mutation.failure' | 'mutation.rollback' | 'mutation.policy_reject' }
  async function logMetric(business) {
    const t = await t_metrics();
    const currentCount = t.size;
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
        validInput.atomicScope === 'prompt' ? 'PROMPT_MUTATION 需要 annotate 读取 evidence' : 'STRATEGY_REWRITE 需要 report 读 windowDays 报告');
    }
    if (validInput.atomicScope === 'tool') {
      softDepOrThrow(ctx, 'agint.evolution', 'TOOL_SYNTHESIS 需要 queryFailures 读取 category=integration 失败模式');
    }

    // ── 6) LIMITS 守门
    const t = await t_proposals();
    const currentCount = t.size;
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
    if (tF.size >= LIMITS.FINDINGS) {
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
  /**
   * FROZEN payload 的 `diffStrategy` 落到哪（v0.6.7）。
   *
   * 背景：`DiffStrategySchema`（`lib/schema.js:36`）声明了
   * `unified_diff | line_replace` 两个值，但**本函数一直 `return p.newText` 整文件覆盖**，
   * 从不读这个字段。`docs/known-limitations/evolution-main-chain-not-energized.md:84`
   * 记过这个契约 bug 但一直没修。
   *
   * 为什么这次修：字段在 FROZEN schema 里，调用方（`agint-evolution-driver:582`、
   * eval 场景 JSON、各测试）**已经在传它并期待它被消费**。契约已经存在，消费方缺席。
   * 补消费方是接线，**不改 FROZEN schema 本身**（枚举值、字段名、类型都未动）⇒
   * 不触发 L0 变更。
   *
   * 语义（两个值都实装，不再只有一个是摆设）：
   *   - `line_replace`  **默认**：把 preimage 里的 `oldText` 片段替换成 `newText`。
   *     这是「局部替换」的真实语义 —— 改一段，不动文件其余部分。
   *   - `unified_diff`：`newText` 视为**改完后的完整文件内容**，整文件覆盖。
   *     与历史行为逐字节一致（下面有「兼容性」注释说明为何这样定）。
   *
   * 为什么 unified_diff 选「整文件覆盖」而不是「解析 unified diff 格式」：
   * 该值在仓库里的实际用法（driver:582、eval 场景 7 处、测试 20+ 处）**全部**把它当
   * 「我用 newText 整份给你」的标记用，从无一处传真正的 `@@ -x,y +a,b @@` 补丁文本。
   * 若改成解析补丁格式，这 30 处调用**全部**会静默失败（patch 解析不出来）。
   * 保守选择 = 与既有实际用法一致。
   *
   * ⚠️ `line_replace` 找不到 `oldText` 时 **throw**，不静默整文件覆盖。
   *    这正是 fail-closed：宁可不写（commit 会写 finding 并跳过），也不能把
   *    「我以为改了一段」变成「我把整个文件换掉了」——后者会毁掉别人的内容。
   */
  function generatePostimage(proposal, preimage) {
    const p = proposal.payload;
    if (proposal.kind === 'PROMPT_MUTATION') {
      const strategy = p.diffStrategy ?? 'line_replace';
      if (strategy === 'unified_diff') {
        return p.newText;   // 兼容：历史行为，逐字节一致
      }
      if (strategy === 'line_replace') {
        const base = typeof preimage === 'string' ? preimage : '';
        const idx = base.indexOf(p.oldText);
        if (idx === -1) {
          throw new Error(
            `commit: diffStrategy='line_replace' 但 preimage 中找不到 oldText（promptId=${p.promptId}）` +
            ` —— 拒绝整文件覆盖：调用方以为只改一段，实际会换掉整个文件。` +
            `oldText 前 60 字：${JSON.stringify(String(p.oldText).slice(0, 60))}`,
          );
        }
        if (base.indexOf(p.oldText, idx + 1) !== -1) {
          throw new Error(
            `commit: diffStrategy='line_replace' 且 oldText 在 preimage 中出现多次（promptId=${p.promptId}）` +
            ` —— 拒绝猜哪一处，调用方需给更长的唯一 oldText`,
          );
        }
        return base.slice(0, idx) + p.newText + base.slice(idx + p.oldText.length);
      }
      throw new Error(`commit: 未知 diffStrategy='${strategy}'（promptId=${p.promptId}）`);
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
    // v0.6.7：把 preimage 传进去 —— diffStrategy='line_replace' 需要它做局部替换
    const postimage = generatePostimage(proposal, preimageContent);
    await nodeFs.mkdir(dirname(absTarget), { recursive: true });
    await nodeFs.writeFile(absTarget, postimage, 'utf8');
    const postimageHash = await contentHash(postimage);
    const commitId = randomId();
    const committedAt = nowIso();

    // 软依赖：sandbox（决策 D3：默认 verify 模式）。mutation 关键路径，不静默。
    const sandbox = softDepOrThrow(ctx, 'agint.qualitySandbox', 'commit verify 必须 sandbox.runSmoke（决策 D3 默认 verify）；FROZEN Service 接口');
    // ── 5) sandbox verify
    // ⛔ 传 absTarget（绝对路径），不是 targetPath。理由与 driver v0.2.7→v0.2.8 同源：
    //   sandbox 内部 `const targetPath = resolve(target.path)` 是 Node 的 path.resolve，
    //   **按 process.cwd() 解析**。传相对路径会把它验成 cwd 下的另一个文件 ——
    //   2026-09-29 05:26Z 真实事故：driver 传 'bin/plugin-check.sh'，宿主 cwd 是
    //   C:\Users\Administrator\Desktop，于是仓库里那个文件被验成了桌面上的同名路径，
    //   failure_pattern 记 plugin-not-found，一路走到 policy.decide 才被拒。
    //   sandbox v0.7.2 已加 fail-closed 拒相对路径，这里改对即可（正确答案就在上方
    //   第 567 行，absTarget 早就算好了）。**不动 FROZEN payload schema** ——
    //   targetPath 本就是仓库相对路径，commit 侧有 repoRoot 能拼绝对路径，
    //   没必要把绝对路径塞进契约。
    const sandboxResult = await sandbox.runSmoke({
      target: { path: absTarget, name: `${targetPlugin}/${basename(targetPath)}` },
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
            { key: 'safety', name: 'safety', score: { score: 1.0, veto: false } },
            { key: 'trust', name: 'trust', score: { score: 1.0, veto: false } },
          ]
        : [
            { key: 'safety', name: 'safety', score: { score: 0.0, veto: true } },
            { key: 'trust', name: 'trust', score: { score: 0.0, veto: true } },
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
    if (tC.size >= LIMITS.COMMITS) {
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
   * `agint.mutator.recordExternalCommit(input) → { ok, commitId, recorded, reason? }`
   *
   * A5（2026-10-03 新增）**记账入口**，不是第二条落盘路径。
   *
   * 为什么需要它（这不是"补个计数"，是补一个功能缺口）：
   *   `agint-evolution-driver` 的 `commitToRepo` 走自己的落盘路径（见该文件头注
   *   「本插件的 commitToRepo 走的是自己的落盘路径（不经过 mutator.commit）」），
   *   所以 driver 产出的 commit **从不写 commits 表**。而 commits 表是
   *   `rollback()` 的唯一凭据：:770 从表里查 commitEntry、:786 用
   *   SHA-256 校验 preimageContent 防篡改、然后把内容写回 targetPath。
   *   ⇒ driver 的 commit 在 mutator 侧**根本无法回滚**，
   *     且 `mutator_stats.commits` 恒为 0（evolution-reconcile-core 的
   *     `mutatorDegraded` 因此恒告警）。
   *
   * 边界（本函数**只**做记账，绝不碰文件系统）：
   *   - 写盘、preimage 备份、sandbox、policy 决策：全是 driver 的活，本函数不重复做。
   *   - 因此 `policyDecision` 由 caller 传入，本函数**信任但不校验**（它没有
   *     独立证据可校验，硬校验只会自造假门禁）。`audit.sandboxResult` 同理。
   *   - 幂等：commitId 已存在 ⇒ 返回 { ok:true, recorded:false, reason:'duplicate' }，
   *     不重复写、不抛错（重试安全）。
   *
   * @param {object} input
   * @param {string} input.commitId      调用方生成的 commit 主键（幂等键）
   * @param {string} input.proposalId    对应 proposals 表的行（不强制存在，见下）
   * @param {string} input.targetPath     仓库相对路径（决策 D8 语义，与 commit() 一致）
   * @param {string} input.preimageContent 回退目标内容（rollback 的唯一凭据）
   * @param {string} input.postimageHash  落盘后内容的 SHA-256
   * @param {'AUTO_DEPLOY'|'PENDING_REVIEW'|'REJECT'|'ABSTAIN'} input.policyDecision
   * @param {object} input.audit          AuditSchema 字段
   * @returns {Promise<{ok:true, commitId:string, recorded:boolean, reason?:string}>}
   */
  async function recordExternalCommit(input) {
    if (!input || !input.commitId) throw new Error('recordExternalCommit: 缺 commitId');
    if (!input.proposalId) throw new Error('recordExternalCommit: 缺 proposalId');
    if (!input.targetPath) throw new Error('recordExternalCommit: 缺 targetPath');
    if (typeof input.preimageContent !== 'string' || input.preimageContent.length === 0) {
      // ⛔ 显式失败，不拿 '' 兜底。preimageContent 缺失/为空 = rollback 无凭据，
      //   写一条空内容进表会**假装**这条 commit 可回滚（rollback 会把文件写成空）。
      //   schema 侧 preimageContent 是 min(0)（TOOL_SYNTHESIS 新建文件确实没有
      //   preimage），所以空串必须在这里挡 —— 那类场景不该走本入口记账。
      throw new Error('recordExternalCommit: 缺 preimageContent（rollback 唯一凭据，不接受空串兜底）');
    }
    if (!input.postimageHash) throw new Error('recordExternalCommit: 缺 postimageHash');
    if (!input.audit) throw new Error('recordExternalCommit: 缺 audit');

    const tC = await t_commits();
    // 幂等：同 commitId 已记账则不重复写。
    if (tC.entries().some((e) => e.id === input.commitId)) {
      return { ok: true, commitId: input.commitId, recorded: false, reason: 'duplicate' };
    }
    if (tC.size >= LIMITS.COMMITS) {
      throw new Error(`recordExternalCommit: commits table full (cap ${LIMITS.COMMITS}) — 请手动 prune`);
    }
    // preimageContent 字节守门：与 commit() 同一上限（决策 D7），不新造第二个阈值。
    const preimageBytes = contentByteLength(input.preimageContent);
    if (preimageBytes > LIMITS.PREIMAGE_BYTES) {
      throw new Error(
        `recordExternalCommit: preimageContent ${preimageBytes} 字节超 `
        + `LIMITS.PREIMAGE_BYTES=${LIMITS.PREIMAGE_BYTES}（决策 D7 5MB 上限）`,
      );
    }
    // commits.preimageHash = SHA-256(实际文件内容)。driver 的 proposal.preimageHash
    // 是 payload 序列化 hash（设计稿 §2.1），语义不同，**不能**拿来填这个字段 ——
    // rollback 的 SHA-256 防篡改校验会比对 preimageContent 与 preimageHash。
    const preimageHash = await contentHash(input.preimageContent);
    const commitEntry = packCommit({
      ok: true,
      commitId: input.commitId,
      postimageHash: input.postimageHash,
      committedAt: input.committedAt || nowIso(),
      policyDecision: input.policyDecision,
      audit: input.audit,
      proposalId: input.proposalId,
      preimageHash,
      preimageContent: input.preimageContent,
      targetPath: input.targetPath,
    });
    await tC.put(commitEntry.id, commitEntry);

    // proposal 状态推进：commit() 会把 PENDING 改成 COMMITTED/REJECTED，driver 路径
    // 同样需要 —— 否则 proposal 永远停在 PENDING，而 proposals 表有
    // `uniq_atomicScope_pending` 唯一索引（决策 §2.6 v2）：同 atomicScope 的下一个
    // 提案会被自己的历史行永久挡住。生产实况正是如此（4 笔已 commit 的 proposal
    // 至今全是 PENDING）。
    // ⛔ 查不到 proposal 不抛错：driver 的 proposal 可能来自别的域（它自己有
    //   `evolve.listProposals`），mutator 不强求 proposals 表一定有对应行。
    //   但状态推不动这件事必须让调用方知道 ⇒ 记进 reason。
    let proposalNote = null;
    try {
      const tP = await t_proposals();
      const pe = tP.entries().find((e) => e.id === input.proposalId);
      if (!pe) {
        proposalNote = 'proposal-absent';
      } else {
        const nextStatus = (input.policyDecision === 'REJECT' || input.policyDecision === 'ABSTAIN')
          ? 'REJECTED' : 'COMMITTED';
        if (pe.status !== nextStatus) await tP.put(pe.id, { ...pe, status: nextStatus });
      }
    } catch (err) {
      // 记账本身已成功落表；状态推不动只降级为 reason，不把整次记账判失败。
      proposalNote = `proposal-update-failed: ${err?.message ?? String(err)}`;
    }

    return {
      ok: true, commitId: commitEntry.id, recorded: true,
      ...(proposalNote ? { reason: proposalNote } : {}),
    };
  }

  /**
   * `agint.mutator.rollback(input) → { ok, restoredHash, commitId, audit }`
   * 设计稿 §2.1 + Sprint 10 #5 §二.4：5 步 + 三段式事务
   *   1) 从 commits 表查 commit 记录
   *   2) SHA-256 校验 preimageContent 与 commits.preimageHash 一致（防外部篡改）
   *   3) 写 targetPath 恢复 preimage（TOOL_SYNTHESIS: preimageContent 为空 → unlink）
   *   4) 计算 restoredHash = SHA-256(恢复后内容)，与 preimageHash 比对
   *   5) proposal.status = 'ROLLED_BACK' + 写 mutation.rollback
   *
   * Sprint 10 #5 改造：
   *   - 同 pluginName 进程级串行（withMutex）；不同 pluginName 并行
   *   - step 3-4 包进三段式事务：原子快照 → 恢复 → smoke test
   *     - smoke 通过 → proposal.status='ROLLED_BACK' + mutation.rollback + 返回 ok
   *     - smoke 失败 → 自动恢复到 step 1 拍的安全位 + proposal.status 保持 COMMITTED + mutation.policy_reject
   *
   * FROZEN 签名 { commitId } → { ok, restoredHash } 不破；扩 4 个可选返回字段：
   *   rollbackTransactionId?, preimageHashAtStart?, smokeResult?, error?
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
      if (tF.size >= LIMITS.FINDINGS) {
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

    // 派生 pluginName：targetPath = plugins/<pluginName>/<subdir>/<file>（决策 D8）
    // 路径首段作 pluginName，找不到则抛错（mutation 关键路径，不静默）
    const targetPath = commitEntry.targetPath;
    const segs = String(targetPath).split('/').filter(Boolean);
    let pluginName = segs[0] === 'plugins' && segs.length >= 3 ? segs[1] : null;
    if (!pluginName) {
      // 兜底：proposalEntry 内部 _targetPlugin（propose 透传）
      const tp = getInternalField(proposalEntry, '_targetPlugin');
      if (tp) pluginName = tp;
    }
    if (!pluginName) {
      throw new Error(`rollback: 无法从 targetPath='${targetPath}' 派生 pluginName；proposal 缺 _targetPlugin 字段`);
    }

    // ── 三段式事务（同 pluginName 串行；不同 pluginName 并行）
    const txResult = await withMutex(pluginName, async () => {
      return runRollbackTransaction({
        ctx, commitEntry, proposal, repoRoot, pluginName,
        targetPath, nodeFs,
      });
    });

    // ── 4) restoredHash 比对（事务后，校验事务返回的 restoredHash 与 preimageHash 一致）
    if (txResult.restoredHash !== commitEntry.preimageHash) {
      const tF2 = await t_findings();
      if (tF2.size >= LIMITS.FINDINGS) {
        throw new Error(`findings table full (cap ${LIMITS.FINDINGS}) — 请手动 prune`);
      }
      const fb2 = packFinding({
        proposalId: commitEntry.proposalId,
        severity: 'error',
        message: `rollback: restoredHash ≠ preimageHash — commitId='${commitId}' restoredHash=${txResult.restoredHash.slice(0,16)}... 期望=${commitEntry.preimageHash.slice(0,16)}...`,
      });
      await tF2.put(fb2.id, fb2);
      throw new Error(`rollback: restoredHash ≠ preimageHash（不静默，已写 findings） — commitId='${commitId}'`);
    }

    // ── smoke 失败：自动恢复到安全位 + proposal 保持 COMMITTED + 写 mutation.policy_reject
    if (!txResult.smokeResult.ok) {
      // 写 mutation.policy_reject（设计稿 §二.6 v2 + Sprint 10 #5）
      try {
        await logMetric({
          eventType: 'mutation.policy_reject',
          proposalId: commitEntry.proposalId,
          commitId,
          source: proposal.source,
          kind: proposal.kind,
          atomicScope: proposal.atomicScope,
          reason: txResult.error || 'rollback-smoke-failed',
          policyDecision: 'ABSTAIN',
        });
      } catch (_metricErr) {
        // 指标写失败不阻断主流程（设计原则 §六：mutation 关键路径不静默，但 metrics 容许降级）
      }
      // 返回失败（新字段全部 optional，旧契约 ok=false 不破）
      return {
        ok: false,
        restoredHash: txResult.restoredHash,
        commitId,
        audit: { ...commitEntry.audit, timestamp: nowIso() },
        rollbackTransactionId: txResult.rollbackTransactionId,
        preimageHashAtStart: txResult.preimageHashAtStart,
        smokeResult: txResult.smokeResult,
        recovered: txResult.recovered,
        tags: txResult.tags,
        error: txResult.error || 'rollback-failed-smoke',
      };
    }

    // ── 5) smoke 通过：proposal.status = 'ROLLED_BACK' + mutation.rollback
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
    return {
      ok: true,
      restoredHash: txResult.restoredHash,
      commitId,
      audit,
      // Sprint 10 #5 新增 4 个可选字段（向后兼容）
      rollbackTransactionId: txResult.rollbackTransactionId,
      preimageHashAtStart: txResult.preimageHashAtStart,
      smokeResult: txResult.smokeResult,
    };
  }

  // ── Sprint 8 #5：3 条变异来源 Service + helpers（设计稿 §二.4） ──
  function softDepOrReturn(name) { const s = ctx && typeof ctx.get === 'function' ? ctx.get(name) : null; return { available: Boolean(s), service: s }; }
  async function degrade(source, reason, details) {
    const tF = await t_findings();
    if (tF.size >= LIMITS.FINDINGS) throw new Error(`findings table full (cap ${LIMITS.FINDINGS})`);
    const fb = packFinding({ proposalId: 'unknown', severity: 'warn', message: `${source}: ${reason}${details ? ' — ' + details : ''}` });
    await tF.put(fb.id, fb); return { ok: false, reason, finding: unpackFinding(fb) };
  }

  async function attributionDriven(input) {
    const source = 'attribution-driven'; const reason = 'root-cause-uncertain';
    const dep = softDepOrReturn('agint.diagnosis');
    if (!dep.available) return degrade(source, reason, 'agint.diagnosis 不可用');
    const { failureId, trajectory } = input || {};
    if (!failureId) return degrade(source, reason, '缺 failureId');
    let ann; try { ann = await dep.service.annotate({ failureId, trajectory }); }
    catch (e) { return degrade(source, reason, `annotate 抛错: ${e.message || e}`); }
    const rc = ann && ann.rootCause;
    if (!rc || rc === 'UNCERTAIN' || !/^(PROMPT_DEFICIENCY|TOOL_GAP|PLANNING_FAILURE)$/.test(rc))
      return degrade(source, reason, `rootCause='${rc}' 不在 3 类可路由枚举`);
    const kind = rc === 'PROMPT_DEFICIENCY' ? 'PROMPT_MUTATION' : rc === 'TOOL_GAP' ? 'TOOL_SYNTHESIS' : 'STRATEGY_REWRITE';
    const tp = _deriveTargetPlugin({ trajectory, metadata: trajectory && trajectory.metadata }) || _deriveTargetPlugin({ evidence: ann && ann.evidence });
    if (!tp) return degrade(source, reason, 'deriveTargetPlugin 4 优先序全失败');
    const sp = SOURCE_STUBS[kind];
    try { return { ok: true, proposal: await propose({ source, failureId, rootCause: rc, expectedEffect: sp.expectedEffect, rollbackCondition: sp.rollbackCondition, atomicScope: _scopeOfKind(kind), targetPlugin: tp, ...sp.payloadField }) }; }
    catch (e) { return degrade(source, reason, `propose 抛错: ${e.message || e}`); }
  }

  async function dreamRandom(input) {
    const source = 'dream-random'; const reason = 'dream-unavailable';
    const dep = softDepOrReturn('agint.dream');
    if (!dep.available) return degrade(source, reason, 'agint.dream 不可用');
    const seed = (input && input.seed != null) ? input.seed : Date.now();
    const kinds = _pickKindFromSeed(seed, MUTATION_KINDS, 1 + (Math.abs(Number(seed) || Date.now()) % 3));
    const tp = _deriveTargetPlugin({ metadata: input && input.metadata, evidence: input && input.context }) || _deriveTargetPlugin({ content: input && input.context }) || 'agint-mutator';
    const out = [];
    for (const kind of kinds) {
      const sp = SOURCE_STUBS[kind];
      try { out.push(await propose({ source, failureId: `dream-${seed}-${out.length}`, rootCause: _scopeToRoot(_scopeOfKind(kind)), expectedEffect: sp.expectedEffect, rollbackCondition: sp.rollbackCondition, atomicScope: _scopeOfKind(kind), targetPlugin: tp, ...sp.payloadField })); }
      catch (e) { await degrade(source, reason, `${kind} 派生失败: ${e.message || e}`); }
    }
    if (out.length === 0) return degrade(source, reason, `${kinds.length} 个 kind 全部派生失败`);
    return { ok: true, proposals: out };
  }

  async function evolutionReversed(input) {
    const source = 'evolution-reversed'; const reason = 'no-pattern-match';
    const dep = softDepOrReturn('agint.evolution');
    if (!dep.available) return degrade(source, reason, 'agint.evolution 不可用');
    const sub = input && input.patternSubstring;
    if (!sub || typeof sub !== 'string') return degrade(source, reason, '缺 patternSubstring');
    let matches = []; try { matches = await dep.service.queryFailures({ query: sub, limit: 50 }); }
    catch (e) { return degrade(source, reason, `queryFailures 抛错: ${e.message || e}`); }
    const filtered = (matches || []).filter((m) => m && (m.category === 'correctness' || m.category === 'integration'));
    if (filtered.length === 0) return degrade(source, reason, `failure_pattern 0 匹配（仅 category ∈ {correctness, integration} 纳入）`);
    const m = filtered[0]; const kind = _patternToKind(m); const sp = SOURCE_STUBS[kind];
    const reversed = _reversePayload(m, { ...sp.template }, kind);
    if (!reversed) return degrade(source, reason, `reversePayload 失败 kind=${kind}`);
    const tp = _deriveTargetPlugin({ pattern: m.pattern, evidence: m.evidence, metadata: m }) || _deriveTargetPlugin({ text: sub }) || 'agint-mutator';
    const field = kind === 'PROMPT_MUTATION' ? { promptPayload: reversed } : kind === 'TOOL_SYNTHESIS' ? { toolPayload: reversed } : { strategyPayload: reversed };
    try { return { ok: true, proposal: await propose({ source, failureId: `evorev-${m.id || sub}`, rootCause: _scopeToRoot(_scopeOfKind(kind)), expectedEffect: sp.expectedEffect, rollbackCondition: sp.rollbackCondition, atomicScope: _scopeOfKind(kind), targetPlugin: tp, ...field }) }; }
    catch (e) { return degrade(source, reason, `propose 抛错: ${e.message || e}`); }
  }

  // ── Service: publishMountRequest（Sprint 12 A4：消费方 publish mount.requested） ──
  // 目的：mutator 作为 mount 消费方上游，把"请求挂载"动作通过 bus 影子发布。
  // 红线（AGENTS.md / 设计稿 §A4）：**直连路径完整保留** —— bus 不可用时静默降级。
  // payload schema：plugins/agint-mount/schemas/mount-requested.schema.yaml v1
  // ⚠️ 2026-09-20 接线判定：**保持无生产调用点 —— 这不是漏接线，是刻意不接。**
  //   1. mount.requested 的发布方是 agint-mount 自己（orchestrator.js:190，挂载流程起点即发）。
  //      本服务若也发，同一件事在总线上出现两条，订阅方无法区分来源。
  //   2. 本服务的语义前提是「mutator 会主动发起挂载请求」，但 mutator 当前不发起
  //      （本文件除注册处外无 mount 相关调用），强行接调用点 = 造流量。
  //   3. 正解：将来真需要请求挂载时，调 agint.mount.request，由 mount 统一发事件。
  //   详见 docs/known-limitations/event-bus-shadow-publish-gap.md §6.2
  async function publishMountRequest(artifact) {
    if (!artifact || typeof artifact !== 'object') {
      return { published: false, reason: 'invalid-artifact' };
    }
    const ticketId = artifact.ticketId || ('t-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36));
    const proposalId = artifact.proposalId || artifact.id || 'unknown';
    const decision = artifact.decision || 'AUTO_DEPLOY';
    const publish = (typeof ctx.get === 'function') ? ctx.get('agint.eventBus.publish') : null;
    if (typeof publish !== 'function') {
      return { published: false, reason: 'eventBus-unavailable', directPathUnaffected: true };
    }
    const payload = { ticketId, proposalId, decision };
    try {
      const env = {
        topic: 'mount.requested',
        version: 1,
        source: 'agint-mutator',
        correlationId: ticketId,
        payload,
      };
      const result = await publish(env);
      return {
        published: true,
        envelopeId: result?.envelopeId,
        deliveredTo: result?.deliveredTo ?? 0,
        deadLettered: result?.deadLettered ?? 0,
        ticketId,
        proposalId,
      };
    } catch (err) {
      return { published: false, reason: `publish-threw:${err?.message || err}`, directPathUnaffected: true };
    }
  }

  ctx.provide('agint.mutator.propose', propose);
  ctx.provide('agint.mutator.validate', validate);
  ctx.provide('agint.mutator.commit', commit);
  // A5：记账入口。与其余 8 个 FROZEN 入口一样给**平铺 key**，不能只挂 umbrella 对象 ——
  // 伞键（agint.mutator）只有全名子键时 ctx.get('agint.mutator') 恒 undefined（见本文件
  // 2026-09-24 那段注释），而 driver 侧 dep('agint.mutator.recordExternalCommit') 取的是平铺 key。
  // 只挂伞键会让 driver 侧永远拿到 undefined，然后走 recordExternalCommit unavailable 分支。
  ctx.provide('agint.mutator.recordExternalCommit', recordExternalCommit);
  ctx.provide('agint.mutator.rollback', rollback);
  ctx.provide('agint.mutator.attributionDriven', attributionDriven);
  ctx.provide('agint.mutator.dreamRandom', dreamRandom);
  ctx.provide('agint.mutator.evolutionReversed', evolutionReversed);
  ctx.provide('agint.mutator.stats', stats);
  ctx.provide('agint.mutator.logMetric', logMetric); // #4 commit/rollback 调用入口
  ctx.provide('agint.mutator.checkLimit', checkLimit);
  ctx.provide('agint.mutator.limits', LIMITS);
  ctx.provide('agint.mutator.publishMountRequest', publishMountRequest); // Sprint 12 A4: 消费方 publish mount.requested

  // ── Sprint 12 / A6 — T1 影子期：subscribe diagnosis.completed ────────────────
  // 目的：观测 agint-diagnosis.report() 完成（影子期；写观测行 + 计数器，不进 mutator 主决策）。
  // 红线（AGENTS.md / 设计稿 §A6）：
  //   - 软降级：bus 不可用静默（subscribe 返回 undefined 时记录一次 warn，后续不再尝试）
  //   - 不修改 mutator 主决策路径（propose / validate / commit / rollback / 3 类来源接口）
  //   - 不新增 ctx.effect（合并进外层 lifecycle effect；smoke 测试断言 disposers.length === 1）
  // handler payload：plugins/agint-diagnosis/schemas/diagnosis-completed.schema.yaml v1
  let _diagnosisCompletedUnsubscribe = null;
  let _diagnosisCompletedObservationCount = 0;
  // 把 observationCount 通过 ctx.provide 暴露给 host 侧（scenario / smoke 用）
  ctx.provide('agint.mutator._diagnosisCompletedObservationCount', () => _diagnosisCompletedObservationCount);

  try {
    const subscribe = (typeof ctx.get === 'function') ? ctx.get('agint.eventBus.subscribe') : null;
    if (typeof subscribe !== 'function') {
      if (!disposed) console.warn('[agint-mutator] agint.eventBus.subscribe 不可用；diagnosis.completed 影子观察静默降级');
    } else {
      const handler = async (envelope) => {
        _diagnosisCompletedObservationCount++;
        try {
          const payload = envelope?.payload ?? {};
          const reportId = String(payload.reportId ?? 'unknown');
          const evaluatedAt = String(payload.evaluatedAt ?? '');
          const distribution = payload.rootCauseDistribution || {};
          const clusterCount = Number(payload.clusterCount ?? 0);
          if (!disposed) {
            // 控制台观测行（CI 友好；被 grep / scenario 观察得到）
            console.log(`[agint-mutator.observe] diagnosis.completed reportId=${reportId} evaluatedAt=${evaluatedAt} clusterCount=${clusterCount} distributionKeys=${Object.keys(distribution).join(',')} observationCount=${_diagnosisCompletedObservationCount}`);
          }
        } catch (_err) {
          // handler 永不抛（设计原则：影子订阅不影响发布方与其他订阅方）
        }
      };
      _diagnosisCompletedUnsubscribe = subscribe(
        {
          subscriber: 'agint-mutator',
          topics: ['diagnosis.completed'],
          mode: 'async',
          timeoutMs: 5000,
        },
        handler,
      );
    }
  } catch (err) {
    if (!disposed) console.error('[agint-mutator] eventBus.subscribe(diagnosis.completed) failed:', err?.message ?? err);
  }
  ctx.provide('agint.mutator.io', {
    packProposal, packCommit, packFinding, packMetricsLog,
    unpackProposal, unpackCommit, unpackFinding, unpackMetricsLog,
    randomId, nowIso, contentHash, checkPendingUnique,
  });

  // ── umbrella 键（2026-09-24 补）──────────────────────────────────────
  // cordis service store 扁平：只有全名子键时 ctx.get('agint.mutator') 恒 undefined。
  // agint-population 的 doMutatorRollback() 正是按命名空间取，且是 **D11 强制依赖** ——
  // 取不到就直接 throw，种群 cull / rollback 根本不可能执行。
  // 纯加法，全名子键一个不动。
  ctx.provide('agint.mutator', {
    propose,
    validate,
    commit,
    recordExternalCommit,
    rollback,
    attributionDriven,
    dreamRandom,
    evolutionReversed,
    stats,
    logMetric,
    checkLimit,
    limits: LIMITS,
    publishMountRequest,
    io: {
      packProposal, packCommit, packFinding, packMetricsLog,
      unpackProposal, unpackCommit, unpackFinding, unpackMetricsLog,
      randomId, nowIso, contentHash, checkPendingUnique,
    },
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
  // Sprint 8 #5 模块级 pure helpers（独立可测）
  _deriveTargetPlugin, _reversePayload, _pickKindFromSeed,
  _scopeToRoot, _scopeOfKind, _patternToKind,
};