/**
 * agint-population: preset-scoped population tools (v0.6.2).
 * Consumes host services: stats (read-only) + evaluate (ASK-gated, single-test entry).
 * ingest/promote/cull/fixate/rollback are deferred to Batch 2 (high-risk writes).
 *
 * Schema policy: K19 — `additionalProperties: true`; tighten after live call.
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'agint-population-tools';
const inject = ['tools',
  'agint.population.stats', 'agint.population.evaluate'];

function apply(ctx) {
  const stats = ctx['agint.population.stats'];
  const evaluate = ctx['agint.population.evaluate'];

  ctx.tools.register(defineTool({
    name: 'population_stats',
    description:
      'Read-only population stats: active variants, fitness history depth, traffic log size, generation count.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute() {
      return stats();
    },
  }));

  ctx.tools.register(defineTool({
    name: 'population_evaluate',
    description:
      'Run the population fitness evaluator against a candidate spec. **ASK-gated**. ' +
      'Exposed for unit-test parity; full tournament scheduling deferred to Batch 2.',
    parameters: {
      spec: { type: 'object', required: true, additionalProperties: true,
        description: 'Candidate spec: { id, kind, payload }' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute(args) {
      return evaluate(args.spec);
    },
  }));
}

export { apply, inject, name };