/**
 * test/diagnosis-loop-guard.test.mjs — 诊断自激环熔断（2026-09-26）
 *
 * 现场现象：`agint-mutator` 持续输出
 *   `[agint-mutator.observe] diagnosis.completed reportId=... observationCount=21681`
 * 观测行、计数无上限增长。溯源发现这是一条闭合的正反馈环：
 *
 *   diagnosis.report() --publish--> diagnosis.completed
 *        ^                                    |
 *        |                                    v
 *   recomputeObservation() <-- selfUpdate() <-- agint-self-model 的 A6 订阅
 *
 * `selfUpdate` 内部有**两处**会回调 `diagnosis.report()`：
 *   1) `aggregateCapabilityEvidence()`（lib/index.js，算非环境根因占比）
 *   2) `recomputeObservation()`（lib/observation.js，算推理画像）
 * ⇒ 只堵一处仍会转。故本测试的核心断言是「report 调用次数 === 0」
 *   —— 任一未堵上，计数都会 ≥1。
 *
 * 熔断判据取**来源**（trigger），不取「是否带载荷」：载荷缺失时同样熔断，
 * 否则一条畸形事件就能让环重新闭合。
 *
 * 覆盖：
 *   1. A6 事件驱动的刷新不再回调 diagnosis.report()（0 次）
 *   2. 根因分布改由事件载荷提供（不丢数据 —— 熔断不等于功能退化）
 *   3. 载荷缺失 / 畸形 envelope 时仍熔断
 *   4. 非诊断来源不受影响：dream.completed 照常回调
 *   5. 显式 update() 主路径不受影响
 *   6. 风暴模拟：连喂 20 条仍 0 次回调（环确已断开）
 *   7. 观测出口：stats().diagnosisLoopGuard
 *   8. 可回滚：diagnosis_loop_guard=false 恢复旧行为
 *   9. handler 永不抛（影子纪律）
 *
 * 跑法（cwd = 仓库根）：
 *   node test/diagnosis-loop-guard.test.mjs
 * 退出码: 0 全过, 1 任一 fail.
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const AGINT_ROOT = process.cwd();
const url = (rel) => pathToFileURL(resolve(AGINT_ROOT, rel)).href;

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log('✓', name); }
  else { fail += 1; console.log('✗', name, extra); }
}

const selfModel = await import(url('plugins/agint-self-model/lib/index.js'));

function mockCtx(services = {}) {
  const provided = new Map(Object.entries(services));
  return {
    get: (k) => provided.get(k) ?? null,
    provide: (k, v) => provided.set(k, v),
    effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {}; } catch { return () => {}; } },
    storageDomain: { open: () => { throw new Error('test: no real storage'); } },
    on: () => () => {},
  };
}

const DIST = {
  REASONING_ERROR: 0, PLANNING_FAILURE: 0, PROMPT_DEFICIENCY: 0,
  TOOL_GAP: 0, KNOWLEDGE_GAP: 0, ENVIRONMENT_SHIFT: 0, UNCERTAIN: 0,
};

/**
 * 装配一个可观测的 harness。核心观测量 = `reportCalls.length`
 * （即 diagnosis.report() 被调用了几次）。
 */
function buildHarness(config = {}) {
  const reportCalls = [];
  const subscriptions = [];
  const published = [];
  const services = {
    'agint.eventBus.publish': async (e) => { published.push(e); return { accepted: true }; },
    'agint.eventBus.subscribe': (sub, handler) => { subscriptions.push({ sub, handler }); return () => {}; },
    'agint.evolution': {
      queryFailures: async () => [], queryTemplates: async () => [],
      addFailure: async () => ({}), getLogRange: async () => [], stats: async () => ({}),
    },
    'agint.diagnosis': {
      report: async (input) => {
        reportCalls.push(input ?? {});
        return { rootCauseDistribution: { ...DIST, REASONING_ERROR: 1 } };
      },
    },
    'agint.metrics': {
      snapshot: async () => ({ metrics: [] }), collect: async () => ({}),
      summary: async () => ({ asOf: 'now', count: 0, metrics: [] }),
    },
    'agint.toolStats': { summary: async () => ({ summary: [] }) },
  };
  const ctx = mockCtx(services);
  selfModel.apply(ctx, config);
  const handlerFor = (topic) => subscriptions.find((s) => (s.sub?.topics ?? []).includes(topic));
  return { ctx, reportCalls, subscriptions, published, handlerFor };
}

/** 造一条 diagnosis.completed envelope；distribution 省略时表示载荷缺该字段。 */
const diagEvent = (distribution) => ({
  topic: 'diagnosis.completed', version: 1, source: 'agint-diagnosis',
  payload: {
    reportId: 'r-fixed-1',
    clusterCount: 0,
    ...(distribution ? { rootCauseDistribution: distribution } : {}),
  },
});

