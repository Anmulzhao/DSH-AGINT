// tick 串行化测试（2026-09-18）。
//
// 背景：tick 原先用 `void runOne(job)` 逐个"发射即忘"，同一批到期的 job 谁能
// 先跑完纯看各自动作耗时。实测 2026-09-18 10:10 唤醒补跑：observe 10:10:54 →
// release 10:10:55 → aggregate 10:11:30 —— **生成候选**那一趟比**发布**那一趟
// 晚 36 秒落地，于是它当天生成的候选全部赶不上车，要等下一个班次（次日 05:15
// 或下次唤醒），把设计意图里 30 分钟的间隔（aggregate 04:45 → release 05:15）
// 拉成了大约一天。
//
// 本文件锁定修复后的三条行为，且**能抓住回退**：
//   1. 同一 tick 内 due 的 job 按定义序**跑完一个再跑下一个**；
//   2. tick 在途时，新 tick 不得抢跑"尚未轮到"的 job（防重入）；
//   3. 单个 job 抛错不得中断整批。
//
// 第 2 条尤其重要：`job.running` 只能挡住"正在跑的那个"，挡不住"还没轮到的" ——
// 若去掉重入保护，一个慢 job 会让其余 due 的 job 被下一个 tick 提前并发拉起，
// 串行化名存实亡。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAR_FUTURE = Date.now() + 30 * 86_400_000;

// 极简 cordis ctx：只实现 apply() 用到的那几个面。
function makeHarness() {
  const provided = {};
  const ctx = {
    get: () => undefined,
    provide: (name, svc) => { provided[name] = svc; },
    effect: (fn) => { fn(); },
    setInterval: () => ({ dispose() {} }),
    storageDomain: {
      open: async () => ({
        table: () => ({ entries: () => [], put: async () => {} }),
        close: async () => {},
      }),
    },
  };
  apply(ctx);
  return { svc: provided['agint.cron'], internals: provided['agint.cron'] };
}

// 让整张 job 表都不 due，只把 `ids` 放出来（lastRunAt=null ⇒ isDue 恒真）。
function isolate(jobMap, definitionOrder, ids) {
  for (const [, job] of jobMap) job.lastRunAt = FAR_FUTURE;
  for (const id of ids) {
    const job = jobMap.get(id);
    assert.ok(job, `job 不存在: ${id}`);
    job.lastRunAt = null;
  }
  return ids.map((id) => jobMap.get(id));
}

function orderedJobIds(jobMap) {
  // jobById 的插入序 = compileJobs() 的定义序
  return Array.from(jobMap.keys());
}

test('tick: 同一批 due 的 job 按定义序串行 —— 前一个跑完才轮到下一个', async () => {
  const { svc } = makeHarness();
  const jobMap = svc._jobs();
  const order = orderedJobIds(jobMap);

  // 定义序前提：aggregate（生成候选）必须排在 release（发布）之前
  const iAgg = order.indexOf('skill-autocreate-aggregate');
  const iRel = order.indexOf('skill-autocreate-release');
  assert.ok(iAgg >= 0 && iRel >= 0, '两个 job 都应注册');
  assert.ok(iAgg < iRel, `aggregate 必须排在 release 之前（实际 ${iAgg} vs ${iRel}）`);

  const trace = [];
  const agg = jobMap.get('skill-autocreate-aggregate');
  const rel = jobMap.get('skill-autocreate-release');
  agg.action = async () => { trace.push('aggregate:start'); await sleep(60); trace.push('aggregate:end'); return {}; };
  rel.action = async () => { trace.push('release:start'); await sleep(5); trace.push('release:end'); return {}; };
  isolate(jobMap, order, ['skill-autocreate-aggregate', 'skill-autocreate-release']);

  await svc._tickNow();

  // 回退判据：若改回 fire-and-forget，release 耗时会先于 aggregate 结束，
  // trace 会变成 ['aggregate:start','release:start','release:end','aggregate:end']。
  assert.deepEqual(
    trace,
    ['aggregate:start', 'aggregate:end', 'release:start', 'release:end'],
    '后一个 job 不得在前一个完成前启动',
  );
});

test('tick: 在途期间新 tick 不得抢跑尚未轮到的 job（防重入）', async () => {
  const { svc } = makeHarness();
  const jobMap = svc._jobs();
  const t0 = Date.now();
  const marks = {};

  const agg = jobMap.get('skill-autocreate-aggregate');
  const rel = jobMap.get('skill-autocreate-release');
  agg.action = async () => {
    marks.aggStart = Date.now() - t0;
    await sleep(80);
    marks.aggEnd = Date.now() - t0;
    return {};
  };
  rel.action = async () => { marks.relStart = Date.now() - t0; return {}; };
  isolate(jobMap, orderedJobIds(jobMap), ['skill-autocreate-aggregate', 'skill-autocreate-release']);

  const first = svc._tickNow();
  await sleep(20);                 // aggregate 仍在跑
  await svc._tickNow();            // 第二次 tick：应被抑制
  await first;                     // 串行跑完

  assert.ok(
    marks.relStart >= marks.aggEnd,
    `release 必须在 aggregate 结束后才启动（relStart=${marks.relStart} aggEnd=${marks.aggEnd}）` +
    ' —— 说明第二次 tick 抢跑了尚未轮到的 job',
  );
});

test('tick: 单个 job 抛错不得中断整批', async () => {
  const { svc } = makeHarness();
  const jobMap = svc._jobs();
  const realError = console.error;
  console.error = () => {}; // 预期内的失败日志，静音以免污染测试输出
  try {
    jobMap.get('skill-autocreate-aggregate').action = async () => { throw new Error('boom'); };
    let releaseRan = false;
    jobMap.get('skill-autocreate-release').action = async () => { releaseRan = true; return {}; };
    isolate(jobMap, orderedJobIds(jobMap), ['skill-autocreate-aggregate', 'skill-autocreate-release']);

    await svc._tickNow();

    assert.equal(releaseRan, true, '前一个 job 抛错后，后续 job 仍须执行');
  } finally {
    console.error = realError;
  }
});

test('tick: 未到点的 job 不被启动', async () => {
  const { svc } = makeHarness();
  const jobMap = svc._jobs();
  let ran = false;
  jobMap.get('skill-autocreate-release').action = async () => { ran = true; return {}; };
  for (const [, job] of jobMap) job.lastRunAt = FAR_FUTURE; // 全部视为已跑过

  await svc._tickNow();

  assert.equal(ran, false, 'isDue 为假的 job 不得被执行');
});
