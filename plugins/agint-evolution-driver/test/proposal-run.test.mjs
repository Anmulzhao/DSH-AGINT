// agint-evolution-driver：提案级执行编排（2026-11-07）
//
// 这一组钉的是**编排语义**，不是「能不能改代码」：
//   ① 一条提案横跨 3 个文件 ⇒ 一次执行全部改完，最后 scope.complete=true
//   ② 中途失败 ⇒ 立即停手，不继续扩大影响面；已落地的如实报告
//   ③ 第一个目标就失败 ⇒ 原样交回，调用方按老口径判失败（不伪造 success）
//   ④ maxUnits 是成本闸：到顶就停，剩余如实留在 scope 里
//   ⑤ 已落地的文件必须透传给下一轮（skipTargets），否则会反复改同一个文件
//
// 运行：node --test test/proposal-run.test.mjs

import assert from 'node:assert/strict';
import { runProposalLoop } from '../lib/proposal-run.js';

/** 造一个脚本化的 runOnce：按顺序返回预设结果，并记录调用参数。 */
function scriptedRunOnce(steps, calls) {
  let i = 0;
  return async (arg) => {
    calls.push({ proposalId: arg.proposalId, skipTargets: [...arg.skipTargets], unitIndex: arg.unitIndex });
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    return typeof step === 'function' ? step(arg) : step;
  };
}

const okOut = (path, { complete = false, remaining = [], unitsTotal = 3 } = {}) => ({
  skipped: false,
  proposalId: 'p1',
  commit: { ok: true, path, policyDecision: 'AUTO_DEPLOY' },
  scope: { unitsApplied: 1, unitsTotal, remainingUnits: remaining, requiresNewAsset: false, complete },
});

// ── ① 3 个目标，一次执行全改完 ────────────────────────────────────────
{
  const calls = [];
  const runOnce = scriptedRunOnce([
    okOut('a.js', { remaining: ['b.js', 'c.js'] }),
    okOut('b.js', { remaining: ['c.js'] }),
    okOut('c.js', { complete: true }),
  ], calls);
  const out = await runProposalLoop({ proposalId: 'p1', runOnce, maxUnits: 6 });
  assert.equal(calls.length, 3, '三个目标应当三次 runOnce，不多不少');
  assert.equal(out.commit.ok, true);
  assert.equal(out.commits.length, 3);
  assert.deepEqual(out.commits.map((c) => c.path), ['a.js', 'b.js', 'c.js']);
  assert.equal(out.scope.unitsApplied, 3);
  assert.equal(out.scope.complete, true, '覆盖完必须判 complete，否则执行器会当 partial 续跑');
  assert.equal(out.ok, true);
  assert.equal(out.skipped, false);
}

// ── ② 中途失败 ⇒ 停手，已落地的不回滚也不掩盖 ─────────────────────────
{
  const calls = [];
  const runOnce = scriptedRunOnce([
    okOut('a.js', { remaining: ['b.js'] }),
    { skipped: true, failures: ['p1: oldText not found in target file'] },
  ], calls);
  const out = await runProposalLoop({ proposalId: 'p1', runOnce, maxUnits: 6 });
  assert.equal(calls.length, 2, '失败后不许再起第三次 LLM');
  assert.equal(out.commits.length, 1, '已落地的一个文件要如实报告');
  assert.equal(out.ok, true, '至少落地一个 ⇒ 交给调用方按 partial 处理，不是失败');
  assert.equal(out.scope.complete, false);
  assert.match(out.scope.reason, /1\/2|剩余/);
  assert.ok(out.failures.some((f) => /oldText not found/.test(f)), '失败原因不许丢');
}

// ── ③ 第一个目标就失败 ⇒ 原样交回（不伪造 success）────────────────────
{
  const calls = [];
  const runOnce = scriptedRunOnce([
    { skipped: true, failures: ['p1: no target asset resolved'], deterministic: true },
  ], calls);
  const out = await runProposalLoop({ proposalId: 'p1', runOnce });
  assert.equal(out.skipped, true);
  assert.equal(out.commit, undefined, '没有落地就不许造 commit 对象');
  assert.equal(out.commits.length, 0);
  assert.equal(out.unitsApplied, 0);
  assert.deepEqual(out.failures, ['p1: no target asset resolved']);
}

// ── ④ maxUnits 是成本闸 ───────────────────────────────────────────────
{
  const calls = [];
  const steps = Array.from({ length: 5 }, (_, i) => okOut(`f${i}.js`, { remaining: [`f${i + 1}.js`] }));
  const out = await runProposalLoop({ proposalId: 'p1', runOnce: scriptedRunOnce(steps, calls), maxUnits: 3 });
  assert.equal(calls.length, 3, 'maxUnits=3 ⇒ 最多 3 次');
  assert.equal(out.commits.length, 3);
  assert.equal(out.scope.complete, false, '没覆盖完不许判 complete');
  assert.ok(out.scope.remainingUnits.length > 0);
}

// ── ⑤ 已落地目标必须透传给下一轮 ──────────────────────────────────────
{
  const calls = [];
  const runOnce = scriptedRunOnce([
    okOut('a.js', { remaining: ['b.js'] }),
    okOut('b.js', { complete: true }),
  ], calls);
  await runProposalLoop({ proposalId: 'p1', runOnce });
  assert.deepEqual(calls[0].skipTargets, []);
  assert.deepEqual(calls[1].skipTargets, ['a.js'], '第二轮必须知道 a.js 已经改过');
  assert.equal(calls[1].proposalId, 'p1');
}

// ── ⑥ 提前 complete ⇒ 不再多起一次 LLM ────────────────────────────────
{
  const calls = [];
  const runOnce = scriptedRunOnce([okOut('only.js', { complete: true })], calls);
  const out = await runProposalLoop({ proposalId: 'p1', runOnce });
  assert.equal(calls.length, 1);
  assert.equal(out.scope.complete, true);
}

console.log('proposal-run.test.mjs: all cases passed');
