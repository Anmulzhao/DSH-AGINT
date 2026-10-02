// ledger-anchor job 编排测试（纯逻辑，不依赖 dsh 运行时、不碰 git）。
// 锚定本身的行为在 plugins/agint-evolution-memory/test/ledger-anchor.test.mjs
// 里用真 git 仓库覆盖；这里只管「cron 能不能正确把这个任务叫起来、失败会不会出声」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultJobs } from '../lib/jobs.js';

const job = defaultJobs.find((j) => j.id === 'ledger-anchor');

test('ledger-anchor 已注册，调度为周一 10:15（排在周复盘之后）', () => {
  assert.ok(job, 'defaultJobs 中存在 ledger-anchor');
  assert.equal(job.schedule, '15 10 * * 1');
  assert.match(job.description, /不 push/, '描述里必须写清不推送（§4.4.5：L1→L2 要人工确认）');
});

/**
 * ⚠️ 这里刻意 **抛错**，不像 curriculum-weekly 那样 soft-skip：
 * 锚定是安全控制，服务没挂载 = 这周的链根本没锚。跳过会留下「一切正常」的
 * 外观，而外观正是 §0.1 里反复出事的地方（fix-20260907 的 silent failure）。
 * 抛错让 cron 的健康记录里留下一次明确失败。
 */
test('agint.evolution.ledger.anchor 未挂载 → 抛错，不静默跳过', async () => {
  await assert.rejects(() => job.action({}), /ledger-anchor: agint.evolution.ledger.anchor not available/);
  await assert.rejects(() => job.action({ 'agint.evolution': {} }), /not available/);
});

test('空链（LEDGER_EMPTY）是正常状态：不抛', async () => {
  const calls = [];
  const services = {
    'agint.evolution': { ledger: { anchor: async () => { calls.push(1); return { anchored: false, code: 'LEDGER_EMPTY' }; } } },
  };
  const r = await job.action(services);
  assert.equal(r.anchored, false);
  assert.equal(calls.length, 1);
});

test('anchored:false 的其他原因（git 不可用 / 提交失败）→ 抛给 cron 记账', async () => {
  for (const code of ['ANCHOR_GIT_UNAVAILABLE', 'ANCHOR_COMMIT_FAILED', 'ANCHOR_FILE_UNCOMMITTED']) {
    const services = {
      'agint.evolution': {
        ledger: { anchor: async () => ({ anchored: false, code, detail: 'fixture 原因' }) },
      },
    };
    await assert.rejects(() => job.action(services), new RegExp(`锚定未完成（${code}）`));
  }
});

test('锚定成功 → 原样返回结果（seq / commit 进 cron 记录）', async () => {
  const ok = { anchored: true, code: 'ANCHORED', row: { seq: 7 }, commit: 'a'.repeat(40) };
  const services = { 'agint.evolution': { ledger: { anchor: async () => ok } } };
  const r = await job.action(services);
  assert.equal(r, ok);
});
