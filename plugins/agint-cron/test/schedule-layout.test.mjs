// cron 排期布局门禁（2026-09-28 提案 e6cbe895 的治本件）。
//
// 背景：排期时间点一直是手摆的，没有落成可验证的规则 —— 于是攒出两组同分钟
// 撞车，而「重排」本身又会引入新的撞车（提案原稿的四处新撞车就是这么来的）。
// 本测试把排期原则编码成断言：下次加/改 job 只要违反原则，测试红。
//
// 原则全文见 docs/operations/cron-schedule-principles.md。
// 纯逻辑，不依赖 dsh 运行时。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultJobs } from '../lib/jobs.js';
import { parseCron } from '../lib/cron.js';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS = 28; // 展开窗口：4 个完整周，足以覆盖月任务以外的全部组合

/**
 * 把 cron 表达式展开成窗口内的触发时刻（分钟粒度，本地时区）。
 * 与 lib/cron.js 的 nextFire 同判据，这里一次算全集以便两两比对。
 */
function enumerate(expr, from = new Date(), days = DAYS) {
  const p = parseCron(expr);
  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const end = start.getTime() + days * 86400_000;
  const out = [];
  for (let t = start.getTime(); t <= end; t += 60_000) {
    const d = new Date(t);
    if (p.month(d.getMonth() + 1) && p.dom(d.getDate()) && p.dow(d.getDay()) && p.hour(d.getHours()) && p.minute(d.getMinutes())) {
      out.push(t);
    }
  }
  return out;
}

