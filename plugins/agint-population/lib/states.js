/**
 * agint-population: 11 阶段状态机 + 阶梯晋升 + 冻结观察池。
 *
 * 设计（设计稿 §六 + §三.5）：
 *
 *   COMMIT → POLICY_GATE → NEW(1%) → OBSERVING(5%) → PROMOTING(20%) →
 *   EXPANDING(50%) → FULL(100%) → FIXED
 *
 *   POLICY_GATE --REJECT------------------> REJECTED
 *   POLICY_GATE --PENDING_REVIEW----------> PENDING_REVIEW --approved--> NEW
 *   任何非终态 --fitness < CULL_THRESHOLD--> CULLED
 *   任何非终态 --safety_violation > 0------> ROLLED_BACK
 *   任何非终态 --全局回滚(种群avg<0.5)----> ROLLED_BACK
 *   FIXED --同scope其余变体--------------> FROZEN_OBSERVE
 *   FROZEN_OBSERVE --1世代后fitness<0.9x--> CULLED
 *   FROZEN_OBSERVE --1世代后fitness≥0.9x-> 重新进入 Ingest 队列
 *
 * 终态：REJECTED / FIXED / CULLED / ROLLED_BACK
 */

import { STAGE_LADDER, isTerminalStage } from './schema.js';

const TERMINAL_FAILURE = new Set(['CULLED', 'ROLLED_BACK', 'REJECTED']);
const TERMINAL_SUCCESS = new Set(['FIXED']);

/**
 * 是否可从 from 流转到 to（粗粒度 — 不含业务条件如 fitness）。
 * 终态除 FIXED（同 scope 可进 FROZEN_OBSERVE）外都不可流转。
 */
function canTransition(from, to) {
  if (isTerminalStage(from) && from !== 'FIXED') return false;
  // FIXED → FROZEN_OBSERVE 是允许的（同 scope 其余变体）
  if (from === 'FIXED' && to === 'FROZEN_OBSERVE') return true;
  // 同阶梯晋升
  const ladderOrder = STAGE_LADDER.map((s) => s.stage);
  const fi = ladderOrder.indexOf(from);
  const ti = ladderOrder.indexOf(to);
  if (fi >= 0 && ti === fi + 1) return true;
  // 旁路流转
  const allowed = {
    POLICY_GATE_REJECT: { from: 'POLICY_GATE', to: 'REJECTED' },
    POLICY_GATE_PENDING: { from: 'POLICY_GATE', to: 'PENDING_REVIEW' },
    PENDING_REVIEW_APPROVE: { from: 'PENDING_REVIEW', to: 'NEW' },
    ABSTAIN_TO_PENDING: { from: 'ABSTAIN', to: 'PENDING_REVIEW' },
  };
  for (const k of Object.keys(allowed)) {
    if (allowed[k].from === from && allowed[k].to === to) return true;
  }
  return false;
}

/**
 * 给定当前阶段，返回下一阶梯（null = 已到 FULL）。
 */
function nextLadderStage(currentStage) {
  const idx = STAGE_LADDER.findIndex((s) => s.stage === currentStage);
  if (idx < 0 || idx >= STAGE_LADDER.length - 1) return null;
  return STAGE_LADDER[idx + 1];
}

/**
 * 给定 stage 名，返回对应阶梯配置（null = 不在阶梯上）。
 */
function ladderForStage(stage) {
  return STAGE_LADDER.find((s) => s.stage === stage) || null;
}

/**
 * 给定 stage 名，返回该阶段的目标流量百分比。
 */
function trafficForStage(stage) {
  const cfg = ladderForStage(stage);
  return cfg ? cfg.traffic : 0;
}

/**
 * 判定 variant 是否满足晋升至下一阶梯的所有条件：
 *   - fitness ≥ 阈值
 *   - consecutive_pass ≥ 要求
 *   - 无安全违规（已硬门控为 fitness=0；双重保险）
 *   - stage 当前不是终态
 *
 * 返回 { canPromote, nextStage, reason }。
 */
