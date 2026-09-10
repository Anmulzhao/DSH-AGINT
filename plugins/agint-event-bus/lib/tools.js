/**
 * agint-event-bus: preset-scoped event-bus tools (Sprint 12 / v0.7.0).
 * Consumes host services: publish / subscribe / inspect / inspectSummary /
 * deadletters / metricsSnapshot. publish is ASK-gated (AGENTS.md boundary).
 *
 * Schema policy: K19 — `additionalProperties: true`; tighten after live call.
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

/**
 * K20-fix (2026-09-11)：工具 output schema 沿用 K19 的 { type: 'object' }，
 * 但 provider 侧两个 Service 返回的是**数组**：
 *   - agint.eventBus.inspect      → EventLogEntry[]（bus.js 头部自述即 `→ EventLogEntry[]`）
 *   - agint.eventBus.deadletters  → listDeadletters() 数组（软降级返回 []）
 * 数组过不了 object 校验 ⇒ 两个工具 100% 报
 * `returned invalid output: "value" must be an object`，排障时极易被误读成
 * "总线没有数据"。这里在工具边界规整为稳定的对象信封，不改 Service 契约。
 */
function asObjectResult(value, key = 'entries') {
  if (Array.isArray(value)) return { [key]: value, count: value.length };
  if (value === null || value === undefined) return { [key]: [], count: 0 };
  return value;
}

const name = 'agint-event-bus-tools';
const inject = ['tools', 'agint.eventBus.publish', 'agint.eventBus.subscribe',
  'agint.eventBus.inspect', 'agint.eventBus.inspectSummary',
  'agint.eventBus.deadletters', 'agint.eventBus.metricsSnapshot'];

function apply(ctx) {
  const publish = ctx['agint.eventBus.publish'];
  const subscribe = ctx['agint.eventBus.subscribe'];
  const inspect = ctx['agint.eventBus.inspect'];
  const inspectSummary = ctx['agint.eventBus.inspectSummary'];
  const deadletters = ctx['agint.eventBus.deadletters'];
  const metricsSnapshot = ctx['agint.eventBus.metricsSnapshot'];

  ctx.tools.register(defineTool({
    name: 'eventBus_publish',
    description:
      'Publish an event onto the AGINT event bus. **ASK-gated** per AGENTS.md boundary. ' +
      'Input is an envelope: { topic, payload, traceId?, occurredAt? }. Sync subscriptions cap at 3.',
    parameters: {
      input: { type: 'object', required: true, additionalProperties: true,
        description: 'Envelope: { topic: string, payload: any, traceId?: string, occurredAt?: string }' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: `eventBus_publish: ${JSON.stringify(v)}` }],
    },
    execute(args) {
      return publish(args.input);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'eventBus_subscribe',
    description:
      'Subscribe to a topic. **ASK-gated**. Returns an unsubscribe disposer. ' +
      'Subscriptions are process-scoped; do NOT subscribe from transient exploration.',
    parameters: {
      rawSub: { type: 'object', required: true, additionalProperties: true,
        description: 'Subscription: { topic: string, sync?: boolean, id?: string }' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: `eventBus_subscribe: ${JSON.stringify(v)}` }],
    },
    execute(args) {
      // Note: subscribe is registered for parity but Tool.execute cannot hold a long-lived disposer;
      // host's subscribe returns { unsubscribe }. Surface the id; runtime side-effect ownership stays host-side.
      return subscribe(args.rawSub, () => {});
    },
  }));

  ctx.tools.register(defineTool({
    name: 'eventBus_inspect',
    description: 'Inspect bus event log with an optional filter (topic / time window / traceId).',
    parameters: {
      filter: { type: 'object', additionalProperties: true,
        description: 'Optional filter: { topic?, traceId?, since?, until? }' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args) {
      return asObjectResult(await inspect(args.filter ?? {}));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'eventBus_inspectSummary',
    description: 'Aggregate counts per topic for a given filter window. Per AGENTS.md step 7.',
    parameters: {
      filter: { type: 'object', additionalProperties: true,
        description: 'Optional filter: { topic?, since?, until? }' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute(args) {
      return inspectSummary(args.filter ?? {});
    },
  }));

  ctx.tools.register(defineTool({
    name: 'eventBus_deadletters',
    description: 'List deadletter entries (subscriptions that exhausted retries).',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute() {
      return asObjectResult(await deadletters());
    },
  }));

  ctx.tools.register(defineTool({
    name: 'eventBus_metricsSnapshot',
    description: 'Bus metrics: publish counts, deadletter rate, sync-quota use, throughput.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute() {
      return metricsSnapshot();
    },
  }));
}

export { apply, inject, name };