/**
 * agint-metrics/lib/mountCounters.js — A2 接线（2026-09-20）
 *
 * 背景：mount.* 系列 topic 的**发布方一直是通的**（agint-mount/orchestrator.js
 * 10 处真实调用），但**订阅方为 0** → 生产 0 条可消费记录，挂载链路的成功/失败
 * 完全不可观测（只能翻 tickets 表）。
 * 另一侧的历史坑：发布方取 bus 用的是 `ctx.getService('agint.eventBus')` 伞键，
 * 而 event-bus 只注册分服务名 → publish 恒 undefined → 静默降级（已在本轮修）。
 *
 * 这里补上订阅侧：把 mount 六个 topic 转成计数指标写入 agint_metrics 表，
 * 让"挂载到底成功几次 / 失败几次"第一次变成可查的数字。
 *
 * 软降级：event-bus / storage 不可用 → log 不抛，metrics 域其他指标照常工作。
 */

const MOUNT_METRIC_KEYS = {
  'mount.requested': 'mount.requestedCount',
  'mount.succeeded': 'mount.succeededCount',
  'mount.failed': 'mount.failedCount',
  'mount.restart-requested': 'mount.restartRequestedCount',
  'mount.restart-completed': 'mount.restartCompletedCount',
  'mount.restart-failed': 'mount.restartFailedCount',
};

const MOUNT_METRIC_LABELS = {
  'mount.requested': '挂载请求数',
  'mount.succeeded': '挂载成功数',
  'mount.failed': '挂载失败数',
  'mount.restart-requested': '重启请求数',
  'mount.restart-completed': '重启完成数',
  'mount.restart-failed': '重启失败数',
};

export const MOUNT_TOPICS = Object.keys(MOUNT_METRIC_KEYS);

/**
 * Handle one envelope → write one counter record into the metrics table.
 * @param {object} args
 * @param {object} args.envelope — bus envelope {topic, source, payload, ...}
 * @param {Function} args.tableFn — async () => table handle (put/get/...)
 * @param {Function} args.randomIdFn — () => string
 */
export async function recordMountCounter({ envelope, tableFn, randomIdFn }) {
  const topic = envelope?.topic ?? '';
  const metricKey = MOUNT_METRIC_KEYS[topic];
  if (!metricKey) return null; // ignore unknown topics
  const t = await tableFn();
  const record = {
    id: randomIdFn(),
    key: metricKey,
    label: MOUNT_METRIC_LABELS[topic] ?? metricKey,
    value: 1, // 增量式 +1；summary 走 collect() 的 kv reduce
    unit: 'count',
    meta: JSON.stringify({
      source: envelope?.source,
      ticketId: envelope?.payload?.ticketId ?? null,
      reason: envelope?.payload?.reason ?? null,
    }).slice(0, 1024),
    ts: new Date().toISOString(),
  };
  await t.put(record.id, record);
  return record;
}

/**
 * Wire up the event-bus subscription. Returns Unsubscribe function.
 * @param {object} args
 * @param {Function} args.subscribeFn — ctx.get('agint.eventBus.subscribe')
 * @param {Function} args.tableFn — async () => table handle
 * @param {Function} args.randomIdFn — () => string
 * @returns {Function|null} Unsubscribe function or null if subscribe failed
 */
export function attachMountCounterSubscription({ subscribeFn, tableFn, randomIdFn }) {
  if (!subscribeFn || typeof subscribeFn !== 'function') return null;
  try {
    return subscribeFn(
      {
        subscriber: 'agint-metrics',
        topics: MOUNT_TOPICS,
        mode: 'async',
        timeoutMs: 5000,
      },
      async (envelope) => {
        try {
          await recordMountCounter({ envelope, tableFn, randomIdFn });
        } catch (err) {
          console.error('[agint-metrics] mount observe failed:', err?.message ?? err);
        }
      },
    );
  } catch (err) {
    console.error('[agint-metrics] eventBus.subscribe(mount.*) failed:', err?.message ?? err);
    return null;
  }
}