function checkPromote(variant, cfg) {
  if (!variant || !variant.stage) return { canPromote: false, nextStage: null, reason: 'no stage' };
  if (isTerminalStage(variant.stage)) return { canPromote: false, nextStage: null, reason: 'terminal stage' };
  if (variant.stage === 'PENDING_REVIEW') return { canPromote: false, nextStage: null, reason: 'pending review' };
  if (variant.stage === 'FROZEN_OBSERVE') return { canPromote: false, nextStage: null, reason: 'frozen observe' };

  const current = ladderForStage(variant.stage);
  const next = nextLadderStage(variant.stage);
  if (!current || !next) return { canPromote: false, nextStage: null, reason: 'no next ladder step' };

  // 用 current stage 的 requirements（设计稿 §五.1：每阶段有「晋升条件」，
  // 满足当前阶段条件 → 升下一阶梯）
  const consecRequired = current.consec_required;
  const fitnessRequired = current.fitness_threshold;
  const consec = Number(variant.consecutive_pass || 0);
  const fitness = Number(variant.fitness_score || 0);
  const safetyViol = Number(variant.safety_violations_total || 0);

  if (safetyViol > 0) return { canPromote: false, nextStage: next.stage, reason: 'safety_violation>0' };
  if (fitness < fitnessRequired) return { canPromote: false, nextStage: next.stage, reason: `fitness ${fitness.toFixed(3)} < ${fitnessRequired}` };
  if (consec < consecRequired) return { canPromote: false, nextStage: next.stage, reason: `consecutive_pass ${consec} < ${consecRequired}` };

  return { canPromote: true, nextStage: next.stage, reason: 'OK' };
}

/**
 * 进入 FROZEN_OBSERVE：仅修改 stage + frozen_at，其余字段保留。
 */
function enterFROZEN_OBSERVE(variant, now) {
  return { ...variant, stage: 'FROZEN_OBSERVE', frozen_at: now, updated_at: now };
}

/**
 * FROZEN_OBSERVE 后 1 世代（设计稿 §五.5.3）：
 *   - ≥ Fixate 者的 frozen_observe_ratio（默认 0.9） → 可重入 Ingest
 *   - < 0.9 → Cull
 */
function decideFrozenOutcome(variant, fixatedFitness, cfg) {
  if (!variant || variant.stage !== 'FROZEN_OBSERVE') {
    return { action: 'noop', reason: 'not in FROZEN_OBSERVE' };
  }
  const ratio = (cfg && cfg.frozen_observe_ratio) || 0.9;
  const threshold = fixatedFitness * ratio;
  const fitness = Number(variant.fitness_score || 0);
  if (fitness >= threshold) return { action: 'reingest', reason: `fitness ${fitness.toFixed(3)} ≥ ${threshold.toFixed(3)}` };
  return { action: 'cull', reason: `fitness ${fitness.toFixed(3)} < ${threshold.toFixed(3)}` };
}

/**
 * 是否需要全局紧急回滚（种群 avg fitness 跌破阈值）。
 */
function shouldGlobalRollback(avgFitness, cfg) {
  const threshold = (cfg && cfg.global_rollback_threshold) || 0.5;
  return avgFitness < threshold;
}

/**
 * 是否触发淘汰条件（任一非终态 fitness < cull_threshold）。
 */
function shouldCull(variant, cfg) {
  if (!variant || isTerminalStage(variant.stage)) return false;
  const threshold = (cfg && cfg.cull_threshold) || 0.3;
  return Number(variant.fitness_score || 0) < threshold;
}

/**
 * 是否触发紧急回滚条件（safety_violations > 0 或全局阈值）。
 */
function shouldEmergencyRollback(variant, avgFitness, cfg) {
  if (!variant || isTerminalStage(variant.stage)) return false;
  if (Number(variant.safety_violations_total || 0) > 0) return true;
  return shouldGlobalRollback(avgFitness, cfg);
}

/**
 * 同 scope 竞争：返回除 fixatedId 外、active 状态的所有 variant（用于批量置 FROZEN_OBSERVE）。
 */
function findSameScopeCompeting(variants, fixatedId, fixatedScope) {
  const out = [];
  for (const v of variants || []) {
    if (v.variant_id === fixatedId) continue;
    if (v.stage === 'FIXED' || v.stage === 'CULLED' || v.stage === 'ROLLED_BACK' || v.stage === 'REJECTED') continue;
    if (v.atomic_scope === fixatedScope) out.push(v);
  }
  return out;
}

export {
  canTransition,
  nextLadderStage,
  ladderForStage,
  trafficForStage,
  checkPromote,
  enterFROZEN_OBSERVE,
  decideFrozenOutcome,
  shouldGlobalRollback,
  shouldCull,
  shouldEmergencyRollback,
  findSameScopeCompeting,
  TERMINAL_FAILURE,
  TERMINAL_SUCCESS,
};
