/**
 * agint-quality-eval: preset-scoped model-facing tools (D-QAF evaluator).
 *
 * Consumes the host `agint.qualityEvaluator` service (registered from
 * profiles/web/cordis.patch.yml as a host row). Exposes two tools:
 *   - quality_eval_status  zero-side-effect snapshot (next fire / last run / weights)
 *   - quality_eval_run_now triggers the weekly scheduler immediately
 *
 * Per editing-cordis-compositions: consumer pattern, no isolate realm.
 * Schemas use additionalProperties:true (per K19) because the host service
 * returns dynamic shapes we cannot fully pre-declare.
 *
 * Preset row (agent.agint.yml):
 *   - id: agint-quality-eval-tools
 *     name: ../../profiles/web/plugins/agint-quality/agint-quality-eval/lib/tools.js
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'agint-quality-eval-tools';
const inject = ['tools', 'agint.qualityEvaluator'];

function apply(ctx) {
  const evaluator = ctx['agint.qualityEvaluator'];

  // ── quality_eval_status ────────────────────────────────────────────────────
  // Zero-side-effect: read nextFire / lastRun / weights / dimensionKeys.
  // Safe to call any time — does NOT trigger an evaluation.
  ctx.tools.register(defineTool({
    name: 'quality_eval_status',
    description:
      '查看 D-QAF 评估引擎当前状态：下次自动触发时间、最近一次评估结果、维度权重。' +
      '零副作用——不触发评估。典型用法：跑周评估前先看一眼 lastRun 是否还新鲜。',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          nextFire: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          lastRun: { type: 'object', required: true, additionalProperties: true },
          weights: { type: 'object', required: true, additionalProperties: true },
          dimensionKeys: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_a, v) => [{
        type: 'text',
        text: [
          `quality_eval_status:`,
          `  nextFire:      ${v.nextFire ?? '<not scheduled>'}`,
          `  lastRun:       ${v.lastRun ? JSON.stringify(v.lastRun) : '<never>'}`,
          `  weights:       ${JSON.stringify(v.weights)}`,
          `  dimensionKeys: ${v.dimensionKeys.join(', ')}`,
        ].join('\n'),
      }],
    },
    execute() {
      const nextFire = typeof evaluator.nextFire === 'function' ? evaluator.nextFire() : null;
      const lastRun = typeof evaluator.lastRun === 'function' ? evaluator.lastRun() : null;
      return {
        nextFire: nextFire ? new Date(nextFire).toISOString() : null,
        lastRun: lastRun ?? null,
        weights: evaluator.weights ?? {},
        dimensionKeys: evaluator.dimensionKeys ?? [],
      };
    },
  }));

  // ── quality_eval_run_now ───────────────────────────────────────────────────
  // Side-effect: forces a weekly-scheduler tick. Writes to memory (decision
  // records per target). ASK-gated by agint-rules — see rule_check before call.
  ctx.tools.register(defineTool({
    name: 'quality_eval_run_now',
    description:
      '手动触发 D-QAF 周评估（强制跑一次，会写入 agint.memory 作为历史）。' +
      '副作用：会产生 decision 类型 memory 条目 + event bus evolution.evaluated 边。' +
      '被 rule 门禁为 ask 级别——调用前先 rule_check 确认。',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          triggered: { type: 'boolean', required: true },
          detail: { type: 'object', required: true, additionalProperties: true },
        },
      },
      render: (_a, v) => [{
        type: 'text',
        text: v.triggered
          ? `quality_eval_run_now: triggered\n${JSON.stringify(v.detail, null, 2)}`
          : `quality_eval_run_now: skipped — ${v.detail?.reason ?? 'unknown'}`,
      }],
    },
    async execute() {
      if (typeof evaluator.runNow !== 'function') {
        return { triggered: false, detail: { reason: 'runNow() not available on evaluator' } };
      }
      try {
        const result = await evaluator.runNow();
        return { triggered: true, detail: result ?? { note: 'runNow returned no detail' } };
      } catch (err) {
        return { triggered: false, detail: { reason: err?.message ?? String(err) } };
      }
    },
  }));
}

export { apply, inject, name };