/**
 * agint-skill-graph — P2-2 技能使用统计与学习图谱（Sprint 19 v0.1.0）。
 *
 * 定位（§1.1）：P0-1 管「生」、P0-2 管「死」、P2-2 管「**亲缘关系**」。
 * Service 前缀 `agint.skillGraph.*`；存储域 `agint_skill_graph`（独占，3 表）。
 *
 * FROZEN 6 Service（§4.1）：updateFull / getStats / neighbors / clusters / recommend / getCoverage
 * 不变量（§4.3）：① fail-open ② 边必须带证据 ③ 只读消费上游 ④ 不进决策
 *                 ⑤ skillName 唯一主键 ⑥ 零数据必须"响" ⑦ 订阅的事件必须已核实存在
 *
 * 上线档位（§5.3）：默认 `count-only` 标定期 —— 只扫不落正式图，产出
 * "若转 live 会得到多少节点/边"的对比报告；未跑过标定期调 setMode('live') **抛错**。
 * 按 §六bis 实测预期，本机当前标定结果应是「11 节点 / 0 条计算型边」——那是正确行为，不是故障。
 *
 * 与同族插件的关系：
 *   - 只读消费 `agint.curator`（skill_states 状态）与 tool-stats JSONL，**无反向写入**；
 *   - overlap 边日常走 `curator.overlap-detected` 事件，回溯走 curator 纯函数（引用不复制）；
 *   - 与 autocreate 的 `similarity.js`（名字编辑距离）分工：那个查"重名"，本图谱查"内容相邻"。
 *
 * Loader row（cordis.patch.yml 模板，本文件不挂载，由老板走 safe-update）：
 *   - insert:
 *       - id: agint-skill-graph
 *         name: ./plugins/agint-skill-graph/lib/index.js
 *         config: {}
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';

import {
  ConfigSchema,
  DEFAULT_WEIGHTS,
  EDGE_TYPES,
  RUNTIME_CONFIG_KEYS,
  makeEdgeId,
} from './schema.js';
import { spec, checkLimit, packUsageStats, packEdge, packMeta, emptyMeta, nowIso, isoWeek } from './storage.js';
import { scanNodes, readJsonl, collectSkillCalls, aggregateUsage } from './collect.js';
import {
  buildRelatedEdges,
  buildCoUseEdges,
  buildSimilarEdges,
  buildOfflineOverlapEdges,
  overlapEdgeFromEvent,
  filterValidEdges,
  dedupe,
} from './edges.js';
import {
  computeCoverage,
  computeHealth,
  isStale,
  neighbors as neighborsOf,
  clusters as clustersOf,
  recommend as recommendOf,
} from './query.js';

const name = 'agint-skill-graph';
const inject = ['storageDomain'];

/** 事件只做「脏标记 + 状态同步」；overlap 边是唯一的实时写入例外（§5.1） */
const STATUS_BY_TOPIC = {
  'curator.skill-archived': 'archived',
  'curator.skill-staled': 'stale',
  'curator.skill-reactivated': 'active',
  'curator.skill-pinned': 'pinned',
  'curator.quality-declining': 'quality_declining',
};

const PROVISIONAL_TTL_DAYS = 30;

