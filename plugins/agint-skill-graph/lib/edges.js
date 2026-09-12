/**
 * agint-skill-graph: 四类边（P2-2 §3.2 v0.3/v0.4）。
 *
 *   related  ← frontmatter `related_skills` **声明**（路径 0，首选，零计算、零阈值、零 LLM）
 *   overlap  ← 订阅 `curator.overlap-detected`（路径 A）；回溯历史时 `overlapOf()` 重算（路径 B）
 *   co_use   ← 同会话 30min 窗口共现 ≥3 次（自算）
 *   similar  ← 元数据相似（**默认关**：实测描述维最高相似度 0.201，0.70 阈值为空集 → Sprint 20 观察项）
 *
 * 取舍（§3.2）：P2-2 **不重新实现**重叠判定 —— 日常走事件、回溯走 curator 已导出的纯函数，
 * 阈值常量**引用不复制**（`OVERLAP_THRESHOLDS` 从 agint-curator 引入）。
 */

import { detectOverlaps, descSimilarity, OVERLAP_THRESHOLDS } from '../../agint-curator/lib/dedup.js';
import {
  CONFIDENCE_BY_TYPE,
  THRESHOLDS,
  makeEdgeId,
  normalizePair,
  validateEdge,
} from './schema.js';

function edge(type, a, b, weight, evidence, extra = {}) {
  const [src, dst] = normalizePair(a, b);
  return {
    edgeId: makeEdgeId(type, src, dst),
    src,
    dst,
    type,
    // 权重按 3 位小数落盘（与 curator dedup 的 round3 口径一致，避免浮点长尾）
    weight: +Math.max(0, Math.min(1, weight)).toFixed(3),
    evidence,
    confidence: CONFIDENCE_BY_TYPE[type],
    createdAt: new Date().toISOString(),
    supersededBy: null,
    ...extra,
  };
}

/** 按 edgeId 去重（同一条边被多路径命中时保留先到者） */
function dedupe(edges) {
  const m = new Map();
  for (const e of edges) if (!m.has(e.edgeId)) m.set(e.edgeId, e);
  return [...m.values()];
}

// ── 路径 0：related（声明式，首选）──────────────────────────────────────

/**
 * @param {Array} nodes  scanNodes 输出
 * @returns {{ edges: Array, droppedRelatedTargets: number }}
 */
export function buildRelatedEdges(nodes) {
  const names = new Set(nodes.map((n) => n.skillName));
  const declaredBy = new Map(nodes.map((n) => [n.skillName, new Set(n.relatedSkills ?? [])]));
  const out = [];
  let dropped = 0;

  for (const n of nodes) {
    for (const target of n.relatedSkills ?? []) {
      if (typeof target !== 'string' || !target || target === n.skillName) continue;
      // 目标端无需反向声明；目标不存在 → 丢弃并计数（不静默）
      if (!names.has(target)) { dropped++; continue; }
      const declaredIn = pickDeclaredIn(n, target);
      out.push(edge('related', n.skillName, target, 1, {
        method: 'declared',
        field: 'related_skills',
        declaredIn,
        declaredAt: n.createdAt ?? null,
        // 双向一致性检查：A 声明 B 而 B 未声明 A → 保留边但记 asymmetric（单向声明是合法表达）
        declaredBack: declaredBy.get(target)?.has(n.skillName) === true,
      }, { asymmetric: declaredBy.get(target)?.has(n.skillName) !== true }));
    }
  }
  return { edges: dedupe(out), droppedRelatedTargets: dropped };
}

function pickDeclaredIn(node, target) {
  for (const [path, list] of Object.entries(node.declarations ?? {})) {
    if (Array.isArray(list) && list.includes(target)) return path;
  }
  return node.path ?? '';
}

// ── 路径 A：overlap 边（订阅 curator.overlap-detected）────────────────────

/**
 * 归一化 curator 事件载荷 → 边。
 * 载荷实测（curator lib/index.js:201）：
 *   { skillA, skillB, similarity: {desc,tools,triggers,descHit,toolsHit,triggersHit,dimsMet} }
 * @returns {object|null} 载荷不合法 / 节点不存在 → null（调用方计入 counters.droppedEdges）
 */
export function overlapEdgeFromEvent(payload, knownNames) {
  const a = payload?.skillA;
  const b = payload?.skillB;
  const sim = payload?.similarity;
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b || a === b) return null;
  if (!sim || typeof sim !== 'object') return null;
  const known = knownNames instanceof Set ? knownNames : new Set(knownNames ?? []);
  if (known.size && (!known.has(a) || !known.has(b))) return null;
  const dimsMet = Number(sim.dimsMet) || 0;
  return edge('overlap', a, b, dimsMet / 3, {
    method: 'curator-event',
    skillA: a,
    skillB: b,
    similarity: { ...sim },
    source: 'curator.overlap-detected',
    detectedAt: new Date().toISOString(),
  });
}

