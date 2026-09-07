/**
 * agint-skill-autocreate — P0-1 技能自动创建机制（Sprint 14 检测层）。
 *
 * Service：`agint.skillAutocreate`（设计稿 §5.1）。
 * 存储域：`agint_skill_autocreate`（5 表，设计稿 §4.1，与既有域互斥）。
 *
 * Sprint 14 范围（设计稿 §12.1）：
 *   - detect()：读 tool-stats JSONL → 聚合任务实例 → 模式检测 → 重复模式
 *     跨阈值后生成技能候选提案（纯模板，零 LLM）
 *   - 只检测 + 生成候选：不调 D-QAF、不发布（triggerEval/release/rollback
 *     显式抛 not implemented，绝不静默——Sprint 15/16 接力）
 *   - 事件：skill-autocreate.pattern-detected / candidate-created（软依赖
 *     event-bus，不可用时降级为仅写 audit_log）
 *
 * Loader row（cordis.patch.yml 模板，本文件不挂载，由老板走 safe-update）：
 *   - insert:
 *       - id: agint-skill-autocreate
 *         name: ./plugins/agint-skill-autocreate/lib/index.js
 *         config: {}
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
} from './storage.js';
import { aggregateTasks, filterWindow } from './aggregator.js';
import { detectPatterns } from './detector.js';
import { buildProposal } from './proposer.js';

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
    const { tasks, unmatched } = aggregateTasks(records);

    const tp = await table('task_patterns');
    const existing = [...tp.entries()].map(([, v]) => v);
    const { upserts, newRepeat } = detectPatterns(tasks, {
      existingPatterns: existing,
      minOccurrence: c.min_occurrence_count,
      similarityThreshold: c.param_similarity_threshold,
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

    // 跨过重复门槛的 pattern → 发事件 + 尝试生成候选
    let candidatesCreated = 0;
    const candidateIds = [];
    for (const pattern of newRepeat) {
      // newRepeat 里的对象是 detector 工作副本，需要回查已入库形态拿 id
      const stored = upserted.find(
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
      patternsUpserted: upserted.length,
      newRepeatPatterns: newRepeat.length,
      candidatesCreated,
      candidateIds,
      limitWarn: limitWarn?._warn ?? null,
    };
  }

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
    const updated = { ...found[1], skillDraft: input.skillDraft };
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

  // Sprint 15/16 接力——显式抛错，绝不静默（真实 > 讨好）
  async function notImplemented(stage) {
    throw new Error(`agint.skillAutocreate: ${stage} 未实现（Sprint 15/16 交付），当前为检测层骨架`);
  }

  async function stats() {
    const [tp, cd, al] = await Promise.all([
      table('task_patterns'), table('candidates'), table('audit_log'),
    ]);
    const patterns = [...tp.entries()].map(([, v]) => v);
    const candidates = [...cd.entries()].map(([, v]) => v);
    const byStatus = {};
    for (const c of candidates) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
    return {
      patterns: {
        total: patterns.length,
        repeated: patterns.filter((p) => p.occurrenceCount >= effectiveConfig().min_occurrence_count).length,
        byStatus: patterns.reduce((m, p) => ({ ...m, [p.status]: (m[p.status] ?? 0) + 1 }), {}),
      },
      candidates: { total: candidates.length, byStatus },
      auditLogEntries: al.entries().length,
      limits: LIMITS,
      paused,
      config: {
        auto_create_enabled: effectiveConfig().auto_create_enabled,
        weekly_deploy_budget: effectiveConfig().weekly_deploy_budget,
        min_occurrence_count: effectiveConfig().min_occurrence_count,
        require_human_approval: effectiveConfig().require_human_approval,
        aggregate_cron: effectiveConfig().aggregate_cron,
      },
      sprint: '14-detection-layer',
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
    triggerEval: (input = {}) => notImplemented('triggerEval'),
    release: (input = {}) => notImplemented('release'),
    rollback: (input = {}) => notImplemented('rollback'),
    stats,
    pause,
    resume,
    config: configApi,
  });
}

export { ConfigSchema, apply, inject, name };
