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
          recallPath: { type: 'string', required: true },
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
              skippedPromoted: { type: 'number', required: true },
              validationOk: { type: 'boolean', required: true },
              validationReason: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
              recovered: { type: 'number', required: true },
              promoted: { type: 'number', required: true },
              recallAppended: { type: 'number', required: true },
              recallPruned: { type: 'number', required: true },
            },
          },
        },
      },
      render: (_a, v) => {
        const lines = [
          `dream_status: ${v.enabled ? 'enabled' : 'disabled'} · 频率 ${v.frequency}`,
          `  sessions=${v.sessionsRoot}`,
          `  diary=${v.diaryRoot} · 窗口 Light ${v.windows.light}d / REM ${v.windows.rem}d / Deep ${v.windows.deep}d${v.recover ? ' · 恢复通道开' : ''}`,
          `  recall=${v.recallPath ?? 'n/a'}`,
          `  阈值 minScore=${v.thresholds.minScore} minRecall=${v.thresholds.minRecall} minUniqueSessions=${v.thresholds.minUniqueSessions}`,
          `  lastSweep=${v.lastSweepAt ?? 'never'}${v.lastError ? ' · ERROR: ' + v.lastError : ''}`,
        ];
        if (v.counts) lines.push(`  counts: sessions=${v.counts.sessions} userMsgs=${v.counts.userMessages} memWrites=${v.counts.memWrites} toolErrors=${v.counts.toolErrors} candidates=${v.counts.candidates} gated=${v.counts.gated} skippedPromoted=${v.counts.skippedPromoted} recovered=${v.counts.recovered} promoted=${v.counts.promoted} recallAppended=${v.counts.recallAppended} recallPruned=${v.counts.recallPruned}`);
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
              skippedPromoted: { type: 'number', required: true },
              validationOk: { type: 'boolean', required: true },
              validationReason: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
              recovered: { type: 'number', required: true },
              promoted: { type: 'number', required: true },
              recallAppended: { type: 'number', required: true },
              recallPruned: { type: 'number', required: true },
              // P1 LLM consolidation mode（llm / heuristic-degraded）
              consolidationMode: { type: 'string', required: true },
              consolidationReason: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
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
          `  candidates=${v.counts.candidates} gated=${v.counts.gated} skippedPromoted=${v.counts.skippedPromoted} promoted=${v.counts.promoted}`,
          `  validation=${v.counts.validationOk ? 'OK' : 'REJECTED' + (v.counts.validationReason ? ': ' + v.counts.validationReason : '')}`,
          `  consolidation=${v.counts.consolidationMode}${v.counts.consolidationReason ? ' (' + v.counts.consolidationReason + ')' : ''}`,
          `  recall: appended=${v.counts.recallAppended} pruned=${v.counts.recallPruned}`,
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

  // P2 (Sprint 13 / 2026-09-05)：recall store inspection tool
  // 让老板 / 智进能直接看 store 内容（debug / 验证时方便）
  ctx.tools.register(defineTool({
    name: 'recall_store_inspect',
    description: '查 short-term recall store 内容。Sprint 13 引入的 P2 inspection 工具。用于 debug / 验证：看哪些候选被累积、是否 promoted、跨日 recallCount 等。',
    parameters: {
      key: { type: 'string', description: '模糊查（按 snippet 文本或 key 包含）' },
      type: { type: 'string', description: '按 type 过滤：preference / decision / lesson / pattern' },
      since: { type: 'string', description: '起始时间（ISO 字符串）' },
      until: { type: 'string', description: '结束时间（ISO 字符串）' },
      limit: { type: 'number', description: '限制返回条数（默认 20）' },
      json: { type: 'boolean', description: 'true=JSON 输出，false=表格（默认）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          skippedPartial: { type: 'number', required: true },
          totalLines: { type: 'number', required: true },
          rows: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: true,
              properties: {
                key: { type: 'string' },
                snippet: { type: 'string' },
                sourceType: { type: 'string' },
                recallCount: { type: 'number' },
                recallDays: { type: 'array', items: { type: 'string' } },
                lastRecalledAt: { type: 'string' },
                promotedAt: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                lineageKey: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                score: { oneOf: [{ type: 'number' }, { type: 'null' }] },
              },
            },
          },
        },
      },
      render: (_a, v) => {
        if (v.rows.length === 0) {
          return [{ type: 'text', text: `recall_store_inspect: empty (total=${v.total}, skippedPartial=${v.skippedPartial}, totalLines=${v.totalLines})` }];
        }
        const lines = [
          `recall_store_inspect: total=${v.total} showing ${v.rows.length} (skippedPartial=${v.skippedPartial}, totalLines=${v.totalLines})`,
          '',
          '| key(8) | type | score | recallCount | days | lastRecalledAt | promoted | lineage |',
          '|---|---|---|---|---|---|---|---|',
        ];
        for (const r of v.rows) {
          const keyShort = (r.key || '').slice(0, 8);
          const promoted = r.promotedAt ? '✓' : '';
          const lineage = r.lineageKey || '';
          const days = (r.recallDays || []).length;
          const lastR = r.lastRecalledAt ? r.lastRecalledAt.slice(0, 10) : '';
          const snippet = (r.snippet || '').replace(/\|/g, '\\|').slice(0, 60);
          lines.push(`| ${keyShort} | ${r.sourceType || ''} | ${(r.score || 0).toFixed(2)} | ${r.recallCount || 0} | ${days} | ${lastR} | ${promoted} | ${lineage} | ${snippet} |`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute(args) {
      if (args.json) {
        return dream.inspectRecall({
          key: args.key,
          type: args.type,
          since: args.since,
          until: args.until,
          limit: args.limit,
        });
      }
      return dream.inspectRecall({
        key: args.key,
        type: args.type,
        since: args.since,
        until: args.until,
        limit: args.limit,
      });
    },
  }));

  // P1 (Sprint 14 / 2026-09-05)：LLM consolidation 独立验证工具。
  // 在 host plane 真调 ctx.agents.create() + ctx.subagents.start('spawn', {outputSchema})，
  // 不依赖 sweep 主体，不写 agint.memory。消耗 1 次 LLM call —— 验证 host 端 DSH
  // subagent runtime 通路是否真可用（设计文档第一步）。
  ctx.tools.register(defineTool({
    name: 'dream_verify_consolidation',
    description: 'P1 验证工具：跑一次 minimal LLM consolidation。消耗 1 次 LLM call，验证 DSH host 端 ctx.agents / ctx.subagents 通路是否真可用。不写 agint.memory，仅返回 schema-validated structured result。设计文档第一步要求的"独立验证脚本"。',
    parameters: {
      provider: { type: 'string', description: 'LLM provider（默认 settings.yaml agent-default-model：minimax-cn）' },
      model: { type: 'string', description: 'model id（默认 MiniMax-M3）' },
      timeoutMs: { type: 'number', description: 'subagent 超时（默认 60000）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true },
          operations: {
            oneOf: [
              { type: 'array',
                items: {
                  type: 'object', additionalProperties: true,
                  properties: {
                    candidateKey: { type: 'string' },
                    action: { type: 'string' },
                    priorEntries: { type: 'array', items: { type: 'string' } },
                    lineageKey: { type: 'string' },
                  },
                },
              },
              { type: 'null' },
            ],
            required: true,
          },
          operationsLength: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
          gatedLength: { type: 'number', required: true },
          reason: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          diagnostic: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          childErrors: {
            oneOf: [
              { type: 'array',
                items: {
                  type: 'object', additionalProperties: true,
                  properties: {
                    turn: { type: 'number' },
                    step: { type: 'number' },
                    error: { type: 'string' },
                  },
                },
              },
              { type: 'null' },
            ],
            required: true,
          },
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
          day: { type: 'string', required: true },
          schemaOk: { type: 'boolean', required: true },
        },
      },
      render(_a, v) {
        const ops = Array.isArray(v.operations) ? v.operations : [];
        const lines = [
          `dream_verify_consolidation: mode=${v.mode} · schemaOk=${v.schemaOk}`,
          `  provider=${v.provider} model=${v.model} day=${v.day}`,
          `  gatedLength=${v.gatedLength} operationsLength=${v.operationsLength ?? 'null'}`,
          `  reason=${v.reason ?? '(none)'}`,
        ];
        if (v.diagnostic) lines.push(`  diagnostic: ${v.diagnostic.slice(0, 200)}`);
        if (Array.isArray(v.childErrors) && v.childErrors.length > 0) {
          for (let i = 0; i < v.childErrors.length; i += 1) {
            const ce = v.childErrors[i];
            lines.push(`  childErr[${i}] turn=${ce.turn ?? '?'} step=${ce.step ?? '?'}`);
            const errMsg = (ce.error || '').split('\n').slice(0, 6).join('\n    ');
            lines.push(`    ${errMsg}`);
          }
        }
        for (let i = 0; i < ops.length; i += 1) {
          const op = ops[i];
          lines.push(`  op[${i}] action=${op.action} candidateKey=${op.candidateKey?.slice(0, 12)}... lineage=${op.lineageKey ?? '-'} priorEntries=${(op.priorEntries || []).length}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute(args) {
      return dream.verifyConsolidation({
        provider: args.provider,
        model: args.model,
        timeoutMs: args.timeoutMs,
      });
    },
  }));
}

export { apply, inject, name };
