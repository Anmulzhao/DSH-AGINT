/**
 * agint-memory-provider: MemoryManager —— provider 选择/激活/生命周期调度
 * （设计稿 §2.2 / §3.1 / §7）。
 *
 * **阶段 1 范围**（§12.1，2026-09-08 落地）：
 *   - activate / deactivate：激活期可用性检查 + 失败降级到 builtin（§3.1 [4]）
 *   - 生命周期调度：initialize → prefetch → syncTurn → shutdown（§3.1 [5]）
 *   - 琐碎输入过滤（§7）
 *   - 确定性召回指示器 RecallStatus（§3.1 [5]）
 *   - 事件：memory.provider-activated / provider-activation-failed /
 *     recall-injected
 *   - pause / resume 内存态开关
 *
 * **阶段 2 范围**（§12.2，本版本落地）：
 *   - 运行时降级（单次失败本轮降级 + 连续失败切换 + 自动恢复）（§3.1 [6]）
 *   - 召回超时保护（prefetch_timeout_ms，超时不阻塞对话）
 *   - fallback_events 表写入 + 降级计数窗口（failure_window_minutes）
 *   - pre_compress 检查点编排（fail-closed，api_version>=2）+
 *     pre_compress_checkpoints 表写入 + 防死锁回退（§13.2）
 *   - provider 工具动态注册（getToolSchemas → 加前缀 → 冲突检查）+
 *     handleToolCall 路由（§3.3）
 *   - testConnection：配置/凭证级可用性校验（不发起真实网络探活，见方法注释）
 *   - 新增事件：memory.provider-fallback / provider-recovered /
 *     pre-compress-checkpoint / tool-called
 *
 * 设计取舍：§9.3 自我评估禁止 —— 本管理器**不自动改配置**。阶段 2 的两类自动
 * 行为都不违反该条，因为它们是 §9.1 L1 降级保护护栏，且**只改运行时激活态、
 * 从不写 active_provider 配置**：
 *   - 激活失败 → builtin（L0 可用性兜底）
 *   - 连续失败 N 次 → 切到 builtin，到 auto_recover_after_minutes 后**恢复用户
 *     原先配置的那个 provider**（不是挑一个「更好」的 provider，也不改配置）
 */

import {
  BUILTIN_PROVIDER,
  FALLBACK_OPERATIONS,
  FALLBACK_ERROR_TYPES,
} from './schema.js';
import { isTrivialPrompt } from './trivial.js';

/**
 * 阶段 2（§12.2）已交付清单。原 SPRINT16_STAGES「未实现哨兵」随本版本作废：
 * 五项交付物全部实现，notImplemented() 只保留给后续 Sprint（§12.3）的
 * 健康检查 / metrics 集成等未接线项使用。
 */
const STAGE2_DELIVERED = Object.freeze([
  'handleRuntimeFailure', 'runPreCompressCheckpoint', 'registerProviderTools',
  'routeToolCall', 'testConnection',
]);

/** 超时错误标记：用于把 errorType 归类为 'timeout'（§4.4 枚举） */
class PrefetchTimeoutError extends Error {
  constructor(ms) {
    super(`prefetch 超时（>${ms}ms），本轮跳过外部 provider 召回`);
    this.name = 'PrefetchTimeoutError';
    this.timeoutMs = ms;
  }
}

/**
 * 给 promise 施加超时（§9.1 L1 召回超时保护）。
 * JS 无法真正取消已发起的异步操作，故超时后原 promise 继续跑但结果被丢弃
 * （settled 标志防止迟到的 settle 影响调用方状态）。
 */
function withTimeout(promise, ms, factory) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(factory(ms));
    }, ms);
    // 超时定时器不得吊住进程退出（node 冒烟测试直接跑本模块）
    if (typeof timer.unref === 'function') timer.unref();
    Promise.resolve(promise).then(
      (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
      (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } },
    );
  });
}

/**
 * 把任意错误归类到 §4.4 的 errorType 枚举（FROZEN，非法值会被 zod 拒）。
 * 只按错误文本/名字做保守推断，推断不出就是 'unknown'——不猜。
 */
function classifyErrorType(error) {
  if (error instanceof PrefetchTimeoutError) return 'timeout';
  const text = `${error?.name ?? ''} ${error?.message ?? String(error ?? '')}`.toLowerCase();
  if (/timeout|timed?\s*out|etimedout|超时/.test(text)) return 'timeout';
  if (/rate.?limit|429|too many requests|限流/.test(text)) return 'rate_limit';
  if (/401|403|unauthor|forbidden|auth|credential|api.?key|凭证|未授权/.test(text)) return 'auth';
  if (/enotfound|econnrefused|econnreset|network|socket|fetch failed|dns|连接/.test(text)) return 'network';
  return 'unknown';
}

/**
 * 内置记忆工具的保留名（§14.1 决策 B + §9.2 约束 7）。
 * 这些工具由 agint-memory 的 preset 平面直接提供，外部 provider 不得占用同名，
 * 否则动态注册会与既有工具冲突。provider 工具统一加前缀后仍撞这些名字 → 跳过。
 */
const RESERVED_TOOL_NAMES = Object.freeze(new Set([
  'memory_write', 'memory_search', 'memory_read', 'memory_stats', 'memory_forget_scan',
  // provider 管理层工具（本插件 tools.js 注册），同样不可被 provider 顶替
  'memory_provider_list', 'memory_provider_status', 'memory_provider_activate',
  'memory_provider_deactivate', 'memory_provider_test', 'memory_provider_config_get',
  'memory_provider_config_set', 'memory_provider_fallback_stats',
  'memory_provider_pause', 'memory_provider_resume',
]));

/**
 * pre_compress 检查点连续失败上限（§13.2 防死锁）。
 * 达到后即使 provider 声明 apiVersion=2（fail-closed），也回退为 best-effort 放行，
 * 避免「检查点持续失败 → 反复中止压缩 → token 溢出」。失败计数在成功时清零。
 */
const MAX_CHECKPOINT_FAILURES = 3;

/**
 * OpenAI function-calling 的 `parameters`（原生 JSON Schema）→ dsh defineTool 的
 * 属性映射规格。
 *
 * 为什么需要转换：provider.getToolSchemas() 按设计稿 §5.1 返回 OpenAI 格式
 * （`{ type:'object', properties:{...}, required:[...] }`），但 dsh 的 defineTool
 * 要求 `parameters` 是「属性名 → value schema」的映射（探测实证：直接传原生
 * JSON Schema 会报 "parameters.type must be a value schema object"）。
 *
 * dsh 约束（探测实证）：
 *   - 支持的标量类型：string / number / integer / boolean / null / array / object
 *   - object 类型必须显式带 additionalProperties（true/false），否则报错
 *   - required 通过每个属性的 `required: true` 表达，不是顶层 required 数组
 *
 * 转换失败/不支持的形态 → 降级为宽松的 `{ type:'object', additionalProperties:true }`，
 * 宁可放宽校验也不让工具注册整个失败（工具能注册比 schema 精确更重要）。
 *
 * @param {object|undefined} params OpenAI parameters 对象
 * @returns {object} dsh 属性映射规格
 */
function openAiParamsToDshSpec(params) {
  if (!params || typeof params !== 'object') return {};
  const props = params.properties;
  if (!props || typeof props !== 'object') return {};

  const requiredSet = Array.isArray(params.required) ? new Set(params.required) : null;
  const spec = {};
  for (const [key, jsonSchema] of Object.entries(props)) {
    const converted = jsonSchemaNodeToDsh(jsonSchema, requiredSet?.has(key) ?? false);
    if (converted) spec[key] = converted;
  }
  return spec;
}

