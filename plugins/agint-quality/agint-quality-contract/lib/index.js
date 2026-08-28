/**
 * agint-quality-contract: D-QAF 评估框架核心契约（FROZEN 层）
 *
 * 设计原则（详见 wiki/AGINT/D-QAF评估框架.md 与 D-QAF与AGINT融合方案.md）：
 *   1. 自身不评估（递归陷阱由外部 CI 兜底）
 *   2. 仅定义接口（Seam），不写实现
 *   3. FROZEN 字段永不修改，需人类多签；ADJUSTABLE 字段由 agint-quality-policy 调整并记日志
 *
 * HOST plane，单实例：提供 `agint.quality` 服务，把 Seam 定义暴露给同进程其他插件。
 * 提供 model-facing 工具 `quality_contract_inspect`，让 Agent 可查询契约字段的 frozen 状态。
 *
 * Row (profile cordis.patch.yml):
 *   - insert:
 *       - id: agint-quality-contract
 *         name: ./plugins/agint-quality/agint-quality-contract/lib/index.js
 *         config: {}
 *
 * FROZEN / ADJUSTABLE 划分（提案 id 3d6cc063 跟踪）：
 *   FROZEN:
 *     - 接口签名 (QualityEvaluator/Policy/Reporter/Lifecycle)
 *     - Safety 红线语义
 *     - 决策输出枚举 (AUTO_DEPLOY / PENDING_REVIEW / REJECT / ABSTAIN)
 *   ADJUSTABLE:
 *     - HARM 四维权重 (w_H, w_A, w_R, w_M)
 *     - 评分阈值 (autoDeploy / pendingReview)
 *     - TRACE-P 维度权重
 *     - 沙箱资源限制 (timeout / memory_limit)
 */

import { z } from 'zod';

// ────────────────────────────────────────────────────────────────────────────
// FROZEN 层：接口契约（修改需人类多签）
// ────────────────────────────────────────────────────────────────────────────

/** 评估目标：被评估对象的元数据 */
export const EvalTargetSchema = z.object({
  /** 唯一 ID：plugin 走 pluginId，skill 走 skill 名 */
  id: z.string().min(1),
  /** 类型 */
  kind: z.enum(['plugin', 'skill', 'preset', 'composite']),
  /** 版本号或 commit SHA（用于评估历史溯源） */
  version: z.string().default('0.0.0'),
  /** 可选路径（plugin/skill 源码位置），用于沙箱执行 */
  path: z.string().optional(),
  /** 评估上下文标签，例如 ['light-dream', 'manual-review'] */
  tags: z.array(z.string()).default([]),
}).strict();
/** @frozen */

/** HARM 四维评分（ADJUSTABLE 权重，固定维度定义） */
export const HARMSchema = z.object({
  homogeneity: z.number().min(0).max(1),
  alignment: z.number().min(0).max(1),
  reduction: z.number().min(0).max(1),
  mutability: z.number().min(0).max(1),
}).strict();
/** @frozen 维度定义；权重由 policy 可调 */

/** 单维度评分（通用：用于 TRACE / TRACE-P 各维度） */
export const DimensionScoreSchema = z.object({
  /** 0..1 归一化分数 */
  score: z.number().min(0).max(1),
  /** 原始观测值（如错误率、覆盖率），用于解释 */
  raw: z.unknown().optional(),
  /** 证据：file:line 或 trace ID，可被 quality-report 引用 */
  evidence: z.array(z.string()).default([]),
  /** 子条目（嵌套维度，如 Safety 下分多类） */
  children: z.array(z.lazy(() => DimensionScoreSchema)).default([]),
}).strict();
/** @frozen */

/** 评估结果（统一输出，eval plugin 必填） */
export const EvalResultSchema = z.object({
  targetId: z.string().min(1),
  kind: EvalTargetSchema.shape.kind,
  /** 评估时间 ISO */
  evaluatedAt: z.string(),
  /** 评估耗时 ms */
  durationMs: z.number().int().nonnegative(),
  /** TRACE 或 TRACE-P 各维度 */
  dimensions: z.array(z.object({
    key: z.enum(['trust', 'reliability', 'adaptability', 'convention', 'effectiveness',
                 'safety', 'integrability']),
    label: z.string(),
    score: DimensionScoreSchema,
    /** 该维度是否一票否决（safety/trust 默认 true） */
    veto: z.boolean().default(false),
  })).default([]),
  /** HARM 评分（如果评估对象是 plugin 或 composite） */
  harm: HARMSchema.optional(),
  /** 严重问题（任一非空都建议 REJECT） */
  findings: z.array(z.object({
    severity: z.enum(['info', 'warn', 'blocker']),
    message: z.string(),
    evidence: z.array(z.string()).default([]),
  })).default([]),
  /** 评估器实例 ID（用于审计） */
  evaluatorId: z.string(),
}).strict();
/** @frozen */

