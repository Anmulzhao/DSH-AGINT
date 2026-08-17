/**
 * agint-evolve: preset-scoped tools (evolve_review / evolve_read /
 * evolve_propose / evolve_proposals / evolve_set_status). Consumes the host
 * `agint.evolve` service; registered from the agint preset family so only
 * 智进 sessions see these tools.
 *
 * Preset row (agent.cordis.yml):
 *   - id: agint-evolve-tools
 *     name: ../../plugins/agint-evolve/lib/tools.js
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'agint-evolve-tools';
const inject = ['tools', 'agint.evolve'];

const CATEGORIES = ['rule', 'skill', 'doc', 'preset', 'service', 'other'];
const STATUSES = ['proposed', 'applied', 'rejected', 'wontfix'];

const FINDING = {
  type: 'object', additionalProperties: false,
  properties: {
    level: { type: 'string', required: true },
    key: { type: 'string', required: true },
    message: { type: 'string', required: true },
  },
};

function apply(ctx) {
  const evolve = ctx['agint.evolve'];

  ctx.tools.register(defineTool({
    name: 'evolve_review',
    description:
      '生成一份智进周复盘报告：采集 memory/wiki/cron/rules/metrics 数据快照 → 自动发现失效任务/断链/矛盾/规则冗余/指标恶化 → ' +
      '写入 reviews/ 目录。周日由 cron 自动执行；手动调用用于即时复盘。返回报告路径与自动发现列表。',
    parameters: {
      date: { type: 'string', description: '报告日期 YYYY-MM-DD（默认今天）' },
      notes: { type: 'string', description: '附加备注（如本周关注点），会写入报告' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          findings: { type: 'array', required: true, items: FINDING },
          snapshotCollectedAt: { type: 'string', required: true },
        },
      },
      render: (_a, v) => [
        { type: 'text', text: `evolve_review: 已写入 ${v.path}（${v.bytes} 字节）\n自动发现 ${v.findings.length} 项：\n${v.findings.map((f) => `  [${f.level}] ${f.message}`).join('\n')}` },
      ],
    },
    execute(args) {
      return evolve.writeReview({ date: args.date, notes: args.notes });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolve_read',
    description:
      '读取一份复盘报告全文。不带 path 时返回最近一份报告的路径列表。读报告后按路由规范行动：教训→memory、方法→准则、知识→wiki，改进→evolve_propose。',
    parameters: {
      path: { type: 'string', description: '报告相对路径（如 2026-08-17-周复盘.md）；省略则只列目录' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          reviews: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, mtime: { type: 'string' }, size: { type: 'integer' } } } },
        },
      },
      render: (_a, v) => {
        if (v.reviews) return [{ type: 'text', text: v.reviews.length === 0 ? 'evolve_read: 尚无复盘报告' : `evolve_read: ${v.reviews.length} 份报告\n${v.reviews.map((r) => `  ${r.path} (${r.mtime.slice(0, 10)})`).join('\n')}` }];
        return [{ type: 'text', text: v.content === null ? `evolve_read: 未找到 ${v.path}` : v.content }];
      },
    },
    async execute(args) {
      if (args.path) {
        const review = await evolve.readReview(args.path);
        return { path: args.path, content: review ? review.content : null };
      }
      const reviews = await evolve.listReviews();
      return { reviews };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolve_propose',
    description:
      '提出一条改进提案（复盘闭环 Phase 3）。category: rule=新增/修改规则门禁, skill=技能, doc=文档/wiki, preset=预设组合, service=host 服务, other。' +
      '提案生成后请评估影响（Phase 4），确认可执行再落地，落地后 evolve_set_status 标记 applied。',
    parameters: {
      title: { type: 'string', required: true, description: '一句话提案标题（动词开头）' },
      body: { type: 'string', required: true, description: '提案详情：现状问题、改动方案、预期收益、风险' },
      category: { type: 'string', enum: CATEGORIES, description: '提案类别（默认 other）' },
      source: { type: 'string', description: '来源报告路径（如 2026-08-17-周复盘.md）' },
    },
    output: {
      // propose returns the full proposalSchema record (9 fields). The old
      // schema declared only 5 (dropping body/source/note/updatedAt) which
      // truncated the output in DSH strict mode.
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          body: { type: 'string', required: true },
          category: { type: 'string', required: true },
          status: { type: 'string', required: true },
          source: { type: 'string', required: true },
          note: { type: 'string', required: true },
          createdAt: { type: 'string', required: true },
          updatedAt: { type: 'string', required: true },
        },
      },
      render: (_a, v) => [{ type: 'text', text: `evolve_propose: [${v.category}] ${v.title}（id=${v.id}, status=${v.status}）` }],
    },
    execute(args) {
      return evolve.propose(args);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolve_proposals',
    description: '列出改进提案（可按状态/类别过滤）。复盘前先看历史提案是否已落地，避免重复提案。',
    parameters: {
      status: { type: 'string', enum: STATUSES, description: '按状态过滤（proposed/applied/rejected/wontfix）' },
      category: { type: 'string', enum: CATEGORIES, description: '按类别过滤' },
    },
    output: {
      // listProposals returns full proposalSchema records; previous items
      // dropped body/note/updatedAt (3 fields per item).
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          proposals: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                body: { type: 'string', required: true },
                category: { type: 'string', required: true },
                status: { type: 'string', required: true },
                source: { type: 'string', required: true },
                note: { type: 'string', required: true },
                createdAt: { type: 'string', required: true },
                updatedAt: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_a, v) => [
        { type: 'text', text: `evolve_proposals: ${v.total} 条提案\n${v.proposals.map((p) => `  [${p.status}] (${p.category}) ${p.title} — id=${p.id}`).join('\n')}` },
      ],
    },
    async execute(args) {
      const proposals = await evolve.listProposals({ status: args.status, category: args.category });
      return { total: proposals.length, proposals };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolve_set_status',
    description: '更新一条改进提案的状态：落地完成 → applied；评估后不做 → rejected；暂不处理 → wontfix。附 note 说明。',
    parameters: {
      id: { type: 'string', required: true, description: '提案 id（evolve_proposals 返回）' },
      status: { type: 'string', required: true, enum: STATUSES, description: '目标状态' },
      note: { type: 'string', description: '变更说明（如"已在 X 落地"）' },
    },
    output: {
      // setStatus returns the full proposalSchema record (9 fields). Previous
      // schema only declared 4 and the execute() pre-trim dropped 5 fields
      // (body, category, source, note, createdAt). Return the full record so
      // downstream evolve_read callers have everything they need.
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          body: { type: 'string', required: true },
          category: { type: 'string', required: true },
          status: { type: 'string', required: true },
          source: { type: 'string', required: true },
          note: { type: 'string', required: true },
          createdAt: { type: 'string', required: true },
          updatedAt: { type: 'string', required: true },
        },
      },
      render: (_a, v) => [{ type: 'text', text: `evolve_set_status: ${v.title} → ${v.status}（${v.updatedAt}）` }],
    },
    async execute(args) {
      const rec = await evolve.setStatus(args.id, args.status, args.note);
      if (!rec) throw new Error(`evolve_set_status: 未找到提案 ${args.id}`);
      return {
        id: rec.id, title: rec.title, body: rec.body,
        category: rec.category, status: rec.status,
        source: rec.source, note: rec.note,
        createdAt: rec.createdAt, updatedAt: rec.updatedAt,
      };
    },
  }));
}

export { apply, inject, name };
