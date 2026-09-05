/**
 * agint-dream: short-term recall store（JSONL，append-only）
 *
 * 设计见 AGINT/决策-p2-recall-store选型论证.md（4 道关 + 决策矩阵 + 容错设计）
 *
 * 关键决策：
 * - JSONL append-only（不 fsync，跟 agint-tool-stats 一致）
 * - 路径 ~/.dsh/storages/agint_dream_recall.jsonl（跟 tool-stats 同目录规范）
 * - 读时丢弃尾部不合法 JSON 行（partial write 保护）
 * - dedupe 用 in-memory Map<key, mergedEntry>
 * - 30 天剪枝：保留 promotedAt != null + 近期 entry
 *
 * entry shape：
 *   {
 *     version: 1,
 *     key: 'sha256-normalized-text',
 *     path: 'memory/2026-09-04.md',
 *     startLine: 5,
 *     endLine: 7,
 *     snippet: '老板是创造者',
 *     recallCount: 3,
 *     dailyCount: 1,
 *     groundedCount: 0,
 *     queryHashes: ['hash1'],
 *     recallDays: ['2026-09-03', '2026-09-04'],
 *     lastRecalledAt: '2026-09-04T12:34:56.000Z',
 *     promotedAt: null | '2026-09-05T...',
 *     lineageKey: null | 'string',  // P0 schema 共享
 *     supersedesKey: null | 'string',  // P0 schema 共享
 *     createdAt: '2026-09-03T...',
 *   }
 */

import { createHash } from 'node:crypto';
import { appendFile, readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const RECALL_STORE_VERSION = 1;
export const RECALL_STORE_FILENAME = 'agint_dream_recall.jsonl';
const DAY_MS = 24 * 60 * 60 * 1000;

/** 选 path — 跟 agint-tool-stats 同目录规范。 */
export function defaultRecallPath(home = process.env.DSH_HOME || (process.env.HOME + '/.dsh')) {
  return join(resolve(home), 'storages', RECALL_STORE_FILENAME);
}

/** sha256(normalized text) — dedupe key。 */
export function recallKey(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** 规范化用于 dedupe 跟 token overlap。 */
function normalizeForCompare(text) {
  return String(text || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '').slice(0, 4096);
}

/** 一次 sweep 写入一条 entry。appendFile，不 fsync。 */
export async function appendEntry(path, entry) {
  const record = {
    version: RECALL_STORE_VERSION,
    ...entry,
    createdAt: entry.createdAt ?? new Date().toISOString(),
  };
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(record) + '\n', 'utf8');
  return record;
}

/**
 * 读整个 store，做容错：尾部 partial JSON 行被丢弃（不抛）。
 * 同步返回 dedupe 后的 Map<key, mergedEntry>。
 *
 * dedupe 策略：同 key 的多个 entry 合并：
 * - recallCount / dailyCount / groundedCount 求和
 * - queryHashes / recallDays 合并去重
 * - lastRecalledAt 取 max
 * - promotedAt 一旦非 null 不再被 null 覆盖
 * - lineageKey / supersedesKey：第一次出现的非空值（按时间顺序）
 */
export async function readStoreRobust(path, nowMs = Date.now()) {
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { entries: new Map(), skippedPartial: 0, totalLines: 0 };
    throw err;
  }
  const lines = text.split('\n');
  const entries = new Map();
  let skippedPartial = 0;
  let totalLines = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    totalLines += 1;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      // 尾部 partial line 保护
      if (i === lines.length - 1) {
        skippedPartial += 1;
        continue;
      }
      // 中间非法行：保守记入 skipped，不阻断 sweep
      skippedPartial += 1;
      continue;
    }
    if (!record || !record.key) {
      skippedPartial += 1;
      continue;
    }
    const existing = entries.get(record.key);
    if (!existing) {
      entries.set(record.key, record);
      continue;
    }
    // 合并：existing 是累积状态（可能已经携带上次 sweep 的 promotedAt / lineageKey 等）
    // record 是当前 sweep 的新信号
    // 关键：lineage / promotedAt / supersedesKey 是"已经定性"的字段，
    // 如果 existing 有值（truthy），应保留；record 有值则升级；都不为 null 才覆盖
    if (existing.promotedAt && !record.promotedAt) {
      // existing 已经有 promotedAt，record 没有 — 保留 existing 的
      // (do nothing)
    } else if (record.promotedAt) {
      existing.promotedAt = record.promotedAt;
    }
    if (existing.lineageKey && !record.lineageKey) {
      // 保留
    } else if (record.lineageKey) {
      existing.lineageKey = record.lineageKey;
    }
    if (existing.supersedesKey && !record.supersedesKey) {
      // 保留
    } else if (record.supersedesKey) {
      existing.supersedesKey = record.supersedesKey;
    }
    // 累加字段
    existing.recallCount = (existing.recallCount || 0) + (record.recallCount || 0);
    existing.dailyCount = (existing.dailyCount || 0) + (record.dailyCount || 0);
    existing.groundedCount = (existing.groundedCount || 0) + (record.groundedCount || 0);
    existing.queryHashes = uniqueStrings([...(existing.queryHashes || []), ...(record.queryHashes || [])]);
    existing.recallDays = uniqueStrings([...(existing.recallDays || []), ...(record.recallDays || [])]).sort();
    if (record.lastRecalledAt && (!existing.lastRecalledAt || record.lastRecalledAt > existing.lastRecalledAt)) {
      existing.lastRecalledAt = record.lastRecalledAt;
    }
  }
  return { entries, skippedPartial, totalLines };
}

