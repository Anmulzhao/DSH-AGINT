/**
 * agint-evolution-memory: preset-scoped evolution memory tools (v0.6.4+).
 * Batch 2.1 (Sprint 14+): 11 model-visible tools. Phase 1 Sprint 22 加 2 个（重建）。
 *
 * Tool list (13):
 *   write:    logPhase4 / logPhase4Buffered / addFailure / addSuccess / flushLogBufferNow / decayScanRun
 *             / ledgerRebuildApply
 *   read-only: readLogRangeMerged / queryFailures / queryTemplates / getLogRange / stats
 *             / ledgerRebuildPlan
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

/**
 * K20-fix (2026-09-11)：4 个 read-only Service 返回的是**数组**
 * （queryFailures/queryTemplates/getLogRange 都是 `return out.slice(0, limit)`，
 * readLogRangeMerged 走 logBuffer.readMerged → 数组），而 output schema 沿用
 * K19 的 { type: 'object' } ⇒ 数组过不了 object 校验，4 个工具 100% 报
 * `returned invalid output: "value" must be an object`。
 *
 * 修法：工具边界包一层稳定信封（不碰 Service 契约，直接消费 Service 的
 * 插件如 event-bus / quality-policy 不受影响）。信封之后保留 K19 的
 * JSON round-trip —— 信封恒为 object，因此不会出现 JSON.stringify(undefined)
 * 崩溃。
 */
function asObjectResult(value, key = 'entries') {
  const env = Array.isArray(value)
    ? { [key]: value, count: value.length }
    : (value === null || value === undefined ? { [key]: [], count: 0 } : value);
  return JSON.parse(JSON.stringify(env));
}

const name = 'agint-evolution-memory-tools';
// IMPORTANT: inject the umbrella `agint.evolution` service object, NOT per-
// function dotted keys. index.js provides ONE umbrella (ctx.provide(
// 'agint.evolution', {...})), and every other consumer (event-bus,
// quality-policy, quality-eval, quality-sandbox, cron, diagnosis, mutator,
// population, self-model, mount) resolves the umbrella. Per-key inject here
// made the DI wait forever on keys nobody provides → preset "agint" failed
// to mount (2026-09-04 智进挂载失败根因).
const inject = ['tools', 'agint.evolution'];

