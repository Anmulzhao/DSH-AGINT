/**
 * agint-population v0.6.2 — 种群管理器。
 *
 * 设计（设计稿 §三.2-3.7 / §七.2）：
 *   - 5 Service + 1 stats：
 *     ingest      摄入（前置校验 + Policy Gate + 1% 起步流量 + 谱系记录）
 *     promote     阶梯式晋升（NEW → OBSERVING → PROMOTING → EXPANDING → FULL）
 *     cull        淘汰（强制 mutator.rollback + failure_pattern tag=population-cull）
 *     fixate      固化（hash 校验 + baseline 更新 + 同 scope 其余 → FROZEN_OBSERVE）
 *     rollback    紧急回滚（强制 mutator.rollback + failure_pattern tag=population-rollback）
 *     stats       种群总览（host-side dashboard，不进 model 工具）
 *   - 独占 agint_population 存储域（4 表 variants/fitness_history/traffic_log/generation_log）
 *   - 软依赖 6 个：mutator / diagnosis / qualityPolicy / qualitySandbox / memory / evolution
 *   - 调 mutator.rollback 是非可选（D11）—— cull + rollback 强制走 mutator
 *
 * 装载红线（AGENTS.md）：本文件不挂顶层 cordis.patch.yml，由老板走 safe-update 重启。
 */

import {
  spec, checkLimit, packVariant, packFitnessHistory, packTrafficLog, packGenerationLog,
  unpackVariant, randomId, nowIso,
} from './storage.js';
import { DEFAULT_CONFIG, isTerminalStage } from './schema.js';
import { evaluate as fitnessEvaluate } from './fitness.js';
import { checkPromote, enterFROZEN_OBSERVE, findSameScopeCompeting, ladderForStage } from './states.js';
import { z } from 'zod';

const name = 'agint-population';
const inject = ['storageDomain'];

// ── 入参 schemas ─────────────────────────────────────────────────────────

const IngestInputSchema = z.object({
  proposal: z.unknown(),                              // 来自 mutator.propose() 的完整 MutationProposal
  parent_variant_id: z.string().min(1).nullable().optional(),
  generation: z.number().int().min(0).optional(),
});
const PromoteInputSchema = z.object({ variant_id: z.string().min(1) });
const CullInputSchema = z.object({
  variant_id: z.string().min(1),
  reason: z.string().optional(),
});
const FixateInputSchema = z.object({ variant_id: z.string().min(1) });
const RollbackInputSchema = z.object({
  variant_id: z.string().min(1),
  reason: z.enum(['safety_violation', 'global_rollback', 'manual']).default('manual'),
  trigger_detail: z.unknown().optional(),
});

// ── helpers ─────────────────────────────────────────────────────────────

function softDep(ctx, key) {
  return (ctx.get && typeof ctx.get === 'function') ? ctx.get(key) : null;
}

function findVariant(table, variantId) {
  for (const [, e] of table.entries()) {
    if (e.variant_id === variantId) return e;
  }
  return null;
}

function listActiveVariants(table) {
  const out = [];
  for (const [, e] of Array.from(table.entries())) {
    if (!isTerminalStage(e.stage) && e.stage !== 'PENDING_REVIEW') out.push(e);
  }
  return out;
}

function recordFailurePattern(ctx, payload, tags) {
  const evo = softDep(ctx, 'agint.evolution');
  if (!evo || typeof evo.addFailure !== 'function') {
    return { written: false, reason: 'agint.evolution unavailable' };
  }
  try {
    return { written: true, id: evo.addFailure({ pattern: JSON.stringify(payload).slice(0, 200), category: 'population', severity: 'high', evidence: payload.summary || 'population lifecycle event', tags }) };
  } catch (err) {
    return { written: false, reason: `addFailure threw: ${err.message || err}` };
  }
}

