/**
 * agint-tool-stats prune：明细保留（默认 30 天）+ 周 rollup。
 *
 * 为什么需要它（2026-11-12 实测取证）：
 *   - 明细文件 agint_tool_stats.jsonl 无上限无轮转，生产已 7.9 MB / 7331 行；
 *   - args 正文占全文件 84%（bash 1.94 MB / 4210 次，edit 653 KB，write 646 KB）；
 *   - 每行**已经**有 argFingerprint(sha256) + argsHash ⇒ 指纹齐备，args 原文
 *     对统计口径没有任何增量价值，纯体积负担。
 *   ⇒ 写侧参数指纹化（storeArgs，默认 false）+ 读侧保留期（prune + rollup）
 *     两条一起做，才能真正把这条 JSONL 从"无限增长的明文日志"变成"可长期持有的统计表"。
 *
 * 保留机制的两条不变量：
 *   ① **先 rollup 再删明细** —— 被删明细按「工具 × 周」聚合成一行写进
 *      agint_tool_stats_rollup.jsonl（append 语义，同目录），历史不丢。
 *   ② **存量行不回填改写** —— prune 只动"超期"的行；30 天内的行原样保留，
 *      连 args 原文也保留（旧行是历史证据，改写等于毁证）。
 *
 * 口径定义只在本文件出现一次（AGENT 守则：同一口径不许有两份实现）：
 *   - 超期判定：`rec.ts`（epoch 毫秒）< `now - maxAgeDays * 86400000`；
 *   - 周口径：UTC 周一 00:00 为一周之始，周键 = 该日期的 YYYY-MM-DD；
 *   - p95：升序取 `idx = min(n-1, floor(n*0.95))`，与 aggregate.js 同口径；
 *   - 失败数：`rec.ok === false`（缺字段不算失败）。
 */

import { readFile, writeFile, appendFile, rename, stat } from 'node:fs/promises';

const DAY_MS = 86400000;

/** 默认保留天数。 */
export const DEFAULT_MAX_AGE_DAYS = 30;

/** rollup 文件名（与明细同目录）。 */
export const ROLLUP_FILENAME = 'agint_tool_stats_rollup.jsonl';

/**
 * 某时间戳所属 ISO 周（UTC 周一 00:00）的起始毫秒。
 * @param {number} tsMs epoch 毫秒
 * @returns {number}
 */
export function weekStartMs(tsMs) {
  const d = new Date(tsMs);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = 周一
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow, 0, 0, 0, 0);
}

/**
 * 周键：该周周一那天的 YYYY-MM-DD（UTC）。
 * @param {number} tsMs epoch 毫秒
 * @returns {string}
 */
export function weekKeyOf(tsMs) {
  return new Date(weekStartMs(tsMs)).toISOString().slice(0, 10);
}

/**
 * p95 —— 与 aggregate.js 的 summarize() 同口径（升序数组取
 * `min(n-1, floor(n*0.95))` 下标）。口径一致 ⇒ rollup 与明细聚合出的数可互相核对。
 * @param {number[]} sorted 已升序的延迟数组
 * @returns {number}
 */
export function p95Of(sorted) {
  if (!Array.isArray(sorted) || sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return +Number(sorted[idx]).toFixed(1);
}

/**
 * 读 rollup 文件（不存在 → 空数组；坏行跳过，绝不抛错）。
 * @param {string} rollupPath
 * @returns {Promise<object[]>}
 */
async function readRollupRows(rollupPath) {
  let text;
  try {
    text = await readFile(rollupPath, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === 'object') out.push(r);
    } catch {
      /* skip malformed rollup line */
    }
  }
  return out;
}

/** rollup 行的唯一键：一周 × 一工具。 */
function rollupKeyOf(row) {
  return `${row.week}|${row.tool}`;
}

/**
 * 原子写（tmp + rename）：写一半断电不会留下半截文件。
 * @param {string} path
 * @param {string} text
 */
async function atomicWrite(path, text) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
}

/**
 * prune 明细 + 生成周 rollup。
 *
 * @param {object} args
 * @param {string} args.jsonlPath 明细 JSONL 路径
 * @param {string} args.rollupPath rollup JSONL 路径（与明细同目录）
 * @param {object} [args.opts] { maxAgeDays = 30, dryRun = false }
 * @param {(topic: string, payload: object) => Promise<unknown>} [args.publish] 事件发布（缺席则静默跳过）
 * @param {number} [args.now] 当前时间（测试可注入）
 * @returns {Promise<{removed:number, freedBytes:number, rolled:number, dryRun:boolean, applied:boolean}>}
 */
