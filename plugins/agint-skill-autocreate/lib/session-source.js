/**
 * session-source — autocreate 的数据源适配层（Phase 1 / 分治架构设计 §4 Pipe A）。
 *
 * 职责单一：把「读哪份数据」这件事从 detect() 里抽出来，收敛成一个函数。
 *   - 'session'    （默认）直读会话日志（agint-session-extract 中立提取器）
 *   - 'tool_stats'        旧行为，只读 agint_tool_stats.jsonl（回滚用）
 *   - 'both'              两会话源合并去重（过渡灰度）
 *
 * 为什么直读会话日志：tool_stats.jsonl 是会话日志的二级派生物，靠 04:30
 * backfill 回填；回填失败 → 记录缺 turn/step → aggregator 归 unmatched → 静默
 * 漏检。会话日志本身已含 turn/step/arguments，直读即消除这条时序依赖。
 *
 * 依赖方向：本模块 import 中立提取器（纯函数，非插件），**不** import dream，
 * **不** import 任何 Cordis service —— 与设计稿「两条链只共享中立模块」一致。
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { createHash } from 'node:crypto';
import { readSessionRecords } from '../../agint-session-extract/index.js';

/**
 * 读 tool-stats JSONL（旧路径，保留作兜底/回滚）。
 * 返回原始 record 数组；文件不存在或解析失败 → []（静默，不抛）。
 */
export async function readToolStatsRecords(jsonlPath) {
  const p = resolvePath(jsonlPath);
  try { await stat(p); } catch { return []; }
  try {
    const text = await readFile(p, 'utf8');
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

/** record 去重键：优先 callId；无 callId 时用 时间+会话+工具 退化键。 */
function dedupeKey(r) {
  if (r?.callId) return `cid:${r.callId}`;
  const h = createHash('sha1')
    .update(`${r?.ts}|${r?.sessionId}|${r?.turn}|${r?.step}|${r?.tool}`)
    .digest('hex')
    .slice(0, 16);
  return `fp:${h}`;
}

/**
 * 按配置读取源 record 数组（aggregator 兼容形状）。
 *
 * opts: { source, sessionsRoot, jsonlPath, sinceMs, limit }
 *   source       — 'session' | 'tool_stats' | 'both'
 *   sessionsRoot — 会话根（仅 session/both 用）
 *   jsonlPath    — tool-stats 路径（仅 tool_stats/both 用）
 *   sinceMs      — 时间下界（仅取 ts >= sinceMs；session 侧同时做 mtime 预过滤）
 *   limit        — 上限（默认不限）
 *
 * 返回 { records, bySource } —— bySource 记各源条数，供审计/报告。
 */
export async function readSourceRecords(opts = {}) {
  const source = opts.source ?? 'session';
  const sinceMs = typeof opts.sinceMs === 'number' ? opts.sinceMs : null;
  const limit = opts.limit ?? Infinity;
  const bySource = { session: 0, tool_stats: 0, dedupedDropped: 0 };

  const wanted = {
    session: source === 'session' || source === 'both',
    tool_stats: source === 'tool_stats' || source === 'both',
  };

  const batches = [];

  if (wanted.session) {
    let recs = [];
    try {
      recs = await readSessionRecords(opts.sessionsRoot, { sinceMs, limit });
    } catch { recs = []; }
    bySource.session = recs.length;
    batches.push(recs);
  }

  if (wanted.tool_stats) {
    const recs = await readToolStatsRecords(opts.jsonlPath);
    bySource.tool_stats = recs.length;
    batches.push(recs);
  }

  // source 单源时直接返回（仅做 sinceMs 过滤与截断）
  if (!(wanted.session && wanted.tool_stats)) {
    let records = batches.flat();
    if (sinceMs != null) records = records.filter((r) => typeof r?.ts !== 'number' || r.ts >= sinceMs);
    if (records.length > limit) records = records.slice(0, limit);
    return { records, bySource };
  }

  // 'both'：合并去重（session 优先——同 callId 保留 session 侧，值更新更全）
  const seen = new Set();
  const merged = [];
  for (const batch of batches) {
    for (const r of batch) {
      if (sinceMs != null && typeof r?.ts === 'number' && r.ts < sinceMs) continue;
      const k = dedupeKey(r);
      if (seen.has(k)) { bySource.dedupedDropped++; continue; }
      seen.add(k);
      merged.push(r);
      if (merged.length >= limit) break;
    }
    if (merged.length >= limit) break;
  }
  return { records: merged, bySource };
}
