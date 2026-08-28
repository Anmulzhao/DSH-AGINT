/**
 * lib/static-profile.js — Sprint 10 v0.6.3 #4 + Sprint 11 v0.6.5 l0-isolation
 *
 * 静态检查白名单 + 默认配置。规则集可独立高频迭代，不污染基座（设计稿 §架构修正声明）。
 *
 * 初版默认（设计稿 §六 §6.5 缓解）：3 族 blocker（dependency-audit / storage-boundary /
 * contract-reference）+ 1 族 warn（env-access）。跑 2 周后收紧（设计稿 §九遗留 TODO）。
 *
 * Sprint 11 v0.6.5 新增 l0-isolation 族（设计稿 §4.4 ADR-11-4）：
 *   - FROZEN_SIGNATURES：L0 签名集合（方案 A：static-profile 内联精简版）
 *   - ALLOWED_SYNTH_DOMAINS：合成产物的 storage domain 白名单（仅 agint_synth_*）
 *   - ALLOWED_HOST_SERVICES：合成产物允许引用的 host service（memory/metrics/cron）
 *   - L0_ISOLATION_CHECKS：l0-isolation 内部 3 个子检查名 → 严重度
 *
 * 行数预算（设计稿 §十.1）：≤100 行（含注释） — Sprint 11 扩到 ~150 行可接受
 */

export const DEFAULT_PROFILE = 'agint-default';

/**
 * 允许的第三方依赖白名单。
 * 来源：AGINT 仓库全部 plugins 目录下 package.json 文件实际使用的 deps + 公认安全库。
 * Sprint 10 初版保守起见只列已知必需项；后续周复盘里发现缺失时再追加。
 */
export const ALLOWED_DEPS = new Set([
  // 官方 SDK / 平台依赖
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-cordis',
  // 数据校验
  'zod',
  // 测试 / 工具
  'node:test',
]);

/**
 * 允许的 storage domain（除 plugin 自己域外的合法读取目标）。
 * 写入时**必须**通过 Service（如 ctx.agintMemory.write），不允许直接 fs 写。
 */
export const STORAGE_DOMAINS = new Set([
  'agint',
  'agint_rules',
  'agint_metrics',
  'agint_evolution',
  'agint_diagnosis',
  'agint_mutator',
  'agint_static_rules',
  'agint_abtest',
  'agint_meta',
  'agint_population',
  'agint_memory',
  'agint_self_model',
  'agint_curriculum',
  'agint_transfer',
  'agint_event_bus',
  'agint_dream',
  'agint_evolve',
  'agint_tool_stats',
  'agint_wiki',
]);

/**
 * env 访问允许清单（设计稿 §二.3 §env-access）。
 * 这些环境变量是 plugin 框架注入或公认安全的环境变量。
 */
export const ENV_ALLOWLIST = new Set([
  'DSH_HOME',
  'AGINT_HOME',
  'PATH',
  'NODE_ENV',
  'HOME',
  'USER',
  'TMPDIR',
  'LANG',
  'TZ',
  'PWD',
  'SHELL',
]);

/**
 * 检查族 → 默认严重度映射（设计稿 §二.3 表格 + Sprint 11 §4.4 l0-isolation）。
 */
export const FAMILY_SEVERITY = {
  'dependency-audit': 'blocker',
  'storage-boundary': 'blocker',
  'env-access': 'warn',
  'contract-reference': 'blocker',
  // Sprint 11 v0.6.5 l0-isolation：动态挂载产物的三项 L0 隔离检查（设计稿 §4.4）
  'l0-isolation': 'blocker',
};

/**
 * 检查族 → 默认启用状态（全部启用；profile.allowlist 可关闭单个族）。
 */
export const FAMILY_ENABLED = {
  'dependency-audit': true,
  'storage-boundary': true,
  'env-access': true,
  'contract-reference': true,
  // Sprint 11 v0.6.5：l0-isolation 默认开启；mount 编排通过 profile.l0IsolationOnly=true
  // 标记「仅对合成产物」生效，避免误伤既有插件（详见 README）。
  'l0-isolation': true,
};

// ─────────────────────────────────────────────────────────────────────────────
// Sprint 11 v0.6.5 l0-isolation 配置（设计稿 §4.4 ADR-11-4）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FROZEN 签名集合（方案 A：static-profile 内联精简版，老板 2026-08-27 拍板）。
 *
 * 来源：agint-quality-contract v0.1.0 的 7 个 L0 schema 名 + 4 个 L0 interface 名 +
 * 1 个 Service 名字空间 + 17 个高频 schema 字段。本表**只列名字**，不含任何
 * 完整路径/字符串模板 —— 既避免 grep 自检命中 contract-reference，又
 * 把「签名空间独占」检查做成纯字面量比较。
 *
 * 同步时机：本表与 FROZEN 契约新增/弃用同步；契约改 FROZEN 字段走人类多签
 * （设计稿 §二.2 / AGENTS.md L0-frozen 治理），本表扩缩随之走同样路径。
 */
