/**
 * agint-quality-policy provider registry —— 行动 #5（2026-09-28）：
 * policy 决策 provider 化（OpenClaw Decision Models 思路）。
 *
 * ## 借鉴点（openclaw/src/decisions）
 *
 * OpenClaw 把决策做成"可选、可替换的决策模型提供方"（DecisionProviderV1：
 * id / contractVersion / isReady / evaluate），宿主 runtime 负责路由与
 * unavailable 降级（不自动重试、保留 provenance）。AGINT 落地为：
 *
 *   - **DecisionProvider 接口**：`{ id, version, describe?(), evaluate(args) }`；
 *   - **注册表**：可注册 / 替换 / 列举 provider；active provider 可切换；
 *   - **内置 provider**：包装既有 decidePolicy（向后兼容，默认 active）；
 *   - **不可用降级**：provider 缺失 / evaluate 抛错 → 回退内置 provider +
 *     fallback 标记（决策永不因 provider 故障而丢失，审计留痕）。
 *
 * 决策审计：Decision 增加非 FROZEN 扩展字段 `providerId`（与 perTarget 先例一致），
 * 使"这条决策由谁做的"可追溯 —— 让"决策者"本身也参与进化（可替换 provider）。
 *
 * ## 边界
 *
 * 1. 默认行为不变：active = builtin，decide() 走内置 provider 时决策结果与
 *    改造前完全一致（decidePolicy 原样包装）。
 * 2. provider.evaluate 的返回必须是 Decision 形状（kind/score/reason/
 *    triggeredBy/decidedAt/policyId）；provider 无权改 FROZEN 字段名。
 * 3. 注册表是进程内内存态（与 committee 同生命周期）；持久化切换由
 *    config.policyProvider / 宿主配置承担，本模块不落盘。
 */

import { decidePolicy } from './decide.js';

/** 内置 provider id（向后兼容默认）。 */
export const BUILTIN_PROVIDER_ID = 'builtin';

/**
 * 内置 provider：包装既有 decidePolicy（阈值-加权综合分决策）。
 * @returns {object} DecisionProvider
 */
export function builtinPolicyProvider() {
  return {
    id: BUILTIN_PROVIDER_ID,
    version: '0.4.0',
    describe() {
      return {
        id: BUILTIN_PROVIDER_ID,
        version: '0.4.0',
        kind: 'threshold-composite',
        weightsSource: 'config.dimensionWeights ?? DEFAULT_DIMENSION_WEIGHTS',
        thresholdsSource: 'config.thresholds ?? { autoDeploy:70, pendingReview:60 }',
      };
    },
    async evaluate({ results, config, options }) {
      return decidePolicy({ results, config, options });
    },
  };
}

/**
 * 校验 provider 形状（register 时的最小契约）。
 * @returns {{ valid: boolean, issues: string[] }}
 */
export function validateProviderShape(provider) {
  if (!provider || typeof provider !== 'object') return { valid: false, issues: ['provider must be an object'] };
  const issues = [];
  if (typeof provider.id !== 'string' || !provider.id.trim()) issues.push('provider.id must be a non-empty string');
  if (typeof provider.evaluate !== 'function') issues.push('provider.evaluate must be a function');
  return { valid: issues.length === 0, issues };
}

/**
 * 创建决策 provider 注册表。
 * @param {object} [opts]
 * @param {string} [opts.initialActiveId] 初始 active provider（缺省内置）
 * @param {object|null} [opts.extraProviders] 初始额外注册的 provider（{ id: provider }）
 * @returns {object} 注册表服务面
 */
export function createProviderRegistry({ initialActiveId, extraProviders } = {}) {
  const providers = new Map();
  providers.set(BUILTIN_PROVIDER_ID, builtinPolicyProvider());
  if (extraProviders) {
    for (const [id, p] of Object.entries(extraProviders)) {
      if (id === BUILTIN_PROVIDER_ID) continue;
      const checked = validateProviderShape(p);
      if (checked.valid) providers.set(id, p);
    }
  }
  let activeId = initialActiveId && providers.has(initialActiveId) ? initialActiveId : BUILTIN_PROVIDER_ID;

  return {
    /** 注册（或替换）一个 provider。非法形状 → 抛错。 */
    register(provider) {
      const checked = validateProviderShape(provider);
      if (!checked.valid) throw new Error(`policy provider register failed: ${checked.issues.join('; ')}`);
      providers.set(provider.id, provider);
      return { ok: true, id: provider.id };
    },

    /** 注销一个 provider（内置不可注销）。 */
    unregister(id) {
      if (id === BUILTIN_PROVIDER_ID) return { ok: false, reason: 'builtin provider cannot be unregistered' };
      const removed = providers.delete(id);
      if (!removed) return { ok: false, reason: `provider "${id}" not registered` };
      if (activeId === id) activeId = BUILTIN_PROVIDER_ID;
      return { ok: true, id };
    },

    /** 列举全部 provider 摘要。 */
    list() {
      return [...providers.values()].map((p) => ({
        id: p.id,
        version: p.version,
        describe: typeof p.describe === 'function' ? p.describe() : undefined,
        active: p.id === activeId,
      }));
    },

    /** 当前 active provider id。 */
    getActive() {
      return activeId;
    },

    /** 切换 active provider（未注册 → 抛错；不自动回退，显式失败）。 */
    setActive(id) {
      if (!providers.has(id)) throw new Error(`policy provider "${id}" not registered`);
      activeId = id;
      return { ok: true, id };
    },

    /**
     * 用指定（或 active）provider 决策；不可用时回退内置。
     * @param {object} args { results, config, options, providerId? }
     * @returns {Promise<{ decision: object, providerId: string, fallback: boolean, fallbackReason?: string }>}
     */
    async resolveAndEvaluate({ results, config, options, providerId } = {}) {
      const requested = providerId ?? activeId;
      const provider = providers.get(requested);
      if (!provider) {
        // 未注册的 providerId → 显式回退内置（不是静默换 provider）。
        const builtin = providers.get(BUILTIN_PROVIDER_ID);
        const decision = await builtin.evaluate({ results, config, options });
        return { decision, providerId: BUILTIN_PROVIDER_ID, fallback: true, fallbackReason: `provider "${requested}" not registered` };
      }
      try {
        const decision = await provider.evaluate({ results, config, options });
        return { decision, providerId: requested, fallback: false };
      } catch (error) {
        // provider 故障 → 回退内置，决策不丢。
        const builtin = providers.get(BUILTIN_PROVIDER_ID);
        const decision = await builtin.evaluate({ results, config, options });
        return {
          decision,
          providerId: BUILTIN_PROVIDER_ID,
          fallback: true,
          fallbackReason: `provider "${requested}" evaluate failed: ${error?.message ?? String(error)}`,
        };
      }
    },
  };
}
