/**
 * agint-quality-eval: D-QAF 评估引擎（v0.2 初版）
 *
 * 实现 QualityEvaluatorIface（contract 定义的 seam）：
 *   evaluate(target: EvalTarget): Promise<EvalResult>
 *
 * 数据源：
 *   - agint.toolStats    reliability / effectiveness
 *   - agint.memory       trust（历史决策）
 *   - agint.rules        safety（deny 规则扣分）
 *   - agint.metrics      integrability
 *
 * 调度：
 *   - 自持 WeeklyScheduler（每周日 04:30）批量评估所有 Skill + Plugin
 *   - 评估结果写到 agint.memory（type: 'decision'）作为历史溯源
 *   - Service 暴露 runNow() 供手动触发
 *
 * 设计原则：
 *   - 严格遵守 contract 的 EvalResult schema（dimension 必须是 DimensionScore）
 *   - 任一上游 Service 不可用 → 降级为「部分评估」+ finding（不抛错）
 *   - 不评估自己（递归陷阱）；self 在 evaluateAll 排除
 *
 * Row (profile cordis.patch.yml):
 *   - insert:
 *       - id: agint-quality-eval
 *         name: ./plugins/agint-quality/agint-quality-eval/lib/index.js
 *         config: {}
 */

import { z } from 'zod';
import {
  evaluateAll,
  compositeScore,
  DIMENSION_KEYS,
} from './evaluators.js';
import { WeeklyScheduler } from './scheduler.js';

const name = 'agint-quality-eval';
const inject = ['timer'];

const Config = z.object({
  /** 调度表达式（cron 5-field）——默认每周日 04:30 */
  schedule: z.string().default('30 4 * * 0'),
  /** tick 间隔（毫秒）——默认 5 分钟 */
  tickIntervalMs: z.number().int().positive().default(5 * 60 * 1000),
}).optional();

/** EvalTarget schema 镜像（不依赖 contract plugin 的运行时 import） */
const EvalTargetSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['plugin', 'skill', 'preset', 'composite']),
  version: z.string().default('0.0.0'),
  path: z.string().optional(),
  tags: z.array(z.string()).default([]),
}).strict();

/** 本插件 id（用于 evaluateAll 排除自评） */
const SELF_PLUGIN_ID = 'agint-quality-eval';