function apply(ctx, config) {
  const cfg = ConfigSchema.parse(config ?? {});
  let domain = null;
  let domainError = null;
  let disposed = false;
  let lastRunAt = null;
  const runtimeOverrides = new Map();

  // ── 运行态（内存）──────────────────────────────────────────────────────
  /** 事件驱动的状态覆盖：不等周更就能反映 curator 的生命周期变化 */
  const statusOverrides = new Map();
  /** 事件累积的脏标记（§5.1 设计原则：事件只做脏标记） */
  let dirty = false;
  let lastCuratorRunAt = null;
  /** count-only 期缓冲：若转 live 会落盘的边（不写正式表，只在标定报告里计数） */
  const heldEdges = new Map();
  /** 节点缓存（事件归一化需要 knownNames） */
  let nodeCache = [];

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
    (err) => { domainError = err; console.error('[agint-skill-graph] storageDomain.open failed:', err?.message || err); return null; },
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

  const currentMode = () => (runtimeOverrides.get('mode') ?? cfg.mode ?? 'count-only');

  // ── meta（单行）────────────────────────────────────────────────────────

  async function readMeta() {
    const t = await table('graph_meta');
    const hit = t.entries().find(([k]) => k === 'graph_meta');
    return hit ? hit[1] : emptyMeta();
  }

  async function patchMeta(patch) {
    const t = await table('graph_meta');
    const existing = await readMeta();
    const merged = { ...existing, ...patch };
    if (patch.counters) merged.counters = { ...(existing.counters ?? {}), ...patch.counters };
    if (patch.coverage) merged.coverage = { ...(existing.coverage ?? {}), ...patch.coverage };
    const packed = packMeta(merged, existing);
    await t.put(packed.id, packed);
    return packed;
  }

  async function bumpCounter(key, delta = 1) {
    const meta = await readMeta();
    const next = { ...(meta.counters ?? {}) };
    next[key] = (next[key] ?? 0) + delta;
    return patchMeta({ counters: next });
  }

  // ── 上游只读：curator 状态 + 事件发布 ──────────────────────────────────

  /**
   * 只读 curator 的 skill_states（不变量 3：无反向写入）。
   * 缺插件 / 失败 → 空 Map 降级，不阻断（fail-open）。
   */
  async function readCuratorStatuses() {
    const map = new Map();
    const curator = typeof ctx.get === 'function' ? ctx.get('agint.curator') : null;
    if (curator && typeof curator.listSkills === 'function') {
      try {
        for (const s of await curator.listSkills({})) {
          if (s?.skillName) map.set(s.skillName, s.state ?? 'active');
        }
      } catch (e) {
        if (!disposed) console.warn(`[${name}] readCuratorStatuses failed:`, e?.message ?? e);
      }
    }
    for (const [k, v] of statusOverrides) map.set(k, v); // 事件热更新优先
    return map;
  }

  async function readProvisional() {
    const meta = await readMeta();
    const list = Array.isArray(meta.provisionalNodes) ? meta.provisionalNodes : [];
    const cutoff = Date.now() - PROVISIONAL_TTL_DAYS * 86_400_000;
    return list.filter((p) => {
      const t = Date.parse(p?.createdAt ?? '');
      return !Number.isFinite(t) || t >= cutoff;
    });
  }

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

  // ── 事件订阅（全 async，不占 sync 配额；§5.1 订阅表逐名核实）───────────

  function subscribeAll() {
    const subscribe = typeof ctx.get === 'function' ? ctx.get('agint.eventBus.subscribe') : null;
    if (typeof subscribe !== 'function' || effectiveConfig().enableEventSubscribe === false) return;

    const topics = [
      'curator.overlap-detected',
      'curator.consolidate-proposed',
      ...Object.keys(STATUS_BY_TOPIC),
      'curator.run-completed',
      'skill-autocreate.released',
      'skill-autocreate.rolled-back',
      'skill-autocreate.candidate-created',
      'trajectory.recorded',
    ];

    try {
      const off = subscribe({ subscriber: name, topics, mode: 'async', timeoutMs: 5000 }, async (env) => {
        try {
          await handleEvent(env?.topic, env?.payload ?? {});
        } catch (e) {
          if (!disposed) console.error(`[${name}] handleEvent(${env?.topic}) failed:`, e?.message ?? e);
        }
      });
      // 生命周期：dispose 时退订（维度 5）
      ctx.effect(() => () => { if (typeof off === 'function') off(); });
    } catch (e) {
      if (!disposed) console.warn(`[${name}] eventBus.subscribe failed:`, e?.message ?? e);
    }
  }

  async function ensureNodes() {
    if (nodeCache.length) return nodeCache;
    try {
      const { nodes } = await scanNodes(resolvePath(effectiveConfig().presetsDir));
      nodeCache = nodes;
    } catch { /* fail-open：保持空 */ }
    return nodeCache;
  }

  async function handleEvent(topic, payload) {
    if (topic === 'curator.overlap-detected') return onOverlapDetected(payload);
    if (topic === 'curator.consolidate-proposed') return onConsolidateProposed(payload);
    if (topic === 'curator.run-completed') { lastCuratorRunAt = nowIso(); dirty = true; return; }
    if (topic === 'trajectory.recorded') { dirty = true; return; }
    if (topic === 'skill-autocreate.candidate-created') return onCandidateCreated(payload);
    if (topic === 'skill-autocreate.released') return onReleased(payload);
    if (topic === 'skill-autocreate.rolled-back') return onRolledBack(payload);
    if (STATUS_BY_TOPIC[topic]) return onStatusChanged(payload, STATUS_BY_TOPIC[topic]);
  }

  async function onOverlapDetected(payload) {
    if (effectiveConfig().edgeTypes?.overlap === false) return;
    const nodes = await ensureNodes();
    const e = overlapEdgeFromEvent(payload, new Set(nodes.map((n) => n.skillName)));
    if (!e) { await bumpCounter('droppedEdges'); return; }
    dirty = true;
    if (currentMode() !== 'live') { heldEdges.set(e.edgeId, e); return; } // 标定期不落正式图
    try {
      const t = await table('skill_edges');
      await t.put(e.edgeId, packEdge(e));
    } catch (err) {
      await bumpCounter('writeFailures');
      if (!disposed) console.warn(`[${name}] overlap edge write failed:`, err?.message ?? err);
    }
  }

  /** 载荷与 overlap-detected 同批发布；语义更接近"重叠待复核"（§5.2 附带发现） */
  async function onConsolidateProposed(payload) {
    if (currentMode() !== 'live') return;
    const a = payload?.skillA;
    const b = payload?.skillB;
    if (!a || !b || a === b) return;
    const edgeId = makeEdgeId('overlap', a, b);
    try {
      const t = await table('skill_edges');
      const hit = t.entries().find(([k]) => k === edgeId);
      if (!hit) return;
      const next = {
        ...hit[1],
        evidence: { ...hit[1].evidence, reviewSuggested: true, recommendation: payload?.recommendation ?? '' },
      };
      await t.put(next.id, next);
    } catch (err) {
      await bumpCounter('writeFailures');
    }
  }

  async function onStatusChanged(payload, state) {
    const skillName = payload?.skillName;
    if (!skillName) return;
    statusOverrides.set(skillName, state);
    dirty = true;
    if (currentMode() !== 'live') return;
    try {
      const t = await table('usage_stats');
      const hit = t.entries().find(([, v]) => v.skillName === skillName);
      if (hit) await t.put(hit[1].id, { ...hit[1], status: state, updatedAt: nowIso() });
    } catch { await bumpCounter('writeFailures'); }
  }

  async function onCandidateCreated(payload) {
    const skillName = payload?.skillName;
    if (!skillName) return;
    const meta = await readMeta();
    const list = Array.isArray(meta.provisionalNodes) ? meta.provisionalNodes : [];
    if (list.some((p) => p.skillName === skillName)) return;
    list.push({ skillName, candidateId: payload?.candidateId ?? null, createdAt: nowIso() });
    await patchMeta({ provisionalNodes: list });
    dirty = true;
  }

  async function onReleased(payload) {
    const skillName = payload?.skillName;
    if (!skillName) return;
    statusOverrides.set(skillName, 'active');   // provisional → active
    const meta = await readMeta();
    const list = (meta.provisionalNodes ?? []).filter((p) => p.skillName !== skillName);
    await patchMeta({ provisionalNodes: list, lastReleaseAt: nowIso() });
    dirty = true;
  }

  async function onRolledBack(payload) {
    const skillName = payload?.skillName;
    if (!skillName) return;
    const meta = await readMeta();
    const list = (meta.provisionalNodes ?? []).filter((p) => p.skillName !== skillName);
    await patchMeta({ provisionalNodes: list, lastRollbackAt: nowIso() });
    statusOverrides.delete(skillName);
    dirty = true;
  }

  subscribeAll();

  // ── 主流程：updateFull（周更全量刷新；**永不 throw**，fail-open）────────

  /**
   * @param {object} args { nowMs?, trigger? }
   * @returns {{ nodes, edgesAdded, edgesRemoved, durationMs, mode, health, coverage, edgesByType }}
   */
  async function updateFull(args = {}) {
    const t0 = Date.now();
    const c = effectiveConfig();
    const nowMs = Number.isFinite(args.nowMs) ? args.nowMs : Date.now();
    const mode = currentMode();
    const empty = {
      nodes: 0, edgesAdded: 0, edgesRemoved: 0, durationMs: Date.now() - t0,
      mode, health: 'EMPTY', coverage: { nodes: 0, nodesWithEdges: 0, nodesWithUsage: 0, ratio: 0, usageRatio: 0 },
      edgesByType: {},
    };
    if (c.enabled === false) return { ...empty, skipped: true, reason: 'disabled' };

    try {
      // ① 节点全集：presets/*/skills/*/SKILL.md（§2.1 R8）
      const { nodes: presetNodes, scanFailures } = await scanNodes(resolvePath(c.presetsDir));
      const provisional = await readProvisional();
      const provisionalNodes = provisional
        .filter((p) => !presetNodes.some((n) => n.skillName === p.skillName))
        .map((p) => ({
          skillName: p.skillName, dirName: p.skillName, presets: [], path: null,
          description: '', tools: [], triggers: [], relatedSkills: [], declarations: {},
          createdAt: p.createdAt, provisional: true,
        }));
      const nodes = [...presetNodes, ...provisionalNodes];
      nodeCache = nodes;

      // ② 主口径取数 + 技能级聚合
      const records = await readJsonl(resolvePath(c.toolStatsPath));
      const known = new Set(nodes.map((n) => n.skillName));
      const { calls, skippedNoSkillField, unknownSkillName } = collectSkillCalls(records, {
        lookbackDays: c.lookbackDays, nowMs, knownNames: known,
      });
      const usageMap = aggregateUsage(nodes, calls);
      const statuses = await readCuratorStatuses();

      // ③ 四类边（§3.2）
      const collected = [];
      let droppedRelatedTargets = 0;
      if (c.edgeTypes?.related !== false) {
        const r = buildRelatedEdges(nodes);
        collected.push(...r.edges);
        droppedRelatedTargets = r.droppedRelatedTargets;
      }
      if (c.edgeTypes?.co_use !== false) {
        collected.push(...buildCoUseEdges(calls, { windowMs: c.coUseWindowMs, minSessions: c.coUseMinSessions }));
      }
      if (c.edgeTypes?.similar === true) {
        collected.push(...buildSimilarEdges(nodes, { threshold: c.similarDescThreshold }));
      }
      const computedTypes = new Set(['related', 'co_use', 'similar']);
      if (c.edgeTypes?.overlap !== false && c.overlapOfflineRecompute === true) {
        // 路径 B：回溯历史（阈值引用 curator 常量，不写副本）
        collected.push(...buildOfflineOverlapEdges(
          nodes.map((n) => ({ ...n, state: statuses.get(n.skillName) ?? 'active',
            usage: usageMap.get(n.skillName) ?? { useCount: 0, successRate: null } })),
        ));
        computedTypes.add('overlap');
      }

      const { edges, dropped } = filterValidEdges(dedupe(collected));
      const edgesByType = edges.reduce((m, e) => ({ ...m, [e.type]: (m[e.type] ?? 0) + 1 }), {});
      const coverage = computeCoverage(
        nodes.map((n) => ({ ...n, calls: usageMap.get(n.skillName)?.calls ?? 0 })),
        edges,
        nodes.length,
      );

      // ④ 落盘：标定期**只写 meta**（不写正式数据表）
      let edgesAdded = 0;
      let edgesRemoved = 0;
      if (mode === 'live') {
        const usageTable = await table('usage_stats');
        const existingUsage = new Map(usageTable.entries().map(([, v]) => [v.skillName, v]));
        for (const n of nodes) {
          const u = usageMap.get(n.skillName);
          const ex = existingUsage.get(n.skillName);
          const rec = packUsageStats({
            skillName: n.skillName,
            dirName: n.dirName ?? n.skillName,
            presets: n.presets ?? [],
            status: statuses.get(n.skillName) ?? (n.provisional ? 'provisional' : 'active'),
            calls: u?.calls ?? 0,
            viewCount: null,
            patchCount: null,
            successRate: null,                 // §3.3：取不到就是 null，不编造
            lastUsedAt: u?.lastUsedAt ?? null,
            firstUsedAt: u?.firstUsedAt ?? null,
            firstSeenAt: ex?.firstSeenAt ?? n.createdAt ?? nowIso(),
            qualityRef: ex?.qualityRef ?? null,
            // provisional 节点不入使用统计口径（§3.3「节点与使用的关系」）
            provisional: n.provisional === true,
          }, ex);
          await usageTable.put(rec.id, rec);
        }
        const uw = checkLimit('usage_stats', usageTable.entries().length, c.limits);
        if (uw) console.warn(`[${name}] ${uw._warn}`);

        const edgeTable = await table('skill_edges');
        const newIds = new Set(edges.map((e) => e.edgeId));
        for (const [key, v] of edgeTable.entries()) {
          if (computedTypes.has(v.type) && !newIds.has(v.edgeId)) {
            await edgeTable.del(key).catch(() => {});
            edgesRemoved++;
          }
        }
        for (const e of edges) {
          const hit = edgeTable.entries().find(([k]) => k === e.edgeId);
          await edgeTable.put(e.edgeId, packEdge({ ...e, createdAt: hit?.[1]?.createdAt ?? e.createdAt }));
          if (!hit) edgesAdded++;
        }
        // 标定期缓冲的边（事件驱动）在切 live 后一次性补落
        for (const e of heldEdges.values()) {
          const hit = edgeTable.entries().find(([k]) => k === e.edgeId);
          if (!hit) { await edgeTable.put(e.edgeId, packEdge(e)); edgesAdded++; }
        }
        heldEdges.clear();
        const ew = checkLimit('skill_edges', edgeTable.entries().length, c.limits);
        if (ew) console.warn(`[${name}] ${ew._warn}`);
      } else {
        // 标定期：事件边进缓冲，供计数
        for (const e of heldEdges.values()) edgesAdded++;
      }

      // ⑤ meta：coverage / counters / 标定报告
      //
      // ⚠️ coverage 必须反映**已落盘**的图，不是"若转 live 会得到什么"的投影：
      // 标定期正式表是空的 → coverage.ratio 必须为 0、health 必须 EMPTY。
      // 投影只出现在 lastCalibration 里（§5.3），两者不可混为一谈，否则就是"用预期值
      // 让空图看起来有内容"——正是 §4.3 不变量 6 禁止的事。
      const allEdges = mode === 'live' ? edges : [];
      const liveCoverage = computeCoverage(
        nodes.map((n) => ({ ...n, calls: usageMap.get(n.skillName)?.calls ?? 0 })),
        allEdges,
        nodes.length,
      );
      const health = computeHealth(allEdges, liveCoverage);
      const projected = mode === 'live' ? edges : [...edges, ...heldEdges.values()];
      const calibration = {
        week: isoWeek(new Date(nowMs)),
        ranAt: nowIso(),
        nodes: nodes.length,
        edges: projected.length,
        edgesByType: projected.reduce((m, e) => ({ ...m, [e.type]: (m[e.type] ?? 0) + 1 }), {}),
        // §5.3 切档凭证：有节点且有边才"可转 live"
        promotable: nodes.length > 0 && projected.length > 0,
        provisionalNodes: provisionalNodes.length,
        skippedNoSkillField,
        unknownSkillName,
      };
      await patchMeta({
        mode,
        lastFullScanAt: nowIso(),
        lastCuratorRunAt,
        coverage: liveCoverage,
        counters: {
          scanFailures,
          droppedEdges: dropped,
          skippedNoSkillField,
          droppedRelatedTargets,
          unknownSkillName,
        },
        lastCalibration: calibration,
      });
      lastRunAt = nowIso();
      dirty = false;

      await publishEvent('skill-graph.updated', {
        nodes: nodes.length, edges: allEdges.length, coverage: liveCoverage, health,
      });

      return {
        nodes: nodes.length,
        edgesAdded,
        edgesRemoved,
        durationMs: Date.now() - t0,
        mode,
        health,
        coverage: liveCoverage,
        edgesByType: calibration.edgesByType,
        dropped,
        droppedRelatedTargets,
        scanFailures,
        calibration,
      };
    } catch (err) {
      // 不变量 1：fail-open —— 永不 throw，counters 留痕
      if (!disposed) console.error(`[${name}] updateFull failed:`, err?.message ?? err);
      try { await bumpCounter('scanFailures'); } catch { /* 域都挂了就只能放弃 */ }
      return { ...empty, error: String(err?.message ?? err) };
    }
  }

  // ── 读路径（FROZEN Service）────────────────────────────────────────────

  async function loadGraph() {
    const usageTable = await table('usage_stats');
    const edgeTable = await table('skill_edges');
    const usageList = usageTable.entries().map(([, v]) => v);
    const edges = edgeTable.entries().map(([, v]) => v);
    return { usageList, edges };
  }

  /** 无正式数据时用内存节点 + 标定期缓冲画像（保证"空图也响，但不合成数据"） */
  async function loadGraphWithFallback() {
    const g = await loadGraph();
    if (g.edges.length || g.usageList.length) return g;
    const nodes = await ensureNodes();
    return { usageList: nodes.map((n) => ({ skillName: n.skillName, calls: 0, lastUsedAt: null, successRate: null })), edges: [...heldEdges.values()] };
  }

  async function ensureNodesForQuery() {
    if (nodeCache.length) return nodeCache;
    const { nodes } = await scanNodes(resolvePath(effectiveConfig().presetsDir));
    nodeCache = nodes;
    return nodes;
  }

  // ── Service 出口 ───────────────────────────────────────────────────────

  async function getStatsImpl(skillName) {
    if (!skillName) return null;
    try {
      const { usageList } = await loadGraph();
      return usageList.find((u) => u.skillName === skillName) ?? null;
    } catch { return null; }
  }

  async function neighborsImpl(skillName, opts = {}) {
    try {
      const { edges } = await loadGraphWithFallback();
      return neighborsOf(edges, skillName, opts);
    } catch { return []; }
  }

  async function clustersImpl(opts = {}) {
    try {
      const { edges } = await loadGraphWithFallback();
      return clustersOf(edges, opts);
    } catch { return []; }
  }

  async function recommendImpl(args = {}) {
    try {
      const { usageList, edges } = await loadGraphWithFallback();
      const nodes = await ensureNodesForQuery();
      const meta = await readMeta();
      return recommendOf(args, {
        nodes, usageList, edges,
        weights: effectiveConfig().recommendWeights,
        halfLifeDays: effectiveConfig().recencyHalfLifeDays,
        lastFullScanAt: meta.lastFullScanAt,
        // 调用方可覆盖（实验性 score 模式）；默认走 config.recommendMode = 'list'
        mode: args.mode ?? effectiveConfig().recommendMode,
      });
    } catch (err) {
      return {
        items: [], status: 'INSUFFICIENT_DATA', degraded: true,
        degradedReason: `internal error: ${String(err?.message ?? err)}`,
        health: 'EMPTY', stale: true, unavailableTerms: [], coverage: { nodes: 0 },
      };
    }
  }

  async function listForPromptImpl(args = {}) {
    const r = await recommendImpl({ ...args, context: args.context ?? {} });
    const limit = Number(args.limit) > 0 ? Number(args.limit) : 50;
    return { skills: r.items.slice(0, limit), status: r.status, degraded: r.degraded, stale: r.stale };
  }

  async function getCoverageImpl() {
    try {
      const { usageList, edges } = await loadGraphWithFallback();
      const nodes = await ensureNodesForQuery();
      const meta = await readMeta();
      const effectiveNodes = usageList.length > 0 ? usageList : nodes;
      const coverage = usageList.length > 0
        ? (meta.coverage ?? computeCoverage(usageList, edges, effectiveNodes.length))
        : computeCoverage(effectiveNodes, edges, nodes.length);
      const health = computeHealth(edges, coverage);
      const byType = EDGE_TYPES.reduce((m, t) => ({ ...m, [t]: edges.filter((e) => e.type === t).length }), {});
      return {
        nodes: coverage.nodes,
        edges: edges.length,
        edgesByType: byType,
        coverage,
        health,                                   // EMPTY / SPARSE / OK —— 空图必须显式
        mode: currentMode(),
        signature: {
          // §12.5 开放问题 6：全收节点是有意选择，故暴露两个分母
          nodesWithEdges: coverage.nodesWithEdges,
          nodesWithUsage: coverage.nodesWithUsage,
        },
        // §3.2：声明型边（related）不依赖流量，计算型边（overlap/co_use）依赖真实使用
        declared: { related: byType.related },
        computed: { overlap: byType.overlap, co_use: byType.co_use, similar: byType.similar },
        lastFullScanAt: meta.lastFullScanAt ?? null,
        lastCuratorRunAt: meta.lastCuratorRunAt ?? null,
        stale: isStale(meta.lastFullScanAt),
        counters: meta.counters ?? {},
        lastCalibration: meta.lastCalibration ?? null,
        provisionalNodes: (meta.provisionalNodes ?? []).length,
      };
    } catch (err) {
      return {
        nodes: 0, edges: 0, edgesByType: {}, health: 'EMPTY', mode: currentMode(),
        coverage: { nodes: 0, nodesWithEdges: 0, nodesWithUsage: 0, ratio: 0, usageRatio: 0 },
        stale: true, counters: {}, error: String(err?.message ?? err),
      };
    }
  }

  const service = {
    /** 周更全量刷新（cron 驱动）；**永不 throw**（fail-open，同 P2-1） */
    updateFull,

    /** 单技能统计；无数据 → null（不编造） */
    getStats: getStatsImpl,

    /** 邻居查询（带证据） */
    neighbors: neighborsImpl,

    /** 重叠/关系簇（连通分量）。⚠️ FROZEN 默认 type='overlap'；v0.3 起首选边是 related */
    clusters: clustersImpl,

    /** 意图→技能；冷启动显式降级（Q5）。主方案 recommendation=list（不打分） */
    recommend: recommendImpl,

    /** §六 v0.3 主方案：返回列表不打分（排序交给调用方） */
    listForPrompt: listForPromptImpl,

    /** 全局健康度（含 coverage 空图指标 + health=EMPTY） */
    getCoverage: getCoverageImpl,

    // ── 非 FROZEN（观察期后转正；§4.2）──────────────────────────────────

    /** 导出 DOT（人看）/ JSONL（程序读）；落 runtime 导出目录（gitignored） */
    async exportGraph(opts = {}) {
      const format = opts.format === 'jsonl' ? 'jsonl' : 'dot';
      const { usageList, edges } = await loadGraph();
      const dir = resolvePath(opts.dir ?? effectiveConfig().exportDir);
      await mkdir(dir, { recursive: true });
      const file = join(dir, `skill-graph.${format}`);
      const body = format === 'dot'
        ? `digraph skill_graph {\n  rankdir=LR;\n`
          + usageList.map((u) => `  "${u.skillName}" [label="${u.skillName}\\n${u.status}"];`).join('\n')
          + (edges.length ? '\n' : '')
          + edges.map((e) => `  "${e.src}" -> "${e.dst}" [label="${e.type}" weight=${e.weight}];`).join('\n')
          + `\n}\n`
        : `${edges.map((e) => JSON.stringify(e)).join('\n')}\n`;
      await writeFile(file, body, 'utf8');
      return { path: file, format, edges: edges.length, nodes: usageList.length, bytes: Buffer.byteLength(body) };
    },

    /**
     * 把整合候选**提交给既有提案通道**（agint.evolve.propose），不直接执行。
     * 执行权归 curator + 老板（§2.2「图谱只建议整合」）。
     */
    async proposeConsolidate(clusterId) {
      if (!clusterId) throw new Error('proposeConsolidate: clusterId is required');
      const groups = clustersOf((await loadGraphWithFallback()).edges, { types: ['related', 'overlap'], minSize: 2 });
      const hit = groups.find((g) => g.clusterId === clusterId);
      if (!hit) throw new Error(`proposeConsolidate: cluster not found: ${clusterId}`);
      const evolve = typeof ctx.get === 'function' ? ctx.get('agint.evolve') : null;
      if (!evolve || typeof evolve.propose !== 'function') {
        throw new Error('proposeConsolidate: agint.evolve.propose not available');
      }
      const rec = await evolve.propose({
        title: `技能整合候选：${hit.members.join(' / ')}`,
        body: `P2-2 图谱检出关系簇（clusterId=${clusterId}，${hit.members.length} 个成员）。\n\n`
          + `证据（每条边都可审计）：\n${hit.evidence.map((e) => `- [${e.type}] ${e.edgeId} (w=${e.weight}) ${JSON.stringify(e.evidence)}`).join('\n')}\n\n`
          + `注：本提案只是"建议"，整合的执行权归 curator + 老板（不变量 4：图谱不进决策）。`,
        category: 'skill',
        source: 'agint-skill-graph',
      });
      return { proposalId: rec.id, clusterId, members: hit.members };
    },

    /** Sprint 20 LLM 离线标注开关（默认 false，需单独拍板） */
    async setLlmAnnotation(enabled) {
      runtimeOverrides.set('llmAnnotation', enabled === true);
      await patchMeta({ llmAnnotation: enabled === true });
      return { llmAnnotation: enabled === true, note: 'Sprint 20 观察项；默认关，开之前先补齐 SKILL.md 元数据' };
    },

    /**
     * 切档：未跑过标定期就切 live → **抛错**（§5.3，对齐 P2-1 不变量）。
     */
    async setMode(mode) {
      if (mode !== 'live' && mode !== 'count-only') throw new Error(`setMode: invalid mode ${mode}`);
      if (mode === 'live') {
        const meta = await readMeta();
        if (!meta.lastCalibration) {
          throw new Error(`${name}: 必须先跑过 count-only 标定期才能切 live（setMode('live') 拒绝）`);
        }
      }
      runtimeOverrides.set('mode', mode);
      await patchMeta({ mode });
      return { mode };
    },

    /** 无参 = 读生效配置；带 patch = 改运行时子集（内存态） */
    config(patch) {
      if (patch == null) {
        return { ...effectiveConfig(), overrides: Object.fromEntries(runtimeOverrides) };
      }
      const allowed = new Set(RUNTIME_CONFIG_KEYS);
      for (const [k, v] of Object.entries(patch)) {
        if (!allowed.has(k) || v === undefined) continue;
        runtimeOverrides.set(k, v);
      }
      return { ...effectiveConfig(), overrides: Object.fromEntries(runtimeOverrides) };
    },

    async stats() {
      const cov = await getCoverageImpl();
      return {
        ...cov,
        lastRunAt,
        dirty,
        heldEdges: heldEdges.size,
        config: {
          presetsDir: effectiveConfig().presetsDir,
          toolStatsPath: effectiveConfig().toolStatsPath,
          mode: currentMode(),
          edgeTypes: effectiveConfig().edgeTypes,
          recommendMode: effectiveConfig().recommendMode,
          weights: effectiveConfig().recommendWeights ?? DEFAULT_WEIGHTS,
          weeklyCron: effectiveConfig().weeklyCron,
        },
        sprint: '19-skill-graph',
      };
    },
  };

  ctx.provide('agint.skillGraph', service);
}

export { ConfigSchema, apply, inject, name };