export async function pruneToolStats({ jsonlPath, rollupPath, opts = {}, publish = null, now = Date.now() } = {}) {
  const maxAgeDays =
    Number.isFinite(opts.maxAgeDays) && opts.maxAgeDays > 0 ? opts.maxAgeDays : DEFAULT_MAX_AGE_DAYS;
  const dryRun = opts.dryRun === true;
  const cutoff = now - maxAgeDays * DAY_MS;

  // ── ① 读明细，逐行判定超期 ────────────────────────────────────────────
  let text = '';
  try {
    text = await readFile(jsonlPath, 'utf8');
  } catch {
    text = '';
  }
  const beforeBytes = Buffer.byteLength(text, 'utf8');

  const kept = [];
  const groups = new Map(); // key → { week, tool, calls, failures, latencies[], firstTs, lastTs }
  let removedCount = 0;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue; // 空行（含文件末尾换行产生的空串）不携带数据
    let rec = null;
    try {
      rec = JSON.parse(line);
    } catch {
      rec = null;
    }
    const ts = rec && typeof rec.ts === 'number' && Number.isFinite(rec.ts) ? rec.ts : null;
    // ⚠️ ts 缺失/坏行 ⇒ **不删**。只删能证明超期的行；删不明行等于毁证。
    if (ts === null || ts >= cutoff) {
      kept.push(line);
      continue;
    }
    removedCount++;
    const tool = typeof rec.tool === 'string' && rec.tool ? rec.tool : 'unknown';
    const week = weekKeyOf(ts);
    const key = `${week}|${tool}`;
    let g = groups.get(key);
    if (!g) {
      g = { week, tool, calls: 0, failures: 0, latencies: [], firstTs: ts, lastTs: ts };
      groups.set(key, g);
    }
    g.calls++;
    if (rec.ok === false) g.failures++;
    // 延迟口径与 aggregate.js 一致：缺失按 0 计（否则明细与 rollup 的 p95 对不上）。
    g.latencies.push(
      typeof rec.latencyMs === 'number' && Number.isFinite(rec.latencyMs) ? rec.latencyMs : 0,
    );
    if (ts < g.firstTs) g.firstTs = ts;
    if (ts > g.lastTs) g.lastTs = ts;
  }

  const newText = kept.length ? kept.join('\n') + '\n' : '';
  const afterBytes = Buffer.byteLength(newText, 'utf8');
  const freedBytes = Math.max(0, beforeBytes - afterBytes);

  // ── ② rollup：与已有行**合并**，保证「一周 × 一工具 = 一行」 ───────────
  //
  // 为什么必须合并而不是纯 append：
  //   一周的行是**逐日**变超期的（每天过期的都是上一周那一天的行）⇒ 同一
  //   (week, tool) 会被多次 prune 命中。纯 append 会让同一周出现 7 行，
  //   "一行一周一工具" 的口径就废了。所以同键合并（calls/failures 累加、
  //   firstTs 取小、lastTs 取大、p95 按合并后的延迟样本重算）。
  //   合并需要历史延迟样本 ⇒ rollup 行里保留 `latencies`（不含 args，只有数字）。
  const existingRows = await readRollupRows(rollupPath);
  const byKey = new Map();
  for (const r of existingRows) byKey.set(rollupKeyOf(r), r);

  let rolled = 0;
  let mergedAny = false;
  const newRows = [];
  for (const g of groups.values()) {
    const key = `${g.week}|${g.tool}`;
    const latencies = [...g.latencies].sort((a, b) => a - b);
    const existing = byKey.get(key);
    if (existing) {
      mergedAny = true;
      existing.calls = (Number(existing.calls) || 0) + g.calls;
      existing.failures = (Number(existing.failures) || 0) + g.failures;
      existing.firstTs = Math.min(Number(existing.firstTs) || g.firstTs, g.firstTs);
      existing.lastTs = Math.max(Number(existing.lastTs) || g.lastTs, g.lastTs);
      existing.latencies = [...(Array.isArray(existing.latencies) ? existing.latencies : []), ...latencies].sort(
        (a, b) => a - b,
      );
      existing.p95Ms = p95Of(existing.latencies);
      existing.updatedAt = now;
    } else {
      const row = {
        week: g.week,
        tool: g.tool,
        calls: g.calls,
        failures: g.failures,
        p95Ms: p95Of(latencies),
        firstTs: g.firstTs,
        lastTs: g.lastTs,
        latencies,
        updatedAt: now,
      };
      byKey.set(key, row);
      newRows.push(row);
    }
    rolled++;
  }

  // ── ③ 落盘（dryRun 只算不写） ─────────────────────────────────────────
  if (!dryRun) {
    // ③a 明细：重写（tmp + rename，原子）。只写回"保留"的行 —— 存量行原样保留。
    await atomicWrite(jsonlPath, newText);
    // ③b rollup：纯新增 ⇒ append；有合并 ⇒ 重写整份（保持一行一周一工具）。
    if (mergedAny) {
      const all = [...byKey.values()].map((r) => JSON.stringify(r)).join('\n');
      await atomicWrite(rollupPath, all ? all + '\n' : '');
    } else if (newRows.length) {
      await appendFile(
        rollupPath,
        newRows.map((r) => JSON.stringify(r)).join('\n') + '\n',
        'utf8',
      );
    }
  }

  // ── ④ 事件：toolStats.pruned ──────────────────────────────────────────
  // 发布失败/缺席一律静默跳过（prune 的成败不依赖总线在场）。
  if (!dryRun && removedCount > 0 && typeof publish === 'function') {
    try {
      await publish('toolStats.pruned', { removed: removedCount, freedBytes });
    } catch {
      /* 静默：事件不是 prune 的成败判据 */
    }
  }

  return {
    // dryRun 时这两个值是「将删多少行 / 将释放多少字节」（一个字节都没动）；
    // applied 字段标明本轮是否真的落盘。
    removed: removedCount,
    freedBytes,
    rolled,
    dryRun,
    applied: !dryRun,
    kept: kept.length,
    maxAgeDays,
    cutoff,
    rollupPath,
  };
}

/**
 * rollup 文件是否存在（诊断用）。
 * @param {string} rollupPath
 * @returns {Promise<boolean>}
 */
export async function rollupExists(rollupPath) {
  try {
    await stat(rollupPath);
    return true;
  } catch {
    return false;
  }
}
