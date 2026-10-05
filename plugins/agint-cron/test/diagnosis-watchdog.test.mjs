// 诊断域看门狗测试（2026-09-26 事故后新增）。
//
// 锁定五条行为，且能抓住回退：
//   1. 服务未挂载 → soft-skip（返回 skipped，不抛）—— 与其它 job 同策略；
//   2. 全部健康 → 返回 alert:false 且带上各表 used/cap 与熔断计数；
//   3. 表**已满** → CRITICAL 且抛错（真故障：守门失效，必须让调度层记 failed）；
//   4. 表**逼近** cap（≥80%）/ 频率熔断被咬 / 调用密集 → 打 warn + 返回 alert:true，
//      但**不抛错**（2026-10-05 老板裁定第 3 项，见下）；
//   5. 熔断计数与占用率照旧回报在返回值里。
//
// ⚠️ 为什么第 4 条从「抛错」改成「只warn」（2026-10-05）：
//   现场：reports 47/50（94%）只是「逼近」，watchdog 却把它记成 job failed，
//   连续两轮（12:30:49 / 13:00:53）⇒ 污染 cron 状态，且把真正的 CRITICAL 淹没。
//   watchdog 是**纯观测任务**，逼近上限是提示不是故障。
//   **告警可见性没有丢**：仍打 console.warn 且返回值 alert:true + warningCount，
//   断言强度按「必须能看见」重新表述，不是放宽。
//   ⚠️ 那条「静默失败比吵闹失败危险」的原教训仍然成立—— 若改成**既不 warn 也不返回 alert**
//   下面每条断言都会红。CRITICAL 仍然抛错，见第 3 条。

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

test('reports 逼近上限（80% 起）→ 打 warn + alert:true，但**不抛错**（不污染 cron 状态）', async () => {
  const { result, error, warns } = await run(makeStats({ reports: 45 }));
  assert.equal(error, null, '逼近上限是提示不是故障，不该让 job 记failed');
  assert.equal(result.alert, true, '必须仍能看见：alert 为 true');
  assert.equal(result.warningCount, 1);
  assert.equal(result.criticalCount, 0, '逼近不是 CRITICAL');
  assert.equal(warns.length, 1, '必须仍打详细指标');
  assert.match(warns[0], /reports/);
  assert.match(warns[0], /45\/50/);
  assert.ok(warns[0].includes('"reports":{"used":45,"cap":50,"pct":90}'));
});

test('reports 恰好 79%（阈下）→ 完全静默；80%（阈上）→ warn 但不抛', async () => {
  const under = await run(makeStats({ reports: 39 })); // 78%
  assert.equal(under.error, null, '78% 不应告警');
  assert.equal(under.result.alert, false, '78% 连 alert 都应为 false');
  assert.equal(under.warns.length, 0, '78% 不应产生任何噪音');
  const at = await run(makeStats({ reports: 40 })); // 80%
  assert.equal(at.error, null, '80% 不抛错');
  assert.equal(at.result.alert, true, '80% 应能看见');
  assert.equal(at.warns.length, 1);
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

test('频率熔断被咬（trips>0）→ warn + alert:true，不抛错（仍是 WARN 级）', async () => {
  const { result, error, warns } = await run(makeStats({
    reportRateGuard: { windowMs: 60_000, max: 30, trips: 3, recent: 0 },
  }));
  assert.equal(error, null, '熔断被咬是 WARN 级，不该让 job 记 failed');
  assert.equal(result.alert, true, '必须仍能看见');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /频率熔断已被咬 3 次/);
  assert.match(warns[0], /调用方栈/);
});

test('近窗口调用密集（recent > max/2）→ warn + alert:true，不抛错', async () => {
  const { result, error, warns } = await run(makeStats({
    reportRateGuard: { windowMs: 60_000, max: 30, trips: 0, recent: 20 },
  }));
  assert.equal(error, null, '调用密集是 WARN 级，不该让 job 记 failed');
  assert.equal(result.alert, true, '必须仍能看见');
  assert.match(warns[0], /近 60000ms 内 report 调用 20 次/);
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

/**
 * 分级护栏（2026-10-05 新增）：WARN 与 CRITICAL 共存时**必须抛**。
 *
 * 为什么必须补这条：把「逼近上限」从抛错降级为 warn 之后，
 * 最危险的退化是「两级被焊在一起」—— 只要有任何 WARN 就永远不抛，
 * 于是表真的满了（CRITICAL）反而没人知道。
 * 本条钉住 criticalCount>0 时恒抛，且错误文案只含 CRITICAL、不含 WARN。
 */
test('WARN 与 CRITICAL 共存 → 仍抛错，且抛的是 CRITICAL 那一档', async () => {
  const { result, error, warns } = await run(makeStats({ reports: 50, annotations: 180 }));
  assert.ok(error, '表已满是 CRITICAL，必须抛给调度层');
  assert.match(error.message, /CRITICAL/);
  assert.match(error.message, /reports/);
  // 抛错分支不返回值（runOne 抛错时拿不到 result）—— 这是真实契约，不是缺陷。
  assert.equal(result, null, 'CRITICAL 抛出后不返回 result');
  // 两者都要留下告警输出：WARN 一条 + CRITICAL 一条
  assert.equal(warns.length, 2, 'WARN 与 CRITICAL 都必须留下告警输出');
  // 抛出的文案只含 CRITICAL 那一档，不含 WARN 文案
  assert.doesNotMatch(error.message, /annotations/, '抛错文案只应是 CRITICAL 档');
});
