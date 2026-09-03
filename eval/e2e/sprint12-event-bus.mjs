/**
 * eval/e2e/sprint12-event-bus.mjs — Sprint 12 A6/A7/A8 事件边集成 e2e。
 *
 * 不依赖 dsh 启动（mock ctx）。跑法：
 *   node eval/e2e/sprint12-event-bus.mjs        （须在仓库根目录跑，AGINT_ROOT=cwd）
 * 退出码: 0 全过, 1 任一 fail.
 *
 * 覆盖（T1 影子期，直连保留）：
 *   A6  diagnosis.completed：真 agint-diagnosis.report() 经真 agint-event-bus publish
 *       → 真 agint-mutator 订阅 handler 收到 → 观测计数 +1
 *   A7  metrics.snapshot：真 agint-metrics._flushSnapshotOnce() 经真 bus publish
 *       → eventBus.inspect 可见 metrics.snapshot envelope（source=agint-metrics）
 *
 * Sprint 13 §3.1 补录（每个场景 ≥3 断言）：
 *   s12-07  cron metrics-collect → bus.publish(A7) → report/memory 订阅消费
 *           → eventBus.metricsSnapshot 导出
 *           ① 订阅者收到 Envelope 且 traceId 与 inspect 记录一致
 *           ② payload 不可变（深冻结；写入抛 TypeError 且 Object.isFrozen 为真）
 *           ③ metrics 导出 eventBus.syncSubscriptions
 *   s12-08  night-dream 完成 → bus.publish(A8) → metrics/report 订阅消费
 *           → 周复盘模板两行落 wiki
 *           ① at-least-once 投递（两个订阅者都收到同一 envelope）
 *           ② handler 异常隔离（注入故障订阅者不影响其他订阅者）
 *           ③ 复盘模板两行写入（Event Bus 死信率 + sync 订阅数）
 *   s12-09  sync 订阅触顶：第 4 个 sync 订阅被拒
 *           → inspectSummary.syncSubscriptionCount=3 → 注入死信
 *           → eventBus.deadletterRate 导出
 *           ① 超配额硬拒（sync 抛错；async 劝导路径提示不阻断）
 *           ② 死信进入 DLQ 且可查询（agint.eventBus.deadletters）
 *           ③ deadletterRate 计算正确（deadletterCount / publishedCount × 100）
 */

import { makeMockCtx } from '../scenarios/driver.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AGINT_ROOT = process.cwd();
// Windows 上 ESM 动态 import 必须走 file:// URL（裸 `D:\...` 会抛
// ERR_UNSUPPORTED_ESM_URL_SCHEME）；pathToFileURL 保证跨平台上可跑。
const pluginUrl = (rel) => pathToFileURL(resolve(AGINT_ROOT, rel)).href;

let pass = 0;
let fail = 0;
const counts = (ok) => (ok ? pass++ : fail++);

async function step(name, fn) {
  process.stdout.write(`▶ ${name}... `);
  try { await fn(); counts(true); console.log('✓'); return true; }
  catch (err) { counts(false); console.log(`✗ ${err.message}`); return false; }
}

function makeTable() {
  const maps = new Map();
  const get = (name) => {
    if (!maps.has(name)) maps.set(name, new Map());
    return maps.get(name);
  };
  const table = (name) => ({
    put: async (id, value) => { get(name).set(id, value); return true; },
    get: async (id) => get(name).get(id) ?? null,
    delete: async (id) => { get(name).delete(id); return true; },
    entries: () => get(name).entries(),
    size: async () => get(name).size,
  });
  return { table, maps };
}

/** 每个场景独立的 bus 环境：清模块级订阅表 + ring + published 计数 */
async function freshBus() {
  const busMod = await import(pluginUrl('plugins/agint-event-bus/lib/bus.js'));
  busMod.disposeBus();
  return busMod;
}

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

