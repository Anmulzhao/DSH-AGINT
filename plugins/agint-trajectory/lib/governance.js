/**
 * agint-trajectory/lib/governance.js — stats / prune / 归因回填（§4.1 FROZEN 5 与 §4.2）。
 *
 * 抽出来的原因：index.js 承载这些会和记录主路径一起膨胀，而这些函数只读 +
 * 治理写入、不依赖运行时闭包状态，显式入参即可表达，也更好单测。
 * （注：仓库「单文件 ≤200 行」红线已于 2026-09-13 由老板取消，这里的拆分是
 *   按职责边界做的，不是为满足行数。）
 */

import { TrajectorySchema } from './schema.js';

/**
 * FROZEN 5：stats（§4.1）
 * @param {object} args
 * @param {Function} args.table async (name) => handle
 * @returns {Promise<object>}
 */
export async function computeStats(args = {}) {
  const { table, cfg, counters, calibration, sampleRates, mode, enabled, bus } = args;
  const t = await table('trajectories');
  const rows = [...t.entries()].map(([, v]) => v);
  const bySource = {};
  const byKind = {};
  let totalBytes = 0;
  let oldest = null;
  let newest = null;
  for (const r of rows) {
    bySource[r.source] = (bySource[r.source] ?? 0) + 1;
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    totalBytes += r.bytes ?? 0;
    if (!oldest || String(r.startedAt) < String(oldest)) oldest = r.startedAt;
    if (!newest || String(r.startedAt) > String(newest)) newest = r.startedAt;
  }
  const dropped = counters.droppedFull + counters.droppedDisabled + counters.droppedPayload;
  const denom = counters.total + dropped;
  return {
    total: rows.length,
    bySource,
    byKind,
    totalBytes,
    oldest,
    newest,
    counters: { ...counters },
    discardRate: denom > 0 ? Math.round((dropped / denom) * 10000) / 10000 : 0,
    truncateRate: counters.total > 0 ? Math.round((counters.truncatedCount / counters.total) * 10000) / 10000 : 0,
    budget: {
      maxCount: cfg.maxCount,
      maxBytes: cfg.maxBytes,
      maxPerDay: cfg.maxPerDay,
      retentionDays: cfg.retentionDays,
      countUsed: rows.length,
      bytesUsed: totalBytes,
      countPressure: rows.length / cfg.maxCount,
      bytePressure: cfg.maxBytes > 0 ? totalBytes / cfg.maxBytes : 0,
    },
    mode,
    enabled,
    sampleRates: { ...sampleRates },
    bus: bus ?? null,
    calibration: calibration?.lastReport ?? null,
    calibrationReady: calibration?.lastReport?.ready === true,
  };
}

/**
 * 非 FROZEN：prune（§4.2）—— 删最旧非 pinned，直到满足保留期 + 条数 + 字节。
 * @returns {Promise<{removed:number, freedBytes:number, kept:number}>}
 */
export async function pruneRows(args = {}) {
  const { table, cfg, opts = {}, publish } = args;
  const maxAgeDays = opts.maxAgeDays ?? cfg.retentionDays;
  const maxCount = opts.maxCount ?? cfg.maxCount;
  const maxBytes = opts.maxBytes ?? cfg.maxBytes;
  const t = await table('trajectories');
  const rows = [...t.entries()].map(([k, v]) => ({ key: k, row: v }));
  const cutoff = Date.now() - maxAgeDays * 86400_000;

  const removable = rows
    .filter(({ row }) => row.pinned !== true)
    .sort((a, b) => String(a.row.startedAt).localeCompare(String(b.row.startedAt)));
  const pinned = rows.filter(({ row }) => row.pinned === true);

  let keptCount = pinned.length;
  let keptBytes = pinned.reduce((a, r) => a + (r.row.bytes ?? 0), 0);
  const removed = [];
  let freedBytes = 0;

  for (const { key, row } of removable) {
    const expired = Date.parse(row.startedAt) < cutoff;
    const overCount = keptCount >= maxCount;
    const overBytes = keptBytes >= maxBytes;
    if (!expired && !overCount && !overBytes) {
      keptCount++;
      keptBytes += row.bytes ?? 0;
      continue;
    }
    await t.delete(key);
    removed.push(key);
    freedBytes += row.bytes ?? 0;
  }

  if (removed.length && typeof publish === 'function') {
    await publish('trajectory.pruned', { removed: removed.length, freedBytes });
  }
  return { removed: removed.length, freedBytes, kept: keptCount };
}

/**
 * 非 FROZEN：linkAttribution（§4.2）—— diagnosis / mount 回填归因钩子。
 * @returns {Promise<object|null>}
 */
export async function linkAttributionRow(args = {}) {
  const { table, id, patch = {} } = args;
  if (!id) return null;
  const t = await table('trajectories');
  const cur = t.get(String(id));
  if (!cur) return null;
  const next = TrajectorySchema.parse({
    ...cur,
    outcome: {
      ...cur.outcome,
      errorClass: patch.errorClass ?? cur.outcome?.errorClass ?? null,
      attributionId: patch.attributionId ?? cur.outcome?.attributionId ?? null,
    },
    taskRef: { ...cur.taskRef, variantId: patch.variantId ?? cur.taskRef?.variantId ?? null },
  });
  await t.put(String(id), next);
  return next;
}

/**
 * 归因目标定位：只按**显式关联键**找（trajectoryId → sessionId），
 * 找不到就返回 null —— 不猜「最近一条失败轨迹」（真实 > 讨好）。
 */
export async function findAttributionTarget(args = {}) {
  const { table, ref = {} } = args;
  if (ref.trajectoryId) {
    const t = await table('trajectories');
    return t.get(String(ref.trajectoryId)) ?? null;
  }
  if (ref.sessionId) {
    const t = await table('trajectories');
    const rows = [...t.entries()]
      .map(([, v]) => v)
      .filter((r) => r.kind === 'failure' && r.taskRef?.sessionId === ref.sessionId)
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    return rows[0] ?? null;
  }
  return null;
}
