// GuardEngine 编排状态机单测（设计稿 §3.2 / §4.3 不变量映射）。

import test from 'node:test';
import assert from 'node:assert/strict';

import { GuardEngine } from '../lib/engine.js';
import { validateInsight } from '../lib/schema.js';
import { makeDomain, makeMemoryProvider } from './_helpers.mjs';

const TEXT = '老板拍板：P3-1 采用 B 档接线。最终配置：端口 3080。';

function makeEngine({ cfg = {}, memoryProvider = null, persistInsights, domain = makeDomain() } = {}) {
  const published = [];
  const engine = new GuardEngine({
    table: (n) => domain.table(n),
    config: () => ({
      enabled: true, shadowMode: true, llmExtractEnabled: false,
      maxInsightsPerCompress: 20, fallbackEnabled: true,
      extractTimeoutMs: 3000, recoveryProbeMs: 300000, sessionsRoot: '/tmp/sessions',
      ...cfg,
    }),
    memoryProvider,
    publish: async (topic, payload) => { published.push({ topic, payload }); return true; },
    persistInsights,
  });
  return { engine, published, domain };
}

test('正常全链路：B 档 host-compaction → PASSED + 洞察入库 + guard_log + checkpointed 事件', async () => {
  const { engine, published, domain } = makeEngine();
  const r = await engine.checkpoint({
    kind: 'host-compaction',
    id: 'compaction-abc',
    text: TEXT,
    shadowedSeqs: [3, 4, 5],
    shadowedTokenCount: 1200,
    sessionId: 'session-x',
  });
  assert.equal(r.status, 'PASSED');
  assert.equal(r.abortCompress, false);
  assert.equal(r.tier, 'B');
  assert.equal(r.checkpointRef.kind, 'host-compaction');
  assert.equal(r.checkpointId, 'compaction-abc');
  assert.ok(r.insightsExtracted >= 2, `至少拍板+配置两句，实际 ${r.insightsExtracted}`);
  assert.equal(r.rawBytes, 1200);

  // 洞察全部有合法 checkpointRef（不变量 1：raw 先于洞察）
  const insights = [...(await domain.table('insights')).entries()].map(([, v]) => v);
  assert.equal(insights.length, r.insightsExtracted);
  for (const ins of insights) {
    assert.equal(validateInsight(ins).ok, true, `洞察 ${ins.id} 违反不变量 1`);
    assert.equal(ins.source.checkpointRef.shadowedSeqs.length, 3);
  }

  // guard_log 一行 + 事件一条
  assert.equal((await domain.table('guard_log')).size, 1);
  const log = [...(await domain.table('guard_log')).entries()][0][1];
  assert.equal(log.status, 'PASSED');
  assert.equal(log.tier, 'B');
  assert.deepEqual(published.map((p) => p.topic), ['compress-guard.checkpointed']);
});

test('B 档无 shadowedSeqs：PASSED 但诚实备注（降为仅审计）', async () => {
  const { engine, domain } = makeEngine();
  const r = await engine.checkpoint({ kind: 'host-compaction', id: 'cp-x', text: TEXT });
  assert.equal(r.status, 'PASSED');
  const log = [...(await domain.table('guard_log')).entries()][0][1];
  assert.ok(log.note && log.note.includes('shadowedSeqs'));
});

test('无可提取文本：PASSED + 0 洞察（诚实 note，不编造）', async () => {
  const { engine, domain } = makeEngine();
  const r = await engine.checkpoint({ kind: 'p1-checkpoint', id: 'pcc_1', text: '' });
  assert.equal(r.status, 'PASSED');
  assert.equal(r.insightsExtracted, 0);
  const log = [...(await domain.table('guard_log')).entries()][0][1];
  assert.ok(log.note.includes('无可提取文本'));
});

test('C 档 raw 快照失败 + shadow 档：BLOCKED_CHECKPOINT 记账但 abortCompress=false', async () => {
  const mp = makeMemoryProvider({ failTimes: 1 });
  const { engine, published, domain } = makeEngine({ memoryProvider: mp });
  const r = await engine.checkpoint({ kind: 'p1-checkpoint', messages: [{ role: 'user', content: TEXT }] });
  assert.equal(r.status, 'BLOCKED_CHECKPOINT');
  assert.equal(r.abortCompress, false, 'shadow 档：记录告警不真中止（§七挂载策略）');
  assert.equal(r.shadowed, true);
  assert.ok(r.note.includes('shadow'));
  // BLOCKED 告警级事件必发（§5.2）
  const blocked = published.find((p) => p.topic === 'compress-guard.blocked');
  assert.ok(blocked, 'BLOCKED 必发告警事件');
  // counters 留痕
  const counters = await engine.getCounters();
  assert.equal(counters.checkpointWriteFailures, 1);
  assert.equal(counters.blockedShadowed, 1);
  // BLOCKED 不落洞察（硬门分支跳过 [2]）
  assert.equal((await domain.table('insights')).size, 0);
});