/** 单个 JSON Schema 节点 → dsh value schema；不支持则返回宽松 object 兜底 */
function jsonSchemaNodeToDsh(node, required) {
  if (!node || typeof node !== 'object') {
    return required ? { type: 'string', required: true } : { type: 'string' };
  }
  const type = node.type;
  const SCALARS = ['string', 'number', 'integer', 'boolean', 'null'];
  const base = {};
  if (typeof node.description === 'string') base.description = node.description;
  if (Array.isArray(node.enum)) base.enum = node.enum;

  if (SCALARS.includes(type)) {
    return required ? { type, ...base, required: true } : { type, ...base };
  }
  if (type === 'array') {
    const items = jsonSchemaNodeToDsh(node.items, false) ?? { type: 'string' };
    // items 不能再带 required（数组元素无必填语义）
    const { required: _drop, ...itemSpec } = items;
    return required
      ? { type: 'array', items: itemSpec, ...base, required: true }
      : { type: 'array', items: itemSpec, ...base };
  }
  if (type === 'object') {
    const nested = openAiParamsToDshSpec(node);
    const addl = node.additionalProperties === true ? true
      : node.additionalProperties === false ? false : true;
    return required
      ? { type: 'object', properties: nested, additionalProperties: addl, ...base, required: true }
      : { type: 'object', properties: nested, additionalProperties: addl, ...base };
  }
  // 未知/缺失 type：宽松 object 兜底（探测实证 dsh 接受 type:'object'+additionalProperties）
  return required
    ? { type: 'object', additionalProperties: true, required: true }
    : { type: 'object', additionalProperties: true };
}

class MemoryManager {
  /**
   * @param {object} deps
   * @param {import('./registry.js').ProviderRegistry} deps.registry
   * @param {object} deps.builtin - BuiltinProvider 实例（§9.1 L0：始终可用）
   * @param {() => object} deps.config - 返回生效配置
   * @param {(table: string, business: object) => Promise<object>} [deps.record]
   *        持久化回调（activation_log / audit_log 写入），由 index.js 注入存储层
   * @param {(topic: string, payload: object) => Promise<boolean>} [deps.publish]
   *        事件发布回调（软依赖 event-bus），由 index.js 注入
   * @param {(msg: string) => void} [deps.debug]
   * @param {object} [deps.tools] - dsh 工具系统（ctx.tools）；提供则支持 provider
   *        工具动态注册（§3.3）。缺失时 registerProviderTools 返回 unavailable。
   * @param {Function} [deps.defineTool] - dsh defineTool 工厂（@deepseek-ai/dsh-tools）。
   *        缺失时 registerProviderTools 内部 lazy dynamic import 兜底（生产 host
   *        必有该包；冒烟测试不引 dsh 依赖，可注入 mock）。
   */
  constructor({ registry, builtin, config, record, publish, debug, tools, defineTool } = {}) {
    if (!registry || typeof registry.get !== 'function') {
      throw new Error('MemoryManager: 需要 ProviderRegistry');
    }
    if (!builtin || builtin.name !== BUILTIN_PROVIDER) {
      throw new Error('MemoryManager: 需要 BuiltinProvider 实例作为 fallback');
    }
    if (typeof config !== 'function') {
      throw new Error('MemoryManager: config 必须是返回生效配置的函数');
    }
    this.registry = registry;
    this.builtin = builtin;
    this.configFn = config;
    this.record = typeof record === 'function' ? record : async () => null;
    this.publish = typeof publish === 'function' ? publish : async () => false;
    this.debug = typeof debug === 'function' ? debug : () => {};
    /** dsh 工具系统（可能不可用；不可用时工具注册显式返回 unavailable，不静默） */
    this.tools = tools && typeof tools.register === 'function' ? tools : null;
    /** dsh defineTool 工厂（可注入 mock；缺省时 registerProviderTools 内 lazy import） */
    this.defineTool = typeof defineTool === 'function' ? defineTool : null;

    // §9.1 L0：默认激活 builtin，行为与现有 agint-memory 一致（§10.3 迁移路径）
    this.activeProvider = builtin;
    this.initialized = false;
    this.sessionId = null;
    this.turnNumber = 0;
    this.paused = false;
    /** 最近一次 prefetch 的召回状态（§3.1 [5]） */
    this.lastRecall = null;
    /** 最近一次激活结果，供 status 查询 */
    this.lastActivation = null;

    // ── 阶段 2：运行时降级状态（§3.1 [6]，全内存态，重启还原）─────────────
    /** 降级态：null = 未降级；否则记被降级的 provider 名 */
    this.degradedProvider = null;
    /** 连续失败计数（成功一次即清零） */
    this.consecutiveFailures = 0;
    /** 窗口内失败时间戳（failure_window_minutes 滚动裁剪） */
    this.failureTimestamps = [];
    /** 降级期间被替换下来的 provider 名，供自动恢复用（不改配置，§9.3） */
    this.recoveryTarget = null;
    /** 下次允许尝试自动恢复的时刻（epoch ms）；0 = 不自动恢复 */
    this.recoverAt = 0;
    /** 已注册的 provider 工具：name → { providerName, originalName, dispose } */
    this.registeredTools = new Map();
    /** pre_compress 检查点连续失败次数（§13.2 防死锁：N 次后回退 best-effort） */
    this.checkpointFailures = 0;
  }

  // ── 内部工具 ───────────────────────────────────────────────────────────

  cfg() {
    return this.configFn();
  }

  getActiveProviderName() {
    try {
      return this.activeProvider?.name ?? BUILTIN_PROVIDER;
    } catch {
      return BUILTIN_PROVIDER;
    }
  }

  isBuiltinActive() {
    return this.getActiveProviderName() === BUILTIN_PROVIDER;
  }

  // ── 生命周期：initialize（§3.1 [4]）────────────────────────────────────

  /**
   * 会话启动：激活配置指定的 provider（默认 builtin）。
   * 激活失败 → 降级到 builtin，不抛错（§9.1 L1：不中断对话）。
   */
  async start(sessionId, kwargs = {}) {
    this.sessionId = sessionId ?? null;
    const wanted = this.cfg().active_provider || BUILTIN_PROVIDER;

    // builtin 直接可用；外部 provider 走 activate 的完整校验路径
    const result = wanted === BUILTIN_PROVIDER
      ? await this.activate(BUILTIN_PROVIDER, { sessionId, kwargs, actor: 'system', reason: '启动激活' })
      : await this.activate(wanted, { sessionId, kwargs, actor: 'system', reason: '启动激活' });

    return result;
  }

