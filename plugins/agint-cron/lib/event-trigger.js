/**
 * agint-cron —— 事件触发桥（2026-11-12，评估报告 §七 步骤 1）
 *
 * WHY：把「到点才做」的 cron job 加一条「状态变了就做」的快路径，同时
 * **不删任何 cron**（评估 §六 第 3 条：本轮是「降级为兜底」，不是取消）。
 *
 * 为什么放在 agint-cron 而不是各业务插件：
 *   1. `agint.cron.runNow(id)` 是唯一复用 runOne 的执行入口 —— 重试、lastResult
 *      记账、persistJobState、health() 全在这一条路径上，不必在 curator / evolve
 *      里各写一套「跑一次」的逻辑（两套口径必然漂移）。
 *   2. 事件订阅集中在调度层，顺序契约（curator → evolve-review）由 topic 链
 *      表达，不靠「希望这一小时内机器没重启」。
 *   3. 业务插件（curator）保持「只提供能力、不自己决定什么时候动手」的职责。
 *
 * ⛔ 三条硬纪律（评估 §四 / §五 / §七）：
 *   - **cron 兜底不可去**：默认 job 表一个不删（评估口径 27、当前 29），
 *     事件只是快路径。⛔ 也不改写
 *     runOne 的 lastRunAt 记账 —— 曾设计 `keepDueOnFailure`（失败不写
 *     lastRunAt 以保持 due），重读 cron.js 的 isDue() 后否决：due 取的是
 *     「最近一次自然周期触发时刻」，事件失败写不写 lastRunAt 都不妨碍下个
 *     周期补跑；反而若 job 从未跑过（lastRunAt=null）却不写，tick 每 60s
 *     判一次 due ⇒ 每分钟重跑一次全量策展（风暴）。失败自愈靠 pending 保持
 *     + 终态事件，不靠篡改调度语义。
 *   - **失败也要发终态事件**：只发成功事件会让链静默断在半路（§4.2 硬要求）。
 *     ⚠️ publish 校验失败返回 accepted:false **不抛异常**，必须显式判。
 *   - **启动补读**：§五 实测启动瞬间订阅者还没注册，事件进了 ring 但 delivered 0。
 *     订阅注册后补读 ring 里「零投递」的同 topic 事件，把它们补进 pending，
 *     否则「机器重启后第一次技能变更」必然丢 —— 而那正是最需要策展的时刻。
 *
 * 纯逻辑 + 依赖注入，可离线单测，不 import cordis / dsh。
 */

/** 触发配置表。新增条目必须同步登记 topic（bin/verify-event-topics.mjs）。 */
export const EVENT_TRIGGERS = Object.freeze([
  {
    jobId: 'curator-weekly',
    topic: 'input.signal.host.skills-change',
    subscriber: 'agint-cron',
    // 复用 curator W2 的 5s 去抖口径（curator/lib/index.js:135）：
    // 技能目录变更会成批连发，不去抖就把一次目录操作放大成 N 次全量扫描。
    debounceMs: 5000,
    // 去抖之上的第二层护栏：避免一天内反复全量策展。冷却中 pending 保留，
    // 等下一次变更或周一 07:00 的 cron 兜底，不吞也不假装跑过。
    cooldownMs: 6 * 3600_000,
    accept: () => true,
  },
  {
    jobId: 'evolve-review',
    topic: 'curator.run-completed',
    subscriber: 'agint-cron',
    debounceMs: 0,
    cooldownMs: 24 * 3600_000,
    // ⛔ dry-run 的策展不算「本周策展已完成」：周复盘必须吃真跑过的报告。
    // curator.run-completed 的 payload 是 { week, trigger, dryRun, summary }。
    accept: (envelope) => envelope?.payload?.dryRun === false,
  },
]);

/** 失败终态事件：成功由业务侧发 curator.run-completed，失败必须单独发一条。 */
// ⚠️ publish 处必须写**字面量**（verify-event-topics 的 topic-prop 正则只认引号）；
//    本常量供 log / 单测引用，两者一致性由 test/event-trigger.test.mjs 断言锁定。
export const FAILURE_TOPIC = 'curator.run-failed';