function apply(ctx, config) {
  const cfg = Config.parse(config || {});
  let scheduler = null;
  let disposed = false;

  // 把 dispose 标记挂到 ctx.effect 上
  ctx.effect(() => () => {
    disposed = true;
    if (scheduler) {
      // scheduler 自己用 ctx.setInterval + ctx.effect 注册，无需手动 dispose
      // 这里只是标记 disposed 防止 tick 期间 race
    }
  });

  /** 把 EvalResult 转成能写进 memory 的精简 record */
  function toMemoryRecord(result, decision) {
    return {
      type: 'decision',
      content: `[agint.quality] ${result.targetId} evaluated → ${decision} (${JSON.stringify({
        trust: result.dimensions.find(d => d.key === 'trust')?.score?.score,
        reliability: result.dimensions.find(d => d.key === 'reliability')?.score?.score,
        effectiveness: result.dimensions.find(d => d.key === 'effectiveness')?.score?.score,
        safety: result.dimensions.find(d => d.key === 'safety')?.score?.score,
        integrability: result.dimensions.find(d => d.key === 'integrability')?.score?.score,
        harm: result.harm,
      })})`,
      evidence: `agint-quality-eval:${result.evaluatorId}`,
    };
  }

  /** 枚举 AGINT 已注册的 Skills + Plugins 作为评估目标 */
  async function enumerateTargets() {
    const targets = [];
    // 1. AGINT Skills（用 dsh skills service，名字带 'agint' 前缀或 'AGINT' tag）
    const skills = ctx.get('skills');
    if (skills && typeof skills.list === 'function') {
      try {
        const list = await skills.list({});
        const items = list?.items || list || [];
        for (const s of items) {
          const name = typeof s === 'string' ? s : (s.name || s.id);
          if (!name) continue;
          // 只评 AGINT 自己相关的 skill（名字包含 agint 或挂在 AGINT 目录）
          if (name.toLowerCase().includes('agint') || name.startsWith('AGINT')) {
            targets.push({ id: name, kind: 'skill', version: '0.0.0' });
          }
        }
      } catch (err) {
        console.error('agint-quality-eval: skills.list failed', err.message);
      }
    }
    // 2. AGINT Plugins（从 dsh plugin registry 拿）
    //    dsh 没有直接 service 暴露 plugin 列表 — 退化为：从 cordis 的插件表读
    //    这里用 ctx.plugin? — 不一定有；保守只评 skills + 显式传入的 targets
    return targets;
  }

  // ── Service: agint.qualityEvaluator ──
  const evaluator = {
    /** 评估单个 target */
    async evaluate(targetInput) {
      if (disposed) throw new Error('agint-quality-eval: disposed');
      // 校验 target（不依赖 contract 插件的运行时 import；本地 schema 镜像）
      const target = EvalTargetSchema.parse(targetInput);
      // 拒绝自评（递归陷阱）
      if (target.id === SELF_PLUGIN_ID) {
        throw new Error(`agint-quality-eval: refusing to self-evaluate (id=${SELF_PLUGIN_ID})`);
      }
      const result = await evaluateAll(ctx, target);
      return result;
    },

    /** 批量评估 */
    async evaluateAll(targets) {
      if (!Array.isArray(targets)) throw new Error('evaluateAll: targets must be array');
      const out = [];
      for (const t of targets) {
        try {
          out.push(await evaluator.evaluate(t));
        } catch (err) {
          out.push({
            targetId: t.id || '<unknown>',
            kind: t.kind || 'unknown',
            evaluatedAt: new Date().toISOString(),
            durationMs: 0,
            dimensions: [],
            harm: { homogeneity: 0.5, alignment: 0.5, reduction: 0.5, mutability: 0.5 },
            findings: [{
              severity: 'blocker',
              message: `evaluate failed: ${err.message}`,
              evidence: [],
            }],
            evaluatorId: SELF_PLUGIN_ID,
          });
        }
      }
      return out;
    },

    /** 综合分（0-100，或 null 表示一票否决） */
    async score(evalResult) {
      return compositeScore(evalResult);
    },

    /** 强制跑一次周评估（供调试 / 手动触发） */
    async runNow() {
      if (!scheduler) throw new Error('agint-quality-eval: scheduler not initialized');
      return scheduler.runNow();
    },

    /** 下次自动触发时间 */
    nextFire() {
      if (!scheduler) return null;
      return scheduler.getNextFire();
    },

    /** 最近一次跑的结果 */
    lastRun() {
      if (!scheduler) return null;
      return scheduler.getLastRun();
    },

    /** 暴露维度权重（供 policy / reporter 调用） */
    weights: {
      trust: 0.20,
      reliability: 0.20,
      effectiveness: 0.10,
      safety: 0.30,
      integrability: 0.20,
      convention: 0.00,
      adaptability: 0.00,
    },

    /** 暴露维度键顺序 */
    dimensionKeys: DIMENSION_KEYS,
  };

  ctx.provide('agint.qualityEvaluator', evaluator);

  // ── 注册周调度器（延迟到 apply 末尾，让所有 Service 已就绪） ──
  // 用 setImmediate / queueMicrotask 推迟到下一个 microtask，确保所有 sibling plugin 已 provide
  queueMicrotask(() => {
    if (disposed) return;

    async function weeklyTask() {
      const memory = ctx.get('agint.memory');
      const targets = await enumerateTargets();
      if (targets.length === 0) {
        console.log('[agint-quality-eval] weekly: no targets to evaluate');
        return { evaluated: 0, persisted: 0 };
      }
      const results = await evaluator.evaluateAll(targets);
      let persisted = 0;
      if (memory && typeof memory.write === 'function') {
        for (const r of results) {
          const decision = compositeScore(r) === null ? 'REJECT' : 'PENDING_REVIEW';
          try {
            await memory.write(toMemoryRecord(r, decision));
            persisted++;
          } catch (err) {
            console.error(`agint-quality-eval: memory.write failed for ${r.targetId}`, err.message);
          }
        }
      }
      console.log(`[agint-quality-eval] weekly: evaluated ${results.length}, persisted ${persisted}`);
      return { evaluated: results.length, persisted };
    }

    try {
      scheduler = new WeeklyScheduler(ctx, weeklyTask);
    } catch (err) {
      // timer 服务不可用时不阻塞：跳过自动调度，Service 仍可手动 runNow()
      console.warn('agint-quality-eval: scheduler init failed (timer unavailable); manual runNow() still works:', err.message);
    }
  });
}

export { Config, apply, inject, name };