  /**
   * 激活指定 provider（§3.1 [4]）。
   *
   * 顺序：存在性 → isAvailable()（不发网络请求，§9.2 约束 6）→ initialize()
   * → 置为 active。任一步失败：记录原因 + 降级 builtin + 发
   * memory.provider-activation-failed 事件（§5.4）。
   *
   * @returns {Promise<{ok: boolean, activeProvider: string, requested: string,
   *                    reason?: string, fellBack: boolean}>}
   */
  async activate(name, opts = {}) {
    const requested = String(name ?? BUILTIN_PROVIDER);
    const sessionId = opts.sessionId ?? this.sessionId;
    const kwargs = opts.kwargs ?? {};
    const actor = opts.actor ?? 'system';
    const reason = opts.reason ?? '手动激活';

    // 采纳显式传入的 sessionId（缺陷修复）：否则 activate({sessionId}) 只作用于
    // 本次 initialize，this.sessionId 仍是旧值/null → 后续 beginTurn 与
    // onSessionSwitch 的 previousSessionId 都拿不到会话标识。
    // 仅在调用方**显式**给出时采纳，undefined 表示「沿用当前会话」。
    if (opts.sessionId !== undefined) this.sessionId = opts.sessionId ?? null;

    // ── builtin：始终可用（§9.1 L0）────────────────────────────────────
    if (requested === BUILTIN_PROVIDER) {
      const t0 = Date.now();
      await this.builtin.initialize(sessionId, kwargs);
      const previous = this.getActiveProviderName();
      this.activeProvider = this.builtin;
      this.initialized = true;

      const durationMs = Date.now() - t0;
      this.lastActivation = {
        ok: true, requested, activeProvider: BUILTIN_PROVIDER,
        reason, fellBack: false, durationMs,
      };

      // 回到 builtin：卸掉此前外部 provider 挂的工具（§9.2 约束 5 清理语义）
      if (previous !== BUILTIN_PROVIDER) {
        await this.unregisterProviderTools().catch((e) => {
          this.debug(`[manager] builtin 接管后卸载工具失败: ${e?.message ?? e}`);
        });
      }

      await this.record('activation_log', {
        action: previous !== BUILTIN_PROVIDER ? 'deactivate' : 'activate',
        providerName: BUILTIN_PROVIDER,
        targetProvider: null,
        reason,
        sessionId,
        details: { isAvailable: true, initializeDurationMs: durationMs, errorMessage: null },
      });
      await this.record('audit_log', {
        actor, action: 'provider_activated', targetType: 'provider',
        targetId: BUILTIN_PROVIDER, details: { requested, previous }, reason,
      });
      await this.publish('memory.provider-activated', {
        providerName: BUILTIN_PROVIDER, sessionId,
      });

      this.debug(`[manager] activated builtin (${durationMs}ms)`);
      return { ...this.lastActivation };
    }

    // ── 外部 provider：存在性 → 可用性 → initialize ─────────────────────
    const provider = this.registry.get(requested);
    if (!provider) {
      return this.failActivation(requested, `provider '${requested}' 未注册`, sessionId, actor, reason);
    }

    let available = false;
    try {
      available = provider.isAvailable() === true;
    } catch (e) {
      return this.failActivation(
        requested, `isAvailable() 抛错: ${e?.message ?? e}`, sessionId, actor, reason,
      );
    }
    if (!available) {
      const why = this.safeReason(provider);
      return this.failActivation(
        requested, why || 'isAvailable() === false（未配置或凭证缺失）', sessionId, actor, reason,
      );
    }

    const t0 = Date.now();
    try {
      await provider.initialize(sessionId, kwargs);
    } catch (e) {
      return this.failActivation(
        requested, `initialize() 失败: ${e?.message ?? e}`, sessionId, actor, reason,
      );
    }
    const durationMs = Date.now() - t0;

    this.activeProvider = provider;
    this.initialized = true;
    this.lastActivation = {
      ok: true, requested, activeProvider: requested, reason, fellBack: false, durationMs,
    };

    await this.record('activation_log', {
      action: 'activate',
      providerName: requested,
      targetProvider: null,
      reason,
      sessionId,
      details: { isAvailable: true, initializeDurationMs: durationMs, errorMessage: null },
    });
    await this.record('audit_log', {
      actor, action: 'provider_activated', targetType: 'provider',
      targetId: requested, details: { initializeDurationMs: durationMs }, reason,
    });
    await this.publish('memory.provider-activated', { providerName: requested, sessionId });

    // §3.3 [2]：initialize 成功后注册 provider 工具（带前缀 + 冲突检查）。
    // 注册失败不回滚激活——工具缺失可在 memory_provider_status 里看见。
    await this.registerProviderTools().catch((e) => {
      this.debug(`[manager] ${requested} 工具注册失败: ${e?.message ?? e}`);
    });

    this.debug(`[manager] activated ${requested} (${durationMs}ms)`);
    return { ...this.lastActivation };
  }

  /** 激活失败统一处理：降级 builtin + 记录 + 发事件（§3.1 [4] / §5.4） */
  async failActivation(requested, reason, sessionId, actor) {
    // 降级到 builtin：builtin 可能尚未 initialize（首次启动就失败的情况）
    if (!this.initialized || this.activeProvider !== this.builtin) {
      await this.builtin.initialize(sessionId, {}).catch((e) => {
        this.debug(`[manager] builtin 降级 initialize 失败: ${e?.message ?? e}`);
      });
      this.activeProvider = this.builtin;
      this.initialized = true;
    }

    this.lastActivation = {
      ok: false, requested, activeProvider: BUILTIN_PROVIDER,
      reason, fellBack: true, durationMs: 0,
    };

    await this.record('activation_log', {
      action: 'fallback',
      providerName: requested,
      targetProvider: BUILTIN_PROVIDER,
      reason,
      sessionId,
      details: { isAvailable: false, initializeDurationMs: null, errorMessage: reason },
    });
    await this.record('audit_log', {
      actor: actor ?? 'system', action: 'provider_activation_failed', targetType: 'provider',
      targetId: requested, details: { fallbackTo: BUILTIN_PROVIDER }, reason,
    });
    await this.publish('memory.provider-activation-failed', {
      providerName: requested, reason, fallbackTo: BUILTIN_PROVIDER,
    });

    this.debug(`[manager] activation failed for ${requested}: ${reason} → builtin`);
    return { ...this.lastActivation };
  }

  safeReason(provider) {
    try {
      return typeof provider.unavailableReason === 'function'
        ? String(provider.unavailableReason() ?? '')
        : '';
    } catch {
      return '';
    }
  }

  /**
   * 停用外部 provider，回到 builtin（§5.3 deactivate）。
   * builtin 激活时调用是无害幂等的（仍走 activate('builtin')）。
   */
  async deactivate(opts = {}) {
    const previous = this.getActiveProviderName();
    const actor = opts.actor ?? 'human';
    const reason = opts.reason ?? '人工停用';

    // 关闭旧 provider 的资源（§9.2 约束 5）；失败不阻断降级
    if (previous !== BUILTIN_PROVIDER) {
      const old = this.registry.get(previous);
      await old?.shutdown?.().catch((e) => {
        this.debug(`[manager] ${previous}.shutdown() 失败: ${e?.message ?? e}`);
      });
    }

    const result = await this.activate(BUILTIN_PROVIDER, {
      actor, reason, sessionId: opts.sessionId ?? this.sessionId, kwargs: {},
    });
    return { ...result, previousProvider: previous };
  }

  // ── 召回阶段（§3.1 [5]）────────────────────────────────────────────────

