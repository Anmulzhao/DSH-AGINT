/**
 * agint-trajectory Service 单测（§4.1 FROZEN 5 + §4.2 非 FROZEN）。
 *
 * 用内存 domain（_helpers.mjs）跑真实 Service 行为，重点是不变量：
 *   #1 fail-open（写失败不抛 + 计数器留痕 + 连续 5 次熔断）
 *   #2 真实截断（truncated/droppedSteps）
 *   #3 分离导出（success/failure 两文件）
 *   #5 标定期门禁（无 ready 报告 setRecordMode('live') 抛错）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as plugin from '../lib/index.js';
import { createFakeDomain, mount } from './_helpers.mjs';

const input = (over = {}) => ({
  source: 'task',
  kind: 'success',
  title: 'demo task',
  taskRef: { sessionId: 's1', variantId: 'v1', round: 3 },
  startedAt: '2026-11-03T00:00:00Z',
  endedAt: '2026-11-03T00:01:00Z',
  steps: [
    { seq: 0, role: 'human', content: 'do it' },
    { seq: 1, role: 'gpt', content: 'ok', tool: 'bash', toolOk: true },
  ],
  final: { decision: 'DONE' },
  ...over,
});

/** 切到 live：count-only 先攒标定期样本 → calibration() → setRecordMode('live') */
async function toLive(service, n = 3) {
  for (let i = 0; i < n; i++) await service.record(input({ title: `t${i}` }));
  const report = service.calibration();
  service.setRecordMode('live');
  return report;
}

test('导出契约：name / inject / optionalInject / apply / ConfigSchema / spec', () => {
  assert.equal(plugin.name, 'agint-trajectory');
  assert.deepEqual(plugin.inject, ['storageDomain']);
  assert.ok(plugin.optionalInject.includes('agint.eventBus'));
  assert.equal(typeof plugin.apply, 'function');
  assert.ok(plugin.ConfigSchema);
  assert.equal(plugin.spec.name, 'agint_trajectory');
  assert.equal(plugin.spec.version, 1);
});

test('默认 count-only：不落盘但计数（§7.1：count-only ≠ sample=0）', async () => {
  const { service } = await mount(plugin, {});
  const r = await service.record(input());
  assert.equal(r.id, null);
  assert.equal(r.reason, 'count-only');
  assert.ok(r.bytes > 0, 'count-only 仍产出体积估算（标定期目的）');
  const s = await service.stats();
  assert.equal(s.total, 0, '未落盘');
  assert.equal(s.mode, 'count-only');
  assert.ok(s.counters.dayCount >= 1, '计数路径执行了');
});

test('不变量 #5：无标定期报告时 setRecordMode("live") 抛错（硬门禁）', async () => {
  const { service } = await mount(plugin, { sampleRates: { task: 1 } });
  assert.throws(() => service.setRecordMode('live'), /缺少标定期报告|setRecordMode\('live'\) rejected/);
  // 有 ready 报告后才允许
  const report = await toLive(service);
  assert.equal(report.ready, true);
  const st = await service.state();
  assert.equal(st.recordMode, 'live');
  const r = await service.record(input());
  assert.ok(r.id, 'live 档落盘');
});

test('live 落盘：get / list / stats 闭环 + 发布 trajectory.recorded', async () => {
  const { service, published } = await mount(plugin, { sampleRates: { task: 1 } });
  await toLive(service);
  const r = await service.record(input({ title: 'abc', source: 'dream', kind: 'failure' }));
  assert.ok(r.id);
  const got = await service.get(r.id);
  assert.equal(got.title, 'abc');
  assert.equal(got.kind, 'failure');
  assert.equal(got.source, 'dream');

  const list = await service.list({ source: 'dream', kind: 'failure', limit: 10 });
  assert.equal(list.length, 1);
  const none = await service.list({ source: 'eval' });
  assert.equal(none.length, 0);

  const s = await service.stats();
  assert.equal(s.total, 1);
  assert.equal(s.byKind.failure, 1);
  assert.ok(s.totalBytes > 0);
  assert.equal(s.calibrationReady, true);
  assert.ok(published.some((e) => e.topic === 'trajectory.recorded'));
});

