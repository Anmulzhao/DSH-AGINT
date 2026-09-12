// skill-graph-weekly job 编排逻辑测试（纯逻辑，不依赖 dsh 运行时）。
// 覆盖：注册与调度、服务未挂载 soft-skip、updateFull skipped 透传、
//       **persisted（已落盘）与 projected（若转 live）两个口径必须分开报**。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultJobs } from '../lib/jobs.js';

const job = defaultJobs.find((j) => j.id === 'skill-graph-weekly');

test('skill-graph-weekly 已注册，调度为周日 07:00（P2-2 §5.2）', () => {
  assert.ok(job, 'defaultJobs 中存在 skill-graph-weekly');
  assert.equal(job.schedule, '0 7 * * 0');
  assert.match(job.description, /count-only/);
});

test('agint.skillGraph 未挂载 → soft-skip 不抛', async () => {
  const r = await job.action({});
  assert.equal(r.skipped, true);
  assert.match(r.reason, /not mounted/);
});

test('updateFull skipped（如 disabled）→ 透传原因', async () => {
  const services = {
    'agint.skillGraph': {
      updateFull: async () => ({ skipped: true, reason: 'disabled' }),
      getCoverage: async () => { throw new Error('不应被调用'); },
    },
  };
  const r = await job.action(services);
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'disabled');
});

test('count-only 档：persisted 全零 而 projected 非零 —— 两个口径不得混为一谈', async () => {
  const services = {
    'agint.skillGraph': {
      updateFull: async () => ({
        mode: 'count-only',
        nodes: 3,
        edgesAdded: 0,          // 标定期不落正式表
        edgesRemoved: 0,
        durationMs: 12,
        edgesByType: { related: 2 },      // ← 投影
        calibration: { week: '2026-W37', promotable: true },
      }),
      getCoverage: async () => ({
        edgesByType: { related: 0, overlap: 0, co_use: 0, similar: 0 }, // ← 已落盘
        health: 'EMPTY',
        coverage: { nodes: 0, nodesWithEdges: 0, nodesWithUsage: 0, ratio: 0, usageRatio: 0 },
      }),
    },
  };
  const r = await job.action(services);
  assert.equal(r.mode, 'count-only');
  assert.equal(r.nodes, 3);
  assert.equal(r.persistedHealth, 'EMPTY', '正式表空 → health 必须是 EMPTY');
  assert.equal(r.persisted.related, 0, 'persisted 必须反映已落盘（0）');
  assert.equal(r.projected.related, 2, 'projected 必须反映投影（2）');
  assert.equal(r.calibration.promotable, true, '解锁凭证必须带出来');
});

test('live 档：updateFull 报错（fail-open）→ error 透传而非抛', async () => {
  const services = {
    'agint.skillGraph': {
      updateFull: async () => ({
        mode: 'live', nodes: 0, edgesAdded: 0, edgesRemoved: 0, durationMs: 3,
        edgesByType: {}, error: 'domain open failed',
      }),
      getCoverage: async () => ({ edgesByType: {}, health: 'EMPTY', coverage: { ratio: 0 } }),
    },
  };
  const r = await job.action(services);
  assert.equal(r.error, 'domain open failed');
  assert.equal(r.persistedHealth, 'EMPTY');
});
