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
import { ConfigSchema, RUNTIME_CONFIG_KEYS, isSelfProtecting, normalizeSkillRoots } from './schema.js';
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

  // ── 指标计数（宿主 ctx.metrics 可选；不可用时静默跳过）──────────────────
  function countMetric(key, delta = 1) {
    if (typeof ctx.metrics !== 'function') return;
    try { ctx.metrics(key, delta); } catch { /* 指标失败不阻断业务 */ }
  }

  // ── 表行数（2026-11-12）─────────────────────────────────────────────────
  //
  // ⚠️ `t.entries()` 返回**迭代器**，`entries.length` 恒为 undefined。
  // 本文件此前写的是 `const entries = t.entries(); checkLimit(..., entries.length)`
  // ⇒ count 是 undefined ⇒ `undefined > 1000` 恒 false ⇒ **上限检查从未触发**。
  // 宿主 API 有 `size`（当前记录数），用它；老 mock 没有 size 时退回展开迭代器。
  const tableSize = (t) => (typeof t.size === 'number' ? t.size : [...t.entries()].length);

  // ── 真删除（2026-11-12 修「假上限」）────────────────────────────────────
  //
  // 宿主 storage 域的表 API **只有** `delete(key)` / `deleteMany(keys)`
  // （@deepseek-ai/dsh-storage-domain/lib/types/domain.d.ts:70,86）——
  // **没有 `del`**。此前本插件两处调的是 `del`：
  //   · `typeof t.del === 'function'` 恒 false ⇒ 整块跳过，**永不删除**；
  //   · 或抛 TypeError 被 `.catch(() => {})` **静默吞掉**。
  // 两种形态都表现为「上限是假的」，且生产表未到上限前根本不会被触发
  // ⇒ 长期隐身（2026-11-12 实测：audit_log 10 行、overlap_candidates 少量，
  // 都远低于 1000 / 200 上限）。
  //
  // 兜底 reject **不许再被空 catch 吞掉**：失败时 ① console.warn ② 指标计数。
  function delOf(t) {
    return typeof t.delete === 'function'
      ? (key) => t.delete(key)
      : (key) => Promise.reject(new Error('curator prune: table API has no delete'));
  }

  /** 删一行；成功 true / 失败 false（失败可见：warn + 指标计数） */
  async function deleteRow(t, key) {
    try {
      await delOf(t)(key);
      return true;
    } catch (e) {
      console.warn(`[${name}] 表行删除失败（key=${key}）: ${e?.message ?? e}`);
      countMetric('storage.pruneFailed', 1);
      return false;
    }
  }

  // ── audit（唯一自动滚动清理的表）───────────────────────────────────────
  //
  // ⚠️ 2026-11-12：这段的「滚动清理」此前是**假上限**（两处独立成因，都已修）：
  //   ① 计数用迭代器的 `.length`（undefined）⇒ 上限恒不触发；
  //   ② 删除用宿主 API 里不存在的 `del` ⇒ 即使触发了也删不掉。
  async function audit(entry) {
    const t = await table('audit_log');
    const record = packAudit(entry);
    await t.put(record.id, record);
    const warn = checkLimit('audit_log', tableSize(t));
    if (warn) {
      const overflow = tableSize(t) - warn.limit;
      if (overflow > 0) {
        const sorted = [...t.entries()].sort((a, b) => String(a[1].timestamp).localeCompare(String(b[1].timestamp)));
        let removed = 0;
        for (const [key] of sorted.slice(0, overflow)) {
          if (await deleteRow(t, key)) removed += 1;
        }
        if (removed > 0) {
          // 留痕：删了什么必须可观测
          await publishEvent('curator.auditLog.pruned', { removed });
        }
      }
    }
    return record;
  }

  // ── W2（2026-11-03）：技能目录变更 → 标记「该策展」 ──────────────────────
  //
  // WHY：策展此前**只靠 cron**。`skills/change` 是宿主主动告知「技能目录变了」的
  // 唯一信号（dsh-skill:404，`dispatch("emit", ["skills/change"])`），
  // 不接它就只能等下一次定时全量扫描。
  //
  // ⛔ 本段**不自动跑 run()**，只置一个待策展标记。三条理由：
  //    1. run() 会扫全部技能根 + 读 tool_stats + 落 skill_states 四张表，
  //       是**秒级**操作；而 `skills/change` 可能成批连发（目录扫描、批量安装）。
  //       直接在回调里触发 = 把宿主的一次目录操作放大成 N 次全量扫描。
  //    2. 自动归档是**不可逆动作**（文件被挪进 .archive/）。让一次目录变更
  //       自动引发归档，等于把「谁动了技能目录」和「谁被归档了」焊死 —— 出事查不清。
  //    3. 与 curriculum 的 goalAlignment 同一口径：事件让系统**知道**，
  //       真正动手由人/agent 显式调 `curator.run()`。
  //
  // ⚠️ 2026-11-12 决策变更（用户拍板，cron 事件驱动评估 §七 步骤 1）：
  //    **本段自身仍不自动跑 run()** —— 上面三条针对「宿主回调里直接跑」依然
  //    成立，故本文件代码不动；但「全系统不得因 skills/change 自动跑 run()」
  //    这条**全局禁令已撤销**。现由 `agint-cron/lib/event-trigger.js` 订阅同一
  //    topic，5s 去抖 + 6h 冷却后调 `agint.cron.runNow('curator-weekly')`，
  //    执行**完整 run()（含归档）**。
  //    护栏一律保留：auto_curation_enabled / dry_run_default /
  //    weekly_archive_budget 不动；cron 全部 job（评估口径 27、当前 29）保留
  //    为兜底；失败发 `curator.run-failed` 终态事件。
  //    ⛔ 别再引用上面第 3 条当作「事件不能驱动 run()」的依据 —— 那是本段的
  //      局部理由，不是全系统约束。
  //
  // ⚠️ 宿主契约：`skills/change` **无参数**。所以这里拿不到「哪个技能变了」，
  //    只能记「变过」。要判断变了什么，必须自己扫 —— 这正是 run() 干的事。
  const SKILLS_CHANGE_DEBOUNCE_MS = 5000;
  let skillsChangeState = null;   // { firstSeenAt, lastSeenAt, batches, pending }

  function attachSkillsChangeWatch() {
    const subscribe = typeof ctx.get === 'function' ? ctx.get('agint.eventBus.subscribe') : null;
    if (typeof subscribe !== 'function') return;

    const onChange = () => {
      const nowMs = Date.now();
      if (!skillsChangeState) {
        skillsChangeState = { firstSeenAt: new Date(nowMs).toISOString(), lastSeenAt: null, batches: 0, pending: true };
      }
      // 防抖只在「观测面」生效：连续变更合并成一个批次计数，pending 保持 true，
      // 直到有人调 run() 才清掉。这样面板能看出「技能目录动过、还没策展」。
      const sinceLast = skillsChangeState.lastSeenAt
        ? nowMs - Date.parse(skillsChangeState.lastSeenAt)
        : Number.POSITIVE_INFINITY;
      if (sinceLast >= SKILLS_CHANGE_DEBOUNCE_MS) skillsChangeState.batches += 1;
      skillsChangeState.lastSeenAt = new Date(nowMs).toISOString();
      skillsChangeState.pending = true;
    };

    try {
      // 入参是 SubscriptionSchema（subscriber/topics/mode），不是事件 envelope 的 { topic, source }。
      const off = subscribe(
        { subscriber: name, topics: ['input.signal.host.skills-change'], mode: 'async' },
        onChange,
      );
      if (typeof off === 'function') ctx.effect(() => () => { try { off(); } catch { /* ignore */ } });
    } catch (e) {
      if (!disposed) console.warn(`[${name}] skills/change 订阅失败（策展将退回纯 cron）:`, e?.message ?? e);
    }
  }

  void ready.then(() => attachSkillsChangeWatch()).catch(() => {});

  /**
   * W2：技能变更观测面（只读）。
   *
   * `received: false` = 链路没通电（退回纯 cron）；
   * `pending: true` = 技能目录变过、还没策展（面板该提示「该跑一次 curator_run_now」）。
   * ⛔ 这两个状态不许合并 —— 「没接上」和「接上了但还没跑」在排障时是完全不同的问题。
   */
  function skillsChangeStatus() {
    if (!skillsChangeState) {
      return { received: false, pending: false, batches: 0, firstSeenAt: null, lastSeenAt: null };
    }
    return { received: true, ...skillsChangeState };
  }

  /** run() / dryRun() 成功后清掉待策展标记 —— 只有真跑过才算「已处理」 */
  function clearSkillsChangePending() {
    if (skillsChangeState && skillsChangeState.pending) skillsChangeState.pending = false;
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
        let removed = 0;
        for (const [key, v] of t.entries()) {
          if (v.skillA === skillA && v.skillB === skillB && v.kind === 'overlap_candidate') {
            // ⚠️ 2026-11-12：此前调的是 `t.del`（宿主表 API 无此方法）
            // ⇒ TypeError 被空 catch 吞掉 ⇒ **旧记录永远删不掉**（覆盖不生效，
            // overlap_candidates 表按周累积）。现在用真的 delete + 留痕。
            if (await deleteRow(t, key)) removed += 1;
          }
        }
        if (removed > 0) {
          await publishEvent('curator.overlapCandidates.pruned', { removed });
        }
        await t.put(record.id, record);
        written++;
      }
      await publishEvent('curator.overlap-detected', { skillA, skillB, similarity: dims });
      await publishEvent('curator.consolidate-proposed', { skillA, skillB, recommendation: recommendation.rationale });
    }
    const lw = checkLimit('overlap_candidates', t.size);
    if (lw) console.warn(`[${name}] ${lw._warn}`);
    void trigger;
    return written;
  }

  /**
   * 多根技能扫描（2026-10-01）：skills_dir 接受单目录或目录列表，逐根 scanSkills
   * 后按 name 去重（声明顺序在前者优先）。返回 dirs 供审计/排障——「扫了哪几个根」
   * 必须是可取证的事实，不能靠读配置猜。
   */
  async function scanSkillRoots() {
    const list = normalizeSkillRoots(effectiveConfig().skills_dir);
    const dirs = [];
    const seen = new Set();
    const skills = [];
    for (const raw of list) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const abs = resolvePath(raw);
      dirs.push(abs);
      for (const s of await scanSkills(abs)) {
        if (seen.has(s.name)) continue;
        seen.add(s.name);
        skills.push(s);
      }
    }
    return { skills, dirs };
  }

  /**
   * lastRunAt 落盘回读（2026-10-01）。lastRunAt 本是内存态 → 每次重启归零，
   * curator_status 恒显 `lastRun=never`，而 cron 记录里明明有成功运行。
   * 落盘通道复用 audit_log：run() 每次写一条 weekly_run / dry_run，
   * 挂载时回读时间戳最新的一条；读不到就保持 null（不假装有值）。
   */
  async function restoreLastRunAt() {
    try {
      const t = await table('audit_log');
      let latest = null;
      for (const [, v] of t.entries()) {
        if (v.action !== 'weekly_run' && v.action !== 'dry_run') continue;
        if (!latest || String(v.timestamp) > String(latest)) latest = v.timestamp;
      }
      if (latest && lastRunAt === null) lastRunAt = latest;
    } catch { /* domain 不可用 → 保持 null，不阻断挂载 */ }
  }

  void ready.then(() => restoreLastRunAt()).catch(() => {});

  /** 扫描到的技能 → skill_states 表同步（保留人工设置，只刷新 usage/描述） */
  async function syncSkillStates(skills, usageMap, { nowMs, dryRun = false, trigger = 'weekly_curation' } = {}) {
    const c = effectiveConfig();
    const cronRefs = await detectCronReferenced();
    const t = await table('skill_states');
    const existingByName = new Map();
    for (const [, v] of t.entries()) existingByName.set(v.skillName, v);

    const synced = [];
    const scannedNames = new Set();
    for (const s of skills) {
      scannedNames.add(s.name);
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
        // 物理位置（2026-10-21）：归档/恢复按它定位目录。扫描结果 s 是权威
        // ——它知道自己从哪个根读出来；2026-10-21 之前的存量记录没有这两个
        // 字段，由 s 补齐（补齐前若发生归档 → 回退 skills_dir 第一根）。
        rootDir: s.rootDir ?? ex?.rootDir ?? null,
        dirName: s.dirName ?? ex?.dirName ?? null,
      };
      const packed = packSkillState(business, ex);
      // createdAt 用技能创建时间（SKILL.md birthtime），不是首次入库时间
      const withRealCreatedAt = { ...packed, createdAt: s.createdAt };
      await t.put(packed.id, withRealCreatedAt);
      synced.push(withRealCreatedAt);
    }

    // ── orphan 清扫（2026-10-01）────────────────────────────────────────
    // 账本里有、任何扫描根里都没有 → 技能目录已被移除/回滚，账上却仍算 active。
    // 只把账改成 archived 并写审计：**不移动目录、不删记录**（可 curator_unarchive 回滚）。
    // 护栏：扫描结果为空时整体跳过 —— 配置写错/目录不可读时不能把整本账扫成孤儿。
    const orphans = [];
    if (c.orphan_sweep_enabled !== false && skills.length > 0) {
      for (const [key, v] of t.entries()) {
        if (scannedNames.has(v.skillName)) continue;
        if (v.state === 'archived') continue;
        orphans.push({ id: key, skillName: v.skillName, fromState: v.state, record: v });
      }
      if (!dryRun) {
        for (const o of orphans) {
          const at = nowIso();
          const packed = packSkillState({
            ...o.record,
            state: 'archived',
            stateChangedAt: at,
            archivedAt: at,
            archiveReason: 'orphan: 源目录中已不存在（curator orphan sweep）',
            stateHistory: [
              ...(o.record.stateHistory ?? []),
              { from: o.fromState, to: 'archived', at, reason: 'orphan sweep: 源目录中已不存在', actor: 'system' },
            ],
          }, o.record);
          await t.put(packed.id, packed);
          await audit({
            actor: 'system',
            action: 'archive',
            targetType: 'skill',
            targetId: o.skillName,
            details: { fromState: o.fromState, toState: 'archived', trigger, dryRun: false, sweep: 'orphan', filesMoved: false },
            reason: `orphan：${o.skillName} 不在任何扫描根中`,
          });
        }
      }
    }

    const limitWarn = checkLimit('skill_states', t.size);
    if (limitWarn) console.warn(`[${name}] ${limitWarn._warn}`);
    void nowMs;
    return { synced, orphans, scannedNames: [...scannedNames] };
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
    const { skills, dirs: skillsDirs } = await scanSkillRoots();
    const { usage, inference } = aggregateUsage(tasks, skills, {
      inferenceEnabled: c.usage_inference_enabled !== false,
      minToolCoverage: c.usage_inference_min_tool_coverage,
    });

    // Sprint 15 T7：跨域读 evolution-log 的 phase3-provisional 评估历史
    // （P0-1 评估层写入，Sprint15 设计稿 §4.3 B 路径）。记录只到候选级
    // （targetId=candidateId），技能级 HARM 待 Sprint 16 release 链路补写；
    // 本阶段用于候选质量池计数，规则 1/2/3 的 HARM 分支以单测覆盖。
    const evolutionEntries = await readEvolutionProvisional();

    const { synced: states, orphans } = await syncSkillStates(skills, usage, { nowMs, dryRun, trigger });

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
      const rw = checkLimit('reports', rt.size);
      if (rw) console.warn(`[${name}] ${rw._warn}`);
    }

    lastRunAt = nowIso();
    await publishEvent('curator.run-completed', {
      week: report.week, trigger, dryRun, summary: report.summary,
    });

    // 落盘 lastRunAt（2026-10-01）：curator_status 的 lastRun 必须重启后仍为真值。
    // dry-run 同样留痕——「跑过但只是 dry-run」与「从没跑过」是两件事，不能混为一谈。
    await audit({
      actor: args.actor ?? 'system',
      action: dryRun ? 'dry_run' : 'weekly_run',
      targetType: 'curator',
      targetId: report.week,
      details: {
        week: report.week,
        trigger,
        dryRun,
        skillsScanned: skills.length,
        skillsDirs,
        orphansDetected: orphans.length,
        orphansSwept: dryRun ? 0 : orphans.length,
      },
      reason: null,
    }).catch(() => { /* 审计写失败不阻断本次运行结果 */ });

    // W2：只有**真跑**（非 dry-run）才算把「技能目录变过」这件事处理掉了。
    // dry-run 刻意不清：它没落盘、也没归档任何东西，清了就等于谎报「已处理」。
    if (!dryRun) clearSkillsChangePending();

    return {
      week: report.week,
      dryRun,
      trigger,
      skillsScanned: skills.length,
      skillsDirs,
      tasksAggregated: tasks.length,
      inference,                 // 'explicit' | 'inferred' | 'disabled'
      overlaps,                  // Sprint 15
      declining,                 // Sprint 15
      orphans,                   // 2026-10-01：账上有、扫描根没有的技能
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
      overlaps: { total: oc.size, proposed: [...oc.entries()].filter(([, v]) => v.status === 'proposed').length }, // Sprint 15
      actionsThisWeek: actions.filter((a) => isoWeek(new Date(a.timestamp)) === week).length,
      archivedThisWeek: await executor.archivedThisWeek(),
      reports: rp.size,
      auditLogEntries: al.size,
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
    // W2：技能变更观测面（只读）。派生值不落盘。
    skillsChange: skillsChangeStatus,
  });
}

export { ConfigSchema, apply, inject, name };