function apply(ctx) {
  const {
    logPhase4,
    logPhase4Buffered,
    readLogRangeMerged,
    flushLogBufferNow,
    addFailure,
    addSuccess,
    queryFailures,
    queryTemplates,
    getLogRange,
    decayScanRun,
    stats,
    ledger,
  } = ctx['agint.evolution'];

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
      'ASK-gated — destructive write. Out-of-enum category/severity are normalized ' +
      'via the mapping table (original value recorded in coercedFrom), never rejected.',
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
      apply: { type: 'boolean', description: 'Set true to apply the decay actions. Defaults to false (dry-run).' },
      dryRun: { type: 'boolean', description: 'Explicit dry-run. Defaults to false.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: `evolution_decayScanRun: ${JSON.stringify(v)}` }],
    },
    execute(args) {
      return decayScanRun({ apply: args?.apply === true, dryRun: args?.dryRun === true })
        .then((s) => JSON.parse(JSON.stringify(s)));
    },
  }));

  // ── Ledger 历史重建（§4.3.5 / §4.6 #7）─────────────────────────────────
  // 计划与入链共用 lib/ledger-rebuild.js 的同一份推导：报告与写入不会是两套口径。
  // ⚠️ 运行时 ask 门禁（storages/agint_rules.json 的 rule 行）不归仓库管，
  //    这个工具应当按 write 登记 ask；登记前它仍有三道代码内闸门：
  //    apply 缺省 false、链上有实时条目即拒、可重建 <5 条即拒。

  ctx.tools.register(defineTool({
    name: 'evolution_ledgerRebuildPlan',
    description:
      'Read-only: derive reconstructable evolution-ledger entries from event_bus + population + preimage (§4.3.5). ' +
      'Returns { entries, blockers, counts } — entries whose evidence is incomplete are listed with reasons, never guessed values.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: `evolution_ledgerRebuildPlan: ${JSON.stringify(v)}` }],
    },
    execute() {
      return ledger.rebuildPlan().then((s) => JSON.parse(JSON.stringify(s)));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolution_ledgerRebuildApply',
    description:
      'Append reconstructed history entries to the evolution ledger through the ledger service (the only legal write path). ' +
      'ASK-gated — ledger writes. Default is dry-run: pass { apply: true } to write. ' +
      'Refuses when the chain already holds live (non-reconstructed) entries (§4.3.5 timing constraint) or when fewer than 5 entries are evidenced.',
    parameters: {
      apply: { type: 'boolean',
        description: 'Pass true to write the planned entries into the ledger. Defaults to false (dry-run).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: `evolution_ledgerRebuildApply: ${JSON.stringify(v)}` }],
    },
    execute(args) {
      return ledger.rebuild({ apply: args?.apply === true }).then((s) => JSON.parse(JSON.stringify(s)));
    },
  }));

  // ── read-only tools (5) ───────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'evolution_readLogRangeMerged',
    description:
      'Read evolution_log merged view (buffer + storage). ' +
      'Sprint 10 v0.6.4 #8: read-side merge covers in-flight buffered entries.',
    parameters: {
      fromDate: { type: 'string', description: 'Inclusive lower bound, ISO date-time. Optional.' },
      toDate: { type: 'string', description: 'Inclusive upper bound, ISO date-time. Optional.' },
      limit: { type: 'number', description: 'Max rows to return. Defaults to 200.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args) {
      return asObjectResult(await readLogRangeMerged({
        ...(args?.fromDate === undefined ? {} : { fromDate: args.fromDate }),
        ...(args?.toDate === undefined ? {} : { toDate: args.toDate }),
        ...(args?.limit === undefined ? {} : { limit: args.limit }),
      }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolution_queryFailures',
    description:
      'Linear-scan + lowercase substring query on failure_pattern table (cap 100).',
    parameters: {
      keyword: { type: 'string', description: 'Lowercase substring match against the entry. Optional.' },
      category: { type: 'string', description: 'Exact category match. Optional.' },
      severity: { type: 'string', description: 'Exact severity match. Optional.' },
      limit: { type: 'number', description: 'Max rows to return. Optional.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args) {
      return asObjectResult(await queryFailures({
        ...(args?.keyword === undefined ? {} : { keyword: args.keyword }),
        ...(args?.category === undefined ? {} : { category: args.category }),
        ...(args?.severity === undefined ? {} : { severity: args.severity }),
        ...(args?.limit === undefined ? {} : { limit: args.limit }),
      }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolution_queryTemplates',
    description:
      'Linear-scan + lowercase substring query on success_template table (cap 50).',
    parameters: {
      keyword: { type: 'string', description: 'Lowercase substring match against the entry. Optional.' },
      limit: { type: 'number', description: 'Max rows to return. Optional.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args) {
      return asObjectResult(await queryTemplates({
        ...(args?.keyword === undefined ? {} : { keyword: args.keyword }),
        ...(args?.limit === undefined ? {} : { limit: args.limit }),
      }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolution_getLogRange',
    description:
      'Range query on evolution_log: { fromDate, toDate, limit=200 }.',
    parameters: {
      fromDate: { type: 'string', description: 'Inclusive lower bound, ISO date-time. Optional.' },
      toDate: { type: 'string', description: 'Inclusive upper bound, ISO date-time. Optional.' },
      limit: { type: 'number', description: 'Max rows to return. Defaults to 200.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args) {
      return asObjectResult(await getLogRange({
        ...(args?.fromDate === undefined ? {} : { fromDate: args.fromDate }),
        ...(args?.toDate === undefined ? {} : { toDate: args.toDate }),
        ...(args?.limit === undefined ? {} : { limit: args.limit }),
      }));
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