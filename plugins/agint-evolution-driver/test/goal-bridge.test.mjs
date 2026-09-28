/**
 * goal-bridge 测试（行动 #2b，2026-09-28）。
 * 覆盖：kill-switch 判定、objective 构建、createEvolutionGoal 的成功/降级/错误路径。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isGoalBridgeEnabled,
  buildGoalObjective,
  createEvolutionGoal,
  GOAL_BRIDGE_ENV,
} from '../lib/goal-bridge.js';

const CANDIDATE = {
  id: 'prop-42',
  title: '让 metrics 汇总透传 meta',
  body: 'summary() 需要把 meta 透传到汇总行，避免神谕层美总分虚标 100。',
  source: 'agint.evolve proposed / #17',
};

test('isGoalBridgeEnabled: 只有显式 on 才开（影子期默认关）', () => {
  assert.equal(isGoalBridgeEnabled({ [GOAL_BRIDGE_ENV]: 'on' }), true);
  assert.equal(isGoalBridgeEnabled({ [GOAL_BRIDGE_ENV]: ' ON ' }), true);
  assert.equal(isGoalBridgeEnabled({ [GOAL_BRIDGE_ENV]: 'off' }), false);
  assert.equal(isGoalBridgeEnabled({ [GOAL_BRIDGE_ENV]: '1' }), false);
  assert.equal(isGoalBridgeEnabled({}), false);
  assert.equal(isGoalBridgeEnabled(undefined), false);
});

test('buildGoalObjective: 拼入 title + 截断 body + 来源 + 提案 id + 完成标准', () => {
  const obj = buildGoalObjective(CANDIDATE);
  assert.ok(obj.startsWith('AGINT 进化目标：让 metrics 汇总透传 meta'));
  assert.ok(obj.includes('背景：summary() 需要把 meta 透传到汇总行'));
  assert.ok(obj.includes('来源：agint.evolve proposed / #17'));
  assert.ok(obj.includes('提案：prop-42'));
  assert.ok(obj.includes('完成标准'));
});

test('buildGoalObjective: body 超长 → 截断到 GOAL_BODY_SNIPPET', () => {
  const long = { title: 't', body: 'x'.repeat(600), source: 's' };
  const obj = buildGoalObjective(long);
  assert.ok(obj.length < 600 + 200, `objective 应截断，实际 ${obj.length}`);
  assert.ok(obj.includes('…'));
});

test('buildGoalObjective: 缺字段 → 兜底占位不抛', () => {
  const obj = buildGoalObjective({});
  assert.ok(obj.includes('<untitled proposal>'));
  assert.ok(obj.includes('完成标准'));
});

test('createEvolutionGoal: kill-switch off → created:false + kill-switch-off', async () => {
  const r = await createEvolutionGoal({ agent: {}, candidate: CANDIDATE, goals: {}, env: {} });
  assert.deepEqual(r, { created: false, reason: 'kill-switch-off' });
});

test('createEvolutionGoal: goals 服务不可用 → goals-unavailable', async () => {
  const r = await createEvolutionGoal({ agent: {}, candidate: CANDIDATE, goals: null, env: { [GOAL_BRIDGE_ENV]: 'on' } });
  assert.deepEqual(r, { created: false, reason: 'goals-unavailable' });
});

test('createEvolutionGoal: 成功 → created:true + goalId/phase', async () => {
  let receivedAgent = null;
  let receivedRequest = null;
  const goals = {
    create: async (agent, request) => {
      receivedAgent = agent;
      receivedRequest = request;
      return { id: 'goal-abc', phase: 'active' };
    },
  };
  const r = await createEvolutionGoal({ agent: { id: 'a1' }, candidate: CANDIDATE, goals, env: { [GOAL_BRIDGE_ENV]: 'on' } });
  assert.deepEqual(r, { created: true, goalId: 'goal-abc', phase: 'active' });
  assert.equal(receivedAgent.id, 'a1');
  assert.ok(receivedRequest.objective.startsWith('AGINT 进化目标'));
});

test('createEvolutionGoal: opts.maxGoalRounds 透传', async () => {
  let receivedRequest = null;
  const goals = {
    create: async (_agent, request) => {
      receivedRequest = request;
      return { id: 'g1', phase: 'active' };
    },
  };
  await createEvolutionGoal({
    agent: {}, candidate: CANDIDATE, goals,
    env: { [GOAL_BRIDGE_ENV]: 'on' }, opts: { maxGoalRounds: 12 },
  });
  assert.equal(receivedRequest.maxGoalRounds, 12);
});

test('createEvolutionGoal: goals.create 抛错 → created:false + reason（不抛）', async () => {
  const goals = {
    create: async () => { throw new Error('GOAL_ALREADY_EXISTS'); },
  };
  const r = await createEvolutionGoal({ agent: {}, candidate: CANDIDATE, goals, env: { [GOAL_BRIDGE_ENV]: 'on' } });
  assert.deepEqual(r, { created: false, reason: 'GOAL_ALREADY_EXISTS' });
});
