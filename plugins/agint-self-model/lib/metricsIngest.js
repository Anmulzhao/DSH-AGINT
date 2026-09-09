/**
 * lib/metricsIngest.js — Sprint 16 / A7「建消费者」+ 影子对账器
 *
 * 背景（T2-切边清单 §3）：A7 `metrics.snapshot` 是设计 8 条边里流量最高的一条
 * （09-09 实测 99 条），但**订阅方为 0** —— 只发不收。清单建议给 evolve/dream
 * 补订阅，实际落点选了 self-model，理由：
 *   1. `lib/observation.js:119` 存在**直连** `await metrics.snapshot()`，
 *      这是 A7 唯一「有直连可切」的落点；evolve/dream 上游在 prod 未激活
 *      （A3–A6 零流量），订阅了也跑不出一致率，T2 拿不到决策数据。
 *   2. self-model 已是 A8 订阅方，架构一致，改造面最小。
 *
 * 定位：**影子期对账器**，不是写路径。
 *   - 订阅 A7 → 按 generatedAt 攒批 → 批结束时用事件重建一份 snapshot
 *   - 与直连 `metrics.snapshot()` 做对账，产出一致率供 T2 决策
 *   - `mode='shadow'`（默认）**不写任何表**，资源基线仍由直连路径权威写入
 *   - `mode='apply'` 留给 T2 拍板后切换（一致才写），本版不启用
 *
 * 判定口径（重要，别改成"值必须相等"）：
 *   事件批次是上一次 collect 的快照，直连是当前时刻的快照，**两者天然有时差**，
 *   数值漂移是必然的、不是链路错误。因此：
 *     - 判 mismatch：**结构不对称**（一边有 latency-ms 另一边没有）
 *     - 只记录不判定：值漂移 valueDrift、批大小漂移 sizeDrift、未知 key
 *   若按"值相等"判定，一致率永远不达标 → T2 永远无法启动。这是本模块的核心权衡。
 *
 * 依赖纪律：零新增依赖，纯函数 + 内存计数；handler 永不抛（影子期红线）。
 */

import { nowIso } from './storage.js';

export const METRICS_SNAPSHOT_TOPIC = 'metrics.snapshot';

/** 资源基线里受 metrics 影响的条目（见 observation.buildResourceBaseline） */
const LATENCY_RE = /latency/i;

/**
 * 纯函数：从 metrics 列表里找 latency 条目。
 * @param {Array<{key:string, value:number}>} metrics
 * @returns {{key:string, value:number}|null}
 */
export function findLatency(metrics) {
  const arr = Array.isArray(metrics) ? metrics : [];
  const hit = arr.find((m) => typeof m?.key === 'string' && LATENCY_RE.test(m.key));
  if (!hit || typeof hit.value !== 'number') return null;
  return { key: hit.key, value: hit.value };
}

/**
 * 纯函数：由事件批次重建一份等价 snapshot（形状对齐 agint.metrics.snapshot()）。
 * @param {{generatedAt:string, metrics:Array<{key:string,value:number}>}} batch
 */
export function rebuildSnapshot(batch) {
  const metrics = Array.isArray(batch?.metrics) ? batch.metrics : [];
  return {
    asOf: batch?.generatedAt ?? null,
    count: metrics.length,
    metrics: metrics.map((m) => ({ key: m.key, value: m.value })),
  };
}

/**
 * 纯函数：对账。返回结构与漂移，不抛。
 * @param {{asOf:string|null,count:number,metrics:Array}} rebuilt 事件重建
 * @param {{asOf?:string,count?:number,metrics?:Array}} direct 直连快照
 */
export function compareSnapshot(rebuilt, direct) {
  const directMetrics = Array.isArray(direct?.metrics) ? direct.metrics : [];
  const directKeys = new Set(directMetrics.map((m) => m?.key));
  const rebuiltLat = findLatency(rebuilt?.metrics);
  const directLat = findLatency(directMetrics);

  const unknownKeys = (rebuilt?.metrics ?? [])
    .map((m) => m?.key)
    .filter((k) => typeof k === 'string' && !directKeys.has(k));

  let matched = true;
  let reason = 'ok';
  if (Boolean(rebuiltLat) !== Boolean(directLat)) {
    matched = false;
    reason = rebuiltLat ? 'latency-missing-in-direct' : 'latency-missing-in-events';
  } else if (!rebuiltLat && !directLat) {
    reason = 'no-latency-key';
  }

  return {
    matched,
    reason,
    valueDrift: rebuiltLat && directLat ? rebuiltLat.value !== directLat.value : false,
    sizeDrift: Number.isFinite(direct?.count) ? rebuilt?.count !== direct.count : false,
    eventCount: rebuilt?.count ?? 0,
    directCount: directMetrics.length,
    unknownKeys: unknownKeys.slice(0, 10),
  };
}

