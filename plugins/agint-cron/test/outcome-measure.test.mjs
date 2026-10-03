// plugins/agint-cron/test/outcome-measure.test.mjs —— 实测 job 的薄壳行为（Phase 1.1 支点 1b）
//
// 判据本身在 driver 的 outcome-measurer（部署包无 bin/ ⇒ 逻辑必须活在插件 lib，经验教训 §3.13）。
// 本文件只管四件事：① 服务没挂 ⇒ soft-skip；② 正常 ⇒ 摘要字段进 report；
// ③ 复原护栏未核过 ⇒ 抛错；④ 归档校验发现篡改/删锁行 ⇒ 抛错（两类都是安全事件，⛔ 不许静默）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultJobs } from '../lib/jobs.js';

const job = defaultJobs.find((j) => j.id === 'outcome-measure');

const OK_OUT = {
  ok: true, scanned: 9, measurable: 2, attempted: 2, deferred: 0,
  counts: { MEASURED: 2 }, results: [{ status: 'MEASURED', contractId: 'EVO-A' }],
  repoRoot: 'D:/repo', limit: 5,
  audit: { ok: true, status: 'AUDITED', checked: 2, counts: { VERIFIED: 2 }, tampered: [], orphanPredictions: [], unverifiable: 0 },
};

test('job 存在且排在 Tue 10:15（evolution-cycle 之后、避开源月 1 日 10:00/10:30 固定位）', () => {
  assert.ok(job, 'outcome-measure 必须注册在 defaultJobs');
  assert.equal(job.schedule, '15 10 * * 2');
  assert.equal(defaultJobs.filter((j) => j.id === job.id).length, 1);
});

test('服务未挂载 / 未提供 measureOutcomes ⇒ soft-skip（driver 是软依赖插件）', async () => {
  assert.deepEqual(await job.action({}), { skipped: true, reason: 'agint.evolutionDriver.measureOutcomes not mounted' });
  const noSvc = { 'agint.evolutionDriver': { runOnce: async () => ({}) } };
  assert.equal((await job.action(noSvc)).skipped, true);
});

test('正常一轮 ⇒ status ok + 计数进 report（limit/repoRoot 也留痕）', async () => {
  const calls = [];
  const services = {
    'agint.evolutionDriver': {
      measureOutcomes: async (opts) => { calls.push(opts); return OK_OUT; },
    },
  };
  const r = await job.action(services);
  assert.equal(r.status, 'ok');
  assert.equal(r.skipped, undefined);
  assert.deepEqual(calls, [{}], 'job 不越权塞参数，仓库根由 driver 自己按优先级解析');
  assert.equal(r.report.scanned, 9);
  assert.equal(r.report.measurable, 2);
  assert.equal(r.report.attempted, 2);
  assert.deepEqual(r.report.counts, { MEASURED: 2 });
  assert.equal(r.report.repoRoot, 'D:/repo');
  assert.equal(r.report.deferred, 0);
  assert.equal(r.report.auditChecked, 2, '验过的锁数要进摘要（"没查"与"查了没问题"必须分得开）');
  assert.deepEqual(r.report.auditCounts, { VERIFIED: 2 });
});

test('约定式 summary 通道带全六个数（⛔ 只写 report 会丢：自动搬运只认 scanned/counts）', async () => {
  const services = { 'agint.evolutionDriver': { measureOutcomes: async () => OK_OUT } };
  const { summary } = await job.action(services);
  assert.equal(summary.scanned, 9);
  assert.equal(summary.measurable, 2);
  assert.equal(summary.attempted, 2);
  assert.equal(summary.deferred, 0);
  assert.deepEqual(summary.counts, { MEASURED: 2 });
  assert.equal(summary.auditChecked, 2);
  assert.equal(summary.auditStatus, 'AUDITED');
  // 可序列化（含循环引用的 summary 会被 cron 换成 '[unserializable]'）
  assert.equal(typeof JSON.stringify(summary), 'string');
});

test('归档校验发现篡改 ⇒ 抛错点名 Contract，并说明"不计入任何统计"', async () => {
  const services = {
    'agint.evolutionDriver': {
      measureOutcomes: async () => ({
        ...OK_OUT,
        audit: {
          ok: true, status: 'AUDITED', checked: 3, counts: { VERIFIED: 2, CONTRACT_TAMPERED: 1 },
          tampered: [{ contractId: 'EVO-X', status: 'CONTRACT_TAMPERED' }], orphanPredictions: [],
        },
      }),
    },
  };
  await assert.rejects(() => job.action(services), /EVO-X.*CONTRACT_TAMPERED.*不计入任何统计/);
});

test('链上有预测而锁行缺失（删证据）⇒ 同样抛错', async () => {
  const services = {
    'agint.evolutionDriver': {
      measureOutcomes: async () => ({
        ...OK_OUT,
        audit: {
          ok: true, status: 'AUDITED', checked: 1, counts: {},
          tampered: [], orphanPredictions: [{ contractId: 'EVO-Y', seq: 12, predictedDelta: 1 }],
        },
      }),
    },
  };
  await assert.rejects(() => job.action(services), /锁行缺失 1 条：EVO-Y\(seq=12\)/);
});

test('audit 判"服务不可用" ⇒ 不算篡改、不抛错，但 report 里如实带出 checked=0', async () => {
  const services = {
    'agint.evolutionDriver': {
      measureOutcomes: async () => ({
        ...OK_OUT,
        audit: { ok: false, status: 'SERVICE_UNAVAILABLE', checked: 0, counts: {}, tampered: [], orphanPredictions: [], reason: 'agint.evolution 未提供 listContractLocks / ledger.list' },
      }),
    },
  };
  const r = await job.action(services);
  assert.equal(r.status, 'ok');
  assert.equal(r.report.auditChecked, 0);
});

test('⛔ 复原护栏未核过 ⇒ 抛错出声，错误串带 contractId 与路径', async () => {
  const services = {
    'agint.evolutionDriver': {
      measureOutcomes: async () => ({
        ...OK_OUT,
        counts: { MEASURED: 1, RESTORE_FAILED: 1 },
        results: [
          { status: 'MEASURED', contractId: 'EVO-A', restoreVerified: true },
          { status: 'RESTORE_FAILED', contractId: 'EVO-B', changedPath: 'plugins/x/lib/i.js', needsAttention: true },
        ],
      }),
    },
  };
  await assert.rejects(() => job.action(services), /EVO-B.*RESTORE_FAILED.*plugins\/x\/lib\/i\.js/);
});

test('测量器自身判"没仪器"（ok:false）⇒ status skipped，不是失败', async () => {
  const services = {
    'agint.evolutionDriver': {
      measureOutcomes: async () => ({ ok: false, status: 'NO_REPOROOT', results: [] }),
    },
  };
  const r = await job.action(services);
  assert.equal(r.status, 'skipped');
  assert.equal(r.report.attempted, 0);
});
