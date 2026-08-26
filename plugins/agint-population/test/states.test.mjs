// 状态机单元测试 — 覆盖 canTransition / 阶梯晋升 / FROZEN_OBSERVE / 淘汰/紧急回滚判定。

import test from 'node:test';
import assert from 'node:assert/strict';

import * as states from '../lib/states.js';
import * as schema from '../lib/schema.js';

const CFG = { ...schema.DEFAULT_CONFIG };

// ── canTransition ──────────────────────────────────────────────────────

test('canTransition: 阶梯晋升 NEW→OBSERVING→PROMOTING→EXPANDING→FULL', () => {
  assert.equal(states.canTransition('NEW', 'OBSERVING'), true);
  assert.equal(states.canTransition('OBSERVING', 'PROMOTING'), true);
  assert.equal(states.canTransition('PROMOTING', 'EXPANDING'), true);
  assert.equal(states.canTransition('EXPANDING', 'FULL'), true);
  assert.equal(states.canTransition('NEW', 'PROMOTING'), false, '不允许跳级');
  assert.equal(states.canTransition('OBSERVING', 'FULL'), false);
});

test('canTransition: 旁路流转 POLICY_GATE → REJECTED / PENDING_REVIEW', () => {
  assert.equal(states.canTransition('POLICY_GATE', 'REJECTED'), true);
  assert.equal(states.canTransition('POLICY_GATE', 'PENDING_REVIEW'), true);
  assert.equal(states.canTransition('PENDING_REVIEW', 'NEW'), true);
  assert.equal(states.canTransition('ABSTAIN', 'PENDING_REVIEW'), true);
});

test('canTransition: 终态不可流转（除 FIXED → FROZEN_OBSERVE）', () => {
  assert.equal(states.canTransition('CULLED', 'NEW'), false);
  assert.equal(states.canTransition('CULLED', 'OBSERVING'), false);
  assert.equal(states.canTransition('ROLLED_BACK', 'NEW'), false);
  assert.equal(states.canTransition('REJECTED', 'NEW'), false);
  assert.equal(states.canTransition('FIXED', 'FROZEN_OBSERVE'), true, 'D10 同 scope 其余 → FROZEN_OBSERVE');
  assert.equal(states.canTransition('FIXED', 'NEW'), false);
});

// ── nextLadderStage / ladderForStage / trafficForStage ──────────────────

test('nextLadderStage: NEW→OBSERVING / FULL→null', () => {
  assert.equal(states.nextLadderStage('NEW').stage, 'OBSERVING');
  assert.equal(states.nextLadderStage('OBSERVING').stage, 'PROMOTING');
  assert.equal(states.nextLadderStage('PROMOTING').stage, 'EXPANDING');
  assert.equal(states.nextLadderStage('EXPANDING').stage, 'FULL');
  assert.equal(states.nextLadderStage('FULL'), null);
  assert.equal(states.nextLadderStage('CULLED'), null);
  assert.equal(states.nextLadderStage('FROZEN_OBSERVE'), null);
});

test('ladderForStage / trafficForStage: 5 阶梯流量 1/5/20/50/100', () => {
  assert.equal(states.trafficForStage('NEW'), 1);
  assert.equal(states.trafficForStage('OBSERVING'), 5);
  assert.equal(states.trafficForStage('PROMOTING'), 20);
  assert.equal(states.trafficForStage('EXPANDING'), 50);
  assert.equal(states.trafficForStage('FULL'), 100);
  assert.equal(states.trafficForStage('FIXED'), 0);
  assert.equal(states.trafficForStage('CULLED'), 0);
});

// ── checkPromote ──────────────────────────────────────────────────────

test('checkPromote: fitness ≥ 阈值 + consec ≥ 要求 → 可晋升', () => {
  const v = { stage: 'NEW', fitness_score: 0.6, consecutive_pass: 1, safety_violations_total: 0 };
  const d = states.checkPromote(v, CFG);
  assert.equal(d.canPromote, true);
  assert.equal(d.nextStage, 'OBSERVING');
});

test('checkPromote: fitness 不足 → 不可晋升', () => {
  const v = { stage: 'NEW', fitness_score: 0.45, consecutive_pass: 5, safety_violations_total: 0 };
  const d = states.checkPromote(v, CFG);
  assert.equal(d.canPromote, false);
  assert.match(d.reason, /fitness 0\.450/);
});

test('checkPromote: consecutive_pass 不足 → 不可晋升', () => {
  const v = { stage: 'OBSERVING', fitness_score: 0.8, consecutive_pass: 0, safety_violations_total: 0 };
  const d = states.checkPromote(v, CFG);
  assert.equal(d.canPromote, false);
  assert.match(d.reason, /consecutive_pass/);
});

test('checkPromote: safety 违规 → 不可晋升（双重保险）', () => {
  const v = { stage: 'NEW', fitness_score: 0.9, consecutive_pass: 5, safety_violations_total: 1 };
  const d = states.checkPromote(v, CFG);
  assert.equal(d.canPromote, false);
  assert.match(d.reason, /safety_violation/);
});

test('checkPromote: 终态不可晋升', () => {
  const v = { stage: 'CULLED', fitness_score: 0.9, consecutive_pass: 5, safety_violations_total: 0 };
  assert.equal(states.checkPromote(v, CFG).canPromote, false);
  const v2 = { stage: 'FIXED', fitness_score: 0.9, consecutive_pass: 5, safety_violations_total: 0 };
  assert.equal(states.checkPromote(v2, CFG).canPromote, false);
  const v3 = { stage: 'ROLLED_BACK', fitness_score: 0.9, consecutive_pass: 5, safety_violations_total: 0 };
  assert.equal(states.checkPromote(v3, CFG).canPromote, false);
});

