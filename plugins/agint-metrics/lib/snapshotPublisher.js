/**
 * agint-metrics/lib/snapshotPublisher.js — Sprint 12 / A7 (T1 影子期)
 *
 * 每 setInterval 周期跑一次 metrics 聚合，对每条 record publish 一条
 * `metrics.snapshot` envelope 到 event-bus。
 *
 * 契约：
 *   - publish 用单 service 接口 ctx.get('agint.eventBus.publish')（伞键修复 A3 已确认；
 *     A7 不复用伞键）。
 *   - 软降级：event-bus 拿不到 / publish 抛错 → 静默，不影响 metrics 主写路径。
 *   - timer 必须 ctx.effect 注册 disposer（PLUGIN-SPEC 维度 5 红线）。
 *   - payload slim：≤200 字符（sandbox.passed/failed 在 inspect payloadPreview 中显示完整）。
 *     payload 字段：{ snapshotId, generatedAt, key, value, delta, tags }。
 *   - 主写路径保留：collect() 不变；publish 在 collect() 末尾的副作用（fire-and-forget）。
 *   - fake-timer 兼容：metrics 暴露 _flushSnapshotOnce() 给 driver/e2e 用，
 *     绕开真 setInterval 推进时间。
 */

const TOPIC = 'metrics.snapshot';

/**
 * Build the snapshot envelope payload (slim, ≤200 chars).
 * @param {object} args
 * @param {string} args.snapshotId
 * @param {string} args.generatedAt — ISO
 * @param {string} args.key
 * @param {number} args.value
 * @param {number|null} args.delta
 * @param {object} args.tags — {source, scheduled?, ...}
 */
export function buildSnapshotPayload({ snapshotId, generatedAt, key, value, delta, tags = {} }) {
  return {
    snapshotId,
    generatedAt,
    key,
    value,
    delta: delta === null || delta === undefined ? null : delta,
    tags,
  };
}

/**
 * Publish one snapshot envelope. Soft-degrade: missing service or throw → silent.
 * @param {object} args
 * @param {Function|null} args.publishFn — ctx.get('agint.eventBus.publish')
 * @param {object} args.payload — see buildSnapshotPayload
 * @returns {Promise<boolean>} true if published, false on soft-degrade
 */
export async function publishSnapshot({ publishFn, payload }) {
  if (!publishFn || typeof publishFn !== 'function') return false;
  try {
    await publishFn({
      topic: TOPIC,
      version: 1,
      source: 'agint-metrics',
      payload,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Flush one snapshot batch: collect metrics, then for each record publish one envelope.
 * Designed for both the periodic timer and the explicit _flushSnapshotOnce() driver.
 *
 * @param {object} args
 * @param {Function|null} args.publishFn — ctx.get('agint.eventBus.publish')
 * @param {Function} args.collectFn — agint.metrics.collect
 * @param {Function} args.summaryFn — agint.metrics.summary (for delta)
 * @param {Function} args.randomIdFn
 * @returns {Promise<{published: number, total: number, degraded: boolean}>}
 */
export async function flushSnapshotOnce({ publishFn, collectFn, summaryFn, randomIdFn }) {
  if (typeof collectFn !== 'function') return { published: 0, total: 0, degraded: true };
  let collected;
  try {
    collected = await collectFn();
  } catch {
    return { published: 0, total: 0, degraded: true };
  }
  const items = Array.isArray(collected?.collected) ? collected.collected : [];
  if (items.length === 0) return { published: 0, total: 0, degraded: false };

  // delta 来自 summary().metrics 中相同 key 的 delta
  let deltaMap = new Map();
  try {
    if (typeof summaryFn === 'function') {
      const s = await summaryFn();
      const list = Array.isArray(s?.metrics) ? s.metrics : [];
      for (const m of list) deltaMap.set(m.key, m.delta ?? null);
    }
  } catch { /* ignore — delta optional */ }

  const generatedAt = collected.collectedAt || new Date().toISOString();
  let published = 0;
  for (const rec of items) {
    if (!rec?.key) continue;
    const payload = buildSnapshotPayload({
      snapshotId: typeof randomIdFn === 'function' ? randomIdFn() : `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      generatedAt,
      key: rec.key,
      value: rec.value,
      delta: deltaMap.has(rec.key) ? deltaMap.get(rec.key) : null,
      tags: { source: 'agint-metrics', periodic: true },
    });
    const ok = await publishSnapshot({ publishFn, payload });
    if (ok) published += 1;
  }
  return { published, total: items.length, degraded: publishFn == null };
}

/**
 * Wire up the periodic snapshot publisher.
 * - Uses ctx.setInterval for the timer handle (mock ctx provides this).
 * - Registers a ctx.effect disposer that clears the interval on fiber dispose.
 *
 * @param {object} args
 * @param {object} args.ctx — Cordis ctx
 * @param {Function} args.collectFn
 * @param {Function} args.summaryFn
 * @param {Function} args.randomIdFn
 * @param {number} args.intervalMs — default 24h (周节奏不严格需要)
 * @returns {Function} a disposer (also registered with ctx.effect)
 */
export function attachSnapshotPublisher({ ctx, collectFn, summaryFn, randomIdFn, intervalMs = 24 * 60 * 60 * 1000 }) {
  const getPublish = () => (typeof ctx.get === 'function' ? ctx.get('agint.eventBus.publish') : null);
  let intervalHandle = null;
  let disposed = false;

  const tick = async () => {
    if (disposed) return;
    await flushSnapshotOnce({
      publishFn: getPublish(),
      collectFn,
      summaryFn,
      randomIdFn,
    });
  };

  if (typeof ctx.setInterval === 'function') {
    intervalHandle = ctx.setInterval(tick, intervalMs);
  }

  // ctx.effect: callback runs immediately; its return value is the disposer.
  // We return a disposer that clears the interval and marks disposed.
  const dispose = () => {
    disposed = true;
    try { intervalHandle?.dispose?.(); } catch { /* ignore */ }
  };
  ctx.effect(() => dispose);
  return dispose;
}

export const METRICS_SNAPSHOT_TOPIC = TOPIC;
