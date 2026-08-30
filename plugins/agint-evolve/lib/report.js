/**
 * agint-evolve: pure report logic (no I/O, no service access).
 *
 * findingsFromSnapshot() turns a live data snapshot into a list of
 * auto-detected issues (stale cron jobs, wiki broken links / contradictions /
 * orphans, rule redundancy, memory bloat or low confidence, declining
 * metrics). buildReport() renders the weekly review markdown with the data
 * snapshot table, findings, proposal section, and the routing rules (教训→
 * memory / 方法→准则 / 知识→wiki) — the 复盘闭环 Phase 1 (挖掘) + Phase 2
 * (归类) skeleton. Phase 3 (提案) happens in the model via evolve_propose.
 */

/** One finding: level ok|info|warn, machine key, human message. */
export function findingsFromSnapshot(snapshot) {
  const out = [];
  const s = snapshot ?? {};

  // ---- cron: blind spots (the 21-day blind-spot accident guard) ----
  const cron = s.cron;
  if (cron && Array.isArray(cron.issues) && cron.issues.length > 0) {
    for (const issue of cron.issues) {
      out.push({ level: 'warn', key: 'cron.stale', message: `定时任务失效：${issue.id}（${issue.reason ?? '未知原因'}）` });
    }
  }

  // ---- wiki: knowledge health ----
  const wiki = s.wiki;
  if (wiki) {
    const broken = Array.isArray(wiki.brokenLinks) ? wiki.brokenLinks.length : 0;
    const contrad = Array.isArray(wiki.contradictions) ? wiki.contradictions.length : 0;
    const orphans = Array.isArray(wiki.orphans) ? wiki.orphans.length : 0;
    if (broken > 0) out.push({ level: 'warn', key: 'wiki.brokenLinks', message: `Wiki 有 ${broken} 个失效引用（断链）` });
    if (contrad > 0) out.push({ level: 'warn', key: 'wiki.contradictions', message: `Wiki 有 ${contrad} 个矛盾标记（⚠️）` });
    if (orphans > 0) out.push({ level: 'info', key: 'wiki.orphans', message: `Wiki 有 ${orphans} 个孤岛条目（未被引用，考虑合并或归档）` });
  }

  // ---- rules: adherence + redundancy ----
  const rules = s.rules;
  if (rules) {
    const totals = rules.totals ?? {};
    const hits = totals.hits ?? 0;
    const blocked = (totals.denies ?? 0) + (totals.asks ?? 0);
    if (Array.isArray(rules.lintIssues) && rules.lintIssues.length > 0) {
      out.push({ level: 'warn', key: 'rules.lint', message: `规则表有 ${rules.lintIssues.length} 个冗余/失效项（重复或非法 pattern）` });
    }
    if (hits > 0 && blocked > 0) {
      out.push({ level: 'info', key: 'rules.blocked', message: `门禁拦截/询问 ${blocked}/${hits} 次（遵守率 ${Math.round(((hits - blocked) / hits) * 100)}%）` });
    } else if (hits === 0) {
      out.push({ level: 'info', key: 'rules.noActivity', message: '本期无门禁活动（hits=0）——规则可能形同虚设，或本期没有危险操作' });
    }
  }

  // ---- memory: scale + confidence ----
  const memory = s.memory;
  if (memory) {
    if ((memory.total ?? 0) > 50) {
      out.push({ level: 'info', key: 'memory.bloat', message: `记忆 ${memory.total} 条——超过 50 条阈值，建议运行 memory_forget_scan` });
    }
    if (typeof memory.avgConfidence === 'number' && memory.avgConfidence < 0.4) {
      out.push({ level: 'warn', key: 'memory.confidence', message: `记忆平均置信度 ${memory.avgConfidence} < 0.4——大量低置信度条目，考虑清理或降级` });
    }
  }

  // ---- metrics trends (when a metrics summary exists) ----
  const metrics = s.metrics;
  if (metrics && Array.isArray(metrics.metrics)) {
    for (const m of metrics.metrics) {
      if (typeof m.delta === 'number' && m.delta > 0) {
        // Positive delta on count metrics = deterioration; on adherencePct it is improvement.
        const worsening = m.key !== 'rules.adherencePct';
        if (worsening) {
          out.push({ level: 'warn', key: `trend.${m.key}`, message: `指标 ${m.key} 较上次恶化 +${m.delta}（当前 ${m.value}）` });
        }
      }
    }
  }

  if (out.length === 0) out.push({ level: 'ok', key: 'all.healthy', message: '未发现明显问题' });
  return out;
}

/** Row of the snapshot table: [域, 值描述]. */
function snapshotRow(key, value) {
  return `| ${key} | ${value} |`;
}

