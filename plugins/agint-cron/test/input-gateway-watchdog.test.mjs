// 输入网关看门狗测试（2026-10-09 新增，v0.2.15 首版 / v0.2.16 修判据）。
//
// 锁定九条行为，且每条都能抓住回退：
//   1. job 已注册，调度在 daily 06:00；
//   2. 服务未挂载 → soft-skip（返回 skipped，不抛）—— 与其它 job 同策略；
//   3. **探针失明**：getStatus() 返回 0 个通道 → 抛错。绝不能判成「0 问题 = 健康」；
//   4. 全健康 → alert:false 且零噪音；
//   5. 即投通道订阅未建立 / 即投失败 → CRITICAL / WARN；
//   6. 静默失效（跑过之后再没跑）→ CRITICAL 且抛错；
//   7. 报错累计达阈值 → CRITICAL 且抛错；
//   8. 从未采集 / 空转零信号 → WARN + alert:true，但**不抛**（不污染 cron 状态）；
//   9. 通道 disabled 时不参与判定。
//
// ⚠️ 第 3 条是这个 job 存在的全部理由（preflight v0.5「silent-zero fixture」）：
//   2026-09-29 agint-input-gateway 的 5 个检测器里 4 个恒返回 0，却报 ok=true，
//   lint 全绿、smoke exit 0 —— 全绿掩盖了失明，比没有监控更坏。
//   一个「0 通道 = 健康」的门禁会把同一次事故再演一遍。
//
// ⚠️ 第 10 条是**本 job 自己踩过的坑**（v0.2.16 修复）：
//   2026-10-09 首版把「fetchCount>0 且 signalsEmitted=0 且 signalsFiltered=0」
//   判成「空转失明」。真实数据上 adversarial 立刻命中。
//   但 adversarial 的 fetch() 是**空 drain**（agint-input-gateway/lib/channels/
//   adversarial.js:200 明写「空 drain（心跳保留）」），信号走事件到达时的
//   ingestImmediate —— signalsEmitted 恒为 0 是**设计如此**，不是失明。
//   换句话说：门禁在校验，但校验的是错的东西。这比不校验更坏，因为它让人
//   以为「已经有人在管这件事」。第 10 条钉死「即投通道必须走 health() 判据」。
//
// ⚠️ 第 11 条是格式回归防护：`lastFetchAt` 在 schema 里是
//   `z.string().nullable()`（agint-input-gateway/lib/storage.js:44），
//   不是 epoch 数字。用 Number() 解析会得到 NaN，静默失效判据永不触发 ——
//   而表现依然是「一切正常」。这是本 job 初版写错的地方，用测试钉死。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defaultJobs } from '../lib/jobs.js';

const job = defaultJobs.find((j) => j.id === 'input-gateway-watchdog');

const HOUR = 3600_000;

/**
 * 构造一个通道。默认给「fetch 产出型 + 健康」的状态。
 * health 只有 immediate-emit 通道才有（其余通道源码里没实现 health()）。
 */
function makeChannel(over = {}) {
  const { counters = {}, health, ...rest } = over;
  const out = {
    channelId: 'cross-agent',
    channelType: 'cross-agent',
    enabled: true,
    quota: 15,
    lastFetchAt: new Date().toISOString(),
    lastFetchDurationMs: 12,
    lastError: null,
    counters: {
      channelId: 'cross-agent',
      fetchCount: 4,
      signalsEmitted: 3,
      signalsFiltered: 1,
      signalsDeduplicated: 0,
      securityScanned: 3,
      securityFlagged: 0,
      securityDropped: 0,
      errorCount: 0,
      lastFetchAt: null,
      createdAt: new Date().toISOString(),
      ...counters,
    },
  };
  if (health !== undefined) out.health = health;
  return { ...out, ...rest };
}

/** 即投型通道（adversarial）：health.mode='immediate-emit'，fetch 是空 drain。 */
function makeImmediateChannel(over = {}) {
  const { health = {}, ...rest } = over;
  return makeChannel({
    channelId: 'adversarial',
    channelType: 'adversarial',
    quota: 10,
    // 即投通道的 counters 常态：fetch 在跑但产出为 0（设计如此）
    counters: {
      fetchCount: 5,
      signalsEmitted: 0,
      signalsFiltered: 0,
    },
    health: {
      channelId: 'adversarial',
      status: 'ok',
      initError: null,
      mode: 'immediate-emit',
      ingestedSignals: 3,
      ingestFailed: 0,
      detectors: {
        counterfactual: { active: true, source: 'diagnosis.completed' },
        curriculumResult: { active: true, source: 'curriculum.challenge-verdicted' },
        boundaryDivergence: { active: true, source: 'curriculum.boundary-probed' },
      },
      ...health,
    },
    ...rest,
  });
}

