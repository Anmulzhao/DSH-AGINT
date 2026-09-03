/**
 * agint-mutator: preset-scoped mutator tools (v0.6.1).
 * Batch 1: stats + logMetric (read-only). propose/validate/commit/rollback
 * and the higher-level strategies are deferred to Batch 2 (high-risk writes).
 *
 * Schema policy: K19 — `additionalProperties: true`; tighten after live call.
 *
 * K19-fix (2026-09-04): dsh-tools' lossless-JSON check rejects host return
 * values that aren't plain JSON. agint.mutator.stats() returns
 * {proposals, commits, findings, metrics_log, limits} (plain object —
 * see plugins/agint-mutator/lib/index.js:235) but passing it through
 * unchanged trips the check. JSON round-trip guarantees plain JSON. If the
 * host ever returns Date/Map/BigInt, this loses precision and we need a
 * typed serialiser; for stats() it is exact.
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'agint-mutator-tools';
const inject = ['tools',
  'agint.mutator.stats', 'agint.mutator.logMetric'];

function apply(ctx) {
  const stats = ctx['agint.mutator.stats'];
  const logMetric = ctx['agint.mutator.logMetric'];

  ctx.tools.register(defineTool({
    name: 'mutator_stats',
    description:
      'Read-only mutator stats: proposal counts, commits/rollbacks, attributionDriven vs dreamRandom vs evolutionReversed distribution.',
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
    name: 'mutator_logMetric',
    description:
      'Log a single metric event into the mutator observation stream (commit/rollback caller entry). ' +
      'Read-only with respect to user state; idempotent for same event id.',
    parameters: {
      event: { type: 'object', required: true, additionalProperties: true,
        description: 'Metric event: { id, kind, value, ts? }' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: `mutator_logMetric: ${JSON.stringify(v)}` }],
    },
    execute(args) {
      return logMetric(args.event);
    },
  }));
}

export { apply, inject, name };