// ── A6: diagnosis.completed publish + mutator subscribe via real bus ──
async function runA6() {
  const ctx = makeMockCtx();
  await freshBus();

  // mock 上游（diagnosis 需 evolution；mutator 需 evolution）
  const evoStore = { evolution_log: new Map(), failure_pattern: new Map(), success_template: new Map() };
  ctx.provide('agint.evolution', {
    logPhase4: async (e) => { evoStore.evolution_log.set(e?.targetId ?? 'x', e); return e; },
    logPhase4Buffered: async (e) => { evoStore.evolution_log.set(e?.targetId ?? 'x', e); return e; },
    addFailure: async (e) => { evoStore.failure_pattern.set(e?.pattern ?? 'x', e); return e; },
    addSuccess: async (e) => { evoStore.success_template.set(e?.pattern ?? 'x', e); return e; },
    queryFailures: async () => [], queryTemplates: async () => [],
    getLogRange: async () => [], stats: async () => ({ evolution_log: evoStore.evolution_log.size }),
    logBuffered: async () => ({}),
  });
  ctx.provide('agint.wiki', { write: async () => undefined });
  ctx.provide('agint.memory', { write: async (r) => ({ id: `m-${Date.now()}`, ...r }), read: async () => null, search: async () => ({ items: [] }) });

  // 真 event-bus apply（提供 publish/subscribe/inspect 3 个 single service）
  const ebIndex = await import(pluginUrl('plugins/agint-event-bus/lib/index.js'));
  ebIndex.apply(ctx, {});
  await settle();

  // 真 mutator apply（订阅 diagnosis.completed）
  const mutatorMod = await import(pluginUrl('plugins/agint-mutator/lib/index.js'));
  mutatorMod.apply(ctx, {});
  await settle();

  // 真 diagnosis apply（report() 会 publish diagnosis.completed）
  const diagMod = await import(pluginUrl('plugins/agint-diagnosis/lib/index.js'));
  diagMod.apply(ctx, {});
  await settle();

  // 触发 report()（需要 annotations + aggregateReport 数据 —— 用诊断 domain 写入）
  const diagDomain = await ctx.storageDomain.open({ name: 'agint_diagnosis', version: 1 });
  const diagTable = diagDomain.table('annotations');
  const now = Date.now();
  for (const [i, rc] of ['TOOL_GAP', 'TOOL_GAP', 'PROMPT_DEFICIENCY'].entries()) {
    await diagTable.put(`a-${i}`, {
      failureId: `f-${i}`, rootCause: rc, confidence: 0.7, evidence: '...', kind: 'annotation',
      createdAt: new Date(now - (i + 1) * 86400_000).toISOString(),
    });
  }

  const report = ctx.get('agint.diagnosis.report');
  if (typeof report !== 'function') throw new Error('missing agint.diagnosis.report');
  const r = await report({ windowDays: 7 });

  // 校验 mutator 观测计数 = 1（真订阅收到 diagnosis.completed）
  const countSvc = ctx.get('agint.mutator._diagnosisCompletedObservationCount');
  const mutatorObserved = countSvc() >= 1;

  // 校验 envelope 落 inspect（topic=diagnosis.completed, source=agint-diagnosis）
  const inspectSvc = ctx.get('agint.eventBus.inspect');
  const events = inspectSvc && typeof inspectSvc === 'function' ? inspectSvc({}) : [];
  const diagEvents = (events ?? []).filter((e) => e.topic === 'diagnosis.completed');
  const envelopeOk = diagEvents.length >= 1
    && diagEvents[0].source === 'agint-diagnosis'
    && diagEvents[0].deliveries?.['agint-mutator'] === 'DELIVERED';

  counts(mutatorObserved && envelopeOk && r.windowDays === 7);
  if (!(mutatorObserved && envelopeOk)) {
    throw new Error(`A6 fail: mutatorObserved=${mutatorObserved} envelopeOk=${envelopeOk} diagEvents=${diagEvents.length}`);
  }
}

