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
import { EXEC_STATES } from './execution.js';

const name = 'agint-evolve-tools';
const inject = ['tools', 'agint.evolve'];

const CATEGORIES = ['rule', 'skill', 'doc', 'preset', 'service', 'plugin', 'other'];
// approved（2026-10-23）：人工批准、尚未执行。与 applied 分开，避免「点了头」
// 被记成「已落地」。缺这一档时人工审批无处落笔 —— 51 条 proposed 只进不出。
const STATUSES = ['proposed', 'approved', 'applied', 'rejected', 'wontfix'];
// 2026-10-27：批准之后谁来动手 —— manual=只批准；immediate=立刻自动跑；
// scheduled=按 execAt 自动跑。后两者由 agint-executor 负责，不需要人再点。
const EXEC_MODES = ['manual', 'immediate', 'scheduled'];
// ⛔ 不再在此处抄第二份：曾出现 execution.js 加了档而这里没加的漂移（2026-10-28
//    加 `partial` 时修）。判据只准一处，工具、面板、执行器一律从 execution.js 引。
//    `partial` = job 成功但提案还有单元没覆盖（见 execution.js 的注释与提案 846f4fbb）。

// K21: raw JSON Schema form. `required` is array on parent object, not on
// each property.
const FINDING = {
  type: 'object', additionalProperties: false,
  // required 已迁移至各属性（value schema DSL: 属性上的布尔 required: true）
  properties: {
    level: { required: true, type: 'string' },
    key: { required: true, type: 'string' },
    message: { required: true, type: 'string' },
  },
};

