/**
 * agint-metrics: preset-scoped tools (metrics_collect / metrics_series /
 * metrics_summary). Consumes the host `agint.metrics` service; registered from
 * the agint preset family so only 智进 sessions see these tools.
 *
 * Preset row (agent.cordis.yml):
 *   - id: agint-metrics-tools
 *     name: ../../plugins/agint-metrics/lib/tools.js
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'agint-metrics-tools';
const inject = ['tools', 'agint.metrics'];

function apply(ctx) {
  const metrics = ctx['agint.metrics'];

  ctx.tools.register(defineTool({
    name: 'metrics_collect',
    description:
      '采集一次 智进 进化指标（盲区/门禁遵守率/wiki 健康/记忆规模），写入 kv 时间序列。' +
      '每日由 cron 自动执行；手动调用用于即时快照。返回本次采集到的全部指标。',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          collectedAt: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          collected: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { key: { type: 'string' }, value: { type: 'number' }, unit: { type: 'string' }, ts: { type: 'string' } } } },
        },
      },
      render: (_a, v) => [
        { type: 'text', text: `metrics_collect: ${v.count} 项指标已写入（${v.collectedAt}）\n${v.collected.map((m) => `  ${m.key} = ${m.value}${m.unit === 'pct' ? '%' : m.unit === 'days' ? '天' : m.unit === 'count' ? '个' : ''}`).join('\n')}` },
      ],
    },
    execute() {
      return metrics.collect();
    },
  }));

  ctx.tools.register(defineTool({
    name: 'metrics_summary',
    description:
      '查看 智进 进化指标最新值（每项指标一条，含与上一次采集的差值 delta，正数=恶化，负数=改善）。' +
      '用于自检：先看这里，再决定是否需要采取行动。',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          asOf: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          metrics: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                label: { type: 'string', required: true },
                value: { type: 'number', required: true },
                unit: { type: 'string', required: true },
                ts: { type: 'string', required: true },
                delta: { oneOf: [{ type: 'number' }, { type: 'null' }] },
              },
            },
          },
        },
      },
      render: (_a, v) => {
        if (v.count === 0) return [{ type: 'text', text: 'metrics_summary: 尚无指标，先运行 metrics_collect' }];
        const lines = [`metrics_summary: ${v.count} 项指标（截至 ${v.asOf}）`];
        for (const m of v.metrics) {
          const unit = m.unit === 'pct' ? '%' : m.unit === 'days' ? '天' : m.unit === 'count' ? '个' : '';
          const trend = m.delta === null ? '' : (m.delta === 0 ? ' (持平)' : (m.delta > 0 ? ` (↑ +${m.delta}${unit})` : ` (↓ ${m.delta}${unit})`));
          lines.push(`  ${m.key} = ${m.value}${unit}${trend}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute() {
      return metrics.summary();
    },
  }));

  ctx.tools.register(defineTool({
    name: 'metrics_series',
    description:
      '查看某个指标的时间序列（默认最近 30 天，按时间升序）。用于观察趋势：指标是否持续恶化、改善是否保持。',
    parameters: {
      key: { type: 'string', required: true, description: '指标 key（如 cron.staleJobs / rules.adherencePct / wiki.brokenLinks），先用 metrics_summary 看有哪些' },
      days: { type: 'integer', description: '回溯天数（默认 30）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          key: { type: 'string', required: true },
          label: { type: 'string', required: true },
          unit: { type: 'string', required: true },
          points: {
            type: 'array', required: true,
            items: {
              // series() stores JSON-stringified meta on each point (see
              // agint-metrics/lib/index.js series() — `meta: rec.meta`).
              type: 'object', additionalProperties: false,
              properties: {
                ts: { type: 'string', required: true },
                value: { type: 'number', required: true },
                meta: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_a, v) => {
        if (v.points.length === 0) return [{ type: 'text', text: `metrics_series: ${v.key} 暂无数据` }];
        const lines = [`metrics_series: ${v.label} (${v.key}) — ${v.points.length} 个采样点`];
        for (const p of v.points.slice(-15)) lines.push(`  ${p.ts.slice(0, 16)}  ${p.value}${v.unit === 'pct' ? '%' : v.unit === 'days' ? '天' : v.unit === 'count' ? '个' : ''}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute(args) {
      return metrics.series(args.key, { days: args.days });
    },
  }));
}

export { apply, inject, name };