/**
 * 路径 B：离线重算（只在需要回溯历史时用）。
 * 复用 curator 的纯函数 `detectOverlaps` + `OVERLAP_THRESHOLDS`（**引用不复制**）。
 */
export function buildOfflineOverlapEdges(subjects, opts = {}) {
  const pairs = detectOverlaps(subjects, {
    thresholds: opts.thresholds ?? OVERLAP_THRESHOLDS,
    includeStates: opts.includeStates,
  });
  return pairs.map((p) => edge('overlap', p.skillA, p.skillB, (p.dims?.dimsMet ?? 0) / 3, {
    method: 'curator-recompute',
    skillA: p.skillA,
    skillB: p.skillB,
    similarity: { ...p.dims },
    source: 'offline-recompute',
    detectedAt: new Date().toISOString(),
  }));
}

// ── co_use：同会话窗口共现 ───────────────────────────────────────────────

/**
 * @param {Array<{ts,sessionId,skillName}>} calls collectSkillCalls 输出
 * @returns {Array} 边（同窗口共现 ≥ minSessions 个**不同会话**才建边）
 */
export function buildCoUseEdges(calls, opts = {}) {
  const windowMs = opts.windowMs ?? THRESHOLDS.CO_USE_WINDOW_MS;
  const minSessions = opts.minSessions ?? THRESHOLDS.CO_USE_MIN_SESSIONS;

  // sessionId → 该会话内所有 skill 调用
  const bySession = new Map();
  for (const c of calls ?? []) {
    if (!c.sessionId || !c.skillName) continue;
    if (!bySession.has(c.sessionId)) bySession.set(c.sessionId, []);
    bySession.get(c.sessionId).push(c);
  }

  // pair → Set(sessionId)（同一会话内多次共现只算一次，防"一个长会话刷满阈值"）
  const pairSessions = new Map();
  for (const [sid, list] of bySession) {
    const sorted = [...list].sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].ts - sorted[i].ts > windowMs) break;      // 窗口外，后面的更远
        if (sorted[i].skillName === sorted[j].skillName) continue;
        const [a, b] = normalizePair(sorted[i].skillName, sorted[j].skillName);
        const key = `${a}\u0000${b}`;
        if (!pairSessions.has(key)) pairSessions.set(key, { a, b, sessions: new Set() });
        pairSessions.get(key).sessions.add(sid);
      }
    }
  }

  const out = [];
  for (const { a, b, sessions } of pairSessions.values()) {
    if (sessions.size < minSessions) continue;
    out.push(edge('co_use', a, b, Math.min(1, sessions.size / (minSessions * 2)), {
      method: 'session-cooccurrence',
      sessions: sessions.size,
      window: `${Math.round(windowMs / 60000)}m`,
      sessionIds: [...sessions].slice(0, 20), // 保留样例会话 ID 供人工复核
    }));
  }
  return dedupe(out);
}

// ── similar：元数据相似（默认关）─────────────────────────────────────────

/**
 * 阈值与 overlap 的 desc 维**分开定**（不得复用 0.85 造成语义混淆）。
 * v0.3 结论：实测 11 技能 55 对全量描述相似度最高 0.201 → 本函数当前恒返回 []
 * （不是 bug，是算术结果；阈值可经 config 下调做观察）。
 */
export function buildSimilarEdges(nodes, opts = {}) {
  const threshold = opts.threshold ?? THRESHOLDS.SIMILAR_DESC;
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const jac = descSimilarity(a.description ?? '', b.description ?? '');
      if (jac < threshold) continue;
      out.push(edge('similar', a.skillName, b.skillName, jac, {
        method: 'metadata',
        fields: ['description'],
        jaccard: +jac.toFixed(3),
      }));
    }
  }
  return out;
}

// ── 统一出口 ─────────────────────────────────────────────────────────────

/**
 * 过滤非法边（不变量 2：evidence 缺失 / 类型未知 / 自环 → 丢弃并计数）。
 * @returns {{ edges: Array, dropped: number, reasons: string[] }}
 */
export function filterValidEdges(edges) {
  const ok = [];
  const reasons = [];
  for (const e of edges) {
    const v = validateEdge(e);
    if (v.ok) ok.push(e);
    else reasons.push(`${e?.edgeId ?? '?'}: ${v.reason}`);
  }
  return { edges: ok, dropped: reasons.length, reasons };
}

export { OVERLAP_THRESHOLDS, dedupe };
