// tick 分层 + 心跳旁路门禁（提案 35744895，2026-11-14）。
//
// 背景：开机补跑时 all jobs due（lastRunAt=null ⇒ isDue 恒真）。tool-stats-backfill
// 曾单独 in flight 18 分钟，声明序在它之后的 17 个 job 全被挡住；STALL_MS=15min
// 的接管 tick 之前，连每 30 分钟的诊断看门狗自己都不响。
//
// 本文件锁定修复后的四条行为，每条都带 negative control（能抓住回退）：
//   1. 同 tick 内 fast 层先于 heavy 层；两层内部保持声明顺序；
//   2. 依赖链整条落在同一层（不许拆开，见 schedule-layout 原则③b）；
//   3. 主 tick 被长跑 job 占住时，心跳 job 仍能在独立通道触发，且不重复启动；
//   4. 两条通道同时写 cron_state 时不并发 put（整单元 last-write-wins 会静默丢行）。
//
// 第 5 条是 kill-switch：enabled:false 必须逐字退回旧的单链串行行为。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, tickLane } from '../lib/index.js';
import { defaultJobs } from '../lib/jobs.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAR_FUTURE = Date.now() + 30 * 86_400_000;

// 极简 cordis ctx。捕获两个 interval 回调：intervals[0] = tick，[1] = heartbeat。
// put 桩带 5ms 异步窗口，用来观察「两次 state 写有没有同时进临界区」。
function makeHarness(config) {
  const intervals = [];
  const provided = {};
  const puts = [];
  let putActive = 0;
  let putPeak = 0;
  const ctx = {
    get: () => undefined,
    provide: (n, svc) => { provided[n] = svc; },
    effect: (fn) => { fn(); },
    setInterval: (fn, ms) => {
      const handle = { fn, ms, dispose() {} };
      intervals.push(handle);
      return handle;
    },
    storageDomain: {
      open: async () => ({
        table: () => ({
          entries: () => [],
          put: async () => {
            putActive += 1;
            putPeak = Math.max(putPeak, putActive);
            await sleep(5);
            putActive -= 1;
            puts.push(1);
          },
        }),
        close: async () => {},
      }),
    },
  };
  apply(ctx, config);
  return {
    svc: provided['agint.cron'],
    intervals,
    puts,
    putPeak: () => putPeak,
  };
}

// 让整张 job 表都不 due，只放出 ids。
function isolate(jobMap, ids) {
  for (const [, job] of jobMap) job.lastRunAt = FAR_FUTURE;
  for (const id of ids) {
    const job = jobMap.get(id);
    assert.ok(job, `job 不存在: ${id}`);
    job.lastRunAt = null;
  }
}

function traceActions(jobMap, ids) {
  const trace = [];
  for (const id of ids) {
    jobMap.get(id).action = async () => { trace.push(id); return {}; };
  }
  return trace;
}

test('分层：fast 先于 heavy，两层内部保持声明顺序（负控制：关掉策略 = 原声明序）', async () => {
  // 声明序：night-dream(7) → tool-stats-backfill(8) → prompt-static-check(9)。
  // 分层后 fast 的 prompt-static-check 应提前到两个 heavy 之前。
  const ids = ['night-dream', 'tool-stats-backfill', 'prompt-static-check'];

  const on = makeHarness();
  const traceOn = traceActions(on.svc._jobs(), ids);
  isolate(on.svc._jobs(), ids);
  await on.svc._tickNow();
  assert.deepEqual(
    traceOn,
    ['prompt-static-check', 'night-dream', 'tool-stats-backfill'],
    'fast 层必须先跑完，heavy 层按声明顺序跟上',
  );

  // negative control：kill-switch 关闭 ⇒ 逐字退回旧的声明顺序。
  // 若这条也变成上面那个顺序，说明分层没生效、测试在自证。
  const off = makeHarness({ tickPolicy: { enabled: false } });
  const traceOff = traceActions(off.svc._jobs(), ids);
  isolate(off.svc._jobs(), ids);
  await off.svc._tickNow();
  assert.deepEqual(
    traceOff,
    ['night-dream', 'tool-stats-backfill', 'prompt-static-check'],
    'enabled:false 必须退回旧的单链串行声明顺序',
  );
});

