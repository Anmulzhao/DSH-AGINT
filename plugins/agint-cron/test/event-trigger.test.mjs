/**
 * agint-cron 事件触发桥回归测试（2026-11-12，评估报告 §七 步骤 1）
 *
 * 纯逻辑 + 依赖注入，不挂 cordis、不连 3080、不碰 storages。
 * 覆盖评估 §四 / §五 / §六 的硬约束：
 *   - 事件触发执行**完整 run()**（用户拍板），不是只置标记
 *   - 失败保留 pending + 发终态事件，绝不吞异常
 *   - 启动补读只捡零投递事件，不重放已处理过的
 *   - 总线缺席时软降级，cron 兜底一个不删
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventTriggerBridge, EVENT_TRIGGERS, FAILURE_TOPIC } from '../lib/event-trigger.js';

// ⛔ node:test 下顶层 await import 必须在所有 test() 之前，否则撞 TDZ。
const { compileJobs } = await import('../lib/jobs.js');

const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setImmediate(r));
};

const DEFAULT_TRIGGERS = [
  {
    jobId: 'curator-weekly',
    topic: 'input.signal.host.skills-change',
    subscriber: 'agint-cron',
    debounceMs: 5000,
    cooldownMs: 6 * 3600_000,
    accept: () => true,
  },
  {
    jobId: 'evolve-review',
    topic: 'curator.run-completed',
    subscriber: 'agint-cron',
    debounceMs: 0,
    cooldownMs: 24 * 3600_000,
    accept: (e) => e?.payload?.dryRun === false,
  },
];

function harness(overrides = {}) {
  const calls = [];
  const pubs = [];
  const logs = overrides.logs ?? [];
  const timers = new Map();
  const subs = new Map();
  const offCalls = [];
  let seq = 0;
  let clock = 1_700_000_000_000;

  const bridge = createEventTriggerBridge({
    runNow: async (id, opts) => {
      calls.push({ id, opts });
      if (typeof overrides.runNow === 'function') return overrides.runNow(id, opts);
      return overrides.runNowResult ?? { ok: true, lastError: null };
    },
    subscribe: (sub, handler) => {
      for (const t of (Array.isArray(sub.topics) ? sub.topics : [])) {
        if (!subs.has(t)) subs.set(t, []);
        subs.get(t).push(handler);
      }
      return () => offCalls.push(sub.subscriber);
    },
    inspect: (filter) => overrides.inspect?.(filter) ?? [],
    publish: async (env) => {
      pubs.push(env);
      return overrides.publishResult ?? { accepted: true, envelopeId: 'test-id' };
    },
    now: () => (typeof overrides.now === 'function' ? overrides.now() : clock),
    schedule: (fn, ms) => { const h = ++seq; timers.set(h, { fn, ms }); return h; },
    cancel: (h) => { timers.delete(h); },
    log: (kind, detail) => { logs.push({ kind, detail }); },
    triggers: overrides.triggers ?? DEFAULT_TRIGGERS,
  });

  return {
    bridge, calls, pubs, logs, timers, subs, offCalls,
    advance: (ms) => { clock += ms; },
    emit: (topic, payload = {}) => {
      for (const h of (subs.get(topic) ?? [])) h({ topic, payload });
    },
    flush: async () => {
      for (const [h, { fn }] of [...timers.entries()]) {
        timers.delete(h);
        fn();
      }
      await settle();
    },
  };
}

const curator = (h) => h.bridge.status().triggers[0];

test('配置契约：两条快路径、5s 去抖、6h/24h 冷却、dry-run 过滤、失败 topic 字面量', () => {
  assert.equal(EVENT_TRIGGERS.length, 2);
  const [a, b] = EVENT_TRIGGERS;
  assert.equal(a.jobId, 'curator-weekly');
  assert.equal(a.topic, 'input.signal.host.skills-change');
  assert.equal(a.debounceMs, 5000);
  assert.equal(a.cooldownMs, 6 * 3600_000);
  assert.equal(b.jobId, 'evolve-review');
  assert.equal(b.topic, 'curator.run-completed');
  assert.equal(b.debounceMs, 0);
  assert.equal(b.cooldownMs, 24 * 3600_000);
  assert.equal(b.accept({ payload: { dryRun: false } }), true);
  assert.equal(b.accept({ payload: { dryRun: true } }), false);
  assert.equal(b.accept({}), false, '判不出来的 payload 一律不触发复盘');
  assert.equal(FAILURE_TOPIC, 'curator.run-failed');
});

test('cron 兜底仍在：两个 job 的排期与声明顺序未被事件桥改动', () => {
  const jobs = compileJobs();
  const ids = jobs.map((j) => j.id);
  const byId = new Map(jobs.map((j) => [j.id, j]));
  assert.ok(byId.has('curator-weekly'));
  assert.ok(byId.has('evolve-review'));
  assert.equal(byId.get('curator-weekly').schedule, '0 7 * * 1');
  assert.equal(byId.get('evolve-review').schedule, '30 7 * * 1');
  assert.ok(
    ids.indexOf('curator-weekly') < ids.indexOf('evolve-review'),
    '顺序契约：curator-weekly 声明顺序必须早于 evolve-review',
  );
});

test('skills-change → 真调 runNow(curator-weekly)（完整 run，不是只置标记）', async () => {
  const h = harness();
  const r = h.bridge.attach();
  assert.equal(r.attached, true);
  assert.equal(h.bridge.status().cronRetained, true);

  h.emit('input.signal.host.skills-change', { hostEvent: 'skills/change' });
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].ms, 5000);
  assert.equal(curator(h).pending, true);

  await h.flush();
  assert.deepEqual(h.calls.map((c) => c.id), ['curator-weekly']);
  assert.equal(curator(h).runs, 1);
  assert.equal(curator(h).pending, false);
  assert.equal(curator(h).lastError, null);
  assert.equal(h.pubs.length, 0, '成功路径不该由本桥另发终态事件（业务侧发 run-completed）');
});

test('5s 去抖：成批 skills/change 只跑一次全量策展', async () => {
  const h = harness();
  h.bridge.attach();
  h.emit('input.signal.host.skills-change');
  h.emit('input.signal.host.skills-change');
  h.emit('input.signal.host.skills-change');
  assert.equal(h.timers.size, 1, '三次变更必须合并成一个 timer');
  await h.flush();
  assert.equal(h.calls.length, 1);
});

test('6h 冷却：不重复跑，但 pending 保留（不吞也不假装跑过）', async () => {
  const h = harness();
  h.bridge.attach();
  h.emit('input.signal.host.skills-change');
  await h.flush();
  assert.equal(h.calls.length, 1);

  h.emit('input.signal.host.skills-change');
  await h.flush();
  assert.equal(h.calls.length, 1);
  assert.equal(curator(h).cooldownSkips, 1);
  assert.equal(curator(h).pending, true);

  // 冷却过后下一次变更可以再跑
  h.advance(6 * 3600_000 + 1);
  h.emit('input.signal.host.skills-change');
  await h.flush();
  assert.equal(h.calls.length, 2);
  assert.equal(curator(h).pending, false);
});

test('顺序链：dry-run 策展不触发 evolve-review，真跑才触发', async () => {
  const h = harness();
  h.bridge.attach();
  h.emit('curator.run-completed', { week: '2026-W46', dryRun: true });
  assert.equal(h.timers.size, 0, 'dry-run 连 timer 都不该排');
  await h.flush();
  assert.equal(h.calls.length, 0);

  h.emit('curator.run-completed', { week: '2026-W46', dryRun: false, summary: {} });
  await h.flush();
  assert.deepEqual(h.calls.map((c) => c.id), ['evolve-review']);
});

test('失败：ok:false → pending 保持 + 发 curator.run-failed 终态事件', async () => {
  const h = harness({ runNowResult: { ok: false, lastError: 'EPERM: rename ...' } });
  h.bridge.attach();
  h.emit('input.signal.host.skills-change');
  await h.flush();

  assert.equal(h.pubs.length, 1);
  assert.equal(h.pubs[0].topic, 'curator.run-failed');
  assert.equal(h.pubs[0].topic, FAILURE_TOPIC, '字面量与常量必须一致（门禁只扫字面量）');
  assert.equal(h.pubs[0].source, 'agint-cron');
  assert.equal(h.pubs[0].payload.jobId, 'curator-weekly');
  assert.equal(h.pubs[0].payload.triggerTopic, 'input.signal.host.skills-change');
  assert.match(h.pubs[0].payload.error, /EPERM/);
  assert.equal(curator(h).failures, 1);
  assert.equal(curator(h).pending, true);
  assert.equal(curator(h).lastTriggeredAt, null, '失败后必须允许下一次事件立即重试');

  // 冷却不该挡住失败后的重试
  h.emit('input.signal.host.skills-change');
  await h.flush();
  assert.equal(h.calls.length, 2);
});

test('失败：runNow 抛异常也不吞，照样发终态事件', async () => {
  const h = harness({ runNow: async () => { throw new Error('storage domain unavailable'); } });
  h.bridge.attach();
  h.emit('input.signal.host.skills-change');
  await h.flush();
  assert.equal(h.pubs.length, 1);
  assert.match(h.pubs[0].payload.error, /storage domain unavailable/);
  assert.equal(curator(h).pending, true);
  assert.ok(h.logs.some((l) => l.kind === 'threw'));
});

test('publish 返回 accepted:false（不抛异常）→ 记 failure-publish-rejected', async () => {
  const h = harness({
    runNowResult: { ok: false, lastError: 'boom' },
    publishResult: { accepted: false, envelopeId: '' },
  });
  h.bridge.attach();
  h.emit('input.signal.host.skills-change');
  await h.flush();
  assert.ok(
    h.logs.some((l) => l.kind === 'failure-publish-rejected'),
    '只 try/catch 会把「终态事件没发出去」当成成功',
  );
});

test('启动补读：只捡零投递事件，limit:0 不限量，不重放已处理过的', async () => {
  const seenFilters = [];
  const h = harness({
    inspect: (filter) => {
      seenFilters.push(filter);
      if (filter.topic !== 'input.signal.host.skills-change') return [];
      return [
        { topic: filter.topic, occurredAt: '2026-11-11T15:29:36.000Z', deliveries: {} },
        { topic: filter.topic, occurredAt: '2026-11-11T15:29:37.000Z', deliveries: {} },
        { topic: filter.topic, occurredAt: '2026-11-11T16:07:36.000Z', deliveries: { 'agint-curator': 'DELIVERED' } },
      ];
    },
  });
  const r = h.bridge.attach();
  assert.equal(r.recovered, 2, '两条零投递被补读，已 DELIVERED 那条不算');
  assert.ok(seenFilters.every((f) => f.limit === 0), '默认 limit=100 会漏，必须显式 0');
  assert.equal(curator(h).recovered, 1, '多条孤儿只补一次 pending，不放大成 N 次扫描');
  assert.equal(curator(h).pending, true);
  await h.flush();
  assert.deepEqual(h.calls.map((c) => c.id), ['curator-weekly']);
});

test('启动补读：ring entry 只有 payloadPreview 时保守判定，不硬造 dryRun', async () => {
  const h = harness({
    inspect: (filter) => filter.topic === 'curator.run-completed'
      ? [{ topic: filter.topic, deliveries: {}, payloadPreview: { __truncated: true } }]
      : [],
  });
  h.bridge.attach();
  assert.equal(h.timers.size, 0, 'dryRun 判不出来 ⇒ 不触发复盘');
  await h.flush();
  assert.equal(h.calls.length, 0);
});

test('总线未挂载 → attached:false，cronRetained 仍为 true，不抛错', () => {
  const logs = [];
  const bridge = createEventTriggerBridge({
    runNow: async () => ({ ok: true }),
    subscribe: null,
    log: (kind, detail) => logs.push({ kind, detail }),
  });
  const r = bridge.attach();
  assert.equal(r.attached, false);
  assert.equal(bridge.status().attached, false);
  assert.equal(bridge.status().cronRetained, true);
  assert.ok(logs.some((l) => l.kind === 'subscribe-unavailable'));
});

test('dispose 取消挂起 timer 与订阅，之后不再触发', async () => {
  const h = harness();
  h.bridge.attach();
  h.emit('input.signal.host.skills-change');
  assert.equal(h.timers.size, 1);
  h.bridge.dispose();
  assert.equal(h.timers.size, 0);
  assert.equal(h.offCalls.length, 2, '两条订阅各自 unsubscribe');
  await h.flush();
  h.emit('input.signal.host.skills-change');
  await h.flush();
  assert.equal(h.calls.length, 0);
});
