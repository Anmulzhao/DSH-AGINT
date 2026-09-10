/**
 * agint-self-model: preset-scoped self-model tools (Sprint 13 / Part 2).
 * Consumes host `agint.selfModel.snapshot`/`update`/`calibrate`/`stats`/
 * `inspectSummary`; read-only observer per design §4.1 — does NOT mutate
 * qualityPolicy / mutator / population.
 *
 * Preset row (agent.cordis.yml):
 *   - id: agint-self-model-tools
 *     name: ../../profiles/web/plugins/agint-self-model/lib/tools.js
 *
 * Schema policy: K19 — `additionalProperties: true` on every nested object;
 * tighten after the first live call reveals the real shape (see
 * editing-cordis-compositions skill §K19).
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

/**
 * K20-fix (2026-09-11)：部分 Service 返回数组（CalibrationResult[]），而工具
 * output schema 恒为 K19 的 { type: 'object' } ⇒ 数组过不了 object 校验，
 * 工具 100% 报 `returned invalid output: "value" must be an object`。
 * 在工具边界规整为稳定的对象信封；Service 契约不变（smoke 仍断言返回数组）。
 */
function asObjectResult(value, key = 'entries') {
  if (Array.isArray(value)) return { [key]: value, count: value.length };
  if (value === null || value === undefined) return { [key]: [], count: 0 };
  return value;
}

const name = 'agint-self-model-tools';
const inject = ['tools', 'agint.selfModel.snapshot', 'agint.selfModel.update',
  'agint.selfModel.calibrate', 'agint.selfModel.stats', 'agint.selfModel.inspectSummary'];

function apply(ctx) {
  const snapshot = ctx['agint.selfModel.snapshot'];
  const update = ctx['agint.selfModel.update'];
  const calibrate = ctx['agint.selfModel.calibrate'];
  const stats = ctx['agint.selfModel.stats'];
  const inspectSummary = ctx['agint.selfModel.inspectSummary'];

  ctx.tools.register(defineTool({
    name: 'selfModel_snapshot',
    description:
      'Read the 智进 self-model snapshot (CAN/CANNOT/UNCERTAIN capability map + reasoning profile + resource baseline). ' +
      'Per AGENTS.md workflow step 8: call before answering when UNCERTAIN or lastVerifiedAt is stale — do NOT assume you can do something you cannot.',
    parameters: {
      domain: { type: 'string', description: 'Optional domain filter (e.g. "plugin", "skill").' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute(args) {
      return snapshot(args.domain ? { domain: args.domain } : undefined);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'selfModel_update',
    description:
      'Trigger a self-model refresh from a known event (e.g. diagnosis.completed, dream.completed). ' +
      'Updates capability map; does NOT mutate qualityPolicy / mutator / population.',
    parameters: {
      trigger: { type: 'string', required: true, description: 'Trigger event name (e.g. "diagnosis.completed").' },
      evidence: { type: 'object', additionalProperties: true, description: 'Trigger evidence payload.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: `selfModel_update: ok=${v.ok} updated=${(v.updatedDomains ?? []).length}` }],
    },
    execute(args) {
      return update({ trigger: args.trigger, evidence: args.evidence ?? {} });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'selfModel_calibrate',
    description:
      'Run per-domain calibration against observed evolution success rate (over a window). ' +
      'Returns CalibrationResult[] for downstream curriculum/transfer consumers.',
    parameters: {
      windowDays: { type: 'integer', description: 'Lookback window in days (default 7).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args) {
      return asObjectResult(await calibrate({ windowDays: args.windowDays ?? 7 }), 'results');
    },
  }));

  ctx.tools.register(defineTool({
    name: 'selfModel_stats',
    description: 'Auxiliary stats: counts of capability entries / calibration runs / observations.',
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
    name: 'selfModel_inspectSummary',
    description: 'Auxiliary inspection summary for health checks.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute() {
      return inspectSummary();
    },
  }));
}

export { apply, inject, name };