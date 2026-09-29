/**
 * agint-input-gateway: preset-scoped tools。
 *
 * 只读（裸调）：input_gateway_status / input_gateway_channel_status
 * 写操作（ask 门禁，description 首行标注）：
 *   - input_gateway_force_fetch（手动触发 Channel 采集）
 *   - input_gateway_set_quota（调整 Channel 日配额）
 *   - input_gateway_channel_enable / input_gateway_channel_disable（开关 Channel）
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'agint-input-gateway-tools';
const inject = ['tools', 'agint.inputGateway'];

function apply(ctx) {
  const svc = ctx['agint.inputGateway'];
  const json = (v) => JSON.parse(JSON.stringify(v ?? {}));
  const out = { schema: { type: 'object', additionalProperties: true } };

  // ── 只读：整体状态 ──────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'input_gateway_status',
    description:
      '多源输入网关整体状态：已注册 Channel 列表、每 Channel 的启用状态/配额/最近采集时间/计数器。'
      + '**Read-only**。',
    parameters: {},
    output: {
      ...out,
      render: (_a, v) => {
        const lines = [`input_gateway_status: enabled=${v.enabled} channels=${v.channelCount}`];
        const sec = v.security;
        lines.push(`  security: action=${sec?.action ?? 'n/a'} rules=${sec?.ruleCount ?? 0} checked=[${(sec?.checkedTypes ?? []).join(',')}]`);
        for (const ch of v.channels ?? []) {
          lines.push(
            `  [${ch.channelId}] type=${ch.channelType} enabled=${ch.enabled} quota=${ch.quota}`
            + ` lastFetch=${ch.lastFetchAt ?? 'never'}`
            + ` emitted=${ch.counters?.signalsEmitted ?? 0} filtered=${ch.counters?.signalsFiltered ?? 0}`
            + ` scanned=${ch.counters?.securityScanned ?? 0} flagged=${ch.counters?.securityFlagged ?? 0}`
            + ` errors=${ch.counters?.errorCount ?? 0}`
            + (ch.lastError ? ` error="${ch.lastError}"` : ''),
          );
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute() { return json(await svc.getStatus()); },
  }));

  // ── 只读：单 Channel 状态 ──────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'input_gateway_channel_status',
    description:
      '查看指定 Channel 的详细状态：计数器、最近采集、错误、配额。**Read-only**。',
    parameters: {
      channelId: { type: 'string', description: 'Channel ID（如 self-observation）', required: true },
    },
    output: {
      ...out,
      render: (_a, v) => [{
        type: 'text',
        text: `channel_status: ${v.channelId}\n`
          + `  type=${v.channelType} enabled=${v.enabled} quota=${v.quota}\n`
          + `  lastFetch=${v.lastFetchAt ?? 'never'} duration=${v.lastFetchDurationMs ?? '-'}ms\n`
          + `  counters: ${JSON.stringify(v.counters ?? {})}`
          + (v.lastError ? `\n  lastError: ${v.lastError}` : '')
          // Channel 自报健康（如 adversarial 的 initError / status）。
          // gateway.getChannelStatus 已挂在返回值上，不渲染 = 假绿：算出来了但看不见。
          + (v.health ? `\n  health: ${JSON.stringify(v.health)}` : ''),
      }],
    },
    async execute(args) {
      if (!args.channelId) throw new Error('channelId is required');
      return json(await svc.getChannelStatus(String(args.channelId)));
    },
  }));

  // ── 写操作：手动触发采集 ────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'input_gateway_force_fetch',
    description:
      '⚠️ 写操作 · 需人工确认。手动触发指定 Channel 的立即采集（不等 cron 定时）。'
      + '采集到的信号会过滤后发布到 eventBus。',
    parameters: {
      channelId: { type: 'string', description: 'Channel ID（如 self-observation）', required: true },
    },
    output: {
      ...out,
      render: (_a, v) => [{
        type: 'text',
        text: `force_fetch ${v.channelId ?? ''}: ok=${v.ok}`
          + (v.error ? ` error="${v.error}"` : '')
          + ` in=${v.in ?? 0} emitted=${v.emitted ?? 0} filtered=${v.filtered ?? 0} dedup=${v.deduplicated ?? 0}`,
      }],
    },
    async execute(args) {
      if (!args.channelId) throw new Error('channelId is required');
      return json(await svc.forceFetch(String(args.channelId)));
    },
  }));

  // ── 写操作：调整配额 ────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'input_gateway_set_quota',
    description:
      '⚠️ 写操作 · 需人工确认。调整指定 Channel 的每日信号配额上限（0-1000 条/日）。'
      + '超出配额的信号会被过滤。设为 0 等于暂停该 Channel 的信号发布（但不停止采集）。',
    parameters: {
      channelId: { type: 'string', description: 'Channel ID', required: true },
      quota: { type: 'number', description: '每日配额上限（0-1000）', required: true },
    },
    output: {
      ...out,
      render: (_a, v) => [{
        type: 'text',
        text: `set_quota: channel=${v.channelId} quota=${v.quota} (已生效)`,
      }],
    },
    async execute(args) {
      if (!args.channelId) throw new Error('channelId is required');
      if (!Number.isFinite(Number(args.quota))) throw new Error('quota must be a number');
      return json(await svc.setQuota(String(args.channelId), Number(args.quota)));
    },
  }));

  // ── 写操作：启用 Channel ────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'input_gateway_channel_enable',
    description:
      '⚠️ 写操作 · 需人工确认。启用指定 Channel（恢复定时采集和信号发布）。',
    parameters: {
      channelId: { type: 'string', description: 'Channel ID', required: true },
    },
    output: {
      ...out,
      render: (_a, v) => [{
        type: 'text',
        text: `channel_enable: ${v.channelId} enabled=${v.enabled}`,
      }],
    },
    async execute(args) {
      if (!args.channelId) throw new Error('channelId is required');
      return json(await svc.setChannelEnabled(String(args.channelId), true));
    },
  }));

  // ── 写操作：禁用 Channel ────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'input_gateway_channel_disable',
    description:
      '⚠️ 写操作 · 需人工确认。禁用指定 Channel（停止定时采集，手动 force_fetch 仍可用）。',
    parameters: {
      channelId: { type: 'string', description: 'Channel ID', required: true },
    },
    output: {
      ...out,
      render: (_a, v) => [{
        type: 'text',
        text: `channel_disable: ${v.channelId} enabled=${v.enabled}`,
      }],
    },
    async execute(args) {
      if (!args.channelId) throw new Error('channelId is required');
      return json(await svc.setChannelEnabled(String(args.channelId), false));
    },
  }));
}

export { name, inject, apply };

