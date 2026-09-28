/**
 * human-approval bridge 测试（行动 #4，2026-09-28）。
 * 覆盖：四分支映射、被拒→人工可继续状态机、askHuman 的 skip/approval/deferred
 * 三通道、decideWithHumanFallback 组合。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapDecisionToApproval,
  applyHumanOutcome,
  askHuman,
  decideWithHumanFallback,
  GRANT_OUTCOME,
} from '../lib/human-approval.js';

const T = (kind, targetId = 't1') => ({ kind, targetId });

// ---- mapDecisionToApproval：四分支映射 ----

test('map: AUTO_DEPLOY → skip（无需人工）', () => {
  assert.deepEqual(mapDecisionToApproval(T('AUTO_DEPLOY')), {
    action: 'skip', reason: 'auto-deploy: no human needed', kind: 'AUTO_DEPLOY',
  });
});

test('map: PENDING_REVIEW → ask（需人工确认）', () => {
  const r = mapDecisionToApproval(T('PENDING_REVIEW'));
  assert.equal(r.action, 'ask');
  assert.equal(r.kind, 'PENDING_REVIEW');
});

test('map: REJECT → escalate（被拒可人工继续）', () => {
  const r = mapDecisionToApproval(T('REJECT'));
  assert.equal(r.action, 'escalate');
  assert.match(r.reason, /human may continue/);
});

test('map: ABSTAIN → escalate（人工决定）', () => {
  const r = mapDecisionToApproval(T('ABSTAIN'));
  assert.equal(r.action, 'escalate');
});

test('map: 未知 kind → skip + 提示', () => {
  const r = mapDecisionToApproval(T('WEIRD'));
  assert.equal(r.action, 'skip');
  assert.match(r.reason, /unknown kind/);
});

// ---- applyHumanOutcome：被拒→人工可继续状态机 ----

test('apply: REJECT + allowed-once → 升级 PENDING_REVIEW，可继续（humanOverride）', () => {
  const r = applyHumanOutcome(T('REJECT'), GRANT_OUTCOME, { actor: 'boss' });
  assert.equal(r.kind, 'PENDING_REVIEW');
  assert.equal(r.continueAllowed, true);
  assert.equal(r.humanOverride, true);
  assert.equal(r.humanApproval.actor, 'boss');
});

test('apply: ABSTAIN + allowed-once → 升级 PENDING_REVIEW，可继续', () => {
  const r = applyHumanOutcome(T('ABSTAIN'), GRANT_OUTCOME);
  assert.equal(r.kind, 'PENDING_REVIEW');
  assert.equal(r.continueAllowed, true);
});

test('apply: PENDING_REVIEW + allowed-once → 人工批准，可继续（humanApproved）', () => {
  const r = applyHumanOutcome(T('PENDING_REVIEW'), GRANT_OUTCOME);
  assert.equal(r.humanApproved, true);
  assert.equal(r.continueAllowed, true);
});

test('apply: REJECT + rejected → 终态拒绝，不可继续', () => {
  const r = applyHumanOutcome(T('REJECT'), 'rejected');
  assert.equal(r.continueAllowed, false);
  assert.equal(r.final, true);
  assert.equal(r.humanApproval.outcome, 'rejected');
});

test('apply: REJECT + unavailable → 未决 pending，保持原 kind（不擅自放行）', () => {
  const r = applyHumanOutcome(T('REJECT'), 'unavailable');
  assert.equal(r.kind, 'REJECT');
  assert.equal(r.continueAllowed, false);
  assert.equal(r.pending, true);
});

test('apply: AUTO_DEPLOY + allowed-once → 可继续（不变）', () => {
  const r = applyHumanOutcome(T('AUTO_DEPLOY'), GRANT_OUTCOME);
  assert.equal(r.kind, 'AUTO_DEPLOY');
  assert.equal(r.continueAllowed, true);
});

// ---- askHuman：三通道 ----

test('ask: AUTO_DEPLOY → skip 通道（不发审批）', async () => {
  let called = false;
  const r = await askHuman({
    target: T('AUTO_DEPLOY'),
    deps: { getApproval: () => ({ request: async () => { called = true; return 'allowed-once'; } }) },
  });
  assert.equal(r.channel, 'skip');
  assert.equal(called, false);
});

test('ask: approval 服务不可用 → deferred + pending（不抛）', async () => {
  const r = await askHuman({ target: T('REJECT'), deps: { getApproval: () => null } });
  assert.equal(r.channel, 'deferred');
  assert.equal(r.outcome, 'pending');
  assert.equal(r.reason, 'approval service unavailable');
});

test('ask: request 抛错（host 无 open turn）→ deferred + pending（降级不阻断）', async () => {
  const r = await askHuman({
    target: T('PENDING_REVIEW'),
    deps: {
      getApproval: () => ({
        request: async () => { throw new Error('approval.request() outside an open turn'); },
      }),
    },
  });
  assert.equal(r.channel, 'deferred');
  assert.equal(r.outcome, 'pending');
  assert.match(r.reason, /outside an open turn/);
});

test('ask: request 返回 allowed-once → approval 通道 + grant', async () => {
  let received = null;
  const r = await askHuman({
    target: T('PENDING_REVIEW'),
    opts: { agent: { id: 'a1' }, requestArgs: { toolName: 'skill_autocreate_release', message: 'approve?' } },
    deps: {
      getApproval: () => ({
        request: async (req) => { received = req; return 'allowed-once'; },
      }),
    },
  });
  assert.equal(r.channel, 'approval');
  assert.equal(r.outcome, GRANT_OUTCOME);
  assert.equal(received.agent.id, 'a1');
  assert.equal(received.toolName, 'skill_autocreate_release');
});

test('ask: request 返回未知值 → 归一化为 unavailable', async () => {
  const r = await askHuman({
    target: T('REJECT'),
    deps: { getApproval: () => ({ request: async () => 'weird-value' }) },
  });
  assert.equal(r.channel, 'approval');
  assert.equal(r.outcome, 'unavailable');
});

// ---- decideWithHumanFallback：组合 ----

test('decideWithHumanFallback: REJECT + 宿主批准 → 决策升级 PENDING_REVIEW', async () => {
  const r = await decideWithHumanFallback({
    target: T('REJECT', 'skill-x'),
    deps: { getApproval: () => ({ request: async () => 'allowed-once' }) },
    opts: { actor: 'boss' },
  });
  assert.equal(r.ask.channel, 'approval');
  assert.equal(r.decision.kind, 'PENDING_REVIEW');
  assert.equal(r.decision.continueAllowed, true);
  assert.equal(r.decision.humanOverride, true);
});

test('decideWithHumanFallback: REJECT + 宿主拒绝 → 终态拒绝', async () => {
  const r = await decideWithHumanFallback({
    target: T('REJECT'),
    deps: { getApproval: () => ({ request: async () => 'rejected' }) },
  });
  assert.equal(r.decision.continueAllowed, false);
  assert.equal(r.decision.final, true);
});

test('decideWithHumanFallback: AUTO_DEPLOY → 不碰审批，决策不变', async () => {
  const r = await decideWithHumanFallback({ target: T('AUTO_DEPLOY'), deps: {} });
  assert.equal(r.ask.channel, 'skip');
  assert.equal(r.decision.kind, 'AUTO_DEPLOY');
});
