/**
 * agint-curriculum: preset-scoped tools（§5.2 B-8，4 个）。
 *
 * 门禁现状对齐 agint-curator：dsh 暂无统一的工具级 approval 配置位，写类
 * 工具（next/submit）的 description 首行显式标注「⚠️ 写操作 · 需人工确认」，
 * 并把 actor 落进 audit_log。待 dsh approvals 可用后再接真实门禁。
 *
 * Schema policy: K19 — additionalProperties: true；线上跑过再收紧。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'agint-curriculum-tools';
const inject = ['tools', 'agint.curriculum'];

function apply(ctx) {
  const svc = ctx['agint.curriculum'];

  ctx.tools.register(defineTool({
    name: 'curriculum_next',
    description:
      '⚠️ 写操作 · 需人工确认：领取下一个 open 挑战（按创建时间最早）。' +
      '挑战不会自动执行（§4.5）——agent 需真实参与，完成后用 curriculum_submit 提交。' +
      '执行时请使用返回的 sessionId（curriculum- 前缀），其调用会被 skill-autocreate/curator 隔离。',
    parameters: {
      domain: { type: 'string', description: '按域过滤：codegen/reasoning/planning/tool-use；省略=任意' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => {
        if (v.skipped) return [{ type: 'text', text: `curriculum_next: skipped — ${v.reason}` }];
        const c = v.challenge;
        return [{
          type: 'text',
          text: `curriculum_next: 挑战 ${c.id} [${c.domain} · ${c.level}]\n  sessionId: ${c.sessionId}\n  任务: ${c.prompt}\n  通过标准: ${c.passCriteria}`,
        }];
      },
    },
    async execute(args) {
      return svc.nextChallenge({ domain: args.domain });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'curriculum_submit',
    description:
      '⚠️ 写操作 · 需人工确认：提交挑战执行结果。判定为外部化（§4.4）：' +
      '系统按挑战的 verifySpec 自动判定，LLM 自评（selfAssessment 字段）只记录不影响结果；' +
      '无 evidence 记 fail（C3）。判定后自动回写 self-model（提供证据，不改结论）。',
    parameters: {
      challengeId: { type: 'string', description: '挑战 ID（curriculum_next 返回）' },
      evidence: {
        type: 'object',
        // dsh-tools 的 schema 编译器要求 object 参数**显式**声明 additionalProperties，
        // 否则 defineTool 抛 JsonSchemaError（挂载时即崩，不是运行期）。
        // 证据字段随挑战类型变化（codegen/reasoning/planning/tool-use 各不相同），
        // 只能开放。参照 output.schema 的 K19 政策。
        additionalProperties: true,
        description: '判定证据。按挑战类型提供：codegen→{exitCode,output}；reasoning→{conclusion}；planning→{steps:[]}；tool-use→{toolUsed,exitCode,output}。可附带 selfAssessment（自评，仅记录）。',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{
        type: 'text',
        text: `curriculum_submit: ${v.challengeId} → ${v.result.toUpperCase()}\n  ${v.reason}\n  难度: ${v.levelBefore} → ${v.levelAfter}（${v.difficultyAction}）`,
      }],
    },
    async execute(args) {
      if (!args.challengeId) throw new Error('curriculum_submit: challengeId is required');
      if (!args.evidence) throw new Error('curriculum_submit: evidence is required');
      return svc.submit({ challengeId: args.challengeId, evidence: args.evidence });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'curriculum_stats',
    description:
      '课程统计：挑战/判定/各域难度档与完成率。**Read-only**。周复盘可直接引用。',
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
    name: 'curriculum_list',
    description:
      '列出挑战（可按状态/域过滤）。**Read-only**。',
    parameters: {
      status: { type: 'string', description: '按状态过滤：open/in_progress/passed/failed/expired；省略=全部' },
      domain: { type: 'string', description: '按域过滤：codegen/reasoning/planning/tool-use' },
      limit: { type: 'number', description: '最多返回多少条（默认 50）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => {
        const list = v.challenges ?? [];
        if (!list.length) return [{ type: 'text', text: 'curriculum_list: no challenges yet' }];
        const lines = list.map((c) => `  ${c.id}  [${c.status}]  ${c.domain}·${c.level}  attempts=${c.attemptCount ?? 0}  ${c.createdAt.slice(0, 10)}`);
        return [{ type: 'text', text: `curriculum_list: ${list.length} challenges\n${lines.join('\n')}` }];
      },
    },
    async execute(args) {
      const list = await svc.list({ status: args.status, domain: args.domain, limit: args.limit ?? 50 });
      return JSON.parse(JSON.stringify({ challenges: list }));
    },
  }));
}

export { apply, inject, name };