/** 四通道的默认健康组合（周期各异，见 schema.js C2-C5_CRON）。 */
function healthyChannels() {
  return [
    makeChannel({ channelId: 'self-observation', channelType: 'self-observation', quota: 50 }),
    makeChannel({ channelId: 'external-git', channelType: 'external', quota: 20 }),
    makeImmediateChannel(),
    makeChannel({ channelId: 'cross-agent', channelType: 'cross-agent', quota: 15 }),
  ];
}

/** 跑一次 action，捕获 console.warn 噪音与抛错。 */
async function run(statusOrUndefined) {
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const services = statusOrUndefined === undefined
      ? {}
      : { 'agint.inputGateway': { getStatus: async () => statusOrUndefined } };
    const result = await job.action(services);
    return { result, warns, error: null };
  } catch (error) {
    return { result: null, warns, error };
  } finally {
    console.warn = realWarn;
  }
}

const rowOf = (result, id) => result.perChannel.find((r) => r.channelId === id);

test('job 已注册且调度在 daily 06:00', () => {
  assert.ok(job, 'input-gateway-watchdog 未在 defaultJobs 中注册');
  assert.equal(job.schedule, '0 6 * * *');
  assert.equal(typeof job.action, 'function');
});

test('服务未挂载 → soft-skip，不抛错', async () => {
  const { result, error } = await run(undefined);
  assert.equal(error, null);
  assert.equal(result.skipped, true);
});

test('【silent-zero 防护】getStatus() 返回 0 个通道 → 抛错，不得判为健康', async () => {
  for (const st of [{ channels: [] }, {}, { channels: null }]) {
    const { result, error } = await run(st);
    assert.ok(error, '探针失明必须抛错，不能返回「一切正常」');
    assert.match(error.message, /探针失明/);
    assert.equal(result, null, '失明时不得返回一个看起来健康的 result');
  }
});

test('四通道全健康 → alert:false，零告警噪音，并回报每通道判定', async () => {
  const { result, error, warns } = await run({ channels: healthyChannels() });
  assert.equal(error, null);
  assert.equal(result.alert, false);
  assert.equal(result.warningCount, 0);
  assert.equal(result.criticalCount, 0);
  assert.equal(result.channelCount, 4);
  assert.equal(warns.length, 0, '健康态不应产生任何告警输出');
  assert.deepEqual(
    result.perChannel.map((r) => r.verdict),
    ['ok', 'ok', 'ok', 'ok'],
  );
});

/**
 * ⚠️ 本 job 初版栽在这里（v0.2.16 修）。
 *
 * 真实生产数据：adversarial counters = {fetchCount:5, signalsEmitted:0,
 * signalsFiltered:0}，health = {status:'ok', mode:'immediate-emit',
 * ingestedSignals:0, ingestFailed:0, detectors 3 个全 active}。
 * 初版判「空转失明」——**误报**：fetch 是空 drain，产出 0 是设计如此。
 */
test('【核心回归】即投通道 counters 产出为 0 不是空转 —— 判据必须走 health()', async () => {
  // 前置：把初版的错误前提显式钉住
  const ch = makeImmediateChannel({ health: { ingestedSignals: 0 } });
  assert.equal(ch.counters.signalsEmitted, 0, '前置：即投通道 counters 产出确实为 0');
  assert.equal(ch.health.mode, 'immediate-emit', '前置：该通道是即投模式');

  const { result, error, warns } = await run({ channels: healthyChannels().map((c) =>
    c.channelId === 'adversarial' ? ch : c) });
  assert.equal(error, null, '订阅健康的即投通道不该抛错');
  const row = rowOf(result, 'adversarial');
  assert.notEqual(row.verdict, 'WARN:idle',
    '即投通道绝不能被判成 fetch 空转 —— fetch 是空 drain，产出 0 属设计');
  assert.equal(row.verdict, 'WARN:noEvent',
    '订阅正常但没收到事件，应报「查上游是否 publish」而不是「采集器失明」');
  // 告警文案必须指向真因（上游没发事件），不能指向假因（采集器瞎了）
  assert.match(warns.join('\n'), /3 个检测器 active/);
  assert.match(warns.join('\n'), /上游是否真的 publish/);
});

test('【正样本·订阅未建立】即投通道 status=degraded → CRITICAL 且抛错', async () => {
  const { error } = await run({ channels: healthyChannels().map((c) =>
    c.channelId === 'adversarial'
      ? makeImmediateChannel({ health: { status: 'degraded', initError: 'eventBus subscribe unavailable', ingestedSignals: 0 } })
      : c) });
  assert.ok(error, '订阅没建起来比「没事件」更严重，必须抛');
  assert.match(error.message, /CRITICAL/);
  assert.match(error.message, /adversarial/);
  assert.match(error.message, /eventBus subscribe unavailable/);
});

