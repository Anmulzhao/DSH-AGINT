/**
 * agint-quality-report/lib/render.js — 报告渲染纯函数（Sprint 4.4）
 *
 * Contract QualityReporterIface (FROZEN):
 *   generate(results: EvalResult[], decision: Decision): Promise<{ markdown: string, json: object }>
 *
 * 输出:
 *   - markdown: 人类可读,可被 agint-wiki 渲染（章节: 概览 / 每维度 / HARM 趋势 / Findings / 决策审计）
 *   - json: 机器可读,包含所有 dimensions + harm + findings + 决策 + ts + policyId
 *
 * Sprint 4.4 范围:
 *   - 纯函数 renderReport({results, decision, meta})
 *   - 不依赖任何 IO;Sprint 4.5 weekly hook 调 reporter.generate 才会写 wiki/memory
 */

const DECISION_LABEL = {
  AUTO_DEPLOY: '✅ AUTO_DEPLOY',
  PENDING_REVIEW: '🟡 PENDING_REVIEW',
  REJECT: '❌ REJECT',
  ABSTAIN: '⚠️ ABSTAIN',
};

/**
 * Format a single dimension row.
 */
function dimensionRow(dim) {
  if (dim.score?.score === null || dim.score?.score === undefined) {
    return `| ${dim.label ?? dim.key} | null | ${dim.veto ? 'YES' : 'no'} | — |`;
  }
  const pct = Math.round(dim.score.score * 100);
  return `| ${dim.label ?? dim.key} | ${pct}% | ${dim.veto ? 'YES' : 'no'} | ${(dim.findings ?? []).length} |`;
}

/**
 * Format the markdown body.
 */
export function formatMarkdown({ results, decision, meta = {} }) {
  const ts = decision.decidedAt ?? new Date().toISOString();
  const decisionLabel = DECISION_LABEL[decision.kind] ?? decision.kind;

  const lines = [];
  lines.push(`# D-QAF Quality Report`);
  lines.push(``);
  lines.push(`- **Time**: ${ts}`);
  lines.push(`- **Decision**: ${decisionLabel}`);
  lines.push(`- **Score**: ${decision.score}`);
  lines.push(`- **Policy**: ${decision.policyId}`);
  lines.push(`- **Reason**: ${decision.reason}`);
  if (decision.triggeredBy?.length) {
    lines.push(`- **Triggered by**: ${decision.triggeredBy.join(', ')}`);
  }
  if (meta.harmonyDetectorReport) {
    lines.push(`- **Harmony detector**: ${meta.harmonyDetectorReport.report ?? meta.harmonyDetectorReport}`);
    if (meta.harmonyDetectorReport.patterns?.length) {
      lines.push(`  - Patterns: ${meta.harmonyDetectorReport.patterns.join(', ')}`);
    }
  }
  if (meta.committeeSnapshot) {
    lines.push(`- **Committee snapshot**: ${JSON.stringify(meta.committeeSnapshot)}`);
  }
  lines.push(``);
  lines.push(`## Targets`);
  lines.push(``);
  lines.push(`| targetId | kind | composite | decision | reason |`);
  lines.push(`|---|---|---|---|---|`);
  for (const t of decision.perTarget ?? []) {
    const score = t.score !== undefined && t.score !== null ? String(t.score) : '—';
    lines.push(`| ${t.targetId} | ${(results.find((r) => r.targetId === t.targetId)?.kind) ?? 'unknown'} | ${score} | ${DECISION_LABEL[t.kind] ?? t.kind} | ${t.reason ?? ''} |`);
  }
  lines.push(``);

  for (const r of results ?? []) {
    lines.push(`### ${r.targetId}`);
    lines.push(``);
    lines.push(`- Kind: ${r.kind}`);
    lines.push(`- Evaluator: ${r.evaluatorId}`);
    lines.push(`- Duration: ${r.durationMs}ms`);
    lines.push(``);
    lines.push(`| dimension | score | veto | findings |`);
    lines.push(`|---|---|---|---|`);
    for (const d of r.dimensions) {
      lines.push(dimensionRow(d));
    }
    lines.push(``);
    if (r.harm) {
      lines.push(`**HARM**: H=${r.harm.homogeneity} A=${r.harm.alignment} R=${r.harm.reduction} M=${r.harm.mutability}`);
      lines.push(``);
    }
    if (r.findings?.length) {
      lines.push(`**Findings**:`);
      for (const f of r.findings) {
        lines.push(`- [${f.severity}] ${f.message}`);
        if (f.evidence?.length) lines.push(`  - Evidence: ${f.evidence.join('; ')}`);
      }
      lines.push(``);
    }
  }

  lines.push(`## Audit`);
  lines.push(``);
  lines.push(`- Generated at: ${new Date().toISOString()}`);
  lines.push(`- Report version: agint-quality-report@0.4.0`);
  lines.push(`- Decision policyId: ${decision.policyId}`);

  return lines.join('\n');
}

/**
 * Format the JSON sidecar (machine-readable).
 */
export function formatJson({ results, decision, meta = {} }) {
  return {
    generatedAt: new Date().toISOString(),
    reportVersion: 'agint-quality-report@0.4.0',
    decision,
    meta,
    summary: {
      targetCount: results.length,
      autoDeploy: decision.perTarget?.filter((t) => t.kind === 'AUTO_DEPLOY').length ?? 0,
      pendingReview: decision.perTarget?.filter((t) => t.kind === 'PENDING_REVIEW').length ?? 0,
      rejected: decision.perTarget?.filter((t) => t.kind === 'REJECT').length ?? 0,
      abstain: decision.perTarget?.filter((t) => t.kind === 'ABSTAIN').length ?? 0,
      avgComposite: avgCompositeScore(decision.perTarget ?? []),
      avgHarm: avgHarm(results),
    },
    targets: results.map((r) => ({
      targetId: r.targetId,
      kind: r.kind,
      evaluatorId: r.evaluatorId,
      durationMs: r.durationMs,
      harm: r.harm,
      dimensions: r.dimensions,
      findings: r.findings ?? [],
    })),
  };
}

function avgCompositeScore(perTarget) {
  const scores = perTarget.filter((t) => typeof t.score === 'number').map((t) => t.score);
  if (!scores.length) return null;
  return Math.round((scores.reduce((s, n) => s + n, 0) / scores.length) * 10) / 10;
}

function avgHarm(results) {
  if (!results.length) return null;
  const totals = { homogeneity: 0, alignment: 0, reduction: 0, mutability: 0 };
  for (const r of results) {
    if (r.harm) {
      totals.homogeneity += r.harm.homogeneity ?? 0;
      totals.alignment += r.harm.alignment ?? 0;
      totals.reduction += r.harm.reduction ?? 0;
      totals.mutability += r.harm.mutability ?? 0;
    }
  }
  return {
    homogeneity: +(totals.homogeneity / results.length).toFixed(3),
    alignment: +(totals.alignment / results.length).toFixed(3),
    reduction: +(totals.reduction / results.length).toFixed(3),
    mutability: +(totals.mutability / results.length).toFixed(3),
  };
}

/**
 * Main entry: renderReport. Pure function.
 */
export function renderReport({ results, decision, meta } = {}) {
  const markdown = formatMarkdown({ results, decision, meta });
  const json = formatJson({ results, decision, meta });
  return { markdown, json };
}
