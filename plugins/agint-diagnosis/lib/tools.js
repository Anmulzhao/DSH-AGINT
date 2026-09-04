/**
 * agint-diagnosis: preset-scoped diagnosis tools (v0.6.0).
 * Consumes host services: annotate / counterfactual / cluster / report /
 * stats / analyzeFailedSmoke. Write/eval tools (annotate, counterfactual,
 * cluster, analyzeFailedSmoke) are ASK-gated per AGENTS.md boundary.
 *
 * Schema policy: K19 — `additionalProperties: true`; tighten after live call.
 *
 * K19-fix (2026-09-04): dsh-tools' lossless-JSON check rejects host return
 * values that aren't plain JSON. agint.diagnosis.stats() returns
 * {annotations, clusters, reports, limits} (plain object — see
 * plugins/agint-diagnosis/lib/index.js:108-118), but dsh-tools rejects
 * objects whose prototype chain contains a non-plain factory. JSON
 * round-trip guarantees plain JSON. If the host ever returns Date/Map/BigInt,
 * this loses precision and we need a typed serialiser; for stats() it is
 * exact. Same fix applies to diagnosis_report (uses report() returning
 * DiagnosisReportSchema-compliant plain object).
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'agint-diagnosis-tools';
const inject = ['tools',
  'agint.diagnosis.annotate', 'agint.diagnosis.counterfactual',
  'agint.diagnosis.cluster', 'agint.diagnosis.report',
  'agint.diagnosis.stats', 'agint.diagnosis.analyzeFailedSmoke'];

function apply(ctx) {
  const annotate = ctx['agint.diagnosis.annotate'];
  const counterfactual = ctx['agint.diagnosis.counterfactual'];
  const cluster = ctx['agint.diagnosis.cluster'];
  const report = ctx['agint.diagnosis.report'];
  const stats = ctx['agint.diagnosis.stats'];
  const analyzeFailedSmoke = ctx['agint.diagnosis.analyzeFailedSmoke'];

  ctx.tools.register(defineTool({
    name: 'diagnosis_annotate',
    description:
      'Tag a failure event with one of 6 root-cause classes. **ASK-gated**. ' +
      'Writes to agint.diagnosis; downstream mutator/curriculum consume these annotations.',
    parameters: {
      event: { type: 'object', required: true, additionalProperties: true,
        description: 'Failure event: { id?, source, error, context? }' },
      category: { type: 'string', required: true,
        description: 'One of 6 root-cause classes (e.g. ENVIRONMENT_SHIFT, LOGIC_ERROR).' },
      notes: { type: 'string', description: 'Optional analyst notes.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: `diagnosis_annotate: ${JSON.stringify(v)}` }],
    },
    execute(args) {
      return annotate({ event: args.event, category: args.category, notes: args.notes ?? '' });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'diagnosis_counterfactual',
    description:
      'Run a counterfactual simulation: "if X were different, would Y still occur?" ' +
      '**ASK-gated** — produces a simulation result that mutator consumes.',
    parameters: {
      hypothesis: { type: 'object', required: true, additionalProperties: true,
        description: 'Hypothesis spec: { change, target, expectedDiff? }' },
      seed: { type: 'integer', description: 'Random seed for reproducible runs.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute(args) {
      return counterfactual(args.hypothesis, { seed: args.seed });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'diagnosis_cluster',
    description: 'Cluster a batch of annotations into patterns (time-window based). **ASK-gated**.',
    parameters: {
      windowDays: { type: 'integer', description: 'Lookback window in days.' },
      minOccurrences: { type: 'integer', description: 'Minimum occurrences to form a cluster (default 3).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute(args) {
      return cluster({ windowDays: args.windowDays ?? 7, minOccurrences: args.minOccurrences ?? 3 });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'diagnosis_report',
    description:
      'Aggregate report over a time window: root-cause distribution + cluster summary. ' +
      '**Read-only**. Per AGENTS.md step 6.',
    parameters: {
      windowDays: { type: 'integer', description: 'Lookback window in days (default 7).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute(args) {
      return report({ windowDays: args.windowDays ?? 7 });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'diagnosis_stats',
    description: 'Auxiliary stats: counts of annotations, clusters, counterfactual runs.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute() {
      return stats().then((s) => JSON.parse(JSON.stringify(s)));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'diagnosis_analyzeFailedSmoke',
    description:
      'Analyze a failed smoke test: which plugin/skill/topic + which root-cause class. ' +
      '**ASK-gated** — feeds the dream mutator with attribution evidence.',
    parameters: {
      smokeRunId: { type: 'string', required: true, description: 'Failed smoke run id.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute(args) {
      return analyzeFailedSmoke(args.smokeRunId);
    },
  }));
}

export { apply, inject, name };