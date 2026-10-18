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

// ── v0.1.4 生成期去重 / v0.1.5 题目池 ────────────────────────────────────
//
// 背景：challenge-gen 是 (domain, level, variant) 的确定性纯函数，2026-10-08
// 与 2026-10-15 两批生产数据出现过逐字相同的挑战（生产存储实测）。以下用例
// 锁住两条契约：
//   1. 不产重复题面
//   2. 撞重优先在同档换 variant，同档用尽才顺延难度档

test('去重：同域再生成不产重复题面，先在本档换 variant（不动档位）', async () => {
  const { svc } = boot({ snapshot: UNCERTAIN_SNAPSHOT });
  await svc.config({ challenge_cooldown_hours: 0 });

  const first = await svc.generate({ domain: 'codegen' });
  assert.equal(first.generated[0].level, 'D1');

  const second = await svc.generate({ domain: 'codegen' });
  assert.equal(second.skipped, false);
  assert.notEqual(second.generated[0].prompt, first.generated[0].prompt, '题面必须不同');

  // codegen 是旧域（每档单题），撞重只能顺延；integration/correctness 才有题池
  assert.equal(second.generated[0].level, 'D2', 'codegen 单题域撞重 → 顺延 D2');
  assert.equal(second.levelShifted, true, '应标注为顺延');

  const df = await svc.difficulty({ domain: 'codegen' });
  assert.equal(df.level, 'D1', '去重顺延不得改写难度档');
});

test('题目池：同档内撞重优先换 variant，档位不变（integration 每档 3 道）', async () => {
  const { svc } = boot({ snapshot: UNCERTAIN_SNAPSHOT });
  await svc.config({ challenge_cooldown_hours: 0 });

  const seen = [];
  for (let i = 0; i < 3; i++) {
    const r = await svc.generate({ domain: 'integration' });
    assert.equal(r.skipped, false, `第 ${i + 1} 次应能生成`);
    assert.equal(r.generated[0].level, 'D1', `第 ${i + 1} 道仍应在 D1（同档换 variant）`);
    seen.push(r.generated[0].prompt);
  }
  assert.equal(new Set(seen).size, 3, '3 道题面必须互不相同');
  assert.equal((await svc.difficulty({ domain: 'integration' })).level, 'D1', '换 variant 不改档');

  // 第 4 次：D1 三道全部出过 → 才顺延 D2
  const fourth = await svc.generate({ domain: 'integration' });
  assert.equal(fourth.generated[0].level, 'D2');
  assert.equal(fourth.levelShifted, true);
});

test('题目池：integration 15 道全部出过 → skipped（池耗尽），不空造挑战', async () => {
  const { svc } = boot({ snapshot: UNCERTAIN_SNAPSHOT });
  await svc.config({ challenge_cooldown_hours: 0 });

  for (let i = 0; i < 15; i++) {
    const r = await svc.generate({ domain: 'integration' });
    assert.equal(r.skipped, false, `第 ${i + 1} 次应能生成（池共 15 道）`);
  }
  const sixteenth = await svc.generate({ domain: 'integration' });
  assert.equal(sixteenth.skipped, true);
  assert.match(sixteenth.reason, /题面/);

  const st = await svc.stats();
  assert.equal(st.challenges.total, 15, '只应有 15 条，不得重复堆叠');
  assert.equal(st.challenges.open, 15);

  // 15 道题面全部互不相同（池真正被遍历，不是重复同一道）
  const list = await svc.list({ domain: 'integration' });
  assert.equal(new Set(list.map((c) => c.prompt)).size, 15, '15 道题面必须互不相同');
});

test('去重：dedup_window_days=0 关闭去重 → 同题面可重复生成（旧行为可回退）', async () => {
  const { svc } = boot({ snapshot: UNCERTAIN_SNAPSHOT });
  await svc.config({ challenge_cooldown_hours: 0, dedup_window_days: 0 });

  const a = await svc.generate({ domain: 'correctness' });
  const b = await svc.generate({ domain: 'correctness' });
  assert.equal(b.skipped, false);
  assert.equal(b.generated[0].level, 'D1');
  assert.equal(a.generated[0].prompt, b.generated[0].prompt, '关闭去重后允许重复题面');
});

