/**
 * agint-memory-provider — P1-1 可插拔记忆 Provider 架构（Sprint 15 基础抽象层）。
 *
 * Service：`agint.memoryProvider`（设计稿 §5.3）。
 * 存储域：`agint_memory_provider`（5 表，设计稿 §4.1，与既有域互斥）。
 *
 * Sprint 15 范围（§12.1）：
 *   - ExternalProvider 抽象基类 + BuiltinProvider（封装 agint-memory）
 *   - MemoryManager：激活/降级、生命周期调度、琐碎输入过滤、召回指示器
 *   - ProviderRegistry：注册 + 实现完整性校验
 *   - Service：listProviders / getActiveProvider / activate / deactivate /
 *     getConfig / setConfig / getRecallStatus / pause / resume / stats
 *   - 事件：memory.provider-activated / provider-activation-failed /
 *     recall-injected（软依赖 event-bus，不可用时降级为仅写 audit_log）
 *
 * Sprint 16 范围（§12.2，2026-09-09 落地）：
 *   - 运行时降级（单次失败降级 + 连续失败切换 + 自动恢复）+ 召回超时保护
 *   - fallback_events / pre_compress_checkpoints 表写入
 *   - pre_compress 检查点编排（fail-closed，api_version>=2，防死锁回退）
 *   - provider 工具动态注册（getToolSchemas → 加前缀 → 冲突检查）+ 路由
 *   - testConnection / getFallbackStats 真实聚合
 *   - 新增事件：memory.provider-fallback / provider-recovered /
 *     pre-compress-checkpoint / tool-called
 *
 * **不修改 agint-memory**（§1.3 非目标第 1 条）：本插件只注入其
 * `agint.memory` 服务做封装，不重开 `agint` 域（该域进程内独占）。
 *
 * Loader row（cordis.patch.yml 模板，本文件不挂载，由老板走 safe-update）：
 *   - insert:
 *       - id: agint-memory-provider
 *         name: ./plugins/agint-memory-provider/lib/index.js
 *         config: {}
 */

import {
  ConfigSchema,
  RUNTIME_CONFIG_KEYS,
  BUILTIN_PROVIDER,
} from './schema.js';
import {
  spec,
  checkLimit,
  LIMITS,
  pruneOldest,
  nowIso,
  providerConfigId,
  packProviderConfig,
  packActivationLog,
  packFallbackEvent,
  packCheckpoint,
  packAudit,
} from './storage.js';
import { ProviderRegistry } from './registry.js';
import { BuiltinProvider } from './builtin-provider.js';
import { MemoryManager } from './manager.js';

const name = 'agint-memory-provider';
// storageDomain 硬依赖（自己的域）+ agint.memory 硬依赖（封装为 builtin）+
// tools（阶段 2 工具动态注册需要 ctx.tools；tools.js 同款 inject，preset 恒有）；
// event-bus 是软依赖，运行时 ctx.get 探测，不进 inject（不可用时降级）。
const inject = ['storageDomain', 'agint.memory', 'tools'];

