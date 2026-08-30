/**
 * agint-diagnosis v0.6.0 — 归因引擎骨架。
 *
 * 本文件只交付 Service 接口契约 + storage domain 装配 + LIMITS 守门，
 * 算法本体（6 类根因判定 / 反事实模拟 / 聚类 / report 聚合）由后续
 * 子任务 #3-#6 实现。
 *
 * Service（FROZEN，设计稿 §2.1）：
 *   - agint.diagnosis.annotate      占位（sub-task #3）
 *   - agint.diagnosis.counterfactual 占位（sub-task #4）
 *   - agint.diagnosis.cluster        占位（sub-task #5）
 *   - agint.diagnosis.report         占位（sub-task #5）
 *
 * 设计原则（设计稿 §六）：
 *   - 简洁 > 冗余：单插件净增 ≤300 行
 *   - 安全 > 效率：归因结果只读 failure_pattern，不调用
 *     agint-quality-contract FROZEN 接口
 *   - 真实 > 讨好：占位显式抛 not implemented，绝不静默
 *   - 主动 > 被动：开 domain 时就检查 LIMITS，给出 warn 让老板提前看见
 *
 * Loader row (cordis.patch.yml 模板，本文件不挂载)：
 *   - insert:
 *       - id: agint-diagnosis
 *         name: ./plugins/agint-diagnosis/lib/index.js
 *         config: {}
 */

import {
  spec,
  checkLimit,
  packAnnotation,
  packCluster,
  packReport,
  unpackAnnotation,
  unpackCluster,
  unpackReport,
  annotationEntrySchema,
  clusterEntrySchema,
  reportEntrySchema,
} from './storage.js';
import {
  AnnotationSchema,
  ClusterSchema,
  DiagnosisReportSchema,
  RootCauseKindSchema,
  LIMITS,
} from './schema.js';
import { classify as rootCauseClassify } from './root-cause-classifier.js';
import { simulate as counterfactualSimulate } from './counterfactual-simulator.js';
import { aggregateClusters, collectFailureIdsFromAnnotations } from './cluster-aggregator.js';
import { aggregateReport } from './report-aggregator.js';

// 冷启动阈值：failure_pattern 表总样本数 < 此值 → 拒绝 annotate
// 设计稿 §二.2 + §五「冷启动提示」+ 子任务 #3 / #4 交付要求
const COLD_START_MIN = 10;

// Plugin 标识 — 跟兄弟插件对齐
const name = 'agint-diagnosis';

// 硬依赖：storageDomain 必须先 mount 才能 open domain。
// 软依赖：agint.evolution（读 failure_pattern 给 annotate 用）——
// 用 ctx.get 读取，不阻塞挂载。
const inject = ['storageDomain'];

const Config = {}; // 当前无配置；保留供后续 sprint 加 limits 调参等

function nowIso() {
  return new Date().toISOString();
}

