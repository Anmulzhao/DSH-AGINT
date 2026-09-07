/**
 * agint-skill-autocreate: detector — 重复任务模式检测。
 *
 * 设计稿 §3.1 [3]：
 *   - 匹配规则：工具组合序列相同 + 参数结构相似度 ≥0.8 → 同一模式
 *   - 同一模式累计次数 ≥3 → 标记为「重复模式」
 *   - 重复模式写入 task_patterns 表
 *
 * 纯函数模块，无 I/O。existingPatterns 为已入库 pattern 的业务字段数组。
 */

import { signatureOf } from './aggregator.js';

/**
 * 参数结构相似度：两个 paramSignature map（tool → sig）的加权 Jaccard。
 * - 只在两边共有的工具上比较签名 token 集合的 Jaccard
 * - 工具集合本身不一致时按共有工具比例折减
 * 返回 [0,1]。
 */
export function paramSimilarity(sigA, sigB) {
  const toolsA = Object.keys(sigA ?? {});
  const toolsB = Object.keys(sigB ?? {});
  if (!toolsA.length || !toolsB.length) return 0;
  const setB = new Set(toolsB);
  const shared = toolsA.filter((t) => setB.has(t));
  if (!shared.length) return 0;
  const toolCoverage = shared.length / new Set([...toolsA, ...toolsB]).size;
  let sum = 0;
  for (const t of shared) {
    sum += jaccard(tokenize(sigA[t]), tokenize(sigB[t]));
  }
  return +((sum / shared.length) * (0.5 + 0.5 * toolCoverage)).toFixed(4);
}

function tokenize(sig) {
  return new Set(String(sig ?? '').split('|').flatMap((part) => part.split(':')));
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  const inter = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union ? inter / union : 0;
}

/** 工具序列是否相同（设计稿：「工具组合序列相同」——严格全等） */
export function sequenceEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((t, i) => t === b[i]);
}

/**
 * 模式检测主入口。
 *
 * opts:
 *   existingPatterns : 已入库 pattern 业务字段数组（含 id/统计）
 *   minOccurrence    : 重复判定阈值（默认 3）
 *   similarityThreshold : 参数相似度阈值（默认 0.8）
 *   nowMs            : 时间基准
 *
 * 返回 { upserts, newRepeat }：
 *   upserts    : 本次要写入/更新的 pattern 业务字段数组（不含 storage metadata）
 *   newRepeat  : 其中「本次跨过 minOccurrence 门槛」的 pattern（发事件用）
 */
export function detectPatterns(taskInstances, opts = {}) {
  const minOccurrence = opts.minOccurrence ?? 3;
  const simThreshold = opts.similarityThreshold ?? 0.8;
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const existing = Array.isArray(opts.existingPatterns) ? opts.existingPatterns : [];

  // 已有 pattern 的工作副本（按 id 索引；保持入库统计可累计）
  const byId = new Map(existing.map((p) => [p.id, { ...p }]));
  // 本次新增（内存中累计，同一批内相同序列的任务也互相合并）
  const batchNew = [];

  function findMatch(task) {
    for (const p of byId.values()) {
      if (sequenceEqual(p.toolSequence, task.toolSequence)
        && paramSimilarity(p.paramSignature, task.paramSignature) >= simThreshold) {
        return p;
      }
    }
    for (const p of batchNew) {
      if (sequenceEqual(p.toolSequence, task.toolSequence)
        && paramSimilarity(p.paramSignature, task.paramSignature) >= simThreshold) {
        return p;
      }
    }
    return null;
  }

  const crossed = new Set();

  for (const task of taskInstances) {
    if (!task?.toolSequence?.length) continue;
    let p = findMatch(task);
    const wasBelow = p ? p.occurrenceCount < minOccurrence : false;
    if (!p) {
      p = {
        toolSequence: task.toolSequence,
        paramSignature: task.paramSignature,
        description: describe(task),
        occurrenceCount: 0,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        avgDurationMs: task.durationMs ?? null,
        avgTokenCost: null,
        successRate: task.successRate,
        status: 'active',
        standardizable: null,
        standardizableConfidence: null,
        linkedCandidateId: null,
        _isNew: true,
      };
      batchNew.push(p);
    } else {
      // 增量更新统计（ occurrence 累计；均值滚动；firstSeen 保留旧值）
      p.avgDurationMs = p.avgDurationMs == null && task.durationMs == null
        ? null
        : Math.round(((p.avgDurationMs ?? 0) * p.occurrenceCount + (task.durationMs ?? 0)) / (p.occurrenceCount + 1));
      p.successRate = +(((p.successRate * p.occurrenceCount + task.successRate) / (p.occurrenceCount + 1))).toFixed(4);
      p.lastSeenAt = nowIso;
    }
    p.occurrenceCount += 1;
    if ((wasBelow || p._isNew) && p.occurrenceCount >= minOccurrence) crossed.add(p);
  }

  // 标记 dirty：被命中的 existing（occurrence 变了）才需要回写。
  const inCount = new Map(existing.map((p) => [p.id, p.occurrenceCount]));
  for (const p of byId.values()) {
    delete p._isNew;
    if (inCount.get(p.id) !== p.occurrenceCount) p._dirty = true;
  }
  const dirtyExisting = [...byId.values()]
    .filter((p) => p._dirty)
    .map((p) => { const { _dirty, ...rest } = p; return rest; });
  const newBusiness = batchNew.map((p) => { const { _isNew, ...rest } = p; return rest; });

  return {
    upserts: [...dirtyExisting, ...newBusiness],
    newRepeat: [...crossed],
  };
}

/** 模式描述：人类可读一句话（给老板/周复盘看） */
export function describe(task) {
  const seq = task.toolSequence.join(' → ');
  const argKeys = Object.entries(task.sampleArgs ?? {})
    .map(([tool, args]) => (args && typeof args === 'object' ? Object.keys(args) : []))
    .flat()
    .filter(Boolean);
  const keys = [...new Set(argKeys)].slice(0, 4).join('/');
  return keys ? `${seq}（参数：${keys}）` : seq;
}

/** 给 detector 测试/补跑用：把 args 转签名的转发导出 */
export { signatureOf };