test('【正样本·即投失败】ingestFailed>0 → WARN + alert:true，但不抛错', async () => {
  const { result, error, warns } = await run({ channels: healthyChannels().map((c) =>
    c.channelId === 'adversarial'
      ? makeImmediateChannel({ health: { ingestFailed: 4, ingestedSignals: 0 } })
      : c) });
  assert.equal(error, null);
  assert.equal(result.alert, true);
  assert.equal(rowOf(result, 'adversarial').verdict, 'WARN:ingestFailed');
  assert.match(warns.join('\n'), /即投失败 4 次/);
});

test('【正样本·静默失效】曾采集过但远超周期未更新 → CRITICAL 且抛错', async () => {
  // self-observation 周频：7d × 2.5 + 6h = 168h × 2.5 + 6h = 426h。430h 越过阈值。
  const { error } = await run({ channels: healthyChannels().map((c) =>
    c.channelId === 'self-observation'
      ? { ...c, lastFetchAt: new Date(Date.now() - 430 * HOUR).toISOString() }
      : c) });
  assert.ok(error, '静默失效是真故障，必须抛给调度层');
  assert.match(error.message, /CRITICAL/);
  assert.match(error.message, /self-observation/);
  assert.match(error.message, /静默失效/);
});

test('【阈值边界】落在 2.5×周期 + 6h 宽限之内 → 不报静默失效', async () => {
  // self-observation 周频阈值 = 426h。425h 在阈下。
  const { error, result } = await run({ channels: healthyChannels().map((c) =>
    c.channelId === 'self-observation'
      ? { ...c, lastFetchAt: new Date(Date.now() - 425 * HOUR).toISOString() }
      : c) });
  assert.equal(error, null, '未越过阈值不应报静默失效（避免噪音）');
  assert.equal(result.criticalCount, 0);
});

test('【周期差异】同一个 70h 未更新：日频通道算失效，周频通道不算', async () => {
  // PERIOD_MS 里 adversarial=1d、cross-agent=7d。用同一个 adversarial id 造一个
  // **无 health 的 fetch 型**通道，才能走到 A 判据（即投型会先被 health 分支拦下）。
  const daily = await run({ channels: [
    makeChannel({
      channelId: 'adversarial',
      lastFetchAt: new Date(Date.now() - 70 * HOUR).toISOString(),
    }),
  ] });
  assert.ok(daily.error, '日频阈值 = 24h×2.5+6h = 66h，70h 越过 ⇒ 应判静默失效');
  assert.match(daily.error.message, /静默失效/);

  const weekly = await run({ channels: [
    makeChannel({
      channelId: 'cross-agent',
      lastFetchAt: new Date(Date.now() - 70 * HOUR).toISOString(),
    }),
  ] });
  assert.equal(weekly.error, null, '周频阈值 = 426h，70h 在阈下 ⇒ 不该判失效');
  assert.equal(weekly.result.criticalCount, 0);
});

test('【正样本·反复报错】errorCount 达阈值 → CRITICAL 且抛错，附最近错误', async () => {
  const { error } = await run({ channels: healthyChannels().map((c) =>
    c.channelId === 'external-git'
      ? { ...c, lastError: 'zstd CLI not found', counters: { ...c.counters, errorCount: 3 } }
      : c) });
  assert.ok(error);
  assert.match(error.message, /CRITICAL/);
  assert.match(error.message, /external-git/);
  assert.match(error.message, /zstd CLI not found/);
});

test('【正样本·从未采集】fetchCount=0 → WARN + alert:true，但不抛错', async () => {
  const { result, error, warns } = await run({ channels: healthyChannels().map((c) =>
    c.channelId === 'cross-agent'
      ? { ...c, lastFetchAt: null, counters: { ...c.counters, fetchCount: 0, signalsEmitted: 0, signalsFiltered: 0 } }
      : c) });
  assert.equal(error, null, '从未采集是提示不是故障，不该让 job 记 failed');
  assert.equal(result.alert, true, '必须仍能看见');
  assert.equal(result.warningCount, 1);
  assert.equal(result.criticalCount, 0);
  assert.match(warns[0], /cross-agent/);
  assert.match(warns[0], /从未采集/);
});