function apply(ctx) {
  let domain = null;
  let domainError = null;
  let disposed = false;

  // lifecycle：所有副作用走 ctx.effect，保证 graceful shutdown（设计稿 §八 + AGENTS.md 挂载红线）
  ctx.effect(() => () => {
    disposed = true;
    try { if (typeof _sandboxFailedUnsubscribe === 'function') _sandboxFailedUnsubscribe(); } catch { /* ignore */ }
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
    if (disposed) throw new Error('agint-diagnosis: disposed');
    if (domainError) throw domainError;
    const d = await ready;
    if (!d) throw new Error('agint-diagnosis: domain unavailable');
    return d.table(tableName);
  };

  const t_annotations = () => table('annotations');
  const t_clusters = () => table('clusters');
  const t_reports = () => table('reports');

  // ── stats helper（smoke / 后续 dashboard 都用到）───────────────────────

  async function stats() {
    const a = await t_annotations();
    const c = await t_clusters();
    const r = await t_reports();
    return {
      annotations: a.entries().length,
      clusters: c.entries().length,
      reports: r.entries().length,
      limits: LIMITS,
    };
  }

  // ── FROZEN Service 出口（设计稿 §2.1）──────────────────────────────────
  // 占位实现：所有 4 个服务都显式抛 not implemented。
  // 后续 sprint #3-#6 把算法注入到对应函数体里——不要悄悄改 Service 签名。

  /**
   * `agint.diagnosis.annotate({ failureId, trajectory }) → { rootCause, confidence, evidence }`
   * 子任务 #3 实现：6 类根因特征投票（设计稿 §二.3）。
   *
   * 流程（子任务 #3 精确范围）：
   *   1) 软依赖 `agint.evolution`（用 ctx.get，不阻塞挂载）。
   *      如未注入 → 用入参 trajectory；如已注入 → 按 failureId 从
   *      failure_pattern 表取真实步骤序列（trajectory 字段缺失时兜底）。
   *   2) cold-start 守门：failure_pattern 样本数 < COLD_START_MIN 抛错。
   *   3) 表满守门：annotations ≥ LIMITS.ANNOTATIONS 抛错（不静默）。
   *   4) 调 rootCauseClassify(trajectory) → { rootCause, confidence, evidence }。
   *   5) 写 agint_diagnosis.annotations 表（一行）。
   *   6) 返回 FROZEN 业务字段（剥 storage metadata）。
   *
   * 红线：
   *   - 不写 failure_pattern（设计稿 §二.2 / §八）。
   *   - 不调真 LLM（设计稿 §八）。
   */
  async function annotate(input) {
    const failureId = input && typeof input.failureId === 'string' ? input.failureId : '';
    if (!failureId) throw new Error('annotate: failureId is required');

    // ── 软依赖：尝试从 agint-evolution-memory.failure_pattern 取真实 trajectory
    const evolution = ctx.get && typeof ctx.get === 'function' ? ctx.get('agint.evolution') : null;
    let patternCount = 0;
    let fetchedTrajectory = null;
    if (evolution && typeof evolution.queryFailures === 'function') {
      try {
        // 先看整表样本数（cold-start 守门用）
        const all = await evolution.queryFailures({ limit: 1000 });
        patternCount = Array.isArray(all) ? all.length : 0;
        // 按 failureId 拉一条作为 trajectory（这里允许演化：failureId 既可对应 pattern.id 也可对应 pattern 文本）
        const matched = patternCount > 0
          ? all.filter((rec) => rec && (rec.id === failureId || rec.pattern === failureId))
          : [];
        if (matched.length > 0) {
          // 把单条 failure_pattern 包装成 trajectory（设计稿「步骤序列」语义对齐：单步也是序列）
          fetchedTrajectory = matched.map((rec) => ({
            pattern: rec.pattern ?? '',
            evidence: rec.evidence ?? '',
            severity: rec.severity ?? '',
            occurrences: rec.occurrences ?? 1,
            category: rec.category ?? '',
          }));
        }
      } catch (err) {
        // 容错：兄弟 service 失败不阻断——继续用入参 trajectory
        patternCount = 0;
      }
    }

    // ── cold-start 守门
    if (patternCount < COLD_START_MIN) {
      throw new Error(
        `cold-start: failure_pattern 样本数 ${patternCount} < ${COLD_START_MIN}，需先喂失败种子`,
      );
    }

    // ── 表满守门（不静默）
    const t = await t_annotations();
    if (t.entries().length >= LIMITS.ANNOTATIONS) {
      throw new Error(`annotations table full (cap ${LIMITS.ANNOTATIONS})`);
    }

    // ── 调算法：优先用从 failure_pattern 拉来的 trajectory，回退入参
    const trajectory = fetchedTrajectory && fetchedTrajectory.length > 0
      ? fetchedTrajectory
      : (Array.isArray(input && input.trajectory) ? input.trajectory : []);

    const result = rootCauseClassify(trajectory);

    // ── 写 agint_diagnosis.annotations 表
    const evidenceStr = JSON.stringify({
      matchedFeatures: result.evidence.matchedFeatures,
      scores: result.evidence.scores,
      tied: result.evidence.tied ?? null,
      note: result.evidence.note ?? null,
    });
    const business = {
      failureId,
      rootCause: result.rootCause,
      confidence: result.confidence,
      evidence: evidenceStr,
    };
    const entry = packAnnotation(business);
    await t.put(entry.id, entry);

    return unpackAnnotation(entry);
  }

  /**
   * `agint.diagnosis.counterfactual({ failureId, modifiedStrategy })
   *   → { successRate, divergentSteps }`
   * 子任务 #4 实现：反事实模拟（确定性重放，不调真 LLM）。
   *
   * 流程（任务描述 §2 精确范围）：
   *   1) 软依赖 `agint.evolution`（用 ctx.get，不阻塞挂载）。
   *      通过 evolution.queryFailures({ limit: 1000 }) 拉整 failure_pattern 表。
   *   2) cold-start 守门：failure_pattern 样本数 < COLD_START_MIN 抛错
   *      （复用 #3 COLD_START_MIN=10，基于 failure_pattern 表，与 #3 annotate 一致）。
   *   3) 按 failureId 找 entry；找不到 → 抛 failureId not found。
   *   4) 调 counterfactualSimulator.simulate({ failureId, modifiedStrategy,
   *      trajectory, evolution, memory }) → { successRate, divergentSteps }。
   *   5) 返回 FROZEN 业务字段（不写任何 agint_diagnosis 表，纯计算型接口）。
   *
   * 红线（设计稿 §八 + 任务描述）：
   *   - 不调真 LLM（确定性 perturb + classifier 重判）。
   *   - 不写 annotations / clusters / reports 任一表（counterfactual 无副作用）。
   *   - 不写 failure_pattern（设计稿 §八 红线）。
   */
  async function counterfactual(input) {
    const failureId = input && typeof input.failureId === 'string' ? input.failureId : '';
    if (!failureId) throw new Error('counterfactual: failureId is required');

    const modifiedStrategy = input && typeof input.modifiedStrategy === 'string'
      ? input.modifiedStrategy
      : '';

    const evolution = ctx.get && typeof ctx.get === 'function' ? ctx.get('agint.evolution') : null;
    if (!evolution || typeof evolution.queryFailures !== 'function') {
      throw new Error('counterfactual: agint.evolution service 不可用（queryFailures 缺失）');
    }

    const memory = ctx.get && typeof ctx.get === 'function' ? ctx.get('agint.memory') : null;

    const trajectory = input && Array.isArray(input.trajectory) ? input.trajectory : null;

    return counterfactualSimulate({
      failureId,
      modifiedStrategy,
      trajectory,
      evolution,
      memory,
    });
  }

  /**
   * `agint.diagnosis.cluster({ failureIds }) → Cluster[]`
   * 子任务 #5：substring 聚类（复用 evolution-memory.queryFailures）。
   * 软依赖 evolution；表满抛错（不静默）；只写 clusters 表；不写 failure_pattern。
   */
  async function cluster(input) {
    const failureIds = Array.isArray(input && input.failureIds) ? input.failureIds : null;
    const maxClusters = (input && typeof input.maxClusters === 'number') ? input.maxClusters : LIMITS.CLUSTERS;
    const evolution = ctx.get && typeof ctx.get === 'function' ? ctx.get('agint.evolution') : null;
    if (!evolution || typeof evolution.queryFailures !== 'function') {
      throw new Error('cluster: agint.evolution service 不可用（queryFailures 缺失）');
    }

    let allFailures;
    try { allFailures = await evolution.queryFailures({ limit: 1000 }); }
    catch (err) { throw new Error(`cluster: queryFailures 失败：${err && err.message ? err.message : String(err)}`); }
    if (!Array.isArray(allFailures)) allFailures = [];

    let candidates;
    if (failureIds && failureIds.length > 0) {
      const idSet = new Set(failureIds.filter((x) => typeof x === 'string' && x.length > 0));
      candidates = allFailures.filter((rec) => rec && idSet.has(rec.id));
    } else {
      const annoIds = await collectFailureIdsFromAnnotations(await t_annotations());
      candidates = allFailures.filter((rec) => rec && annoIds.has(rec.id));
    }

    const t = await t_clusters();
    const existingCount = t.entries().length;
    if (existingCount >= LIMITS.CLUSTERS) {
      throw new Error(`clusters table full (cap ${LIMITS.CLUSTERS})`);
    }

    const clusters = await aggregateClusters({ failurePatterns: candidates, evolution, maxClusters });
    const available = LIMITS.CLUSTERS - existingCount;
    if (clusters.length > available) {
      throw new Error(`clusters table full (cap ${LIMITS.CLUSTERS})`);
    }

    const written = [];
    for (const c of clusters) {
      const entry = packCluster(c);
      await t.put(entry.id, entry);
      written.push(unpackCluster(entry));
    }
    return written;
  }

  /**
   * `agint.diagnosis.report({ windowDays }) → DiagnosisReport`
   * 子任务 #5：window-based 聚合 + 写 reports 表 + 写 wiki/memory 钩子（容错）。
   * 软依赖 evolution（必填）/ wiki / memory；表满抛错；不写 failure_pattern。
   */
  async function report(input) {
    const windowDays = (input && typeof input.windowDays === 'number') ? input.windowDays : 7;
    const maxClusters = (input && typeof input.maxClusters === 'number') ? input.maxClusters : LIMITS.CLUSTERS;
    const evolution = ctx.get && typeof ctx.get === 'function' ? ctx.get('agint.evolution') : null;
    const wiki = ctx.get && typeof ctx.get === 'function' ? ctx.get('agint.wiki') : null;
    const memory = ctx.get && typeof ctx.get === 'function' ? ctx.get('agint.memory') : null;

    const tr = await t_reports();
    if (tr.entries().length >= LIMITS.REPORTS) {
      throw new Error(`reports table full (cap ${LIMITS.REPORTS})`);
    }

    const ta = await t_annotations();
    const annotations = [];
    for (const [, entry] of ta.entries()) annotations.push(entry);

    const reportData = await aggregateReport({ annotations, evolution, windowDays, maxClusters });
    const entry = packReport(reportData);
    await tr.put(entry.id, entry);

    // 副作用：写 wiki + memory 钩子（容错——失败不阻断 report 返回）
    const dateStr = (reportData.generatedAt || nowIso()).slice(0, 10);
    const wikiPath = `AGINT/diagnosis-report-${dateStr}.md`;
    const dist = reportData.rootCauseDistribution || {};
    const distLines = Object.entries(dist).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `- **${k}**: ${v}`).join('\n');
    const markdown = [
      `# Diagnosis Report — ${dateStr}`,
      '',
      `- windowDays: ${reportData.windowDays}`,
      `- generatedAt: ${reportData.generatedAt}`,
      `- annotationCount: ${reportData.annotationCount}`,
      `- clusterCount: ${reportData.clusterCount}`,
      '',
      '## rootCauseDistribution',
      '',
      distLines,
      '',
      '_来源：agint-diagnosis.report — 子任务 #5 落地（不调真 LLM）_',
    ].join('\n');

    if (wiki && typeof wiki.write === 'function') {
      try { await wiki.write(wikiPath, markdown); }
      catch (err) { console.warn(`[agint-diagnosis] wiki.write 失败：${err && err.message ? err.message : String(err)}`); }
    }
    if (memory && typeof memory.write === 'function') {
      const total = reportData.annotationCount || 0;
      const sorted = Object.entries(dist).sort((a, b) => b[1] - a[1]);
      const topName = sorted[0] ? sorted[0][0] : 'UNCERTAIN';
      const topCount = sorted[0] ? sorted[0][1] : 0;
      const summary = `Sprint 7 diagnosis report windowDays=${reportData.windowDays} annotations=${total} top=${topName}=${topCount}`;
      try {
        await memory.write({
          type: 'pattern',
          content: summary,
          level: 'L1',
          confidence: 0.5,
          evidence: `report ${entry.id} generatedAt=${reportData.generatedAt}`,
        });
      } catch (err) { console.warn(`[agint-diagnosis] memory.write 失败：${err && err.message ? err.message : String(err)}`); }
    }

    // ── Sprint 12 / A6 — T1 影子期：publish diagnosis.completed ────────────
    // 红线（AGENTS.md / A6）：
    //   - 单 service 接口 ctx.get('agint.eventBus.publish')（不用伞键）
    //   - 软降级：bus 不可用静默；不阻断 unpackReport 返回
    //   - report 主路径完整保留（unpackReport 在 publish 之后调用，确保业务流不切）
    // payload schema：plugins/agint-diagnosis/schemas/diagnosis-completed.schema.yaml v1
    const p = (typeof ctx.get === 'function') ? ctx.get('agint.eventBus.publish') : null;
    if (typeof p === 'function') {
      try {
        await p({
          topic: 'diagnosis.completed',
          version: 1,
          source: 'agint-diagnosis',
          payload: {
            reportId: entry.id,
            targetIds: Array.isArray(reportData.targetIds) ? reportData.targetIds : [],
            rootCauseDistribution: reportData.rootCauseDistribution || {},
            clusterCount: reportData.clusterCount ?? 0,
            evaluatedAt: reportData.generatedAt || nowIso(),
          },
        });
      } catch (e) {
        if (!disposed) console.error('[agint-diagnosis] publish failed:', e?.message ?? e);
      }
    }

    return unpackReport(entry);
  }

  // ── Sprint 12 / A3 — T1 影子期：async 订阅 sandbox.failed → analyzeFailedSmoke ──
  // 不进入 FROZEN Service 列表；软依赖 eventBus，subscribe 失败 log 不抛。
  // 输出写到 agint_diagnosis.annotations 表（与 annotate 一致路径）。
  let _sandboxFailedUnsubscribe = null;
  try {
    const subscribe = typeof ctx.get === 'function' ? ctx.get('agint.eventBus.subscribe') : null;
    if (subscribe && typeof subscribe === 'function') {
      _sandboxFailedUnsubscribe = subscribe(
        {
          subscriber: 'agint-diagnosis',
          topics: ['sandbox.failed'],
          mode: 'async',
          timeoutMs: 5000,
        },
        async (env) => {
          try {
            await analyzeFailedSmoke(env?.payload ?? {});
          } catch (err) {
            if (!disposed) console.error('[agint-diagnosis] analyzeFailedSmoke failed:', err?.message ?? err);
          }
        },
      );
    }
  } catch (err) {
    if (!disposed) console.error('[agint-diagnosis] eventBus.subscribe(sandbox.failed) failed:', err?.message ?? err);
  }

  /**
   * Sprint 12 / A3 — analyzeFailedSmoke(payload) → { rootCause, confidence, evidence }
   *
   * 输入来自 sandbox.failed 事件的 payload：
   *   { target, mode, reason, failedChecks, durationMs }
   *
   * 输出：根因候选（启发式 v1；规则版，可直接进 FROZEN schema）
   *   - reason 关键词 → RootCauseKind 映射（planner / env-shift / tool-gap / reasoning-error）
   *   - failedChecks 名称 → 补充证据（加入 evidence 数组）
   *   - confidence：reason 命中 + 1，failedChecks 长度 > 0 + 0.1，封顶 0.95
   *
   * 写表：annotations（与 annotate 共用路径）；rootCause 必为 RootCauseKindSchema enum 之一。
   */
  async function analyzeFailedSmoke(payload) {
    const reason = String(payload?.reason ?? 'unknown');
    const failed = Array.isArray(payload?.failedChecks) ? payload.failedChecks : [];
    const targetPath = String(payload?.target?.path ?? '');

    // ── reason → rootCause 启发式映射（v1）───────────────────────────
    // 枚举对齐 RootCauseKindSchema：reasoning-error / tool-gap / knowledge-gap /
    //                            planning-failure / environment-shift / prompt-deficiency /
    //                            uncertain
    let rootCause = 'uncertain';
    let matchedRule = null;
    const reasonLower = reason.toLowerCase();
    if (reasonLower.includes('timeout') || reasonLower.includes('memory')) {
      rootCause = 'environment-shift';
      matchedRule = 'reason:env-shift(memory-or-timeout)';
    } else if (reasonLower.includes('import') || reasonLower.includes('exports') || reasonLower.includes('package-json')) {
      rootCause = 'tool-gap';
      matchedRule = 'reason:tool-gap(import-or-export-shape)';
    } else if (reasonLower.includes('network') || reasonLower.includes('dns')) {
      rootCause = 'environment-shift';
      matchedRule = 'reason:env-shift(network)';
    } else if (reasonLower.includes('plugin-not-found') || reasonLower.includes('package-json-missing')) {
      rootCause = 'planning-failure';
      matchedRule = 'reason:planning-failure(missing-artifact)';
    } else if (reasonLower.includes('unparseable-stdout') || reasonLower.includes('confine')) {
      rootCause = 'prompt-deficiency';
      matchedRule = 'reason:prompt-deficiency(runtime-misconfig)';
    } else if (reasonLower.includes('smoke-failed')) {
      // smoke-failed 是兜底 reason——按 failedChecks 进一步细分
      const names = failed.map((f) => String(f?.name ?? '').toLowerCase());
      if (names.some((n) => n.includes('plugin-exports') || n.includes('plugin-import'))) {
        rootCause = 'tool-gap';
        matchedRule = 'reason:smoke-failed+checks:plugin-shape';
      } else if (names.some((n) => n.includes('no-external-network'))) {
        rootCause = 'environment-shift';
        matchedRule = 'reason:smoke-failed+checks:network';
      } else {
        rootCause = 'reasoning-error';
        matchedRule = 'reason:smoke-failed+checks:unknown-shape';
      }
    }

    // ── failedChecks 名称 → 证据补强 ───────────────────────────────
    const evidence = [];
    if (matchedRule) evidence.push(matchedRule);
    for (const fc of failed.slice(0, 5)) {
      evidence.push(`check:${fc?.name ?? 'unknown'}:${String(fc?.detail ?? '').slice(0, 80)}`);
    }

    // ── confidence 计算（启发式）───────────────────────────────────
    let confidence = 0.5;
    if (matchedRule) confidence += 0.2;
    if (failed.length > 0) confidence += 0.1;
    if (failed.length >= 3) confidence += 0.1;
    confidence = Math.min(confidence, 0.95);

    // ── 写 annotations 表（不阻塞；cold-start 不强制；reasoning-error 写一条说明）──
    let written = false;
    let writeError = null;
    try {
      const tbl = await t_annotations();
      const id = `sandbox-failed-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const entry = packAnnotation({
        id,
        failureId: targetPath || reason,
        rootCause,
        confidence,
        evidence,
        generatedAt: nowIso(),
        source: 'sandbox.failed',
      });
      await tbl.put(id, entry);
      written = true;
    } catch (err) {
      writeError = err?.message ?? String(err);
    }

    return {
      rootCause,
      confidence,
      evidence,
      targetPath,
      reason,
      written,
      writeError,
    };
  }

  // 提供 4 个 Service + 1 个 stats（stats 不在 FROZEN 列表内，仅 host-side
  // dashboard / smoke 用；model 平面不可见）。
  ctx.provide('agint.diagnosis.annotate', annotate);
  ctx.provide('agint.diagnosis.counterfactual', counterfactual);
  ctx.provide('agint.diagnosis.cluster', cluster);
  ctx.provide('agint.diagnosis.report', report);
  ctx.provide('agint.diagnosis.stats', stats);
  // Sprint 12 / A3: 暴露 analyzeFailedSmoke 供 host-side / 测试调用
  ctx.provide('agint.diagnosis.analyzeFailedSmoke', analyzeFailedSmoke);

  // 暴露调参 / 守门接口（host-side，不进 model 工具）
  ctx.provide('agint.diagnosis.checkLimit', checkLimit);
  ctx.provide('agint.diagnosis.limits', LIMITS);

  // 暴露 pack/unpack helpers（host-side，后续算法实现要复用）
  ctx.provide('agint.diagnosis.io', {
    packAnnotation,
    packCluster,
    packReport,
    unpackAnnotation,
    unpackCluster,
    unpackReport,
    schemas: {
      Annotation: annotationEntrySchema,
      Cluster: clusterEntrySchema,
      Report: reportEntrySchema,
    },
  });
}

export {
  Config,
  apply,
  inject,
  name,
  // 重新导出 FROZEN schemas 方便 host-side 算法实现引用
  AnnotationSchema,
  ClusterSchema,
  DiagnosisReportSchema,
  RootCauseKindSchema,
  LIMITS,
};
