// curriculum-weekly job 编排逻辑测试（纯逻辑，不依赖 dsh 运行时）。
// 覆盖：注册与调度、服务未挂载 soft-skip、probe skipped 透传、逐域生成汇总。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultJobs } from '../lib/jobs.js';

const job = defaultJobs.find((j) => j.id === 'curriculum-weekly');

test('curriculum-weekly 已注册，调度为周日 05:00', () => {
  assert.ok(job, 'defaultJobs 中存在 curriculum-weekly');
  assert.equal(job.schedule, '0 5 * * 0');
  assert.match(job.description, /不自动执行/);
});

test('agint.curriculum 未挂载 → soft-skip 不抛', async () => {
  const r = await job.action({});
  assert.equal(r.skipped, true);
  assert.match(r.reason, /not mounted/);
});

test('probe skipped（如 paused）→ 透传原因', async () => {
  const services = {
    'agint.curriculum': {
      probe: async () => ({ skipped: true, reason: 'paused（curriculum_pause）' }),
    },
  };
  const r = await job.action(services);
  assert.equal(r.skipped, true);
  assert.match(r.reason, /paused/);
});

test('正常链路：逐域 generate 并汇总（含无模板域诚实留白）', async () => {
  const services = {
    'agint.curriculum': {
      probe: async () => ({
        skipped: false,
        domains: [{ domain: 'codegen' }, { domain: 'tool-use' }],
        unverifiable: [{ domain: 'some-unverifiable' }],
      }),
      generate: async ({ domain }) =>
        domain === 'codegen'
          ? { skipped: false, level: 'D1', generated: [{ id: 'clg_x' }] }
          : { skipped: true, reason: 'domain "tool-use" 无模板', unverifiable: true },
    },
  };
  const r = await job.action(services);
  assert.deepEqual(r.probedDomains, ['codegen', 'tool-use']);
  assert.deepEqual(r.unverifiable, ['some-unverifiable']);
  assert.equal(r.generated, 1, '只有 codegen 产出挑战');
  assert.equal(r.results[0].count, 1);
  assert.equal(r.results[0].level, 'D1');
  assert.equal(r.results[1].skipped, true);
  assert.match(r.results[1].reason, /无模板/);
});
