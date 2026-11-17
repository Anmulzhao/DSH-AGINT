/**
 * agint-metrics/lib/eventCounters.js — 四插件接线后的统一影子计数订阅（2026-10-26）
 *
 * 起因：`node bin/check-wiring.mjs` 报 4 处硬缺口 ——
 *   NO_SUBSCRIBER(rules.changed) + UNWIRED(agint-wiki / agint-quality-contract / agint-abtest)。
 *
 * 前三处是**发布侧缺**（代码里根本没有 publish 调用点），已在本轮分别补上：
 *   - `agint-wiki`             → `wiki.updated`（write / remove 落盘后）
 *   - `agint-quality-contract`  → `quality.contract.violated`（setConfig 被 L0 守卫拒绝时）
 *   - `agint-abtest`           → `abtest.started` / `abtest.concluded`
 * 第四处（`rules.changed`）方向相反：`agint-rules` 自 2026-10-09 起就在发，
 * 生产已有 2 条事件，但 **deliveredTo 恒 0** —— 发了没人收，等于白发。
 *
 * ⇒ 本模块是这五条主题的**唯一订阅方**，落点选 metrics 而不是某个业务插件，理由：
 *   metrics 是全系统既定的统一遥测出口，policy.* / dream.rejected 已是同一形态
 *   （policyCounters.js / dreamCounters.js）。把新主题接到同一张表，
 *   才可能用一条 `metrics_series` 就把「规则改了没 / wiki 写了没 / 契约被拦了没 /
 *   A/B 跑出结论没」并排看。
 *
 * 为什么每条主题都值得记（不是为凑门禁绿）：
 *   - `rules.changed`            deny 门禁增删对下游此前完全不可见（evolve/metrics 只能
 *                                现场拉快照），变更时刻无锚点、无法归因到某次编辑。
 *   - `wiki.updated`             知识层写入此前零指标，`wiki.total` 只是快照值，
 *                                看不出增长速率，更看不出哪天突然停写。
 *   - `quality.contract.violated` ⭐ 最重要的一条：AGENTS.md 明载「废除多签后 L0 没有
 *                                事前审批」，运行时唯一的守卫就是 setConfig 里的
 *                                validatePatch。它 throw 之后错误只消失在调用栈里，
 *                                **谁试图改 FROZEN 字段、改了哪个字段，无人知晓**。
 *   - `abtest.started/concluded` A/B 结论此前从未产生过（存储域 DEAD），一旦产生就必须
 *                                可查 —— 否则 quality-eval 的决策依据无法回溯。
 *
 * 软降级：event-bus / storage 不可用 → 不抛，metrics 域其他指标照常工作。
 * 红线：不改 FROZEN schema；不切 T2（本条纯订阅，主路径不受影响）。
 *
 * 2026-11-11 扩容：补三条宿主信号主题（本模块是它们的唯一订阅方）
 * ---------------------------------------------------------------
 * 起因：`node bin/check-wiring.mjs` 报 2 个硬缺口 —— NO_SUBSCRIBER(
 * input.signal.host.subagent-start) / (-end)。取证：
 *   · 发布方 = agint-event-bus/lib/host-bridge.js（字面量 topic，门禁扫得到）
 *   · 生产总线实读 **40 条 start / 35 条 end**，首条 2026-11-04T12:23:01Z
 *   · 仓库里零订阅方（grep `input.signal.host.subagent` 在 plugins/ 下只命中发布侧 2 处）
 *   · 正负对照（生产 agint_metrics.json 实读）：host.* 计数 668 条**全是**
 *     domainChangedCount，subagent 两个 key **0 条** —— 同模块同一条 attach 通路，
 *     旧主题有数、新主题零，证明缺的是订阅而不是采集能力
 *   ⇒ 不是「尚未触发」，是**接了发布没接消费**（同 rules.changed 那一类）。
 *
 * ⚠️ 取证口径：`deliveredTo` 是 bus.js 里 publish() 的**返回值**，不落盘
 * （agint_event_bus.json 记录层只有 envelope / payloadPreview / occurredAt / traceId）。
 * 它恒空只能由「零订阅方」推断，不能写成存储实读。可测的证据是上面那组计数对照。
 *
 * 为什么落 metrics 而不是新建业务插件：
 *   ① metrics 是全系统既定的统一遥测出口，domain-changed / workflow-end 已是同形态；
 *   ② 「多 Agent 跑了多少、成没成、用哪个 provider」在 AGINT 侧此前**零指标** ——
 *      进化闭环能看见自己发了什么事件，却看不见宿主真的派了多少子代理
 *      （host-bridge 头注释原话：这是「哪些子代理值得派」的唯一依据）；
 *   ③ 事件 payload 里已带 provider / stopReason / messageLength，meta 原样落库，
 *      后续要按 provider 或终态聚合，直接查这一张表，不用另建采集通道。
 *
 * 第三条 workflow-phase：同族潜在缺口（发布方 1 / 订阅方 0 / 生产 0）——
 *   门禁此刻只报 NOT_YET_FIRED（软），但第一次有工作流跑起来就会翻成 NO_SUBSCRIBER。
 *   一并接上，避免同一诉求分两次改、两次重启。
 */

