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
 */

export const METRIC_DEFS = [
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
];

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
        push('rules.lintIssues', Array.isArray(issues) ? issues.length : 0, { issues: issues ?? [] });
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
      push('wiki.orphans', Array.isArray(lint?.orphans) ? lint.orphans.length : 0,
        { files: lint?.orphans ?? [] });
    } catch { /* skip */ }
  }

  // ---- memory: scale + health ----
  const memory = sources?.memory;
  if (memory && typeof memory.stats === 'function') {
    try {
      const stats = await awaitMaybe(memory.stats());
      push('memory.total', stats?.total ?? 0, stats?.byType ?? {});
      push('memory.avgConfidence', round(stats?.avgConfidence ?? 0, 2));
    } catch { /* skip */ }
  }

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
