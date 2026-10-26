/**
 * agint-verify-tools — host 平面：把 AGINT 的验证入口注册为**全局工具**
 *
 * ## 为什么需要这个插件（2026-10-21 立项）
 *
 * AGINT 的 cron / self-model 工具原本只在 `agint` preset 里（`.agent-presets/agint/agent.cordis.yml`
 * 的 25 个工具行）。但会话实际可能跑在别的 preset 上（本机实测：`agent-preset/selected`
 * 把 preset 切成过 `cordis`）⇒ 那些工具一个都不出现，**验证一次修复必须等一个 cron 周期**。
 *
 * 曾经的临时解法是整段覆盖 `preset-cordis` 的 `config.plugins`。那个解法有两个硬伤：
 *   ① 覆盖是整体替换（dsh-app-boot `applyPatches`：`target[key] = value`，不深合并）
 *      ⇒ 官方升级 cordis preset 后，新增插件被冻结的快照挡住，不再出现；
 *   ② 官方若改名/删除某个插件，快照里仍引用旧名 ⇒ 该 preset 可能整体起不来。
 *
 * 本插件改用**正确机制**：host 平面直接 `ctx.tools.register(...)`。
 * 依据 `@deepseek-ai/dsh-scope/lib/index.js:189-195`：
 *   `effect(ctx, action)` 里 `if (scope === void 0) layer = this.global;`
 * host 平面的 ctx 没有 scope ⇒ 注册进 **global 层** ⇒ 每个会话、每个 preset 都可见。
 * 现成先例：`agint-tool-stats` 的 `tool_stats_summary` 就是这么做，本会话（cordis preset）可用。
 *
 * ## 边界：只做转发，不复制业务逻辑
 *
 * 这里注册的 8 个工具全部**转调** host 服务（`agint.cron` / `agint.selfModel.*`）。
 * 真正的实现在 agint-cron / agint-self-model 的 `lib/tools.js` 里，本插件不复制它们 ——
 * 复制会造出第二份 schema，两边一漂就出「工具描述与实现不符」。
 *
 * ## 与 preset 内同名工具的关系
 *
 * 若某会话跑在 `agint` preset 上，那里也有同名工具（`agint-cron-tools` 等）。
 * `dsh-tools` 的解析规则是 **scoped 注册遮蔽 global**（`ToolLayer` / `ScopedLayers`），
 * 所以 agint preset 会话用 preset 内那份，其他 preset 会话用本插件这份。
 * 两份都是转调同一 host 服务 ⇒ 行为一致，不会互相打架。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'agint-verify-tools';

/**
 * 只 inject 服务，不 inject `tools`？—— 需要 `tools` 才能 register。
 * 这些服务由 host 平面的 agint-cron / agint-self-model 提供（同一 profile patch 层）。
 * 软依赖：某个服务缺失时只是少注册那几个工具，不影响其他工具（见 apply 里的逐段 try）。
 */
const inject = ['tools'];

/** 与 agint-self-model/lib/tools.js 的 asObjectResult 同口径（数组转对象信封）。 */
function asObjectResult(value, key = 'entries') {
  if (Array.isArray(value)) return { [key]: value, count: value.length };
  if (value === null || value === undefined) return { [key]: [], count: 0 };
  return value;
}

function apply(ctx) {
  const tools = ctx.tools;
  if (!tools || typeof tools.register !== 'function') return;

  // ⛔ 服务用 ctx.get 懒取：host 平面各插件挂载顺序不保证，apply 时未必就绪。
  //    每次 execute 再取一次，代价可忽略，换掉「挂载顺序耦合」这一整类故障。
  const svc = (key) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(key) : undefined;
    }
    catch {
      return undefined;
    }
  };

  // 统一注册帮手：把「服务缺失」变成一次明确的运行时错误，
  // 而不是工具列表里悄悄少一个（静默缺失比报错更难查）。
  const register = (definition, serviceKey, fn) => {
    tools.register(defineTool({
      ...definition,
      async execute(args) {
        const target = svc(serviceKey);
        if (target === undefined || target === null) {
          throw new Error(
            `${definition.name}: host 服务 "${serviceKey}" 不可用`
            + '（agint-cron / agint-self-model 未挂载？）',
          );
        }
        return fn(target, args ?? {});
      },
    }));
  };

  // ── agint.cron（3 个）──────────────────────────────────────────────────
  const cronDesc = 'Manually trigger a cron job by id. Returns the job result or error.';
  register({
    name: 'cron_list',
    description: 'List all scheduled cron jobs with their schedule, last run, next run, and health.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
  }, 'agint.cron', (cron) => cron.list());

  register({
    name: 'cron_run_now',
    description: `${cronDesc} Use to test or backfill.`,
    parameters: {
      id: { type: 'string', required: true, description: 'Job id (e.g. "night-dream").' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v.ok ? 'cron_run_now: OK' : `cron_run_now: FAILED — ${v.lastError}` }],
    },
  }, 'agint.cron', (cron, args) => cron.runNow(args.id));

  register({
    name: 'cron_health',
    description: 'Report cron health: overdue jobs, missed windows, last-run timestamps.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
  }, 'agint.cron', (cron) => cron.health());

  // ── agint.selfModel.*（5 个）───────────────────────────────────────────
  register({
    name: 'selfModel_snapshot',
    description:
      'Read the 智进 self-model snapshot (CAN/CANNOT/UNCERTAIN capability map + reasoning profile + resource baseline). '
      + 'Call before answering when UNCERTAIN or lastVerifiedAt is stale.',
    parameters: {
      domain: { type: 'string', description: 'Optional domain filter (e.g. "integration").' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
  }, 'agint.selfModel.snapshot', (snapshot, args) => snapshot(args.domain ? { domain: args.domain } : undefined));

  register({
    name: 'selfModel_update',
    description:
      'Trigger a self-model refresh from a known event. Updates the capability map; '
      + 'does NOT mutate qualityPolicy / mutator / population.',
    parameters: {
      trigger: { type: 'string', required: true, description: 'Trigger event name (e.g. "task-completed").' },
      evidence: { type: 'object', additionalProperties: true, description: 'Trigger evidence payload.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: `selfModel_update: ok=${v.ok} updated=${(v.updatedDomains ?? []).length}` }],
    },
  }, 'agint.selfModel.update', (update, args) => update({ trigger: args.trigger, evidence: args.evidence ?? {} }));

  register({
    name: 'selfModel_calibrate',
    description: 'Run per-domain calibration against observed evolution success rate over a window.',
    parameters: {
      windowDays: { type: 'integer', description: 'Lookback window in days (default 7).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
  }, 'agint.selfModel.calibrate', (calibrate, args) => asObjectResult(calibrate({ windowDays: args.windowDays ?? 7 }), 'results'));

  register({
    name: 'selfModel_stats',
    description: 'Auxiliary stats: counts of capability entries / calibration runs / observations.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
  }, 'agint.selfModel.stats', (stats) => stats());

  register({
    name: 'selfModel_inspectSummary',
    description: 'Auxiliary inspection summary for health checks.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
  }, 'agint.selfModel.inspectSummary', (inspectSummary) => inspectSummary());
}

export { apply, inject, name };