// ── 1. 核心：熔断生效（0 次回调）──────────────────────────────────────────
{
  const h = buildHarness();
  const a6 = h.handlerFor('diagnosis.completed');
  ok('A6 diagnosis.completed 订阅存在', !!a6);
  ok('A6 订阅为 async', a6?.sub?.mode === 'async');

  await a6.handler(diagEvent({ TOOL_GAP: 3 }));
  // 这条断言同时证明「两处」调用路径都被堵上：任一未堵，calls 都会 ≥1。
  ok('【熔断】A6 事件驱动的刷新不回调 diagnosis.report()',
    h.reportCalls.length === 0, `calls=${h.reportCalls.length}`);
}

// ── 2. 熔断不等于功能退化：分布改由事件载荷提供 ──────────────────────────
{
  const h = buildHarness();
  await h.handlerFor('diagnosis.completed').handler(diagEvent({ TOOL_GAP: 3, KNOWLEDGE_GAP: 2 }));
  const snap = await h.ctx.get('agint.selfModel.snapshot')();
  const keys = snap.reasoningProfile.map((r) => r.key);
  ok('根因分布取自事件载荷（未丢数据）',
    keys.includes('TOOL_GAP') && keys.includes('KNOWLEDGE_GAP'), JSON.stringify(keys));
  const toolGap = snap.reasoningProfile.find((r) => r.key === 'TOOL_GAP');
  ok('分布计数原样落到推理画像', toolGap?.count === 3, JSON.stringify(toolGap));
}

// ── 3. 判据是「来源」不是「载荷」：畸形事件同样熔断 ──────────────────────
{
  const h = buildHarness();
  const a6 = h.handlerFor('diagnosis.completed');
  await a6.handler({ topic: 'diagnosis.completed', payload: {} });          // 无分布字段
  await a6.handler({ topic: 'diagnosis.completed' });                       // 无 payload
  await a6.handler(diagEvent('not-an-object'));                             // 载荷类型错
  await a6.handler(null);                                                   // 畸形 envelope
  ok('【判据是来源】载荷缺失/畸形时仍 0 次回调',
    h.reportCalls.length === 0, `calls=${h.reportCalls.length}`);
}

// ── 4. 非诊断来源不受影响（第一跳仍正常）──────────────────────────────────
{
  const h = buildHarness();
  await h.handlerFor('dream.completed').handler({ topic: 'dream.completed', payload: {} });
  ok('dream.completed 来源照常回调 report()',
    h.reportCalls.length >= 1, `calls=${h.reportCalls.length}`);
}

// ── 5. 显式 update() 主路径不受影响 ──────────────────────────────────────
{
  const h = buildHarness();
  await h.ctx.get('agint.selfModel.update')({ trigger: 'weekly' });
  ok('显式 update(trigger=weekly) 照常回调 report()',
    h.reportCalls.length >= 1, `calls=${h.reportCalls.length}`);
}

// ── 6. 风暴模拟：环确已断开 ──────────────────────────────────────────────
{
  const h = buildHarness();
  const a6 = h.handlerFor('diagnosis.completed');
  for (let i = 0; i < 20; i += 1) await a6.handler(diagEvent({ TOOL_GAP: i + 1 }));
  ok('【断环】连喂 20 条 diagnosis.completed 仍 0 次回调',
    h.reportCalls.length === 0, `calls=${h.reportCalls.length}`);
  ok('A11 self.model.updated 仍照常发布（刷新本身没被跳过）',
    h.published.some((e) => e?.topic === 'self.model.updated'),
    JSON.stringify(h.published.map((e) => e?.topic)));

  const stats = await h.ctx.get('agint.selfModel.stats')();
  ok('观测出口暴露熔断开关与计数',
    !!stats.diagnosisLoopGuard && stats.diagnosisLoopGuard.enabled === true,
    JSON.stringify(stats.diagnosisLoopGuard));
  ok('熔断计数随事件累积（每次刷新记一次，不翻倍）',
    stats.diagnosisLoopGuard.trips === 20, JSON.stringify(stats.diagnosisLoopGuard));

  const inspect = await h.ctx.get('agint.selfModel.inspectSummary')();
  ok('inspectSummary 同样暴露熔断计数',
    inspect.diagnosisLoopGuard?.trips === 20, JSON.stringify(inspect.diagnosisLoopGuard));
}

// ── 7. 可回滚：guard=false 恢复旧行为 ────────────────────────────────────
{
  const h = buildHarness({ diagnosis_loop_guard: false });
  await h.handlerFor('diagnosis.completed').handler(diagEvent({ TOOL_GAP: 1 }));
  ok('【可回滚】guard=false 时恢复旧行为（照常回调 report）',
    h.reportCalls.length >= 1, `calls=${h.reportCalls.length}`);
  const stats = await h.ctx.get('agint.selfModel.stats')();
  ok('guard=false 时 enabled 可见为 false',
    stats.diagnosisLoopGuard?.enabled === false, JSON.stringify(stats.diagnosisLoopGuard));
  ok('guard=false 时不计熔断次数',
    stats.diagnosisLoopGuard?.trips === 0, JSON.stringify(stats.diagnosisLoopGuard));
}