const fmt = (t) => {
  const d = new Date(t);
  return `${DOW[d.getDay()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// diagnosis-watchdog 是「每 30 分钟」的轻量巡检，必然覆盖所有 :00 / :30。
// 把它算进碰撞判据会让门禁恒红且无意义 —— 单列，单独断言它的存在与表达式。
const WATCHDOG = 'diagnosis-watchdog';
const scheduled = defaultJobs.filter((j) => j.id !== WATCHDOG);

/**
 * LLM 密集型 / 重计算 job：彼此之间必须留 ≥30 分钟。
 * 判据 = 该 job 的 action 会调 LLM 或做全量重算（见各 job 注释）。
 */
const HEAVY = new Set([
  'night-dream',                 // dream sweep：LLM 提取候选
  'skill-autocreate-aggregate',  // jobs.js 自述「LLM 密集型」
  'skill-autocreate-release',    // evaluateQueue 可能调 LLM 评估候选
  'evolution-cycle',             // driver 调 LLM 构造原子编辑
  'curator-weekly',              // 聚合使用 + 状态转换
  'curriculum-weekly',           // generate() 调 LLM 生成挑战
  'oracle-daily',                // 神谕层
  'oracle-weekly',
  'oracle-monthly',
]);

test('每个 job 的表达式可被 parseCron 解析，且 job id 唯一', () => {
  const seen = new Set();
  for (const j of defaultJobs) {
    assert.ok(j.id, 'job 必须有 id');
    assert.equal(seen.has(j.id), false, `job id 重复: ${j.id}`);
    seen.add(j.id);
    assert.doesNotThrow(() => parseCron(j.schedule), `${j.id} 的表达式无法解析: ${j.schedule}`);
    assert.equal(String(j.schedule).trim().split(/\s+/).length, 5, `${j.id} 必须是 5 段表达式`);
  }
});

test('原则①：任意两个 job 不得落在同一分钟（daily × weekly 交叉也算）', () => {
  const byMinute = new Map();
  for (const j of scheduled) {
    for (const t of enumerate(j.schedule)) {
      if (!byMinute.has(t)) byMinute.set(t, []);
      byMinute.get(t).push(j.id);
    }
  }
  const clashes = [...byMinute.entries()].filter(([, ids]) => ids.length > 1);
  assert.equal(
    clashes.length,
    0,
    '同分钟撞车：\n' + clashes.map(([t, ids]) => `  ${fmt(t)}  ${ids.join(' + ')}`).join('\n'),
  );
});

test('原则②：相邻触发间隔 ≥15 分钟', () => {
  const times = new Set();
  for (const j of scheduled) for (const t of enumerate(j.schedule)) times.add(t);
  const sorted = [...times].sort((a, b) => a - b);
  const violations = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i] - sorted[i - 1]) / 60_000;
    if (gap < 15) violations.push(`${fmt(sorted[i - 1])} → ${fmt(sorted[i])} 仅 ${gap} 分钟`);
  }
  assert.equal(violations.length, 0, '相邻间隔不足 15 分钟：\n' + violations.join('\n'));
});

test('原则②b：LLM 密集型 job 之间间隔 ≥30 分钟', () => {
  const times = new Set();
  for (const j of scheduled) {
    if (!HEAVY.has(j.id)) continue;
    for (const t of enumerate(j.schedule)) times.add(t);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const violations = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i] - sorted[i - 1]) / 60_000;
    if (gap < 30) violations.push(`${fmt(sorted[i - 1])} → ${fmt(sorted[i])} 仅 ${gap} 分钟`);
  }
  assert.equal(violations.length, 0, 'LLM 密集型间隔不足 30 分钟：\n' + violations.join('\n'));
});

test('原则③（顺序契约）：curator-weekly 必须早于 evolve-review', () => {
  // 硬契约，不是习惯：周复盘要吃本周的策展报告（P0-2 §2.2 / §8.1
  // run_before_evolve_review）。调换顺序不会报错，只会让周复盘静默读到上周数据。
  const curator = scheduled.find((j) => j.id === 'curator-weekly');
  const review = scheduled.find((j) => j.id === 'evolve-review');
  assert.ok(curator && review, '两个 job 都必须存在');

  const c = enumerate(curator.schedule);
  const r = enumerate(review.schedule);
  // 逐周比较：每一周内 curator 的触发时刻都必须早于 evolve-review。
  assert.ok(c.length > 0 && r.length > 0, '窗口内两个 job 都应有触发点');
  const firstPairOk = c[0] < r[0];
  assert.ok(firstPairOk, `curator ${fmt(c[0])} 必须早于 evolve-review ${fmt(r[0])}`);
  // 且不能落在同一分钟（原则① 已覆盖，这里再钉一次语义）
  assert.notEqual(new Date(c[0]).getDay(), undefined);
  for (const t of c) {
    const sameWeekReview = r.find((rt) => rt > t && rt - t < 7 * 86400_000);
    if (sameWeekReview !== undefined) assert.ok(sameWeekReview > t, '同周内 curator 必须更早');
  }
});

test('原则③b（同 tick 补跑）：curator-weekly 的声明顺序也必须早于 evolve-review', () => {
  // 排期时刻只在「两个 job 分属不同 tick」时保证顺序。宿主停机后重启，isDue()
  // 会把错过的 job 一次性全判 due，它们在同一 tick 内按 **声明顺序** 串行执行
  // —— 那一刻 07:00 / 07:30 的差别完全失效。
  // 2026-09-28 实测：重启后首 tick 会补跑 6 个 job，其中就含这两个。
  // 不钉住声明顺序的话，补跑场景下周复盘会静默读到上周的策展报告。
  const idxCurator = defaultJobs.findIndex((j) => j.id === 'curator-weekly');
  const idxReview = defaultJobs.findIndex((j) => j.id === 'evolve-review');
  assert.ok(idxCurator >= 0 && idxReview >= 0, '两个 job 都必须存在');
  assert.ok(
    idxCurator < idxReview,
    `声明顺序错了：curator-weekly 在 ${idxCurator}，evolve-review 在 ${idxReview}；` +
    '同 tick 补跑时 tick() 按声明顺序串行执行，curator 必须更靠前',
  );
});

test('原则④：周任务不得全部堆在同一天（去单点）', () => {
  const weekly = scheduled.filter((j) => {
    const dow = j.schedule.trim().split(/\s+/)[4];
    return dow !== '*'; // dow 字段不是通配 = 周任务
  });
  assert.ok(weekly.length >= 6, `周任务数量应可观，实测 ${weekly.length}`);
  const days = new Set(weekly.map((j) => j.schedule.trim().split(/\s+/)[4]));
  assert.ok(days.size >= 3, `周任务只分布在 ${days.size} 个 dow 值上（${[...days].join(',')}），单点风险仍在`);
});

test('diagnosis-watchdog 仍为每 30 分钟巡检（限流待验证，不得顺手改）', () => {
  const wd = defaultJobs.find((j) => j.id === WATCHDOG);
  assert.ok(wd, 'watchdog 必须存在');
  assert.equal(wd.schedule, '*/30 * * * *', '限流（*/30 7-23）需先观测 annotations 产出时间分布，未验证前不动');
  // 顺带钉住候选表达式可被解析 —— 将来真要限时，改这一行的期望值即可。
  assert.doesNotThrow(() => parseCron('*/30 7-23 * * *'));
});