test('门禁：HEAVY_LANE 的 id 都存在，依赖链整条同层，心跳 job 不在 heavy 层', () => {
  const known = new Set(defaultJobs.map((j) => j.id));
  for (const id of tickLane.HEAVY_LANE) {
    assert.ok(known.has(id), `HEAVY_LANE 里的 ${id} 不在 defaultJobs —— 拼错或 job 已删`);
  }
  assert.ok(known.has(tickLane.HEARTBEAT_JOB), '心跳 job 必须存在');
  assert.equal(
    tickLane.HEAVY_LANE.has(tickLane.HEARTBEAT_JOB), false,
    '心跳 job 走独立通道，不能再进 heavy 层（否则主 tick 与旁路会抢同一个 job）',
  );

  const idx = (id) => defaultJobs.findIndex((j) => j.id === id);
  for (const chain of tickLane.ORDER_CHAINS) {
    const inHeavy = chain.map((id) => tickLane.HEAVY_LANE.has(id));
    assert.ok(
      inHeavy.every(Boolean) || inHeavy.every((v) => !v),
      `依赖链被拆到两层：${chain.join('→')} —— 同 tick 补跑时会静默断链`,
    );
    // 链本身在声明数组里也必须递增，否则「组内保序」保的是错的顺序。
    for (let i = 1; i < chain.length; i += 1) {
      assert.ok(idx(chain[i - 1]) < idx(chain[i]), `声明顺序错了：${chain[i - 1]} 必须早于 ${chain[i]}`);
    }
  }
});

test('心跳旁路：主 tick 被长跑 job 占住时，看门狗仍触发且只触发一次', async () => {
  const { svc, intervals } = makeHarness();
  assert.equal(intervals.length, 2, '应注册 tick 与 heartbeat 两个 interval');
  const heartbeat = intervals[1];
  assert.equal(svc._tickPolicy().enabled, true, '新能力出厂即开（kill-switch ≠ 默认关）');

  let releaseGate;
  const gate = new Promise((r) => { releaseGate = r; });
  let longJobStillRunning = false;
  let heartbeatCount = 0;

  const jobMap = svc._jobs();
  jobMap.get('metrics-collect').action = async () => {
    longJobStillRunning = true;
    await gate; // 模拟 20 分钟长跑；主 tick 卡在这里，tickRunning 恒为 true
    longJobStillRunning = false;
    return {};
  };
  jobMap.get('diagnosis-watchdog').action = async () => {
    heartbeatCount += 1;
    return { alert: false };
  };
  isolate(jobMap, ['metrics-collect', 'diagnosis-watchdog']);

  const tickPromise = svc._tickNow(); // 故意不 await
  await sleep(20);
  assert.equal(longJobStillRunning, true, '前置条件：主 tick 确实卡在长跑 job 上');

  // 手动触发心跳 interval（真运行时由 60s 定时器驱动）。
  heartbeat.fn();
  await sleep(20);
  assert.equal(heartbeatCount, 1, '长跑期间心跳必须已经跑过一次（不受 tickRunning 抑制）');
  assert.equal(longJobStillRunning, true, '心跳不得打断主 tick 的长跑 job');

  releaseGate();
  await tickPromise;
  assert.equal(heartbeatCount, 1, '主 tick 必须跳过心跳 job，不能跑第二遍');
});

test('kill-switch：enabled:false 时心跳回主 tick，旁路 callback 是空操作', async () => {
  const { svc, intervals } = makeHarness({ tickPolicy: { enabled: false } });
  assert.equal(svc._tickPolicy().enabled, false);

  const jobMap = svc._jobs();
  const trace = traceActions(jobMap, ['metrics-collect', 'diagnosis-watchdog']);
  isolate(jobMap, ['metrics-collect', 'diagnosis-watchdog']);

  await svc._tickNow();
  assert.deepEqual(
    trace,
    ['metrics-collect', 'diagnosis-watchdog'],
    '关掉策略后 watchdog 必须回归主 tick，按声明顺序串行执行',
  );

  const before = trace.length;
  intervals[1].fn(); // 旁路必须直接 return
  await sleep(20);
  assert.equal(trace.length, before, 'kill-switch 下旁路不得再触发任何 job');
});

test('并发：两条通道同时写 cron_state 不得重叠（负控制：去掉串行队列会 peak=2）', async () => {
  const { svc, puts, putPeak } = makeHarness();
  const jobMap = svc._jobs();
  // 用两个不同 job 并发走 runOne，模拟主 tick 与心跳同时进 finally。
  jobMap.get('metrics-collect').action = async () => ({});
  jobMap.get('wiki-lint').action = async () => ({});

  await Promise.all([
    svc.runNow('metrics-collect'),
    svc.runNow('wiki-lint'),
  ]);

  assert.equal(puts.length, 2, '两个 job 各写一条 state');
  assert.equal(
    putPeak(), 1,
    '整单元 last-write-wins 存储不许并发 put；peak=2 说明串行队列被去掉了',
  );
});

test('_tickPolicy 诊断面：分层结果与运行时一致', () => {
  const { svc } = makeHarness();
  const p = svc._tickPolicy();
  assert.equal(p.heartbeatJob, tickLane.HEARTBEAT_JOB);
  assert.ok(p.heartbeatMs >= 10_000);
  assert.deepEqual(
    [...p.heavyLane].sort(),
    [...tickLane.HEAVY_LANE].sort(),
    '_tickPolicy 的 heavyLane 必须取自同一个集合，不是另一份拷贝',
  );
  for (const id of p.fastLane) {
    assert.equal(tickLane.HEAVY_LANE.has(id), false, `${id} 不该同时出现在两层`);
  }
});
