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

import { z } from '../../node_modules/zod/index.js';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  evaluateAll,
  compositeScore,
  DIMENSION_KEYS,
} from './evaluators.js';
import { resolveWeights, validateWeights, DEFAULT_DIMENSION_WEIGHTS } from './weights.js';
import { WeeklyScheduler } from './scheduler.js';
import { enumeratePluginTargets } from './plugin-targets.js';
import {
  BASELINE_TARGETS,
  checkRegression,
  checkStagnation,
  computePassRate,
  makeBaselineSnapshot,
  pickLatestBaseline,
  STAGNATION_DELTA_THRESHOLD,
  STAGNATION_K,
} from './regression.js';
import {
  checkDeployBudget,
  countAutoDeploys,
  DEFAULT_DEPLOY_BUDGET,
  DEFAULT_WINDOW_DAYS,
} from './deployBudget.js';
import {
  computeEffectiveDelta,
  formatEffectiveDeltaLine,
  MIN_TOKEN_COVERAGE,
} from './effectiveDelta.js';

const name = 'agint-quality-eval';
// 0.3.3：运行时 inject 只列真实存在的 cordis 服务（timer=平台、agint.evolution=evolution-memory、
// agint.qualitySandbox=sandbox）。'skills' 不是 cordis 服务（dsh 全仓无注册方），放进 inject
// 会让本插件永久 pending —— 见 CHANGELOG 0.3.3。技能目标改由 enumerateTargets 目录扫描枚举。
const inject = ['timer', 'agint.evolution', 'agint.qualitySandbox'];

