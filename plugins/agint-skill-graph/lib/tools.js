/**
 * agint-skill-graph: preset-scoped tools（P2-2 §4.1 / §4.2）。
 *
 * 门禁策略与 curator / curriculum 一致：写类工具在 description 首行显式标注
 * 「⚠️ 写操作 · 需人工确认」（dsh 当前无统一工具级 ask 配置位，如实标注为未决项）。
 *
 * 只读（裸调）：skillGraph_stats / coverage / neighbors / clusters / recommend /
 *               list_for_prompt / get_skill
 * 写操作（ask 确认）：skillGraph_export（本地 runtime 目录）/
 *                     skillGraph_set_mode（切 live）/
 *                     skillGraph_propose_consolidate（提交整合提案）
 *
 * Schema policy: K19 — 每个 `type: 'object'` 显式 additionalProperties；
 *                K20 — 不写 `required: false`（可选参数就是不写 required）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'agint-skill-graph-tools';
const inject = ['tools', 'agint.skillGraph'];

function apply(ctx) {
  const svc = ctx['agint.skillGraph'];
  const json = (v) => JSON.parse(JSON.stringify(v));
  const out = { schema: { type: 'object', additionalProperties: true } };

  ctx.tools.register(defineTool({
    name: 'skillGraph_stats',
    description:
      '技能图谱状态：节点/边/coverage/health/mode/标定报告/counters。**Read-only**。' +
      'health=EMPTY 表示图里一条边都没有 —— 这是正确行为（当前元数据未补齐的预期结果），不是故障。',
    parameters: {},
    output: {
      ...out,
      render: (_a, v) => [{
        type: 'text',
        text: `skillGraph_stats: mode=${v.mode} health=${v.health} `
          + `nodes=${v.nodes} edges=${v.edges} coverage=${v.coverage?.ratio ?? 0}`
          + `${v.stale ? '  [STALE>14d]' : ''}\n`
          + `  edgesByType: ${JSON.stringify(v.edgesByType ?? {})}\n`
          + `  counters: ${JSON.stringify(v.counters ?? {})}\n`
          + `  lastCalibration: ${v.lastCalibration ? `${v.lastCalibration.week} nodes=${v.lastCalibration.nodes} edges=${v.lastCalibration.edges} promotable=${v.lastCalibration.promotable}` : '无（尚未跑过标定期）'}`,
      }],
    },
    execute() { return svc.stats().then(json); },
  }));

  ctx.tools.register(defineTool({
    name: 'skillGraph_coverage',
    description:
      '图谱健康度：coverage 空图指标（nodesWithEdges / nodesWithUsage 两个分母）+ 声明型边与计算型边的分账。' +
      '**Read-only**。周复盘直接引用本工具；**空图必须显式呈现为"图谱为空 + 原因"，不得省略**。',
    parameters: {},
    output: { ...out, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
    execute() { return svc.getCoverage().then(json); },
  }));

  ctx.tools.register(defineTool({
    name: 'skillGraph_get_skill',
    description: '取单个技能的使用统计（calls / lastUsedAt / status / presets）。**Read-only**。无数据返回 null，不编造。',
    parameters: {
      skillName: { type: 'string', description: '技能名（SKILL.md frontmatter 的 name）' },
    },
    output: {
      ...out,
      render: (_a, v) => [{
        type: 'text',
        text: v.stats
          ? `skillGraph_get_skill: ${v.stats.skillName} [${v.stats.status}] calls=${v.stats.calls} last=${v.stats.lastUsedAt ?? 'never'} presets=${(v.stats.presets ?? []).join(',')}`
          : 'skillGraph_get_skill: no data（技能不在全集内，或统计尚未落盘）',
      }],
    },
    async execute(args) {
      if (!args.skillName) throw new Error('skillGraph_get_skill: skillName is required');
      return json({ stats: await svc.getStats(args.skillName) });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'skillGraph_neighbors',
    description:
      '查某技能的关系邻居（边带 evidence，可审计"为什么说它俩有关系"）。**Read-only**。' +
      'type 可选 related（声明）/ overlap（curator 判定）/ co_use（会话共现）/ similar（默认关）。',
    parameters: {
      skillName: { type: 'string', description: '技能名' },
      type: { type: 'string', description: '按边类型过滤：related/overlap/co_use/similar；省略=全部' },
      minWeight: { type: 'number', description: '最小权重（0-1）' },
    },
    output: {
      ...out,
      render: (_a, v) => {
        const list = v.edges ?? [];
        if (!list.length) return [{ type: 'text', text: `skillGraph_neighbors: ${v.skillName} 无邻居边` }];
        return [{
          type: 'text',
          text: `skillGraph_neighbors: ${v.skillName} → ${list.length} 条\n`
            + list.map((e) => `  [${e.type}] ↔ ${e.src === v.skillName ? e.dst : e.src}  w=${e.weight}  ${JSON.stringify(e.evidence)}`).join('\n'),
        }];
      },
    },
    async execute(args) {
      if (!args.skillName) throw new Error('skillGraph_neighbors: skillName is required');
      const edges = await svc.neighbors(args.skillName, { type: args.type, minWeight: args.minWeight ?? 0 });
      return json({ skillName: args.skillName, edges });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'skillGraph_clusters',
    description:
      '关系簇（连通分量，结果带证据）。**Read-only**。' +
      '⚠️ 默认 type=overlap（FROZEN 签名）；v0.3 起首选边是 related，查真实关系簇请传 type=related 或 types=[related,overlap]。',
    parameters: {
      type: { type: 'string', description: '边类型（默认 overlap）；related 是 v0.3 首选边' },
      types: { type: 'string', description: '逗号分隔的多类型并集，如 "related,overlap"' },
      minSize: { type: 'number', description: '簇最小成员数（默认 2）' },
    },
    output: {
      ...out,
      render: (_a, v) => {
        const list = v.clusters ?? [];
        if (!list.length) return [{ type: 'text', text: `skillGraph_clusters: 0 个簇（type=${v.type}）` }];
        return [{
          type: 'text',
          text: `skillGraph_clusters: ${list.length} 个簇（type=${v.type}）\n`
            + list.map((c) => `  ${c.clusterId}  ${c.members.join(' / ')}  (${c.evidence.length} 条边)`).join('\n'),
        }];
      },
    },
    async execute(args) {
      const types = typeof args.types === 'string' && args.types
        ? args.types.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
      const clusters = await svc.clusters({ type: args.type ?? 'overlap', types, minSize: args.minSize ?? 2 });
      return json({ type: args.types ?? args.type ?? 'overlap', clusters });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'skillGraph_recommend',
    description:
      '按任务意图列出技能（**默认 mode=list，不打分** —— 排序/选择交给调用方，对齐 §六 v0.3 结论）。' +
      '**Read-only**。冷启动（零边）时 status=INSUFFICIENT_DATA + degraded=true，items 仍返回纯 intentMatch 列表。' +
      '禁止项：不做学习排序、不做 embedding 召回、结果不写回统计（防回音室）。',
    parameters: {
      intent: { type: 'string', description: '任务意图（自由文本，规则关键词匹配）' },
      mode: { type: 'string', description: 'list（默认，不打分）| score（实验性加权公式）' },
      limit: { type: 'number', description: '最多返回多少条（默认 10）' },
    },
    output: {
      ...out,
      render: (_a, v) => {
        const items = (v.items ?? []).slice(0, 10);
        const head = `skillGraph_recommend: status=${v.status}${v.degraded ? ' degraded' : ''}${v.stale ? ' stale' : ''} `
          + `health=${v.health} healthReason=${v.degradedReason ?? '-'}`;
        if (!items.length) return [{ type: 'text', text: `${head}\n  （无候选）` }];
        return [{
          type: 'text',
          text: `${head}\n` + items.map((i) => `  ${i.skillName}  ${i.score === undefined ? '' : `score=${i.score} `}${i.reason}`).join('\n'),
        }];
      },
    },
    async execute(args) {
      const r = await svc.recommend({ intent: args.intent, context: {}, mode: args.mode });
      const limit = Number(args.limit) > 0 ? Number(args.limit) : 10;
      return json({ ...r, items: r.items.slice(0, limit) });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'skillGraph_list_for_prompt',
    description:
      '返回技能列表（skillName + description + related 邻居展开），**不打分**。**Read-only**。' +
      '这是 §六 的主方案：11 个技能的规模下由调用方（LLM 或人）自己挑，不做推荐算法。',
    parameters: {
      intent: { type: 'string', description: '可选的意图提示（仅用于排序，不用于打分）' },
      limit: { type: 'number', description: '最多返回多少条（默认 50）' },
    },
    output: { ...out, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
    async execute(args) {
      return json(await svc.listForPrompt({ intent: args.intent, limit: args.limit ?? 50 }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'skillGraph_export',
    description:
      '⚠️ 写操作 · 需人工确认：导出图谱为 DOT（人看）或 JSONL（程序读），落 runtime 导出目录（gitignored）。',
    parameters: {
      format: { type: 'string', description: 'dot（默认）| jsonl' },
    },
    output: {
      ...out,
      render: (_a, v) => [{ type: 'text', text: `skillGraph_export: ${v.path}（${v.format}, nodes=${v.nodes}, edges=${v.edges}, bytes=${v.bytes}）` }],
    },
    async execute(args) {
      return json(await svc.exportGraph({ format: args.format ?? 'dot' }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'skillGraph_set_mode',
    description:
      '⚠️ 写操作 · 需人工确认：切换落盘档位 count-only（标定期，默认）↔ live。' +
      '**未跑过标定期就切 live 会被拒绝并抛错**（§5.3 护栏，对齐 P2-1 不变量）。',
    parameters: {
      mode: { type: 'string', description: 'count-only | live' },
    },
    output: {
      ...out,
      render: (_a, v) => [{ type: 'text', text: `skillGraph_set_mode: → ${v.mode}` }],
    },
    async execute(args) {
      if (!args.mode) throw new Error('skillGraph_set_mode: mode is required');
      return json(await svc.setMode(args.mode));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'skillGraph_propose_consolidate',
    description:
      '⚠️ 写操作 · 需人工确认：把一个关系簇作为**整合候选**提交给既有提案通道（agint.evolve.propose）。' +
      '只建议、不执行 —— 整合的执行权归 curator + 老板（不变量 4：图谱不进决策）。',
    parameters: {
      clusterId: { type: 'string', description: 'skillGraph_clusters 返回的 clusterId' },
    },
    output: {
      ...out,
      render: (_a, v) => [{ type: 'text', text: `skillGraph_propose_consolidate: proposalId=${v.proposalId} members=${(v.members ?? []).join(' / ')}` }],
    },
    async execute(args) {
      if (!args.clusterId) throw new Error('skillGraph_propose_consolidate: clusterId is required');
      return json(await svc.proposeConsolidate(args.clusterId));
    },
  }));
}

export { apply, inject, name };
