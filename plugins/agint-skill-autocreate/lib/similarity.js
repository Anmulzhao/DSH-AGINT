/**
 * lib/similarity.js — Sprint 15 T5 候选去重（设计稿 T5）
 *
 * 与现有技能列表比对：归一化名字相等 或 编辑距离相似度 ≥ threshold（默认 0.9）
 * → 判重（Phase 1 前置拒绝，省评估资源，避免重复技能涌入队列）。
 *
 * 比对对象：host 侧 `ctx.get('skills').list()` 返回的技能名（既有注册技能）。
 * 纯函数，无 I/O，便于单测。
 */

/** 归一化：小写 + 去空白 + 去非字母数字（保留 CJK） */
export function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[\s\-_.]+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** 编辑距离（Levenshtein），O(mn) 滚动数组 */
export function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1);
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

/** 归一化编辑距离相似度：1 - dist / max(len)（任一侧空 → 0） */
export function nameSimilarity(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  const dist = levenshtein(na, nb);
  return 1 - dist / Math.max(na.length, nb.length);
}

/**
 * 判重：candidateName 与 existingNames 中任一 ≥ threshold → 命中。
 * @returns {{ duplicate: boolean, matchedName: string|null, similarity: number|null }}
 */
export function isDuplicate(candidateName, existingNames, threshold = 0.9) {
  const cand = normalizeName(candidateName);
  if (!cand) return { duplicate: false, matchedName: null, similarity: null };
  for (const name of existingNames ?? []) {
    const sim = nameSimilarity(cand, name);
    if (sim >= threshold) {
      return { duplicate: true, matchedName: name, similarity: sim };
    }
  }
  return { duplicate: false, matchedName: null, similarity: null };
}
