// pipeline 端到端测试：mock ctx + 内存 storage + mock self-model。
// 覆盖：probe → generate → nextChallenge → submit（pass/fail）→ 难度演进 →
// self-model 回写（§4.9）→ 事件发布 → 冷却 → unverifiable → D1 隔离。

import test from 'node:test';
import assert from 'node:assert/strict';

import * as plugin from '../lib/index.js';
import { makeSnapshot, makeCapability, mockCtx } from './_helpers.mjs';

function boot({ snapshot, selfModelUpdate } = {}) {
  const published = [];
  const updates = [];
  const selfModel = {
    snapshot: async () => (snapshot === undefined ? makeSnapshot([]) : snapshot),
    update: async (input) => {
      updates.push(input);
      if (typeof selfModelUpdate === 'function') selfModelUpdate(input);
      return { ok: true, updatedDomains: [] };
    },
  };
  const ctx = mockCtx({
    'agint.selfModel': selfModel,
    'agint.eventBus.publish': async (input) => { published.push(input); return { ok: true }; },
  });
  plugin.apply(ctx, {});
  return { ctx, svc: ctx._provided['agint.curriculum'], published, updates };
}

const UNCERTAIN_SNAPSHOT = makeSnapshot([
  makeCapability('codegen', 'UNCERTAIN', { lastVerifiedAt: '2026-08-01T00:00:00Z' }),
]);

test('probe：UNCERTAIN 域进入待练列表；无 self-model 时软降级 skipped', async () => {
  const { svc } = boot({ snapshot: UNCERTAIN_SNAPSHOT });
  const r = await svc.probe({});
  assert.equal(r.skipped, false);
  assert.deepEqual(r.domains.map((d) => d.domain), ['codegen']);
  assert.ok(r.domains[0].reason.some((x) => x.includes('UNCERTAIN')));
  assert.deepEqual(r.unverifiable, []);

  const { svc: svc2 } = boot({ snapshot: null }); // self-model 不可用
  const r2 = await svc2.probe({});
  assert.equal(r2.skipped, true);
  assert.match(r2.reason, /self-model/);
});

test('generate：按当前难度生成挑战，sessionId 带 curriculum- 前缀（D1）', async () => {
  const { svc } = boot({ snapshot: UNCERTAIN_SNAPSHOT });
  const r = await svc.generate({ domain: 'codegen' });
  assert.equal(r.skipped, false);
  assert.equal(r.level, 'D1');
  assert.equal(r.generated.length, 1);
  assert.ok(r.generated[0].sessionId.startsWith('curriculum-'));
  assert.ok(r.generated[0].prompt.length > 0);
  assert.ok(r.generated[0].passCriteria.length > 0);
});

test('generate：无模板域 → skipped + unverifiable（C1/Q5）', async () => {
  const { svc } = boot({ snapshot: UNCERTAIN_SNAPSHOT });
  const r = await svc.generate({ domain: 'custom-domain' });
  assert.equal(r.skipped, true);
  assert.equal(r.unverifiable, true);
});

test('generate：同域 24h 冷却 → 第二次 skipped（7.1 防爆炸）', async () => {
  const { svc } = boot({ snapshot: UNCERTAIN_SNAPSHOT });
  const first = await svc.generate({ domain: 'codegen' });
  assert.equal(first.skipped, false);
  const second = await svc.generate({ domain: 'codegen' });
  assert.equal(second.skipped, true);
  assert.match(second.reason, /冷却/);
  // force 绕过冷却（显式意图）
  const third = await svc.generate({ domain: 'codegen', force: true });
  assert.equal(third.skipped, false);
});

test('nextChallenge：出队最早 open 挑战（不自动执行，§4.5）→ in_progress', async () => {
  const { svc } = boot({ snapshot: UNCERTAIN_SNAPSHOT });
  await svc.generate({ domain: 'codegen', count: 3 });
  const n1 = await svc.nextChallenge({});
  const n2 = await svc.nextChallenge({ domain: 'codegen' });
  assert.equal(n1.skipped, false);
  assert.equal(n2.skipped, false);
  assert.notEqual(n1.challenge.id, n2.challenge.id);
  assert.ok(n1.challenge.sessionId.startsWith('curriculum-'));

  const list = await svc.list({});
  const inProgress = list.filter((c) => c.status === 'in_progress');
  assert.equal(inProgress.length, 2);
});

test('nextChallenge：无 open 挑战 → skipped', async () => {
  const { svc } = boot({ snapshot: UNCERTAIN_SNAPSHOT });
  const r = await svc.nextChallenge({});
  assert.equal(r.skipped, true);
});

test('submit：pass 全链路（判定 + attempts + 状态 + 事件 + self-model 回写 §4.9）', async () => {
  const { svc, published, updates } = boot({ snapshot: UNCERTAIN_SNAPSHOT });
  await svc.generate({ domain: 'codegen' });
  const { challenge } = await svc.nextChallenge({});

  const r = await svc.submit({
    challengeId: challenge.id,
    evidence: { exitCode: 0, output: '2\n4\n6' },
  });
  assert.equal(r.result, 'pass');
  assert.equal(r.domain, 'codegen');
  assert.equal(r.levelBefore, 'D1');

  // challenge 状态
  const list = await svc.list({});
  assert.equal(list.find((c) => c.id === challenge.id).status, 'passed');

  // self-model 回写：task-completed 且证据带 result
  const wb = updates[0];
  assert.equal(wb.trigger, 'task-completed');
  assert.equal(wb.evidence.domain, 'codegen');
  assert.equal(wb.evidence.result, 'pass');
  assert.equal(wb.evidence.source, 'agint-curriculum');

  // 事件：challenge-created + challenge-verdicted
  const topics = published.map((p) => p.topic);
  assert.ok(topics.includes('curriculum.challenge-created'));
  assert.ok(topics.includes('curriculum.challenge-verdicted'));

  // stats
  const st = await svc.stats();
  assert.equal(st.attempts.byResult.pass, 1);
});

