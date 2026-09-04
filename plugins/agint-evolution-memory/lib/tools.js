/**
 * agint-evolution-memory: preset-scoped evolution memory tools (v0.6.4+).
 * Batch 2.1 (Sprint 14+): 11 model-visible tools.
 *
 * Tool list (11):
 *   write:    logPhase4 / logPhase4Buffered / addFailure / addSuccess / flushLogBufferNow / decayScanRun
 *   read-only: readLogRangeMerged / queryFailures / queryTemplates / getLogRange / stats
 *
 * Ask gate (per老板 2026-09-04 决策):
 *   - logPhase4 / logPhase4Buffered / addFailure / addSuccess / flushLogBufferNow = ask
 *   - decayScanRun = read-only side-effect (L1-L4 衰减)，不入 ask（可走 rule_check 兜底）
 *   - 其余 5 个 read-only 工具可裸调
 *
 * Schema policy: K19 — additionalProperties: true on output / input where shape not
 * fully known (host returns plain JSON after dsh-tools lossless-JSON check; pass-through
 * safe with `additionalProperties: true`).
 *
 * K19-fix (2026-09-04 pattern): dsh-tools' lossless-JSON check rejects host return
 * values that aren't plain JSON. stats() / read*() / query*() return plain objects,
 * but JSON round-trip via JSON.parse(JSON.stringify(s)) guarantees plain JSON.
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'agint-evolution-memory-tools';
const inject = ['tools',
  'agint.evolution.logPhase4',
  'agint.evolution.logPhase4Buffered',
  'agint.evolution.readLogRangeMerged',
  'agint.evolution.flushLogBufferNow',
  'agint.evolution.addFailure',
  'agint.evolution.addSuccess',
  'agint.evolution.queryFailures',
  'agint.evolution.queryTemplates',
  'agint.evolution.getLogRange',
  'agint.evolution.decayScanRun',
  'agint.evolution.stats'];

function apply(ctx) {
  const logPhase4 = ctx['agint.evolution.logPhase4'];
  const logPhase4Buffered = ctx['agint.evolution.logPhase4Buffered'];
  const readLogRangeMerged = ctx['agint.evolution.readLogRangeMerged'];
  const flushLogBufferNow = ctx['agint.evolution.flushLogBufferNow'];
  const addFailure = ctx['agint.evolution.addFailure'];
  const addSuccess = ctx['agint.evolution.addSuccess'];
  const queryFailures = ctx['agint.evolution.queryFailures'];
  const queryTemplates = ctx['agint.evolution.queryTemplates'];
  const getLogRange = ctx['agint.evolution.getLogRange'];
  const decayScanRun = ctx['agint.evolution.decayScanRun'];
  const stats = ctx['agint.evolution.stats'];

  // ── write tools (5) ─────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'evolution_logPhase4',
    description:
      'Append one evolution-log entry (D-QAF Phase 4 completion marker). ' +
      'ASK-gated per Batch 2.1 决策 — call goes through rule_check ask gate.',
    parameters: {
      entry: { type: 'object', required: true, additionalProperties: true,
        description: 'EvolutionLogEntry: { targetId, targetKind, decision, scores?, findings?, tags? }' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: `evolution_logPhase4: ${JSON.stringify(v)}` }],
    },
    execute(args) {
      return logPhase4(args.entry).then((s) => JSON.parse(JSON.stringify(s)));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolution_logPhase4Buffered',
    description:
      'Buffered variant of logPhase4 (Sprint 10 v0.6.4 #7): async batch flush. ' +
      'Returns { queued: true, id }. ASK-gated per Batch 2.1.',
    parameters: {
      entry: { type: 'object', required: true, additionalProperties: true,
        description: 'EvolutionLogEntry: { targetId, targetKind, decision, scores?, findings?, tags? }' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: `evolution_logPhase4Buffered: ${JSON.stringify(v)}` }],
    },
    execute(args) {
      return logPhase4Buffered(args.entry).then((s) => JSON.parse(JSON.stringify(s)));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolution_addFailure',
    description:
      'Record a failure pattern into agint_evolution.failure_pattern table (cap 100). ' +
      'ASK-gated — destructive write.',
    parameters: {
      failure: { type: 'object', required: true, additionalProperties: true,
        description: 'FailurePattern: { pattern, category?, severity?, evidence? }' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: `evolution_addFailure: ${JSON.stringify(v)}` }],
    },
    execute(args) {
      return addFailure(args.failure).then((s) => JSON.parse(JSON.stringify(s)));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolution_addSuccess',
    description:
      'Record a success template into agint_evolution.success_template table (cap 50). ' +
      'ASK-gated — destructive write.',
    parameters: {
      success: { type: 'object', required: true, additionalProperties: true,
        description: 'SuccessTemplate: { template, sampleSize?, appliesTo?, evidence? }' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: `evolution_addSuccess: ${JSON.stringify(v)}` }],
    },
    execute(args) {
      return addSuccess(args.success).then((s) => JSON.parse(JSON.stringify(s)));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolution_flushLogBufferNow',
    description:
      'Force-flush the EvolutionLogBuffer (Sprint 10 v0.6.4 #7). ' +
      'ASK-gated — blocking I/O operation.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: `evolution_flushLogBufferNow: ${JSON.stringify(v)}` }],
    },
    execute() {
      return flushLogBufferNow().then((s) => JSON.parse(JSON.stringify(s)));
    },
  }));

  // ── write tools (1, no ask gate but side-effect) ─────────────────

  ctx.tools.register(defineTool({
    name: 'evolution_decayScanRun',
    description:
      'Run L1-L4 decay scan on evolution memory entries. ' +
      'Side-effect: downgrades stale entries; clear L4 entries resolved/replaced and 730+ days stale when apply=true.',
    parameters: {
      opts: { type: 'object', additionalProperties: true,
        description: 'DecayScanOptions: { apply?: boolean, dryRun?: boolean }' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: `evolution_decayScanRun: ${JSON.stringify(v)}` }],
    },
    execute(args) {
      return decayScanRun(args.opts || {}).then((s) => JSON.parse(JSON.stringify(s)));
    },
  }));

  // ── read-only tools (5) ───────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'evolution_readLogRangeMerged',
    description:
      'Read evolution_log merged view (buffer + storage). ' +
      'Sprint 10 v0.6.4 #8: read-side merge covers in-flight buffered entries.',
    parameters: {
      opts: { type: 'object', additionalProperties: true,
        description: 'RangeOptions: { fromDate?, toDate?, limit? }' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute(args) {
      return readLogRangeMerged(args.opts || {}).then((s) => JSON.parse(JSON.stringify(s)));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolution_queryFailures',
    description:
      'Linear-scan + lowercase substring query on failure_pattern table (cap 100).',
    parameters: {
      opts: { type: 'object', additionalProperties: true,
        description: 'QueryOptions: { keyword?, category?, severity?, limit? }' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute(args) {
      return queryFailures(args.opts || {}).then((s) => JSON.parse(JSON.stringify(s)));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolution_queryTemplates',
    description:
      'Linear-scan + lowercase substring query on success_template table (cap 50).',
    parameters: {
      opts: { type: 'object', additionalProperties: true,
        description: 'QueryOptions: { keyword?, limit? }' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute(args) {
      return queryTemplates(args.opts || {}).then((s) => JSON.parse(JSON.stringify(s)));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolution_getLogRange',
    description:
      'Range query on evolution_log: { fromDate, toDate, limit=200 }.',
    parameters: {
      range: { type: 'object', additionalProperties: true,
        description: 'RangeOptions: { fromDate?, toDate?, limit? }' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute(args) {
      return getLogRange(args.range || {}).then((s) => JSON.parse(JSON.stringify(s)));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolution_stats',
    description:
      'Read-only stats for evolution tables (counts + limits). ' +
      'Consumed by host dashboard.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute() {
      return stats().then((s) => JSON.parse(JSON.stringify(s)));
    },
  }));
}

export { apply, inject, name };