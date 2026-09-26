// 诊断域看门狗测试（2026-09-26 事故后新增）。
//
// 锁定四条行为，且能抓住回退：
//   1. 服务未挂载 → soft-skip（返回 skipped，不抛）—— 与其它 job 同策略；
//   2. 全部健康 → 返回 alert:false 且带上各表 used/cap 与熔断计数；
//   3. 表逼近/达到 cap → 抛错（throw 才能被 runOne 记进 console.error + cron_state）；
//   4. 频率熔断被咬（trips>0）/ 调用密集（recent>max/2）→ 抛错。
//
// 为什么强调 throw：看门狗的告警必须**能被看见**。若改成静默返回 false，
// 就重演了 09-26 事故的教训 —— 「静默失败」比「吵闹失败」危险得多。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultJobs } from '../lib/jobs.js';

const job = defaultJobs.find((j) => j.id === 'diagnosis-watchdog');

/** 构造一份 stats() 返回值（默认为健康态：reports 12/50）。 */
function makeStats(over = {}) {
  return {
    annotations: 3,
    clusters: 1,
    reports: 12,
    limits: { ANNOTATIONS: 200, CLUSTERS: 50, REPORTS: 50 },
    reportRateGuard: { windowMs: 60_000, max: 30, trips: 0, recent: 0 },
    ...over,
  };
}

/** 跑一次 action，捕获 console.warn 噪音与抛错。 */
async function run(statsOrUndefined) {
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const services = statsOrUndefined === undefined
      ? {}
      : { 'agint.diagnosis.stats': async () => statsOrUndefined };
    const result = await job.action(services);
    return { result, warns, error: null };
  } catch (error) {
    return { result: null, warns, error };
  } finally {
    console.warn = realWarn;
  }
}

test('job 已注册且调度为每 30 分钟', () => {
  assert.ok(job, 'diagnosis-watchdog 未在 defaultJobs 中注册');
  assert.equal(job.schedule, '*/30 * * * *');
  assert.equal(typeof job.action, 'function');
});

test('服务未挂载 → soft-skip，不抛错', async () => {
  const { result, error } = await run(undefined);
  assert.equal(error, null);
  assert.equal(result.skipped, true);
});

test('全部健康 → alert:false，并回报各表占用率与熔断计数', async () => {
  const { result, error, warns } = await run(makeStats());
  assert.equal(error, null);
  assert.equal(result.alert, false);
  assert.deepEqual(result.usage.reports, { used: 12, cap: 50, pct: 24 });
  assert.deepEqual(result.usage.annotations, { used: 3, cap: 200, pct: 2 });
  assert.equal(result.reportRateGuard.trips, 0);
  assert.equal(warns.length, 0, '健康态不应产生任何告警输出');
});

test('reports 逼近上限（80% 起）→ 抛错', async () => {
  const { error, warns } = await run(makeStats({ reports: 45 }));
  assert.ok(error, 'reports 45/50 应触发告警');
  assert.match(error.message, /reports/);
  assert.match(error.message, /45\/50/);
  assert.equal(warns.length, 1, '抛错前应先打详细指标');
  assert.ok(warns[0].includes('"reports":{"used":45,"cap":50,"pct":90}'));
});

test('reports 恰好 79%（阈下）→ 不报；80%（阈上）→ 报', async () => {
  const under = await run(makeStats({ reports: 39 })); // 78%
  assert.equal(under.error, null, '78% 不应告警');
  const at = await run(makeStats({ reports: 40 })); // 80%
  assert.ok(at.error, '80% 应告警');
});

test('表已满 → CRITICAL（守门失效）', async () => {
  const { error } = await run(makeStats({ reports: 50 }));
  assert.ok(error);
  assert.match(error.message, /CRITICAL/);
  assert.match(error.message, /守门失效/);
});

test('annotations 满同样被看见（不止盯 reports）', async () => {
  const { error } = await run(makeStats({ annotations: 200 }));
  assert.ok(error);
  assert.match(error.message, /annotations/);
});

test('频率熔断被咬（trips>0）→ 抛错', async () => {
  const { error } = await run(makeStats({
    reportRateGuard: { windowMs: 60_000, max: 30, trips: 3, recent: 0 },
  }));
  assert.ok(error, 'trips>0 是熔断被咬的直接证据，必须告警');
  assert.match(error.message, /频率熔断已被咬 3 次/);
  assert.match(error.message, /调用方栈/);
});

test('近窗口调用密集（recent > max/2）→ 抛错', async () => {
  const { error } = await run(makeStats({
    reportRateGuard: { windowMs: 60_000, max: 30, trips: 0, recent: 20 },
  }));
  assert.ok(error);
  assert.match(error.message, /近 60000ms 内 report 调用 20 次/);
});

test('recent 恰为 max/2（阈上不含）→ 不报', async () => {
  const { error } = await run(makeStats({
    reportRateGuard: { windowMs: 60_000, max: 30, trips: 0, recent: 15 },
  }));
  assert.equal(error, null, '15 = max/2 不构成「大于一半」');
});

test('stats 缺 limits / rateGuard 时不崩（字段容错）', async () => {
  const bare = await run({ reports: 5 });
  assert.equal(bare.error, null);
  assert.equal(bare.result.alert, false);
  assert.equal(bare.result.usage.reports, undefined, '无 cap 可比时跳过该表（不参与判定）');
});
