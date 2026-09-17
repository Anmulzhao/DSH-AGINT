/**
 * agint-trajectory/lib/subscribers.js — Event Bus 订阅（§5.1，Sprint 18 T3）。
 *
 * 两条纪律都来自设计稿自身的教训表：
 *   1. **只订阅已验证存在的事件**。v0.1 曾经虚构 5 个事件（源码 grep 命中 0），
 *      本文件的 SUBSCRIPTIONS 是唯一订阅源，由 `test/event-contract.test.mjs`
 *      正则抽出后到 `plugins/` 全库 grep 校验 publish 存在——护栏自动化。
 *   2. **事件是通知机制，不是数据来源**（§5.1 v0.3 降级路径）。订阅失败 /
 *      event-bus 不可用 / T2 未切流量，都退回显式 `record()`；降级不丢数据，
 *      只是少了自动触发。用 `via: 'event' | 'explicit'` 区分来源。
 */

/**
 * event-bus 的 topic 契约（与 `agint-event-bus/lib/schemas.js` 的 `TopicSchema` 同源）。
 *
 * 为什么本地冗余一份正则：event-bus 对本插件是**软依赖**（`optionalInject`），
 * 硬 import 会破坏"缺失也能启动"的降级承诺。漂移由 `test/event-contract.test.mjs`
 * 的「本地正则与 bus 契约一致」用例兜住（读 bus 源码比对字面）。
 *
 * 形状：首段 `[a-z][a-z0-9]*` —— **不含连字符**；其后 1–3 段 `[a-z][a-z0-9-]*`。
 *
 * 2026-09-17 事故：本文件曾订阅 `evo-orch.task-started`（首段含 `-`），而 bus 侧
 * `SubscriptionSchema.topics` 是 `z.array(TopicSchema)` —— **整批**校验，一条非法
 * 即整体抛错；`attachSubscriptions` 又一次性把 6 条 topics 交出去 → 连 4 条合法
 * 订阅（dream/evolution×2/diagnosis）**一起失效**，只剩显式 record()。
 */
export const TOPIC_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/;

/** 该 topic 名是否合法。**订阅前逐条过滤**，别把整批交给 bus 校验。 */
export function isValidTopic(topic) {
  return typeof topic === 'string' && TOPIC_RE.test(topic);
}

/**
 * 把 topic 清单切成 `{ valid, dropped }`（顺序保持）。
 * 订阅侧的唯一防线：bus 的 topics 数组整批校验，一条非法即全灭。
 */
export function partitionValidTopics(topics) {
  const valid = [];
  const dropped = [];
  for (const t of topics) (isValidTopic(t) ? valid : dropped).push(t);
  return { valid, dropped };
}

/**
 * 订阅清单（唯一真源）。
 * topic → 轨迹源的映射；`attribution: true` 表示这条不新记轨迹，只回填归因。
 */
export const SUBSCRIPTIONS = Object.freeze([
  { topic: 'dream.completed', source: 'dream', role: 'record' },
  { topic: 'evolution.proposed', source: 'evolution', role: 'record' },
  { topic: 'evolution.evaluated', source: 'evolution', role: 'record' },
  { topic: 'diagnosis.completed', source: 'task', role: 'attribution' },
  // P2-3 设计稿已定义的契约（尚未实施）。原名 `evo-orch.*` 首段含连字符属**非法
  // topic**，会让整批订阅被拒（见 TOPIC_RE 注释）→ 2026-09-17 改为 `evoorch.*`。
  // ⚠️ P2-3 实现时 **publish 侧必须用这里的名字**，否则订阅永远收不到。
  { topic: 'evoorch.task-started', source: 'subagent', role: 'record' },
  { topic: 'evoorch.task-completed', source: 'subagent', role: 'record' },
]);

export const SUBSCRIBED_TOPICS = Object.freeze(SUBSCRIPTIONS.map((s) => s.topic));

const iso = (d) => new Date(d).toISOString();

/**
 * 事件 → record() 入参。宽容解析：payload 缺字段也能出一条可用轨迹
 * （真实 > 讨好：宁可字段少，也不编造数据）。
 *
 * @param {object} envelope {topic, payload, source, ts}
 * @returns {object|null} null = 该事件不成轨迹（如 attribution 类 / 未知 topic）
 */