const COUNTER_METRIC_KEYS = {
  'rules.changed': 'rules.changedCount',
  'wiki.updated': 'wiki.updatedCount',
  'quality.contract.violated': 'quality.contractViolatedCount',
  'abtest.started': 'abtest.startedCount',
  'abtest.concluded': 'abtest.concludedCount',
  // ── 2026-11-02（B1）：宿主事件桥的两条主题 ──
  // 生产者是 agint-event-bus/lib/host-bridge.js。接它们不是为了凑门禁绿，
  // 是因为「宿主的域被写了」与「工作流跑完了」在 AGINT 侧此前**零指标**：
  // 进化闭环能看见自己发了什么事件，却看不见自己**被写了什么**。
  'input.signal.host.domain-changed': 'host.domainChangedCount',
  'input.signal.host.workflow-end': 'host.workflowEndCount',
  // ── 2026-11-11：子代理边界事件 + 工作流相位 ──
  // 生产已有 40 条 start / 35 条 end 且零订阅方（check-wiring 判 NO_SUBSCRIBER）。
  'input.signal.host.subagent-start': 'host.subagentStartCount',
  'input.signal.host.subagent-end': 'host.subagentEndCount',
  // 同族潜在缺口：发布方 1 / 订阅方 0 / 生产 0，此刻软报 NOT_YET_FIRED，
  // 第一次有工作流跑起来就会翻成 NO_SUBSCRIBER ⇒ 一并接。
  'input.signal.host.workflow-phase': 'host.workflowPhaseCount',
};

const COUNTER_METRIC_LABELS = {
  'rules.changed': 'rule set changed count (add / remove / toggle)',
  'wiki.updated': 'wiki write/remove count (knowledge layer)',
  'quality.contract.violated': 'L0 frozen-field write attempt blocked',
  'abtest.started': 'A/B test started count',
  'abtest.concluded': 'A/B test concluded count',
  'input.signal.host.domain-changed': 'host storage-domain write count (whitelisted domains only)',
  'input.signal.host.workflow-end': 'workflow run settled count (any stop reason)',
  'input.signal.host.subagent-start': 'host subagent start count (child agent spawned)',
  'input.signal.host.subagent-end': 'host subagent end count (child agent settled, stopReason in meta)',
  'input.signal.host.workflow-phase': 'workflow phase advance count (one per phase)',
};

const SUBSCRIBED_TOPICS = Object.keys(COUNTER_METRIC_KEYS);

/**
 * 订阅配置。
 *
 * ⚠️ `topics` 必须是**单行字面量数组**，不能写成 `topics: SUBSCRIBED_TOPICS`。
 * 原因：`bin/check-wiring.mjs` 的订阅侧靠逐行正则 `/topics:\s*\[([^\]]*)\]/` 扫描
 * 源码，变量形式对它是**不可见**的 —— 第一版这里写成变量，门禁照样报
 * `NO_SUBSCRIBER(rules.changed)`，即「订阅代码是对的，但回归防线瞎了」。
 * 把字面量放在门禁看得见的位置，比省一行重复更重要；两者一致性由
 * test/event-counters.test.mjs 的断言钉死。
 */
const SUBSCRIPTION = {
  subscriber: 'agint-metrics',
  topics: ['rules.changed', 'wiki.updated', 'quality.contract.violated', 'abtest.started', 'abtest.concluded', 'input.signal.host.domain-changed', 'input.signal.host.workflow-end', 'input.signal.host.subagent-start', 'input.signal.host.subagent-end', 'input.signal.host.workflow-phase'],
  mode: 'async', // sync 配额全局上限 3，留给真正的门禁边
  timeoutMs: 5000,
};

/**
 * Handle one envelope → write one counter record into the metrics table.
 * @param {object} args
 * @param {object} args.envelope — bus envelope {topic, source, payload, ...}
 * @param {Function} args.tableFn — async () => table handle (put/get/...)
 * @param {Function} args.randomIdFn — () => string
 */
export async function recordEventCounter({ envelope, tableFn, randomIdFn }) {
  const topic = envelope?.topic ?? '';
  const metricKey = COUNTER_METRIC_KEYS[topic];
  if (!metricKey) return; // ignore unknown topics
  const t = await tableFn();
  const record = {
    id: randomIdFn(),
    key: metricKey,
    label: COUNTER_METRIC_LABELS[topic] ?? metricKey,
    value: 1, // 增量式 +1；summary 走 collect() 的 kv reduce
    unit: 'count',
    // meta 是归因位：只留能回答「谁改的 / 改了哪条 / 结论是什么」的最小字段集，
    // 并整体截断到 1024（与 policyCounters 一致的存储预算）。
    meta: JSON.stringify({
      source: envelope?.source,
      traceId: envelope?.traceId ?? null,
      payload: envelope?.payload ?? {},
    }).slice(0, 1024),
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
export function attachEventCounterSubscription({ subscribeFn, tableFn, randomIdFn }) {
  if (!subscribeFn || typeof subscribeFn !== 'function') return null;
  try {
    return subscribeFn(
      SUBSCRIPTION,
      async (envelope) => {
        try {
          await recordEventCounter({ envelope, tableFn, randomIdFn });
        } catch (err) {
          console.error('[agint-metrics] event counter observe failed:', err?.message ?? err);
        }
      },
    );
  } catch (err) {
    console.error('[agint-metrics] eventBus.subscribe (event counters) failed:', err?.message ?? err);
    return null;
  }
}

export { COUNTER_METRIC_KEYS, SUBSCRIBED_TOPICS, SUBSCRIPTION };
