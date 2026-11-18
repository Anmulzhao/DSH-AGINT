// 防复读护栏测试（提案 10d2d87f）：堵住「换个说法填两遍 / 原样复读」漏洞。
//
// 覆盖：方案 4（指纹）、方案 1（题面实例去重）、方案 2/3（确定性信号，不改判定）、
//       提交路径不计能力成功（难度/self-model/事件/返回值）、存量与开关回退。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  stepsFingerprint,
  stepsOf,
  diversitySignals,
  detectReplay,
} from '../lib/replay.js';
import * as plugin from '../lib/index.js';
import { makeSnapshot, makeCapability, mockCtx } from './_helpers.mjs';

// ── 纯函数：指纹 ───────────────────────────────────────────────────────

test('stepsFingerprint：原样 / 仅排版差异 → 同指纹；实质不同 → 异指纹', () => {
  const a = ['先做校验，请求失败要处理', '然后重试两次'];
  const b = ['  先做校验，请求失败要处理。', '然后重试两次！'];  // 标点/空白差异
  const c = ['先做校验，请求失败要处理', '然后重试三次'];       // 措辞差异（非数字噪声）
  const d = ['先做校验，请求失败要处理 50', '然后重试两次']; // 纯数字噪声
  assert.equal(stepsFingerprint(a), stepsFingerprint(b), '去标点/空白后应同指纹');
  assert.equal(stepsFingerprint(a), stepsFingerprint(d), '纯数字噪声不影响指纹');
  assert.notEqual(stepsFingerprint(a), stepsFingerprint(c), '实质措辞不同 → 异指纹');
  assert.equal(stepsFingerprint(null), null);
  assert.equal(stepsFingerprint(['ok', 123]), null, '非字符串元素 → 无指纹');
});