test('list：taskRef 精确匹配 + limit 上限 100 + 时间窗', async () => {
  const { service } = await mount(plugin, { sampleRates: { task: 1 } });
  await toLive(service, 1);
  await service.record(input({ taskRef: { sessionId: 's1', variantId: 'vX' } }));
  await service.record(input({ taskRef: { sessionId: 's1', variantId: 'vY' } }));
  assert.equal((await service.list({ taskRef: { variantId: 'vX' } })).length, 1);
  assert.equal((await service.list({ taskRef: { sessionId: 's1' } })).length, 2);
  assert.equal((await service.list({ limit: 1 })).length, 1);
  assert.equal((await service.list({ limit: 9999 })).length, 2, 'limit 硬上限 100');
  const win = await service.list({ timeRange: { from: '2026-11-03T00:00:30Z', to: '2026-11-03T23:00:00Z' } });
  assert.equal(win.length, 0);
});

test('不变量 #1 fail-open：写失败不抛 + writeFailures 留痕 + 连续 5 次熔断', async () => {
  const domain = createFakeDomain({ failPutFor: 'trajectories' });
  const { service } = await mount(plugin, { sampleRates: { task: 1 }, failStreakLimit: 5 }, { domain });
  await toLive(service, 1);
  for (let i = 0; i < 5; i++) {
    const r = await service.record(input({ title: `f${i}` }));
    assert.equal(r.id, null, '永不 throw，返回 reason');
    assert.equal(r.reason, 'error');
  }
  const st = await service.state();
  assert.equal(st.counters.writeFailures, 5);
  assert.equal(st.enabled, false, '连续 5 次写失败 → 自动熔断');
  const after = await service.record(input());
  assert.equal(after.reason, 'disabled');
  assert.equal((await service.state()).counters.droppedDisabled, 1);
});

test('熔断可手动恢复：setEnabled(true) 后落盘恢复', async () => {
  const { service } = await mount(plugin, { sampleRates: { task: 1 } });
  await toLive(service, 1);
  service.setEnabled(false);
  assert.equal((await service.record(input())).reason, 'disabled');
  service.setEnabled(true);
  const r = await service.record(input({ source: 'dream' }));
  assert.ok(r.id, '恢复后落盘');
});

