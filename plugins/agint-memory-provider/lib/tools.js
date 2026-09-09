/**
 * agint-memory-provider: preset-scoped tools（设计稿 §6 / §12.1）。
 *
 * Sprint 15 交付 4 个工具：
 *   - memory_provider_list      read-only，裸调
 *   - memory_provider_status    read-only，裸调
 *   - memory_provider_activate  **write**，需 ask 门禁（§9.1 L3）
 *   - memory_provider_deactivate **write**，需 ask 门禁（§9.1 L3）
 *
 * Sprint 16 补（§12.2）：memory_provider_test / config_get / config_set /
 * fallback_stats；Sprint 17 补：pause / resume（§12.3）。
 *
 * ⚠️ 现有记忆工具（memory_write / memory_search / memory_read / memory_stats /
 * memory_forget_scan）**不在这里注册**——按 §14.1 决策 B，它们继续由
 * agint-memory 的 preset 平面提供，行为完全不变。
 *
 * Schema policy: K19 — additionalProperties: true；线上跑过再收紧。
 * 返回值统一 JSON round-trip（AGENTS.md K19 兜底，防 strict-mode 丢字段）。
 *
 * Preset row（presets/agint/agent.cordis.yml）：
 *   - id: agint-memory-provider-tools
 *     name: ../../profiles/web/plugins/agint-memory-provider/lib/tools.js
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'agint-memory-provider-tools';
const inject = ['tools', 'agint.memoryProvider'];

const roundTrip = (v) => JSON.parse(JSON.stringify(v));

function apply(ctx) {
  const svc = ctx['agint.memoryProvider'];

  ctx.tools.register(defineTool({
    name: 'memory_provider_list',
    description:
      '列出所有已注册的记忆 Provider 及其可用性快照（builtin 恒在且始终可用，' +
      '外部 provider 如 honcho/hindsight/mem0 需先注册）。' +
      '**Read-only**。用于确认当前有哪些 provider 可选。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => {
        const list = v.providers ?? [];
        if (!list.length) return [{ type: 'text', text: 'memory_provider_list: no providers' }];
        const lines = list.map((p) => {
          const flags = [
            p.isBuiltin ? 'BUILTIN' : 'external',
            p.available ? 'available' : `UNAVAILABLE${p.unavailableReason ? `(${p.unavailableReason})` : ''}`,
            p.name === v.activeProvider ? '◀ ACTIVE' : '',
          ].filter(Boolean);
          return `  ${p.name}  [${flags.join(' · ')}]  tools=${p.toolCount}  preCompressApi=v${p.preCompressCheckpointApiVersion}`;
        });
        return [{
          type: 'text',
          text: `memory_provider_list: ${list.length} providers（active=${v.activeProvider}）\n${lines.join('\n')}`,
        }];
      },
    },
    async execute() {
      return roundTrip(await svc.listProviders());
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_provider_status',
    description:
      '当前激活的记忆 Provider 状态：是否初始化、会话/轮次、是否暂停、' +
      '最近一次召回条数（RecallStatus）、最近一次激活结果。' +
      '**Read-only**。排查「记忆为什么没召回」先看这个。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => {
        const r = v.recallStatus;
        const recall = r ? `${r.glyph} ${r.count} 条（来自 ${r.providerLabel}）` : '本轮无召回';
        return [{
          type: 'text',
          text: [
            `memory_provider_status: active=${v.providerName}${v.isBuiltin ? '（内置）' : '（外部）'}`,
            `  initialized=${v.initialized}  paused=${v.paused}  turn=${v.turnNumber}`,
            `  session=${v.sessionId ?? '(none)'}`,
            `  recall: ${recall}`,
            v.lastActivation
              ? `  lastActivation: ok=${v.lastActivation.ok} requested=${v.lastActivation.requested}` +
                `${v.lastActivation.fellBack ? ` → 降级到 ${v.lastActivation.activeProvider}` : ''}` +
                `${v.lastActivation.reason ? ` (${v.lastActivation.reason})` : ''}`
              : '  lastActivation: (none)',
          ].join('\n'),
        }];
      },
    },
    async execute() {
      return roundTrip(await svc.getActiveProvider());
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_provider_activate',
    description:
      '激活指定的记忆 Provider。**Write 操作，需人工确认**（设计稿 §9.1 L3）。' +
      '激活顺序：检查已注册 → isAvailable()（不发网络请求）→ initialize()。' +
      '任一步失败会自动降级到 builtin 并记录原因，不会中断对话。' +
      '传 builtin 可随时回到内置记忆（L5 回滚能力）。',
    parameters: {
      providerName: {
        type: 'string',
        required: true,
        description: '要激活的 provider 名（builtin / honcho / hindsight / mem0 / ...）',
      },
      reason: { type: 'string', description: '激活原因，写入 audit_log' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => {
        if (v.ok) {
          return [{ type: 'text', text: `memory_provider_activate: ✅ ${v.activeProvider} 已激活（${v.durationMs}ms）` }];
        }
        return [{
          type: 'text',
          text: `memory_provider_activate: ⚠️ ${v.requested} 激活失败 → 已降级到 ${v.activeProvider}\n  原因: ${v.reason}`,
        }];
      },
    },
    async execute(args) {
      return roundTrip(await svc.activate(args.providerName, {
        actor: 'human',
        reason: args.reason ?? `工具调用 activate(${args.providerName})`,
      }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_provider_deactivate',
    description:
      '停用当前外部记忆 Provider，回到 builtin 内置记忆。' +
      '**Write 操作，需人工确认**（设计稿 §9.1 L3）。' +
      '会先调用旧 provider 的 shutdown() 释放资源，再激活 builtin。' +
      '内置记忆数据不受外部 provider 使用影响（§9.1 L5 回滚能力）。',
    parameters: {
      reason: { type: 'string', description: '停用原因，写入 audit_log' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{
        type: 'text',
        text: `memory_provider_deactivate: ${v.previousProvider} → ${v.activeProvider}` +
          `${v.ok ? '（已停用，内置记忆接管）' : `（停用失败: ${v.reason}）`}`,
      }],
    },
    async execute(args) {
      return roundTrip(await svc.deactivate({
        actor: 'human',
        reason: args.reason ?? '工具调用 deactivate',
      }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_provider_test',
    description:
      '测试记忆 Provider 的可用性：配置/凭证校验 + initialize 试探。' +
      '**Read-only**。注意：不做真实网络探活（isAvailable 约束 §9.2 约束 6），' +
      '「ok=true」代表配置与初始化没问题，不代表外部 API 端到端可达。',
    parameters: {
      providerName: {
        type: 'string',
        description: '要测试的 provider 名；缺省测当前激活的',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{
        type: 'text',
        text: `memory_provider_test: ${v.ok ? '✅' : '❌'} ${v.providerName}` +
          `  registered=${v.registered} available=${v.available}` +
          `${v.initializeOk !== null ? ` initializeOk=${v.initializeOk}` : ''}` +
          `（${v.durationMs}ms）\n  ${v.reason ?? ''}`,
      }],
    },
    async execute(args) {
      return roundTrip(await svc.testConnection(args.providerName));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_provider_config_get',
    description:
      '读取记忆 Provider 的配置（config + secrets 的 env var 名）。' +
      '**Read-only**；敏感值永不返回（只回 env var 名，§9.1 L2）。' +
      'providerName 缺省读当前激活的 provider。',
    parameters: {
      providerName: { type: 'string', description: 'provider 名；缺省 = 当前激活的' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{
        type: 'text',
        text: `memory_provider_config_get: ${v.providerName} configured=${v.configured}` +
          `  configKeys=[${Object.keys(v.config ?? {}).join(', ') || '无'}]` +
          `  secretEnvVars=[${Object.keys(v.secrets ?? {}).join(', ') || '无'}]` +
          `${v.lastValidatedAt ? `\n  lastValidatedAt=${v.lastValidatedAt} result=${v.validationResult}` : ''}`,
      }],
    },
    async execute(args) {
      return roundTrip(await svc.getConfig(args?.providerName));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_provider_config_set',
    description:
      '设置记忆 Provider 的配置。**Write 操作，需人工确认**（§9.1 L3）。' +
      'secrets 只接受 **env var 名**（如 MY_API_KEY），不接受实际凭证值——' +
      '疑似凭证会被直接拒绝（§9.1 L2）。',
    parameters: {
      providerName: {
        type: 'string', required: true,
        description: 'provider 名',
      },
      config: {
        type: 'object', additionalProperties: true,
        description: '非敏感配置键值对（如 { apiBaseUrl: "https://..." }）',
      },
      secrets: {
        type: 'object', additionalProperties: true,
        description: '敏感配置，值必须是 env var 名（如 { apiKeyEnv: "MY_API_KEY" }），实际凭证会被拒绝',
      },
      reason: { type: 'string', description: '修改原因，写入 audit_log' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{
        type: 'text',
        text: v.ok
          ? `memory_provider_config_set: ✅ ${v.providerName} 已更新（${v.updatedAt}）`
          : `memory_provider_config_set: ❌ ${v.providerName} 更新失败`,
      }],
    },
    async execute(args) {
      return roundTrip(await svc.setConfig(
        args.providerName,
        { config: args.config ?? {}, secrets: args.secrets ?? {} },
        { actor: 'human', reason: args.reason ?? '工具调用 config_set' },
      ));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_provider_fallback_stats',
    description:
      '记忆 Provider 运行时降级统计（最近 7 天 fallback_events 聚合）' +
      '：按操作/错误类型分布、自动恢复次数、当前降级态。' +
      '**Read-only**。排查「记忆最近怎么老不召回」先看这个。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => {
        const d = v.degradation ?? {};
        const lines = [
          `memory_provider_fallback_stats: total=${v.total}（近 ${v.windowDays} 天 ${v.inWindow}）`,
          `  byOperation=${JSON.stringify(v.byOperation)}  byErrorType=${JSON.stringify(v.byErrorType)}`,
          `  自动恢复次数=${v.recoveredCount}`,
          `  当前降级态: degraded=${d.degraded} provider=${d.degradedProvider ?? '无'}` +
            ` 连续失败=${d.consecutiveFailures}` +
            `${d.recoverAt ? ` 计划恢复=${d.recoverAt}` : ''}`,
        ];
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute() {
      return roundTrip(await svc.getFallbackStats());
    },
  }));
}

export { apply, inject, name };
