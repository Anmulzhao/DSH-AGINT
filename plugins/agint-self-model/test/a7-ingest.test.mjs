/**
 * test/a7-ingest.test.mjs — Sprint 16 / A7「建消费者」影子对账器测试
 *
 * 覆盖：
 *   1. 纯函数：findLatency / rebuildSnapshot / compareSnapshot
 *   2. apply 注册了 metrics.snapshot 的 async 订阅（此前订阅方为 0）
 *   3. 攒批语义：generatedAt 变化才结算上一批
 *   4. 判定口径：结构不对称才 mismatch；值漂移只记录不判定（时差必然）
 *   5. 影子纪律：不写任何表；handler 喂垃圾 payload 永不抛
 *   6. 去重 + inspectSummary 暴露
 *   7. onPersist 节流落盘钩子（v0.7.3）：结算触发 / 节流 / 异常吞掉 / flush 强制落
 *
 * 跑法（cwd = 仓库根）：
 *   node test/a7-ingest.test.mjs     或     node --test test/
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const AGINT_ROOT = process.cwd();
const url = (rel) => pathToFileURL(resolve(AGINT_ROOT, rel)).href;

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log('✓', name); }
  else { fail += 1; console.log('✗', name, extra); }
}

const ingest = await import(url('plugins/agint-self-model/lib/metricsIngest.js'));
const selfModel = await import(url('plugins/agint-self-model/lib/index.js'));

const { findLatency, rebuildSnapshot, compareSnapshot, createSnapshotIngest, METRICS_SNAPSHOT_TOPIC } = ingest;

// ── 1. 纯函数 ──────────────────────────────────────────────────────────────
ok('findLatency 命中 latency 变体', findLatency([{ key: 'e2e.latency-ms', value: 12 }])?.value === 12);
ok('findLatency 无命中返回 null', findLatency([{ key: 'tool.calls', value: 3 }]) === null);
ok('findLatency 非 number 值返回 null', findLatency([{ key: 'latency', value: 'x' }]) === null);
ok('rebuildSnapshot 形状对齐直连', (() => {
  const s = rebuildSnapshot({ generatedAt: 'T1', metrics: [{ key: 'a', value: 1 }] });
  return s.asOf === 'T1' && s.count === 1 && s.metrics[0].key === 'a';
})());
ok('compareSnapshot 两侧都有 latency → matched',
  compareSnapshot({ count: 1, metrics: [{ key: 'latency', value: 5 }] }, { count: 1, metrics: [{ key: 'latency', value: 5 }] }).matched);
ok('compareSnapshot 值漂移不判 mismatch',
  compareSnapshot({ count: 1, metrics: [{ key: 'latency', value: 5 }] }, { count: 1, metrics: [{ key: 'latency', value: 9 }] }).valueDrift === true
  && compareSnapshot({ count: 1, metrics: [{ key: 'latency', value: 5 }] }, { count: 1, metrics: [{ key: 'latency', value: 9 }] }).matched);
ok('compareSnapshot 结构不对称 → mismatch',
  compareSnapshot({ count: 1, metrics: [{ key: 'latency', value: 5 }] }, { count: 1, metrics: [{ key: 'other', value: 5 }] }).reason === 'latency-missing-in-direct');
ok('compareSnapshot 两侧都无 latency → 视为 ok',
  compareSnapshot({ count: 1, metrics: [{ key: 'a', value: 1 }] }, { count: 1, metrics: [{ key: 'a', value: 1 }] }).reason === 'no-latency-key');

// ── 2. 攒批 + 结算 ─────────────────────────────────────────────────────────
let directSnapshot = { metrics: [{ key: 'e2e.latency-ms', value: 42 }] };
const ev = (generatedAt, key, value, snapshotId = 's1') => ({
  topic: METRICS_SNAPSHOT_TOPIC, version: 1, source: 'agint-metrics',
  payload: { snapshotId, generatedAt, key, value, delta: null, tags: { source: 'agint-metrics' } },
});

const inst = createSnapshotIngest({ getDirectSnapshot: async () => directSnapshot });
await inst.ingest(ev('T1', 'e2e.latency-ms', 42, 'a'));
await inst.ingest(ev('T1', 'tool.calls', 7, 'b'));
ok('同批次未切换时不结算', inst.stats().compared === 0 && inst.stats().events === 2);
await inst.ingest(ev('T2', 'e2e.latency-ms', 43, 'c'));
ok('generatedAt 变化触发上一批结算', inst.stats().compared === 1);
ok('结构一致 → matched', inst.stats().matched === 1 && inst.stats().mismatched === 0);
ok('同值不算漂移', inst.stats().valueDrift === 0);
ok('一致率可计算', inst.stats().consistencyRate === 1);

// 值漂移：直连值变了（时差导致），应只记录不判 mismatch
const instDrift = createSnapshotIngest({ getDirectSnapshot: async () => ({ metrics: [{ key: 'e2e.latency-ms', value: 99 }] }) });
await instDrift.ingest(ev('U1', 'e2e.latency-ms', 42, 'da'));
await instDrift.ingest(ev('U2', 'e2e.latency-ms', 42, 'db'));
ok('值漂移被记录但不判 mismatch',
  instDrift.stats().valueDrift === 1 && instDrift.stats().matched === 1 && instDrift.stats().mismatched === 0);

// 重复事件去重
await inst.ingest(ev('T2', 'e2e.latency-ms', 43, 'c'));
ok('重复 snapshotId+key 被去重', inst.stats().duplicates === 1);

// 结构不对称 → mismatch
directSnapshot = { metrics: [{ key: 'tool.calls', value: 7 }] };
await inst.ingest(ev('T3', 'x', 1, 'd'));
ok('结构不对称 → mismatched', inst.stats().mismatched === 1);
ok('mismatch 记录原因', inst.stats().lastMismatch?.reason === 'latency-missing-in-direct');

// 垃圾 payload 不抛
let threw = false;
try {
  await inst.ingest(null);
  await inst.ingest({});
  await inst.ingest({ payload: { key: 'k' } });
} catch { threw = true; }
ok('handler 喂垃圾 payload 永不抛', threw === false);

// 影子期不写表：stats 里没有写库计数（batches 只增不写）
const beforeBatches = inst.stats().batches;
await inst.flush();
ok('flush 后批次计入', inst.stats().batches === beforeBatches + 1);

// ── 3. apply 注册订阅 ──────────────────────────────────────────────────────
function mockCtx(services = {}) {
  const provided = new Map(Object.entries(services));
  return {
    get: (k) => provided.get(k) ?? null,
    provide: (k, v) => provided.set(k, v),
    effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {}; } catch { return () => {}; } },
    storageDomain: { open: () => { throw new Error('test: no real storage'); } },
    on: () => () => {},
  };
}

const subscriptions = [];
const services = {
  'agint.eventBus.publish': async () => ({ accepted: true }),
  'agint.eventBus.subscribe': (sub, handler) => { subscriptions.push({ sub, handler }); return () => {}; },
  'agint.evolution': { queryFailures: async () => [], queryTemplates: async () => [], addFailure: async () => ({}), getLogRange: async () => [], stats: async () => ({}) },
  'agint.diagnosis': { report: async () => ({ rootCauseDistribution: { REASONING_ERROR: 1 } }) },
  'agint.metrics': { snapshot: async () => ({ metrics: [{ key: 'e2e.latency-ms', value: 42 }] }), collect: async () => ({}), summary: async () => ({ asOf: 'now', count: 1, metrics: [{ key: 'e2e.latency-ms', value: 42 }] }) },
  'agint.toolStats': { summary: async () => ({ summary: [] }) },
};
const ctx = mockCtx(services);
selfModel.apply(ctx, {});

const topics = subscriptions.map((s) => (s.sub?.topics ?? []).join(','));
ok('A7 metrics.snapshot 已注册订阅（此前为 0）', topics.includes('metrics.snapshot'));
ok('A7 订阅为 async（不占 sync 配额）',
  subscriptions.find((s) => (s.sub?.topics ?? []).includes('metrics.snapshot'))?.sub?.mode === 'async');
ok('订阅者名为 agint-self-model',
  subscriptions.every((s) => s.sub?.subscriber === 'agint-self-model'));
ok('A6/A8 订阅未丢失', topics.includes('diagnosis.completed') && topics.includes('dream.completed'));

// 真喂事件给 apply 注册的 handler
const a7 = subscriptions.find((s) => (s.sub?.topics ?? []).includes('metrics.snapshot'));
await a7.handler(ev('TA', 'e2e.latency-ms', 42, 'x1'));
await a7.handler(ev('TB', 'e2e.latency-ms', 42, 'x2'));
const inspect = await ctx.get('agint.selfModel.inspectSummary')();
ok('inspectSummary 暴露 metricsIngest', !!inspect.metricsIngest);
ok('metricsIngest 记录了事件', inspect.metricsIngest.events === 2);
ok('metricsIngest 完成了一次对账', inspect.metricsIngest.compared === 1);
ok('metricsIngest 模式为 apply（T2 切换后）', inspect.metricsIngest.mode === 'apply');
ok('影子期一致率为 1', inspect.metricsIngest.consistencyRate === 1);

// ── 7. onPersist 节流落盘钩子（v0.7.3）────────────────────────────────────
{
  const writes = [];
  const inst = ingest.createSnapshotIngest({
    getDirectSnapshot: async () => ({ asOf: 'now', count: 1, metrics: [{ key: 'e2e.latency-ms', value: 42 }] }),
    onPersist: (s) => writes.push(s),
    persistIntervalMs: 0, // 关闭节流，方便断言
  });
  await inst.ingest(ev('P1', 'e2e.latency-ms', 42, 's1'));
  await inst.ingest(ev('P2', 'e2e.latency-ms', 42, 's2')); // 批切换 → 结算 → onPersist
  ok('结算触发 onPersist', writes.length === 1 && writes[0].compared === 1, `writes=${writes.length}`);
  ok('onPersist 收到一致率快照', writes[0].consistencyRate === 1);
  await inst.ingest(ev('P3', 'e2e.latency-ms', 42, 's3'));
  ok('interval=0 时每次结算都落盘', writes.length === 2, `writes=${writes.length}`);

  const bad = ingest.createSnapshotIngest({
    getDirectSnapshot: async () => ({ asOf: 'now', count: 1, metrics: [{ key: 'x', value: 1 }] }),
    onPersist: () => { throw new Error('boom'); },
    persistIntervalMs: 0,
  });
  let threw = false;
  try {
    await bad.ingest(ev('Q1', 'x', 1, 'q1'));
    await bad.ingest(ev('Q2', 'x', 1, 'q2'));
  } catch { threw = true; }
  ok('onPersist 抛异常被吞、影子主流程存活', threw === false);

  const fw = [];
  const finst = ingest.createSnapshotIngest({
    getDirectSnapshot: null, // skipped 路径也要能落盘（记 skipped 计数）
    onPersist: (s) => fw.push(s),
    persistIntervalMs: 60_000, // 节流开着
  });
  await finst.ingest(ev('F1', 'x', 1, 'f1'));
  await finst.flush();
  // 2 次属预期：settle 的 skipped 路径节流落盘 1 次（首次必落）+ flush 强制兜底 1 次（幂等覆盖）
  ok('flush 后统计已落盘（节流 + 强制兜底，幂等）', fw.length === 2, `fw=${fw.length}`);
  ok('落盘内容记录了 skipped', fw[1].skipped === 1);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
