/**
 * agint-metrics/lib/dreamCounters.js — dream 侧计数订阅（2026-09-24 补）
 *
 * 起因：接线门禁查出 `dream.rejected` **有发布方、零订阅方** —— dream 的 validation
 * gate 拒掉整批时会发这个事件（plugins/agint-dream/lib/index.js:130），但没人收，
 * 于是「dream 到底拒了多少、为什么拒」完全不可观测。
 *
 * 为什么值得收：dream 当前的真实卡点是**去重**（K68），拒绝率是最直接的诊断信号 ——
 * 拒绝率突然升高 = 去重规则或候选源出了问题。没有这个计数器就只能靠翻会话日志。
 *
 * 复刻 policyCounters.js 的形态（独立模块 + 软降级），保持 index.js 不超红线。
 * 软降级：event-bus / storage 不可用 → 不抛，metrics 域其他指标照常工作。
 */

const DREAM_METRIC_KEYS = {
  'dream.rejected': 'dream.rejectedCount',
};

const DREAM_METRIC_LABELS = {
  'dream.rejected': 'dream candidate rejected count (validation gate)',
};

/**
 * Handle one envelope → write one counter record into the metrics table.
 * @param {object} args
 * @param {object} args.envelope — bus envelope {topic, source, payload, ...}
 * @param {Function} args.tableFn — async () => table handle (put/get/...)
 * @param {Function} args.randomIdFn — () => string
 */
export async function recordDreamCounter({ envelope, tableFn, randomIdFn }) {
  const topic = envelope?.topic ?? '';
  const metricKey = DREAM_METRIC_KEYS[topic];
  if (!metricKey) return; // ignore unknown topics
  const t = await tableFn();
  const record = {
    id: randomIdFn(),
    key: metricKey,
    label: DREAM_METRIC_LABELS[topic] ?? metricKey,
    value: 1, // 增量式 +1；summary 走 collect() 的 kv reduce
    unit: 'count',
    meta: JSON.stringify({ source: envelope?.source, payload: envelope?.payload ?? {} }).slice(0, 1024),
    ts: new Date().toISOString(),
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
export function attachDreamCounterSubscription({ subscribeFn, tableFn, randomIdFn }) {
  if (!subscribeFn || typeof subscribeFn !== 'function') return null;
  try {
    return subscribeFn(
      {
        subscriber: 'agint-metrics',
        topics: ['dream.rejected'],
        mode: 'async',
        timeoutMs: 5000,
      },
      async (envelope) => {
        try {
          await recordDreamCounter({ envelope, tableFn, randomIdFn });
        } catch (err) {
          console.error('[agint-metrics] dream observe failed:', err?.message ?? err);
        }
      },
    );
  } catch (err) {
    console.error('[agint-metrics] eventBus.subscribe(dream) failed:', err?.message ?? err);
    return null;
  }
}
