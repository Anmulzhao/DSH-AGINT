/**
 * agint-metrics: pure metric computation (no I/O, no service access).
 *
 * One record per metric key. Sources are plain service objects (or undefined
 * when the host service is unavailable); every computation is defensive so a
 * missing/unhealthy source skips its metrics instead of failing the run.
 *
 * The PLAN's 7 metrics map as follows (everything computable today):
 *   盲区天数           → cron.staleJobs + cron.maxOverdueDays
 *   门禁遵守率         → rules.hits / rules.blocked / rules.adherencePct
 *   记忆矛盾数         → wiki.contradictions (memory-lint 尚未实现，见报告)
 *   谄媚率             → 未采集（需 session 日志抽样，evolve 报告标注 future work）
 *   失效引用数         → wiki.brokenLinks
 *   任务步数中位数     → 未采集（需 session 日志统计，同上）
 *   规则冗余度         → rules.lintIssues
 * Plus memory scale/health (memory.total / memory.avgConfidence).
 *
 * 2026-09-27 美的神谕层 Day 0（方案 C）：新增 4 个原子 key，计算块在
 * metrics-ext.js（本文件保持行数纪律）；同时给三个既有 key 的 meta 增补
 * 派生所需的原子事实（**value 一律不动**，summary 值与扩展前逐项 diff=0）：
 *   rules.lintIssues.meta.rulesTotal  — 规则全量数（rules.list()，冗余度分母）
 *   wiki.orphans.meta.total           — wiki 全量页数（lint().checked，噪声分母）
 *   memory.total.meta                 — 无证据 id 清单（cap 50）+ Σ(conf×compliance)/N
 *                                       （神谕层 Q3 证据清单与决策确信度分子）
 * 复合派生（noise_ratio / aesthetic_score）永远不进本插件——§9.4。
 */

import { METRIC_DEFS_EXT, computeMetricsExt, describeMetricExt, NO_EVIDENCE_IDS_CAP } from './metrics-ext.js';

export const METRIC_DEFS_BASE = [
  { key: 'cron.staleJobs', label: '定时任务失效数（盲区）', unit: 'count', source: 'cron' },
  { key: 'cron.maxOverdueDays', label: '最大任务逾期天数', unit: 'days', source: 'cron' },
  { key: 'rules.hits', label: '门禁命中总数', unit: 'count', source: 'rules' },
  { key: 'rules.blocked', label: '门禁阻断/询问数', unit: 'count', source: 'rules' },
  { key: 'rules.adherencePct', label: '门禁遵守率', unit: 'pct', source: 'rules' },
  { key: 'rules.lintIssues', label: '规则冗余/失效数', unit: 'count', source: 'rules' },
  { key: 'wiki.brokenLinks', label: 'Wiki 失效引用（断链）', unit: 'count', source: 'wiki' },
  { key: 'wiki.contradictions', label: 'Wiki 矛盾标记数', unit: 'count', source: 'wiki' },
  { key: 'wiki.orphans', label: 'Wiki 孤岛条目数', unit: 'count', source: 'wiki' },
  { key: 'memory.total', label: '记忆条目总数', unit: 'count', source: 'memory' },
  { key: 'memory.avgConfidence', label: '记忆平均置信度', unit: '', source: 'memory' },
  { key: 'eventBus.syncSubscriptions', label: 'Event Bus sync 订阅数', unit: 'count', source: 'eventBus' },
  { key: 'eventBus.deadletterRate', label: 'Event Bus 死信率', unit: '', source: 'eventBus' },
];

/** 对外完整定义表 = 基础 13 + Day 0 扩展 4。 */
export const METRIC_DEFS = [...METRIC_DEFS_BASE, ...METRIC_DEFS_EXT];

/** Metrics the PLAN lists but that need session-log mining (future work). */
export const UNCOLLECTED = [
  { key: 'flattery.rate', label: '谄媚率（session 日志抽样）', reason: '需 session 日志语言特征抽样，留待 evolve Phase 1 扩展' },
  { key: 'tasks.stepsMedian', label: '任务步数中位数', reason: '需 session 日志工具调用统计，留待 evolve Phase 1 扩展' },
];

const round = (n, d = 0) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

/**
 * Compute metric records from live source snapshots.
 * @param {{cron?: object, rules?: object, wiki?: object, memory?: object}} sources
 * @returns {Promise<Array<{key: string, label: string, value: number, unit: string, meta: string}>>}
 */