test('C 档 raw 快照失败 + 非 shadow：abortCompress=true（硬门不可被绕过）', async () => {
  const mp = makeMemoryProvider({ failTimes: 1 });
  const { engine } = makeEngine({ memoryProvider: mp, cfg: { shadowMode: false } });
  const r = await engine.checkpoint({ kind: 'p1-checkpoint', messages: [{ role: 'user', content: TEXT }] });
  assert.equal(r.status, 'BLOCKED_CHECKPOINT');
  assert.equal(r.abortCompress, true);
  assert.equal(r.shadowed, false);
});

test('C 档 raw 快照成功：checkpointId 来自 P1-1 返回，洞察挂上 pcc id', async () => {
  const mp = makeMemoryProvider();
  const { engine, domain } = makeEngine({ memoryProvider: mp });
  const r = await engine.checkpoint({ kind: 'p1-checkpoint', messages: [{ role: 'user', content: TEXT }] });
  assert.equal(r.status, 'PASSED');
  assert.match(r.checkpointId, /^pcc_test_\d{6}$/);
  const insights = [...(await domain.table('insights')).entries()].map(([, v]) => v);
  for (const ins of insights) {
    assert.equal(ins.source.checkpointRef.id, r.checkpointId);
    assert.equal(ins.linkPending, false);
  }
});

test('熔断 setEnabled(false)：压缩直通 + counters 留痕 + 不落 guard_log', async () => {
  const { engine, domain } = makeEngine();
  await engine.setEnabled(false);
  const r = await engine.checkpoint({ kind: 'host-compaction', id: 'cp-x', text: TEXT });
  assert.equal(r.status, 'DISABLED');
  assert.equal(r.disabled, true);
  assert.equal((await domain.table('guard_log')).size, 0);
  const counters = await engine.getCounters();
  assert.equal(counters.disabledPassThrough, 1);
  // 重新打开恢复工作
  await engine.setEnabled(true);
  const r2 = await engine.checkpoint({ kind: 'host-compaction', id: 'cp-y', text: TEXT });
  assert.equal(r2.status, 'PASSED');
});

test('提取软超时 → DEGRADED_INSIGHT（raw 兜底不受影响，extractFailures 计数）', async () => {
  const { engine, domain } = makeEngine({
    cfg: { extractTimeoutMs: 20 },
    persistInsights: async () => {
      await new Promise((r) => setTimeout(r, 200));
      return [];
    },
  });
  const r = await engine.checkpoint({ kind: 'host-compaction', id: 'cp-t', text: TEXT });
  assert.equal(r.status, 'DEGRADED_INSIGHT');
  assert.equal(r.abortCompress, false, '软降级不中止压缩（Q2 两段式）');
  const counters = await engine.getCounters();
  assert.equal(counters.extractFailures, 1);
  assert.equal((await domain.table('guard_log')).size, 1);
});

test('洞察全部持久化失败 → DEGRADED_INSIGHT（产出了但不落盘 ≠ 没产出，§十）', async () => {
  const { engine } = makeEngine({ persistInsights: async () => [] });
  const r = await engine.checkpoint({ kind: 'host-compaction', id: 'cp-f', text: TEXT });
  assert.equal(r.status, 'DEGRADED_INSIGHT');
  assert.ok(r.note.includes('持久化失败'));
});

test('fail-open：publish 抛错不炸 checkpoint（不变量 3，永不 throw）', async () => {
  const domain = makeDomain();
  const engine = new GuardEngine({
    table: (n) => domain.table(n),
    config: () => ({ enabled: true, shadowMode: true, llmExtractEnabled: false, maxInsightsPerCompress: 20, fallbackEnabled: true, extractTimeoutMs: 3000, recoveryProbeMs: 300000, sessionsRoot: '/tmp' }),
    publish: async () => { throw new Error('bus down'); },
  });
  const r = await engine.checkpoint({ kind: 'host-compaction', id: 'cp-e', text: TEXT });
  assert.equal(r.status, 'PASSED');
});

