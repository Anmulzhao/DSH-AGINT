/**
 * agint-skill-autocreate — P0-1 技能自动创建机制（Sprint 14 检测层 + Sprint 15 评估层）。
 *
 * Service：`agint.skillAutocreate`（设计稿 §5.1）。
 * 存储域：`agint_skill_autocreate`（5 表，设计稿 §4.1，与既有域互斥）。
 *
 * Sprint 14（设计稿 §12.1）：
 *   - detect()：读 tool-stats JSONL → 聚合任务实例 → 模式检测 → 重复模式
 *     跨阈值后生成技能候选提案（纯模板，零 LLM）
 *   - 只检测 + 生成候选：不调 D-QAF、不发布（Sprint 15 接力 triggerEval）
 *
 * Sprint 15（P0-1 评估层，设计稿 §5/§6/§7，用户 2026-09-08 拍板 §12）：
 *   - triggerEval()：A 路径分流评估（Phase 1 静态准入 → Phase 2 沙箱门 →
 *     Phase 3 硬门+排序），复用 D-QAF 执行层但不复用综合分决策（§3 语义错配）
 *   - T1 staging 物化 / T2 quality-static 四族 checker / T5 去重 / T6 事件+工具 /
 *     T7 evolution 写 phase3-provisional / T8 回归验收（71.4 不死锁）
 *
 * Sprint 16（P0-1 发布层，设计稿 §3，用户 2026-09-09 拍板 3 项）：
 *   - release/releaseQueue/rollback/observe/listReleases（lib/release-manager.js）
 *   - 三道门（总开关/人工确认窗/policy 门/周预算）→ 原子落盘 skills_root →
 *     14 天观察期（0 调用三重确认自动回滚）→ STABLE；回滚只归档不删除+30 天冷却
 *
 * 事件：skill-autocreate.pattern-detected / candidate-created /
 *   phase1-passed / phase1-rejected / phase2-passed / phase2-rejected /
 *   phase3-passed / phase3-rejected（软依赖 event-bus，不可用时降级为仅写
 *   audit_log）
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import {
  ConfigSchema,
  RUNTIME_CONFIG_KEYS,
  isSelfReferential,
} from './schema.js';
import {
  spec,
  checkLimit,
  LIMITS,
  packTaskPattern,
  packCandidate,
  packAudit,
  nowIso,
  datedId,
  proposalEntrySchema,
} from './storage.js';
import { aggregateTasks, filterWindow } from './aggregator.js';
import { detectPatterns } from './detector.js';
import { judgeStandardizable } from './standardizable.js';
import { buildProposal } from './proposer.js';
import { evaluateCandidate } from './evaluator.js';
import { isDuplicate } from './similarity.js';
import { cleanupCandidate, cleanupStale, stagingRootFor } from './staging.js';
import { createReleaseManager } from './release-manager.js';

const name = 'agint-skill-autocreate';
// storageDomain 硬依赖；tools 在宿主不注册 model 工具（preset 平面经 lib/tools.js）
const inject = ['storageDomain'];

function apply(ctx, config) {
  const cfg = ConfigSchema.parse(config ?? {});
  let domain = null;
  let domainError = null;
  let disposed = false;
  let paused = false;                       // §8.2 运行时开关（内存态，重启还原）
  const runtimeOverrides = new Map();       // §8.2 可运行时修改的配置子集

  // lifecycle：disposer 关 domain（AGENTS.md 挂载红线）
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
    if (disposed) throw new Error('agint-skill-autocreate: disposed');
    if (domainError) throw domainError;
    const d = await ready;
    if (!d) throw new Error('agint-skill-autocreate: domain unavailable');
    return d.table(tableName);
  };

  const effectiveConfig = () => {
    const merged = { ...cfg };
    for (const [k, v] of runtimeOverrides) merged[k] = v;
    return merged;
  };

  // ── 事件发布（软依赖 event-bus，降级不抛）──────────────────────────────
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

  // ── agint-diagnosis 软依赖（[4] 轨道 A）────────────────────────────────
  //
  // 仅当 diagnosis 服务暴露 `classify(trajectory)` 时轨道 A 才可用。
  // 现状（agint-diagnosis v0.6.0）：只暴露 annotate/counterfactual，且都要求
  // failureId（必须存在于 failure_pattern 表）。重复成功模式既无 failureId
  // 也无失败证据 → 轨道 A 实际不激活，全部走启发式轨道 B。
  // 激活条件：aggregator 开始聚合 errorKind 后，在 detect() 里把失败步传给
  // judgeStandardizable 的 failureEvidence，并在 diagnosis 侧暴露 classify。
  function diagnosisSvc() {
    const d = typeof ctx.get === 'function' ? ctx.get('agint.diagnosis') : null;
    if (!d || typeof d.classify !== 'function') return null;
    return { classify: (trajectory) => d.classify(trajectory) };
  }

  // ── audit（唯一自动滚动清理的表：>1000 条删最旧）───────────────────────
  async function audit(entry) {
    const t = await table('audit_log');
    const record = packAudit(entry);
    await t.put(record.id, record);
    const entries = t.entries();
    const warn = checkLimit('audit_log', entries.length);
    if (warn) {
      // 滚动清理：保留最近 LIMITS.AUDIT_LOG 条（按 timestamp 升序删最旧）
      const overflow = entries.length - warn.limit;
      if (overflow > 0) {
        const del = delOf(t);
        const sorted = [...entries].sort((a, b) => String(a[1].timestamp).localeCompare(String(b[1].timestamp)));
        for (const [key] of sorted.slice(0, overflow)) {
          await del(key).catch(() => {});
        }
      }
    }
    return record;
  }

  // 通用删除兜底（storage 域 API 若无 del，退化处理）
  function delOf(t) {
    return typeof t.del === 'function'
      ? (key) => t.del(key)
      : (key) => Promise.reject(new Error('audit_log prune: table API has no del'));
  }

  // ── 读 tool-stats JSONL（设计稿 §10.1：读文件，不重复采集）─────────────
  async function readToolStatsRecords() {
    const jsonlPath = resolvePath(effectiveConfig().jsonlPath);
    try { await stat(jsonlPath); } catch { return []; }
    try {
      const text = await readFile(jsonlPath, 'utf8');
      const out = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }
      return out;
    } catch {
      return [];
    }
  }

  // ── 核心流程：检测 → 候选生成（§3.1 [2]-[5]）──────────────────────────
  async function detect(args = {}) {
    const c = effectiveConfig();
    if (args.force !== true && paused) {
      return { skipped: true, reason: 'paused (autocreate_pause)' };
    }

    const windowHours = args.windowHours ?? c.aggregate_window_hours;
    const records = filterWindow(await readToolStatsRecords(), windowHours);
    const { tasks, unmatched, excluded } = aggregateTasks(records);

    const tp = await table('task_patterns');
    const existing = [...tp.entries()].map(([, v]) => v);
    const { upserts, newRepeat, blockedBySuccessRate } = detectPatterns(tasks, {
      existingPatterns: existing,
      minOccurrence: c.min_occurrence_count,
      similarityThreshold: c.param_similarity_threshold,
      minSuccessRate: c.min_pattern_success_rate,
      nowIso: nowIso(),
    });

    // 上限 warn（不 prune，设计稿 §4.2）
    const limitWarn = checkLimit('task_patterns', existing.length + upserts.filter((p) => !p.id).length);

    // 回写 patterns
    const idOf = new Map(existing.map((p) => [p.id, p.id]));
    const upserted = [];
    for (const p of upserts) {
      const business = { ...p };
      let id = business.id;
      if (!id || !idOf.has(id)) {
        // 新 pattern：pack 生成 id
        const packed = packTaskPattern(business, null);
        await tp.put(packed.id, packed);
        upserted.push(packed);
        idOf.set(packed.id, packed.id);
        business.id = packed.id;
      } else {
        const packed = packTaskPattern(business, existing.find((e) => e.id === id));
        await tp.put(id, packed);
        upserted.push(packed);
      }
    }

    // ── 成功率门拦下的模式（2026-09-13）──────────────────────────────────
    // 照常入库、照常留痕，但**不**发 pattern-detected、**不**生成候选。
    // 稳定失败的模式恰恰是最该被看见的（说明有工具或流程坏了），只是不该
    // 被固化成技能——所以走审计而不是静默丢弃，供周复盘/人工复核扫。
    let successRateBlocked = 0;
    for (const pattern of blockedBySuccessRate) {
      const blockedStored = upserted.find(
        (u) => u.toolSequence.join('>') === pattern.toolSequence.join('>'),
      );
      if (!blockedStored) continue;
      successRateBlocked++;
      await audit({
        actor: 'system',
        action: 'pattern_blocked_low_success',
        targetType: 'task_pattern',
        targetId: blockedStored.id,
        details: {
          occurrenceCount: blockedStored.occurrenceCount,
          successRate: blockedStored.successRate,
          minSuccessRate: c.min_pattern_success_rate,
          toolSequence: blockedStored.toolSequence,
        },
      });
    }

    // 跨过重复门槛的 pattern → 发事件 + [4] 判定 + 尝试生成候选
    let candidatesCreated = 0;
    let standardizableJudged = 0;
    let standardizablePass = 0;
    let standardizableReject = 0;
    let standardizableUncertain = 0;
    const candidateIds = [];
    for (const pattern of newRepeat) {
      // newRepeat 里的对象是 detector 工作副本，需要回查已入库形态拿 id
      let stored = upserted.find(
        (u) => u.toolSequence.join('>') === pattern.toolSequence.join('>'),
      );
      if (!stored) continue;

      await publishEvent('skill-autocreate.pattern-detected', {
        patternId: stored.id,
        toolSequence: stored.toolSequence,
        occurrenceCount: stored.occurrenceCount,
      });
      await audit({
        actor: 'system',
        action: 'pattern_detected',
        targetType: 'task_pattern',
        targetId: stored.id,
        details: { occurrenceCount: stored.occurrenceCount, toolSequence: stored.toolSequence },
      });

      // ── [4] 可标准化判断（设计稿 §3.1；2026-09-09 补齐）────────────────
      // 判定结果**无论通过与否都回写 pattern**——周复盘/人工复核直接扫
      // task_patterns.standardizable 即可，不依赖审计日志。
      const verdict = judgeStandardizable(stored, {
        minSteps: c.standardizable_min_steps,
        minDistinctTools: c.standardizable_min_distinct_tools,
        minConfidence: c.min_standardizable_confidence,
        diagnosis: c.standardizable_route === 'off' ? null : diagnosisSvc(),
        // 轨道 A 的输入：聚合层目前只落 successRate，不聚合 errorKind，
        // 因此恒为 null → 轨道 A 不激活（见 lib/standardizable.js 文件头）。
        failureEvidence: null,
      });
      standardizableJudged++;
      if (verdict.standardizable === true) standardizablePass++;
      else if (verdict.standardizable === false) standardizableReject++;
      else standardizableUncertain++;

      stored = packTaskPattern({
        ...stored,
        standardizable: verdict.standardizable,
        standardizableConfidence: verdict.confidence,
      }, stored);
      await tp.put(stored.id, stored);

      if (verdict.standardizable !== true) {
        await audit({
          actor: 'system',
          action: verdict.standardizable === null
            ? 'standardizable_uncertain'     // → 需人工判断，写周复盘
            : 'standardizable_rejected',     // → 明确不可标准化
          targetType: 'task_pattern',
          targetId: stored.id,
          details: {
            reason: verdict.reason,
            route: verdict.route,
            rootCause: verdict.rootCause,
            signals: verdict.signals,
            toolSequence: stored.toolSequence,
          },
          reason: verdict.reason,
        });
        continue;
      }

      // ── 候选生成守门（Sprint 14 只做：总开关 + 暂停 + 去重 + 自我指涉）──
      if (!c.auto_create_enabled) continue;
      if (stored.linkedCandidateId) continue;      // 已有候选，不重复生成
      if (stored.status !== 'active') continue;    // dismissed 等状态不复活

      const proposal = buildProposal(stored);
      if (!proposal) {
        await audit({
          actor: 'system',
          action: 'candidate_skipped',
          targetType: 'task_pattern',
          targetId: stored.id,
          details: { reason: 'no matching template or self-referential' },
        });
        continue;
      }

      const cd = await table('candidates');
      const candWarn = checkLimit('candidates', cd.entries().length);
      if (candWarn) console.warn(`[${name}] ${candWarn._warn}`);

      const candidate = packCandidate({
        sourcePatternId: stored.id,
        source: 'auto',
        triggerEvent: args.triggerEvent ?? 'daily-aggregate',
        skillDraft: proposal.skillDraft,
        estimatedBenefit: proposal.estimatedBenefit,
        status: 'PENDING_EVAL',
        evalResults: {},
        rejectionReason: null,
        releasedAt: null,
        releasedVersion: null,
        rollbackReason: null,
      });
      await cd.put(candidate.id, candidate);
      candidatesCreated++;
      candidateIds.push(candidate.id);

      // pattern 标记为 candidate 并回链
      const updatedPattern = packTaskPattern(
        { ...stored, status: 'candidate', linkedCandidateId: candidate.id },
        stored,
      );
      await tp.put(updatedPattern.id, updatedPattern);

      await publishEvent('skill-autocreate.candidate-created', {
        candidateId: candidate.id,
        skillName: proposal.skillDraft.name,
        estimatedBenefit: proposal.estimatedBenefit,
      });
      await audit({
        actor: 'system',
        action: 'candidate_created',
        targetType: 'candidate',
        targetId: candidate.id,
        details: {
          sourcePatternId: stored.id,
          skillName: proposal.skillDraft.name,
          template: proposal.skillDraft.template,
          estimatedBenefit: proposal.estimatedBenefit,
        },
      });
    }

    return {
      windowHours,
      records: records.length,
      tasks: tasks.length,
      unmatched,
      excluded,   // D2：被排除的 curriculum 挑战调用数
      patternsUpserted: upserted.length,
      newRepeatPatterns: newRepeat.length,
      successRateBlocked,   // 2026-09-13：跨过次数门槛但成功率不达标的
      standardizable: {
        judged: standardizableJudged,
        pass: standardizablePass,
        rejected: standardizableReject,
        uncertain: standardizableUncertain,
      },
      candidatesCreated,
      candidateIds,
      limitWarn: limitWarn?._warn ?? null,
    };
  }

  // Sprint 16 发布层（设计稿 §3；createReleaseManager 依赖注入，见 lib/release-manager.js）
  const releaseManager = createReleaseManager({
    table,
    audit,
    publishEvent,
    cfg: effectiveConfig,
    getService: (key) => (typeof ctx.get === 'function' ? ctx.get(key) : null),
    readToolStatsRecords,
    dshHome: process.env.DSH_HOME || (process.env.HOME + '/.dsh'),
  });

  // ── Service 出口（设计稿 §5.1）─────────────────────────────────────────

  async function listPatterns(args = {}) {
    const t = await table('task_patterns');
    let list = [...t.entries()].map(([, v]) => v);
    if (args.status) list = list.filter((p) => p.status === args.status);
    if (args.repeatedOnly) list = list.filter((p) => p.occurrenceCount >= effectiveConfig().min_occurrence_count);
    list.sort((a, b) => b.occurrenceCount - a.occurrenceCount || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    if (args.limit) list = list.slice(0, args.limit);
    return list;
  }

  async function listCandidates(args = {}) {
    const t = await table('candidates');
    let list = [...t.entries()].map(([, v]) => v);
    if (args.status) list = list.filter((p) => p.status === args.status);
    // T6：按评估证据级别 / provisional 标记过滤（评估层增强）
    if (args.evidenceLevel) list = list.filter((p) => p.evalResults?.phase3?.evidenceLevel === args.evidenceLevel);
    if (args.provisional === true) list = list.filter((p) => p.evalResults?.phase3?.provisional === true);
    list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (args.limit) list = list.slice(0, args.limit);
    return list;
  }

  async function getCandidate(id) {
    if (!id) throw new Error('getCandidate: id is required');
    const t = await table('candidates');
    const found = t.entries().find(([key]) => key === id);
    return found ? found[1] : null;
  }

  /** 人工拒绝候选（§5.1 rejectCandidate） */
  async function rejectCandidate(input = {}) {
    const id = input.id;
    const reason = input.reason ?? '';
    if (!id) throw new Error('rejectCandidate: id is required');
    if (!reason) throw new Error('rejectCandidate: reason is required');
    const t = await table('candidates');
    const found = t.entries().find(([key]) => key === id);
    if (!found) throw new Error(`rejectCandidate: no candidate '${id}'`);
    const updated = { ...found[1], status: 'REJECTED_STATIC', rejectionReason: reason };
    await t.put(id, updated);
    // 解除 pattern 回链，允许未来重新提案（人工否决记录在案）
    const tp = await table('task_patterns');
    const patEntry = tp.entries().find(([, v]) => v.linkedCandidateId === id);
    if (patEntry) {
      const dismissed = packTaskPattern({ ...patEntry[1], status: 'dismissed', linkedCandidateId: null }, patEntry[1]);
      await tp.put(dismissed.id, dismissed);
    }
    await audit({
      actor: input.actor ?? 'human',
      action: 'human_rejected',
      targetType: 'candidate',
      targetId: id,
      details: {},
      reason,
    });
    return updated;
  }

  /** 人工修改候选草稿（§5.1 modifyCandidate） */
  async function modifyCandidate(input = {}) {
    const id = input.id;
    if (!id) throw new Error('modifyCandidate: id is required');
    if (!input.skillDraft || typeof input.skillDraft !== 'object') {
      throw new Error('modifyCandidate: skillDraft is required');
    }
    if (isSelfReferential(input.skillDraft.name, input.skillDraft.description)) {
      throw new Error('modifyCandidate: self-referential skill drafts are forbidden (设计稿 §9.4)');
    }
    const t = await table('candidates');
    const found = t.entries().find(([key]) => key === id);
    if (!found) throw new Error(`modifyCandidate: no candidate '${id}'`);
    // Sprint 16（设计稿 §6）：发布前修改 → 回 PENDING_EVAL 重跑评估
    //（防人工改动引入未经 Phase 1-3 评估的内容直接挂载）
    let status = found[1].status;
    if (status === 'QUEUED_FOR_RELEASE' || status === 'BUDGET_WAIT') {
      status = 'PENDING_EVAL';
    }
    const updated = { ...found[1], skillDraft: input.skillDraft, status };
    await t.put(id, updated);
    await audit({
      actor: input.actor ?? 'human',
      action: 'human_modified',
      targetType: 'candidate',
      targetId: id,
      details: { fields: Object.keys(input.skillDraft) },
    });
    return updated;
  }

  // ── T4/T5/T6/T7：评估层入口（设计稿 §5.2/§6）───────────────────────────
  // 状态机：PENDING_EVAL → (Phase1) → PHASE1_PASS / REJECTED_STATIC
  //                    → (Phase2) → PHASE2_PASS / REJECTED_SANDBOX（skipped 不标 pass）
  //                    → (Phase3) → PHASE3_PASS / REJECTED_EVAL（可重试，超限转人工）
  // A 路径决策：硬门（Phase1 无 blocker ∧ Phase2 未失败）+ rankingScore 排序，
  // **不消费 D-QAF 综合分**（§3 语义错配，T8 防 71.4 死锁回归）。
  async function triggerEval(input = {}) {
    const id = input.id;
    if (!id) throw new Error('triggerEval: id is required');
    const actor = input.actor ?? 'system';
    const c = effectiveConfig();
    const dshHome = process.env.DSH_HOME || (process.env.HOME + '/.dsh');

    const cd = await table('candidates');
    const found = cd.entries().find(([key]) => key === id);
    if (!found) throw new Error(`triggerEval: no candidate '${id}'`);
    const candidate = found[1];

    if (candidate.status !== 'PENDING_EVAL') {
      throw new Error(`triggerEval: candidate '${id}' is ${candidate.status}（仅 PENDING_EVAL 可评估）`);
    }

    // T5：去重（与现有技能 list() 比对 ≥ dedup_similarity_threshold → 拒）
    const skillsSvc = typeof ctx.get === 'function' ? ctx.get('skills') : null;
    let existingNames = [];
    if (skillsSvc && typeof skillsSvc.list === 'function') {
      try {
        const list = await skillsSvc.list();
        existingNames = (Array.isArray(list) ? list : []).map((s) => s?.name ?? '').filter(Boolean);
      } catch { /* skills service 不可用 → 跳过去重（不阻断） */ }
    }
    const dup = isDuplicate(candidate.skillDraft.name, existingNames, c.dedup_similarity_threshold);
    if (dup.duplicate) {
      const reason = `去重：与现有技能 "${dup.matchedName}" 相似度 ${dup.similarity.toFixed(2)} ≥ ${c.dedup_similarity_threshold}`;
      const updated = { ...candidate, status: 'REJECTED_STATIC', rejectionReason: reason };
      await cd.put(id, updated);
      await publishEvent('skill-autocreate.phase1-rejected', {
        candidateId: id, phase: 1, reason: 'dedup',
        detail: reason, matchedName: dup.matchedName, similarity: dup.similarity,
      });
      await audit({
        actor, action: 'eval_rejected_dedup', targetType: 'candidate', targetId: id,
        details: { matchedName: dup.matchedName, similarity: dup.similarity, threshold: c.dedup_similarity_threshold },
        reason,
      });
      return { candidateId: id, finalStatus: 'REJECTED_STATIC', rejected: 'dedup', similarity: dup.similarity, matchedName: dup.matchedName };
    }

    // T4：尝试上限（超限转人工，保持 PENDING_EVAL）/ 冷却期
    const attempts = candidate.evalAttempts ?? 0;
    if (attempts >= c.max_eval_attempts) {
      await audit({
        actor, action: 'eval_attempts_exhausted', targetType: 'candidate', targetId: id,
        details: { attempts, max: c.max_eval_attempts },
        reason: `转人工（保持 PENDING_EVAL，${attempts}/${c.max_eval_attempts}）`,
      });
      return { candidateId: id, skipped: true, reason: `eval_attempts_exhausted ${attempts}/${c.max_eval_attempts}，转人工` };
    }
    if (candidate.cooldownUntil && candidate.cooldownUntil > nowIso()) {
      return { candidateId: id, skipped: true, reason: `cooldown until ${candidate.cooldownUntil}` };
    }

    // 关联 pattern（rankingScore 的模式频次来源）
    const tp = await table('task_patterns');
    const patEntry = tp.entries().find(([, v]) => v.id === candidate.sourcePatternId);
    const pattern = patEntry ? patEntry[1] : {};

    // 依赖服务（evolution 可缺失降级，其余必需）
    const services = {
      qualityStatic: typeof ctx.get === 'function' ? ctx.get('agint.qualityStatic') : null,
      qualitySandbox: typeof ctx.get === 'function' ? ctx.get('agint.qualitySandbox') : null,
      qualityEvaluator: typeof ctx.get === 'function' ? ctx.get('agint.qualityEvaluator') : null,
      evolution: typeof ctx.get === 'function' ? ctx.get('agint.evolution') : null,
    };
    for (const key of ['qualityStatic', 'qualitySandbox', 'qualityEvaluator']) {
      if (!services[key]) throw new Error(`triggerEval: 依赖服务 ${key} 未挂载`);
    }

    // T1+T3：物化 + 三阶段评估
    const result = await evaluateCandidate({ candidate, pattern, services, cfg: c, dshHome });
    const base = { ...candidate, evalResults: result.evalResults, evalAttempts: attempts + 1 };
    const reasonFor = (f) => f?.message ?? '';

    // ── 状态机持久化 + 事件（§6.1/§6.2）────────────────────────────────
    if (result.finalStatus === 'REJECTED_STATIC') {
      const updated = { ...base, status: 'REJECTED_STATIC', rejectionReason: reasonFor(result.blockers?.[0]) };
      await cd.put(id, updated);
      await publishEvent('skill-autocreate.phase1-rejected', {
        candidateId: id, phase: 1, reason: 'static-blocker',
        detail: updated.rejectionReason, families: result.evalResults.phase1?.families ?? [],
      });
      await audit({
        actor, action: 'eval_rejected_static', targetType: 'candidate', targetId: id,
        details: { families: result.evalResults.phase1?.families, findings: result.evalResults.phase1?.findings?.length },
        reason: updated.rejectionReason,
      });
      return { candidateId: id, finalStatus: updated.status, rejectionReason: updated.rejectionReason, evalResults: result.evalResults };
    }

    if (result.evalResults.phase1?.status === 'pass') {
      const mid1 = { ...base, status: 'PHASE1_PASS' };
      await cd.put(id, mid1);
      await publishEvent('skill-autocreate.phase1-passed', {
        candidateId: id, families: result.evalResults.phase1?.families ?? [],
      });
    }

    if (result.finalStatus === 'REJECTED_SANDBOX') {
      const updated = { ...base, status: 'REJECTED_SANDBOX', rejectionReason: (result.evalResults.phase2?.detail ?? '').slice(0, 300) };
      await cd.put(id, updated);
      await publishEvent('skill-autocreate.phase2-rejected', {
        candidateId: id, phase: 2, reason: 'sandbox-failed',
        detail: updated.rejectionReason, exitCode: result.evalResults.phase2?.exitCode,
      });
      await audit({
        actor, action: 'eval_rejected_sandbox', targetType: 'candidate', targetId: id,
        details: { exitCode: result.evalResults.phase2?.exitCode }, reason: updated.rejectionReason,
      });
      return { candidateId: id, finalStatus: updated.status, rejectionReason: updated.rejectionReason, evalResults: result.evalResults };
    }

    if (result.evalResults.phase2?.status === 'pass') {
      const mid2 = { ...base, status: 'PHASE2_PASS' };
      await cd.put(id, mid2);
      await publishEvent('skill-autocreate.phase2-passed', { candidateId: id });
    }

    if (result.finalStatus === 'REJECTED_EVAL') {
      // 非终态：保持 PENDING_EVAL，attempts+1，进入冷却期（可重试，超限转人工）
      const cooldownUntil = new Date(Date.now() + c.eval_cooldown_days * 24 * 60 * 60 * 1000).toISOString();
      const updated = { ...base, status: 'PENDING_EVAL', cooldownUntil };
      await cd.put(id, updated);
      await publishEvent('skill-autocreate.phase3-rejected', {
        candidateId: id, phase: 3, reason: 'evaluator-error',
        detail: result.evalResults.phase3?.reason, attempts: updated.evalAttempts,
      });
      await audit({
        actor, action: 'eval_failed_retry', targetType: 'candidate', targetId: id,
        details: { attempts: updated.evalAttempts, max: c.max_eval_attempts, cooldownUntil },
        reason: result.evalResults.phase3?.reason,
      });
      return {
        candidateId: id, finalStatus: 'PENDING_EVAL', retryable: true,
        attempts: updated.evalAttempts, cooldownUntil, reason: result.evalResults.phase3?.reason,
      };
    }

    // ── 评估通过：候选进入发布队列（§7.2）+ proposals 表写入 + TTL 清理兜底 ──
    // B 闭环第三断点修复（2026-09-13）：候选此前停在 PHASE3_PASS，但 releaseQueue /
    // releaseCandidate 只认 candidates 表的 QUEUED_FOR_RELEASE / BUDGET_WAIT（见
    // release-manager.js L348 守卫 / L464 过滤），PHASE3_PASS 是没人消费的死状态 →
    // 闭环在「评估→发布」间断掉。此处把候选终态直接置为 QUEUED_FOR_RELEASE（与
    // proposal 同态），triggerEval 之后 evaluateQueue→releaseQueue 才能真正接走候选。
    const finalStatus = 'QUEUED_FOR_RELEASE';
    const updated = { ...base, status: finalStatus, rejectionReason: null };
    await cd.put(id, updated);
    await publishEvent('skill-autocreate.phase3-passed', {
      candidateId: id,
      rankingScore: result.rankingScore,
      evidenceLevel: result.evidenceLevel,
      provisional: result.provisional,
      composite: result.evalResults.phase3?.composite,
    });

    const proposal = proposalEntrySchema.parse({
      id: datedId('prop'),
      kind: 'skill_proposal',
      createdAt: nowIso(),
      candidateId: id,
      skillDraft: candidate.skillDraft,
      evalResults: result.evalResults,
      rankingScore: result.rankingScore,
      evidenceLevel: result.evidenceLevel,
      provisional: result.provisional,
      status: 'QUEUED_FOR_RELEASE',
      estimatedBenefit: candidate.estimatedBenefit,
    });
    const pt = await table('proposals');
    const propWarn = checkLimit('proposals', pt.entries().length);
    if (propWarn) console.warn(`[${name}] ${propWarn._warn}`);
    await pt.put(proposal.id, proposal);

    await audit({
      actor, action: 'eval_passed_provisional', targetType: 'candidate', targetId: id,
      details: {
        rankingScore: result.rankingScore, evidenceLevel: result.evidenceLevel,
        composite: result.evalResults.phase3?.composite, compositeTrusted: false,
        proposalId: proposal.id,
      },
      reason: 'Phase3 硬门通过，provisional 待 Sprint 16 观察期',
    });

    // TTL 兜底清理（终态后 7 天；顺路执行，无独立 cron）
    const cleaned = await cleanupStale({ dshHome, ttlDays: c.staging_ttl_days });
    if (cleaned.removed.length) console.warn(`[${name}] staging TTL cleaned: ${cleaned.removed.join(', ')}`);

    return {
      candidateId: id,
      finalStatus,
      rankingScore: result.rankingScore,
      evidenceLevel: result.evidenceLevel,
      provisional: result.provisional,
      composite: result.evalResults.phase3?.composite,
      compositeTrusted: false,
      proposalId: proposal.id,
      evalResults: result.evalResults,
    };
  }

  // Sprint 16 发布层 Service 出口（原 notImplemented 桩替换为真实现）
  const release = (input = {}) => releaseManager.releaseCandidate(input);
  const releaseQueue = (input = {}) => releaseManager.releaseQueue(input);
  const rollback = (input = {}) => releaseManager.rollback(input);
  const observe = () => releaseManager.observe();
  const listReleases = (input = {}) => releaseManager.listReleases(input);

  /**
   * Sprint 16 B 修复（2026-09-13）：评估桥自动接通。
   * detect() 产出 PENDING_EVAL 候选后，此前生产里没有任何 cron / 事件自动调用
   * triggerEval（只被人工 tools.js 与测试调用），候选永远卡在 PENDING_EVAL →
   * 达不到 QUEUED_FOR_RELEASE → releaseQueue 无物可发，自演化闭环在「评估」这一步断掉。
   * 本函数由 skill-autocreate-release cron 在发布前调用，把待评估候选逐个推进评估
   * （逐条容错），使 detect → eval → release → observe 在单日 cron 内闭环。
   */
  async function evaluateQueue(args = {}) {
    const c = effectiveConfig();
    if (!c.auto_create_enabled) return { skipped: true, reason: 'auto_create_enabled=false' };
    const cd = await table('candidates');
    const pending = [...cd.entries()].map(([, v]) => v).filter((v) => v.status === 'PENDING_EVAL');
    let evaluated = 0, queued = 0, rejected = 0, retried = 0, failed = 0;
    for (const cand of pending) {
      try {
        const r = await triggerEval({ id: cand.id, actor: 'system' });
        evaluated++;
        const fs2 = r.finalStatus ?? '';
        if (fs2 === 'QUEUED_FOR_RELEASE' || fs2 === 'PHASE3_PASS') queued++;
        else if (/REJECTED/.test(fs2)) rejected++;
        else if (r.retryable) retried++;
      } catch (e) {
        failed++;
        await audit({
          actor: 'system', action: 'eval_queue_failed', targetType: 'candidate', targetId: cand.id,
          details: {}, reason: String(e?.message ?? e),
        });
      }
    }
    return { attempted: pending.length, evaluated, queued, rejected, retried, failed };
  }

  async function stats() {
    const [tp, cd, al, rt] = await Promise.all([
      table('task_patterns'), table('candidates'), table('audit_log'), table('releases'),
    ]);
    const patterns = [...tp.entries()].map(([, v]) => v);
    const candidates = [...cd.entries()].map(([, v]) => v);
    const releases = [...rt.entries()].map(([, v]) => v);
    const byStatus = {};
    for (const c of candidates) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
    return {
      patterns: {
        total: patterns.length,
        repeated: patterns.filter((p) => p.occurrenceCount >= effectiveConfig().min_occurrence_count).length,
        byStatus: patterns.reduce((m, p) => ({ ...m, [p.status]: (m[p.status] ?? 0) + 1 }), {}),
      },
      candidates: { total: candidates.length, byStatus },
      releases: {
        total: releases.length,
        byStatus: releases.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {}),
        budgetWeek: releases.filter((r) => r.budgetWeek === releaseManager._internals.weekKey()).length,
      },
      auditLogEntries: al.entries().length,
      limits: LIMITS,
      paused,
      config: {
        auto_create_enabled: effectiveConfig().auto_create_enabled,
        release_enabled: effectiveConfig().release_enabled,
        weekly_deploy_budget: effectiveConfig().weekly_deploy_budget,
        min_occurrence_count: effectiveConfig().min_occurrence_count,
        require_human_approval: effectiveConfig().require_human_approval,
        require_human_approval_until: effectiveConfig().require_human_approval_until,
        observation_period_days: effectiveConfig().observation_period_days,
        observation_min_calls: effectiveConfig().observation_min_calls,
        aggregate_cron: effectiveConfig().aggregate_cron,
      },
      sprint: '16-release-layer',
    };
  }

  function pause(actor = 'human') {
    paused = true;
    return audit({ actor, action: 'paused', targetType: 'candidate', targetId: '*', details: {} })
      .then(() => ({ ok: true, paused: true }));
  }

  function resume(actor = 'human') {
    paused = false;
    return audit({ actor, action: 'resumed', targetType: 'candidate', targetId: '*', details: {} })
      .then(() => ({ ok: true, paused: false }));
  }

  /** §8.2：无参 = 读当前生效配置；带 patch = 修改运行时子集（内存态）。
   *  注意：必须是 const 箭头函数——若声明为 function config(){}，会被
   *  函数声明提升遮蔽 apply(ctx, config) 的同名入参（已踩坑验证）。 */
  const configApi = (patch) => {
    if (patch == null) return { ...effectiveConfig(), paused, overrides: Object.fromEntries(runtimeOverrides) };
    // 白名单过滤：只接受 §8.2 子集，子集外字段静默忽略（不报错，防误伤）
    const allowed = new Set(RUNTIME_CONFIG_KEYS);
    for (const [k, v] of Object.entries(patch)) {
      if (!allowed.has(k) || v === undefined) continue;
      runtimeOverrides.set(k, v);
    }
    return { ...effectiveConfig(), paused, overrides: Object.fromEntries(runtimeOverrides) };
  };

  ctx.provide('agint.skillAutocreate', {
    detect,
    listPatterns,
    listCandidates,
    getCandidate,
    rejectCandidate,
    modifyCandidate,
    triggerEval,
    evaluateQueue,
    release,
    releaseQueue,
    rollback,
    observe,
    listReleases,
    stats,
    pause,
    resume,
    config: configApi,
  });
}

export { ConfigSchema, apply, inject, name };
