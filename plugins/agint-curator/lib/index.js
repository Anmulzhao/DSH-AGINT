/**
 * agint-curator — P0-2 技能策展人（Sprint 14 阶段 1：基础策展）。
 *
 * Service：`agint.curator.*`（P0-2 §5.1）。
 * 存储域：`agint_curator`（独占，4 表，Sprint14 §3.2，与既有域互斥）。
 *
 * Sprint 14 范围（P0-2 §12.1 + Sprint14 §3）：
 *   - 检测陈旧技能（30 天 stale / 90 天 archive）→ 自动归档到 skills/.archive/
 *   - 四类保护：pinned / protected（含策展自保护 §9.4）/ cron-referenced /
 *     新技能 14 天保护期（Sprint14 §3.4 A-16）
 *   - 基础报告（统计 + 归档列表）
 *   - dry-run 与真实执行走**同一条计算路径**（验收标准：输出一致，除不落盘）
 *   - D3：curriculum 来源（sessionId 前缀 `curriculum-`）的调用不刷新 lastUsedAt
 *   - ❌ 不做重叠检测 / 质量评估 / consolidate / prune（Sprint 15/16）
 *
 * Loader row（cordis.patch.yml 模板，本文件不挂载，由老板走 safe-update）：
 *   - insert:
 *       - id: agint-curator
 *         name: ./plugins/agint-curator/lib/index.js
 *         config: {}
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { ConfigSchema, RUNTIME_CONFIG_KEYS, isSelfProtecting } from './schema.js';
import {
  spec,
  checkLimit,
  LIMITS,
  packSkillState,
  packReport,
  packAudit,
  packOverlapCandidate,
  isoWeek,
  nowIso,
} from './storage.js';
import { scanSkills, filterRecords, groupTaskCalls, aggregateUsage } from './aggregator.js';
import { evaluateAll } from './state-engine.js';
import { createExecutor } from './executor.js';
import { buildReport } from './reporter.js';
import { detectOverlaps, OVERLAP_THRESHOLDS } from './dedup.js';
import { evaluateQuality, appendQualitySnapshot, QUALITY_THRESHOLDS } from './quality.js';

const name = 'agint-curator';
const inject = ['storageDomain'];

function apply(ctx, config) {
  const cfg = ConfigSchema.parse(config ?? {});
  let domain = null;
  let domainError = null;
  let disposed = false;
  let paused = false;                       // §8.2 运行时开关（内存态，重启还原）
  let lastRunAt = null;
  const runtimeOverrides = new Map();

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

  // ── audit（唯一自动滚动清理的表）───────────────────────────────────────
  async function audit(entry) {
    const t = await table('audit_log');
    const record = packAudit(entry);
    await t.put(record.id, record);
    const entries = t.entries();
    const warn = checkLimit('audit_log', entries.length);
    if (warn) {
      const overflow = entries.length - warn.limit;
      if (overflow > 0) {
        const del = typeof t.del === 'function' ? (k) => t.del(k) : null;
        if (del) {
          const sorted = [...entries].sort((a, b) => String(a[1].timestamp).localeCompare(String(b[1].timestamp)));
          for (const [key] of sorted.slice(0, overflow)) await del(key).catch(() => {});
        }
      }
    }
    return record;
  }

  const executor = createExecutor({
    getTable: table,
    audit,
    publishEvent,
    effectiveConfig,
  });

  // ── 读 tool-stats JSONL（P0-2 §10.1：读文件，不重复采集）───────────────
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
    } catch { return []; }
  }

  /**
   * cron-referenced 探测：软依赖 agint.cron。
   * 当前 agint-cron 的 job 定义不声明技能字段，因此这条通道是**预留**——
   * 实际生效来源为 config.cron_referenced_skills（人工声明）。诚实标注，不假装生效。
   */
  async function detectCronReferenced() {
    const set = new Set(effectiveConfig().cron_referenced_skills ?? []);
    const cron = typeof ctx.get === 'function' ? ctx.get('agint.cron') : null;
    if (cron && typeof cron.list === 'function') {
      try {
        const jobs = await cron.list();
        for (const j of jobs ?? []) {
          for (const s of j?.skills ?? (j?.skill ? [j.skill] : [])) set.add(s);
        }
      } catch { /* 探测失败不影响策展 */ }
    }
    return set;
  }

  /**
   * Sprint 15 T7：跨域读 evolution-log 的 phase3-provisional 记录。
   * 软依赖 agint.evolution（readLogRangeMerged），缺失/失败 → [] 降级不阻断。
   * readLogRangeMerged 的 query 只匹配 evidence/pattern/reason，不覆盖 tags，
   * 因此全量读 + 本侧按 tags 过滤。
   */
  async function readEvolutionProvisional() {
    const evo = typeof ctx.get === 'function' ? ctx.get('agint.evolution') : null;
    if (!evo || typeof evo.readLogRangeMerged !== 'function') return [];
    try {
      const merged = await evo.readLogRangeMerged({});
      const list = Array.isArray(merged) ? merged : [];
      return list
        .filter((e) => Array.isArray(e?.tags) && e.tags.includes('phase3-provisional'))
        .sort((a, b) => String(a.timestamp ?? a.createdAt ?? '').localeCompare(String(b.timestamp ?? b.createdAt ?? '')));
    } catch (e) {
      if (!disposed) console.warn(`[${name}] readEvolutionProvisional failed:`, e?.message ?? e);
      return [];
    }
  }

  /**
   * Sprint 15 T1/T6：重叠候选对落盘 overlap_candidates + 发布事件。
   * 每周覆盖同对（同 skillA/skillB）旧记录，避免堆积（上限 OVERLAP_CANDIDATES）。
   */
  async function persistOverlaps(overlaps, { dryRun, trigger }) {
    if (!overlaps?.length) return 0;
    const t = await table('overlap_candidates');
    let written = 0;
    for (const o of overlaps) {
      const { recommendation, dims, skillA, skillB } = o;
      if (!dryRun) {
        const record = packOverlapCandidate({ skillA, skillB, dims, recommendation });
        // 覆盖同对旧记录（保持幂等）
        for (const [key, v] of t.entries()) {
          if (v.skillA === skillA && v.skillB === skillB && v.kind === 'overlap_candidate') {
            await t.del(key).catch(() => {});
          }
        }
        await t.put(record.id, record);
        written++;
      }
      await publishEvent('curator.overlap-detected', { skillA, skillB, similarity: dims });
      await publishEvent('curator.consolidate-proposed', { skillA, skillB, recommendation: recommendation.rationale });
    }
    const lw = checkLimit('overlap_candidates', t.entries().length);
    if (lw) console.warn(`[${name}] ${lw._warn}`);
    void trigger;
    return written;
  }

  /** 扫描到的技能 → skill_states 表同步（保留人工设置，只刷新 usage/描述） */
  async function syncSkillStates(skills, usageMap, { nowMs }) {
    const c = effectiveConfig();
    const cronRefs = await detectCronReferenced();
    const t = await table('skill_states');
    const existingByName = new Map();
    for (const [, v] of t.entries()) existingByName.set(v.skillName, v);

    const synced = [];
    for (const s of skills) {
      const ex = existingByName.get(s.name);
      const protectedFlag = ex?.protected === true
        || c.protected_skills.includes(s.name)
        || (c.self_protect_enabled !== false && isSelfProtecting(s.name));
      const usage = usageMap[s.name] ?? {
        useCount: 0, lastUsedAt: null, firstUsedAt: null, successRate: null, avgDurationMs: null, avgTokenCost: null,
      };
      const business = {
        skillName: s.name,
        source: ex?.source ?? 'manual',
        sourcePlugin: ex?.sourcePlugin ?? null,
        category: ex?.category ?? 'general',
        description: s.description || ex?.description || '',
        protected: protectedFlag,
        cronReferenced: ex?.cronReferenced === true || cronRefs.has(s.name),
        state: ex?.state ?? 'active',
        stateChangedAt: ex?.stateChangedAt ?? s.createdAt,
        stateHistory: ex?.stateHistory ?? [],
        usage,
        quality: ex?.quality ?? { qualityState: null, history: [], reviewSuggested: false },
        archivedAt: ex?.archivedAt ?? null,
        archiveReason: ex?.archiveReason ?? null,
        curationNotes: ex?.curationNotes ?? '',
      };
      const packed = packSkillState(business, ex);
      // createdAt 用技能创建时间（SKILL.md birthtime），不是首次入库时间
      const withRealCreatedAt = { ...packed, createdAt: s.createdAt };
      await t.put(packed.id, withRealCreatedAt);
      synced.push(withRealCreatedAt);
    }

    const limitWarn = checkLimit('skill_states', t.entries().length);
    if (limitWarn) console.warn(`[${name}] ${limitWarn._warn}`);
    void nowMs;
    return synced;
  }

  // ── 主流程：run / dryRun 同一条路径（验收标准）────────────────────────
  async function run(args = {}) {
    const c = effectiveConfig();
    if (args.force !== true && paused) {
      return { skipped: true, reason: 'paused（curator_pause）' };
    }
    const nowMs = Number.isFinite(args.nowMs) ? args.nowMs : Date.now();
    const trigger = args.trigger ?? 'weekly_curation';
    // 总开关关 = 只检测不执行（P0-2 §8.1 auto_curation_enabled）
    const dryRun = args.dryRun === true || (args.dryRun !== false && c.dry_run_default === true) || c.auto_curation_enabled === false;

    const records = filterRecords(await readToolStatsRecords(), {
      lookbackDays: c.usage_lookback_days,
      nowMs,
    });
    const tasks = groupTaskCalls(records);
    const skills = await scanSkills(resolvePath(c.skills_dir));
    const { usage, inference } = aggregateUsage(tasks, skills, {
      inferenceEnabled: c.usage_inference_enabled !== false,
      minToolCoverage: c.usage_inference_min_tool_coverage,
    });

    // Sprint 15 T7：跨域读 evolution-log 的 phase3-provisional 评估历史
    // （P0-1 评估层写入，Sprint15 设计稿 §4.3 B 路径）。记录只到候选级
    // （targetId=candidateId），技能级 HARM 待 Sprint 16 release 链路补写；
    // 本阶段用于候选质量池计数，规则 1/2/3 的 HARM 分支以单测覆盖。
    const evolutionEntries = await readEvolutionProvisional();

    const states = await syncSkillStates(skills, usage, { nowMs });

    // Sprint 15 T2：质量周快照 + 趋势评估（挂 skill.quality，state-engine 消费）
    for (const s of states) {
      const snap = { week: isoWeek(new Date(nowMs)), successRate: s.usage?.successRate ?? null, useCount: s.usage?.useCount ?? 0 };
      s.quality.history = appendQualitySnapshot(s, snap, c.quality_snapshot_max_weeks);
      const q = evaluateQuality(s, { evolutionEntries });
      s.quality.qualityState = q.qualityState;
      s.quality.harmTrend = q.harmTrend;
      s.quality.successTrend = q.successTrend;
      if (q.qualityState === 'declining' && !s.quality.reviewSuggested) {
        s.quality.reviewSuggested = q.harmTrend?.state === 'declining' ? true : false;
      }
      await table('skill_states').then((t) => t.put(s.id, s));
    }

    // Sprint 15 T1：重叠检测（active + stale 状态对）
    // 输入=扫描元数据（description/tools/triggers）+ 状态/使用（来自 skill_states），
    // 两个来源缺一不可：skill_states 无 tools/triggers，扫描清单无 state/usage。
    const stateByName = new Map(states.map((s) => [s.skillName, s]));
    const dedupInput = skills.map((s) => ({
      ...s,
      state: stateByName.get(s.name)?.state ?? 'active',
      usage: stateByName.get(s.name)?.usage ?? { useCount: 0, successRate: null },
    }));
    const overlaps = c.overlap_detection_enabled !== false
      ? detectOverlaps(dedupInput, {
          includeStates: ['active', 'stale', 'quality_declining'],
          thresholds: {
            description: c.overlap_desc_threshold,
            tools: c.overlap_tools_threshold,
            triggers: c.overlap_triggers_threshold,
            minDimensions: c.overlap_min_dimensions,
          },
        }).slice(0, c.overlap_max_pairs ?? 50)
      : [];
    await persistOverlaps(overlaps, { dryRun, trigger });

    const { decisions } = evaluateAll(states, { config: c, nowMs });
    const applied = await executor.applyDecisions(decisions, { dryRun, trigger, actor: args.actor ?? 'system' });

    // Sprint 15 T8：质量下降技能列表（进报告 + 事件）
    const declining = states
      .filter((s) => s.quality?.qualityState === 'declining')
      .map((s) => ({
        skillName: s.skillName,
        state: s.state,
        reason: (s.quality?.successTrend?.state === 'declining' ? s.quality.successTrend.reason : '')
          + (s.quality?.harmTrend?.state === 'declining' ? (s.quality.successTrend?.state === 'declining' ? '；' : '') + s.quality.harmTrend.reason : ''),
        successTrendState: s.quality?.successTrend?.state ?? null,
        harmTrendState: s.quality?.harmTrend?.state ?? null,
      }));
    for (const d of declining) {
      await publishEvent('curator.quality-declining', { skillName: d.skillName, trend: { success: d.successTrendState, harm: d.harmTrendState }, reason: d.reason });
    }

    const report = buildReport({
      week: isoWeek(new Date(nowMs)),
      generatedAt: nowIso(),
      trigger,
      dryRun,
      skills: states,
      decisions,
      applied,
      overlaps,
      declining,
    });

    if (!dryRun || args.persistDryRunReport === true) {
      const rt = await table('reports');
      const existing = rt.entries().find(([, v]) => v.week === report.week);
      const packed = packReport(report, existing?.[1]);
      await rt.put(packed.id, packed);
      const rw = checkLimit('reports', rt.entries().length);
      if (rw) console.warn(`[${name}] ${rw._warn}`);
    }

    lastRunAt = nowIso();
    await publishEvent('curator.run-completed', {
      week: report.week, trigger, dryRun, summary: report.summary,
    });

    return {
      week: report.week,
      dryRun,
      trigger,
      skillsScanned: skills.length,
      tasksAggregated: tasks.length,
      inference,                 // 'explicit' | 'inferred' | 'disabled'
      overlaps,                  // Sprint 15
      declining,                 // Sprint 15
      applied,
      report,
      lastRunAt,
    };
  }

  function dryRun(args = {}) {
    return run({ ...args, dryRun: true, trigger: args.trigger ?? 'dry_run' });
  }

  // ── Service 出口（P0-2 §5.1）───────────────────────────────────────────

  async function listSkills(filter = {}) {
    const t = await table('skill_states');
    let list = [...t.entries()].map(([, v]) => v);
    if (filter.state) list = list.filter((s) => s.state === filter.state);
    if (filter.protectedOnly) list = list.filter((s) => s.protected === true);
    if (filter.query) {
      const q = String(filter.query).toLowerCase();
      list = list.filter((s) => s.skillName.toLowerCase().includes(q));
    }
    list.sort((a, b) => String(a.skillName).localeCompare(String(b.skillName)));
    if (filter.limit) list = list.slice(0, filter.limit);
    return list;
  }

  async function getSkill(skillName) {
    if (!skillName) throw new Error('getSkill: skillName is required');
    const found = await executor.findSkill(skillName);
    return found?.value ?? null;
  }

  async function stats() {
    const [st, ca, rp, al, oc] = await Promise.all([
      table('skill_states'), table('curation_actions'), table('reports'), table('audit_log'), table('overlap_candidates'),
    ]);
    const states = [...st.entries()].map(([, v]) => v);
    const actions = [...ca.entries()].map(([, v]) => v);
    const week = isoWeek();
    return {
      skills: {
        total: states.length,
        byState: states.reduce((m, s) => ({ ...m, [s.state]: (m[s.state] ?? 0) + 1 }), {}),
        protected: states.filter((s) => s.protected === true).length,
        cronReferenced: states.filter((s) => s.cronReferenced === true).length,
        withUsageData: states.filter((s) => (s.usage?.useCount ?? 0) > 0).length,
        declining: states.filter((s) => s.quality?.qualityState === 'declining').length, // Sprint 15
        reviewSuggested: states.filter((s) => s.quality?.reviewSuggested === true).length, // Sprint 15
      },
      overlaps: { total: oc.entries().length, proposed: [...oc.entries()].filter(([, v]) => v.status === 'proposed').length }, // Sprint 15
      actionsThisWeek: actions.filter((a) => isoWeek(new Date(a.timestamp)) === week).length,
      archivedThisWeek: await executor.archivedThisWeek(),
      reports: rp.entries().length,
      auditLogEntries: al.entries().length,
      limits: LIMITS,
      paused,
      lastRunAt,
      config: {
        stale_after_days: effectiveConfig().stale_after_days,
        archive_after_days: effectiveConfig().archive_after_days,
        quality_archive_after_days: effectiveConfig().quality_archive_after_days, // Sprint 15
        new_skill_protection_days: effectiveConfig().new_skill_protection_days,
        weekly_archive_budget: effectiveConfig().weekly_archive_budget,
        auto_curation_enabled: effectiveConfig().auto_curation_enabled,
        dry_run_default: effectiveConfig().dry_run_default,
        overlap_detection_enabled: effectiveConfig().overlap_detection_enabled, // Sprint 15
        weekly_cron: effectiveConfig().weekly_cron,
      },
      sprint: '15-smart-curation',
    };
  }

  async function getReport(week) {
    const t = await table('reports');
    if (week) {
      const hit = t.entries().find(([, v]) => v.week === week);
      return hit ? hit[1] : null;
    }
    const all = [...t.entries()].map(([, v]) => v).sort((a, b) => String(b.week).localeCompare(String(a.week)));
    return all[0] ?? null;
  }

  function pause(actor = 'human') {
    paused = true;
    return audit({ actor, action: 'paused', targetType: 'skill_state', targetId: '*', details: {} })
      .then(() => ({ ok: true, paused: true }));
  }

  function resume(actor = 'human') {
    paused = false;
    return audit({ actor, action: 'resumed', targetType: 'skill_state', targetId: '*', details: {} })
      .then(() => ({ ok: true, paused: false }));
  }

  /** §8.2：无参 = 读当前生效配置；带 patch = 修改运行时子集（内存态）。
   *  必须 const 箭头函数——function config(){} 会被提升遮蔽 apply(ctx, config) 的同名入参。 */
  const configApi = (patch) => {
    if (patch == null) return { ...effectiveConfig(), paused, overrides: Object.fromEntries(runtimeOverrides) };
    const allowed = new Set(RUNTIME_CONFIG_KEYS);
    for (const [k, v] of Object.entries(patch)) {
      if (!allowed.has(k) || v === undefined) continue;
      runtimeOverrides.set(k, v);
    }
    return { ...effectiveConfig(), paused, overrides: Object.fromEntries(runtimeOverrides) };
  };

  ctx.provide('agint.curator', {
    run,
    dryRun,
    listSkills,
    getSkill,
    pin: (args = {}) => executor.pin(args),
    unpin: (args = {}) => executor.unpin(args),
    archive: (args = {}) => executor.archive(args),
    unarchive: (args = {}) => executor.unarchive(args),
    stats,
    getReport,
    // Sprint 15：重叠 / 质量下降（P0-2 §5.1）
    listOverlaps: async (filter = {}) => {
      const t = await table('overlap_candidates');
      let list = [...t.entries()].map(([, v]) => v);
      if (filter.status) list = list.filter((o) => o.status === filter.status);
      list.sort((a, b) => b.dims?.dimsMet - a.dims?.dimsMet || String(a.skillA).localeCompare(String(b.skillA)));
      if (filter.limit) list = list.slice(0, filter.limit);
      return list;
    },
    listDeclining: async (filter = {}) => {
      const t = await table('skill_states');
      let list = [...t.entries()].map(([, v]) => v)
        .filter((s) => s.quality?.qualityState === 'declining');
      if (filter.onlyReviewSuggested) list = list.filter((s) => s.quality?.reviewSuggested === true);
      list.sort((a, b) => String(a.skillName).localeCompare(String(b.skillName)));
      return list;
    },
    // Sprint 16 接力——显式抛错，绝不静默（真实 > 讨好）
    consolidate: () => Promise.reject(new Error('agint.curator: consolidate 未实现（Sprint 16 整合）')),
    prune: () => Promise.reject(new Error('agint.curator: prune 未实现（Sprint 16，且默认永久禁用）')),
    pause,
    resume,
    config: configApi,
  });
}

export { ConfigSchema, apply, inject, name };