  /**
   * 每轮开始：onTurnStart → 琐碎过滤 → prefetch → recallStatus → 发事件。
   *
   * @param {string} query 用户输入
   * @param {object} [opts] { sessionId, message, turnNumber }
   * @returns {Promise<{context: string, status: object|null, skipped: boolean,
   *                     skipReason?: string, providerName: string}>}
   */
  async beginTurn(query, opts = {}) {
    const cfg = this.cfg();
    const sessionId = opts.sessionId ?? this.sessionId;
    const turnNumber = Number.isInteger(opts.turnNumber)
      ? opts.turnNumber
      : (this.turnNumber + 1);
    this.turnNumber = turnNumber;

    // 阶段 2：降级后的自动恢复尝试（§8.1 auto_recover_after_minutes）。
    // 必须在取 activeProvider 之前调用——恢复成功会当场换 provider。
    // 失败不抛（恢复失败只是继续用 builtin，不影响本轮对话）。
    await this.maybeRecover().catch((e) => {
      this.debug(`[manager] maybeRecover 异常: ${e?.message ?? e}`);
    });

    const provider = this.activeProvider ?? this.builtin;
    const providerName = this.getActiveProviderName();

    // onTurnStart 始终调用（§7.3：琐碎输入也调，provider 可能需要计数）
    await provider.onTurnStart(turnNumber, opts.message ?? query, { sessionId })
      .catch((e) => this.debug(`[manager] onTurnStart 失败: ${e?.message ?? e}`));

    const skip = (skipReason) => {
      this.lastRecall = null;
      return { context: '', status: null, skipped: true, skipReason, providerName };
    };

    if (this.paused) return skip('paused');
    if (!cfg.prefetch_enabled) return skip('prefetch_disabled');

    // §7.3：琐碎输入不检索记忆
    if (cfg.trivial_prompt_filter_enabled && isTrivialPrompt(query)) {
      // 日志不落原始输入内容（§9.1 L2：日志不记录敏感数据）
      this.debug('[manager] trivial prompt → skip prefetch');
      return skip('trivial_prompt');
    }

    let context = '';
    try {
      // §9.1 L1 召回超时保护：超时跳过本轮召回，不阻塞对话响应。
      // builtin 是进程内本地检索（§11.5 ≤50ms），不套超时——避免本地调用被
      // 无谓地包一层定时器。
      context = this.isBuiltinActive()
        ? await provider.prefetch(query, { sessionId })
        : await withTimeout(
          provider.prefetch(query, { sessionId }),
          cfg.prefetch_timeout_ms,
          (ms) => new PrefetchTimeoutError(ms),
        );
    } catch (e) {
      // 阶段 2：走运行时降级编排（§3.1 [6]）——记 fallback_events + 计数 +
      // 必要时切 builtin，但**绝不让召回失败炸掉对话**（§9.2 约束 3）。
      const fb = await this.handleRuntimeFailure('prefetch', e, { turnNumber, sessionId });
      this.lastRecall = null;
      return {
        context: '',
        status: null,
        skipped: false,
        skipReason: fb.switched ? 'prefetch_error_switched' : 'prefetch_error',
        providerName,
        errorType: fb.errorType,
        degraded: fb.degraded,
        switched: fb.switched,
      };
    }

    // 成功即清零连续失败计数，并尝试从降级中恢复（§3.1 [6]）
    await this.noteSuccess(providerName);

    const status = this.safeRecallStatus(provider);
    this.lastRecall = status;

    // 召回指示器（§3.1 [5]）+ recall-injected 事件（§5.4）
    if (cfg.recall_indicator_enabled && status && status.count > 0) {
      await this.publish('memory.recall-injected', {
        providerName, count: status.count, sessionId, turnNumber,
      });
    }

    return {
      context: typeof context === 'string' ? context : '',
      status,
      skipped: false,
      providerName,
    };
  }

  safeRecallStatus(provider) {
    try {
      const s = provider.recallStatus?.();
      if (!s || typeof s !== 'object') return null;
      return {
        providerLabel: String(s.providerLabel ?? this.getActiveProviderName()),
        count: Number.isFinite(s.count) ? s.count : 0,
        glyph: String(s.glyph ?? '🧠'),
      };
    } catch {
      return null;
    }
  }

  /** 最近一次召回状态（Service/UI 用） */
  getRecallStatus() {
    return this.lastRecall ? { ...this.lastRecall } : null;
  }

  // ── 同步阶段（§3.1 [5]）────────────────────────────────────────────────

  /**
   * 每轮结束：非阻塞写入记忆（§3.1 [5]）。
   * 失败不抛（不影响对话），并计入运行时降级（阶段 2）。
   * 写入队列/重试策略属 §14.1「Sprint 16 启动前决策」的独立议题，本版本不做
   * 队列——失败即记 fallback_event，避免用未决策的重试策略掩盖真实失败。
   */
  async endTurn(userContent, assistantContent, opts = {}) {
    const cfg = this.cfg();
    if (this.paused || !cfg.sync_turn_enabled) {
      return { synced: false, reason: this.paused ? 'paused' : 'sync_disabled' };
    }

    const provider = this.activeProvider ?? this.builtin;
    const providerName = this.getActiveProviderName();
    const sessionId = opts.sessionId ?? this.sessionId;
    try {
      await provider.syncTurn(userContent, assistantContent, {
        sessionId, messages: opts.messages,
      });
      await this.noteSuccess(providerName);
      return { synced: true, providerName };
    } catch (e) {
      const fb = await this.handleRuntimeFailure('sync_turn', e, {
        turnNumber: this.turnNumber, sessionId,
      });
      return {
        synced: false,
        reason: 'provider_error',
        providerName,
        errorType: fb.errorType,
        degraded: fb.degraded,
        switched: fb.switched,
      };
    }
  }

  // ── pause / resume（内存态，重启还原）──────────────────────────────────

  pause(actor = 'human') {
    this.paused = true;
    this.debug('[manager] PAUSED（跳过召回与同步）');
    return this.record('audit_log', {
      actor, action: 'paused', targetType: 'manager', targetId: '*', details: {},
    }).then(() => ({ ok: true, paused: true }));
  }

  resume(actor = 'human') {
    this.paused = false;
    this.debug('[manager] RESUMED');
    return this.record('audit_log', {
      actor, action: 'resumed', targetType: 'manager', targetId: '*', details: {},
    }).then(() => ({ ok: true, paused: false }));
  }

  // ── 会话边界（§3.1 [7] / §5.1 hooks）───────────────────────────────────

  /** 会话切换：/resume, /branch, /reset, /new, compression（§5.1） */
  async onSessionSwitch(newSessionId, options = {}) {
    const provider = this.activeProvider ?? this.builtin;
    const previous = this.sessionId;
    this.sessionId = newSessionId ?? null;
    this.turnNumber = 0;
    await provider.onSessionSwitch?.(this.sessionId, { ...options, previousSessionId: previous })
      .catch((e) => this.debug(`[manager] onSessionSwitch 失败: ${e?.message ?? e}`));
    return { ok: true, sessionId: this.sessionId, previousSessionId: previous };
  }

  /** 会话结束（仅真实会话边界） */
  async onSessionEnd(messages = []) {
    const provider = this.activeProvider ?? this.builtin;
    await provider.onSessionEnd?.(messages)
      .catch((e) => this.debug(`[manager] onSessionEnd 失败: ${e?.message ?? e}`));
    return { ok: true };
  }

  /**
   * 关闭：刷新队列 + 关闭连接（§3.1 [7]）。
   * 只关当前激活的外部 provider；**builtin 的 agint 域由 agint-memory 自己的
   * disposer 关闭**，这里不调用 builtin.shutdown() 以外的资源释放。
   */
  async shutdown() {
    const provider = this.activeProvider;
    const name = this.getActiveProviderName();
    try {
      await provider?.shutdown?.();
    } catch (e) {
      this.debug(`[manager] ${name}.shutdown() 失败: ${e?.message ?? e}`);
    }
    this.initialized = false;
    this.activeProvider = this.builtin;
    this.lastRecall = null;
    return { ok: true, shutdownProvider: name };
  }

  // ── 阶段 2：运行时降级（§3.1 [6] / §9.1 L1）────────────────────────────