function uniqueStrings(arr) {
  return [...new Set(arr.filter((s) => typeof s === 'string' && s.length > 0))];
}

/** 30 天剪枝：保留 promotedAt != null + 近期 entry；其余剪掉。 */
export async function pruneStore(path, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const retentionDays = opts.retentionDays ?? 30;
  const cutoffMs = nowMs - retentionDays * DAY_MS;
  const { entries } = await readStoreRobust(path, nowMs);
  const kept = [];
  for (const e of entries.values()) {
    if (e.promotedAt) {
      kept.push(e);
      continue;
    }
    const lastMs = e.lastRecalledAt ? Date.parse(e.lastRecalledAt) : 0;
    if (Number.isFinite(lastMs) && lastMs >= cutoffMs) {
      kept.push(e);
    }
    // 其它（无 promotedAt 且 lastRecalledAt 超 cutoff）丢弃
  }
  // 整体重写（接受 sweep 期间并发读阻塞）
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
  return { kept: kept.length, dropped: entries.size - kept.length };
}

/** 把 candidate 列表写入 store（带 dedupe-aware 累加）。 */
export async function recordRecalls(path, candidates, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const dayBucket = opts.dayBucket ?? new Date(nowMs).toISOString().slice(0, 10);
  const existing = await readStoreRobust(path, nowMs);
  const writes = [];
  for (const c of candidates) {
    if (!c || !c.text) continue;
    const key = c.key ?? recallKey(normalizeForCompare(c.text));
    const prior = existing.entries.get(key);
    const entry = {
      key,
      path: c.path ?? null,
      startLine: c.startLine ?? null,
      endLine: c.endLine ?? null,
      snippet: (c.text || '').slice(0, 280),
      recallCount: c.signalCount ?? 1,
      dailyCount: c.dailyCount ?? 0,
      groundedCount: c.groundedCount ?? 0,
      queryHashes: c.queryHashes ?? [],
      recallDays: c.days ? [...new Set(c.days)].sort() : [dayBucket],
      lastRecalledAt: new Date(nowMs).toISOString(),
      promotedAt: prior?.promotedAt ?? null,
      lineageKey: prior?.lineageKey ?? null,
      supersedesKey: prior?.supersedesKey ?? null,
      sourceType: c.type ?? null,
      score: c.score ?? null,
    };
    writes.push(entry);
  }
  for (const entry of writes) {
    await appendEntry(path, entry);
  }
  return { appended: writes.length, skippedPartial: existing.skippedPartial };
}

/** 标记一个 key 已经被 promote。 */
export async function markPromoted(path, key, opts = {}) {
  if (!key) return false;
  const { entries, skippedPartial, totalLines } = await readStoreRobust(path);
  const existing = entries.get(key);
  if (!existing) {
    // promote 一个不存在的 key：单独 append 一行（避免遗漏）
    await appendEntry(path, {
      key,
      promotedAt: new Date(opts.nowMs ?? Date.now()).toISOString(),
      snippet: opts.snippet ?? null,
    });
    return true;
  }
  existing.promotedAt = new Date(opts.nowMs ?? Date.now()).toISOString();
  // 重写整个文件（接受阻塞）
  const allEntries = [...entries.values()];
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, allEntries.map((e) => JSON.stringify(e)).join('\n') + (allEntries.length ? '\n' : ''), 'utf8');
  return { rewritten: true, total: totalLines, skippedPartial };
}

/** 列出所有 promotedAt != null 的 key。 */
export async function listPromotedKeys(path) {
  const { entries } = await readStoreRobust(path);
  return [...entries.values()].filter((e) => e.promotedAt).map((e) => e.key);
}

/** 给一组候选做"已被 promoted 则跳过"的过滤。 */
export function filterUnpromoted(candidates, storeEntries) {
  return candidates.filter((c) => {
    if (!c || !c.text) return false;
    const key = c.key ?? recallKey(normalizeForCompare(c.text));
    const prior = storeEntries.get(key);
    return !prior?.promotedAt;
  });
}

/** 简单 inspect 工具：按 key/type/time 窗口过滤。 */
export async function inspectStore(path, opts = {}) {
  const { entries, skippedPartial, totalLines } = await readStoreRobust(path);
  const sinceMs = opts.since ? Date.parse(opts.since) : null;
  const untilMs = opts.until ? Date.parse(opts.until) : null;
  const keyNeedle = opts.key ? String(opts.key).toLowerCase() : null;
  const typeFilter = opts.type ?? null;
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 20;
  const rows = [];
  for (const e of entries.values()) {
    if (typeFilter && e.sourceType !== typeFilter) continue;
    if (keyNeedle && !String(e.snippet || '').toLowerCase().includes(keyNeedle)
        && !String(e.key).toLowerCase().includes(keyNeedle)) continue;
    if (sinceMs || untilMs) {
      const ts = e.lastRecalledAt ? Date.parse(e.lastRecalledAt) : 0;
      if (sinceMs && (!Number.isFinite(ts) || ts < sinceMs)) continue;
      if (untilMs && (!Number.isFinite(ts) || ts > untilMs)) continue;
    }
    rows.push(e);
  }
  rows.sort((a, b) => (b.lastRecalledAt || '').localeCompare(a.lastRecalledAt || ''));
  return {
    total: entries.size,
    skippedPartial,
    totalLines,
    rows: rows.slice(0, limit),
  };
}

/** 文件大小（bytes），用于健康检查。 */
export async function storeSize(path) {
  try {
    const st = await stat(path);
    return st.size;
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
}