const Config = z.object({
  /** 调度表达式（cron 5-field）——默认每周日 04:30 */
  schedule: z.string().default('30 4 * * 0'),
  /** tick 间隔（毫秒）——默认 5 分钟 */
  tickIntervalMs: z.number().int().positive().default(5 * 60 * 1000),
  /**
   * 0.3.3：技能根目录列表（评估目标枚举源，同 agint-curator v0.2.1 的 skills_dir 多根口径）。
   * 缺省 = [DSH_HOME/skills, DSH_HOME/.agent-presets/agint/skills]（投放位在前，手工位在后，
   * 多根按 name 去重、声明顺序在前者优先）。
   */
  skillsDirs: z.array(z.string()).optional(),
  /**
   * 0.3.5：是否把宿主已挂载的 plugin 纳入评估目标（老板 2026-10-14 拍板方案 2：
   * plugin + skill 都评）。
   *
   * 发现源是 `ctx.loader.entries()` —— 权威名册（patch 只说"要什么"，loader
   * 才说"挂上了什么"，agint-family-panel/lib/index.js:176 的同款口径）。
   * 默认 true：此前 weekly 只枚举技能目录里名字含 'agint' 的技能，
   * 本机实测只枚举到 1 个（$DSH_HOME/skills 6 个目录含 agint 的 0；
   * .agent-presets/agint/skills 10 个目录含 agint 的 1），
   * 与老板 2026-08-20 拍板的 9 个 core plugin 口径不符。
   *
   * 设为 false 可回到纯技能枚举（不新增目录扫描面）。
   */
  includePlugins: z.boolean().default(true),
  /** 0.3.5：plugin 命名空间过滤。默认只收 `agint-*` —— 宿主其它 plugin 不在本系统评估范围。 */
  pluginIdPrefix: z.string().default('agint-'),
  /**
   * 0.3.5：单次评估的目标数上限。
   * 默认 undefined = 不限（老板拍板"plugin + skill 都评"，不悄悄截断）。
   * ⛔ 若设了值，截断会 console.warn 点名被丢掉的数量 —— 静默截断等于假覆盖率。
   * 扩大评估面后目标数从 1 涨到 38（本机实测），若单次评估耗时不可接受，
   * 在这里设上限，而不是回头去收窄枚举口径。
   */
  maxTargets: z.number().int().positive().optional(),
  /** 行动 #5（2026-09-28）：综合分维度权重外置（partial；缺失键回退内置默认） */
  dimensionWeights: z.object({
    trust: z.number().min(0).max(1).optional(),
    reliability: z.number().min(0).max(1).optional(),
    effectiveness: z.number().min(0).max(1).optional(),
    safety: z.number().min(0).max(1).optional(),
    convention: z.number().min(0).max(1).optional(),
    adaptability: z.number().min(0).max(1).optional(),
    integrability: z.number().min(0).max(1).optional(),
    promptStatic: z.number().min(0).max(1).optional(),
  }).optional(),
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

/**
 * Sprint 13 §3.3 部署护栏默认配置（ADJUSTABLE；口径见遗留 TODO T2）
 *   - windowDays：滚动 7 天（默认口径，老板过审时确认）
 *   - budget：每周自动部署上限 3 次（AGENTS.md 健康度护栏）
 */
const DEFAULT_DEPLOY_GUARD = Object.freeze({
  windowDays: DEFAULT_WINDOW_DAYS,
  budget: DEFAULT_DEPLOY_BUDGET,
});

function apply(ctx, config) {
  const cfg = Config.parse(config || {});
  // 行动 #5（2026-09-28）：权重外置可配置 —— patch config.dimensionWeights 覆盖内置默认；
  // 非法 patch 回退默认并告警（不抛，不影响评估主路径）。
  const resolvedWeights = resolveWeights(cfg.dimensionWeights);
  if (resolvedWeights.issues.length > 0) {
    console.warn('[agint-quality-eval] dimensionWeights invalid, using defaults: ' + resolvedWeights.issues.join('; '));
  }
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

  // Sprint 12 A1（T1 影子期）：影子订阅接收记录 ring buffer
  const shadowProposals = [];

  /** Sprint 3.1: 构造 sandbox-failed REJECT EvalResult（safety=0 一票否决） */
  function makeSandboxRejectedResult(target, smoke) {
    const failedChecks = (smoke.checks ?? []).filter((c) => !c.ok).map((c) => c.name);
    return {
      targetId: target.id,
      kind: target.kind,
      evaluatedAt: new Date().toISOString(),
      durationMs: 0,
      dimensions: [
        {
          key: 'safety',
          label: '安全',
          score: { score: 0, raw: { sandbox: smoke }, evidence: [], children: [] },
          veto: true,
          findings: [],
        },
      ],
      harm: { homogeneity: 0, alignment: 0, reduction: 0, mutability: 0 },
      findings: [{
        severity: 'blocker',
        message: `sandbox-failed: ${smoke.reason ?? 'unknown'} (mode=${smoke.mode}, failed_checks=[${failedChecks.join(',')}])`,
        evidence: failedChecks,
      }],
      evaluatorId: SELF_PLUGIN_ID,
    };
  }

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

  /** 加载 baseline 历史：从 evo.queryTemplates 筛 appliesTo 包含 'baseline-suite' 的 */
  async function loadBaselineHistory(evo) {
    if (!evo || typeof evo.queryTemplates !== 'function') return [];
    const templates = await evo.queryTemplates({ appliesTo: ['baseline-suite'] });
    return templates.map((t) => {
      try {
        return JSON.parse(t.evidence);
      } catch {
        return null;
      }
    }).filter(Boolean);
  }

  /** 用当前 BASELINE_TARGETS 跑一遍生成 snapshot（用于 setBaseline({ results: undefined })） */
  async function currentSnapshot() {
    const results = await evaluator.evaluateAll(BASELINE_TARGETS);
    const perTarget = results.map((r) => ({
      id: r.targetId,
      ok: compositeScore(r, resolvedWeights.weights) !== null,
      score: compositeScore(r, resolvedWeights.weights),
    }));
    return makeBaselineSnapshot({ results: perTarget });
  }

  /**
   * 枚举 AGINT Skills 作为评估目标。
   *
   * 0.3.3 修正：原实现走 ctx.get('skills')，但 'skills' 不是 cordis 服务
   * （dsh 全仓没有任何注册方），恒 undefined → 评估池恒空（0.3.2 想修的就是它，
   * 但 manifest 声明救不了运行时）。改为目录扫描，口径与 agint-curator v0.2.1
   * 的 skills_dir 多根一致：子目录含 SKILL.md 视为技能，name 取 frontmatter、
   * 缺省用目录名，多根按 name 去重（声明顺序在前者优先）。
   *
   * 产出形态保持 { id, kind: 'skill', version: '0.0.0' }——不带 path，
   * 不触发 sandbox gate（只恢复取数能力，不扩大评估行为面）。
   */
  async function enumerateTargets() {
    const targets = [];
    const seen = new Set();

    // ── 源 1：已挂载 plugin（0.3.5 新增，老板 2026-10-14 拍板方案 2）────────
    // 权威名册 = ctx.loader.entries()。⚠️ 它不是数组、是迭代器 ——
    // agint-mascot v0.1.1 踩过（用 Array.isArray 判形状会把健康宿主读成 warn），
    // 照它的 toArray() 先例处理，不自创。
    // 自评由 evaluate() 里的 SELF_PLUGIN_ID 拒绝兜底（递归陷阱），这里不重复判。
    if (cfg?.includePlugins !== false) {
      const { targets: pluginTargets, reason } = enumeratePluginTargets(
        ctx,
        cfg?.pluginIdPrefix ?? 'agint-',
        SELF_PLUGIN_ID,
      );
      // 读不到要出声：静默返回空 = 评估池看着有数、实际漏了一整类目标
      if (reason) {
        console.warn(`[agint-quality-eval] plugin 目标枚举降级: ${reason}`);
      }
      for (const p of pluginTargets) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        targets.push(p);
      }
    }

    // ── 源 2：技能目录（0.3.3 起的既有行为，保持不变）──────────────────────
    const dshHome = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh');
    const roots = cfg?.skillsDirs?.length
      ? cfg.skillsDirs
      : [
          join(dshHome, 'skills'),                              // 用户级投放位（skill-autocreate）
          join(dshHome, '.agent-presets', 'agint', 'skills'),   // AGINT 手工位（preset 随仓库同步）
        ];
    for (const root of roots) {
      for (const s of await scanSkillDir(root)) {
        if (seen.has(s.name)) continue;
        seen.add(s.name);
        if (s.name.toLowerCase().includes('agint')) {
          targets.push({ id: s.name, kind: 'skill', version: '0.0.0' });
        }
      }
    }
    if (typeof cfg?.maxTargets === 'number' && targets.length > cfg.maxTargets) {
      // 截断必须出声：静默截断 = 假覆盖率（判据层同款纪律，§3.18）
      console.warn(
        `[agint-quality-eval] 目标数 ${targets.length} 超过 maxTargets=${cfg.maxTargets}，` +
        `截断后 ${cfg.maxTargets} 个，丢弃 ${targets.length - cfg.maxTargets} 个`,
      );
      return targets.slice(0, cfg.maxTargets);
    }
    return targets;
  }

  /** 扫描单个技能根（精简自 agint-curator/lib/aggregator.js scanSkills，宁漏勿错） */
  async function scanSkillDir(root) {
    let entries = [];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return []; // 目录不存在 → 空清单，不抛（冒烟友好）
    }
    const out = [];
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue; // .archive 等隐藏目录不扫
      let name = ent.name;
      try {
        const text = await readFile(join(root, ent.name, 'SKILL.md'), 'utf8');
        const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
        const nm = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
        if (nm) name = nm;
      } catch {
        continue; // SKILL.md 缺失/不可读 → 跳过
      }
      out.push({ name });
    }
    return out;
  }

  // ── Service: agint.qualityEvaluator ──
  // 有效进化增量结果缓存（60s TTL）：决策路径会按 target 连调，每次都读两遍 JSONL 太浪费。
  let effectiveDeltaCache = null;
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

      // ── Sprint 3.1: sandbox gate (D-QAF Phase 2 hook) ─────────────────
      // 老板拍板: sandbox 失败 → REJECT (safety 一票否决)
      const sandbox = ctx.get('agint.qualitySandbox');
      if (sandbox && typeof sandbox.runSmoke === 'function' && target.path) {
        let smoke;
        try {
          smoke = await sandbox.runSmoke({ target: { path: target.path, name: target.id } });
        } catch (e) {
          // sandbox service 自己挂了（不该发生，但防御性）
          smoke = { ok: false, mode: 'sandbox', reason: `sandbox-threw:${e.message}`, checks: [] };
        }
        if (!smoke.ok) {
          // 构造 REJECT EvalResult（safety=0 触发 compositeScore null + finding blocker）
          return makeSandboxRejectedResult(target, smoke);
        }
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
          const r = await evaluator.evaluate(t);
          // Sprint 6.3/6.4: 把 target.tags 注入到 EvalResult（policy/report 用）
          // EvalResult 不是 FROZEN 字段，但 contract EvalResultSchema 也不含 tags。
          // 选用最小侵入: 给 result 增加非 contract 字段 tags (政策/render 用)
          out.push({ ...r, tags: t.tags ?? [] });
        } catch (err) {
          out.push({
            targetId: t.id || '<unknown>',
            kind: t.kind || 'unknown',
            tags: t.tags ?? [],
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

    /** 综合分（0-100，或 null 表示一票否决）
     *
     * Sprint 12 / A2 — T1 影子期：发布 evolution.evaluated 边事件
     * 唯一 sync 门禁边（per Sprint12 设计稿 §A3，policy 订阅 mode=sync）
     *
     * 行为契约：
     *   - 保留原 return（composite 数值）；不阻塞调用方
     *   - publish 失败 → log error 但不抛（事件层降级不影响评分主路径）
     *   - 缺 agint.eventBus.publish Service → 纯静默跳过（软降级）
     */
    async score(evalResult) {
      const composite = compositeScore(evalResult, resolvedWeights.weights);

      // 拉取 eventBus publish（optionalInject 软依赖）
      const publish = typeof ctx.get === 'function' ? ctx.get('agint.eventBus.publish') : null;
      if (publish && typeof publish === 'function' && !disposed) {
        try {
          await publish({
            topic: 'evolution.evaluated',
            version: 1,
            source: 'agint-quality-eval',
            payload: {
              targetId: evalResult?.targetId ?? null,
              decision: composite !== null ? 'SCORED' : 'VETOED',
              scores: { composite },
              findings: Array.isArray(evalResult?.findings) ? evalResult.findings : [],
            },
          });
        } catch (err) {
          if (!disposed) console.error('[agint-quality-eval] eventBus.publish failed:', err?.message ?? err);
        }
      }

      return composite;
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

    /** 暴露维度权重（行动 #5 2026-09-28：单一事实源 = resolvedWeights；config 可覆盖） */
    weights: { ...resolvedWeights.weights },

    /** 暴露维度键顺序 */
    dimensionKeys: DIMENSION_KEYS,

    // ── 退化探测（Sprint 2 落地） ────────────────────────────────────

    /**
     * Run baseline-regression-suite: evaluate all BASELINE_TARGETS, compare
     * pass rate against the latest baseline snapshot stored in evolution.
     * Returns { snapshot, baseline, regression, alerts[] }.
     *
     * triggers evo.addFailure(pattern='regression:<severity>', tags=['freeze'])
     * on regression detection (老板拍板：只加 freeze failure-pattern).
     */
    async runBaselineSuite({ targets = BASELINE_TARGETS } = {}) {
      const evo = ctx.get('agint.evolution');
      const results = await evaluator.evaluateAll(targets);
      const perTarget = results.map((r) => ({
        id: r.targetId,
        ok: compositeScore(r, resolvedWeights.weights) !== null,  // safety veto / null score = REJECT
        score: compositeScore(r, resolvedWeights.weights),
      }));
      const snapshot = makeBaselineSnapshot({ results: perTarget });
      const baselineHistory = await loadBaselineHistory(evo);
      const baseline = pickLatestBaseline(baselineHistory);
      const regression = baseline
        ? checkRegression({ baselineRate: baseline.passRate, currentRate: snapshot.passRate })
        : { delta: 0, isRegression: false, threshold: -0.02, severity: 'no-baseline', reason: 'no-baseline' };

      const alerts = [];
      if (regression.isRegression && evo && typeof evo.addFailure === 'function') {
        const pattern = `regression:${regression.severity}`;
        const alert = {
          kind: 'regression',
          severity: regression.severity,
          delta: regression.delta,
          baselineRate: baseline?.passRate ?? null,
          currentRate: snapshot.passRate,
          capturedAt: snapshot.capturedAt,
          targetCount: snapshot.total,
        };
        await evo.addFailure({
          pattern,
          category: 'integration',
          severity: regression.severity === 'blocker' ? 'high' : (regression.severity === 'high' ? 'high' : 'medium'),
          evidence: JSON.stringify(alert),
        });
        alerts.push(alert);
      }

      return { snapshot, baseline, regression, alerts };
    },

    /**
     * Set the current baseline. Stores a success-template entry so it can be
     * found via evo.queryTemplates({ appliesTo: ['baseline-suite'] }).
     */
    async setBaseline({ results, note } = {}) {
      const evo = ctx.get('agint.evolution');
      if (!evo) throw new Error('setBaseline: agint.evolution not available');
      const snapshot = results ? makeBaselineSnapshot({ results }) : await currentSnapshot();
      const appliesTo = ['baseline-suite', ...snapshot.targetIds.slice(0, 3)];
      const evidence = note ?? JSON.stringify(snapshot);
      return await evo.addSuccess({
        template: `baseline-suite-passrate:${snapshot.passRate.toFixed(3)}`,
        sampleSize: snapshot.total,
        appliesTo,
        evidence,
      });
    },

    /** Get the latest baseline snapshot (or null if none). */
    async getBaseline() {
      const evo = ctx.get('agint.evolution');
      if (!evo) return null;
      const history = await loadBaselineHistory(evo);
      return pickLatestBaseline(history);
    },

    /**
     * Check stagnation: read recent evolution-log entries, extract composite
     * scores in ascending time order, run checkStagnation.
     * Returns the full stagnation report; does NOT auto-freeze (Sprint 3
     * policy integration decides).
     */
    async checkStagnation({ k = STAGNATION_K, threshold = STAGNATION_DELTA_THRESHOLD } = {}) {
      const evo = ctx.get('agint.evolution');
      if (!evo) return { isStagnated: false, k, threshold, reason: 'evolution-unavailable' };
      // Read recent evolution-log entries; extract composite scores
      const logs = await evo.getLogRange({ limit: 50 });
      const scored = logs
        .filter((l) => l.scores && typeof l.scores.composite === 'number')
        .map((l) => ({ ts: l.ts ?? l.createdAt, score: l.scores.composite }))
        .sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
      const scores = scored.map((s) => s.score);
      const result = checkStagnation({ scores, k, threshold });
      return { ...result, sampleSize: scores.length, scores };
    },

    // ── D-QAF §5.3 有效进化增量（2026-10-26，D2 收口） ─────────────────

    /**
     * 有效进化增量 = Δ(任务完成率) / Δ(token + 步数 + 耗时)（evolution-framework.md §5.2）。
     *
     * 数据源：`agint.toolStats.resourceWindow()` 的**相邻两窗**读数
     *   - 当期：最近 windowDays 天（offsetDays = 0）
     *   - 基线：再往前 windowDays 天（offsetDays = windowDays）
     * 判定交给纯函数 `computeEffectiveDelta`（fail-closed：token 覆盖率不足 ⇒ verdict='unknown'，
     * 绝不把分母退化成「步数 + 耗时」冒充完整读数）。
     *
     * 调用方（quality-policy 的 decide）会把结果塞进 options.effectiveDelta，
     * 使「≤ 0 ⇒ 拒绝自动部署」这条宪法约束第一次真正生效。
     *
     * @param {{windowDays?: number, minTokenCoverage?: number, nowMs?: number, origin?: string}} [args]
     */
    async effectiveDelta({ windowDays = DEFAULT_WINDOW_DAYS, minTokenCoverage = MIN_TOKEN_COVERAGE, nowMs, origin = 'manual' } = {}) {
      const ts = (typeof ctx.get === 'function') ? ctx.get('agint.toolStats') : null;
      if (!ts || typeof ts.resourceWindow !== 'function') {
        const base = { value: null, verdict: 'unknown', reason: 'tool-stats-unavailable', shouldBlockDeploy: false };
        return { ...base, origin, line: formatEffectiveDeltaLine(base) };
      }
      // 决策路径会按 target 连续调用（每次都读两遍 5MB JSONL）⇒ 60s TTL 缓存。
      // 这是**周级**指标，60 秒内的抖动没有意义；缓存键含窗口与门槛，origin 只影响标注。
      const clock = Number.isFinite(nowMs) ? nowMs : Date.now();
      const cacheKey = `${windowDays}|${minTokenCoverage}`;
      const now = Date.now();
      if (effectiveDeltaCache && effectiveDeltaCache.key === cacheKey && now - effectiveDeltaCache.at < 60_000) {
        return { ...effectiveDeltaCache.result, origin, line: formatEffectiveDeltaLine(effectiveDeltaCache.result) };
      }
      // 两窗必须同口径、同天数、同一基准时刻错开 —— 否则「增量」比较的是两段不等长的时间
      const current = await ts.resourceWindow({ days: windowDays, offsetDays: 0, nowMs: clock });
      const baseline = await ts.resourceWindow({ days: windowDays, offsetDays: windowDays, nowMs: clock });
      const result = computeEffectiveDelta({ baseline, current, minTokenCoverage, origin: 'cached' });
      effectiveDeltaCache = { key: cacheKey, at: now, result };
      return { ...result, origin, windowDays, line: formatEffectiveDeltaLine(result) };
    },
  };

  ctx.provide('agint.qualityEvaluator', evaluator);

  // 行动 #5（2026-09-28）：权重外置可配置服务面（get/validate/resolve + 内置默认）。
  ctx.provide('agint.qualityEvaluator.weights', {
    get: () => ({ ...resolvedWeights.weights }),
    validate: (patch) => validateWeights(patch),
    resolve: (patch) => resolveWeights(patch),
    defaults: { ...DEFAULT_DIMENSION_WEIGHTS },
  });

  // ── Sprint 13 §3.3 部署预算护栏（weekly hook 每周 ≤3 次自动部署）────────
  // 数据源 = quality-policy 既有 audit 日志（agint.evolution evolution_log），不自建存储。
  // 最近一次护栏结果缓存在内存，供周复盘 / 巡检读取；不持久化（读侧可随时重算）。
  let lastDeployBudget = null;

  async function runDeployBudgetCheck(overrides = {}) {
    const result = await checkDeployBudget({
      ctx,
      windowDays: overrides.windowDays ?? DEFAULT_DEPLOY_GUARD.windowDays,
      budget: overrides.budget ?? DEFAULT_DEPLOY_GUARD.budget,
      nowMs: overrides.nowMs,
      writeAudit: overrides.writeAudit !== false,
    });
    lastDeployBudget = result;
    return result;
  }

  ctx.provide('agint.qualityEval.checkDeployBudget', runDeployBudgetCheck);
  ctx.provide('agint.qualityEval.countAutoDeploys', (overrides = {}) =>
    countAutoDeploys({
      evolution: ctx.get('agint.evolution'),
      windowDays: overrides.windowDays ?? DEFAULT_DEPLOY_GUARD.windowDays,
      nowMs: overrides.nowMs,
    }));
  /** 只读快照：最近一次护栏结果（未跑过返回 null） */
  ctx.provide('agint.qualityEval.deployBudget', () => lastDeployBudget);
  /**
   * 门禁查询：超预算时返回 'PENDING_REVIEW'（proposal 路径强制降级），否则 null。
   * 幂等（R1）：纯读，不累加任何计数 —— at-least-once 重复调用不改变结果。
   */
  ctx.provide('agint.qualityEval.deployBudgetGate', () =>
    (lastDeployBudget?.exceeded ? lastDeployBudget.forcedDecision : null));
  ctx.provide('agint.qualityEval.deployGuardConfig', DEFAULT_DEPLOY_GUARD);

  // ── Sprint 12 A1（T1 影子期）：订阅 evolution.proposed ─────────────────
  // 设计稿 §A1：population → (bus) → quality-eval 的异步通路。
  // **直连路径完整保留**：上层仍可走 evaluator.runNow() / 内部调用；
  //   本 handler 是 **shadow ingestion** —— 接收 proposal 写入内部 ring
  //   （不打分、不触发真实 evaluateAll，避免双跑流量）。
  // 降级：bus 不可用 → 静默跳过（不报错）
  try {
    // event-bus plugin 的 subscribe 也是分 service（agint.eventBus.subscribe），无 umbrella key
    const subscribe = (typeof ctx.get === 'function') ? ctx.get('agint.eventBus.subscribe') : null;
    if (typeof subscribe === 'function') {
      const unsubscribe = subscribe(
        { subscriber: 'agint-quality-eval', topics: ['evolution.proposed'], mode: 'async' },
        async (envelope) => {
          try {
            const p = envelope?.payload ?? {};
            shadowProposals.push({
              proposalId: p.proposalId,
              kind: p.kind,
              origin: p.origin,
              at: new Date().toISOString(),
              envelopeId: envelope?.id,
            });
            // ring buffer 上限（与 event-bus ringBufferCapacity 2000 对齐；本地 ring 更小）
            if (shadowProposals.length > 500) shadowProposals.splice(0, shadowProposals.length - 500);
          } catch { /* handler 永不抛 */ }
        },
      );
      ctx.effect(() => () => { try { if (typeof unsubscribe === 'function') unsubscribe(); } catch { /* ignore */ } });
    }
  } catch { /* bus 不可用：影子订阅静默跳过 */ }

  // 暴露影子 ring（仅 host / driver / inspect 使用；不进 model 工具）
  ctx.provide('agint.qualityEval.shadowProposals', () => shadowProposals.slice());

  // ── 注册周调度器（延迟到 apply 末尾，让所有 Service 已就绪） ──
  // 用 setImmediate / queueMicrotask 推迟到下一个 microtask，确保所有 sibling plugin 已 provide
  queueMicrotask(() => {
    if (disposed) return;

    async function weeklyTask() {
      const memory = ctx.get('agint.memory');
      const evo = ctx.get('agint.evolution');
      const targets = await enumerateTargets();
      if (targets.length === 0) {
        console.log('[agint-quality-eval] weekly: no targets to evaluate');
        return { evaluated: 0, persisted: 0, loggedToEvo: 0, baseline: null, stagnation: null };
      }
      const results = await evaluator.evaluateAll(targets);

      // ── Phase 4 自动化：每个 EvalResult 写 evolution-log ─────────
      let loggedToEvo = 0;
      if (evo && typeof evo.logPhase4 === 'function') {
        for (const r of results) {
          const score = compositeScore(r);
          const decision = score === null ? 'REJECT' : 'PENDING_REVIEW';
          const scores = { composite: score };
          for (const d of r.dimensions) {
            if (d.score?.score !== null && d.score?.score !== undefined) {
              scores[d.key] = d.score.score;
            }
          }
          try {
            await evo.logPhase4({
              targetId: r.targetId,
              targetKind: r.kind,
              decision,
              scores,
              findings: r.findings ?? [],
              tags: ['weekly'],
            });
            loggedToEvo++;
          } catch (err) {
            console.error(`agint-quality-eval: evo.logPhase4 failed for ${r.targetId}`, err.message);
          }
        }
      }

      // ── 任务记忆（保持 v0.2 行为，向后兼容） ─────────────────────
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

      // ── D-QAF Phase 3：baseline-regression-suite（退化探测） ────
      let baselineReport = null;
      try {
        baselineReport = await evaluator.runBaselineSuite();
        if (baselineReport?.regression?.isRegression) {
          console.warn(`[agint-quality-eval] baseline regression detected: severity=${baselineReport.regression.severity} delta=${baselineReport.regression.delta}`);
        }
      } catch (err) {
        console.error(`[agint-quality-eval] runBaselineSuite failed: ${err.message}`);
      }

      // ── D-QAF Phase 3：stagnation-check（进化停滞） ─────────────
      let stagnationReport = null;
      try {
        stagnationReport = await evaluator.checkStagnation();
        if (stagnationReport?.isStagnated) {
          console.warn(`[agint-quality-eval] stagnation detected: reason=${stagnationReport.reason} recentMaxDelta=${stagnationReport.recentMaxDelta}`);
        }
      } catch (err) {
        console.error(`[agint-quality-eval] checkStagnation failed: ${err.message}`);
      }

      // ── D-QAF §5.3 有效进化增量（2026-10-26，D2 收口）─────────────
      // 公式的分母此前只算得出「步数 + 时间」（token 项恒缺，见 F3）。
      // 现在 token 项接上后的三种结局都必须**出声**：
      //   effective / ineffective / unknown（token 覆盖率不足，护栏未生效）。
      let effectiveDelta = null;
      try {
        effectiveDelta = await evaluator.effectiveDelta({ origin: 'weekly' });
        if (effectiveDelta.verdict === 'ineffective') {
          console.warn(`[agint-quality-eval] 无效进化：${effectiveDelta.line}`);
        } else if (effectiveDelta.verdict === 'unknown') {
          console.warn(`[agint-quality-eval] 有效进化增量测不出来（护栏未生效）：${effectiveDelta.line}`);
        }
      } catch (err) {
        console.error(`[agint-quality-eval] effectiveDelta failed: ${err?.message ?? err}`);
        effectiveDelta = { verdict: 'unknown', reason: 'compute-failed', value: null, line: `- 有效进化增量：计算失败（${err?.message ?? err}）` };
      }

      // ── Sprint 13 §3.3 weekly hook 部署预算护栏（weeklyTask 末尾）────────
      // 统计滚动 7 天 AUTO_DEPLOY 次数；超预算 → 后续 proposal 强制 PENDING_REVIEW
      // + 写 audit + 周复盘告警一行（reviewLine 由周复盘模板直接消费）。
      // 幂等（R1）：纯读 + 单次 audit 写；事件重复投递不产生重复决策、不污染计数。
      let deployBudget = null;
      try {
        deployBudget = await runDeployBudgetCheck();
      } catch (err) {
        // 护栏自身失败不阻断 weeklyTask 其余产出（真实 > 讨好：暴露错误而非静默吞掉）
        console.error(`[agint-quality-eval] checkDeployBudget failed: ${err?.message ?? err}`);
        deployBudget = { error: err?.message ?? String(err), exceeded: false, forcedDecision: null, reviewLine: '- 部署预算：护栏执行失败（见日志）' };
      }

      // ── Sprint 13 §4.5 模型更新主路径：weeklyTask 直连调 agint.selfModel.update ──
      // 不经由总线（对齐「主路径直连 / 影子消费 A6/A8」双轨原则）；self-model 未挂载
      // 时软降级跳过（不阻断 weeklyTask 其余产出）。T1 影子期 update 顺带 publish A11（publish-only）。
      try {
        const selfModelUpdate = (typeof ctx.get === 'function') ? ctx.get('agint.selfModel.update') : null;
        if (typeof selfModelUpdate === 'function') {
          await selfModelUpdate({ trigger: 'weekly' });
        }
      } catch (err) {
        console.warn(`[agint-quality-eval] self-model weekly update skipped: ${err?.message ?? err}`);
      }

      console.log(`[agint-quality-eval] weekly: evaluated ${results.length}, persisted ${persisted}, evo ${loggedToEvo}, baseline ${baselineReport?.regression?.severity ?? 'no-baseline'}, stagnation ${stagnationReport?.isStagnated ? 'STAGNATED' : 'active'}, effectiveDelta ${effectiveDelta?.verdict ?? '?'}, deployBudget ${deployBudget?.used ?? '?'}/${DEFAULT_DEPLOY_GUARD.budget}${deployBudget?.exceeded ? ' EXCEEDED' : ''}`);
      return {
        evaluated: results.length,
        persisted,
        loggedToEvo,
        baseline: baselineReport?.regression ?? null,
        stagnation: { isStagnated: stagnationReport?.isStagnated, reason: stagnationReport?.reason },
        // D-QAF §5.3：有效进化增量（verdict ∈ effective/ineffective/unknown + 一行可读文本）
        effectiveDelta,
        deployBudget,
      };
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