  /**
   * 处理一次外部 provider 运行时失败。
   *
   * 分层行为（§3.1 [6]）：
   *   1. 单次失败 → 本轮降级：调用方拿到空结果/失败标记，**对话不中断**；
   *      记 fallback_events + 发 memory.provider-fallback。
   *   2. 连续失败达 max_consecutive_failures（窗口 failure_window_minutes 内）
   *      → 切换到 builtin：关闭失败 provider 的资源、卸载其工具、记
   *      activation_log(action=fallback)，并按 auto_recover_after_minutes
   *      安排恢复。
   *   3. builtin 自身失败 → 无处可降级（L0 兜底已是最后一层），只记录不切换。
   *
   * §9.3 边界：本方法**只改运行时激活态，从不写 active_provider 配置**。
   *
   * @param {string} operation §4.4 FALLBACK_OPERATIONS 之一
   * @param {unknown} error
   * @param {object} [meta] { turnNumber, sessionId, providerName }
   * @returns {Promise<{degraded: boolean, switched: boolean, errorType: string,
   *                     consecutiveFailures: number, recoverAt: number|null}>}
   */
  async handleRuntimeFailure(operation, error, meta = {}) {
    const cfg = this.cfg();
    const op = FALLBACK_OPERATIONS.includes(operation) ? operation : 'prefetch';
    const errorType = classifyErrorType(error);
    // 错误详情默认不落库（§9.1 L2 日志不记录敏感数据）；debug 开关由人工决定
    const errorMessage = cfg.log_sensitive_data
      ? String(error?.message ?? error ?? '').slice(0, 500)
      : `${errorType} error（详情未记录：log_sensitive_data=false）`;
    const providerName = meta.providerName ?? this.getActiveProviderName();
    const sessionId = meta.sessionId ?? this.sessionId;
    const now = Date.now();

    // 窗口内失败计数：裁掉窗口外的旧时间戳，再记本次
    const windowMs = Math.max(1, cfg.failure_window_minutes) * 60_000;
    this.failureTimestamps = this.failureTimestamps.filter((t) => now - t <= windowMs);
    this.failureTimestamps.push(now);
    this.consecutiveFailures += 1;

    const threshold = Math.max(1, cfg.max_consecutive_failures);
    const shouldSwitch = cfg.fallback_enabled
      && !this.isBuiltinActive()
      && this.consecutiveFailures >= threshold;

    let switched = false;
    if (shouldSwitch) {
      switched = await this.switchToBuiltinAfterFailures(providerName, cfg, now, sessionId);
    } else if (!this.isBuiltinActive()) {
      // 单次失败：标记降级态但保持当前 provider（下一轮继续尝试，避免抖动切换）
      this.degradedProvider = providerName;
    }

    await this.record('fallback_events', {
      providerName,
      operation: op,
      errorType,
      errorMessage,
      sessionId,
      turnNumber: Number.isInteger(meta.turnNumber) ? meta.turnNumber : null,
      recovered: switched,
      recoveryAction: switched ? 'fallback_to_builtin' : null,
    });

    await this.publish('memory.provider-fallback', {
      providerName,
      operation: op,
      errorType,
      recovered: switched,
      consecutiveFailures: this.consecutiveFailures,
      activeProvider: this.getActiveProviderName(),
    });

    this.debug(
      `[manager] runtime failure op=${op} type=${errorType} ` +
      `count=${this.consecutiveFailures}/${threshold} switched=${switched}`,
    );

    return {
      degraded: Boolean(this.degradedProvider),
      switched,
      errorType,
      consecutiveFailures: this.consecutiveFailures,
      recoverAt: this.recoverAt || null,
      reason: errorMessage,
    };
  }

  /** 连续失败达阈值 → 切 builtin（关资源 + 卸工具 + 记日志 + 安排恢复） */
  async switchToBuiltinAfterFailures(providerName, cfg, now, sessionId) {
    // 先卸载该 provider 的工具：它已不可用，工具留着只会持续报错
    await this.unregisterProviderTools(providerName);

    const old = this.registry.get(providerName);
    await old?.shutdown?.().catch((e) => {
      this.debug(`[manager] ${providerName}.shutdown() 失败（降级路径）: ${e?.message ?? e}`);
    });

    // builtin 可能尚未 initialize（极端情况），initialize 失败也要保证 active 指向它
    try {
      await this.builtin.initialize(sessionId, {});
    } catch (e) {
      this.debug(`[manager] builtin 接管 initialize 失败: ${e?.message ?? e}`);
    }
    this.activeProvider = this.builtin;
    this.initialized = true;
    this.degradedProvider = null;
    this.consecutiveFailures = 0;
    this.failureTimestamps = [];

    // 自动恢复：恢复到**用户配置的那个 provider**，不是挑一个「更好」的
    // （§9.3：不改配置、不做自我优化）。0 = 不自动恢复，等重启或人工 activate。
    const recoverMinutes = Math.max(0, Number(cfg.auto_recover_after_minutes) || 0);
    this.recoveryTarget = providerName;
    this.recoverAt = recoverMinutes > 0 ? now + recoverMinutes * 60_000 : 0;

    await this.record('activation_log', {
      action: 'fallback',
      providerName,
      targetProvider: BUILTIN_PROVIDER,
      reason: `连续失败达阈值（${cfg.max_consecutive_failures} 次 / ${cfg.failure_window_minutes} 分钟窗口）→ 运行时切换 builtin`,
      sessionId,
      details: {
        isAvailable: false,
        initializeDurationMs: null,
        errorMessage: null,
        consecutiveFailures: cfg.max_consecutive_failures,
        recoverAt: this.recoverAt ? new Date(this.recoverAt).toISOString() : null,
      },
    });
    await this.record('audit_log', {
      actor: 'system',
      action: 'provider_runtime_fallback',
      targetType: 'provider',
      targetId: providerName,
      details: { fallbackTo: BUILTIN_PROVIDER, recoverAt: this.recoverAt || null },
      reason: '连续失败自动降级（§9.1 L1 护栏，非自我优化）',
    });

    this.debug(`[manager] switched ${providerName} → builtin（连续失败达阈值）`);
    return true;
  }

  /** 成功调用：清零连续失败计数（§3.1 [6]「连续」语义） */
  async noteSuccess(providerName) {
    if (this.consecutiveFailures !== 0) {
      this.consecutiveFailures = 0;
      this.failureTimestamps = [];
    }
    // 成功即视为该 provider 健康：清除「单次失败」的降级标记。
    // 注意不动 recoveryTarget/recoverAt——那是切换态的恢复计划。
    if (this.degradedProvider === providerName) this.degradedProvider = null;
  }

