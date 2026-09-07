/**
 * agint-skill-autocreate: preset-scoped tools（设计稿 §6）。
 *
 * Sprint 14 只交付 3 个 read-only 裸调工具（§12.1）：
 *   autocreate_list_patterns / autocreate_list_candidates / autocreate_stats
 * 写类工具（reject/modify/trigger_eval/release/rollback/pause/resume）随
 * Sprint 15/16 状态机与发布层一起上，届时按门禁要求配 ask 确认。
 *
 * Schema policy: K19 — additionalProperties: true；线上跑过再收紧。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'agint-skill-autocreate-tools';
const inject = ['tools', 'agint.skillAutocreate'];

function apply(ctx) {
  const svc = ctx['agint.skillAutocreate'];

  ctx.tools.register(defineTool({
    name: 'autocreate_list_patterns',
    description:
      '列出技能自动创建机制检测到的重复任务模式（按出现次数降序）。' +
      '**Read-only**。数据来源：每日 cron 聚合 agint_tool_stats.jsonl 的任务级模式。',
    parameters: {
      status: { type: 'string', description: '按状态过滤：active/candidate/proposed/released/dismissed；省略=全部' },
      repeatedOnly: { type: 'boolean', description: '只看已跨重复门槛（≥min_occurrence_count）的模式' },
      limit: { type: 'number', description: '最多返回多少条（默认 20）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => {
        const list = v.patterns ?? [];
        if (!list.length) return [{ type: 'text', text: 'autocreate_list_patterns: no patterns yet' }];
        const lines = list.map((p) =>
          `  ${p.id}  x${p.occurrenceCount}  [${p.status}]  ${(p.toolSequence ?? []).join(' → ')}`);
        return [{ type: 'text', text: `autocreate_list_patterns: ${list.length} patterns\n${lines.join('\n')}` }];
      },
    },
    async execute(args) {
      const patterns = await svc.listPatterns({ ...args, limit: args.limit ?? 20 });
      return JSON.parse(JSON.stringify({ patterns }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'autocreate_list_candidates',
    description:
      '列出自动生成的技能候选提案（含 SKILL.md 草稿状态）。' +
      '**Read-only**。当前为 Sprint 14 检测层：候选生成后停在 PENDING_EVAL，等 Sprint 15 接 D-QAF。',
    parameters: {
      status: { type: 'string', description: '按状态过滤（PENDING_EVAL / REJECTED_STATIC / ...）；省略=全部' },
      limit: { type: 'number', description: '最多返回多少条（默认 20）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => {
        const list = v.candidates ?? [];
        if (!list.length) return [{ type: 'text', text: 'autocreate_list_candidates: no candidates yet' }];
        const lines = list.map((c) =>
          `  ${c.id}  [${c.status}]  ${c.skillDraft?.name ?? '?'}（模板 ${c.skillDraft?.template ?? '?'}）`);
        return [{ type: 'text', text: `autocreate_list_candidates: ${list.length} candidates\n${lines.join('\n')}` }];
      },
    },
    async execute(args) {
      const candidates = await svc.listCandidates({ ...args, limit: args.limit ?? 20 });
      return JSON.parse(JSON.stringify({ candidates }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'autocreate_stats',
    description:
      '技能自动创建统计：模式数/候选数（各状态分布）/暂停状态/当前配置。' +
      '**Read-only**。周复盘可直接引用。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute() {
      return svc.stats().then((s) => JSON.parse(JSON.stringify(s)));
    },
  }));
}

export { apply, inject, name };
