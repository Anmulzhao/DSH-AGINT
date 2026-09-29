/**
 * agint-metrics: 工具 output schema ↔ service 返回值的契约测试（2026-09-29）。
 *
 * 背景：2026-09-28 给 service.summary() 补了 meta 透传（神谕层派生依赖它），
 * 但 tools.js 里 metrics_summary 的 output schema 没同步声明 meta，而
 * additionalProperties:false ⇒ 宿主拿 schema 校验返回值时**整条工具调用失败**
 * （agint 侧表现为 "tool metrics_summary schema validation error"）。
 *
 * 为什么既有门禁没抓到：
 *   - bin/check-tool-schemas.mjs 只验证 schema 字面量能否编译，不验证返回值能否装进去；
 *   - service-summary.test.js 只钉 service 侧，不钉工具侧。
 * 两侧单测各自全绿、接缝处断裂——本文件把这道接缝钉死：真调 apply() 拿到注册
 * 的工具定义，真调 summary() 拿到真实返回，交叉断言字段集合。
 *
 * 跑法：`node --test "plugins/agint-metrics/test/*.test.js"`（仓库统一）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMetricsService } from '../lib/service.js';
import { computeMetrics, describeMetric } from '../lib/metrics.js';
import { apply as applyTools } from '../lib/tools.js';

function memTable() {
  const m = new Map();
  return {
    async put(k, v) { m.set(k, v); },
    async get(k) { return m.get(k); },
    entries() { return m.entries(); },
    get size() { return m.size; },
  };
}

function fakeSources() {
  const entries = [
    { id: 'm1', confidence: 0.8, evidence: 'src://a' },
    { id: 'm2', confidence: 0.6, evidence: '' },
  ];
  return {
    'agint.cron': { health: () => ({ issues: [], jobs: [] }) },
    'agint.rules': {
      audit: () => ({ totals: { hits: 0, denies: 0, asks: 0, advisories: 0 } }),
      lint: async () => [{ ruleId: 'r1', kind: 'duplicate-pattern', with: 'r2' }],
      list: async () => [{ id: 'r1' }, { id: 'r2' }],
    },
    'agint.wiki': {
      lint: async () => ({ brokenLinks: [], contradictions: [], orphans: [], checked: 18 }),
    },
    'agint.memory': {
      stats: async () => ({ total: 2, avgConfidence: 0.7, byType: { lesson: 2 } }),
      list: async () => entries,
    },
    'agint.eventBus.metricsSnapshot': async () => ({ syncSubscriptions: 1, deadletterCount: 0, publishedCount: 5 }),
  };
}

/** 真调 apply()：捕获 tools.register 收到的工具定义（按 name 索引）。 */
function captureTools(metricsService) {
  const registered = new Map();
  const ctx = {
    tools: { register: (t) => registered.set(t.name, t) },
    'agint.metrics': metricsService,
  };
  applyTools(ctx);
  return registered;
}

test('metrics_summary 的 output schema 必须容纳 summary() 的真实返回值', async () => {
  const t = memTable();
  const svc = buildMetricsService({ ctx: { get: (k) => fakeSources()[k] }, table: async () => t, computeMetrics, describeMetric });
  await svc.collect();
  const summary = await svc.summary();
  assert.ok(summary.metrics.length > 0, 'summary 应有指标（否则本断言形同虚设）');

  const tools = captureTools(svc);
  const tool = tools.get('metrics_summary');
  assert.ok(tool, 'metrics_summary 应被注册');

  const schema = tool.output?.schema;
  assert.ok(schema, 'metrics_summary 应声明 output.schema');

  // 1) 顶层字段全部在册
  for (const k of Object.keys(summary)) {
    assert.ok(
      Object.hasOwn(schema.properties ?? {}, k),
      `output.schema.properties 缺少顶层字段 "${k}"（additionalProperties:false ⇒ 宿主会整条拒收）`,
    );
  }

  // 2) 每条 metric 的字段全部在 items.properties 在册
  const itemProps = schema.properties.metrics?.items?.properties ?? {};
  for (const m of summary.metrics) {
    for (const k of Object.keys(m)) {
      assert.ok(
        Object.hasOwn(itemProps, k),
        `metrics[].items.properties 缺少 "${m.key}.${k}"（这正是 2026-09-28 meta 透传后宿主报 schema validation error 的根因）`,
      );
    }
  }

  // 3) meta 显式在册且为 string（与 series() 口径一致）
  assert.equal(itemProps.meta?.type, 'string', 'meta 必须声明为 string');
});

test('metrics_series 的 output schema 同样容纳 series() 的真实返回值', async () => {
  const t = memTable();
  const svc = buildMetricsService({ ctx: { get: (k) => fakeSources()[k] }, table: async () => t, computeMetrics, describeMetric });
  await svc.collect();
  const se = await svc.series('memory.total');
  assert.ok(se.points.length > 0, 'series 应有点位');

  const tool = captureTools(svc).get('metrics_series');
  assert.ok(tool, 'metrics_series 应被注册');
  const schema = tool.output?.schema;
  for (const k of Object.keys(se)) {
    assert.ok(Object.hasOwn(schema.properties ?? {}, k), `metrics_series 顶层缺 "${k}"`);
  }
  const pointProps = schema.properties.points?.items?.properties ?? {};
  for (const p of se.points) {
    for (const k of Object.keys(p)) {
      assert.ok(Object.hasOwn(pointProps, k), `metrics_series points[] 缺 "${k}"`);
    }
  }
});
