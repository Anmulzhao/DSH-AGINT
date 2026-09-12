/**
 * agint-compress-guard: preset-scoped tools（设计稿 §6.1 / T6）。
 *
 * 只读（裸调）：compress_recall（恢复双通道①显式工具）/ compress_guard_stats。
 * 无写工具 —— 洞察只增不改，且不让洞察自动回写记忆库（§2.2 非目标）。
 *
 * Schema policy: K19 — 每个 object 参数显式 additionalProperties；
 *                K20 — 不写 required: false（可选参数就是不写 required）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'agint-compress-guard-tools';
const inject = ['tools', 'agint.compressGuard'];

function apply(ctx) {
  const svc = ctx['agint.compressGuard'];
  const json = (v) => JSON.parse(JSON.stringify(v));
  const out = { schema: { type: 'object', additionalProperties: true } };

  ctx.tools.register(defineTool({
    name: 'compress_recall',
    description:
      '恢复被压缩掉的上下文（P3-1 恢复双通道①）：按关键词查压缩前提取的洞察，'
      + '洞察查不到时下钻检查点回溯原文（host-compaction → 会话文件；p1 → P1-1 raw 表引用）。'
      + '**Read-only**。返回的 raw 原文是「压缩前」的内容，引用时注明，防止把 raw 误当现行事实。',
    parameters: {
      query: { type: 'string', description: '自然语言关键词（如「P3-1 拍板」「端口 3080」）', required: true },
      type: { type: 'string', description: '洞察类型过滤：decision/fact/preference；省略=全部' },
      limit: { type: 'number', description: '最多返回条数（默认 20，上限 50）' },
    },
    output: {
      ...out,
      render: (_a, v) => {
        const list = v.insights ?? [];
        const lines = [`compress_recall: status=${v.status} 洞察 ${list.length} 条`];
        for (const i of list) {
          lines.push(`  [${i.type}/${i.retention}] ${i.content}\n    来源=${i.source?.checkpointRef?.kind}:${i.source?.checkpointRef?.id ?? 'pending'} 提取于 ${i.source?.checkpointRef?.extractedAt}`);
        }
        if (v.rawRefs && v.rawRefs.length > 0) {
          lines.push(`  raw 引用（压缩前原文，非现行事实）：${JSON.stringify(v.rawRefs).slice(0, 800)}`);
        }
        if (list.length === 0 && (!v.rawRefs || v.rawRefs.length === 0)) {
          lines.push('  查无结果（recallMisses 已诚实计数，进周报）');
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      if (!args.query) throw new Error('compress_recall: query is required');
      return json(await svc.recall({
        query: String(args.query),
        type: args.type || undefined,
        limit: Number.isFinite(Number(args.limit)) ? Number(args.limit) : undefined,
      }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'compress_guard_stats',
    description:
      '压缩护栏健康度：双源流量（P1-1 检查点 / 宿主压缩）、洞察分布、recall 命中率、counters、'
      + '接线档位登记、恢复探测状态。**Read-only**。'
      + 'status=NO_SOURCE_REACHED 表示标定期双源零流量（没有压缩发生）——这是诚实指标，不是故障；'
      + '周报必须原样呈现，禁止省略。',
    parameters: {},
    output: {
      ...out,
      render: (_a, v) => [{
        type: 'text',
        text: `compress_guard_stats: status=${v.status} 洞察=${v.coverage?.insights ?? 0} `
          + `pending=${v.coverage?.pendingInsights ?? 0} guardLogs=${v.coverage?.guardLogs ?? 0}\n`
          + `  双源: p1CheckpointsSeen=${v.sourceHealth?.p1CheckpointsSeen ?? 0} hostCompactionsSeen=${v.sourceHealth?.hostCompactionsSeen ?? 0}\n`
          + `  byType: ${JSON.stringify(v.byType ?? {})}\n`
          + `  byStatus: ${JSON.stringify(v.byStatus ?? {})}\n`
          + `  recallHitRate: ${v.recallHitRate ?? 0} tiers: ${JSON.stringify(v.tiers ?? {})}\n`
          + `  counters: ${JSON.stringify(v.counters ?? {})}\n`
          + `  recovery: ${JSON.stringify(v.recovery ?? {})}`,
      }],
    },
    execute() { return svc.stats().then(json); },
  }));
}

export { name, inject, apply };