export function mapEvent(envelope) {
  const topic = envelope?.topic;
  const p = envelope?.payload ?? {};
  const now = iso(envelope?.ts ?? Date.now());
  const entry = SUBSCRIPTIONS.find((s) => s.topic === topic);
  if (!entry || entry.role !== 'record') return null;

  const base = { source: entry.source, via: 'event', steps: [], taskRef: {} };

  if (topic === 'dream.completed') {
    const dur = Number(p.durationMs) || 0;
    const ended = p.completedAt ?? now;
    return {
      ...base,
      kind: 'success',
      title: `dream sweep ${p.sweepId ?? ''}`.trim(),
      taskRef: { cronJob: 'night-dream' },
      startedAt: iso(Date.parse(ended) - dur),
      endedAt: ended,
      durationMs: dur,
      steps: [{
        seq: 0, role: 'observation',
        content: `candidates=${p.countCandidates ?? 0} gated=${p.countGated ?? 0} promoted=${p.countPromoted ?? 0} apply=${Boolean(p.apply)} diary=${p.diaryPath ?? '-'}`,
      }],
      final: { sweepId: p.sweepId ?? null, counts: { candidates: p.countCandidates ?? 0, gated: p.countGated ?? 0, promoted: p.countPromoted ?? 0 } },
    };
  }

  if (topic === 'evolution.proposed') {
    return {
      ...base,
      kind: 'success',
      title: `evolution.proposed ${p.proposalId ?? ''}`.trim(),
      taskRef: {
        variantId: p.variantId ?? null,
        candidateId: p.proposalId ?? null,
        round: Number.isInteger(p.round) ? p.round : null,
      },
      startedAt: now,
      endedAt: now,
      durationMs: 0,
      steps: [{ seq: 0, role: 'observation', content: JSON.stringify({ kind: p.kind ?? null, origin: p.origin ?? null }) }],
      final: { proposalId: p.proposalId ?? null, kind: p.kind ?? null, origin: p.origin ?? null },
    };
  }

  if (topic === 'evolution.evaluated') {
    const vetoed = p.decision === 'VETOED';
    return {
      ...base,
      kind: vetoed ? 'failure' : 'success',
      title: `evolution.evaluated ${p.targetId ?? ''}`.trim(),
      taskRef: { variantId: p.targetId ?? null },
      startedAt: now,
      endedAt: now,
      durationMs: 0,
      steps: [{ seq: 0, role: 'observation', content: `decision=${p.decision ?? 'SCORED'} composite=${p.scores?.composite ?? null}` }],
      final: { decision: p.decision ?? 'SCORED', scores: p.scores ?? null, findings: Array.isArray(p.findings) ? p.findings : [] },
      // 不猜 errorClass：等 diagnosis.completed 回填（真实 > 讨好）
      outcome: vetoed ? { errorMsg: 'VETOED by quality-eval composite score' } : {},
    };
  }

  if (topic === 'evoorch.task-started') {
    return {
      ...base,
      kind: 'success',
      title: `subagent start ${p.taskId ?? ''}`.trim(),
      taskRef: { subagentTaskId: p.taskId ?? null, batchId: p.batchId ?? null },
      startedAt: now, endedAt: now, durationMs: 0,
      steps: [{ seq: 0, role: 'observation', content: `retryCount=${p.retryCount ?? 0}` }],
      final: { phase: 'started' },
    };
  }

  if (topic === 'evoorch.task-completed') {
    const failed = p.status && p.status !== 'success' && p.status !== 'completed';
    const dur = Number(p.durationMs) || 0;
    const ended = now;
    return {
      ...base,
      kind: failed ? 'failure' : 'success',
      title: `subagent done ${p.taskId ?? ''} (${p.status ?? 'success'})`.trim(),
      taskRef: { subagentTaskId: p.taskId ?? null, batchId: p.batchId ?? null },
      startedAt: iso(Date.parse(ended) - dur),
      endedAt: ended,
      durationMs: dur,
      steps: [{ seq: 0, role: 'observation', content: `status=${p.status ?? 'success'} durationMs=${dur}` }],
      final: { status: p.status ?? 'success' },
      outcome: failed ? { errorMsg: `subagent status=${p.status}` } : {},
    };
  }

  return null;
}