function renderSnapshotTable(s) {
  const rows = [];
  if (s.memory) {
    const m = s.memory;
    const byType = m.byType ?? {};
    rows.push(snapshotRow('记忆', `${m.total ?? 0} 条（教训 ${byType.lesson ?? 0} / 决策 ${byType.decision ?? 0} / 偏好 ${byType.preference ?? 0} / 规律 ${byType.pattern ?? 0}），平均置信度 ${m.avgConfidence ?? '-'}`));
  }
  if (s.wiki) {
    const w = s.wiki;
    rows.push(snapshotRow('Wiki', `${w.checked ?? 0} 个文件；断链 ${(w.brokenLinks ?? []).length} / 矛盾 ${(w.contradictions ?? []).length} / 孤岛 ${(w.orphans ?? []).length}`));
  }
  if (s.cron) {
    const c = s.cron;
    rows.push(snapshotRow('Cron', `${(c.jobs ?? []).length} 个任务；失效 ${(c.issues ?? []).length}`));
  }
  if (s.rules) {
    const r = s.rules;
    const totals = r.totals ?? {};
    const hits = totals.hits ?? 0;
    const blocked = (totals.denies ?? 0) + (totals.asks ?? 0);
    rows.push(snapshotRow('规则门禁', `命中 ${hits} 次，拦截/询问 ${blocked} 次${hits > 0 ? `，遵守率 ${Math.round(((hits - blocked) / hits) * 100)}%` : ''}；冗余/失效 ${(r.lintIssues ?? []).length}`));
  }
  if (s.metrics) {
    rows.push(snapshotRow('指标', `${s.metrics.count ?? 0} 项已采集（用 metrics_summary 看明细）`));
    // Sprint 12 / A10 — 周复盘模板新增两行：eventBus 死信率 + sync 订阅数
    const mList = Array.isArray(s.metrics.metrics) ? s.metrics.metrics : [];
    const sync = mList.find((m) => m.key === 'eventBus.syncSubscriptions');
    const dlRate = mList.find((m) => m.key === 'eventBus.deadletterRate');
    if (sync && sync.value !== undefined) {
      rows.push(snapshotRow('Event Bus sync 订阅数', `${sync.value} 个（上限 3）`));
    }
    if (dlRate && dlRate.value !== undefined) {
      let meta = '';
      try { const p = JSON.parse(dlRate.meta || '{}'); meta = `（死信 ${p.deadletterCount ?? 0} / 发布 ${p.publishedCount ?? 0}）`; } catch { /* ignore */ }
      rows.push(snapshotRow('Event Bus 死信率', `${dlRate.value}%${meta}`));
    }
  }
  if (s.sessions) {
    rows.push(snapshotRow('会话', s.sessions.count !== undefined ? `${s.sessions.count} 个历史会话` : '（sessionQuery 未接入）'));
  }
  if (rows.length === 0) rows.push(snapshotRow('数据源', '全部不可用——检查 host 服务是否已挂载'));
  return rows.join('\n');
}

/**
 * Render the weekly review markdown.
 * @param {{date: string, snapshot: object, findings: Array, notes?: string}} input
 * @returns {string} markdown
 */
export function buildReport({ date, snapshot, findings, notes }) {
  const d = String(date ?? new Date().toISOString().slice(0, 10));
  const collectedAt = snapshot?.collectedAt ? String(snapshot.collectedAt) : new Date().toISOString();
  const lines = [];
  lines.push(`# 智进周复盘 ${d}`);
  lines.push('');
  lines.push(`> 自动生成于 ${collectedAt}｜数据源：agint-memory / agint-wiki / agint-cron / agint-rules / agint-metrics`);
  lines.push('');
  lines.push('## 一、数据快照');
  lines.push('');
  lines.push('| 域 | 关键值 |');
  lines.push('|---|---|');
  lines.push(renderSnapshotTable(snapshot ?? {}));
  lines.push('');
  lines.push('## 二、自动发现');
  lines.push('');
  if (findings.length === 0) {
    lines.push('- 未发现明显问题');
  } else {
    for (const f of findings) {
      const icon = f.level === 'warn' ? '⚠️' : f.level === 'info' ? 'ℹ️' : '✅';
      lines.push(`- ${icon} [${f.key}] ${f.message}`);
    }
  }
  lines.push('');
  lines.push('## 三、改进提案');
  lines.push('');
  lines.push('> 用 evolve_propose 在此追加提案（category: rule / skill / doc / preset / service / other），' +
    '状态用 evolve_set_status 跟踪（proposed → applied / rejected）。');
  lines.push('');
  if (notes && String(notes).trim() !== '') {
    lines.push('## 四、备注');
    lines.push('');
    lines.push(String(notes).trim());
    lines.push('');
  }
  lines.push('## 路由规范（复盘产出去向）');
  lines.push('');
  lines.push('- 教训（不可再做）→ agint-memory，type=lesson，必须带 evidence');
  lines.push('- 决策（如何取舍）→ agint-memory，type=decision');
  lines.push('- 方法/准则（可复用流程）→ 准则段落（AGENTS/agent-instructions）');
  lines.push('- 知识（领域事实）→ agint-wiki');
  lines.push('- 未采集指标（谄媚率/任务步数中位数）→ 需 session 日志挖掘，留待 evolve Phase 1 扩展');
  lines.push('');
  return lines.join('\n');
}
