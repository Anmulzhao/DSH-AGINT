/**
 * test/t2-sync-drill.mjs — T2 演练脚本：A2 `evolution.evaluated` sync 边三场景
 *
 * 为什么要有这个脚本：A2 是 T2 里风险最高的一条边 —— 唯一 sync 门禁边
 * （agint-quality-policy 订阅，timeoutMs 5000，门禁决策必须等评分确定后才推进）。
 * 切流量之前必须证明：handler 出事时，发布方主路径不会跟着死。
 *
 * 三个场景（切边清单 §3 A2）：
 *   1. handler 抛错  → 该订阅者 DEAD_LETTERED + 死信落库；publish 本身不抛；
 *                      其余订阅者照常 DELIVERED（隔离）
 *   2. handler 超时  → PENDING_REVIEW 降级 + pendingReview 被调用 + 按时返回不卡死
 *   3. bus 不可用    → 发布方软降级（拿不到 publish 服务 / publish 抛错），
 *                      评分主路径照常返回（模拟 agint-quality-eval score() 的写法）
 *   4. 护栏：sync 全局配额 3，第 4 个 sync 订阅硬抛
 *
 * 跑法：node --test plugins/agint-event-bus/test/t2-sync-drill.mjs
 *      或 node plugins/agint-event-bus/test/t2-sync-drill.mjs（cwd = 仓库根）
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const url = (rel) => pathToFileURL(resolve(ROOT, rel)).href;

const { publish, subscribe, disposeBus } = await import(url('plugins/agint-event-bus/lib/bus.js'));
// SYNC_GLOBAL_LIMIT 只在 lib/index.js 对外导出（bus.js 内部是私有 const）
const { SYNC_GLOBAL_LIMIT } = await import(url('plugins/agint-event-bus/lib/index.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log('✓', name); }
  else { fail += 1; console.log('✗', name, extra); }
}

/** Mock EventBusContext（与 a9-a10.test.mjs 同型） */
function makeCtx() {
  const events = new Map();
  const deadletter = new Map();
  const calls = { pendingReview: 0, metrics: [] };
  const ctx = {
    tables: {
      events: {
        get: async (id) => events.get(id) ?? null,
        put: async (id, v) => { events.set(id, v); },
        delete: async (id) => { events.delete(id); },
        entries: () => events.entries(),
        size: async () => events.size,
      },
      deadletter: {
        get: async (id) => deadletter.get(id) ?? null,
        put: async (id, v) => { deadletter.set(id, v); },
        delete: async (id) => { deadletter.delete(id); },
        entries: () => deadletter.entries(),
        size: async () => deadletter.size,
      },
    },
    pendingReview: async () => { calls.pendingReview += 1; },
    metrics: (key, delta) => { calls.metrics.push({ key, delta }); },
    logBuffered: async () => {},
  };
  return { ctx, calls, events, deadletter };
}

const TOPIC = 'evolution.evaluated';
const envelope = (id = 'e1') => ({
  topic: TOPIC, version: 1, source: 'agint-quality-eval',
  occurredAt: new Date().toISOString(), traceId: `t-${id}`,
  payload: { evaluationId: id, score: 0.8 },
});

