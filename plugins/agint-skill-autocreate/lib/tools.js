/**
 * agint-skill-autocreate: preset-scoped tools（设计稿 §6）。
 *
 * Sprint 14 交付 3 个 read-only 裸调工具（§12.1）；Sprint 15 评估层新增：
 *   autocreate_trigger_eval（write，需人工确认门禁——由 agint-rules 的
 *     advisory/ask/deny 三档统一接管，本插件只负责注册）
 *   autocreate_get_candidate（read，候选详情含评估结果）
 *   autocreate_list_candidates 增强（evidenceLevel / provisional 过滤）
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
      '列出自动生成的技能候选提案（含评估结果）。' +
      '**Read-only**。Sprint 15 起支持按 status / evidenceLevel / provisional 过滤。',
    parameters: {
      status: { type: 'string', description: '按状态过滤（PENDING_EVAL / PHASE3_PASS / REJECTED_STATIC / ...）；省略=全部' },
      evidenceLevel: { type: 'string', description: '按 Phase 3 证据级别过滤：E0（无可执行物）/ E1（沙箱实测）' },
      provisional: { type: 'boolean', description: '只看 provisional 候选（Sprint 16 观察期前均为 true）' },
      limit: { type: 'number', description: '最多返回多少条（默认 20）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => {
        const list = v.candidates ?? [];
        if (!list.length) return [{ type: 'text', text: 'autocreate_list_candidates: no candidates yet' }];
        const lines = list.map((c) => {
          const p3 = c.evalResults?.phase3;
          const suffix = p3 ? `  r=${p3.rankingScore ?? '-'}  [${p3.evidenceLevel ?? '-'}]${p3.provisional ? ' provisional' : ''}` : '';
          return `  ${c.id}  [${c.status}]  ${c.skillDraft?.name ?? '?'}（模板 ${c.skillDraft?.template ?? '?'}）${suffix}`;
        });
        return [{ type: 'text', text: `autocreate_list_candidates: ${list.length} candidates\n${lines.join('\n')}` }];
      },
    },
    async execute(args) {
      const candidates = await svc.listCandidates({ ...args, limit: args.limit ?? 20 });
      return JSON.parse(JSON.stringify({ candidates }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'autocreate_get_candidate',
    description:
      '读取单个技能候选详情（含 SKILL.md 草稿、预估收益、三阶段评估结果）。' +
      '**Read-only**。',
    parameters: {
      id: { type: 'string', description: '候选 id（autocreate_list_candidates 返回的 id）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => {
        const c = v.candidate;
        if (!c) return [{ type: 'text', text: `autocreate_get_candidate: no candidate '${v.id}'` }];
        const p3 = c.evalResults?.phase3;
        return [{
          type: 'text',
          text: [
            `autocreate_get_candidate: ${c.id}`,
            `  status=${c.status}  name=${c.skillDraft?.name ?? '?'}  template=${c.skillDraft?.template ?? '?'}`,
            `  estimatedBenefit=${JSON.stringify(c.estimatedBenefit ?? {})}`,
            p3 ? `  phase3: composite=${p3.composite} trusted=${p3.compositeTrusted} ranking=${p3.rankingScore} evidence=${p3.evidenceLevel} provisional=${p3.provisional}` : '  phase3: (未评估)',
            `  rejectionReason=${c.rejectionReason ?? '-'}`,
          ].join('\n'),
        }];
      },
    },
    async execute(args) {
      const candidate = await svc.getCandidate(args.id);
      return JSON.parse(JSON.stringify({ id: args.id, candidate }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'autocreate_trigger_eval',
    description:
      '触发单个候选的评估（Phase 1 静态准入 → Phase 2 沙箱门 → Phase 3 硬门+排序）。' +
      '**WRITE**：会改变候选状态并可能向 evolution-log 写入记录，执行需人工确认（agint-rules 门禁）。' +
      '仅 PENDING_EVAL 候选可评估；重试受 max_eval_attempts / 冷却期约束。',
    parameters: {
      id: { type: 'string', description: '候选 id（PENDING_EVAL 状态）' },
      actor: { type: 'string', description: '触发人标识（默认 system）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => {
        if (v.skipped) return [{ type: 'text', text: `autocreate_trigger_eval: skipped — ${v.reason}` }];
        const line = `autocreate_trigger_eval: ${v.candidateId} → ${v.finalStatus}`;
        const extra = v.rankingScore != null ? `  ranking=${v.rankingScore}  evidence=${v.evidenceLevel}${v.provisional ? ' provisional' : ''}  composite=${v.composite} (trusted=false)` : '';
        return [{ type: 'text', text: `${line}${extra}${v.rejectionReason ? `  reason=${v.rejectionReason}` : ''}` }];
      },
    },
    async execute(args) {
      const out = await svc.triggerEval(args);
      return JSON.parse(JSON.stringify(out));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'autocreate_stats',
    description:
      '技能自动创建统计：模式数/候选数（各状态分布）/发布数/暂停状态/当前配置。' +
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

  // ── Sprint 16 发布层（设计稿 §6）────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'autocreate_release',
    description:
      '发布指定候选为真实技能（写入 preset skills 目录，宿主自动发现，无需重启）。' +
      '**WRITE**：改变候选状态并落盘文件，执行需人工确认（agint-rules 门禁）。' +
      '人工发布绕过周预算但绕不过 policy 质量门；仅 QUEUED_FOR_RELEASE / BUDGET_WAIT 可发。',
    parameters: {
      id: { type: 'string', description: '候选 id（QUEUED_FOR_RELEASE / BUDGET_WAIT 状态）' },
      reason: { type: 'string', description: '发布理由，写入审计日志' },
      actor: { type: 'string', description: '发布人标识（默认 human）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => {
        if (v.released) {
          return [{ type: 'text', text: `autocreate_release: ✅ ${v.skillName} 已发布 → ${v.dir}\n  观察期至 ${v.observationEndAt}（release=${v.releaseId}）` }];
        }
        return [{ type: 'text', text: `autocreate_release: ⛔ 未发布 — [${v.gate}] ${v.reason}` }];
      },
    },
    async execute(args) {
      const out = await svc.release({ ...args, manual: true });
      return JSON.parse(JSON.stringify(out));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'autocreate_rollback',
    description:
      '回滚已发布的自动创建技能：目录移入归档区（只归档不删除），候选标记 ROLLED_BACK，' +
      '同名技能进入 30 天冷却期。**WRITE**，执行需人工确认（agint-rules 门禁）。',
    parameters: {
      skillName: { type: 'string', description: '技能名（与 id 二选一）' },
      id: { type: 'string', description: '候选 id（与 skillName 二选一）' },
      reason: { type: 'string', description: '回滚原因（必填，写入审计与 release 记录）' },
      actor: { type: 'string', description: '操作人标识（默认 human）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{
        type: 'text',
        text: v.archived
          ? `autocreate_rollback: ✅ ${v.skillName} 已回滚 → 归档 ${v.dest}`
          : `autocreate_rollback: ⚠️ ${v.skillName} 标记回滚（目录本就不存在）`,
      }],
    },
    async execute(args) {
      const out = await svc.rollback(args);
      return JSON.parse(JSON.stringify(out));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'autocreate_list_releases',
    description:
      '列出发布记录（含观察期状态/调用计数/回滚信息）。**Read-only**。',
    parameters: {
      status: { type: 'string', description: '按状态过滤：OBSERVING / STABLE / ROLLED_BACK；省略=全部' },
      limit: { type: 'number', description: '最多返回多少条（默认 20）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => {
        const list = v.releases ?? [];
        if (!list.length) return [{ type: 'text', text: 'autocreate_list_releases: no releases yet' }];
        const lines = list.map((r) => {
          const m = r.observationMetrics ?? {};
          return `  ${r.id}  [${r.status}]  ${r.skillName}  by=${r.releasedBy}  calls=${m.callsTotal ?? 0}  end=${r.observationEndAt ?? '-'}${r.rollbackReason ? `  回滚=${r.rollbackReason}` : ''}`;
        });
        return [{ type: 'text', text: `autocreate_list_releases: ${list.length} releases\n${lines.join('\n')}` }];
      },
    },
    async execute(args) {
      const releases = await svc.listReleases({ ...args, limit: args.limit ?? 20 });
      return JSON.parse(JSON.stringify({ releases }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'autocreate_modify',
    description:
      '修改发布前候选的技能草稿（发布前人工把关）。**WRITE**：修改后候选回到 PENDING_EVAL ' +
      '需重新过 Phase 1-3 评估（防人工改动引入未评估内容）；自我指涉草稿被拒绝。',
    parameters: {
      id: { type: 'string', description: '候选 id（QUEUED_FOR_RELEASE / BUDGET_WAIT 状态）' },
      skillDraft: {
        type: 'object',
        description: '完整替换的新草稿（name/description/frontmatter/body/...）',
        additionalProperties: true,   // dsh 严格 JSON Schema 校验要求每个对象显式声明
      },
      actor: { type: 'string', description: '修改人标识（默认 human）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{
        type: 'text',
        text: `autocreate_modify: ✅ ${v.id} 草稿已更新 → 状态回 ${v.status}（需重跑评估）`,
      }],
    },
    async execute(args) {
      const out = await svc.modifyCandidate(args);
      return JSON.parse(JSON.stringify({ id: out.id, status: out.status, name: out.skillDraft?.name }));
    },
  }));
}

export { apply, inject, name };
