/**
 * agint-curator: reporter — 基础策展报告（Sprint 14 阶段 1）。
 *
 * P0-2 §3.1 [7] 的完整报告含重叠/质量/影响三章，属 Sprint 15。
 * 阶段 1 只交付「统计 + 归档列表 + 建议」（§12.1 reporter 模块）。
 *
 * 纯函数：输入本周策展的输入输出快照 → 报告对象。不落盘（落盘在 index.js）。
 */

/** @param {Object} args { week, generatedAt, trigger, dryRun, skills, decisions, applied } */
export function buildReport({ week, generatedAt, trigger = 'weekly_curation', dryRun = false, skills = [], decisions = [], applied = null }) {
  const byState = {};
  let pinned = 0;
  let protectedCount = 0;
  for (const s of skills) {
    byState[s.state] = (byState[s.state] ?? 0) + 1;
    if (s.state === 'pinned') pinned++;
    if (s.protected === true) protectedCount++;
  }

  const staled = (applied?.staled ?? []).map((x) => ({
    skillName: x.skillName, reason: x.reason, lastUsedAt: x.lastUsedAt ?? null,
  }));
  const archived = (applied?.archived ?? []).map((x) => ({
    skillName: x.skillName, reason: x.reason, lastUsedAt: x.lastUsedAt ?? null,
  }));
  const reactivated = (applied?.reactivated ?? []).map((x) => ({ skillName: x.skillName, reason: x.reason }));

  const summary = {
    totalSkillsChecked: skills.length,
    newlyStale: staled.length,
    newlyArchived: archived.length,
    reactivated: reactivated.length,
    pinned,
    protected: protectedCount,
    skipped: (applied?.skipped ?? []).length,
    byState,
  };

  return {
    week,
    generatedAt,
    trigger,
    dryRun,
    summary,
    archived,
    staled,
    reactivated,
    recommendations: buildRecommendations({ summary, archived, staled, dryRun, decisions }),
  };
}

function buildRecommendations({ summary, archived, staled, dryRun, decisions }) {
  const recs = [];
  if (archived.length) {
    recs.push(`本周归档 ${archived.length} 个技能（${archived.map((a) => a.skillName).join(', ')}）。归档只是移动到 skills/.archive/，可用 curator_unarchive 一键恢复。`);
  }
  if (staled.length) {
    recs.push(`${staled.length} 个技能进入 stale（30 天未用）。若仍在用，请 curator_pin 固定，避免 90 天后被归档。`);
  }
  if (!archived.length && !staled.length) {
    recs.push('本周无状态变化。');
  }
  // 注意：dryRun 提示**不进** recommendations —— 验收标准要求 dry_run 输出与
  // 真实执行完全一致（除不落盘外）。是否 dry-run 由 report.dryRun 字段承载，
  // 渲染层（renderReport / 工具 render）自行提示。
  const budgetWait = (decisions ?? []).filter((d) => typeof d.reason === 'string' && d.reason.includes('budget_wait'));
  if (budgetWait.length) recs.push(`${budgetWait.length} 个技能因本周归档预算用尽被跳过，下周自动重试。`);
  return recs;
}

/** 报告的文本渲染（周复盘/终端可读） */
export function renderReport(report) {
  const s = report.summary;
  const lines = [
    `策展报告 ${report.week}${report.dryRun ? '（dry-run）' : ''}`,
    `  检查 ${s.totalSkillsChecked} 个技能 | stale ${s.newlyStale} | archived ${s.newlyArchived} | reactivated ${s.reactivated} | pinned ${s.pinned} | protected ${s.protected}`,
    `  状态分布：${Object.entries(s.byState).map(([k, v]) => `${k}=${v}`).join(' ') || '空'}`,
  ];
  if (report.archived.length) {
    lines.push('  归档：');
    for (const a of report.archived) lines.push(`    - ${a.skillName}：${a.reason}`);
  }
  if (report.staled.length) {
    lines.push('  转 stale：');
    for (const a of report.staled) lines.push(`    - ${a.skillName}：${a.reason}`);
  }
  for (const r of report.recommendations) lines.push(`  * ${r}`);
  return lines.join('\n');
}
