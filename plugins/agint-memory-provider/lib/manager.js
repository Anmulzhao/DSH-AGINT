/**
 * agint-memory-provider: MemoryManager —— provider 选择/激活/生命周期调度
 * （设计稿 §2.2 / §3.1 / §7）。
 *
 * **Sprint 15 范围**（§12.1）：
 *   - activate / deactivate：激活期可用性检查 + 失败降级到 builtin（§3.1 [4]）
 *   - 生命周期调度：initialize → prefetch → syncTurn → shutdown（§3.1 [5]）
 *   - 琐碎输入过滤（§7）
 *   - 确定性召回指示器 RecallStatus（§3.1 [5]）
 *   - 事件：memory.provider-activated / provider-activation-failed /
 *     recall-injected（§12.1 只要求这 3 个）
 *   - pause / resume 内存态开关
 *
 * **Sprint 16 接力**（§12.2，本文件显式抛未实现，绝不静默——沿用
 * agint-skill-autocreate 的 notImplemented 惯例）：
 *   - 运行时降级（单次失败降级 + 连续失败切换 + 自动恢复）
 *   - 召回超时保护（prefetch_timeout_ms；配置项已冻结，Sprint 16 生效）
 *   - pre_compress 检查点编排（fail-closed）+ fallback_events /
 *     pre_compress_checkpoints 两表写入
 *   - provider 工具动态注册（getToolSchemas → 加前缀 → handleToolCall 路由）
 *
 * 设计取舍：§9.3 自我评估禁止 —— 本管理器**不自动切换 provider、不自动改
 * 配置**。唯一的自动降级是「激活失败 → builtin」，那是 §9.1 L0 护栏要求的
 * 可用性兜底，不是自我优化。
 */

import { BUILTIN_PROVIDER } from './schema.js';
import { isTrivialPrompt } from './trivial.js';

/** Sprint 16 交付物的显式未实现哨兵 */
const SPRINT16_STAGES = Object.freeze([
  'handleRuntimeFailure', 'onPreCompress', 'registerProviderTools',
  'routeToolCall', 'testConnection',
]);

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
   */
  constructor({ registry, builtin, config, record, publish, debug } = {}) {
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
      context = await provider.prefetch(query, { sessionId });
    } catch (e) {
      // Sprint 15：不实现运行时降级（§12.2），但**不能让召回失败炸掉对话**
      // （§9.2 约束 3）。本轮返回空上下文并记录；连续失败切换见 Sprint 16。
      this.debug(`[manager] prefetch 失败: ${e?.message ?? e}`);
      await this.record('audit_log', {
        actor: 'system', action: 'prefetch_failed', targetType: 'provider',
        targetId: providerName,
        details: { turnNumber, errorType: 'unknown' },
        reason: cfg.log_sensitive_data ? String(e?.message ?? e) : 'prefetch failed',
      }).catch(() => {});
      this.lastRecall = null;
      return { context: '', status: null, skipped: false, skipReason: 'prefetch_error', providerName };
    }

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
   * 失败不抛（不影响对话），只记日志；队列/重试属 Sprint 16（§14.1 决策 A）。
   */
  async endTurn(userContent, assistantContent, opts = {}) {
    const cfg = this.cfg();
    if (this.paused || !cfg.sync_turn_enabled) return { synced: false, reason: this.paused ? 'paused' : 'sync_disabled' };

    const provider = this.activeProvider ?? this.builtin;
    const sessionId = opts.sessionId ?? this.sessionId;
    try {
      await provider.syncTurn(userContent, assistantContent, {
        sessionId, messages: opts.messages,
      });
      return { synced: true, providerName: this.getActiveProviderName() };
    } catch (e) {
      this.debug(`[manager] syncTurn 失败: ${e?.message ?? e}`);
      return { synced: false, reason: 'provider_error', providerName: this.getActiveProviderName() };
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

  // ── Sprint 16 接力：显式抛错，绝不静默（真实 > 讨好）───────────────────

  notImplemented(stage) {
    throw new Error(
      `agint.memoryProvider: ${stage} 未实现（Sprint 16 交付，设计稿 §12.2）；` +
      '当前为 Sprint 15 基础抽象层',
    );
  }

  /** 运行时降级（单次失败 + 连续失败切换 + 自动恢复）——Sprint 16 */
  handleRuntimeFailure(operation, error) {
    return this.notImplemented('handleRuntimeFailure');
  }

  /** pre_compress 检查点编排（fail-closed）——Sprint 16 */
  async runPreCompressCheckpoint(messages) {
    return this.notImplemented('onPreCompress');
  }

  /** provider 工具动态注册（加前缀 + 冲突检查）——Sprint 16 */
  registerProviderTools() {
    return this.notImplemented('registerProviderTools');
  }

  /** provider 工具调用路由——Sprint 16 */
  async routeToolCall(toolName, args, kwargs) {
    return this.notImplemented('routeToolCall');
  }

  /** 连接测试（testConnection Service）——Sprint 16 */
  async testConnection(name) {
    return this.notImplemented('testConnection');
  }
}

export { MemoryManager, SPRINT16_STAGES };