export async function computeMetrics(sources) {
  const out = [];
  const defs = new Map(METRIC_DEFS.map((d) => [d.key, d]));

  const push = (key, value, meta = {}) => {
    const def = defs.get(key);
    if (!def || value === null || value === undefined || Number.isNaN(value)) return;
    out.push({
      key,
      label: def.label,
      value,
      unit: def.unit,
      meta: JSON.stringify(meta),
    });
  };

  // ---- cron: blind spots ----
  const cron = sources?.cron;
  if (cron && typeof cron.health === 'function') {
    try {
      const health = cron.health();
      const stale = Array.isArray(health.issues) ? health.issues.length : 0;
      push('cron.staleJobs', stale, { issues: health.issues ?? [] });
      const jobs = Array.isArray(health.jobs) ? health.jobs : [];
      const maxOverdueMs = jobs.reduce((m, j) => Math.max(m, j?.overdueMs ?? 0), 0);
      push('cron.maxOverdueDays', round(maxOverdueMs / 86_400_000, 1), { jobs: jobs.length });
    } catch { /* source unhealthy → skip */ }
  }

  // ---- rules: adherence + redundancy ----
  const rules = sources?.rules;
  if (rules) {
    try {
      if (typeof rules.audit === 'function') {
        const audit = rules.audit();
        const totals = audit?.totals ?? { hits: 0, denies: 0, asks: 0, advisories: 0 };
        const hits = totals.hits ?? 0;
        const blocked = (totals.denies ?? 0) + (totals.asks ?? 0);
        push('rules.hits', hits, { advisories: totals.advisories ?? 0 });
        push('rules.blocked', blocked, { denies: totals.denies ?? 0, asks: totals.asks ?? 0 });
        // 遵守率只在有门禁活动时才有意义（无活动记 0 会误导趋势）
        if (hits > 0) push('rules.adherencePct', round(((hits - blocked) / hits) * 100, 1));
      }
      if (typeof rules.lint === 'function') {
        const issues = await awaitMaybe(rules.lint());
        // Day 0 meta 增补：rulesTotal = 规则全量数（冗余度分母）。rules.list()
        // 是既有服务方法；缺席时 null（神谕层侧 N/A 处理），不影响 value。
        let rulesTotal = null;
        try {
          if (typeof rules.list === 'function') {
            const all = await awaitMaybe(rules.list());
            rulesTotal = Array.isArray(all) ? all.length : null;
          }
        } catch { /* rulesTotal 保持 null */ }
        push('rules.lintIssues', Array.isArray(issues) ? issues.length : 0,
          { issues: issues ?? [], rulesTotal });
      }
    } catch { /* skip */ }
  }

  // ---- wiki: knowledge health ----
  const wiki = sources?.wiki;
  if (wiki && typeof wiki.lint === 'function') {
    try {
      const lint = await awaitMaybe(wiki.lint());
      push('wiki.brokenLinks', Array.isArray(lint?.brokenLinks) ? lint.brokenLinks.length : 0,
        { links: lint?.brokenLinks ?? [] });
      push('wiki.contradictions', Array.isArray(lint?.contradictions) ? lint.contradictions.length : 0,
        { files: lint?.contradictions ?? [] });
      // Day 0 meta 增补：total = wiki 全量页数（lint().checked，噪声比分母）
      push('wiki.orphans', Array.isArray(lint?.orphans) ? lint.orphans.length : 0,
        { files: lint?.orphans ?? [], total: lint?.checked ?? null });
    } catch { /* skip */ }
  }

  // ---- memory: scale + health ----
  const memory = sources?.memory;
  if (memory && typeof memory.stats === 'function') {
    try {
      const stats = await awaitMaybe(memory.stats());
      // Day 0 meta 增补：无证据 id 清单（cap 50）+ Σ(conf×compliance)/N。
      // 神谕层的决策确信度公式是「逐条 conf×evidence 有无」的均值，与
      // avgConfidence（不乘 compliance）不同口径——两个数都要给。
      // list() 缺席/失败 → meta 退化为 { byType }，value 不受影响。
      let meta = { byType: stats?.byType ?? {} };
      try {
        if (typeof memory.list === 'function') {
          const all = await awaitMaybe(memory.list());
          if (Array.isArray(all)) {
            const noEvidenceIds = all
              .filter((e) => !e?.evidence || String(e.evidence).trim() === '')
              .map((e) => String(e.id));
            let sumConfXComp = 0;
            for (const e of all) {
              const c = Number(e?.confidence);
              if (!Number.isFinite(c)) continue;
              if (e?.evidence && String(e.evidence).trim() !== '') sumConfXComp += c;
            }
            meta = {
              ...meta,
              noEvidence: { count: noEvidenceIds.length, ids: noEvidenceIds.slice(0, NO_EVIDENCE_IDS_CAP), capped: noEvidenceIds.length > NO_EVIDENCE_IDS_CAP },
              avgConfXCompliance: all.length > 0 ? round(sumConfXComp / all.length, 4) : null,
            };
          }
        }
      } catch { /* meta 保持退化形态 */ }
      push('memory.total', stats?.total ?? 0, meta);
      push('memory.avgConfidence', round(stats?.avgConfidence ?? 0, 2));
    } catch { /* skip */ }
  }

  // ---- eventBus: sync 订阅数 + 死信率（A10 尾巴；软降级→缺省不 push） ----
  const eventBus = sources?.eventBus;
  if (eventBus && typeof eventBus.metricsSnapshot === 'function') {
    try {
      const snap = await awaitMaybe(eventBus.metricsSnapshot());
      const syncSubsrc = snap?.syncSubscriptions ?? 0;
      if (Number.isInteger(syncSubsrc)) push('eventBus.syncSubscriptions', syncSubsrc, {});
      const deadletterCount = snap?.deadletterCount ?? 0;
      // 死信率为比例时用 metricsSnapshot 增补的 published 字段；缺省用事件数做归一（无 published 则记 0）
      const published = snap?.publishedCount ?? 0;
      const rate = published > 0 ? round((deadletterCount / published) * 100, 3) : (deadletterCount > 0 ? null : 0);
      if (rate !== null) push('eventBus.deadletterRate', rate, { deadletterCount, publishedCount: published });
    } catch { /* skip：bus 不可用时不 push eventBus 指标 */ }
  }

  // ---- Day 0 扩展块（metrics-ext.js）：4 个新原子 key ----
  try {
    const ext = await computeMetricsExt({
      skillAutocreate: sources?.skillAutocreate,
      evolution: sources?.evolution,
      skillsFs: sources?.skillsFs,
    });
    out.push(...ext);
  } catch { /* 扩展块整体失败不拖垮基础 13 key */ }

  return out;
}

/** Await a value that may be a promise (services may be sync or async). */
async function awaitMaybe(v) {
  return v && typeof v.then === 'function' ? await v : v;
}

/** Latest-def lookup: describe one metric key for tool renderers. */
export function describeMetric(key) {
  return METRIC_DEFS.find((d) => d.key === key) ?? null;
}