/** 策略决策输出 */
export const DecisionKindSchema = z.enum([
  'AUTO_DEPLOY',    // 综合分 >= autoDeploy 阈值，安全门通过
  'PENDING_REVIEW', // 综合分 >= pendingReview 阈值，待人工 review
  'REJECT',         // 未达阈值或安全门失败
  'ABSTAIN',        // 评估不充分，无法决策（信号不足）
]);
/** @frozen — 决策枚举稳定，扩展需新增字段而非重命名 */

export const DecisionSchema = z.object({
  kind: DecisionKindSchema,
  /** 综合分 0..100 */
  score: z.number().min(0).max(100),
  /** 决策理由（短） */
  reason: z.string(),
  /** 触发该决策的具体 findings（指向 EvalResult.findings 的子集） */
  triggeredBy: z.array(z.string()).default([]),
  /** 决策时间 */
  decidedAt: z.string(),
  /** 策略实例 ID */
  policyId: z.string(),
}).strict();
/** @frozen */

/** 梦境阶段枚举（来自 agint-dream） */
export const DreamPhaseSchema = z.enum(['light', 'rem', 'deep']);
/** @frozen */

// ────────────────────────────────────────────────────────────────────────────
// ADJUSTABLE 层：策略可调字段（policy 改这里必须写日志）
// ────────────────────────────────────────────────────────────────────────────

export const QualityConfigSchema = z.object({
  /** HARM 四维权重（ADJUSTABLE） */
  harmWeights: z.object({
    H: z.number().min(0).max(1).default(0.2),
    A: z.number().min(0).max(1).default(0.3),
    R: z.number().min(0).max(1).default(0.3),
    M: z.number().min(0).max(1).default(0.2),
  }).default({ H: 0.2, A: 0.3, R: 0.3, M: 0.2 }),

  /** 综合分阈值（ADJUSTABLE） */
  thresholds: z.object({
    autoDeploy: z.number().min(0).max(100).default(90),
    pendingReview: z.number().min(0).max(100).default(75),
  }).default({ autoDeploy: 90, pendingReview: 75 }),

  /** 梦境阶段最大评估耗时（秒，ADJUSTABLE） */
  dreamBudgetSec: z.object({
    light: z.number().int().positive().default(60),
    rem: z.number().int().positive().default(1200),     // 20 分钟
    deep: z.number().int().positive().default(300),
  }).default({ light: 60, rem: 1200, deep: 300 }),

  /** 沙箱资源限制（ADJUSTABLE） */
  sandboxLimits: z.object({
    timeoutMs: z.number().int().positive().default(30000),
    memoryMB: z.number().int().positive().default(512),
    networkDisabled: z.boolean().default(true),
    readOnly: z.boolean().default(true),
  }).default({ timeoutMs: 30000, memoryMB: 512, networkDisabled: true, readOnly: true }),

  /** A/B 测试配置（Sprint 10 v0.6.4 #10，ADJUSTABLE）
   *
   * 设计稿 §二.6：A/B 结果作为 policy 加权综合分的额外输入维度（权重 0.10）。
   * abtest 插件独立实现（agint-abtest 提供 winner/pValue/effectSize/samples），
   * policy 在 options.abtestResults 注入结果，映射为 'abtest' dimension 参与综合分。
   *
   * enabled=false 默认 → 向后兼容（既有测试无需修改）；v0.7+ 启用时按需打开。
   * minSamples 与 agint-abtest §二.6 任务集 ≥10 门槛对齐。
   */
  abtest: z.object({
    enabled: z.boolean().default(false),
    weight: z.number().min(0).max(1).default(0.10),
    minSamples: z.number().int().positive().default(10),
    pValueThreshold: z.number().min(0).max(1).default(0.05),
  }).default({ enabled: false, weight: 0.10, minSamples: 10, pValueThreshold: 0.05 }),
}).strict();
/** @adjustable */