// ── 8. 影子纪律：handler 永不抛 ──────────────────────────────────────────
{
  const h = buildHarness();
  const a6 = h.handlerFor('diagnosis.completed');
  let threw = false;
  try {
    await a6.handler(null);
    await a6.handler({});
    await a6.handler({ payload: { rootCauseDistribution: null } });
    await a6.handler({ payload: { rootCauseDistribution: [] } });
  } catch { threw = true; }
  ok('handler 喂垃圾 payload 永不抛', threw === false);
}

// ── 9. 端到端闭环：复刻生产链路，验证调用次数收敛 ────────────────────────
//
// 前面几条是单元级的（只喂 handler）。这条把链路接全：
//   真 diagnosis.report()（会 publish）→ 真 eventBus 分发 → 真 A6 handler
// 起点用显式 update()（模拟 weekly / 工具调用），看总调用次数是否收敛。
// 这才是「环有没有断开」的直接证据。
{
  function buildClosedLoop(config = {}, maxDepth = 100) {
    const reportCalls = [];
    const subscriptions = [];
    const services = {
      'agint.eventBus.subscribe': (sub, handler) => { subscriptions.push({ sub, handler }); return () => {}; },
      'agint.evolution': {
        queryFailures: async () => [], queryTemplates: async () => [],
        addFailure: async () => ({}), getLogRange: async () => [], stats: async () => ({}),
      },
      'agint.metrics': { snapshot: async () => ({ metrics: [] }), collect: async () => ({}), summary: async () => ({ asOf: 'now', count: 0, metrics: [] }) },
      'agint.toolStats': { summary: async () => ({ summary: [] }) },
    };
    let depth = 0;
    // 真 publish：把事件同步分发给匹配的订阅者（忠实复刻 bus 的投递语义）
    services['agint.eventBus.publish'] = async (env) => {
      depth += 1;
      if (depth > maxDepth) throw new Error(`test: publish 深度超限 ${maxDepth}（环未断开）`);
      for (const s of subscriptions) {
        if ((s.sub?.topics ?? []).includes(env.topic)) await s.handler(env);
      }
      return { accepted: true, envelopeId: `e${depth}`, deliveredTo: subscriptions.length };
    };
    // 真 diagnosis：report() 末尾会 publish diagnosis.completed（复刻生产行为）
    services['agint.diagnosis'] = {
      report: async () => {
        reportCalls.push(1);
        await services['agint.eventBus.publish']({
          topic: 'diagnosis.completed', version: 1, source: 'agint-diagnosis',
          payload: { reportId: 'r-loop-1', clusterCount: 0, rootCauseDistribution: { TOOL_GAP: 1 } },
        });
        return { rootCauseDistribution: { ...DIST, TOOL_GAP: 1 } };
      },
    };
    const ctx = mockCtx(services);
    selfModel.apply(ctx, config);
    return { ctx, reportCalls, depth: () => depth };
  }

  // 熔断开（默认）：显式 update 只应产生 1 次 report —— 事件回流后被熔断拦住
  const guarded = buildClosedLoop();
  let guardedThrew = null;
  try { await guarded.ctx.get('agint.selfModel.update')({ trigger: 'weekly' }); }
  catch (e) { guardedThrew = e; }
  ok('【端到端】闭环链路跑完不抛错', guardedThrew === null, String(guardedThrew?.message));
  // 基线值是 2 而非 1：selfUpdate 内两处调用点各发一次 diagnosis.completed
  // （aggregateCapabilityEvidence 用 windowDays:7，recomputeObservation 用
  // windowDays:28 —— 两个不同口径，不是重复调用，不能合并）。
  // 关键不在「恰好几次」，而在**有界**：回流事件不再引发新的 report。
  ok('【端到端】report 调用次数收敛（回流事件不再引发新 report）',
    guarded.reportCalls.length === 2, `calls=${guarded.reportCalls.length} depth=${guarded.depth()}`);
  ok('【端到端】调用次数有界：不随事件回流增长',
    guarded.reportCalls.length <= 2, `calls=${guarded.reportCalls.length}`);

  // 对照：关掉熔断 = 旧行为 = 同一条链路会一直转（撞深度上限这个安全阀）。
  // 注意 A6 handler 的 catch 会吞掉深层抛错，所以判据取**调用次数**而非抛错。
  // 这条的作用是证明「上面那条测试真的抓得住这个 bug」，而不是碰巧通过。
  const unguarded = buildClosedLoop({ diagnosis_loop_guard: false }, 40);
  try { await unguarded.ctx.get('agint.selfModel.update')({ trigger: 'weekly' }); }
  catch { /* A6 handler 会吞掉深度超限，这里兜底即可 */ }
  ok('【对照】guard=false 时 report 被反复调用（≥3 次即已失控）',
    unguarded.reportCalls.length > 2, `calls=${unguarded.reportCalls.length} depth=${unguarded.depth()}`);
  ok('【对照】未熔断时调用次数显著高于熔断路径（差量可量化）',
    unguarded.reportCalls.length > guarded.reportCalls.length,
    `unguarded=${unguarded.reportCalls.length} guarded=${guarded.reportCalls.length}`);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