  /**
   * 降级后的自动恢复尝试（§8.1 auto_recover_after_minutes）。
   * 在 beginTurn 开头调用：到点才试，失败则按同一间隔退避（不每轮猛敲外部 API）。
   *
   * @returns {Promise<{attempted: boolean, recovered: boolean, providerName?: string}>}
   */
  async maybeRecover() {
    if (!this.recoverAt || Date.now() < this.recoverAt) return { attempted: false, recovered: false };
    const target = this.recoveryTarget;
    const cfg = this.cfg();
    if (!target || !cfg.fallback_enabled) {
      this.recoverAt = 0;
      return { attempted: false, recovered: false };
    }

    const backoffMs = Math.max(0, Number(cfg.auto_recover_after_minutes) || 0) * 60_000;
    // 先退避再尝试：失败时不会在同一轮内被反复触发
    this.recoverAt = backoffMs > 0 ? Date.now() + backoffMs : 0;

    const provider = this.registry.get(target);
    if (!provider) {
      this.recoveryTarget = null;
      this.recoverAt = 0;
      return { attempted: true, recovered: false, providerName: target };
    }

    let available = false;
    try {
      available = provider.isAvailable() === true;
      if (available) await provider.initialize(this.sessionId, {});
    } catch (e) {
      this.debug(`[manager] 自动恢复 ${target} 失败: ${e?.message ?? e}`);
      return { attempted: true, recovered: false, providerName: target };
    }
    if (!available) {
      this.debug(`[manager] 自动恢复 ${target} 跳过：isAvailable()=false`);
      return { attempted: true, recovered: false, providerName: target };
    }

    this.activeProvider = provider;
    this.initialized = true;
    this.degradedProvider = null;
    this.recoveryTarget = null;
    this.recoverAt = 0;
    this.consecutiveFailures = 0;
    this.failureTimestamps = [];

    await this.record('activation_log', {
      action: 'recover',
      providerName: target,
      targetProvider: null,
      reason: `自动恢复（距上次降级 ${cfg.auto_recover_after_minutes} 分钟）`,
      sessionId: this.sessionId,
      details: { isAvailable: true, initializeDurationMs: null, errorMessage: null },
    });
    await this.record('audit_log', {
      actor: 'system',
      action: 'provider_recovered',
      targetType: 'provider',
      targetId: target,
      details: { from: BUILTIN_PROVIDER },
      reason: '恢复用户原配置的 provider（未修改任何配置，§9.3）',
    });
    await this.publish('memory.provider-recovered', {
      providerName: target,
      sessionId: this.sessionId,
    });

    // 恢复后重新注册该 provider 的工具（切换时已卸载）
    await this.registerProviderTools().catch((e) => {
      this.debug(`[manager] 恢复后重注册工具失败: ${e?.message ?? e}`);
    });

    this.debug(`[manager] recovered ${target}（builtin → ${target}）`);
    return { attempted: true, recovered: true, providerName: target };
  }

  /** 降级态快照（Service / memory_provider_fallback_stats 用） */
  getDegradationState() {
    return {
      degraded: Boolean(this.degradedProvider),
      degradedProvider: this.degradedProvider,
      consecutiveFailures: this.consecutiveFailures,
      failuresInWindow: this.failureTimestamps.length,
      recoveryTarget: this.recoveryTarget,
      recoverAt: this.recoverAt ? new Date(this.recoverAt).toISOString() : null,
      checkpointFailures: this.checkpointFailures,
      registeredTools: [...this.registeredTools.keys()],
    };
  }

  // ── 阶段 2：pre_compress 检查点（§3.2 / §9.1 L5 fail-closed）───────────

  /**
   * 压缩前检查点编排（§3.2）。
   *
   * ⚠️ **接线状态（诚实边界）**：宿主 dsh v0.1.3 的 compaction 子系统只提供
   * `CompactionEngine.compactIfNeeded/compactNow/compactRegion` 与
   * `compaction/start|summary|end` 三个事件，**没有 pre-compact 钩子或事件**。
   * 因此本方法当前无法被压缩流程自动调用——它是一个已实现、可测试、可被上层
   * 显式调用的检查点编排器，等宿主暴露 pre-compact 扩展点后接线（§13.1
   * 「dsh 压缩机制的 pre-compress 事件不可用」风险的最坏情况分支）。
   *
   * 语义（§3.2 [3]）：
   *   - provider.preCompressCheckpointApiVersion >= 2 → **fail-closed**：
   *     onPreCompress 抛错即视为「洞察未持久化」→ 返回 abortCompress=true，
   *     调用方必须中止压缩并保留原始消息。
   *   - apiVersion === 1 → best-effort：失败也放行（记 best_effort 状态）。
   *   - 防死锁（§13.2）：连续失败达 MAX_CHECKPOINT_FAILURES 后，即使
   *     apiVersion=2 也降级为 best-effort 放行 + 记告警，避免「反复中止压缩
   *     导致 token 溢出」。
   *
   * @param {Array} messages 即将被压缩的消息
   * @param {object} [opts] { sessionId }
   * @returns {Promise<{ok: boolean, abortCompress: boolean, status: string,
   *                     insight: string, providerName: string, apiVersion: number,
   *                     durationMs: number, reason?: string}>}
   */
  async runPreCompressCheckpoint(messages, opts = {}) {
    const cfg = this.cfg();
    const provider = this.activeProvider ?? this.builtin;
    const providerName = this.getActiveProviderName();
    const sessionId = opts.sessionId ?? this.sessionId;
    const list = Array.isArray(messages) ? messages : [];

    if (!cfg.pre_compress_checkpoint_enabled) {
      const skipped = await this.recordCheckpoint({
        providerName, sessionId, apiVersion: this.safeApiVersion(provider),
        messagesCompressed: list.length, insightLength: 0,
        checkpointStatus: 'skipped', errorMessage: null, durationMs: 0,
      });
      return {
        ok: true, abortCompress: false, status: 'skipped', insight: '',
        providerName, apiVersion: this.safeApiVersion(provider),
        durationMs: 0, checkpointId: skipped?.id ?? null,
        reason: 'pre_compress_checkpoint_enabled=false',
      };
    }

    const apiVersion = this.safeApiVersion(provider);
    const t0 = Date.now();
    let insight = '';
    let error = null;
    try {
      const raw = await provider.onPreCompress(list);
      insight = typeof raw === 'string' ? raw : '';
    } catch (e) {
      error = e;
    }
    const durationMs = Date.now() - t0;

    // fail-closed 判定：apiVersion>=2 且开关开启，且未触发防死锁回退
    const deadlockGuard = this.checkpointFailures >= MAX_CHECKPOINT_FAILURES;
    const wantsFailClosed = cfg.pre_compress_fail_closed && apiVersion >= 2;
    const failClosed = wantsFailClosed && !deadlockGuard;

    if (error) {
      this.checkpointFailures += 1;
      const errorMessage = cfg.log_sensitive_data
        ? String(error?.message ?? error).slice(0, 500)
        : 'checkpoint 失败（详情未记录：log_sensitive_data=false）';

      // 洞察提取失败也要记 fallback_events（operation=on_pre_compress，§4.4）
      if (!this.isBuiltinActive()) {
        await this.record('fallback_events', {
          providerName,
          operation: 'on_pre_compress',
          errorType: classifyErrorType(error),
          errorMessage,
          sessionId,
          turnNumber: null,
          recovered: false,
          recoveryAction: null,
        });
      }

      const status = failClosed ? 'failed' : 'best_effort';
      const rec = await this.recordCheckpoint({
        providerName, sessionId, apiVersion, messagesCompressed: list.length,
        insightLength: 0, checkpointStatus: status, errorMessage, durationMs,
      });
      await this.publish('memory.pre-compress-checkpoint', {
        providerName, status, messagesCompressed: list.length,
        abortCompress: failClosed, apiVersion,
        // P3-1 最小 PR（设计稿 §5.1 载荷缺口正解②，< 5 行授权范围内）：
        // 补 checkpointId + sessionId，compress-guard 依赖它做 raw 关联
        checkpointId: rec?.id ?? null,
        sessionId,
      });

      this.debug(
        `[manager] pre_compress FAILED provider=${providerName} apiV=${apiVersion} ` +
        `failClosed=${failClosed} consecutive=${this.checkpointFailures}`,
      );

      return {
        ok: false,
        // fail-closed：中止压缩，调用方保留原始消息（§9.1 L5）
        abortCompress: failClosed,
        status,
        insight: '',
        providerName, apiVersion, durationMs,
        checkpointId: rec?.id ?? null,
        reason: errorMessage,
        deadlockGuard,
      };
    }

    // 成功：清零连续失败计数
    this.checkpointFailures = 0;
    const status = apiVersion >= 2 ? 'success' : 'best_effort';
    const rec = await this.recordCheckpoint({
      providerName, sessionId, apiVersion, messagesCompressed: list.length,
      insightLength: insight.length, checkpointStatus: status,
      errorMessage: null, durationMs,
    });
    await this.publish('memory.pre-compress-checkpoint', {
      providerName, status, messagesCompressed: list.length,
      abortCompress: false, apiVersion, insightLength: insight.length,
      // P3-1 最小 PR：同上（§5.1 载荷缺口正解②）
      checkpointId: rec?.id ?? null,
      sessionId,
    });

    this.debug(
      `[manager] pre_compress OK provider=${providerName} apiV=${apiVersion} ` +
      `status=${status} insight=${insight.length} chars`,
    );

    return {
      ok: true, abortCompress: false, status, insight,
      providerName, apiVersion, durationMs,
      checkpointId: rec?.id ?? null,
      deadlockGuard: false,
    };
  }

