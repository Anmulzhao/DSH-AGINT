/**
 * agint-metrics/lib/policyCounters.js — Sprint 12 / A5 (T1 影子期)
 *
 * 把 policy.deployed / policy.rolledback 计数器订阅逻辑抽出成独立模块：
 *   - 减少 index.js 体积（红线：单文件 ≤ 200 行）
 *   - 单元可测（不用启真 plugin apply() 也能验计数器逻辑）
 *
 * 软降级：event-bus / storage 不可用 → log 不抛，metrics 域其他指标照常工作。
 */

const POLICY_METRIC_KEYS = {
  'policy.deployed': 'policy.deployedCount',
  'policy.rolledback': 'policy.rolledbackCount',
};

const POLICY_METRIC_LABELS = {
  'policy.deployed': 'policy deploy count (shadow T1)',
  'policy.rolledback': 'policy rollback count (shadow T1)',
};

/**
 * Handle one envelope → write one counter record into the metrics table.
 * @param {object} args
 * @param {object} args.envelope — bus envelope {topic, source, payload, ...}
 * @param {Function} args.tableFn — async () => table handle (put/get/...)
 * @param {Function} args.randomIdFn — () => string
 * @param {boolean} args.disposed
 */
export async function recordPolicyCounter({ envelope, tableFn, randomIdFn, disposed = false }) {
  const topic = envelope?.topic ?? '';
  const metricKey = POLICY_METRIC_KEYS[topic];
  if (!metricKey) return; // ignore unknown topics
  const t = await tableFn();
  const now = new Date().toISOString();
  const record = {
    id: randomIdFn(),
    key: metricKey,
    label: POLICY_METRIC_LABELS[topic] ?? metricKey,
    value: 1, // 增量式 +1；summary 走 collect() 的 kv reduce
    unit: 'count',
    meta: JSON.stringify({ source: envelope?.source, payload: envelope?.payload ?? {} }).slice(0, 1024),
    ts: now,
  };
  await t.put(record.id, record);
}

/**
 * Wire up the event-bus subscription. Returns Unsubscribe function.
 * @param {object} args
 * @param {Function} args.subscribeFn — ctx.get('agint.eventBus.subscribe')
 * @param {Function} args.tableFn — async () => table handle
 * @param {Function} args.randomIdFn — () => string
 * @returns {Function|null} Unsubscribe function or null if subscribe failed
 */
export function attachPolicyCounterSubscription({ subscribeFn, tableFn, randomIdFn }) {
  if (!subscribeFn || typeof subscribeFn !== 'function') return null;
  try {
    return subscribeFn(
      {
        subscriber: 'agint-metrics',
        topics: ['policy.deployed', 'policy.rolledback'],
        mode: 'async',
        timeoutMs: 5000,
      },
      async (envelope) => {
        try {
          await recordPolicyCounter({ envelope, tableFn, randomIdFn });
        } catch (err) {
          console.error('[agint-metrics] policy observe failed:', err?.message ?? err);
        }
      },
    );
  } catch (err) {
    console.error('[agint-metrics] eventBus.subscribe failed:', err?.message ?? err);
    return null;
  }
}