// ── 场景 1：handler 抛错 ────────────────────────────────────────────────────
{
  disposeBus();
  const { ctx, calls, deadletter } = makeCtx();
  let otherDelivered = false;

  subscribe({ subscriber: 'policy-throwing', topics: [TOPIC], mode: 'sync', reason: '门禁决策必须等评分确定后才推进', timeoutMs: 500, retry: { maxAttempts: 1, backoffMs: 50 } },
    async () => { throw new Error('policy handler boom'); });
  subscribe({ subscriber: 'audit-ok', topics: [TOPIC], mode: 'async', retry: { maxAttempts: 1, backoffMs: 50 } },
    async () => { otherDelivered = true; });

  let result = null;
  let threw = false;
  try { result = await publish(ctx, envelope('s1')); } catch { threw = true; }

  ok('场景1 publish 不抛（主路径存活）', threw === false);
  // 注意：publish 的 deliveredTo / deadLettered 是订阅者名的字符串数组，不是对象数组
  ok('场景1 抛错订阅者 → 进 deadLettered', (result?.deadLettered ?? []).includes('policy-throwing'),
    JSON.stringify(result?.deadLettered));
  ok('场景1 死信已落库', deadletter.size >= 1);
  ok('场景1 死信标记 sync=true', [...deadletter.values()].some((d) => d?.sync === true));
  ok('场景1 死信保留原始错误原因',
    [...deadletter.values()].some((d) => String(d?.reason ?? '').includes('policy handler boom')));
  ok('场景1 其他订阅者不受影响',
    (result?.deliveredTo ?? []).includes('audit-ok') && otherDelivered === true,
    JSON.stringify(result?.deliveredTo));
}

// ── 场景 2：handler 超时 ────────────────────────────────────────────────────
{
  disposeBus();
  const { ctx, calls } = makeCtx();

  subscribe({ subscriber: 'policy-slow', topics: [TOPIC], mode: 'sync', reason: '门禁决策必须等评分确定后才推进', timeoutMs: 250, retry: { maxAttempts: 1, backoffMs: 50 } },
    () => new Promise(() => {})); // 永不 resolve

  const t0 = Date.now();
  const result = await publish(ctx, envelope('s2'));
  const elapsed = Date.now() - t0;

  // PENDING_REVIEW 在 publish 返回值里落不到 deliveredTo / deadLettered
  // （只记进事件日志的 delivery 记录），所以靠副作用判定
  ok('场景2 超时未算投递成功', !(result?.deliveredTo ?? []).includes('policy-slow'));
  ok('场景2 超时未进死信（是降级不是失败）', !(result?.deadLettered ?? []).includes('policy-slow'));
  ok('场景2 pendingReview 被调用一次', calls.pendingReview === 1);
  ok('场景2 syncTimeout 已计数', calls.metrics.some((m) => m.key === 'eventBus.syncTimeout'));
  ok('场景2 在超时点附近返回不卡死', elapsed >= 200 && elapsed < 3000, `elapsed=${elapsed}ms`);
}

// ── 场景 3：bus 不可用（发布方视角软降级）──────────────────────────────────
{
  disposeBus();

  // 复刻 agint-quality-eval score() 末尾的写法：publish 失败 log 不抛，
  // 不影响评分主路径。
  async function scoreLike({ publishService }) {
    const score = { overall: 0.82, decision: 'PASS' };
    try {
      if (typeof publishService === 'function') await publishService(envelope('s3'));
    } catch { /* 演练：bus 不可用 → 静默，主路径继续 */ }
    return score;
  }

  const s1 = await scoreLike({ publishService: null });
  ok('场景3 publish 服务缺失 → 评分照常返回', s1.overall === 0.82 && s1.decision === 'PASS');

  const s2 = await scoreLike({ publishService: async () => { throw new Error('bus down'); } });
  ok('场景3 publish 抛错 → 评分照常返回', s2.overall === 0.82 && s2.decision === 'PASS');
}

// ── 场景 4：sync 配额护栏 ───────────────────────────────────────────────────
{
  disposeBus();
  let lastThrew = false;
  for (let i = 1; i <= SYNC_GLOBAL_LIMIT + 1; i += 1) {
    try {
      subscribe({ subscriber: `sync-${i}`, topics: [TOPIC], mode: 'sync', reason: `drill ${i}`, timeoutMs: 100, retry: { maxAttempts: 1, backoffMs: 50 } },
        async () => {});
    } catch {
      lastThrew = true;
    }
  }
  ok(`场景4 第 ${SYNC_GLOBAL_LIMIT + 1} 个 sync 订阅硬抛（配额=${SYNC_GLOBAL_LIMIT}）`, lastThrew === true);
  disposeBus();
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