  safeApiVersion(provider) {
    const v = provider?.preCompressCheckpointApiVersion;
    return v === 2 ? 2 : 1;
  }

  /** 写 pre_compress_checkpoints 表；存储不可用不得影响压缩决策（返回 null） */
  async recordCheckpoint(business) {
    return this.record('pre_compress_checkpoints', business).catch((e) => {
      this.debug(`[manager] 检查点落库失败: ${e?.message ?? e}`);
      return null;
    });
  }

  // ── 阶段 2：provider 工具暴露（§3.3）───────────────────────────────────

  /**
   * 注册当前激活 provider 暴露的工具（§3.3 [1]-[2]）。
   *
   * 规则：
   *   - 前缀：`external_tool_prefix` 非空则用之，否则用 `<providerName>_`；
   *     provider 自己已带该前缀时不重复加。
   *   - 冲突（§9.2 约束 7 / §13.1）：与已注册工具或内置 memory_* 保留名重名
   *     → **跳过该工具并记录原因**，不覆盖、不静默吞。
   *   - builtin 返回 `[]`（§14.1 决策 B）→ 本方法对 builtin 是 no-op。
   *   - 宿主工具系统不可用 → 显式返回 unavailable，不假装成功。
   *
   * @returns {Promise<{ok: boolean, providerName: string, registered: Array,
   *                     skipped: Array, total: number, reason?: string}>}
   */
  async registerProviderTools() {
    const cfg = this.cfg();
    const provider = this.activeProvider ?? this.builtin;
    const providerName = this.getActiveProviderName();
    const result = { ok: false, providerName, registered: [], skipped: [], total: 0 };

    if (!cfg.external_provider_tools_enabled) {
      return { ...result, reason: 'external_provider_tools_enabled=false' };
    }
    if (!this.tools) {
      // 显式不可用（真实 > 讨好）：不返回假成功
      return { ...result, reason: 'tools_unavailable（宿主工具系统未注入）' };
    }
    // defineTool 工厂：优先用注入的（测试 mock），否则 lazy dynamic import
    // '@deepseek-ai/dsh-tools'（生产 host 必有；冒烟测试不引 dsh 依赖，走不到
    // 这里——harness 不注入 tools 时已在上方返回 unavailable）。
    if (typeof this.defineTool !== 'function') {
      try {
        const mod = await import('@deepseek-ai/dsh-tools');
        this.defineTool = typeof mod.defineTool === 'function' ? mod.defineTool : null;
      } catch (e) {
        this.defineTool = null;
      }
      if (typeof this.defineTool !== 'function') {
        return { ...result, reason: 'defineTool_unavailable（@deepseek-ai/dsh-tools 导入失败）' };
      }
    }

    let schemas = [];
    try {
      schemas = provider.getToolSchemas() ?? [];
    } catch (e) {
      return { ...result, reason: `getToolSchemas() 抛错: ${e?.message ?? e}` };
    }
    if (!Array.isArray(schemas) || schemas.length === 0) {
      // builtin 与「不暴露工具」的 provider 走这里，是正常态而非错误
      return { ...result, ok: true, reason: schemas.length === 0 ? 'no_tools_declared' : undefined };
    }

    const prefix = String(cfg.external_tool_prefix || `${providerName}_`);
    for (const s of schemas) {
      const original = String(s?.name ?? '');
      if (!original) {
        result.skipped.push({ originalName: null, reason: 'schema 缺少 name' });
        continue;
      }
      const finalName = original.startsWith(prefix) ? original : `${prefix}${original}`;

      if (RESERVED_TOOL_NAMES.has(finalName)) {
        result.skipped.push({
          originalName: original, name: finalName,
          reason: '与内置记忆工具保留名冲突（§14.1 决策 B：memory_* 归 agint-memory）',
        });
        continue;
      }
      if (this.registeredTools.has(finalName) || this.toolExists(finalName)) {
        result.skipped.push({
          originalName: original, name: finalName,
          reason: '工具名已被占用（§9.2 约束 7：不得覆盖既有工具）',
        });
        continue;
      }

      let dispose = null;
      try {
        const definition = this.defineTool({
          name: finalName,
          // 描述里标注来源 provider，便于排障时定位（§9.1 L4 可追溯）
          description: `[${providerName}] ${String(s.description ?? '')}`.trim(),
          parameters: openAiParamsToDshSpec(s.parameters),
          output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{
              type: 'text',
              text: typeof value === 'string' ? value : JSON.stringify(value ?? null),
            }],
          },
          // 路由回 provider.handleToolCall（§3.3 [3]）；传原始名，provider 认自己的命名
          execute: async (args) => this.routeToolCall(finalName, args ?? {}, {
            sessionId: this.sessionId,
            turnNumber: this.turnNumber,
          }),
        });
        dispose = this.tools.register(definition);
      } catch (e) {
        result.skipped.push({
          originalName: original, name: finalName,
          reason: `注册失败: ${e?.message ?? e}`,
        });
        continue;
      }