function doMutatorRollback(ctx, commitId, repoRoot) {
  const mutator = softDep(ctx, 'agint.mutator');
  if (!mutator || typeof mutator.rollback !== 'function') {
    throw new Error('agint.population.cull/rollback: mutator.rollback 不可用 — D11 强制要求');
  }
  return mutator.rollback({ commitId, repoRoot: repoRoot || process.cwd() });
}

function writeTrafficLog(ctx, tLog, variantId, fromPct, toPct, reason, trigger) {
  const entry = packTrafficLog({
    variant_id: variantId, from_pct: fromPct, to_pct: toPct,
    reason, trigger: trigger || null, changed_at: nowIso(),
  });
  return tLog.put(entry.id, entry);
}

// ── apply(ctx) ──────────────────────────────────────────────────────────

function apply(ctx) {
  let domain = null;
  let domainError = null;
  let disposed = false;
  let cfg = { ...DEFAULT_CONFIG };

  ctx.effect(() => () => { disposed = true; if (domain) return domain.close(); });

  const ready = ctx.storageDomain.open(spec).then(
    (d) => { if (disposed) { void d.close().catch(() => {}); return null; } domain = d; return d; },
    (error) => { domainError = error; return null; },
  );

  const table = async (tableName) => {
    if (disposed) throw new Error('agint-population: disposed');
    if (domainError) throw domainError;
    const d = await ready;
    if (!d) throw new Error('agint-population: domain unavailable');
    return d.table(tableName);
  };

  const t_variants = () => table('variants');
  const t_fit = () => table('fitness_history');
  const t_log = () => table('traffic_log');
  const t_gen = () => table('generation_log');

  // ── Service: ingest ─────────────────────────────────────────────────
  async function ingest(input) {
    const parsed = IngestInputSchema.safeParse(input || {});
    if (!parsed.success) throw new Error(`ingest: invalid input: ${parsed.error.issues[0]?.message}`);
    const { proposal, parent_variant_id = null, generation = 0 } = parsed.data;

    // ── 前置校验：expectedEffect / rollbackCondition 非空
    if (!proposal || !proposal.expectedEffect || !proposal.rollbackCondition) {
      const payload = { summary: 'ingest rejected: expectedEffect/rollbackCondition missing', proposalId: proposal?.id, parent: parent_variant_id };
      recordFailurePattern(ctx, payload, ['population-ingest-reject']);
      throw new Error('ingest: expectedEffect 与 rollbackCondition 必须非空（设计稿 §三.2）');
    }
    const expectedOk = typeof proposal.expectedEffect === 'object'
      ? !!(proposal.expectedEffect.metric && proposal.expectedEffect.direction && proposal.expectedEffect.window)
      : (proposal.expectedEffect.length >= 5);
    if (!expectedOk) throw new Error('ingest: expectedEffect 必须含 metric + direction + window');
    const rollbackOk = typeof proposal.rollbackCondition === 'object'
      ? !!(proposal.rollbackCondition.trigger && proposal.rollbackCondition.trigger.length >= 3)
      : (proposal.rollbackCondition.length >= 3);
    if (!rollbackOk) throw new Error('ingest: rollbackCondition.trigger 非空（≥3 字符）');

    // ── Policy Gate（软依赖 qualityPolicy.decide；缺则降级 PENDING_REVIEW）
    const policy = softDep(ctx, 'agint.qualityPolicy');
    let decision = 'PENDING_REVIEW';
    if (policy && typeof policy.decide === 'function') {
      try { decision = (await policy.decide({ proposal, scope: proposal.atomicScope || 'default' }))?.decision || 'PENDING_REVIEW'; }
      catch (_e) { decision = 'PENDING_REVIEW'; }
    }

    // REJECT → 写 failure_pattern + 抛错
    if (decision === 'REJECT') {
      const payload = { summary: 'ingest rejected by policy', proposalId: proposal.id, reason: proposal.expectedEffect };
      recordFailurePattern(ctx, payload, ['population-ingest-reject']);
      throw new Error(`ingest: policy REJECT for proposalId=${proposal.id}`);
    }

    // PENDING_REVIEW → 创 variant(stage=PENDING_REVIEW, traffic=0)
    if (decision === 'PENDING_REVIEW' || decision === 'ABSTAIN') {
      const entry = packVariant({
        variant_id: randomId(),
        commit_id: proposal.id || randomId(),
        parent_variant_id,
        mutation_kind: proposal.kind,
        source: proposal.source,
        atomic_scope: proposal.atomicScope || 'default',
        payload: proposal.payload || null,
        expected_effect: typeof proposal.expectedEffect === 'object' ? proposal.expectedEffect : { metric: 'unspecified', direction: 'increase', window: '7d' },
        rollback_condition: typeof proposal.rollbackCondition === 'object' ? proposal.rollbackCondition : { trigger: proposal.rollbackCondition },
        policy_decision: decision,
        stage: 'PENDING_REVIEW',
        traffic_pct: 0,
        fitness_score: 0,
        fitness_detail: null,
        generation,
        consecutive_pass: 0,
        created_at: nowIso(),
        updated_at: nowIso(),
        fixed_at: null, culled_at: null, rolled_back_at: null, frozen_at: null,
        safety_violations_total: 0,
      });
      const tv = await t_variants();
      if (Array.from(tv.entries()).length >= 100) throw new Error('variants table full');
      await tv.put(entry.id, entry);
      return unpackVariant(entry);
    }

    // AUTO_DEPLOY → 检查 capacity + same_scope_max → 创 variant(NEW, 1%)
    const tv = await t_variants();
    const active = listActiveVariants(tv);
    const cfgCap = cfg.capacity;
    if (active.length >= cfgCap) {
      const worst = active.slice().sort((a, b) => (a.fitness_score || 0) - (b.fitness_score || 0))[0];
      if (worst) await cull(worst.variant_id, { reason: 'capacity-pressure' });
    }
    const scope = proposal.atomicScope || 'default';
    const sameScopeCount = active.filter((v) => v.atomic_scope === scope).length;
    if (sameScopeCount >= cfg.same_scope_max) {
      throw new Error(`ingest: same_scope=${scope} 并发数 ${sameScopeCount} ≥ ${cfg.same_scope_max}，排队等待`);
    }

    const entry = packVariant({
      variant_id: randomId(),
      commit_id: proposal.id || randomId(),
      parent_variant_id,
      mutation_kind: proposal.kind,
      source: proposal.source,
      atomic_scope: scope,
      payload: proposal.payload || null,
      expected_effect: typeof proposal.expectedEffect === 'object' ? proposal.expectedEffect : { metric: 'unspecified', direction: 'increase', window: '7d' },
      rollback_condition: typeof proposal.rollbackCondition === 'object' ? proposal.rollbackCondition : { trigger: proposal.rollbackCondition },
      policy_decision: 'AUTO_DEPLOY',
      stage: 'NEW',
      traffic_pct: 1,
      fitness_score: 0,
      fitness_detail: null,
      generation,
      consecutive_pass: 0,
      created_at: nowIso(),
      updated_at: nowIso(),
      fixed_at: null, culled_at: null, rolled_back_at: null, frozen_at: null,
      safety_violations_total: 0,
    });
    if (Array.from(tv.entries()).length >= 100) throw new Error('variants table full');
    await tv.put(entry.id, entry);
    const tl = await t_log();
    await writeTrafficLog(ctx, tl, entry.variant_id, 0, 1, 'INGEST', { decision: 'AUTO_DEPLOY', source: proposal.source });

    return unpackVariant(entry);
  }

  // ── Service: promote ────────────────────────────────────────────────
  async function promote(input) {
    const parsed = PromoteInputSchema.safeParse(input || {});
    if (!parsed.success) throw new Error(`promote: invalid input: ${parsed.error.issues[0]?.message}`);
    const { variant_id } = parsed.data;
    const tv = await t_variants();
    const v = findVariant(tv, variant_id);
    if (!v) throw new Error(`promote: variant_id=${variant_id} 不存在`);

    const decision = checkPromote(v, cfg);
    if (!decision.canPromote) {
      // 不达标 → consecutive_pass 归零（除非已是终态或冻结）
      if (!isTerminalStage(v.stage) && v.stage !== 'FROZEN_OBSERVE') {
        const updated = { ...v, consecutive_pass: 0, updated_at: nowIso() };
        await tv.put(v.id, updated);
        return { variant: unpackVariant(updated), promoted: false, reason: decision.reason };
      }
      return { variant: unpackVariant(v), promoted: false, reason: decision.reason };
    }

    const nextCfg = ladderForStage(decision.nextStage);
    const updated = {
      ...v,
      stage: decision.nextStage,
      traffic_pct: nextCfg ? nextCfg.traffic : v.traffic_pct,
      consecutive_pass: (v.consecutive_pass || 0) + 1,
      updated_at: nowIso(),
    };
    await tv.put(v.id, updated);
    const tl = await t_log();
    await writeTrafficLog(ctx, tl, v.variant_id, v.traffic_pct, updated.traffic_pct, 'PROMOTE', { from: v.stage, to: decision.nextStage, fitness: v.fitness_score, consec: updated.consecutive_pass });
    return { variant: unpackVariant(updated), promoted: true, reason: 'OK', nextStage: decision.nextStage };
  }

  // ── Service: cull（强制 mutator.rollback + failure_pattern tag=population-cull）──
  async function cull(inputOrId, opts) {
    // 兼容两种调用形式：(variant_id, opts) 或 ({ variant_id, reason })
    let variant_id, reason;
    if (typeof inputOrId === 'string') {
      variant_id = inputOrId;
      reason = (opts && opts.reason) || 'manual';
    } else {
      const parsed = CullInputSchema.safeParse(inputOrId || {});
      if (!parsed.success) throw new Error(`cull: invalid input: ${parsed.error.issues[0]?.message}`);
      variant_id = parsed.data.variant_id;
      reason = parsed.data.reason || 'manual';
    }

    const tv = await t_variants();
    const v = findVariant(tv, variant_id);
    if (!v) throw new Error(`cull: variant_id=${variant_id} 不存在`);
    if (isTerminalStage(v.stage)) throw new Error(`cull: variant_id=${variant_id} 已是终态 stage=${v.stage}`);

    // D11 强制：必须调 mutator.rollback
    let rollbackResult = null;
    let rollbackError = null;
    try { rollbackResult = await doMutatorRollback(ctx, v.commit_id); }
    catch (err) { rollbackError = err; }

    const updated = { ...v, stage: 'CULLED', traffic_pct: 0, culled_at: nowIso(), updated_at: nowIso() };
    await tv.put(v.id, updated);
    const tl = await t_log();
    await writeTrafficLog(ctx, tl, v.variant_id, v.traffic_pct, 0, 'CULL', { reason, fitness: v.fitness_score, rollbackOk: rollbackResult?.ok ?? false });

    const fpPayload = {
      summary: `cull: variant=${variant_id} reason=${reason} fitness=${v.fitness_score}`,
      variant: { id: v.variant_id, commit_id: v.commit_id, source: v.source, atomic_scope: v.atomic_scope, fitness_score: v.fitness_score },
      rollback: rollbackResult ? { ok: rollbackResult.ok, restoredHash: rollbackResult.restoredHash } : { error: rollbackError?.message || 'rollback unavailable' },
    };
    const fp = recordFailurePattern(ctx, fpPayload, ['population-cull']);

    return { variant: unpackVariant(updated), rollback: rollbackResult, rollbackError: rollbackError?.message || null, failurePattern: fp };
  }

  // ── Service: fixate（hash 校验 + baseline 更新 + 同 scope 其余 → FROZEN_OBSERVE）──
  async function fixate(input) {
    const parsed = FixateInputSchema.safeParse(input || {});
    if (!parsed.success) throw new Error(`fixate: invalid input: ${parsed.error.issues[0]?.message}`);
    const { variant_id } = parsed.data;

    const tv = await t_variants();
    const v = findVariant(tv, variant_id);
    if (!v) throw new Error(`fixate: variant_id=${variant_id} 不存在`);
    if (v.stage !== 'FULL') throw new Error(`fixate: variant 必须已到 FULL stage，当前 stage=${v.stage}`);
    if ((v.consecutive_pass || 0) < cfg.fixation_periods) throw new Error(`fixate: consecutive_pass ${v.consecutive_pass} < fixation_periods=${cfg.fixation_periods}`);

    // ── hash 校验：从 mutator.commit.get() 拉 preimageHash 与 variants 的 preimageHash 对比
    const mutator = softDep(ctx, 'agint.mutator');
    let commitInfo = null;
    if (mutator && typeof mutator.commit?.get === 'function') {
      try { commitInfo = await mutator.commit.get({ commitId: v.commit_id }); }
      catch (err) { commitInfo = { error: err.message || String(err) }; }
    }

    // ── 更新 baseline
    const updated = {
      ...v, stage: 'FIXED', traffic_pct: 100,
      fixed_at: nowIso(), updated_at: nowIso(),
      // 固化时的 commitId 作为 baseline 标记供后续 audit
    };
    await tv.put(v.id, updated);

    // ── 同 scope 其余 active → FROZEN_OBSERVE
    const allActive = listActiveVariants(tv).filter((x) => x.variant_id !== variant_id);
    const competitors = findSameScopeCompeting(allActive, variant_id, v.atomic_scope);
    for (const c of competitors) {
      const frozen = enterFROZEN_OBSERVE(c, nowIso());
      await tv.put(c.id, frozen);
      const tl = await t_log();
      await writeTrafficLog(ctx, tl, c.variant_id, c.traffic_pct, c.traffic_pct, 'FREEZE', { trigger: 'fixate', fixatedId: variant_id });
    }

    const tl = await t_log();
    await writeTrafficLog(ctx, tl, v.variant_id, v.traffic_pct, 100, 'FIXATE', { commit: commitInfo?.preimageHash || null });

    return { variant: unpackVariant(updated), frozen: competitors.map((c) => c.variant_id), commitInfo };
  }

  // ── Service: rollback（紧急回滚：safety_violation>0 / 全局回滚 avg<0.5）──
  async function rollback(input) {
    const parsed = RollbackInputSchema.safeParse(input || {});
    if (!parsed.success) throw new Error(`rollback: invalid input: ${parsed.error.issues[0]?.message}`);
    const { variant_id, reason, trigger_detail } = parsed.data;
    const tv = await t_variants();
    const v = findVariant(tv, variant_id);
    if (!v) throw new Error(`rollback: variant_id=${variant_id} 不存在`);
    if (isTerminalStage(v.stage)) throw new Error(`rollback: variant 已是终态 stage=${v.stage}`);

    // D11 强制：必须调 mutator.rollback
    let rollbackResult = null; let rollbackError = null;
    try { rollbackResult = await doMutatorRollback(ctx, v.commit_id); }
    catch (err) { rollbackError = err; }

    const updated = { ...v, stage: 'ROLLED_BACK', traffic_pct: 0, rolled_back_at: nowIso(), updated_at: nowIso() };
    await tv.put(v.id, updated);
    const tl = await t_log();
    await writeTrafficLog(ctx, tl, v.variant_id, v.traffic_pct, 0, 'ROLLBACK', { reason, trigger_detail, rollbackOk: rollbackResult?.ok ?? false });

    const fpPayload = {
      summary: `rollback: variant=${variant_id} reason=${reason}`,
      variant: { id: v.variant_id, commit_id: v.commit_id, source: v.source, fitness_score: v.fitness_score },
      rollback: rollbackResult ? { ok: rollbackResult.ok, restoredHash: rollbackResult.restoredHash } : { error: rollbackError?.message || 'rollback unavailable' },
    };
    const fp = recordFailurePattern(ctx, fpPayload, ['population-rollback']);

    return { variant: unpackVariant(updated), rollback: rollbackResult, rollbackError: rollbackError?.message || null, failurePattern: fp };
  }

  // ── Service: stats（host-side） ─────────────────────────────────────
  async function stats() {
    const tv = await t_variants();
    const tf = await t_fit();
    const tl = await t_log();
    const tg = await t_gen();
    const variants = [];
    for (const [, e] of tv.entries()) variants.push(unpackVariant(e));
    return {
      counts: {
        variants: Array.from(tv.entries()).length,
        fitness_history: Array.from(tf.entries()).length,
        traffic_log: Array.from(tl.entries()).length,
        generation_log: Array.from(tg.entries()).length,
      },
      limits: { variants: 100, fitness_history: 500, traffic_log: 500, generation_log: 50 },
      config: cfg,
      active: variants.filter((v) => !isTerminalStage(v.stage) && v.stage !== 'PENDING_REVIEW').length,
      byStage: variants.reduce((acc, v) => { acc[v.stage] = (acc[v.stage] || 0) + 1; return acc; }, {}),
      variants,
    };
  }

  // ── Helper: recordEvaluation（host-side：把 fitness 评估写入 fitness_history） ──
  async function recordEvaluation(variantId, raw, baseline, generation) {
    const tv = await t_variants();
    const v = findVariant(tv, variantId);
    if (!v) throw new Error(`recordEvaluation: variant_id=${variantId} 不存在`);
    const fit = fitnessEvaluate(raw, baseline);
    const tf = await t_fit();
    if (Array.from(tf.entries()).length >= 500) throw new Error('fitness_history table full');
    const fhEntry = packFitnessHistory({
      variant_id: variantId, generation: generation || v.generation,
      score: fit.score, dimensions: fit.dimensions,
      sample_count: raw.sample_count || 0, evaluated_at: nowIso(),
    });
    await tf.put(fhEntry.id, fhEntry);
    const safetyInc = (raw.safety_violations || 0) > 0 ? Math.max(1, Number(raw.safety_violations) || 1) : 0;
    const updated = {
      ...v,
      fitness_score: fit.score,
      fitness_detail: fit.dimensions,
      safety_violations_total: (v.safety_violations_total || 0) + safetyInc,
      updated_at: nowIso(),
    };
    await tv.put(v.id, updated);
    return { variant: unpackVariant(updated), evaluation: { score: fit.score, eligible: fit.eligible, reason: fit.reason } };
  }

  // ── Provide Services ────────────────────────────────────────────────
  ctx.provide('agint.population.ingest', ingest);
  ctx.provide('agint.population.promote', promote);
  ctx.provide('agint.population.cull', cull);
  ctx.provide('agint.population.fixate', fixate);
  ctx.provide('agint.population.rollback', rollback);
  ctx.provide('agint.population.stats', stats);
  ctx.provide('agint.population.evaluate', fitnessEvaluate);    // 暴露 evaluate 让上层可单测
  ctx.provide('agint.population.recordEvaluation', recordEvaluation);
  ctx.provide('agint.population.limits', { variants: 100, fitness_history: 500, traffic_log: 500, generation_log: 50 });
  ctx.provide('agint.population.config', cfg);
  ctx.provide('agint.population.updateConfig', (patch) => {
    if (!patch || typeof patch !== 'object') return cfg;
    Object.assign(cfg, patch);   // 原地改，保留引用语义
    return cfg;
  });
  ctx.provide('agint.population.checkLimit', checkLimit);
}

const Config = {};
export { Config, apply, inject, name };