/**
 * 创建 A7 影子对账器。
 *
 * @param {object} [opts]
 * @param {Function|null} [opts.getDirectSnapshot] 直连快照来源（默认 null → 只攒批不对账）
 * @param {'shadow'|'apply'} [opts.mode] apply 本版不启用（见文件头）
 * @param {Function|null} [opts.onMismatch] mismatch 回调（测试/告警用）
 * @param {number} [opts.maxBatchKeys] 单批 key 上限，防异常 payload 撑爆内存
 * @returns {{ingest:Function, flush:Function, stats:Function}}
 */
export function createSnapshotIngest(opts = {}) {
  const {
    getDirectSnapshot = null,
    mode = 'shadow',
    onMismatch = null,
    maxBatchKeys = 512,
  } = opts;

  let current = null; // { generatedAt, metrics: Map<key,value>, seen: Set<string> }
  const counters = {
    events: 0,
    duplicates: 0,
    batches: 0,
    compared: 0,
    matched: 0,
    mismatched: 0,
    valueDrift: 0,
    sizeDrift: 0,
    skipped: 0,
  };
  let lastComparedAt = null;
  let lastMismatch = null;
  let lastBatchSize = 0;

  function openBatch(generatedAt) {
    return { generatedAt, metrics: new Map(), seen: new Set() };
  }

  /** 结算一个批次：重建 → 取直连 → 对账 → 计数 */
  async function settle(batch) {
    counters.batches += 1;
    lastBatchSize = batch.metrics.size;
    if (typeof getDirectSnapshot !== 'function') {
      counters.skipped += 1;
      return { compared: false, reason: 'no-direct-source' };
    }
    let direct = null;
    try {
      direct = await getDirectSnapshot();
    } catch {
      direct = null;
    }
    if (!direct) {
      counters.skipped += 1;
      return { compared: false, reason: 'direct-unavailable' };
    }
    const rebuilt = rebuildSnapshot({
      generatedAt: batch.generatedAt,
      metrics: [...batch.metrics.entries()].map(([key, value]) => ({ key, value })),
    });
    const cmp = compareSnapshot(rebuilt, direct);
    counters.compared += 1;
    if (cmp.matched) counters.matched += 1;
    else {
      counters.mismatched += 1;
      lastMismatch = { at: nowIso(), reason: cmp.reason, asOf: batch.generatedAt };
      if (typeof onMismatch === 'function') {
        try { onMismatch(lastMismatch); } catch { /* ignore */ }
      }
    }
    if (cmp.valueDrift) counters.valueDrift += 1;
    if (cmp.sizeDrift) counters.sizeDrift += 1;
    lastComparedAt = nowIso();
    return { compared: true, ...cmp };
  }

  /**
   * 消费一条 metrics.snapshot 事件（async，永不抛）。
   * 批切换语义：generatedAt 变化即视为上一批结束。
   * @param {object} envelope
   */
  async function ingest(envelope) {
    try {
      const p = envelope?.payload;
      if (!p || typeof p.key !== 'string') return null;
      const generatedAt = typeof p.generatedAt === 'string' ? p.generatedAt : '';
      if (!current || current.generatedAt !== generatedAt) {
        const prev = current;
        current = openBatch(generatedAt);
        if (prev) await settle(prev);
      }
      const dedupKey = `${p.snapshotId ?? ''}|${p.key}`;
      if (current.seen.has(dedupKey)) {
        counters.duplicates += 1;
        return null;
      }
      current.seen.add(dedupKey);
      if (current.metrics.size < maxBatchKeys) current.metrics.set(p.key, p.value);
      counters.events += 1;
      return null;
    } catch {
      return null; // 影子期红线：handler 永不抛
    }
  }

  /** 强制结算当前批（dispose / 测试用） */
  async function flush() {
    try {
      if (!current) return null;
      const batch = current;
      current = null;
      return await settle(batch);
    } catch {
      return null;
    }
  }

  function stats() {
    const total = counters.compared;
    return {
      mode,
      topic: METRICS_SNAPSHOT_TOPIC,
      ...counters,
      consistencyRate: total > 0 ? Number((counters.matched / total).toFixed(4)) : null,
      lastComparedAt,
      lastMismatch,
      lastBatchSize,
      openBatch: current ? { generatedAt: current.generatedAt, keys: current.metrics.size } : null,
    };
  }

  return { ingest, flush, stats };
}