// ── A7: metrics.snapshot publish via real bus (service._flushSnapshotOnce) ──
async function runA7() {
  const ctx = makeMockCtx();
  await freshBus();

  // 上游 sources：cron/rules/wiki/memory（computeMetrics 需要）
  ctx.provide('agint.cron', { health: () => ({ healthy: true, issues: [], jobs: [] }) });
  ctx.provide('agint.rules', { audit: () => ({ rules: [], totals: { hits: 0, denies: 0, asks: 0, advisories: 0 } }), lint: async () => [] });
  ctx.provide('agint.wiki', { stats: async () => ({ brokenLinks: 0, contradictions: 0, orphans: 0 }) });
  ctx.provide('agint.memory', { stats: async () => ({ total: 0, avgConfidence: 0 }), read: async () => null, write: async (r) => ({ id: 'm', ...r }) });

  // 真 event-bus + 真 metrics
  const ebIndex = await import(pluginUrl('plugins/agint-event-bus/lib/index.js'));
  ebIndex.apply(ctx, {});
  await settle();

  const metricsMod = await import(pluginUrl('plugins/agint-metrics/lib/index.js'));
  metricsMod.apply(ctx, {});
  await settle();

  const metrics = ctx.get('agint.metrics');
  const flush = metrics?._flushSnapshotOnce;
  if (typeof flush !== 'function') throw new Error('missing agint.metrics._flushSnapshotOnce');

  // 先 collect 一次（写表，让 summary 有数据），再 flush
  await metrics.collect();
  const fr = await flush();
  if (!fr || typeof fr !== 'object') throw new Error('flush returned non-object');

  // 校验 envelope 落 inspect（topic=metrics.snapshot, source=agint-metrics）
  await settle();
  const inspectSvc = ctx.get('agint.eventBus.inspect');
  const events = inspectSvc && typeof inspectSvc === 'function' ? inspectSvc({}) : [];
  const snapEvents = (events ?? []).filter((e) => e.topic === 'metrics.snapshot');
  const envelopeOk = snapEvents.length >= 1 && snapEvents[0].source === 'agint-metrics';
  counts(envelopeOk);
  if (!envelopeOk) throw new Error(`A7 fail: snapEvents=${snapEvents.length}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// s12-07 — A7 全链路：metrics-collect → publish → 订阅消费 → metricsSnapshot 导出
// ─────────────────────────────────────────────────────────────────────────────
async function runS12_07() {
  const ctx = makeMockCtx();
  await freshBus();

  ctx.provide('agint.cron', { health: () => ({ healthy: true, issues: [], jobs: [] }) });
  ctx.provide('agint.rules', { audit: () => ({ rules: [], totals: { hits: 0, denies: 0, asks: 0, advisories: 0 } }), lint: async () => [] });
  ctx.provide('agint.wiki', { stats: async () => ({ brokenLinks: 0, contradictions: 0, orphans: 0 }) });
  ctx.provide('agint.memory', { stats: async () => ({ total: 0, avgConfidence: 0 }), read: async () => null, write: async (r) => ({ id: 'm', ...r }) });

  const ebIndex = await import(pluginUrl('plugins/agint-event-bus/lib/index.js'));
  ebIndex.apply(ctx, {});
  await settle();

  const metricsMod = await import(pluginUrl('plugins/agint-metrics/lib/index.js'));
  metricsMod.apply(ctx, {});
  await settle();

  // ── 模拟 report / memory 两个消费端订阅 A7 ──
  const received = [];
  const frozenFlags = [];
  const subscribe = ctx.get('agint.eventBus.subscribe');
  if (typeof subscribe !== 'function') throw new Error('missing agint.eventBus.subscribe');
  const unsub = subscribe(
    { subscriber: 'agint-quality-report', topics: ['metrics.snapshot'], mode: 'async', timeoutMs: 5000 },
    (env) => {
      received.push({ id: env.id, traceId: env.traceId, topic: env.topic, source: env.source });
      frozenFlags.push(Object.isFrozen(env.payload));
    },
  );

  const metrics = ctx.get('agint.metrics');
  await metrics.collect();
  await metrics._flushSnapshotOnce();
  await settle(80);

  // ── 断言①：订阅者收到 Envelope，且 traceId 与 inspect 记录一致 ──
  if (received.length < 1) throw new Error('s12-07 ①: 订阅者未收到 metrics.snapshot envelope');
  const inspect = ctx.get('agint.eventBus.inspect');
  const logged = inspect({ topic: 'metrics.snapshot' });
  const byId = new Map(logged.map((e) => [e.id, e]));
  const traceMismatch = received.filter((r) => {
    const rec = byId.get(r.id);
    return !rec || rec.traceId !== r.traceId;
  });
  if (traceMismatch.length > 0) {
    throw new Error(`s12-07 ①: ${traceMismatch.length}/${received.length} 条 traceId 与 inspect 不一致`);
  }

  // ── 断言②：payload 不可变（深冻结）—— 写入必须抛 TypeError ──
  if (frozenFlags.some((f) => f !== true)) {
    throw new Error('s12-07 ②: 存在未冻结的 envelope payload');
  }
  let mutabilityProbe = null;
  const unsubProbe = subscribe(
    { subscriber: 's12-07-probe', topics: ['metrics.snapshot'], mode: 'async', timeoutMs: 5000 },
    (env) => {
      try { env.payload.key = 'MUTATED'; mutabilityProbe = 'no-throw'; }
      catch (err) { mutabilityProbe = err instanceof TypeError ? 'throws' : `other:${err.name}`; }
    },
  );
  await metrics._flushSnapshotOnce();
  await settle(80);
  unsubProbe();
  if (mutabilityProbe !== 'throws') {
    throw new Error(`s12-07 ②: payload 写入未抛 TypeError（probe=${mutabilityProbe}）`);
  }

  // ── 断言③：metrics 导出 eventBus.syncSubscriptions（A10 尾巴）──
  await metrics.collect();
  const summary = await metrics.summary();
  const keys = (summary.metrics ?? []).map((m) => m.key);
  if (!keys.includes('eventBus.syncSubscriptions')) {
    throw new Error(`s12-07 ③: metrics 未导出 eventBus.syncSubscriptions（keys=${keys.join(',')}）`);
  }
  const syncSub = summary.metrics.find((m) => m.key === 'eventBus.syncSubscriptions');
  if (typeof syncSub.value !== 'number') throw new Error('s12-07 ③: syncSubscriptions 值非数字');

  unsub();
}

// ─────────────────────────────────────────────────────────────────────────────
// s12-08 — A8 全链路：night-dream → publish → 多订阅消费 → 周复盘模板两行落 wiki
// ─────────────────────────────────────────────────────────────────────────────
async function runS12_08() {
  const ctx = makeMockCtx();
  await freshBus();

  // dream 需要真实目录（sweep 会写 diary）；用临时目录，跑完清理
  const base = await mkdtemp(join(tmpdir(), 's12-08-dream-'));
  const sessions = join(base, 'sessions');
  const diary = join(base, 'diary');
  await mkdir(sessions, { recursive: true });
  await mkdir(diary, { recursive: true });

  try {
    // wiki 落盘载体：周复盘模板两行写这里
    const wikiPages = new Map();
    ctx.provide('agint.wiki', {
      write: async (path, content) => { wikiPages.set(path, content); },
      read: async (path) => wikiPages.get(path) ?? null,
      stats: async () => ({ brokenLinks: 0, contradictions: 0, orphans: 0 }),
    });
    ctx.provide('agint.memory', {
      list: async () => [],
      write: async (r) => ({ id: `m-${Date.now()}`, ...r }),
      read: async () => null,
      search: async () => ({ items: [] }),
      stats: async () => ({ total: 0, avgConfidence: 0 }),
    });
    ctx.provide('agint.cron', { health: () => ({ healthy: true, issues: [], jobs: [] }) });
    ctx.provide('agint.rules', { audit: () => ({ rules: [], totals: { hits: 0, denies: 0, asks: 0, advisories: 0 } }), lint: async () => [] });

    const ebIndex = await import(pluginUrl('plugins/agint-event-bus/lib/index.js'));
    ebIndex.apply(ctx, {});
    await settle();

    const metricsMod = await import(pluginUrl('plugins/agint-metrics/lib/index.js'));
    metricsMod.apply(ctx, {});
    await settle();

    const subscribe = ctx.get('agint.eventBus.subscribe');
    if (typeof subscribe !== 'function') throw new Error('missing agint.eventBus.subscribe');

    // 消费端 1：metrics（计数）——正常订阅者
    const metricsSeen = [];
    const unsubMetrics = subscribe(
      { subscriber: 'agint-metrics', topics: ['dream.completed'], mode: 'async', timeoutMs: 5000 },
      (env) => { metricsSeen.push({ id: env.id, traceId: env.traceId }); },
    );

    // 消费端 2：report（写周复盘模板两行）——正常订阅者
    const unsubReport = subscribe(
      { subscriber: 'agint-quality-report', topics: ['dream.completed'], mode: 'async', timeoutMs: 5000 },
      async (env) => {
        const snapSvc = ctx.get('agint.eventBus.metricsSnapshot');
        const snap = (typeof snapSvc === 'function') ? await snapSvc() : { deadletterCount: 0, publishedCount: 0, syncSubscriptions: 0 };
        const rate = snap.publishedCount > 0
          ? ((snap.deadletterCount / snap.publishedCount) * 100).toFixed(3)
          : '0';
        const wiki = ctx.get('agint.wiki');
        await wiki.write(`AGINT/weekly-review-${String(env.payload?.completedAt ?? '').slice(0, 10)}.md`, [
          `# 周复盘（dream.completed 触发）`,
          '',
          `- Event Bus sync 订阅数：${snap.syncSubscriptions} 个（上限 3）`,
          `- Event Bus 死信率：${rate}%（死信 ${snap.deadletterCount} / 发布 ${snap.publishedCount}）`,
        ].join('\n'));
      },
    );

    // 消费端 3：注入故障（永远抛错）→ 用于验证 handler 异常隔离
    const unsubFaulty = subscribe(
      {
        subscriber: 's12-08-faulty',
        topics: ['dream.completed'],
        mode: 'async',
        timeoutMs: 5000,
        retry: { maxAttempts: 1, backoffMs: 50 },
      },
      () => { throw new Error('injected handler failure (s12-08)'); },
    );

    // 真 dream apply + sweep（会 publish A8 dream.completed）
    const dreamMod = await import(pluginUrl('plugins/agint-dream/lib/index.js'));
    dreamMod.apply(ctx, { root: diary, sessionsRoot: sessions });
    await settle();

    const dream = ctx.get('agint.dream');
    if (!dream || typeof dream.sweep !== 'function') throw new Error('missing agint.dream.sweep');
    await dream.sweep({ apply: false });
    await settle(120);

    // ── 断言①：at-least-once 投递 —— 两个正常订阅者都收到同一 envelope ──
    const inspect = ctx.get('agint.eventBus.inspect');
    const dreamEvents = inspect({ topic: 'dream.completed' });
    if (dreamEvents.length < 1) throw new Error('s12-08 ①: 未捕获 dream.completed envelope');
    if (metricsSeen.length < 1) throw new Error('s12-08 ①: metrics 订阅者未收到');
    const dreamId = dreamEvents[0].id;
    if (metricsSeen[0].id !== dreamId) {
      throw new Error('s12-08 ①: 订阅者收到的 envelope 与 inspect 记录不一致');
    }
    const delivered = dreamEvents[0].deliveries ?? {};
    if (delivered['agint-metrics'] !== 'DELIVERED' || delivered['agint-quality-report'] !== 'DELIVERED') {
      throw new Error(`s12-08 ①: 两个正常订阅者必须都 DELIVERED（实际 ${JSON.stringify(delivered)}）`);
    }

    // ── 断言②：handler 异常隔离 —— 故障订阅者死信，正常订阅者不受影响 ──
    if (delivered['s12-08-faulty'] !== 'DEAD_LETTERED') {
      throw new Error(`s12-08 ②: 故障订阅者应 DEAD_LETTERED（实际 ${delivered['s12-08-faulty']}）`);
    }
    if (delivered['agint-metrics'] !== 'DELIVERED') {
      throw new Error('s12-08 ②: 故障 handler 污染了其他订阅者（隔离失败）');
    }
    if (metricsSeen.length !== 1) {
      throw new Error(`s12-08 ②: 正常订阅者被重复/漏投（seen=${metricsSeen.length}）`);
    }

    unsubMetrics(); unsubReport(); unsubFaulty();

    // ── 断言③：周复盘模板两行落 wiki ──
    const pages = [...wikiPages.values()];
    const withRows = pages.filter((c) => c && c.includes('Event Bus sync 订阅数') && c.includes('Event Bus 死信率'));
    if (withRows.length < 1) {
      throw new Error(`s12-08 ③: wiki 未写入复盘模板两行（pages=${wikiPages.size}）`);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// s12-09 — sync 配额硬拒 + 死信 + deadletterRate 导出
// ─────────────────────────────────────────────────────────────────────────────
async function runS12_09() {
  const ctx = makeMockCtx();
  const busMod = await freshBus();

  ctx.provide('agint.cron', { health: () => ({ healthy: true, issues: [], jobs: [] }) });
  ctx.provide('agint.rules', { audit: () => ({ rules: [], totals: { hits: 0, denies: 0, asks: 0, advisories: 0 } }), lint: async () => [] });
  ctx.provide('agint.wiki', { stats: async () => ({ brokenLinks: 0, contradictions: 0, orphans: 0 }) });
  ctx.provide('agint.memory', { stats: async () => ({ total: 0, avgConfidence: 0 }), read: async () => null, write: async (r) => ({ id: 'm', ...r }) });

  const ebIndex = await import(pluginUrl('plugins/agint-event-bus/lib/index.js'));
  ebIndex.apply(ctx, {});
  await settle();

  const metricsMod = await import(pluginUrl('plugins/agint-metrics/lib/index.js'));
  metricsMod.apply(ctx, {});
  await settle();

  const subscribe = ctx.get('agint.eventBus.subscribe');
  if (typeof subscribe !== 'function') throw new Error('missing agint.eventBus.subscribe');

  // ── 断言①：sync 配额硬拒 —— 前 3 个 sync 通过，第 4 个抛错 ──
  const syncUnsubs = [];
  for (let i = 1; i <= 3; i += 1) {
    syncUnsubs.push(subscribe({
      subscriber: `s12-09-sync-${i}`,
      topics: ['evolution.evaluated'],
      mode: 'sync',
      reason: `门禁边压测 #${i}：验证 sync 全局配额上限（Sprint 13 §3.1 s12-09）`,
      timeoutMs: 2000,
    }, () => undefined));
  }
  const inspectSummary = ctx.get('agint.eventBus.inspectSummary');
  const quotaBefore = inspectSummary({}).syncSubscriptionCount;

  let rejected = null;
  try {
    subscribe({
      subscriber: 's12-09-sync-4',
      topics: ['evolution.evaluated'],
      mode: 'sync',
      reason: '第 4 个 sync：应被硬拒',
      timeoutMs: 2000,
    }, () => undefined);
  } catch (err) { rejected = err; }
  if (!rejected) throw new Error('s12-09 ①: 第 4 个 sync 订阅未被硬拒');
  if (!/上限|limit/i.test(rejected.message)) {
    throw new Error(`s12-09 ①: 拒绝原因应提示配额上限（实际 "${rejected.message}"）`);
  }
  if (quotaBefore !== 3) throw new Error(`s12-09 ①: syncSubscriptionCount 应为 3（实际 ${quotaBefore}）`);

  // async 劝导路径：sync 被拒后 async 订阅仍可用（不阻断）
  let asyncAccepted = true;
  try {
    subscribe({ subscriber: 's12-09-async-ok', topics: ['evolution.evaluated'], mode: 'async', timeoutMs: 2000 }, () => undefined);
  } catch { asyncAccepted = false; }
  if (!asyncAccepted) throw new Error('s12-09 ①: sync 触顶后 async 订阅不应被阻断');

  // ── 断言②：注入死信 —— handler 恒抛 → 进 DLQ 且可查询 ──
  subscribe(
    {
      subscriber: 's12-09-dead',
      topics: ['dl.probe'],
      mode: 'async',
      timeoutMs: 2000,
      retry: { maxAttempts: 1, backoffMs: 50 },
    },
    () => { throw new Error('injected dead-letter failure (s12-09)'); },
  );

  const publish = ctx.get('agint.eventBus.publish');
  if (typeof publish !== 'function') throw new Error('missing agint.eventBus.publish');
  const pr = await publish({ topic: 'dl.probe', version: 1, source: 's12-e2e', payload: { probe: true } });
  if (!pr.accepted) throw new Error('s12-09 ②: publish 未被接受');
  if (!pr.deadLettered.includes('s12-09-dead')) {
    throw new Error(`s12-09 ②: 故障订阅者应落死信（deadLettered=${JSON.stringify(pr.deadLettered)}）`);
  }
  await settle(60);

  const dlSvc = ctx.get('agint.eventBus.deadletters');
  if (typeof dlSvc !== 'function') throw new Error('s12-09 ②: 缺少 agint.eventBus.deadletters 服务');
  const dlList = await dlSvc();
  if (!Array.isArray(dlList) || dlList.length < 1) throw new Error('s12-09 ②: DLQ 为空，死信不可查询');
  const dlEntry = dlList.find((d) => d.subscriber === 's12-09-dead');
  if (!dlEntry) throw new Error('s12-09 ②: DLQ 中找不到 s12-09-dead 条目');
  if (dlEntry.envelope?.topic !== 'dl.probe') throw new Error('s12-09 ②: DLQ 条目 envelope 不正确');
  if (typeof dlEntry.reason !== 'string' || dlEntry.reason.length === 0) {
    throw new Error('s12-09 ②: DLQ 条目缺少失败原因');
  }

  // ── 断言③：deadletterRate 计算正确（分子/分母都来自 metricsSnapshot）──
  const snapSvc = ctx.get('agint.eventBus.metricsSnapshot');
  const snap = await snapSvc();
  if (typeof snap.publishedCount !== 'number' || snap.publishedCount < 1) {
    throw new Error(`s12-09 ③: publishedCount 分母缺失（snap=${JSON.stringify(snap)}）`);
  }
  if (snap.deadletterCount < 1) throw new Error('s12-09 ③: deadletterCount 分子缺失');

  const metrics = ctx.get('agint.metrics');
  await metrics.collect();
  const summary = await metrics.summary();
  const rateRec = (summary.metrics ?? []).find((m) => m.key === 'eventBus.deadletterRate');
  if (!rateRec) throw new Error('s12-09 ③: metrics 未导出 eventBus.deadletterRate');
  const expected = Number(((snap.deadletterCount / snap.publishedCount) * 100).toFixed(3));
  if (!Number.isFinite(rateRec.value)) throw new Error('s12-09 ③: deadletterRate 非有限数');
  if (Math.abs(rateRec.value - expected) > 0.01) {
    throw new Error(`s12-09 ③: deadletterRate 计算错误（实际 ${rateRec.value}，期望 ${expected}）`);
  }
  if (rateRec.value <= 0 || rateRec.value > 100) {
    throw new Error(`s12-09 ③: deadletterRate 应落在 (0,100]（实际 ${rateRec.value}）`);
  }

  for (const u of syncUnsubs) { try { u(); } catch { /* ignore */ } }
}

async function main() {
  console.log('Sprint 12/13 event-bus e2e（T1 影子期）');
  await step('A6 diagnosis.completed publish + mutator subscribe', runA6);
  await step('A7 metrics.snapshot publish', runA7);
  await step('s12-07 A7 全链路：traceId 一致 + payload 冻结 + metrics 导出', runS12_07);
  await step('s12-08 A8 全链路：at-least-once + 异常隔离 + 复盘两行', runS12_08);
  await step('s12-09 sync 配额硬拒 + 死信可查询 + deadletterRate', runS12_09);
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