test('日配额：超 maxPerDay 丢弃 + droppedFull + 发布 budget-exhausted', async () => {
  const { service, published } = await mount(plugin, { sampleRates: { task: 1 }, maxPerDay: 2 });
  await toLive(service, 1);
  const a = await service.record(input());
  const b = await service.record(input());
  const c = await service.record(input());
  assert.ok(a.id && b.id);
  assert.equal(c.id, null);
  assert.equal(c.reason, 'quota');
  const st = await service.state();
  assert.equal(st.counters.droppedFull, 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(published.some((e) => e.topic === 'trajectory.budget-exhausted'));
});

test('拒记：单条超 rejectBytes → droppedPayload（不落盘）', async () => {
  const { service } = await mount(plugin, { sampleRates: { task: 1 }, rejectBytes: 200 });
  await toLive(service, 1);
  const r = await service.record(input({ steps: [{ seq: 0, role: 'human', content: 'x'.repeat(500) }] }));
  assert.equal(r.id, null);
  assert.equal(r.reason, 'payload-too-large');
  assert.equal((await service.state()).counters.droppedPayload, 1);
});

test('不变量 #2：截断必置 truncated + droppedSteps（保头保尾）', async () => {
  const { service } = await mount(plugin, {
    sampleRates: { task: 1 }, maxPayloadBytes: 800, observationSummaryChars: 500,
  });
  await toLive(service, 1);
  const steps = Array.from({ length: 12 }, (_, i) => ({ seq: i, role: 'observation', content: 'y'.repeat(200) }));
  const r = await service.record(input({ steps }));
  assert.ok(r.id);
  assert.equal(r.truncated, true);
  const t = await service.get(r.id);
  assert.equal(t.truncated, true);
  assert.ok(t.payload.droppedSteps > 0);
  const kept = t.payload.steps.map((s) => s.seq);
  assert.equal(kept[0], 0, '保头');
  assert.equal(kept[kept.length - 1], 11, '保尾（结局优先）');
  const st = await service.stats();
  assert.equal(st.counters.truncatedCount, 1);
  assert.ok(st.truncateRate > 0);
});

test('脱敏：命中置 redacted=true 且内容被替换（范围覆盖参数正文）', async () => {
  const { service } = await mount(plugin, { sampleRates: { task: 1 } });
  await toLive(service, 1);
  const r = await service.record(input({
    steps: [{ seq: 0, role: 'human', content: 'token sk-abcdefghijklmnopqrstuv' }],
  }));
  const t = await service.get(r.id);
  assert.equal(t.redacted, true);
  assert.ok(!JSON.stringify(t.payload).includes('sk-abcdefghijklmnopqrstuv'));
  assert.ok(JSON.stringify(t.payload).includes('[REDACTED]'));
});

test('采样：setSample(source, 0) → sampled-out 不落盘（不计丢弃）', async () => {
  const { service } = await mount(plugin, { sampleRates: { task: 1 } });
  await toLive(service, 1);
  service.setSample('task', 0);
  const r = await service.record(input());
  assert.equal(r.reason, 'sampled-out');
  const st = await service.state();
  assert.equal(st.counters.sampledOut, 1);
  assert.equal(st.counters.droppedFull, 0, '采样未命中不计入丢弃');
});

test('linkAttribution：回填 errorClass / attributionId / variantId', async () => {
  const { service } = await mount(plugin, { sampleRates: { task: 1 } });
  await toLive(service, 1);
  const r = await service.record(input({ kind: 'failure', source: 'evolution' }));
  const linked = await service.linkAttribution(r.id, {
    errorClass: 'TOOL_GAP', attributionId: 'diag-1', variantId: 'v-9',
  });
  assert.equal(linked.outcome.errorClass, 'TOOL_GAP');
  assert.equal(linked.outcome.attributionId, 'diag-1');
  assert.equal(linked.taskRef.variantId, 'v-9');
  assert.equal(await service.linkAttribution('nope', {}), null);
});

test('prune：过期删除 + pinned 豁免 + 发布 trajectory.pruned', async () => {
  const { service, published } = await mount(plugin, { sampleRates: { task: 1 } });
  await toLive(service, 1);
  const old = await service.record(input({ startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z' }));
  const pinned = await service.record(input({ pinned: true, startedAt: '2026-01-02T00:00:00Z', endedAt: '2026-01-02T00:01:00Z' }));
  const fresh = await service.record(input({ startedAt: '2026-11-02T00:00:00Z', endedAt: '2026-11-02T00:01:00Z' }));
  const res = await service.prune({ maxAgeDays: 90 });
  assert.ok(res.removed >= 1);
  assert.equal(await service.get(old.id), null, '过期删除');
  assert.ok(await service.get(pinned.id), 'pinned 豁免');
  assert.ok(await service.get(fresh.id), '保留期内不动');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(published.some((e) => e.topic === 'trajectory.pruned'));
});

test('prune：条数/字节容量触顶时删最旧非 pinned', async () => {
  const { service } = await mount(plugin, { sampleRates: { task: 1 } });
  await toLive(service, 1);
  await service.record(input({ startedAt: '2026-11-01T00:00:00Z', endedAt: '2026-11-01T00:01:00Z' }));
  await service.record(input({ startedAt: '2026-11-02T00:00:00Z', endedAt: '2026-11-02T00:01:00Z' }));
  const res = await service.prune({ maxAgeDays: 90, maxCount: 1, maxBytes: 1024 * 1024 * 1024 });
  assert.equal(res.removed, 1);
  assert.equal((await service.stats()).total, 1);
});

test('不变量 #3：export 成功/失败物理分离两个文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'traj-exp-'));
  try {
    const { service } = await mount(plugin, { sampleRates: { task: 1 }, exportDir: dir });
    await toLive(service, 1);
    await service.record(input({ kind: 'success', source: 'dream' }));
    await service.record(input({ kind: 'failure', source: 'eval', outcome: { errorClass: 'TOOL_GAP' } }));
    const res = await service.export({ format: 'sharegpt', date: '2026-11-16' });
    assert.equal(res.counts.success, 1);
    assert.equal(res.counts.failure, 1);
    assert.equal(res.valid, true, '导出自检通过');
    const okText = await readFile(res.successPath, 'utf8');
    const failText = await readFile(res.failurePath, 'utf8');
    assert.equal(okText.trim().split('\n').length, 1);
    assert.equal(failText.trim().split('\n').length, 1);
    assert.ok(!okText.includes('TOOL_GAP'), '元数据不进 ShareGPT 体');
    const idx = JSON.parse(await readFile(res.indexPath, 'utf8'));
    assert.equal(idx.entries.length, 2);
    assert.ok(idx.entries.some((e) => e.errorClass === 'TOOL_GAP'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dispose：ctx.effect disposer 关闭 domain', async () => {
  const domain = createFakeDomain();
  const h = await mount(plugin, {}, { domain });
  assert.equal(domain.closed.value, false);
  for (const fn of h.effects) {
    const d = fn();
    if (typeof d === 'function') await d();
    else if (d && typeof d.then === 'function') await d;
  }
  assert.equal(domain.closed.value, true);
});