/**
 * 从 diagnosis.completed 抽取归因钩子。
 * @returns {{errorClass?:string, attributionId?:string, trajectoryId?:string, sessionId?:string}|null}
 */
export function mapAttribution(envelope) {
  const p = envelope?.payload ?? {};
  const errorClass = typeof p.errorClass === 'string' ? p.errorClass : null;
  const attributionId = p.attributionId ?? p.diagnosisId ?? p.id ?? null;
  const trajectoryId = p.trajectoryId ?? null;
  const sessionId = p.sessionId ?? null;
  if (!errorClass && !attributionId) return null;
  return { errorClass, attributionId, trajectoryId, sessionId };
}

/**
 * 事件分发：attribution 类 → 回填归因；其余 → 走 record()。
 * 回调注入（不 import Service），保持本模块可单测。
 *
 * @param {object} deps
 * @param {Function} deps.record
 * @param {Function} deps.findAttributionTarget (ref) => row|null
 * @param {Function} deps.linkAttribution (id, patch) => row|null
 * @returns {Function} async (envelope) => void
 */
export function createEnvelopeHandler(deps = {}) {
  const { record, findAttributionTarget, linkAttribution } = deps;
  return async function handleEnvelope(envelope) {
    if (envelope?.topic === 'diagnosis.completed') {
      const ref = mapAttribution(envelope);
      if (!ref || typeof findAttributionTarget !== 'function') return;
      const target = await findAttributionTarget(ref);
      if (!target) return;
      await linkAttribution(target.id, { errorClass: ref.errorClass, attributionId: ref.attributionId });
      return;
    }
    const input = mapEvent(envelope);
    if (!input || typeof record !== 'function') return;
    await record(input);
  };
}

/**
 * 装配订阅。软依赖：subscribeFn 缺失 / 抛错 → 返回 degraded，调用方退回显式调用。
 *
 * @param {object} args
 * @param {Function|null} args.subscribeFn ctx.get('agint.eventBus.subscribe')
 * @param {Function} args.onEnvelope (envelope) => Promise|void
 * @param {string} [args.subscriber]
 * @returns {{subscribed:string[], degraded:boolean, reason:string|null, unsubscribe:Function|null}}
 */
export function attachSubscriptions(args = {}) {
  const { subscribeFn, onEnvelope, subscriber = 'agint-trajectory' } = args;
  // 订阅前**逐条过滤**：bus 侧 topics 是整批校验的，一条非法会连坐整批（2026-09-17
  // 事故），所以过滤责任放在订阅侧 —— 非法项只丢它自己，合法项照常订阅。
  const { valid: topics, dropped } = partitionValidTopics(SUBSCRIBED_TOPICS);
  if (typeof subscribeFn !== 'function') {
    return { subscribed: [], dropped, degraded: true, reason: 'agint.eventBus.subscribe unavailable', unsubscribe: null };
  }
  if (topics.length === 0) {
    return { subscribed: [], dropped, degraded: true, reason: 'no valid topic to subscribe', unsubscribe: null };
  }
  try {
    const off = subscribeFn(
      { subscriber, topics: [...topics], mode: 'async', timeoutMs: 5000 },
      async (envelope) => {
        try {
          await onEnvelope(envelope);
        } catch {
          /* 观察层内部异常绝不外溢（不变量 #1 fail-open） */
        }
      },
    );
    return {
      subscribed: [...topics],
      dropped,
      // 丢了非法 topic 但合法订阅成功 = **部分**降级（degraded 为真，但 subscribed 非空）
      degraded: dropped.length > 0,
      reason: dropped.length ? `invalid topic dropped: ${dropped.join(', ')}` : null,
      unsubscribe: typeof off === 'function' ? off : null,
    };
  } catch (err) {
    return { subscribed: [], dropped, degraded: true, reason: String(err?.message ?? err), unsubscribe: null };
  }
}
