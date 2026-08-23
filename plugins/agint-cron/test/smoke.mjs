// agint-cron smoke: 一行可跑的最小验证（node test/smoke.mjs → 退出码 0）。
// 只测纯逻辑（cron 解析/调度 + 默认 job 编译），不依赖 dsh 运行时。
import assert from 'node:assert/strict';
import { parseCron, nextFire, lastFire } from '../lib/cron.js';
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

console.log(`agint-cron smoke: ok (${jobs.length} 个默认 job)`);