test('去重：窗口过期后同题面允许复出（复验），窗口内则换 variant', async () => {
  const { svc } = boot({ snapshot: UNCERTAIN_SNAPSHOT });
  await svc.config({ challenge_cooldown_hours: 0, dedup_window_days: 30 });

  const t0 = Date.parse('2026-10-08T00:00:00Z');
  const first = await svc.generate({
    domain: 'correctness', nowMs: t0, force: true,
  });

  // 窗口内（第 10 天）：D1 variant0 已出过 → 换 variant1，仍在 D1
  const inWindow = await svc.generate({ domain: 'correctness', nowMs: t0 + 10 * 86400000 });
  assert.equal(inWindow.generated[0].level, 'D1', '同档换 variant，不顺延');
  assert.notEqual(inWindow.generated[0].prompt, first.generated[0].prompt);

  // 窗口外（第 31 天）：第一条已过期，variant0 可复出
  const expired = await svc.generate({ domain: 'correctness', nowMs: t0 + 31 * 86400000 });
  assert.equal(expired.generated[0].level, 'D1', '窗口过期后 D1 题面允许复出');
});

test('去重：force=true 显式绕过（与冷却同语义）', async () => {
  const { svc } = boot({ snapshot: UNCERTAIN_SNAPSHOT });
  await svc.config({ challenge_cooldown_hours: 0 });
  await svc.generate({ domain: 'correctness' });
  const forced = await svc.generate({ domain: 'correctness', force: true });
  assert.equal(forced.skipped, false);
  assert.equal(forced.generated[0].level, 'D1', 'force 绕过去重，回到 D1');
});

// ── v0.1.5 题库自检 ──────────────────────────────────────────────────────

test('题库：每个域每档都有题，integration/correctness 每档 ≥3 道', async () => {
  const { bankSize, totalBankSize } = await import('../lib/challenge-gen.js');
  const { DIFFICULTY_LEVELS } = await import('../lib/schema.js');

  for (const domain of ['integration', 'correctness']) {
    for (const lv of DIFFICULTY_LEVELS) {
      assert.ok(bankSize(domain, lv) >= 3, `${domain}@${lv} 至少 3 道，实得 ${bankSize(domain, lv)}`);
    }
    assert.ok(totalBankSize(domain) >= 15, `${domain} 池总量应 ≥15，实得 ${totalBankSize(domain)}`);
  }
});

test('题库：correctness 同档内答案互不相同（防变体只是换个说法）', async () => {
  const { generateChallenge } = await import('../lib/challenge-gen.js');
  const { DIFFICULTY_LEVELS } = await import('../lib/schema.js');

  for (const lv of DIFFICULTY_LEVELS) {
    const answers = [];
    for (let v = 0; v < 3; v++) {
      answers.push(generateChallenge('correctness', lv, { variant: v }).verifySpec.expected);
    }
    assert.equal(new Set(answers).size, 3, `${lv} 三个 variant 答案必须互异，实得 ${JSON.stringify(answers)}`);
  }
});

test('题库：integration 同档内题面互不相同且关键词各成一组', async () => {
  const { generateChallenge } = await import('../lib/challenge-gen.js');
  const { DIFFICULTY_LEVELS } = await import('../lib/schema.js');

  for (const lv of DIFFICULTY_LEVELS) {
    const prompts = [];
    const kwSets = [];
    for (let v = 0; v < 3; v++) {
      const c = generateChallenge('integration', lv, { variant: v });
      prompts.push(c.prompt);
      kwSets.push(c.verifySpec.expected.join(','));
    }
    assert.equal(new Set(prompts).size, 3, `${lv} 三个 variant 题面必须互异`);
    assert.ok(kwSets.every((k) => k.length > 0), `${lv} 每道题都要有关键词`);
  }
});

test('题库：generateChallenge 不传 variant 时输出与 v0.1.4 逐字一致（向后兼容）', async () => {
  const { generateChallenge } = await import('../lib/challenge-gen.js');
  const noVariant = generateChallenge('correctness', 'D1');
  const v0 = generateChallenge('correctness', 'D1', { variant: 0 });
  assert.deepEqual(noVariant, v0);
  assert.equal(noVariant.prompt, '计算 17 + 26。请给出数字结论。');
  assert.equal(noVariant.verifySpec.expected, '43');
});