// ────────────────────────────────────────────────────────────────────────────
// 接口签名（FROZEN：实现由 sibling 插件提供）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 评估器接口（FROZEN 签名）。
 * 由 agint-quality-eval 实现；本插件不提供实例。
 */
export const QualityEvaluatorIface = {
  /** @frozen */
  name: 'QualityEvaluator',
  version: '0.1.0',
  methods: ['evaluate(target: EvalTarget): Promise<EvalResult>'],
};

/** 策略接口（FROZEN） */
export const QualityPolicyIface = {
  /** @frozen */
  name: 'QualityPolicy',
  version: '0.1.0',
  methods: ['decide(results: EvalResult[], config: QualityConfig): Promise<Decision>'],
};

/** 报告接口（FROZEN） */
export const QualityReporterIface = {
  /** @frozen */
  name: 'QualityReporter',
  version: '0.1.0',
  methods: ['generate(results: EvalResult[], decision: Decision): Promise<{ markdown: string, json: object }>'],
};

/** 生命周期钩子（FROZEN） */
export const QualityLifecycleIface = {
  /** @frozen */
  name: 'QualityLifecycle',
  version: '0.1.0',
  methods: [
    'onPluginLoaded(meta: PluginMeta): void',
    'onPluginUnloaded(meta: PluginMeta): void',
    'onSkillRegistered(meta: SkillMeta): void',
    'onDreamPhase(phase: DreamPhase): Promise<void>',
    'onWeeklyReview(): Promise<void>',
  ],
};

// ────────────────────────────────────────────────────────────────────────────
// Cordis 插件导出
// ────────────────────────────────────────────────────────────────────────────

const name = 'agint-quality-contract';
const inject = [];

const Config = z.object({});