test('恢复探测（不变量 8）：失败降级 → 冷却期满 → 探针成功 → 复位 fail-closed', async () => {
  const mp = makeMemoryProvider({ failTimes: 2 });
  const { engine } = makeEngine({ memoryProvider: mp, cfg: { recoveryProbeMs: 50, shadowMode: false } });

  // 第一次：失败（BLOCKED）→ 计数 1、降级起点已记
  const r1 = await engine.checkpoint({ kind: 'p1-checkpoint', messages: [{ role: 'user', content: '老板拍板：方案一。' }] });
  assert.equal(r1.status, 'BLOCKED_CHECKPOINT');
  assert.equal(engine.consecutiveWriteFailures, 1);
  assert.ok(engine.degradedSince > 0);

  // 冷却期内第二次调用：不是探针（失败即计数 2）
  const r2 = await engine.checkpoint({ kind: 'p1-checkpoint', messages: [{ role: 'user', content: '老板拍板：方案二。' }] });
  assert.equal(r2.status, 'BLOCKED_CHECKPOINT');
  assert.equal(engine.consecutiveWriteFailures, 2);

  // 推进时间过冷却期 → 探针放行：这次 mock 成功 → 复位
  await new Promise((r) => setTimeout(r, 60));
  const r3 = await engine.checkpoint({ kind: 'p1-checkpoint', messages: [{ role: 'user', content: '老板拍板：方案三。' }] });
  assert.equal(r3.status, 'PASSED');
  assert.equal(engine.consecutiveWriteFailures, 0, '探针成功必须复位回 fail-closed（不变量 8）');
  assert.equal(engine.degradedSince, 0);
  const counters = await engine.getCounters();
  assert.equal(counters.recoveryProbes, 1);
});

test('恢复探测：冷却期内不放行探针', async () => {
  const mp = makeMemoryProvider({ failTimes: 1 });
  const { engine } = makeEngine({ memoryProvider: mp, cfg: { recoveryProbeMs: 60_000 } });
  await engine.checkpoint({ kind: 'p1-checkpoint', messages: [{ role: 'user', content: '老板拍板：一。' }] });
  assert.equal(engine.consecutiveWriteFailures, 1);
  // 立刻再试：探针计数应为 0（未到期）
  const countersBefore = await engine.getCounters();
  await engine.checkpoint({ kind: 'p1-checkpoint', messages: [{ role: 'user', content: '老板拍板：二。' }] });
  const counters = await engine.getCounters();
  assert.equal(counters.recoveryProbes, countersBefore.recoveryProbes);
});

test('stats 零数据：双源合计 0 → NO_SOURCE_REACHED（不变量 6，禁止静默空图）', async () => {
  const { engine } = makeEngine();
  const s = await engine.stats();
  assert.equal(s.status, 'NO_SOURCE_REACHED');
  assert.equal(s.noSourceReached, true);
  assert.equal(s.sourceHealth.p1CheckpointsSeen, 0);
  assert.equal(s.sourceHealth.hostCompactionsSeen, 0);
});

test('stats 有数据：OK + byType/byStatus/recallHitRate/tiers 档位登记', async () => {
  const { engine } = makeEngine();
  await engine.checkpoint({ kind: 'host-compaction', id: 'c1', text: TEXT, shadowedSeqs: [1] });
  await engine.bumpCounters({ hostCompactionsSeen: 1 });
  const s = await engine.stats();
  assert.equal(s.status, 'OK');
  assert.equal(s.sourceHealth.hostCompactionsSeen, 1);
  assert.equal(s.tiers.active, 'B+C');
  assert.equal(s.tiers.counts.B, 1);
  assert.equal(s.tiers.counts.A, 0, 'A 档已移出设计，永不产出');
  assert.ok(s.byType.preference >= 0);
});