export function createEventTriggerBridge({
  runNow,
  subscribe = null,
  inspect = null,
  publish = null,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
  log = () => {},
  triggers = EVENT_TRIGGERS,
} = {}) {
  if (typeof runNow !== 'function') throw new Error('event-trigger: runNow 必须是函数');

  const state = new Map();
  for (const t of triggers) {
    state.set(t.jobId, {
      jobId: t.jobId, topic: t.topic,
      subscribed: false, pending: false, timer: null,
      lastTriggeredAt: null, runs: 0, failures: 0,
      recovered: 0, cooldownSkips: 0, lastError: null,
    });
  }
  const offs = [];
  let disposed = false;

  const emitFailure = async (trigger, errorText) => {
    if (typeof publish !== 'function') return false;
    try {
      const result = await publish({
        topic: 'curator.run-failed',     // ⛔ 字面量：门禁静态扫描只认引号，不能写常量
        source: 'agint-cron',
        payload: { jobId: trigger.jobId, triggerTopic: trigger.topic, error: String(errorText).slice(0, 300) },
      });
      // ⛔ publish 的入参校验失败是 `accepted:false` + 空 envelopeId，不抛异常
      //   （bus.js:84-92）。只 try/catch 会把「终态事件没发出去」当成成功。
      if (result && result.accepted === false) {
        log('failure-publish-rejected', { jobId: trigger.jobId, topic: FAILURE_TOPIC });
        return false;
      }
      return true;
    } catch (e) {
      log('failure-publish-error', { jobId: trigger.jobId, error: String(e?.message ?? e) });
      return false;
    }
  };

  /** 真正跑一次 job。失败时保留 pending + 发终态事件，绝不吞异常。 */
  const fire = async (trigger) => {
    const s = state.get(trigger.jobId);
    if (disposed || !s?.pending) return;
    const ts = now();
    // 冷却只对「成功跑过」生效：失败后 lastTriggeredAt 会被清空，
    // 下一次变更必须能立刻重试（评估 §4.1「跑失败 → pending 保持 true」）。
    if (s.lastTriggeredAt !== null && ts - s.lastTriggeredAt < (trigger.cooldownMs ?? 0)) {
      s.cooldownSkips += 1;
      log('cooldown', { jobId: trigger.jobId, pending: true });
      return;
    }
    try {
      // 复用 agint.cron.runNow(id)：重试 / lastResult / persistJobState / health()
      // 全在这条路径上。⛔ 只透传**只读的触发源标注**，不传任何改写 lastRunAt
      // 的选项 —— 见头注释硬纪律 1。标注经 jobs.js 落到 curator.run-completed
      // 的 payload.trigger，让终态事件能自证「这次是事件触发，不是周一 07:00
      // 的 cron 兜底」（2026-11-12 补，解决验收遗留 1）。
      const result = await runNow(trigger.jobId, {
        triggerSource: 'event:' + trigger.topic,
      });
      if (result?.ok === true) {
        s.pending = false;
        s.runs += 1;
        s.lastTriggeredAt = ts;
        s.lastError = null;
        log('ok', { jobId: trigger.jobId });
      } else {
        s.failures += 1;
        s.lastError = result?.lastError ?? 'runNow 未返回 ok';
        s.lastTriggeredAt = null; // 允许下一次事件立即重试
        log('failed', { jobId: trigger.jobId, error: s.lastError });
        await emitFailure(trigger, s.lastError);
      }
    } catch (error) {
      s.failures += 1;
      s.lastError = String(error?.message ?? error);
      s.lastTriggeredAt = null;
      log('threw', { jobId: trigger.jobId, error: s.lastError });
      await emitFailure(trigger, s.lastError);
    }
  };

  const enqueue = (trigger, envelope, recovered = false) => {
    if (disposed) return;
    if (typeof trigger.accept === 'function' && !trigger.accept(envelope)) return;
    const s = state.get(trigger.jobId);
    if (!s) return;
    if (recovered) s.recovered += 1;
    s.pending = true;
    if (s.timer !== null) {
      try { cancel(s.timer); } catch { /* ignore */ }
      s.timer = null;
    }
    const delay = Math.max(0, Number(trigger.debounceMs) || 0);
    s.timer = schedule(() => {
      s.timer = null;
      void fire(trigger);
    }, delay);
  };

  /**
   * 启动补读（§五 的 B 半边）：订阅者注册时，ring 里可能已有「发布过但
   * 零投递」的同 topic 事件 —— 那正是开机瞬间没人收的那批。补进 pending。
   * 只认 deliveries 为空的 entry，避免把已被别的订阅者处理过的事件重放。
   */
  const recover = (trigger) => {
    if (typeof inspect !== 'function') return 0;
    let entries;
    try {
      // limit: 0 = 不限（observability.js filterEntries 明文口径），默认 100 会漏。
      entries = inspect({ topic: trigger.topic, limit: 0 }) ?? [];
    } catch (e) {
      log('recover-inspect-error', { jobId: trigger.jobId, error: String(e?.message ?? e) });
      return 0;
    }
    const orphans = (Array.isArray(entries) ? entries : [])
      .filter((e) => !e?.deliveries || Object.keys(e.deliveries).length === 0);
    if (orphans.length === 0) return 0;
    const last = orphans[orphans.length - 1];
    // ring entry 只有 payloadPreview（可能截断），没有完整 payload；
    // accept 会据此保守判定（例如 dryRun 判不出来 ⇒ 不触发复盘），不硬造字段。
    enqueue(trigger, { ...last, payload: last.payload ?? last.payloadPreview ?? {} }, true);
    return orphans.length;
  };

  const attach = () => {
    if (typeof subscribe !== 'function') {
      log('subscribe-unavailable', { reason: 'agint.eventBus.subscribe 未提供，事件快路径关闭，cron 兜底照常' });
      return { attached: false, recovered: 0 };
    }
    let recovered = 0;
    for (const trigger of triggers) {
      try {
        const off = subscribe(
          { subscriber: trigger.subscriber, topics: [trigger.topic], mode: 'async' },
          (envelope) => enqueue(trigger, envelope),
        );
        if (typeof off === 'function') offs.push(off);
        state.get(trigger.jobId).subscribed = true;
        recovered += recover(trigger);
      } catch (e) {
        log('subscribe-error', { jobId: trigger.jobId, error: String(e?.message ?? e) });
      }
    }
    return { attached: offs.length > 0, recovered };
  };

  const status = () => ({
    generatedAt: new Date(now()).toISOString(),
    attached: offs.length > 0,
    subscribed: [...state.values()].filter((s) => s.subscribed).length,
    cronRetained: true, // 契约：本桥只加事件快路径，永不删 cron job
    triggers: [...state.values()].map((s) => ({ ...s, timer: s.timer !== null })),
  });

  const dispose = () => {
    disposed = true;
    for (const s of state.values()) {
      if (s.timer !== null) {
        try { cancel(s.timer); } catch { /* ignore */ }
        s.timer = null;
      }
    }
    for (const off of offs.splice(0)) {
      try { off(); } catch { /* ignore */ }
    }
  };

  return { attach, status, dispose, enqueue, fire };
}
