/**
 * agint-curator: preset-scoped tools（P0-2 §6，Sprint 14 阶段 1 的 10 个）。
 *
 * 门禁：P0-2 §6 要求 pin/unpin/archive/unarchive/run_now 为 ask 确认。当前
 * dsh 未见统一的工具级 ask 配置位（agint-rules 的 ask 是业务语义，非门禁），
 * 因此阶段 1 的做法是：写类工具的 description 首行显式标注「⚠️ 写操作 ·
 * 需人工确认」，并把人工确认落进 audit_log（actor 字段）。
 * 待 dsh 侧 approvals 机制可用后再接真实门禁——此处如实标注为未决项。
 *
 * Schema policy: K19 — additionalProperties: true；线上跑过再收紧。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'agint-curator-tools';
const inject = ['tools', 'agint.curator'];

function apply(ctx) {
  const svc = ctx['agint.curator'];

  ctx.tools.register(defineTool({
    name: 'curator_list',
    description:
      '列出技能及其策展状态（active/stale/archived/pinned）。**Read-only**。' +
      '数据来源：preset skills 目录扫描 + agint_tool_stats.jsonl 聚合的使用统计。',
    parameters: {
      state: { type: 'string', description: '按状态过滤：active/stale/archived/pinned；省略=全部' },
      protectedOnly: { type: 'boolean', description: '只看受保护技能' },
      query: { type: 'string', description: '按技能名模糊匹配' },
      limit: { type: 'number', description: '最多返回多少条（默认 50）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => {
        const list = v.skills ?? [];
        if (!list.length) return [{ type: 'text', text: 'curator_list: no skills yet' }];
        const lines = list.map((s) => {
          const last = s.usage?.lastUsedAt ? s.usage.lastUsedAt.slice(0, 10) : 'never';
          return `  ${s.skillName}  [${s.state}]  use=${s.usage?.useCount ?? 0}  last=${last}${s.protected ? '  protected' : ''}${s.cronReferenced ? '  cron' : ''}`;
        });
        return [{ type: 'text', text: `curator_list: ${list.length} skills\n${lines.join('\n')}` }];
      },
    },
    async execute(args) {
      const skills = await svc.listSkills({ ...args, limit: args.limit ?? 50 });
      return JSON.parse(JSON.stringify({ skills }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'curator_status',
    description: '策展系统状态：暂停/运行、上次运行时间、各状态技能数。**Read-only**。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{
        type: 'text',
        text: `curator_status: paused=${v.paused} lastRun=${v.lastRunAt ?? 'never'}\n  states: ${JSON.stringify(v.skills?.byState ?? {})}\n  archivedThisWeek: ${v.archivedThisWeek}/${v.config?.weekly_archive_budget}`,
      }],
    },
    execute() {
      return svc.stats().then((s) => JSON.parse(JSON.stringify(s)));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'curator_stats',
    description: '策展统计：各状态数量/受保护数/本周动作数/表上限。**Read-only**。周复盘可直接引用。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute() {
      return svc.stats().then((s) => JSON.parse(JSON.stringify(s)));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'curator_get_skill',
    description: '获取单个技能的策展详情（状态/使用统计/状态历史/保护位）。**Read-only**。',
    parameters: {
      skillName: { type: 'string', description: '技能名（SKILL.md frontmatter 的 name）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => v.skill
        ? [{ type: 'text', text: `curator_get_skill: ${v.skill.skillName}\n${JSON.stringify(v.skill, null, 2)}` }]
        : [{ type: 'text', text: 'curator_get_skill: not found' }],
    },
    async execute(args) {
      if (!args.skillName) throw new Error('curator_get_skill: skillName is required');
      const skill = await svc.getSkill(args.skillName);
      return JSON.parse(JSON.stringify({ skill }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'curator_pin',
    description:
      '⚠️ 写操作 · 需人工确认：固定技能（state=pinned，永不参与任何自动转换，包括归档）。',
    parameters: {
      skillName: { type: 'string', description: '技能名' },
      reason: { type: 'string', description: '固定原因（写进审计）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: `curator_pin: ${v.result} — ${v.reason}` }],
    },
    async execute(args) {
      if (!args.skillName) throw new Error('curator_pin: skillName is required');
      return svc.pin({ skillName: args.skillName, reason: args.reason ?? 'manual pin', actor: 'human' });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'curator_unpin',
    description: '⚠️ 写操作 · 需人工确认：取消固定（pinned → active，重新纳入自动策展）。',
    parameters: {
      skillName: { type: 'string', description: '技能名' },
      reason: { type: 'string', description: '取消固定原因' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: `curator_unpin: ${v.result} — ${v.reason}` }],
    },
    async execute(args) {
      if (!args.skillName) throw new Error('curator_unpin: skillName is required');
      return svc.unpin({ skillName: args.skillName, reason: args.reason ?? 'manual unpin', actor: 'human' });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'curator_archive',
    description:
      '⚠️ 写操作 · 需人工确认：手动归档技能（移动到 skills/.archive/，从 Prompt 移除，可恢复）。' +
      '受保护/pinned/cron-referenced 的技能会被跳过；本周归档预算用尽也会跳过。',
    parameters: {
      skillName: { type: 'string', description: '技能名' },
      reason: { type: 'string', description: '归档原因（写进审计与报告）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: `curator_archive: ${v.result} — ${v.reason}` }],
    },
    async execute(args) {
      if (!args.skillName) throw new Error('curator_archive: skillName is required');
      return svc.archive({
        skillName: args.skillName, reason: args.reason ?? 'manual archive',
        actor: 'human', trigger: 'manual', allowPinned: false,
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'curator_unarchive',
    description: '⚠️ 写操作 · 需人工确认：恢复已归档技能（.archive/ → skills/，archived → active）。',
    parameters: {
      skillName: { type: 'string', description: '技能名' },
      reason: { type: 'string', description: '恢复原因' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: `curator_unarchive: ${v.result} — ${v.reason}` }],
    },
    async execute(args) {
      if (!args.skillName) throw new Error('curator_unarchive: skillName is required');
      return svc.unarchive({ skillName: args.skillName, reason: args.reason ?? 'manual unarchive', actor: 'human' });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'curator_run_now',
    description:
      '⚠️ 写操作 · 需人工确认：立即跑一次完整策展（扫描 → 聚合 → 状态转换 → 归档 → 报告）。' +
      '会真实归档陈旧技能并移动目录；只想预览请用 curator_dry_run。',
    parameters: {
      force: { type: 'boolean', description: '暂停状态下强制执行（默认 false）' },
      reason: { type: 'string', description: '触发原因（写进审计）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{
        type: 'text',
        text: v.skipped
          ? `curator_run_now: skipped — ${v.reason}`
          : `curator_run_now: ${v.week ?? ''} stale=${v.applied?.staled?.length ?? 0} archived=${v.applied?.archived?.length ?? 0} reactivated=${v.applied?.reactivated?.length ?? 0}`,
      }],
    },
    async execute(args) {
      return svc.run({ trigger: 'manual', force: args.force === true, dryRun: false, actor: 'human' });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'curator_dry_run',
    description:
      '试运行策展：与真实执行走同一条计算路径，输出完全一致，但**不落盘、不移动目录**。' +
      '**Read-only**。首次挂载建议先跑这个。',
    parameters: {
      persistReport: { type: 'boolean', description: '是否把 dry-run 报告也存进 reports 表（默认 false）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => {
        const r = v.report ?? {};
        const s = r.summary ?? {};
        return [{
          type: 'text',
          text: `curator_dry_run: ${r.week ?? ''}\n  将转 stale: ${s.newlyStale ?? 0}\n  将归档: ${s.newlyArchived ?? 0}\n  将恢复: ${s.reactivated ?? 0}\n  跳过: ${s.skipped ?? 0}\n${(r.recommendations ?? []).map((x) => `  * ${x}`).join('\n')}`,
        }];
      },
    },
    async execute(args) {
      const r = await svc.dryRun({ persistDryRunReport: args.persistReport === true });
      return JSON.parse(JSON.stringify(r));
    },
  }));

  // ── Sprint 15 新增（P0-2 §6：overlaps/declining/get_report）────────────

  ctx.tools.register(defineTool({
    name: 'curator_list_overlaps',
    description:
      '列出重叠候选对（三维度检测：描述≥0.85 / 工具≥0.7 / 触发词≥0.6，≥2 维达标），' +
      '含推荐动作（保留高频/高质量，归档另一个）。**Read-only**。',
    parameters: {
      status: { type: 'string', description: '按状态过滤：proposed/acknowledged/resolved；省略=全部' },
      limit: { type: 'number', description: '最多返回多少条（默认 50）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => {
        const list = v.overlaps ?? [];
        if (!list.length) return [{ type: 'text', text: 'curator_list_overlaps: 无重叠候选' }];
        const lines = list.map((o) => `  ${o.skillA} ↔ ${o.skillB}  [${o.dims?.dimsMet ?? '?'}/3 维]  ${o.recommendation?.rationale ?? ''}`);
        return [{ type: 'text', text: `curator_list_overlaps: ${list.length} 对\n${lines.join('\n')}` }];
      },
    },
    async execute(args) {
      const overlaps = await svc.listOverlaps({ ...args, limit: args.limit ?? 50 });
      return JSON.parse(JSON.stringify({ overlaps }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'curator_list_declining',
    description:
      '列出质量下降技能（成功率连续 2 周降>10% 或 HARM 连续 2 次<0）。**Read-only**。' +
      '含趋势详情与 review 建议标记。',
    parameters: {
      onlyReviewSuggested: { type: 'boolean', description: '只看质量保护（规则 3）标记为需人工审查的' },
      limit: { type: 'number', description: '最多返回多少条（默认 50）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => {
        const list = v.declining ?? [];
        if (!list.length) return [{ type: 'text', text: 'curator_list_declining: 无质量下降技能' }];
        const lines = list.map((s) => `  ${s.skillName}  [${s.state}]  success=${s.quality?.successTrend?.state ?? '?'}  harm=${s.quality?.harmTrend?.state ?? '?'}${s.quality?.reviewSuggested ? '  [review]' : ''}`);
        return [{ type: 'text', text: `curator_list_declining: ${list.length} 个\n${lines.join('\n')}` }];
      },
    },
    async execute(args) {
      const declining = await svc.listDeclining({ ...args, limit: args.limit ?? 50 });
      return JSON.parse(JSON.stringify({ declining }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'curator_get_report',
    description:
      '获取指定周的策展报告（统计/stale/归档/质量下降/重叠/建议）。**Read-only**。' +
      '省略 week 参数返回最新一份。',
    parameters: {
      week: { type: 'string', description: 'ISO 周，如 2026-W37；省略=最新' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => v.report
        ? [{ type: 'text', text: `curator_get_report ${v.report.week}\n${JSON.stringify(v.report, null, 2)}` }]
        : [{ type: 'text', text: 'curator_get_report: 无该周报告' }],
    },
    async execute(args) {
      const report = await svc.getReport(args.week);
      return JSON.parse(JSON.stringify({ report }));
    },
  }));
}

export { apply, inject, name };
