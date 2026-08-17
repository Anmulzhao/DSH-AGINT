/**
 * agint-dream: preset-scoped tools (dream_status / dream_run_now / dream_diary).
 * Consumes the host agint.dream service.
 *
 * Preset row (agent.cordis.yml):
 *   - id: agint-dream-tools
 *     name: ../../plugins/agint-dream/lib/tools.js
 *
 * NOTE on schemas: the value-schema DSL collects requiredness from per-field
 * `required: true` booleans inside an object's properties; root and nested
 * value nodes (oneOf branches, array items) must NOT declare `required`.
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'agint-dream-tools';
const inject = ['tools', 'agint.dream'];

function apply(ctx) {
  const dream = ctx['agint.dream'];

  ctx.tools.register(defineTool({
    name: 'dream_status',
    description: '梦境服务状态：开关、频率、阈值、上次 sweep 时间与计数。查看梦境是否在工作。',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          enabled: { type: 'boolean', required: true },
          frequency: { type: 'string', required: true },
          sessionsRoot: { type: 'string', required: true },
          diaryRoot: { type: 'string', required: true },
          lookbackDays: { type: 'number', required: true },
          windows: {
            type: 'object', additionalProperties: false, required: true,
            properties: {
              light: { type: 'number', required: true },
              rem: { type: 'number', required: true },
              deep: { type: 'number', required: true },
            },
          },
          recover: { type: 'boolean', required: true },
          thresholds: {
            type: 'object', additionalProperties: false, required: true,
            properties: {
              minScore: { type: 'number', required: true },
              minRecall: { type: 'number', required: true },
              minUniqueSessions: { type: 'number', required: true },
            },
          },
          lastSweepAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          lastError: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          counts: {
            type: 'object', additionalProperties: false, required: true,
            properties: {
              sessions: { type: 'number', required: true },
              userMessages: { type: 'number', required: true },
              memWrites: { type: 'number', required: true },
              toolErrors: { type: 'number', required: true },
              candidates: { type: 'number', required: true },
              gated: { type: 'number', required: true },
              recovered: { type: 'number', required: true },
              promoted: { type: 'number', required: true },
            },
          },
        },
      },
      render: (_a, v) => {
        const lines = [
          `dream_status: ${v.enabled ? 'enabled' : 'disabled'} · 频率 ${v.frequency}`,
          `  sessions=${v.sessionsRoot}`,
          `  diary=${v.diaryRoot} · 窗口 Light ${v.windows.light}d / REM ${v.windows.rem}d / Deep ${v.windows.deep}d${v.recover ? ' · 恢复通道开' : ''}`,
          `  阈值 minScore=${v.thresholds.minScore} minRecall=${v.thresholds.minRecall} minUniqueSessions=${v.thresholds.minUniqueSessions}`,
          `  lastSweep=${v.lastSweepAt ?? 'never'}${v.lastError ? ' · ERROR: ' + v.lastError : ''}`,
        ];
        if (v.counts) lines.push(`  counts: sessions=${v.counts.sessions} userMsgs=${v.counts.userMessages} memWrites=${v.counts.memWrites} toolErrors=${v.counts.toolErrors} candidates=${v.counts.candidates} gated=${v.counts.gated} recovered=${v.counts.recovered} promoted=${v.counts.promoted}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute() {
      return dream.status();
    },
  }));

  ctx.tools.register(defineTool({
    name: 'dream_run_now',
    description: '手动触发一次梦境 sweep。默认只预览（dry-run：评分+写梦境日记，不写记忆）；apply=true 才把门槛通过的候选提升进长期记忆。用于测试、补做或审查。',
    parameters: {
      apply: { type: 'boolean', description: 'true=真正提升进记忆（默认 false 预览）。' },
      lookbackDays: { type: 'number', description: 'Light 窗口覆盖（默认按服务配置）。' },
      remLookbackDays: { type: 'number', description: 'REM 窗口覆盖（默认按服务配置）。' },
      deepRecoveryDays: { type: 'number', description: 'Deep 恢复窗口覆盖（默认按服务配置）。' },
      recover: { type: 'boolean', description: '是否启用 Deep 30 天恢复通道（默认按服务配置）。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          day: { type: 'string', required: true },
          diaryPath: { type: 'string', required: true },
          apply: { type: 'boolean', required: true },
          counts: {
            type: 'object', additionalProperties: false, required: true,
            properties: {
              sessions: { type: 'number', required: true },
              userMessages: { type: 'number', required: true },
              memWrites: { type: 'number', required: true },
              toolErrors: { type: 'number', required: true },
              candidates: { type: 'number', required: true },
              gated: { type: 'number', required: true },
              recovered: { type: 'number', required: true },
              promoted: { type: 'number', required: true },
            },
          },
          promoted: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                type: { type: 'string', required: true },
                content: { type: 'string', required: true },
                score: { type: 'number', required: true },
                id: { type: 'string', required: true },
              },
            },
          },
          errors: { type: 'array', required: true, items: { type: 'string' } },
          durationMs: { type: 'number', required: true },
        },
      },
      render: (_a, v) => {
        const lines = [
          `dream_run_now: ${v.apply ? 'APPLIED' : 'dry-run preview'} · day=${v.day} · ${(v.durationMs / 1000).toFixed(1)}s`,
          `  sessions=${v.counts.sessions} userMsgs=${v.counts.userMessages} memWrites=${v.counts.memWrites} errors=${v.counts.toolErrors}`,
          `  candidates=${v.counts.candidates} gated=${v.counts.gated} promoted=${v.counts.promoted}`,
          `  diary=${v.diaryPath}`,
        ];
        for (const p of v.promoted) lines.push(`  ↑ [${p.type}] (${p.score.toFixed(2)}) ${p.content.slice(0, 80)}`);
        for (const e of v.errors) lines.push(`  ! ${e}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute(args) {
      return dream.sweep({
        apply: Boolean(args.apply),
        lookbackDays: args.lookbackDays,
        remLookbackDays: args.remLookbackDays,
        deepRecoveryDays: args.deepRecoveryDays,
        recover: args.recover,
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'dream_diary',
    description: '读取梦境日记（默认最近一天；可指定 YYYY-MM-DD）。用于审阅梦境提炼了什么、提升了什么。',
    parameters: {
      date: { type: 'string', description: '日期 YYYY-MM-DD，缺省=最近一天。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          path: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          content: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        },
      },
      render: (_a, v) => v.path
        ? [{ type: 'text', text: `dream_diary: ${v.path}\n\n${v.content.slice(0, 3000)}` }]
        : [{ type: 'text', text: 'dream_diary: no diary yet' }],
    },
    execute(args) {
      return dream.diary(args.date);
    },
  }));
}

export { apply, inject, name };