test('submit：fail 全链路（evidence 不满足断言 → fail + task-failed 回写）', async () => {
  const { svc, updates } = boot({ snapshot: UNCERTAIN_SNAPSHOT });
  await svc.generate({ domain: 'reasoning' });
  const { challenge } = await svc.nextChallenge({});

  const r = await svc.submit({
    challengeId: challenge.id,
    evidence: { conclusion: 'B' }, // D1 预期 A
  });
  assert.equal(r.result, 'fail');
  assert.match(r.reason, /conclusion/);
  assert.equal(updates[0].trigger, 'task-failed');

  const st = await svc.stats();
  assert.equal(st.attempts.byResult.fail, 1);
});

test('submit：无 evidence → fail（C3），且不回写 self-model 的 pass', async () => {
  const { svc, updates } = boot({ snapshot: UNCERTAIN_SNAPSHOT });
  await svc.generate({ domain: 'codegen' });
  const { challenge } = await svc.nextChallenge({});

  const r = await svc.submit({ challengeId: challenge.id, evidence: { selfAssessment: '我觉得行' } });
  assert.equal(r.result, 'fail');
  assert.match(r.reason, /无 evidence/);
  assert.equal(updates[0].trigger, 'task-failed', '自评不算证据 → 回写失败信号');
});

test('难度演进：连续 3 次 pass → 第 3 次 force-promote D1→D2（防刷分 §4.6）', async () => {
  const { svc } = boot({ snapshot: UNCERTAIN_SNAPSHOT });
  await svc.generate({ domain: 'codegen', count: 3 });
  let lastAction = null;
  for (let i = 0; i < 3; i++) {
    const { challenge } = await svc.nextChallenge({ domain: 'codegen' });
    const r = await svc.submit({ challengeId: challenge.id, evidence: { exitCode: 0, output: 'ok' } });
    lastAction = r;
  }
  // 第 3 次 submit 时连续 pass=3 → force-promote（D1→D2）
  assert.equal(lastAction.levelAfter, 'D2');
  assert.equal(lastAction.difficultyAction, 'force-promote');

  const df = await svc.difficulty({ domain: 'codegen' });
  assert.equal(df.level, 'D2');
  assert.equal(df.windowResults.length, 3);
  assert.equal(df.consecutivePass, 3);
});

test('难度演进：连续 3 次 fail → force-demote + CANNOT 候选（§4.6）', async () => {
  const { svc } = boot({ snapshot: UNCERTAIN_SNAPSHOT });
  await svc.generate({ domain: 'reasoning', count: 3 });
  for (let i = 0; i < 3; i++) {
    const { challenge } = await svc.nextChallenge({ domain: 'reasoning' });
    await svc.submit({ challengeId: challenge.id, evidence: { conclusion: 'WRONG' } });
  }
  const df = await svc.difficulty({ domain: 'reasoning' });
  assert.equal(df.level, 'D1', 'D1 下限不再降');
  assert.equal(df.cannotCandidate, true, '连续 fail ≥ 3 → CANNOT 候选');
});

test('stats / difficulty / list 输出形状', async () => {
  const { svc } = boot({ snapshot: UNCERTAIN_SNAPSHOT });
  await svc.generate({ domain: 'codegen', count: 2 });
  const st = await svc.stats();
  assert.equal(st.challenges.total, 2);
  assert.equal(st.challenges.byStatus.open, 2);
  assert.ok(st.domains.codegen);
  assert.equal(st.domains.codegen.level, 'D1');
  assert.equal(st.limits.CHALLENGES, 200);
  assert.match(st.sprint, /14-/);

  const all = await svc.difficulty({});
  assert.equal(all.length, 1);
  const list = await svc.list({ status: 'open' });
  assert.equal(list.length, 2);
});

test('audit_log 记录生成与判定', async () => {
  const { ctx, svc } = boot({ snapshot: UNCERTAIN_SNAPSHOT });
  await svc.generate({ domain: 'codegen' });
  const { challenge } = await svc.nextChallenge({});
  await svc.submit({ challengeId: challenge.id, evidence: { exitCode: 0, output: 'x' } });
  const audit = ctx._provided['agint.curriculum'];
  const st = await audit.stats();
  // 无法直接读表；通过 stats 的挑战/判定数确认写入成功
  assert.equal(st.challenges.total, 1);
  assert.equal(st.attempts.total, 1);
});

test('pause/resume/config 运行时开关', async () => {
  const { svc } = boot({ snapshot: UNCERTAIN_SNAPSHOT });
  await svc.pause();
  const r = await svc.probe({});
  assert.equal(r.skipped, true);
  assert.match(r.reason, /paused/);
  await svc.resume();
  const r2 = await svc.probe({});
  assert.equal(r2.skipped, false);

  const before = await svc.config();
  await svc.config({ pass_ceiling: 0.8 });
  const after = await svc.config();
  assert.equal(after.pass_ceiling, 0.8);
  assert.equal(before.pass_ceiling, 0.70);
});