test('checkPromote: PENDING_REVIEW / FROZEN_OBSERVE 不在晋升路径', () => {
  const v1 = { stage: 'PENDING_REVIEW', fitness_score: 0.9, consecutive_pass: 5, safety_violations_total: 0 };
  assert.match(states.checkPromote(v1, CFG).reason, /pending review/);
  const v2 = { stage: 'FROZEN_OBSERVE', fitness_score: 0.9, consecutive_pass: 5, safety_violations_total: 0 };
  assert.match(states.checkPromote(v2, CFG).reason, /frozen observe/);
});

// ── enterFROZEN_OBSERVE ───────────────────────────────────────────────

test('enterFROZEN_OBSERVE: 修改 stage + frozen_at，其余字段保留', () => {
  const v = { variant_id: 'v-1', stage: 'PROMOTING', traffic_pct: 20, fitness_score: 0.7, atomic_scope: 'prompt' };
  const f = states.enterFROZEN_OBSERVE(v, '2026-08-26T10:00:00Z');
  assert.equal(f.stage, 'FROZEN_OBSERVE');
  assert.equal(f.frozen_at, '2026-08-26T10:00:00Z');
  assert.equal(f.updated_at, '2026-08-26T10:00:00Z');
  assert.equal(f.variant_id, 'v-1');
  assert.equal(f.atomic_scope, 'prompt');
  assert.equal(f.traffic_pct, 20, 'FROZEN_OBSERVE 不直接修改 traffic_pct');
});

// ── decideFrozenOutcome ───────────────────────────────────────────────

test('decideFrozenOutcome: fitness ≥ 0.9×fixate → reingest', () => {
  const d = states.decideFrozenOutcome({ stage: 'FROZEN_OBSERVE', fitness_score: 0.95 }, 1.0, CFG);
  assert.equal(d.action, 'reingest');
  assert.match(d.reason, /0\.950/);
});

test('decideFrozenOutcome: fitness < 0.9×fixate → cull', () => {
  const d = states.decideFrozenOutcome({ stage: 'FROZEN_OBSERVE', fitness_score: 0.85 }, 1.0, CFG);
  assert.equal(d.action, 'cull');
});

test('decideFrozenOutcome: 非 FROZEN_OBSERVE 阶段 → noop', () => {
  const d = states.decideFrozenOutcome({ stage: 'PROMOTING', fitness_score: 0.5 }, 1.0, CFG);
  assert.equal(d.action, 'noop');
});

// ── shouldCull / shouldEmergencyRollback / shouldGlobalRollback ────────

test('shouldCull: fitness < cull_threshold(0.3) → true', () => {
  assert.equal(states.shouldCull({ stage: 'OBSERVING', fitness_score: 0.25 }, CFG), true);
  assert.equal(states.shouldCull({ stage: 'OBSERVING', fitness_score: 0.35 }, CFG), false);
  // 终态不触发 cull
  assert.equal(states.shouldCull({ stage: 'CULLED', fitness_score: 0.1 }, CFG), false);
});

test('shouldGlobalRollback: 种群 avg < 0.5 → true', () => {
  assert.equal(states.shouldGlobalRollback(0.4, CFG), true);
  assert.equal(states.shouldGlobalRollback(0.6, CFG), false);
  assert.equal(states.shouldGlobalRollback(0.5, CFG), false, '0.5 边界不算');
});

test('shouldEmergencyRollback: safety_violation>0 或全局 avg<0.5 → true', () => {
  assert.equal(states.shouldEmergencyRollback({ stage: 'PROMOTING', safety_violations_total: 1 }, 0.8, CFG), true);
  assert.equal(states.shouldEmergencyRollback({ stage: 'PROMOTING', safety_violations_total: 0 }, 0.4, CFG), true);
  assert.equal(states.shouldEmergencyRollback({ stage: 'PROMOTING', safety_violations_total: 0 }, 0.8, CFG), false);
  // 终态不触发
  assert.equal(states.shouldEmergencyRollback({ stage: 'CULLED', safety_violations_total: 1 }, 0.4, CFG), false);
});

// ── findSameScopeCompeting ────────────────────────────────────────────

test('findSameScopeCompeting: 仅返回同 scope 且非终态的变体', () => {
  const all = [
    { variant_id: 'A', stage: 'FIXED', atomic_scope: 'prompt' },         // 自己
    { variant_id: 'B', stage: 'PROMOTING', atomic_scope: 'prompt' },      // 同 scope + active
    { variant_id: 'C', stage: 'PROMOTING', atomic_scope: 'tool' },        // 不同 scope
    { variant_id: 'D', stage: 'OBSERVING', atomic_scope: 'prompt' },      // 同 scope + active
    { variant_id: 'E', stage: 'CULLED', atomic_scope: 'prompt' },         // 同 scope + 终态
    { variant_id: 'F', stage: 'FIXED', atomic_scope: 'prompt' },          // 同 scope + 终态
  ];
  const result = states.findSameScopeCompeting(all, 'A', 'prompt');
  const ids = result.map((v) => v.variant_id);
  assert.deepEqual(ids, ['B', 'D']);
});
