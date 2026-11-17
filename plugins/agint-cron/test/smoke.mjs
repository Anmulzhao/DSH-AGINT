// agint-cron smoke: 一行可跑的最小验证（node test/smoke.mjs → 退出码 0）。
// 只测纯逻辑（cron 解析/调度 + 默认 job 编译 + 失效两维度判定），不依赖 dsh 运行时。
import assert from 'node:assert/strict';
import { parseCron, nextFire, lastFire } from '../lib/cron.js';
import { classifyInactivity, INACTIVE_PERIOD_FACTOR } from '../lib/staleness.js';
import { compileJobs } from '../lib/jobs.js';

// cron 解析 + nextFire：Sun 03:00 (0 3 * * 0)，从一个已知基线往后推
const parsed = parseCron('0 3 * * 0');
assert.ok(parsed, 'parseCron 返回调度对象');
const next = nextFire(parsed, new Date('2026-08-20T00:00:00'));
assert.ok(next instanceof Date, 'nextFire 返回 Date');

// lastFire：给定时刻之前最近的一次匹配
const last = lastFire(parsed, new Date('2026-08-23T04:00:00'));
assert.ok(last instanceof Date, 'lastFire 返回 Date');

// 默认 job 编译为非空列表，且每个都有 id + 已解析的 schedule
const jobs = compileJobs();
assert.ok(Array.isArray(jobs) && jobs.length > 0, 'compileJobs 返回默认 job');
for (const j of jobs) {
  assert.ok(j.id && j.parsed, `job 含 id + parsed schedule: ${j.id}`);
}

// ── 失效两维度（提案 cdf41d63）────────────────────────────────────────────
// 判据分两路：跑过的 job 与从未跑过的 job，各自的阈值来源不同。
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-08T00:00:00Z');

// ① 每日 job（周期 1 天），上次跑完 1.2 天前 ⇒ 既不「久未活动」（1.2 < 2×1）
//    也不「过期未跑」（1.2 < 1.5×1）—— 两个维度的阈值不一样，必须分别验
{
  const period = DAY;
  const lastRunAt = NOW - 1.2 * DAY;
  const r = classifyInactivity({
    now: NOW,
    lastRunAt,
    bootTime: NOW - 10 * DAY,
    expectedNextRunAt: lastRunAt + period,
  });
  assert.equal(r.staleInactive, false, 'idle 1.2 天（周期 1 天）不该判久未活动');
  assert.equal(r.periodMs, period, '周期 = 相邻两次触发的间隔');
}

// ② 每周 job（周期 7 天），上次跑完 20 天前 ⇒ 久未活动（20 > 14）
{
  const period = 7 * DAY;
  const lastRunAt = NOW - 20 * DAY;
  const r = classifyInactivity({
    now: NOW,
    lastRunAt,
    bootTime: NOW - 30 * DAY,
    expectedNextRunAt: lastRunAt + period,
  });
  assert.equal(r.staleInactive, true, 'idle 20 天（周期 7 天）必须判久未活动');
  assert.equal(r.inactiveMs, 20 * DAY);
}

// ③ 从未运行的 job：从**宿主启动时刻**起算，用真实周期（不是固定 7 天兜底）
{
  const period = DAY; // 每日 job
  const bootTime = NOW - 3 * DAY;
  const r = classifyInactivity({
    now: NOW,
    lastRunAt: null,
    bootTime,
    expectedNextRunAt: bootTime + period,
  });
  assert.equal(r.staleInactive, true, '每日 job 从未运行、宿主已起 3 天 ⇒ 久未活动');
  assert.equal(r.periodMs, period, '从未运行的 job 也用真实周期');
}

// ④ 阈值本身：倍数改了判据就变了，别让常量漂移
assert.equal(INACTIVE_PERIOD_FACTOR, 2, '久未活动倍数 = 2 个调度周期');

console.log(`agint-cron smoke: ok (${jobs.length} 个默认 job，失效两维度已覆盖)`);