function apply(ctx) {
  /** 默认配置（启动时载入；policy 可调后通过 setConfig 覆盖） */
  let config = QualityConfigSchema.parse({});

  ctx.effect(() => {
    // 当前无可逆副作用，但保留 effect 占位以备后续加监听器
    return () => {};
  });

  ctx.provide('agint.quality', {
    /** 获取当前配置（供 sibling 插件读取） */
    getConfig() {
      return config;
    },

    /** 修改配置（policy 调用，会记录审计日志到 agint-memory）
     * 安全护栏：调用 validatePatch 拒绝任何 L0 字段修改（提案 3d6cc063）
     */
    async setConfig(patch) {
      // 1. L0 防护：拒绝任何契约层字段修改
      const validation = this.validatePatch(patch);
      if (!validation.ok) {
        const err = new Error(
          `agint-quality-contract: setConfig rejected — patch contains L0-frozen fields: ${validation.violations.join(', ')}. ` +
          `L0 fields require human multi-sig (see proposal 3d6cc063).`
        );
        err.code = 'L0_FROZEN_VIOLATION';
        err.violations = validation.violations;
        ctx.logger?.error?.(err.message);
        throw err;
      }

      const memory = ctx.get('agint.memory');
      const before = config;
      const merged = QualityConfigSchema.parse({
        ...before,
        ...patch,
        harmWeights: { ...before.harmWeights, ...(patch.harmWeights ?? {}) },
        thresholds: { ...before.thresholds, ...(patch.thresholds ?? {}) },
        dreamBudgetSec: { ...before.dreamBudgetSec, ...(patch.dreamBudgetSec ?? {}) },
        sandboxLimits: { ...before.sandboxLimits, ...(patch.sandboxLimits ?? {}) },
      });
      config = merged;
      // 审计：写到 agint-memory（如果可用；不可用则降级为 console.warn）
      if (memory && typeof memory.write === 'function') {
        try {
          await memory.write({
            type: 'decision',
            content: `[agint.quality] config updated: ${JSON.stringify(patch)}`,
            evidence: 'agint-quality-contract:setConfig',
          });
        } catch (err) {
          ctx.logger?.warn?.('agint-quality-contract: audit write failed', err);
        }
      }
      return config;
    },

    /** 暴露契约 Schema 给 sibling 插件 */
    schemas: {
      EvalTarget: EvalTargetSchema,
      EvalResult: EvalResultSchema,
      Decision: DecisionSchema,
      DecisionKind: DecisionKindSchema,
      HARM: HARMSchema,
      DimensionScore: DimensionScoreSchema,
      QualityConfig: QualityConfigSchema,
      DreamPhase: DreamPhaseSchema,
    },

    /** 暴露接口定义给 sibling 插件（供自描述/文档生成） */
    interfaces: {
      QualityEvaluator: QualityEvaluatorIface,
      QualityPolicy: QualityPolicyIface,
      QualityReporter: QualityReporterIface,
      QualityLifecycle: QualityLifecycleIface,
    },

    /** 字段层级查询（供 lint / CI / audit / policy 自检 用）
     * 返回 'L0-frozen' | 'L1-adjustable' | 'L2-implementation' | 'unknown'
     * L0 = 接口契约（修改需人类多签 + CI 禁改）
     * L1 = 策略参数（policy 自调 + 写审计日志）
     * L2 = 实现细节（实现插件自治）
     * unknown = 未登记字段,默认视为 L2（保守放权）
     */
    getLayer(fieldPath) {
      const layers = {
        // L0-frozen: 接口契约层（永不修改,除非人类多签）
        'EvalTarget': 'L0-frozen',
        'EvalResult': 'L0-frozen',
        'Decision': 'L0-frozen',
        'DecisionKind': 'L0-frozen',
        'HARM': 'L0-frozen',
        'DimensionScore': 'L0-frozen',
        'DreamPhase': 'L0-frozen',
        'interfaces.QualityEvaluator': 'L0-frozen',
        'interfaces.QualityPolicy': 'L0-frozen',
        'interfaces.QualityReporter': 'L0-frozen',
        'interfaces.QualityLifecycle': 'L0-frozen',
        // L1-adjustable: 策略参数层（policy 可调,记审计日志）
        'harmWeights': 'L1-adjustable',
        'harmWeights.H': 'L1-adjustable',
        'harmWeights.A': 'L1-adjustable',
        'harmWeights.R': 'L1-adjustable',
        'harmWeights.M': 'L1-adjustable',
        'thresholds': 'L1-adjustable',
        'thresholds.autoDeploy': 'L1-adjustable',
        'thresholds.pendingReview': 'L1-adjustable',
        'dreamBudgetSec': 'L1-adjustable',
        'dreamBudgetSec.light': 'L1-adjustable',
        'dreamBudgetSec.rem': 'L1-adjustable',
        'dreamBudgetSec.deep': 'L1-adjustable',
        'sandboxLimits': 'L1-adjustable',
        'sandboxLimits.timeoutMs': 'L1-adjustable',
        'sandboxLimits.memoryMB': 'L1-adjustable',
        'sandboxLimits.networkDisabled': 'L1-adjustable',
        'sandboxLimits.readOnly': 'L1-adjustable',
        // Sprint 10 v0.6.4 #10: A/B 测试配置（policy 可调，记审计日志）
        'abtest': 'L1-adjustable',
        'abtest.enabled': 'L1-adjustable',
        'abtest.weight': 'L1-adjustable',
        'abtest.minSamples': 'L1-adjustable',
        'abtest.pValueThreshold': 'L1-adjustable',
        // L2-implementation: 实现细节层（实现插件自治,默认未登记即 L2）
      };
      return layers[fieldPath] || 'L2-implementation';
    },

    /** 向后兼容的别名（老代码可能还在用 isFrozen） */
    isFrozen(fieldPath) {
      return this.getLayer(fieldPath) === 'L0-frozen';
    },

    /** 校验 patch 中没有任何字段属于 L0（供 setConfig 入口自检）
     * 递归遍历 patch 所有路径,任一 L0 即失败
     * 返回 { ok: boolean, violations: string[] }
     */
    validatePatch(patch) {
      const violations = [];
      const checkPath = (pathPrefix, obj) => {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
        for (const [k, v] of Object.entries(obj)) {
          const path = pathPrefix ? `${pathPrefix}.${k}` : k;
          if (this.getLayer(path) === 'L0-frozen') {
            violations.push(path);
          }
          // 递归检查嵌套对象（不递归数组）
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            checkPath(path, v);
          }
        }
      };
      checkPath('', patch);
      return { ok: violations.length === 0, violations };
    },
  });
}

export { Config, apply, inject, name };

// 供 sibling 插件 import 用的 named exports 已经在上方声明