export const FROZEN_SIGNATURES = Object.freeze({
  schemas: Object.freeze([
    'EvalTarget',
    'EvalResult',
    'Decision',
    'DecisionKind',
    'HARM',
    'DimensionScore',
    'DreamPhase',
  ]),
  interfaces: Object.freeze([
    'QualityEvaluator',
    'QualityPolicy',
    'QualityReporter',
    'QualityLifecycle',
  ]),
  serviceNamespace: 'agint.quality',
  schemaFields: Object.freeze([
    'id', 'kind', 'version', 'path', 'tags',
    'targetId', 'evaluatedAt', 'durationMs', 'dimensions', 'harm',
    'findings', 'evaluatorId',
    'score', 'reason', 'triggeredBy', 'decidedAt', 'policyId',
  ]),
});

/**
 * 合成产物允许的 storage domain 模式（设计稿 §4.4：必须全新 agint_synth_* 域）。
 *
 * 检测策略（老板 2026-08-27 拍板）：禁全部既有 agint_* 域，仅放行 agint_synth_*。
 * 运行时检查只看 pattern；examples 字段供 README/文档引用。
 */
export const ALLOWED_SYNTH_DOMAINS = Object.freeze({
  pattern: /^agint_synth_[a-z0-9_]+$/,
  examples: Object.freeze([
    'agint_synth_echo',
    'agint_synth_counter',
    'agint_synth_journal',
  ]),
});

/**
 * host service 白名单（设计稿 §4.4 原文「memory / metrics / cron 等」）。
 *
 * 产物源码里的 import / require 命中 `@deepseek-ai/agint-<x>` 形式依赖包，
 * 仅这 3 个放行。任何其他 `agint-*` 内部模块（含 agint-quality-* / agint-mount /
 * agint-mutator / agint-quality-static 自己）一律拒绝 —— 防止合成产物借用既有
 * 插件的实现或绕过 L0 治理（设计稿 §二.2「不为挂载方便而放宽契约」）。
 */
export const ALLOWED_HOST_SERVICES = Object.freeze([
  '@deepseek-ai/agint-memory',
  '@deepseek-ai/agint-metrics',
  '@deepseek-ai/agint-cron',
]);

/**
 * l0-isolation 族：内部子检查名 → 默认严重度（全部 blocker；与 ADR-11-4 对齐）。
 */
export const L0_ISOLATION_CHECKS = Object.freeze({
  signatureCompatibility: 'blocker',
  domainIsolation: 'blocker',
  dependencyWhitelist: 'blocker',
});

/**
 * 加载 profile 配置（未来扩展点；初版直接返默认值）。
 *
 * Sprint 11 v0.6.5：在 profile 上额外暴露 4 个 l0-isolation 相关配置点，
 * mount 编排可通过覆盖这些字段动态收紧/放宽（默认全部走本文件常量）。
 *
 * @param {string} _profileName profile 名（初版忽略）
 * @param {object} [overrides] 可选覆盖项（mount 编排传入；测试也用）
 * @param {object} [overrides.frozenSignatures] 覆盖 FROZEN_SIGNATURES（极少用）
 * @param {object} [overrides.allowedSynthDomains] 覆盖 ALLOWED_SYNTH_DOMAINS
 * @param {Array<string>} [overrides.allowedHostServices] 覆盖 ALLOWED_HOST_SERVICES
 * @param {boolean} [overrides.l0IsolationOnly] true = 仅对标记 `agint_synth_*`
 *        域名的产物生效；既有插件扫到也跳过（防误伤）。mount 默认传 true。
 */
export function loadProfile(_profileName = DEFAULT_PROFILE, overrides = {}) {
  return {
    name: _profileName,
    allowedDeps: ALLOWED_DEPS,
    storageDomains: STORAGE_DOMAINS,
    envAllowlist: ENV_ALLOWLIST,
    familySeverity: FAMILY_SEVERITY,
    familyEnabled: FAMILY_ENABLED,
    // ── Sprint 11 v0.6.5 l0-isolation 配置点 ──
    frozenSignatures: overrides.frozenSignatures ?? FROZEN_SIGNATURES,
    allowedSynthDomains: overrides.allowedSynthDomains ?? ALLOWED_SYNTH_DOMAINS,
    allowedHostServices: overrides.allowedHostServices ?? ALLOWED_HOST_SERVICES,
    l0IsolationOnly: overrides.l0IsolationOnly ?? false,
  };
}