test('【正样本·空转】fetch 型通道跑过但产出与过滤均为 0 → WARN，但不抛错', async () => {
  const { result, error, warns } = await run({ channels: healthyChannels().map((c) =>
    c.channelId === 'self-observation'
      ? { ...c, counters: { ...c.counters, fetchCount: 9, signalsEmitted: 0, signalsFiltered: 0 } }
      : c) });
  assert.equal(error, null);
  assert.equal(result.alert, true);
  assert.equal(rowOf(result, 'self-observation').verdict, 'WARN:idle');
  assert.match(warns.join('\n'), /空转/);
});

test('disabled 通道不参与判定（配了 enabled:false 的通道不算从未采集）', async () => {
  const channels = healthyChannels().map((c) =>
    c.channelId === 'external-git'
      ? {
          ...c,
          enabled: false,
          lastFetchAt: null,
          counters: { ...c.counters, fetchCount: 0, signalsEmitted: 0, signalsFiltered: 0 },
        }
      : c
  );
  const { result, error } = await run({ channels });
  assert.equal(error, null, '禁用的通道本就不该被采集，不该告警');
  assert.equal(result.warningCount, 0);
  assert.equal(rowOf(result, 'external-git').verdict, 'disabled');
});

test('WARN 与 CRITICAL 共存 → 仍抛错，且抛的是 CRITICAL 那一档', async () => {
  const { result, error, warns } = await run({
    channels: healthyChannels().map((c) => {
      if (c.channelId === 'self-observation') {
        return { ...c, lastFetchAt: new Date(Date.now() - 430 * HOUR).toISOString() };
      }
      if (c.channelId === 'cross-agent') {
        return { ...c, lastFetchAt: null, counters: { ...c.counters, fetchCount: 0, signalsEmitted: 0, signalsFiltered: 0 } };
      }
      return c;
    }),
  });
  assert.ok(error, 'CRITICAL 必须抛给调度层');
  assert.match(error.message, /CRITICAL/);
  assert.doesNotMatch(error.message, /cross-agent/, '抛错文案只应是 CRITICAL 档');
  assert.equal(result, null, 'CRITICAL 抛出后不返回 result');
  assert.equal(warns.length, 2, 'WARN 与 CRITICAL 都必须留下告警输出');
});

test('【格式回归】lastFetchAt 是 ISO 字符串：静默失效判据必须能识别它', async () => {
  // 若实现误用 Number(lastFetchAt) → NaN → lastMs=0 → A 判据永不触发，
  // 而结果仍会是「无 CRITICAL」。本条断言 ISO 字符串形态真的能被判成失效。
  const iso = new Date(Date.now() - 430 * HOUR).toISOString();
  assert.equal(typeof iso, 'string', '前置：真实 lastFetchAt 就是 ISO 字符串');
  assert.ok(Number.isNaN(Number(iso)), '前置：Number(ISO字符串) 确实是 NaN（这正是陷阱）');
  const { error } = await run({ channels: healthyChannels().map((c) =>
    c.channelId === 'self-observation' ? { ...c, lastFetchAt: iso } : c) });
  assert.ok(error, 'ISO 字符串形态的 lastFetchAt 必须能触发静默失效判定');
  assert.match(error.message, /静默失效/);
});

test('未知 channelId / 缺 counters 字段 → 不崩，按无周期处理', async () => {
  const { result, error } = await run({
    channels: [
      { channelId: 'brand-new-channel', channelType: 'external', enabled: true },
      makeChannel({ channelId: 'cross-agent' }),
    ],
  });
  assert.equal(error, null, '未知通道没有 PERIOD_MS，应跳过 A 判据而不是崩');
  assert.equal(result.channelCount, 2);
  // fetchCount 缺失 → 落到 `?? 0` → 判「从未采集」WARN，不该崩
  assert.equal(rowOf(result, 'brand-new-channel').verdict, 'WARN:neverFetched');
});

/**
 * 接线回归：services 是**白名单**而非 ctx 全量透传（lib/index.js:159）。
 * 漏掉 `'agint.inputGateway'` 那一行，job 不会报错、只会每天报 skipped ——
 * 症状与「网关没跑」一模一样。lib/index.js:166-167 记着同类的历史坑
 * （ledger-anchor 漏 'agint.evolution'，2026-10-03 实测钉死）。
 *
 * 局限：这是源码字符串断言，证明不了运行时 ctx.get 真能解析到值 ——
 * 那需要真实挂载后 cron_run_now 验一次。
 */
test('【接线】lib/index.js 的 services 白名单含 agint.inputGateway', async () => {
  const p = fileURLToPath(new URL('../lib/index.js', import.meta.url));
  const src = await readFile(p, 'utf8');
  assert.match(src, /'agint\.inputGateway':\s*ctx\.get\('agint\.inputGateway'\)/);
});
