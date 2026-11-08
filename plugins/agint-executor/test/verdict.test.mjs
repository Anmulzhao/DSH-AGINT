// agint-executor/lib/verdict.js —— 终局判决判据（2026-11-08）。
//
// 这一组钉的是「判决不靠 LLM、不靠猜」：
//   ① 枚举与 evolve 侧逐字一致（改一处必须改另一处）
//   ② 每条判决都有原文样本，其中两条取自 2026-11-08 生产存储的真实悬案
//   ③ 每条判决都配一条 negative control，证明「不该判的时候不判」
//
// 运行：node --test plugins/agint-executor/test/verdict.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VERDICTS,
  TERMINAL_VERDICTS,
  isTerminalVerdict,
  isNotActionable,
  isInterrupted,
  decideVerdict,
  verdictFromError,
} from '../lib/verdict.js';
import { isEnvironmentFailure } from '../lib/env.js';
import { EXEC_VERDICTS } from '../../agint-evolve/lib/execution.js';

/** 生产存储 2026-11-08 的错误原文，逐字抄录做固定样本，不依赖本机路径。 */
const PROD = {
  // 提案 04d6199c：事务门撞同 scope PENDING。
  pending: "transaction gate: plugins/agint-metrics/lib/metrics.js: propose threw: propose: atomicScope='prompt' 已有 PENDING proposal（id=09f7342c）；同 scope 只允许 1 条 PENDING",
  // 提案 531e2631：宿主重启打断，孤儿执行回收。
  orphan: '宿主重启/进程中断导致本次执行未结算（宿主重启前就已 running（startedAt=2026-11-08T07:14:56.616Z < 本进程挂载时刻），上一进程已死）',
  // 提案 cdf41d63 11-07 两次失败的原文。
  llm: 'driver 抛错：evolution-driver aborted: llm unavailable: stopReason=error',
  deterministic: 'not-actionable（这条提案没有可改的目标，重试也不会变）：8e976fd3: no target asset resolved (mentioned:0 inRepo:0 bodyLen:819)',
};

test('① 枚举与 agint-evolve 的 EXEC_VERDICTS 逐字一致', () => {
  assert.deepEqual([...VERDICTS], [...EXEC_VERDICTS], '两处枚举分叉 = 判决写不进提案行');
  assert.equal(VERDICTS.length, 6);
  assert.deepEqual([...TERMINAL_VERDICTS], ['not-actionable', 'exhausted', 'env-blocked', 'interrupted']);
});

test('② isTerminalVerdict：只有 4 个终局判决落 wontfix', () => {
  for (const v of TERMINAL_VERDICTS) assert.equal(isTerminalVerdict(v), true, `${v} 应判终局`);
  for (const v of ['applied', 'partial', '', null, undefined, 'unknown']) {
    assert.equal(isTerminalVerdict(v), false, `${String(v)} 不该判终局`);
  }
});

test('③ decideVerdict：确定性 / 不可执行 ⇒ not-actionable', () => {
  assert.equal(decideVerdict({ deterministic: true, reason: 'whatever' }), 'not-actionable');
  assert.equal(decideVerdict({ reason: PROD.deterministic }), 'not-actionable');
  assert.equal(decideVerdict({ reason: PROD.pending }), 'not-actionable');
  assert.equal(decideVerdict({ reason: 'oldText not found' }), 'not-actionable');
});

test('④ decideVerdict：中断 ⇒ interrupted，且优先于额度耗尽', () => {
  assert.equal(decideVerdict({ reason: PROD.orphan, attempts: 2, maxAttempts: 2 }), 'interrupted');
  assert.equal(verdictFromError(PROD.orphan), 'interrupted');
});

test('⑤ decideVerdict：环境故障未到上限不判，到上限才 env-blocked', () => {
  assert.equal(decideVerdict({ reason: PROD.llm, attempts: 1, maxAttempts: 2, envDeferrals: 0, maxEnvDeferrals: 6 }), null);
  assert.equal(decideVerdict({ reason: PROD.llm, envDeferrals: 5, maxEnvDeferrals: 6 }), null, '5 < 6 仍要等');
  assert.equal(decideVerdict({ reason: PROD.llm, envDeferrals: 6, maxEnvDeferrals: 6 }), 'env-blocked');
});

test('⑥ decideVerdict：普通失败有额度不判，额度用尽才 exhausted', () => {
  assert.equal(decideVerdict({ reason: 'policy REJECT：改动超出批准范围', attempts: 1, maxAttempts: 2 }), null);
  assert.equal(decideVerdict({ reason: 'policy REJECT：改动超出批准范围', attempts: 2, maxAttempts: 2 }), 'exhausted');
  assert.equal(decideVerdict({ ok: true, attempts: 2, maxAttempts: 2 }), null, '成功由 finishExecution 结案，这里不判');
});

test('⑦ negative control：环境判据与确定性判据互不串味', () => {
  // env.js 明确不收「LLM 产出不合格」这一类；verdict.js 必须把它归成 not-actionable。
  assert.equal(isEnvironmentFailure('oldText not found'), false);
  assert.equal(isNotActionable('oldText not found'), true);
  assert.equal(isInterrupted(PROD.llm), false, '环境故障不能被误判成中断');
  assert.equal(isNotActionable(PROD.llm), false, '环境故障不能被误判成不可执行');
  assert.equal(isEnvironmentFailure(PROD.llm), true);
});

test('⑧ verdictFromError：生产样本 + 兜底 + 空证据', () => {
  assert.equal(verdictFromError(PROD.pending), 'not-actionable');
  assert.equal(verdictFromError(PROD.orphan), 'interrupted');
  assert.equal(verdictFromError(PROD.llm), 'env-blocked');
  assert.equal(verdictFromError(PROD.deterministic), 'not-actionable');
  assert.equal(verdictFromError('某种没见过的失败'), 'exhausted', '认不出归因时按「失败且无额度」这个事实结案');
  assert.equal(verdictFromError(''), null, '没证据就不判（K117）');
  assert.equal(verdictFromError(null), null);
});

test('⑨ 纯函数：冻结入参连喂两次，结果逐字相同、入参不变', () => {
  const input = Object.freeze({ reason: PROD.llm, attempts: 2, maxAttempts: 2, envDeferrals: 6, maxEnvDeferrals: 6 });
  const a = decideVerdict(input);
  const b = decideVerdict(input);
  assert.equal(a, b);
  assert.equal(a, 'env-blocked');
  assert.deepEqual(Object.keys(input).sort(), ['attempts', 'envDeferrals', 'maxAttempts', 'maxEnvDeferrals', 'reason']);
});