test('stepsOf：兼容参数层数组包装 { item:[...] } 与数字下标形态', () => {
  assert.deepEqual(stepsOf({ steps: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(stepsOf({ steps: { item: ['a', 'b'] } }), ['a', 'b']);
  assert.deepEqual(stepsOf({ steps: { 0: 'a', 1: 'b' } }), ['a', 'b']);
  assert.equal(stepsOf({ steps: 'not-array' }), null);
});

// ── 纯函数：方案 2/3 信号（只报 flags，不改判定）────────────────────────

test('diversitySignals：关键词堆在同一步 → flag；分布在不同步 → 无 flag', () => {
  const spec = { expected: ['请求', '错误'] };
  const concentrated = diversitySignals(spec, ['请求错误一起处理', '兜底']);
  assert.ok(concentrated.flags.length > 0, '单步贡献两个关键词 → 疑似同义反复 flag');
  assert.equal(concentrated.maxPerStep, 2);

  const distributed = diversitySignals(spec, ['先发请求', '再处理错误']);
  assert.equal(distributed.flags.length, 0, '关键词分布在不同步 → 无 flag');
  assert.equal(distributed.maxPerStep, 1);
});

// ── 纯函数：detectReplay ───────────────────────────────────────────────

test('detectReplay：方案 4 原样复读 → isReplay/fingerprint', () => {
  const challenge = { id: 'clg_2', domain: 'integration', level: 'D1', prompt: '题B' };
  const steps = ['先发请求', '再处理错误'];
  const prior = [{
    id: 'att_1', challengeId: 'clg_1', domain: 'integration', level: 'D1',
    prompt: '题A', evidence: { steps: ['先发请求', '再处理错误'] },
  }];
  const r = detectReplay({ challenge, evidence: { steps }, priorPasses: prior, spec: { expected: ['请求', '错误'] } });
  assert.equal(r.isReplay, true);
  assert.equal(r.kind, 'fingerprint');
  assert.equal(r.matchedAttemptId, 'att_1');
});

test('detectReplay：方案 1 同题面换说法（异指纹）→ duplicate-prompt', () => {
  const challenge = { id: 'clg_2', domain: 'integration', level: 'D1', prompt: '题A（逐字相同）' };
  const steps = ['完全不同的说法：先建连接', '再按契约分流'];
  const prior = [{
    id: 'att_1', challengeId: 'clg_1', domain: 'integration', level: 'D1',
    prompt: '题A（逐字相同）', evidence: { steps: ['另一套实现：先发请求', '再处理错误'] },
  }];
  const r = detectReplay({ challenge, evidence: { steps }, priorPasses: prior, spec: { expected: ['请求', '错误'] } });
  assert.equal(r.isReplay, true);
  assert.equal(r.kind, 'duplicate-prompt', '异指纹但同题面 → 题面去重命中');
});

test('detectReplay：新题面 + 新答案 → 非复读；关开关 → 全部非复读', () => {
  const challenge = { id: 'clg_x', domain: 'integration', level: 'D2', prompt: '新题' };
  const evidence = { steps: ['先订阅', '再发布', '最后取消'] };
  const prior = [{ id: 'att_1', challengeId: 'clg_1', domain: 'integration', level: 'D1', prompt: '旧题', evidence: { steps: ['别的步骤'] } }];
  assert.equal(detectReplay({ challenge, evidence, priorPasses: prior }).isReplay, false);

  const sameSteps = detectReplay({
    challenge, evidence, priorPasses: [{ ...prior[0], prompt: '新题', evidence }],
    config: { fingerprintEnabled: false, promptDedupEnabled: false },
  });
  assert.equal(sameSteps.isReplay, false, '两个子开关关闭 → 回退旧行为');
});

// ── 提交路径集成 ───────────────────────────────────────────────────────

const SNAP = makeSnapshot([makeCapability('integration', 'UNCERTAIN', { lastVerifiedAt: '2026-08-01T00:00:00Z' })]);

function boot() {
  const published = [];
  const updates = [];
  const ctx = mockCtx({
    'agint.selfModel': {
      snapshot: async () => SNAP,
      update: async (input) => { updates.push(input); return { ok: true, updatedDomains: [] }; },
    },
    'agint.eventBus.publish': async (input) => { published.push(input); return { ok: true }; },
  });
  plugin.apply(ctx, {});
  return { svc: ctx._provided['agint.curriculum'], published, updates };
}

test('提交路径：原样复读第二次 pass → 标记 replay，难度不推进，不回写成功', async () => {
  const { svc, published, updates } = boot();
  const r1 = await svc.generate({ domain: 'codegen', force: true });
  const ch = r1.generated[0].id;
  const ev = { exitCode: 0, output: '2\n4\n6' };
  await svc.submit({ challengeId: ch, evidence: ev });

  // 同 challenge 原样再交一次（codegen 无 steps，指纹不适用；此例验证「成功路径仍 pass」）
  // 改用 step-list 域构造真实复读：integration D1
  const b = boot();
  await b.svc.config({ challenge_cooldown_hours: 0, dedup_window_days: 0 });
  const g = await b.svc.generate({ domain: 'integration', force: true });
  const cid = g.generated[0].id;
  const steps = ['先发请求', '再处理错误', '兜底重试'];
  const first = await b.svc.submit({ challengeId: cid, evidence: { steps } });
  assert.equal(first.result, 'pass');
  assert.ok(!first.replay, '首 pass 非复读');
  assert.equal(first.countedForSuccess, true);

  // 同一 challenge 第二次提交相同 steps（生产 clg_20261112 场景）
  const second = await b.svc.submit({ challengeId: cid, evidence: { steps } });
  assert.equal(second.result, 'pass', '事实仍是 pass（判定不变）');
  assert.equal(second.replay, true, '第二次原样提交 → 复读标记');
  assert.equal(second.replayKind, 'fingerprint');
  assert.equal(second.countedForSuccess, false);
  assert.equal(second.difficultyAction, 'keep', '复读不推进难度');

  // 难度状态：只有第 1 次 pass 计入窗口 / consecutivePass
  const df = await b.svc.difficulty({ domain: 'integration' });
  assert.equal(df.consecutivePass, 1, '复读未让 consecutivePass 从 1→2');
  assert.equal(df.windowResults.filter((r) => r.result === 'pass').length, 1, '窗口只有 1 条 pass');

  // self-model 只回写了 1 次 task-completed（第二次复读不回写成功）
  const successWrites = b.updates.filter((u) => u.trigger === 'task-completed');
  assert.equal(successWrites.length, 1, '复读不灌水 capability recentSuccess');
  assert.equal(b.published.filter((p) => p.topic === 'curriculum.difficulty-adjusted').length, 0, '复读不发升档事件');
});

test('提交路径：换说法填两遍（同题面不同 challenge）→ duplicate-prompt，不计成功', async () => {
  const { svc, updates } = boot();
  await svc.config({ challenge_cooldown_hours: 0, dedup_window_days: 0 });
  // dedup_window_days=0 允许同题面重复生成，构造生产 clg_20261008/1015 场景
  await svc.generate({ domain: 'integration', force: true });
  await svc.generate({ domain: 'integration', force: true });
  const list = await svc.list({ domain: 'integration' });
  assert.equal(list.length, 2);
  assert.equal(list[0].prompt, list[1].prompt, '两道题面逐字相同（构造漏洞现场）');

  const first = await svc.submit({ challengeId: list[0].id, evidence: { steps: ['实现A：先发请求', '再处理错误', '最后兜底重试'] } });
  assert.equal(first.result, 'pass');
  assert.equal(first.countedForSuccess, true);
  const second = await svc.submit({ challengeId: list[1].id, evidence: { steps: ['实现B：换说法后先发起请求', '再按状态机分流处理错误', '收尾统一留痕'] } });
  assert.equal(second.result, 'pass');
  assert.equal(second.replay, true);
  assert.equal(second.replayKind, 'duplicate-prompt', '换说法也挡住（题面去重）');
  assert.equal(second.countedForSuccess, false);

  const df = await svc.difficulty({ domain: 'integration' });
  assert.equal(df.consecutivePass, 1, '同题面第 2 次 pass 未增加连击');
  assert.equal(updates.filter((u) => u.trigger === 'task-completed').length, 1);
});

test('提交路径：replay_detection=false → 完全回退旧行为（两次都计成功）', async () => {
  const { svc } = boot();
  await svc.config({ challenge_cooldown_hours: 0, dedup_window_days: 0, replay_detection: false });
  await svc.generate({ domain: 'integration', force: true });
  const list = await svc.list({ domain: 'integration' });
  const steps = ['先发请求', '再处理错误'];
  await svc.submit({ challengeId: list[0].id, evidence: { steps } });
  const two = await svc.generate({ domain: 'integration', force: true });
  const cid = two.generated[0].id;
  const r = await svc.submit({ challengeId: cid, evidence: { steps } });
  assert.equal(r.replay, false, '总开关关 → 无复读标记');
  assert.equal(r.countedForSuccess, true);
});

test('提交路径：fail 不受影响（不计成功、无复读逻辑、照常回写失败）', async () => {
  const { svc, updates } = boot();
  await svc.generate({ domain: 'integration', force: true });
  const list = await svc.list({ domain: 'integration' });
  const r = await svc.submit({ challengeId: list[0].id, evidence: { steps: ['太短'] } });
  assert.equal(r.result, 'fail');
  assert.equal(r.replay, false);
  assert.equal(updates[0].trigger, 'task-failed');
});