function apply(ctx) {
  const evolve = ctx['agint.evolve'];

  ctx.tools.register(defineTool({
    name: 'evolve_review',
    description:
      '生成一份智进周复盘报告：采集 memory/wiki/cron/rules/metrics 数据快照 → 自动发现失效任务/断链/矛盾/规则冗余/指标恶化 → ' +
      '写入 reviews/ 目录。周一 07:30 由 cron 自动执行；手动调用用于即时复盘。返回报告路径与自动发现列表。',
    parameters: {
      date: { type: 'string', description: '报告日期 YYYY-MM-DD（默认今天）' },
      notes: { type: 'string', description: '附加备注（如本周关注点），会写入报告' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        // required 已迁移至各属性（value schema DSL: 属性上的布尔 required: true）
        properties: {
          path: { required: true, type: 'string' },
          bytes: { required: true, type: 'integer' },
          findings: { required: true, type: 'array', items: FINDING },
          snapshotCollectedAt: { required: true, type: 'string' },
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
      '提出一条改进提案（复盘闭环 Phase 3）。category: rule=新增/修改规则门禁, skill=技能, doc=文档/wiki, preset=预设组合, service=host 服务, plugin=整 cordis 模块级改动, other。' +
      '提案生成后请评估影响（Phase 4），确认可执行再落地，落地后 evolve_set_status 标记 applied。',
    parameters: {
      title: { type: 'string', required: true, description: '一句话提案标题（动词开头）' },
      body: { type: 'string', required: true, description: '提案详情：现状问题、改动方案、预期收益、风险' },
      category: { type: 'string', enum: CATEGORIES, description: '提案类别（默认 other）' },
      source: { type: 'string', description: '来源报告路径（如 2026-08-17-周复盘.md）' },
      // 2026-10-27：成立条件。formulaVersion 由服务端自动填（当前判尺口径），
      // 调用方只需要在「结论依赖某个具体口径」时用 assumedBy 写更强假设锚点。
      assumedBy: { type: 'string', description: '可选：这条结论依赖的具体假设锚点（如 scoring.js@r2 / HTTP 超时 5s）。省略=只记当前判尺口径' },
      conflictsWith: {
        type: 'array',
        items: { type: 'string' },
        description: '可选：声明本条与哪些提案互斥（提案 id 列表）。目标提案已 applied/approved ⇒ 拒绝创建，需在正文「关联」节写清如何共存',
      },
    },
    output: {
      // propose returns the full proposalSchema record (9 fields). The old
      // schema declared only 5 (dropping body/source/note/updatedAt) which
      // truncated the output in DSH strict mode.
      // K21: raw JSON Schema form (DSH subset).
      schema: {
        type: 'object', additionalProperties: false,
        // required 已迁移至各属性（value schema DSL: 属性上的布尔 required: true）
        properties: {
          id: { required: true, type: 'string' },
          title: { required: true, type: 'string' },
          body: { required: true, type: 'string' },
          category: { required: true, type: 'string' },
          status: { required: true, type: 'string' },
          source: { required: true, type: 'string' },
          note: { required: true, type: 'string' },
          // 2026-10-27：补齐 proposalSchema 里同日新增的字段。
          // ⛔ output schema 是 additionalProperties:false —— 返回体里有、schema 里
          // 没声明 ⇒ DSH strict 校验直接判失败（2026-10-27 实测：每次 propose
          // 都报 "value.blocker is not a declared property"）。声明必须与
          // proposalSchema 同步增补，否则新增字段在输出面一律被挡。
          blocker: { required: true, type: 'string' },
          unblockCondition: { required: true, type: 'string' },
          execMode: { required: true, type: 'string' },
          execAt: { required: true, type: 'string' },
          execState: { required: true, type: 'string' },
          execAttempts: { required: true, type: 'integer' },
          execError: { required: true, type: 'string' },
          execStartedAt: { required: true, type: 'string' },
          execFinishedAt: { required: true, type: 'string' },
          autoExecutable: { required: true, type: 'boolean' },
          createdAt: { required: true, type: 'string' },
          updatedAt: { required: true, type: 'string' },
          // 2026-10-27：成立条件三字段 + 派生值 staleSince。同样是
          // additionalProperties:false ⇒ 返回体里有就必须在这里声明。
          formulaVersion: { required: true, type: 'string' },
          assumedBy: { required: true, type: 'string' },
          conflictsWith: { required: true, type: 'array', items: { type: 'string' } },
          staleSince: { required: true, type: 'string' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: `evolve_propose: [${v.category}] ${v.title}（id=${v.id}, status=${v.status}）` + (v.formulaVersion ? `\n  成立口径：${v.formulaVersion}${v.assumedBy ? ` / ${v.assumedBy}` : ''}（口径变了会标 staleSince，需重新评审）` : '') }],
    },
    execute(args) {
      return evolve.propose(args);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolve_proposals',
    description: '列出改进提案（可按状态/类别过滤）。复盘前先看历史提案是否已落地，避免重复提案。',
    parameters: {
      status: { type: 'string', enum: STATUSES, description: '按状态过滤（proposed 待批 / approved 已批准待执行 / applied 已落地 / rejected 拒绝 / wontfix 暂不处理）' },
      category: { type: 'string', enum: CATEGORIES, description: '按类别过滤' },
      blocked: { type: 'boolean', description: '只看「批准了但前置没到位」的（true）／排除它们（false）。省略=不过滤' },
    },
    output: {
      // listProposals returns full proposalSchema records; previous items
      // dropped body/note/updatedAt (3 fields per item).
      // K21: raw JSON Schema form.
      schema: {
        type: 'object', additionalProperties: false,
        // required 已迁移至各属性（value schema DSL: 属性上的布尔 required: true）
        properties: {
          total: { required: true, type: 'integer' },
          proposals: { required: true,
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              // required 已迁移至各属性（value schema DSL: 属性上的布尔 required: true）
              properties: {
                id: { required: true, type: 'string' },
                title: { required: true, type: 'string' },
                body: { required: true, type: 'string' },
                category: { required: true, type: 'string' },
                status: { required: true, type: 'string' },
                source: { required: true, type: 'string' },
                note: { required: true, type: 'string' },
                blocker: { required: true, type: 'string' },
                unblockCondition: { required: true, type: 'string' },
                // 2026-10-27：同批补齐执行计划字段（proposalSchema 里已有，
                // 但 output schema 没声明 ⇒ additionalProperties:false 直接判失败）。
                execMode: { required: true, type: 'string' },
                execAt: { required: true, type: 'string' },
                execState: { required: true, type: 'string' },
                execAttempts: { required: true, type: 'integer' },
                execError: { required: true, type: 'string' },
                execStartedAt: { required: true, type: 'string' },
                execFinishedAt: { required: true, type: 'string' },
                autoExecutable: { required: true, type: 'boolean' },
                createdAt: { required: true, type: 'string' },
                updatedAt: { required: true, type: 'string' },
                // 2026-10-27：成立条件。staleSince 非空 = 立项时的判尺口径已被
                // 后续公式变更甩在身后（如 r2→r4），这条结论未必还站得住。
                formulaVersion: { required: true, type: 'string' },
                assumedBy: { required: true, type: 'string' },
                conflictsWith: { required: true, type: 'array', items: { type: 'string' } },
                staleSince: { required: true, type: 'string' },
              },
            },
          },
        },
      },
      render: (_a, v) => [
        { type: 'text', text: `evolve_proposals: ${v.total} 条提案\n${v.proposals.map((p) => `  [${p.status}${p.status === 'approved' && p.blocker ? '·阻塞' : ''}${p.staleSince ? `·口径已变` : ''}] (${p.category}) ${p.title} — id=${p.id}${p.staleSince ? `\n      ⚠ 依赖口径已变（${p.staleSince}）：结论可能已失效，批准前先重新评审` : ''}${p.status === 'approved' && p.blocker ? `\n      ⛔ 卡在：${p.blocker}${p.unblockCondition ? `\n      ⏳ 解锁：${p.unblockCondition}` : ''}` : ''}`).join('\n')}` },
      ],
    },
    async execute(args) {
      const proposals = await evolve.listProposals({ status: args.status, category: args.category, blocked: args.blocked });
      return { total: proposals.length, proposals };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolve_set_status',
    description: '更新一条改进提案的状态：人工批准 → approved；落地完成 → applied；评估后不做 → rejected；暂不处理 → wontfix。附 note 说明。approved 与 applied 不是同一件事：前者是决定，后者是事实。批准的是**方向**、前置没到位时，同时传 blocker / unblockCondition，这条才不会在待办里被当成可催办的工作单。execMode=immediate/scheduled 表示**批准后由 agint-executor 自动执行**（不需要人再动手）；不传则保持原计划（新提案默认 manual=只批准）。',
    parameters: {
      id: { type: 'string', required: true, description: '提案 id（evolve_proposals 返回）' },
      status: { type: 'string', required: true, enum: STATUSES, description: '目标状态' },
      note: { type: 'string', description: '变更说明（如"已在 X 落地"）' },
      blocker: { type: 'string', description: '阻塞原因：为什么批准了还不能动手（传空字符串=解除阻塞）。省略=保持原值不动' },
      unblockCondition: { type: 'string', description: '解锁条件：等什么满足才算能动手（传空字符串=清除）。省略=保持原值不动' },
      execMode: { type: 'string', enum: EXEC_MODES, description: '批准后的执行方式：manual=只批准不自动跑 / immediate=立即自动执行 / scheduled=按 execAt 定时自动执行。省略=保持原计划' },
      execAt: { type: 'string', description: 'execMode=scheduled 时的执行时刻（ISO，如 2026-10-28T09:00:00+08:00）。其它模式传了会被忽略' },
      // 2026-10-29：autoExecutable 已降级为**惰性历史标记**（老板裁定：批准即自动执行）。
      // 仍然接受这个入参以兼容老调用方，但它**不再影响入队**。
      autoExecutable: { type: 'boolean', description: '历史标记（2026-10-29 起不参与判据）：true/false 都照常入队执行。省略=保持原值' },
    },
    output: {
      // setStatus returns the full proposalSchema record (9 fields). Previous
      // schema only declared 4 and the execute() pre-trim dropped 5 fields
      // (body, category, source, note, createdAt). Return the full record so
      // downstream evolve_read callers have everything they need.
      // K21: raw JSON Schema form.
      schema: {
        type: 'object', additionalProperties: false,
        // required 已迁移至各属性（value schema DSL: 属性上的布尔 required: true）
        properties: {
          id: { required: true, type: 'string' },
          title: { required: true, type: 'string' },
          body: { required: true, type: 'string' },
          category: { required: true, type: 'string' },
          status: { required: true, type: 'string' },
          source: { required: true, type: 'string' },
          note: { required: true, type: 'string' },
          blocker: { required: true, type: 'string' },
          unblockCondition: { required: true, type: 'string' },
          execMode: { required: true, type: 'string' },
          execAt: { required: true, type: 'string' },
          execState: { required: true, type: 'string' },
          execAttempts: { required: true, type: 'integer' },
          execError: { required: true, type: 'string' },
          // 2026-10-27：execute() 的返回体本来就带 autoExecutable（见下方 return），
          // output schema 没声明 ⇒ additionalProperties:false 判失败。补上。
          autoExecutable: { required: true, type: 'boolean' },
          createdAt: { required: true, type: 'string' },
          updatedAt: { required: true, type: 'string' },
          // 2026-10-27：同 propose/proposals —— 成立条件三字段 + 派生 staleSince。
          formulaVersion: { required: true, type: 'string' },
          assumedBy: { required: true, type: 'string' },
          conflictsWith: { required: true, type: 'array', items: { type: 'string' } },
          staleSince: { required: true, type: 'string' },
        },
      },
      render: (_a, v) => [{
        type: 'text',
        text: `evolve_set_status: ${v.title} → ${v.status}（${v.updatedAt}）`
          + (v.status === 'approved' && v.blocker ? `\n  ⛔ 已标阻塞：${v.blocker}${v.unblockCondition ? `\n  ⏳ 解锁条件：${v.unblockCondition}` : ''}\n  ⇒ 家族面板待办里它会进「已批准·阻塞中」，不再计为可催办工作单。` : '')
          + (v.autoExecutable === false ? `\n  ℹ 该提案带历史上的 autoExecutable=false 标记 —— 2026-10-29 起不再拦执行，照常入队。` : '')
          + (v.status === 'approved' && v.execMode !== 'manual'
            ? `\n  ▶ 执行计划：${v.execMode === 'scheduled' ? `定时 ${v.execAt}` : '立即'} · 当前 ${v.execState}`
              + (v.blocker ? '（有 blocker，暂不入队）' : '⇒ 已进入自动执行队列，由 agint-executor 执行，不需要人再动手')
            : '')
          + (v.execError ? `\n  ⚠ 最近一次执行：${v.execError}` : ''),
      }],
    },
    async execute(args) {
      const opts = {};
      if (typeof args.blocker === 'string') opts.blocker = args.blocker;
      if (typeof args.unblockCondition === 'string') opts.unblockCondition = args.unblockCondition;
      // ⛔ 只认布尔：传字符串/数字一律当没传（不猜）。
      if (typeof args.autoExecutable === 'boolean') opts.autoExecutable = args.autoExecutable;
      if (typeof args.execMode === 'string') opts.execMode = args.execMode;
      if (typeof args.execAt === 'string') opts.execAt = args.execAt;
      const rec = await evolve.setStatus(args.id, args.status, args.note, opts);
      if (!rec) throw new Error(`evolve_set_status: 未找到提案 ${args.id}`);
      return {
        id: rec.id, title: rec.title, body: rec.body,
        category: rec.category, status: rec.status,
        source: rec.source, note: rec.note,
        blocker: rec.blocker ?? '', unblockCondition: rec.unblockCondition ?? '',
        execMode: rec.execMode ?? 'manual', execAt: rec.execAt ?? '',
        execState: rec.execState ?? 'idle', execAttempts: rec.execAttempts ?? 0,
        execError: rec.execError ?? '',
        autoExecutable: rec.autoExecutable !== false,
        createdAt: rec.createdAt, updatedAt: rec.updatedAt,
        formulaVersion: rec.formulaVersion ?? '', assumedBy: rec.assumedBy ?? '',
        conflictsWith: Array.isArray(rec.conflictsWith) ? rec.conflictsWith : [],
        staleSince: rec.staleSince ?? '',
      };
    },
  }));

  // ── 执行队列（2026-10-27）────────────────────────────────────────────
  // 「批准即执行」之后，人还需要两个动作：看队列、必要时撤单/放行。
  // ⛔ 不做「批准 + 执行」的二合一工具：批准是决定，执行是动作，
  //    合成一个工具后，「我只是同意方向」和「现在就去改代码」就分不开了。
  ctx.tools.register(defineTool({
    name: 'evolve_executions',
    description: '查看/操作提案的执行队列（批准后的自动执行）。action=list 看排队、在跑、失败、顺延；action=run 立刻放行一条（force 忽略 blocker/状态复核之外的等待，但仍会过执行器的状态与 blocker 复核）；action=cancel 撤销排队中或重试中的执行。执行由 agint-executor 负责，本工具不直接改代码。',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'run', 'cancel'], description: 'list=看队列 / run=立刻放行 / cancel=撤销' },
      id: { type: 'string', description: '提案 id（run / cancel 必填；cancel 也接受执行 id）' },
      state: { type: 'string', enum: EXEC_STATES, description: 'list 时按状态过滤（queued / running / succeeded / failed / deferred / cancelled / partial）' },
      limit: { type: 'integer', description: 'list 返回条数上限（默认 20）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { required: true, type: 'string' },
          ok: { required: true, type: 'boolean' },
          message: { required: true, type: 'string' },
          total: { required: true, type: 'integer' },
          queued: { required: true, type: 'integer' },
          running: { required: true, type: 'integer' },
          weekCommits: { required: true, type: 'integer' },
          items: { required: true,
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { required: true, type: 'string' },
                proposalId: { required: true, type: 'string' },
                state: { required: true, type: 'string' },
                dueAt: { required: true, type: 'string' },
                attempts: { required: true, type: 'integer' },
                summary: { required: true, type: 'string' },
              },
            },
          },
        },
      },
      render: (_a, v) => [{
        type: 'text',
        text: v.action === 'list'
          ? `evolve_executions: ${v.total} 条（排队 ${v.queued} / 在跑 ${v.running} / 本周已落地 ${v.weekCommits}）\n`
            + (v.items.length === 0 ? '  （队列为空）' : v.items.map((x) => `  [${x.state}] ${x.proposalId.slice(0, 8)} · ${x.summary}`).join('\n'))
          : `evolve_executions ${v.action}: ${v.message}`,
      }],
    },
    async execute(args) {
      const executor = typeof ctx.get === 'function' ? ctx.get('agint.executor') : null;
      const stats = typeof evolve.executionStats === 'function' ? await evolve.executionStats({}) : { queued: 0, running: 0, lastWeekCommits: 0 };
      const counts = {
        total: stats.total ?? 0,
        queued: stats.queued ?? 0,
        running: stats.running ?? 0,
        weekCommits: stats.lastWeekCommits ?? 0,
      };
      if (args.action === 'list') {
        const rows = typeof evolve.listExecutions === 'function'
          ? await evolve.listExecutions({ state: args.state, limit: args.limit ?? 20 })
          : [];
        return {
          action: 'list', ok: true,
          message: `${rows.length} 条`,
          ...counts,
          items: rows.map((r) => ({
            id: r.id, proposalId: r.proposalId, state: r.state,
            dueAt: r.dueAt ?? '', attempts: r.attempts ?? 0,
            summary: r.summary ?? r.state,
          })),
        };
      }
      if (args.action === 'run') {
        if (!args.id) throw new Error('evolve_executions run: 缺 id（提案 id）');
        if (executor && typeof executor.runNow === 'function') {
          const out = await executor.runNow(args.id, { force: true, by: 'tool' });
          return {
            action: 'run', ok: out?.ok === true,
            message: out?.ok ? '已执行' : `已入队但本次未落地：${out?.reason ?? out?.result?.reason ?? out?.result?.error ?? '见队列'}`,
            ...counts, items: [],
          };
        }
        const out = await evolve.enqueueExecution(args.id, { force: true, by: 'tool' });
        return {
          action: 'run', ok: out?.enqueued === true,
          message: out?.enqueued ? 'agint-executor 未挂载：已入队，等它上线后执行' : `入队失败：${out?.reason ?? '未知'}`,
          ...counts, items: [],
        };
      }
      if (!args.id) throw new Error('evolve_executions cancel: 缺 id');
      const done = await evolve.cancelExecution(args.id, '工具撤销');
      return {
        action: 'cancel', ok: Array.isArray(done) && done.length > 0,
        message: Array.isArray(done) && done.length ? `已撤销 ${done.length} 条` : '没有可撤销的执行',
        ...counts, items: [],
      };
    },
  }));
}

export { apply, inject, name };