      this.registeredTools.set(finalName, {
        providerName, originalName: original, dispose,
      });
      result.registered.push({ name: finalName, originalName: original });
    }

    result.total = result.registered.length;
    result.ok = true;

    if (result.total > 0) {
      await this.record('audit_log', {
        actor: 'system', action: 'provider_tools_registered', targetType: 'provider',
        targetId: providerName,
        details: { tools: result.registered.map((t) => t.name), skipped: result.skipped.length },
        reason: '阶段 2 工具动态注册（§3.3）',
      });
    }
    this.debug(
      `[manager] registered ${result.total} tools for ${providerName}` +
      (result.skipped.length ? `（跳过 ${result.skipped.length}）` : ''),
    );
    return result;
  }

  /** 宿主工具是否已存在（tools.get 可能不可用 → 视为不存在，由 register 自身兜冲突） */
  toolExists(name) {
    try {
      if (typeof this.tools?.get === 'function') return Boolean(this.tools.get(name));
    } catch {
      /* get 抛错不作为「存在」证据 */
    }
    return false;
  }

  /**
   * 卸载 provider 工具（切换/降级/关闭时调用，§9.2 约束 5 清理语义）。
   * @param {string} [providerName] 只卸该 provider 的；缺省卸全部
   */
  async unregisterProviderTools(providerName) {
    const removed = [];
    for (const [name, entry] of [...this.registeredTools.entries()]) {
      if (providerName && entry.providerName !== providerName) continue;
      try {
        if (typeof entry.dispose === 'function') entry.dispose();
      } catch (e) {
        this.debug(`[manager] 卸载工具 ${name} 失败: ${e?.message ?? e}`);
      }
      this.registeredTools.delete(name);
      removed.push(name);
    }
    if (removed.length) {
      this.debug(`[manager] unregistered tools: ${removed.join(', ')}`);
    }
    return { removed, count: removed.length };
  }

  /** 已注册的 provider 工具清单（Service / 排障用） */
  listProviderTools() {
    return [...this.registeredTools.entries()].map(([name, e]) => ({
      name, originalName: e.originalName, providerName: e.providerName,
    }));
  }

  /**
   * 路由 provider 工具调用（§3.3 [3]）。
   *
   * 未注册的工具名 → **显式抛错**，不静默返回空（provider.js 同策略）。
   * provider.handleToolCall 失败 → 记 fallback_events + 发 tool-called(success=false)，
   * 并把错误抛回调用方（工具失败必须让模型看见，否则它会以为写入成功了）。
   *
   * @param {string} toolName 注册后的带前缀名
   * @param {object} args
   * @param {object} [kwargs]
   * @returns {Promise<object>} provider 返回的 JSON 字符串会被解析成对象；
   *          解析失败则原样包在 { raw } 里（不丢数据）
   */
  async routeToolCall(toolName, args = {}, kwargs = {}) {
    const entry = this.registeredTools.get(String(toolName));
    if (!entry) {
      throw new Error(
        `routeToolCall: 工具 '${toolName}' 未注册。已注册: ` +
        `${[...this.registeredTools.keys()].join(', ') || '(none)'}`,
      );
    }

    const provider = this.registry.get(entry.providerName) ?? this.activeProvider;
    if (!provider) {
      throw new Error(`routeToolCall: provider '${entry.providerName}' 已不在注册表`);
    }

    const t0 = Date.now();
    let raw = null;
    let error = null;
    try {
      // 传原始名：provider 认自己声明的命名，不认我们加的前缀
      raw = await provider.handleToolCall(entry.originalName, args, {
        sessionId: this.sessionId,
        ...kwargs,
      });
    } catch (e) {
      error = e;
    }
    const durationMs = Date.now() - t0;

    await this.publish('memory.tool-called', {
      providerName: entry.providerName,
      toolName: entry.originalName,
      success: !error,
      durationMs,
    });

    if (error) {
      const cfg = this.cfg();
      await this.handleRuntimeFailure('handle_tool_call', error, {
        providerName: entry.providerName,
        turnNumber: this.turnNumber,
        sessionId: this.sessionId,
      });
      // 抛回调用方：工具失败不得被包装成成功（真实 > 讨好）
      throw new Error(
        `provider 工具 ${toolName} 调用失败: ` +
        (cfg.log_sensitive_data ? String(error?.message ?? error) : classifyErrorType(error)),
      );
    }

    // provider 契约返回 JSON 字符串（§5.1）；容错解析，解析不了就原样带回
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch {
        return { raw };
      }
    }
    return raw ?? null;
  }

  // ── 阶段 2：连接测试（§5.3 testConnection）─────────────────────────────

  /**
   * 测试 provider 可用性（§5.3 / §6 memory_provider_test）。
   *
   * **诚实边界**：§9.2 约束 6 规定 isAvailable() 只检查配置/凭证、**不得发起
   * 网络请求**。因此本方法做的是「配置/凭证级校验 + 可选 initialize 试探」，
   * 不是真实端到端连通性探活。真实网络探活属 §12.3 阶段 3「定期健康检查
   * （cron job）」范围，届时由 provider 自己实现探活方法再接进来。
   *
   * @param {string} [name] 缺省测当前激活的
   * @returns {Promise<{ok: boolean, providerName: string, registered: boolean,
   *                     available: boolean, reason: string|null,
   *                     initializeOk: boolean|null, durationMs: number,
   *                     networkProbed: false}>}
   */
  async testConnection(name) {
    const target = String(name ?? this.getActiveProviderName());
    const provider = target === BUILTIN_PROVIDER ? this.builtin : this.registry.get(target);
    const out = {
      ok: false,
      providerName: target,
      registered: Boolean(provider),
      available: false,
      reason: null,
      initializeOk: null,
      durationMs: 0,
      // 显式声明未做网络探活，避免调用方误以为是端到端连通性验证
      networkProbed: false,
    };

    if (!provider) {
      out.reason = `provider '${target}' 未注册`;
      await this.recordValidation(target, 'unavailable', out.reason);
      return out;
    }

    const t0 = Date.now();
    try {
      out.available = provider.isAvailable() === true;
    } catch (e) {
      out.reason = `isAvailable() 抛错: ${e?.message ?? e}`;
      out.durationMs = Date.now() - t0;
      await this.recordValidation(target, 'error', out.reason);
      return out;
    }
    if (!out.available) {
      out.reason = this.safeReason(provider) || 'isAvailable() === false（未配置或凭证缺失）';
      out.durationMs = Date.now() - t0;
      await this.recordValidation(target, 'unavailable', out.reason);
      return out;
    }

    // 可用 → 试探 initialize（这是本地/建连语义，不等于业务 API 探活）
    try {
      await provider.initialize(this.sessionId, {});
      out.initializeOk = true;
    } catch (e) {
      out.initializeOk = false;
      out.reason = `initialize() 失败: ${e?.message ?? e}`;
      out.durationMs = Date.now() - t0;
      await this.recordValidation(target, 'error', out.reason);
      return out;
    }

    out.ok = true;
    out.durationMs = Date.now() - t0;
    out.reason = '配置/凭证校验通过（未做网络探活，见方法注释）';
    await this.recordValidation(target, 'available', out.reason);
    return out;
  }

  /** 把校验结果写回 provider_config（§4.2 lastValidatedAt / validationResult） */
  async recordValidation(providerName, validationResult, reason) {
    await this.record('audit_log', {
      actor: 'system',
      action: 'provider_connection_tested',
      targetType: 'provider',
      targetId: providerName,
      details: { validationResult, networkProbed: false },
      // 只记结果分类，不记可能含凭证信息的原始错误（§9.1 L2）
      reason: this.cfg().log_sensitive_data ? String(reason ?? '').slice(0, 500) : validationResult,
    }).catch(() => {});
  }

  // ── 后续 Sprint 接力：显式抛错，绝不静默（真实 > 讨好）─────────────────

  notImplemented(stage, sprint = 'Sprint 17（设计稿 §12.3）') {
    throw new Error(
      `agint.memoryProvider: ${stage} 未实现（${sprint} 交付）；` +
      '当前版本已完成阶段 2（§12.2：运行时降级 + pre_compress fail-closed + 工具暴露）',
    );
  }

  // 注：registerProviderTools / routeToolCall / testConnection / handleRuntimeFailure /
  // runPreCompressCheckpoint 五项阶段 2 交付物均已在本文件上方实现，
  // 不再保留「显式抛未实现」桩（原桩会覆盖真实实现，已删除）。
}

export {
  MemoryManager,
  STAGE2_DELIVERED,
  PrefetchTimeoutError,
  withTimeout,
  classifyErrorType,
  openAiParamsToDshSpec,
  RESERVED_TOOL_NAMES,
  MAX_CHECKPOINT_FAILURES,
};
