/**
 * Deprecation proxy for agint-quality-sandbox.
 *
 * Sprint 10 v0.6.3 把 agint-quality-sandbox 物理剥离为顶层独立插件后，
 * 历史通过 agint-quality 基座调用 sandbox 的代码路径保留 1 周兼容代理
 * （设计稿 §二.1 + §九遗留 TODO #5：v0.7 清理）。
 *
 * ## 行为
 * 1. 旧路径 agint.qualitySandbox（旧基座内嵌版）的所有调用转发到新独立插件
 *    （按 service name 路由：ctx.get('agint.qualitySandbox') 已由 dsh 解析）
 * 2. 转发同时在 agint.evolution 写一条 evo.addFailure('deprecated-sandbox-call')
 *    提示调用方迁移（决策 §真实 > 讨好：不静默）
 * 3. 不在 deprecation 期间重写基座逻辑；新代码请直接挂顶层 agint-quality-sandbox 插件
 *
 * ## v0.7 清理
 * 删除此文件 + 删除 plugins/agint-quality/agint-quality-sandbox/ 整个目录。
 * 任何旧调用方届时若未迁移，运行时 ctx.get('agint.qualitySandbox') 返回 undefined。
 *
 * ## L0-frozen 保护
 * 本文件不引用 quality-contract FROZEN 接口（详 CHANGELOG §L0-frozen）。
 */

import { runSmoke as legacyRunSmoke } from './lib/index.js';

const name = 'agint-quality-sandbox-deprecation-proxy';
const Config = {};
const inject = ['sandbox', 'agint.evolution'];

async function apply(ctx, config) {
  let disposed = false;
  ctx.effect(() => () => { disposed = true; });

  // 转发旧基座调用 → 新顶层插件（ctx.get 解析 dsh 已挂载的所有 provider）
  const forward = async (method, args) => {
    const evo = ctx.get('agint.evolution');
    if (evo?.addFailure && !disposed) {
      try {
        await evo.addFailure({
          pattern: 'deprecated-sandbox-call',
          category: 'integration',
          severity: 'low',
          evidence: `method=${method} target=${args?.target?.path ?? '<none>'}`,
        });
      } catch { /* evolution unavailable — ignore */ }
    }
    const live = ctx.get('agint.qualitySandbox');
    if (!live) throw new Error('deprecated-sandbox-call: new plugin not mounted');
    return live[method]?.(args);
  };

  // 仅转发旧基座内嵌的 v0.3 Service（向后兼容 eval）
  ctx.provide('agint.qualitySandboxLegacy', {
    runSmoke: (args) => forward('runSmoke', args),
    backendHealth: () => forward('backendHealth', {}),
    legacyRunSmoke, // 兜底：基座内嵌实现
  });
}

export { Config, apply, name, inject };