function apply(ctx, config) {
  const cfg = ConfigSchema.parse(config ?? {});
  let domain = null;
  let domainError = null;
  let disposed = false;
  const runtimeOverrides = new Map();        // §8.2 可运行时修改的配置子集

  // lifecycle：disposer 关自己的域（AGENTS.md 挂载红线）。
  // 注意：**不关 agint 域**——它归 agint-memory 独占并自行 dispose。
  ctx.effect(() => () => {
    disposed = true;
    if (domain) return domain.close();
    return undefined;
  });

  const ready = ctx.storageDomain.open(spec).then(
    (d) => {
      if (disposed) { void d.close().catch(() => {}); return null; }
      domain = d;
      return d;
    },
    (error) => { domainError = error; return null; },
  );

  const table = async (tableName) => {
    if (disposed) throw new Error(`${name}: disposed`);
    if (domainError) throw domainError;
    const d = await ready;
    if (!d) throw new Error(`${name}: domain unavailable`);
    return d.table(tableName);
  };

  const effectiveConfig = () => {
    const merged = { ...cfg };
    for (const [k, v] of runtimeOverrides) merged[k] = v;
    return merged;
  };

  const debug = (msg) => {
    if (effectiveConfig().debug_mode) console.log(`[${name}] ${msg}`);
  };

  // ── 事件发布（软依赖 event-bus，降级不抛；与 skill-autocreate 同策略）────
  async function publishEvent(topic, payload) {
    const p = typeof ctx.get === 'function' ? ctx.get('agint.eventBus.publish') : null;
    if (typeof p !== 'function') return false;
    try {
      await p({ topic, version: 1, source: name, payload });
      return true;
    } catch (e) {
      if (!disposed) console.error(`[${name}] publish ${topic} failed:`, e?.message ?? e);
      return false;
    }
  }

  // ── 持久化回调（供 manager/registry 写表；表名 → pack 映射）─────────────
  const PACKERS = {
    provider_config: packProviderConfig,
    activation_log: packActivationLog,
    fallback_events: packFallbackEvent,
    pre_compress_checkpoints: packCheckpoint,
    audit_log: packAudit,
  };

  async function record(tableName, business) {
    if (disposed) return null;
    const packer = PACKERS[tableName];
    if (!packer) throw new Error(`${name}: 未知表 ${tableName}`);
    try {
      const t = await table(tableName);
      // 记录是存储对象本身、禁止原地改（storage.js 头注），pack 产出新对象
      const entry = packer(business);
      await t.put(entry.id, entry);
      const warn = checkLimit(tableName, t.size);
      if (warn) {
        // 滚动清理仅对 activation_log / audit_log / fallback_events 生效
        const removed = await pruneOldest(t, tableName);
        if (removed === 0) console.warn(`[${name}] ${warn._warn}`);
      }
      return entry;
    } catch (e) {
      // 存储不可用不得炸掉对话（§9.1 L1）：记 stderr，返回 null
      if (!disposed) console.error(`[${name}] record ${tableName} failed:`, e?.message ?? e);
      return null;
    }
  }

  // ── 组装 registry / builtin / manager ──────────────────────────────────

  const registry = new ProviderRegistry({ debug });

  const builtin = new BuiltinProvider({
    memory: ctx['agint.memory'],
    config: effectiveConfig,
    debug,
  });

  // §9.1 L0：builtin 必须注册成功，否则整个插件失去 fallback → 直接抛
  const builtinReg = registry.register(builtin);
  if (!builtinReg.registered) {
    throw new Error(`${name}: builtin provider 注册失败（${builtinReg.reason}）`);
  }

  const manager = new MemoryManager({
    registry,
    builtin,
    config: effectiveConfig,
    record,
    publish: publishEvent,
    debug,
    // 阶段 2 工具动态注册（§3.3）：注入 ctx.tools；defineTool 不在此静态导入
    // （repo 冒烟测试不引 dsh 依赖），由 manager 内 lazy dynamic import 兜底。
    tools: ctx.tools ?? null,
  });

  // ── Service 出口（设计稿 §5.3）─────────────────────────────────────────

  /** 列出所有已注册 provider 及其可用性快照 */
  async function listProviders() {
    const list = registry.describe();
    return {
      providers: list,
      total: list.length,
      external: list.filter((p) => !p.isBuiltin).length,
      activeProvider: manager.getActiveProviderName(),
      // §9.1 L0：builtin 恒在（单外部 provider 限制由 activate 保证）
      builtinPresent: registry.has(BUILTIN_PROVIDER),
    };
  }

  /** 当前激活的 provider + 召回状态（§5.3） */
  async function getActiveProvider() {
    const activeName = manager.getActiveProviderName();
    const entry = registry.describe().find((p) => p.name === activeName) ?? null;
    return {
      providerName: activeName,
      isBuiltin: activeName === BUILTIN_PROVIDER,
      initialized: manager.initialized,
      sessionId: manager.sessionId,
      turnNumber: manager.turnNumber,
      paused: manager.paused,
      recallStatus: manager.getRecallStatus(),
      lastActivation: manager.lastActivation ? { ...manager.lastActivation } : null,
      detail: entry,
    };
  }

  /** 激活指定 provider（§5.3）。写操作，preset 平面配 ask 门禁 */
  async function activate(providerName, opts = {}) {
    if (!providerName) throw new Error('activate: providerName is required');
    const result = await manager.activate(providerName, {
      actor: opts.actor ?? 'human',
      reason: opts.reason ?? `activate(${providerName})`,
      sessionId: opts.sessionId,
      kwargs: opts.kwargs ?? {},
    });
    // §9.1 L0 单外部 provider：activate 天然只置一个 active，无需额外互斥逻辑
    return result;
  }

  /** 停用外部 provider，降级到 builtin（§5.3） */
  async function deactivate(opts = {}) {
    return manager.deactivate({
      actor: opts.actor ?? 'human',
      reason: opts.reason ?? '人工停用',
      sessionId: opts.sessionId,
    });
  }

  /** 获取 provider 配置（§5.3）；敏感项只回 env var 名，不回实际值 */
  async function getConfig(providerName) {
    const target = providerName ?? manager.getActiveProviderName();
    const t = await table('provider_config');
    const found = t.entries().find(([key, v]) => key === providerConfigId(target) || v.providerName === target);
    if (!found) {
      return {
        providerName: target,
        configured: false,
        config: {},
        secrets: {},
        isConfigured: false,
        lastValidatedAt: null,
        validationResult: null,
      };
    }
    // 返回浅拷贝：存储记录不得被调用方原地修改
    const rec = { ...found[1] };
    return {
      providerName: rec.providerName,
      configured: true,
      config: { ...(rec.config ?? {}) },
      secrets: { ...(rec.secrets ?? {}) },
      isConfigured: rec.isConfigured,
      lastValidatedAt: rec.lastValidatedAt,
      validationResult: rec.validationResult,
      updatedAt: rec.updatedAt,
    };
  }

  /**
   * 设置 provider 配置（§5.3）。写操作，preset 平面配 ask 门禁。
   *
   * 安全（§9.1 L2）：`secrets` 只接受 **env var 名**，不接受实际值；若调用方
   * 传进来的值看起来像凭证（长随机串），拒绝并提示改用 env var 名。
   */
  async function setConfig(providerName, values = {}, opts = {}) {
    if (!providerName) throw new Error('setConfig: providerName is required');
    if (!values || typeof values !== 'object') throw new Error('setConfig: values 必须是对象');

    const secrets = { ...(values.secrets ?? {}) };
    for (const [k, v] of Object.entries(secrets)) {
      if (typeof v !== 'string' || !v.trim()) {
        throw new Error(`setConfig: secrets.${k} 必须是 env var 名（字符串）`);
      }
      // 疑似实际凭证：含分隔符/过长/像 key 的字面量 → 拒绝（不落库）
      if (v.length > 64 || /[=+\/]{1}.*[=+\/]{1}/.test(v) || /^(sk|pk|api)[-_]/i.test(v)) {
        throw new Error(
          `setConfig: secrets.${k} 疑似实际凭证而非 env var 名，已拒绝。` +
          '敏感值请写入 $DSH_HOME/secrets/ 或 .env，这里只存变量名（设计稿 §9.1 L2）',
        );
      }
    }

    const t = await table('provider_config');
    const key = providerConfigId(providerName);
    const existing = t.get(key) ? { ...t.get(key) } : null;

    const entry = packProviderConfig({
      providerName,
      config: { ...(existing?.config ?? {}), ...(values.config ?? {}) },
      secrets,
      isConfigured: values.isConfigured ?? existing?.isConfigured ?? true,
      lastValidatedAt: values.lastValidatedAt ?? existing?.lastValidatedAt ?? null,
      validationResult: values.validationResult ?? existing?.validationResult ?? null,
    }, existing);

    await t.put(entry.id, entry);
    const warn = checkLimit('provider_config', t.size);
    if (warn) console.warn(`[${name}] ${warn._warn}（provider_config 不自动 prune）`);

    await record('audit_log', {
      actor: opts.actor ?? 'human',
      action: 'provider_config_set',
      targetType: 'provider_config',
      targetId: entry.id,
      // 只记字段名，不记值（§9.1 L2：日志不记录敏感数据）
      details: { configKeys: Object.keys(values.config ?? {}), secretKeys: Object.keys(secrets) },
      reason: opts.reason ?? null,
    });

    return { ok: true, providerName, id: entry.id, updatedAt: entry.updatedAt };
  }

  /** 当前召回状态（§5.3 getRecallStatus） */
  function getRecallStatus() {
    return {
      recallStatus: manager.getRecallStatus(),
      indicatorEnabled: effectiveConfig().recall_indicator_enabled,
      turnNumber: manager.turnNumber,
      providerName: manager.getActiveProviderName(),
    };
  }

  /** 暂停记忆召回（调试用，§5.3）；内存态，重启还原 */
  function pause(opts = {}) {
    return manager.pause(opts.actor ?? 'human');
  }

  /** 恢复记忆召回（§5.3） */
  function resume(opts = {}) {
    return manager.resume(opts.actor ?? 'human');
  }

  /**
   * 注册一个外部 provider 实例（供测试 / Sprint 17-18 插件开发用）。
   * Sprint 15 不做插件扫描（§12.3 交付「外部 provider 插件开发指南」）。
   */
  function registerProvider(provider) {
    const result = registry.register(provider);
    if (result.registered) {
      void record('audit_log', {
        actor: 'system', action: 'provider_registered', targetType: 'provider',
        targetId: result.name, details: {}, reason: null,
      });
    }
    return {
      registered: result.registered,
      name: result.name,
      reason: result.reason ?? null,
      missing: result.report?.missing ?? [],
      errors: result.report?.errors ?? [],
      recommendedOverrides: result.report?.recommended ?? [],
    };
  }

  // ── 对话循环入口（§3.1 [5]）：供 preset / dsh 集成层调用 ────────────────

  /** 每轮开始：琐碎过滤 + 召回（§3.1 [5]） */
  async function beginTurn(query, opts = {}) {
    return manager.beginTurn(query, opts);
  }

  /** 每轮结束：非阻塞同步（§3.1 [5]） */
  async function endTurn(userContent, assistantContent, opts = {}) {
    return manager.endTurn(userContent, assistantContent, opts);
  }

  /** 会话启动（§3.1 [4]） */
  async function start(sessionId, kwargs = {}) {
    return manager.start(sessionId, kwargs);
  }

  /** 会话切换（§5.1 hook） */
  async function onSessionSwitch(newSessionId, options = {}) {
    return manager.onSessionSwitch(newSessionId, options);
  }

  /** 会话结束（§3.1 [7]） */
  async function onSessionEnd(messages = []) {
    return manager.onSessionEnd(messages);
  }

  async function shutdown() {
    return manager.shutdown();
  }

  async function stats() {
    const [pc, al, fe, pcc, audit] = await Promise.all([
      table('provider_config'), table('activation_log'), table('fallback_events'),
      table('pre_compress_checkpoints'), table('audit_log'),
    ]).catch(() => [null, null, null, null, null]);

    const count = (t) => (t && typeof t.size === 'number' ? t.size : 0);
    return {
      activeProvider: manager.getActiveProviderName(),
      isBuiltinActive: manager.isBuiltinActive(),
      initialized: manager.initialized,
      paused: manager.paused,
      turnNumber: manager.turnNumber,
      providers: registry.list(),
      externalProviders: registry.listExternal(),
      recallStatus: manager.getRecallStatus(),
      tables: {
        provider_config: count(pc),
        activation_log: count(al),
        fallback_events: count(fe),
        pre_compress_checkpoints: count(pcc),
        audit_log: count(audit),
      },
      limits: LIMITS,
      config: {
        active_provider: effectiveConfig().active_provider,
        prefetch_enabled: effectiveConfig().prefetch_enabled,
        prefetch_timeout_ms: effectiveConfig().prefetch_timeout_ms,
        trivial_prompt_filter_enabled: effectiveConfig().trivial_prompt_filter_enabled,
        recall_indicator_enabled: effectiveConfig().recall_indicator_enabled,
        builtin_recall_limit: effectiveConfig().builtin_recall_limit,
        builtin_recall_touch: effectiveConfig().builtin_recall_touch,
        fallback_enabled: effectiveConfig().fallback_enabled,
        max_consecutive_failures: effectiveConfig().max_consecutive_failures,
        failure_window_minutes: effectiveConfig().failure_window_minutes,
        auto_recover_after_minutes: effectiveConfig().auto_recover_after_minutes,
        pre_compress_checkpoint_enabled: effectiveConfig().pre_compress_checkpoint_enabled,
        pre_compress_fail_closed: effectiveConfig().pre_compress_fail_closed,
        external_provider_tools_enabled: effectiveConfig().external_provider_tools_enabled,
        require_human_approval_switch: effectiveConfig().require_human_approval_switch,
        debug_mode: effectiveConfig().debug_mode,
      },
      degradation: manager.getDegradationState(),
      providerTools: manager.listProviderTools(),
      sprint: '16-fallback-checkpoints',
    };
  }

  /**
   * 降级统计（§5.3 memory_provider_fallback_stats）。
   * 阶段 2 起 fallback_events 由运行时降级逻辑真实写入（§3.1 [6]）。
   */
  async function getFallbackStats() {
    const t = await table('fallback_events').catch(() => null);
    const total = t && typeof t.size === 'number' ? t.size : 0;

    const byOperation = {};
    const byErrorType = {};
    let recovered = 0;
    const windowDays = 7;
    const cutoff = Date.now() - windowDays * 24 * 3600 * 1000;
    let inWindow = 0;

    if (t) {
      for (const [, e] of t.entries()) {
        byOperation[e.operation] = (byOperation[e.operation] ?? 0) + 1;
        byErrorType[e.errorType] = (byErrorType[e.errorType] ?? 0) + 1;
        if (e.recovered) recovered += 1;
        const ts = Date.parse(e.timestamp);
        if (Number.isFinite(ts) && ts >= cutoff) inWindow += 1;
      }
    }

    return {
      total,
      inWindow,
      windowDays,
      byOperation,
      byErrorType,
      recoveredCount: recovered,
      degradation: manager.getDegradationState(),
    };
  }

  /** §8.2：无参 = 读当前生效配置；带 patch = 修改运行时子集（内存态）。
   *  必须是 const 箭头函数——若声明为 function config(){}，会被函数声明提升
   *  遮蔽 apply(ctx, config) 的同名入参（agint-skill-autocreate 已踩坑验证）。 */
  const configApi = (patch) => {
    if (patch == null) {
      return {
        ...effectiveConfig(),
        paused: manager.paused,
        overrides: Object.fromEntries(runtimeOverrides),
      };
    }
    const allowed = new Set(RUNTIME_CONFIG_KEYS);
    const rejected = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!allowed.has(k) || v === undefined) {
        if (!allowed.has(k)) rejected.push(k);
        continue;
      }
      // active_provider 的变更必须走 activate()（带校验 + 审计 + 事件），
      // 不允许经 config patch 静默改（§9.3 自我评估禁止）
      if (k === 'active_provider') {
        rejected.push(`${k}(请用 activate/deactivate)`);
        continue;
      }
      runtimeOverrides.set(k, v);
    }
    return {
      ...effectiveConfig(), paused: manager.paused,
      overrides: Object.fromEntries(runtimeOverrides),
      rejected,
    };
  };

  // ── 启动激活（§3.1 [2]-[4]）────────────────────────────────────────────
  // 不在 apply 同步段 await：cordis fiber 不允许阻塞挂载。域就绪后再激活，
  // 失败已在 manager 内部降级到 builtin（不抛）。
  void ready.then(() => {
    if (disposed) return null;
    return manager.start(null, { platform: process.platform }).catch((e) => {
      console.error(`[${name}] start failed:`, e?.message ?? e);
      return null;
    });
  });

  ctx.provide('agint.memoryProvider', {
    // §5.3 Service 列表
    listProviders,
    getActiveProvider,
    activate,
    deactivate,
    getConfig,
    setConfig,
    getRecallStatus,
    getFallbackStats,
    pause,
    resume,
    // 对话循环集成（§3.1 [5]）
    start,
    beginTurn,
    endTurn,
    onSessionSwitch,
    onSessionEnd,
    shutdown,
    // 扩展 / 运维
    registerProvider,
    stats,
    config: configApi,
    // Sprint 16（§12.2）：降级 / 检查点 / 工具暴露 / 连接测试
    testConnection: (n) => manager.testConnection(n),
    runPreCompressCheckpoint: (m) => manager.runPreCompressCheckpoint(m),
    registerProviderTools: () => manager.registerProviderTools(),
    routeToolCall: (t, a, k) => manager.routeToolCall(t, a, k),
    listProviderTools: () => manager.listProviderTools(),
  });
}

export { ConfigSchema, apply, inject, name, nowIso };
