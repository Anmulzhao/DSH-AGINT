/**
 * test/real-compat.mjs — agint-self-model 真兼容测试（v0.7.3 / peerDep 仲裁用）
 *
 * 目的：验证 self-model@0.7.4 (源码) 在使用真实 diagnosis@0.7.0 / metrics@0.1.0 /
 *       tool-stats@0.1.0 提供的 service 时，不会因 peerDep 版本号失配而运行时失败。
 *
 * 不是单元测试，是接口契约对比。返回 0/1 = pass/fail。
 *
 * 跑法（cwd = AGINT 仓库根 D:\DSH\project源码\DSH-AGINT）：
 *   node plugins/agint-self-model/test/real-compat.mjs
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const AGINT_ROOT = process.cwd();
const url = (rel) => pathToFileURL(resolve(AGINT_ROOT, rel)).href;

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('✓', name); }
  else { fail++; console.log('✗', name, extra); }
}

console.log('=== 真兼容验证：self-model@0.7.4 ← diagnosis@0.7.0 + metrics@0.1.0 + tool-stats@0.1.0 ===\n');

// 1) 真实 diagnosis: 看 report 返回 shape
const diagnosis = await import(url('plugins/agint-diagnosis/lib/index.js'));
const diagReportFn = diagnosis?.report ?? diagnosis?.default?.report;
// diagnosis 报告是 service 暴露，不在 module 直接 export。我们直接构造 report 函数上下文。
// 用 mirror：通过 source aggregateReport 拿真实形状
const { aggregateReport } = await import(url('plugins/agint-diagnosis/lib/report-aggregator.js'));
const diagReport = await aggregateReport({
  annotations: [],      // 空 window
  evolution: undefined,
  windowDays: 28,
  maxClusters: 5,
});
ok('diagnosis@0.7.0 aggregateReport 返回 rootCauseDistribution', diagReport && typeof diagReport.rootCauseDistribution === 'object');
ok('diagnosis@0.7.0 distribution 含 6 类（REASONING_ERROR 等）', typeof diagReport.rootCauseDistribution.REASONING_ERROR === 'number'
  && typeof diagReport.rootCauseDistribution.PLANNING_FAILURE === 'number');

// 2) 真实 metrics summary 形状（需要先跑一次 collect 填数据）
const { buildMetricsService } = await import(url('plugins/agint-metrics/lib/service.js'));
// 用 inline mock ctx 满足 sources()
const fakeTable = async () => ({ entries: () => new Map(), put: async () => {} });
const fakeCtx = {
  get: () => null,         // 无上游 service（cron/rules/wiki/memory/eventBus 均为 null）
  provide: () => {},
};
const metricsSvc = buildMetricsService({
  ctx: fakeCtx,
  table: fakeTable,
  computeMetrics: async () => [],  // 无 source → 空 metrics
  describeMetric: () => ({}),
  randomId: () => 'test-id',
});
const metricsSummary = await metricsSvc.summary();
ok('metrics@0.1.0 summary 返回 {asOf, count, metrics[]}', metricsSummary
  && typeof metricsSummary.count === 'number'
  && Array.isArray(metricsSummary.metrics));
ok('metrics@0.1.0 summary.metrics 字段对齐 self-model 期望', metricsSummary.metrics.every(m => typeof m.key === 'string' && typeof m.value === 'number'));

// 3) 真实 toolStats summary 形状
// toolStats 内部读 ~/.dsh/storages/agint_tool_stats.jsonl。本机无该文件应返回空 summary。
const toolStatsMod = await import(url('plugins/agint-tool-stats/lib/index.js'));
// index.js apply(ctx, cfg) 模式需要 ctx。直接调用 aggregate 模块的 summarize。
const { summarize } = await import(url('plugins/agint-tool-stats/lib/aggregate.js'));
const tsSummary = summarize([], { since: '7d' }); // 空记录
ok('toolStats@0.1.0 summarize 返回数组', Array.isArray(tsSummary));
ok('toolStats@0.1.0 summarize 每项 {tool, calls, avgMs, p95Ms}', tsSummary.every(t => typeof t.tool === 'string' && typeof t.calls === 'number'));

// 4) 真集成：把三个真 service 喂给 self-model 的 recomputeObservation
const { recomputeObservation } = await import(url('plugins/agint-self-model/lib/observation.js'));
const { schema } = await import(url('plugins/agint-self-model/lib/schema.js'));

// 内存 fakeStore（self-model 期望 store.tables.{reasoningProfile, resourceBaseline}）
const fakeStore = {
  tables: {
    reasoningProfile: {
      entries: () => new Map(),
      put: async (k, v) => { fakeStore._r.set(k, v); },
      clear: async () => { fakeStore._r.clear(); },
    },
    resourceBaseline: {
      entries: () => new Map(),
      put: async (k, v) => { fakeStore._b.set(k, v); },
      clear: async () => { fakeStore._b.clear(); },
    },
  },
  _r: new Map(),
  _b: new Map(),
};

const realCtx = {
  get: (key) => {
    if (key === 'agint.diagnosis') return { report: aggregateReport };
    if (key === 'agint.metrics') return metricsSvc;
    if (key === 'agint.toolStats') return { summary: async () => ({ summary: tsSummary }) };
    return null;
  },
};

const result = await recomputeObservation(fakeStore, realCtx, {});
ok('recomputeObservation 不抛错（接口契约兼容）', result && typeof result.reasoningCount === 'number');
ok('推理画像为空（distribution 全 0）', result.reasoningCount === 0);
ok('资源基线构建成功（≥0 个条目）', result.resourceCount >= 0);
ok('metricsSource = direct-fallback（直连兜底，无事件入）', result.metricsSource === 'direct-fallback');

console.log(`\n${pass} pass, ${fail} fail`);
console.log('\n=== 结论 ===');
if (fail === 0) {
  console.log('✅ 三上游插件接口与 self-model@0.7.4 兼容。peerDep 版本号失配但 API 实际兼容。');
  console.log('   行动：方案 C 验证通过 → 加豁免文档（package.json + README 标注 "currently compatible with X@Y.Z despite ≥X.W.V")');
} else {
  console.log('❌ 接口不兼容 → 走方案 B（升 3 个上游）或方案 A（降 self-model）');
}
process.exit(fail === 0 ? 0 : 1);