test('search：默认排除 superseded 与 linkPending；includePending/includeSuperseded 显式开', async () => {
  const { engine, domain } = makeEngine();
  await engine.checkpoint({ kind: 'host-compaction', id: 'c1', text: TEXT, shadowedSeqs: [1] });
  const t = await domain.table('insights');
  const all = [...t.entries()].map(([, v]) => v);
  assert.ok(all.length > 0);
  // 造一条 pending
  const pendingRec = JSON.parse(JSON.stringify(all[0]));
  pendingRec.id = 'ins_pending_test';
  pendingRec.linkPending = true;
  pendingRec.source.checkpointRef.id = null;
  await t.put(pendingRec.id, pendingRec);
  // 造一条 superseded
  const supRec = JSON.parse(JSON.stringify(all[0]));
  supRec.id = 'ins_superseded_test';
  supRec.supersededBy = all[0].id;
  await t.put(supRec.id, supRec);

  const visible = await engine.search({ keyword: '拍板' });
  assert.ok(!visible.some((v) => v.id === 'ins_pending_test'), 'pending 默认不可见');
  assert.ok(!visible.some((v) => v.id === 'ins_superseded_test'), 'superseded 默认不可见');
  const withPending = await engine.search({ keyword: '拍板', includePending: true, includeSuperseded: true });
  assert.ok(withPending.some((v) => v.id === 'ins_pending_test'));
  assert.ok(withPending.some((v) => v.id === 'ins_superseded_test'));
});

test('supersededBy 链：旧洞察指向新洞察后 search 排除、stats 计 supersededCount', async () => {
  const { engine, domain } = makeEngine();
  await engine.checkpoint({ kind: 'host-compaction', id: 'c1', text: '老板拍板：v1 方案，端口 3080。', shadowedSeqs: [1] });
  const t = await domain.table('insights');
  const all = [...t.entries()].map(([, v]) => v);
  const oldRec = all[0];
  // 新洞察入库，旧洞察 supersededBy → 新（不改写历史，真实 > 讨好）
  const newRec = JSON.parse(JSON.stringify(oldRec));
  newRec.id = 'ins_new_version';
  newRec.supersededBy = null;
  await t.put(newRec.id, newRec);
  await t.put(oldRec.id, { ...oldRec, supersededBy: newRec.id });

  const s = await engine.stats();
  assert.equal(s.coverage.supersededCount, 1);
  const visible = await engine.search({ limit: 50 });
  assert.ok(visible.some((v) => v.id === newRec.id));
  assert.ok(!visible.some((v) => v.id === oldRec.id));
});

test('recall：命中 → recallCount/lastRecalledAt 更新 + recallHits 计数', async () => {
  const { engine, domain } = makeEngine();
  await engine.checkpoint({ kind: 'host-compaction', id: 'c1', text: '老板拍板：采用 B 档接线方案。', shadowedSeqs: [1] });
  const r = await engine.recall({ query: 'B 档' });
  assert.equal(r.status, 'HIT');
  assert.ok(r.insights.length > 0);
  const counters = await engine.getCounters();
  assert.equal(counters.recallHits, 1);
  const ins = [...(await domain.table('insights')).entries()].map(([, v]) => v)[0];
  assert.equal(ins.recallCount, 1);
  assert.ok(ins.lastRecalledAt);
});

test('recall：miss → recallMisses 诚实计数 + status MISS', async () => {
  const { engine } = makeEngine();
  const r = await engine.recall({ query: '不存在的关键词xyz' });
  assert.equal(r.status, 'MISS');
  const counters = await engine.getCounters();
  assert.equal(counters.recallMisses, 1);
});

test('extract：无 checkpointRef 显式拒绝（不变量 1 离线补录也要 raw 引用）', async () => {
  const { engine } = makeEngine();
  await assert.rejects(
    () => engine.extract({ text: TEXT }),
    /checkpointRef 必填/,
  );
});

test('extract：带 checkpointRef 正常入库（离线补录路径）', async () => {
  const { engine, domain } = makeEngine();
  const rows = await engine.extract({
    text: '老板拍板：离线补录方案可行。',
    checkpointRef: { kind: 'p1-checkpoint', id: 'pcc_offline_1' },
  });
  assert.ok(rows.length >= 1);
  const insights = [...(await domain.table('insights')).entries()].map(([, v]) => v);
  assert.ok(insights.some((i) => i.source.checkpointRef.id === 'pcc_offline_1'));
});

test('setLlmExtract(true) 显式拒绝（Q1 默认关，Sprint 21 拍板）；reindex 显式未实现', async () => {
  const { engine } = makeEngine();
  await assert.rejects(() => engine.setLlmExtract(true), /Sprint 21/);
  await assert.rejects(() => engine.reindex(), /未实现/);
});
