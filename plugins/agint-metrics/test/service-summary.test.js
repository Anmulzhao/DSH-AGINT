/**
 * agint-metrics: summary() meta 透传回归测试（2026-09-28）。
 *
 * 背景：summary() 曾只返回 {key,label,value,unit,ts,delta} 丢掉 meta，而神谕层
 * （agint-aesthetic-oracle）的 noise/confidence/redundancy 派生全靠 meta
 * （memory.total.meta.noEvidence / rules.lintIssues.meta.rulesTotal /
 * wiki.orphans.meta.total / avgConfXCompliance / skills.totalBytes.meta.fileCount）。
 * 消费侧拿不到 meta → 全 null → 权重归一后美总分虚标 100（2026-09-28 晨报事故，
 * 同日标定值应为 52.4）。两侧单测各自全绿、接缝处静默断裂——本文件把接缝钉死：
 * 用真实 service（内存表 + 假源）走 collect → summary，断言 meta 落地。
 *
 * 跑法：`node --test`（仓库统一）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMetricsService } from '../lib/service.js';
import { computeMetrics, describeMetric } from '../lib/metrics.js';

/** 内存表：与 dsh 存储域同形（put/get/entries）。 */
function memTable() {
  const m = new Map();
  return {
    async put(k, v) { m.set(k, v); },
    async get(k) { return m.get(k); },
    entries() { return m.entries(); },
    get size() { return m.size; },
  };
}

/** 假源：wiki 带全量页数（checked）；memory 带 evidence 分布；rules 带全量数。 */
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
    // skills 文件系统 source 由 service 内部 makeSkillsFsSource() 造——宿主环境
    // 可能无 skills 根 → 该 key 缺席，不参与 meta 断言（AC 语义：缺 source 跳过）。
  };
}

const ctx = {
  get: (k) => fakeSources()[k],
};

test('summary() 必须透传 meta（神谕层派生数据合同，2026-09-28 回归钉）', async () => {
  const t = memTable();
  const svc = buildMetricsService({ ctx, table: async () => t, computeMetrics, describeMetric });
  const c = await svc.collect();
  assert.ok(c.count > 0, 'collect 应产出记录');

  const s = await svc.summary();
  const byKey = new Map(s.metrics.map((m) => [m.key, m]));

  // 1) 每项都带 meta 字段（字符串形态，与 series() 口径一致）
  for (const m of s.metrics) {
    assert.equal(typeof m.meta, 'string', `${m.key}.meta 应为字符串`);
  }

  // 2) 神谕层派生所需的四类 meta 全部可解析、含值
  const memMeta = JSON.parse(byKey.get('memory.total').meta);
  assert.equal(memMeta.noEvidence.count, 1, 'memory 无证据计数（m2 evidence 为空）');
  assert.ok(memMeta.avgConfXCompliance > 0, 'avgConfXCompliance 应为正数');

  const rulesMeta = JSON.parse(byKey.get('rules.lintIssues').meta);
  assert.equal(rulesMeta.rulesTotal, 2, 'rulesTotal = 规则全量数');
  assert.equal(rulesMeta.issues.length, 1);

  const wikiMeta = JSON.parse(byKey.get('wiki.orphans').meta);
  assert.equal(wikiMeta.total, 18, 'wiki 全量页数（lint().checked）');

  // 3) value 不受影响（既有断言语义：meta 增补不碰 value）
  assert.equal(byKey.get('memory.total').value, 2);
  assert.equal(byKey.get('rules.lintIssues').value, 1);
  assert.equal(byKey.get('wiki.orphans').value, 0);
});

test('series() 与 summary() 的 meta 口径一致（同 key 同轮）', async () => {
  const t = memTable();
  const svc = buildMetricsService({ ctx, table: async () => t, computeMetrics, describeMetric });
  await svc.collect();
  const s = await svc.summary();
  const se = await svc.series('memory.total');
  const sm = JSON.parse(s.metrics.find((m) => m.key === 'memory.total').meta);
  const sem = JSON.parse(se.points.at(-1).meta);
  assert.deepEqual(sem, sm, 'summary 与 series 的 meta 应逐字节同源');
});
