/**
 * agint-curator — W2：`skills/change` 订阅（2026-11-03）
 * Run: node --test plugins/agint-curator/test/skills-change-watch.test.mjs
 *
 * 这个文件守的**不是**「收到事件就策展」，恰恰相反 —— 它守的是
 * **收到事件不许自动策展**。三条不许破的理由写在 lib/index.js 的 W2 段：
 *   1. run() 是秒级全量扫描，事件可能成批连发 ⇒ 会把一次目录操作放大成 N 次扫描；
 *   2. 自动归档不可逆，让目录变更引发归档会让「谁动了目录」与「谁被归档」焊死；
 *   3. 与 curriculum 的 goalAlignment 同口径：事件让系统**知道**，动手由人显式调。
 *
 * 阴性对照：把 `onChange` 改成直接 `void run(...)`，第 2 条用例必须红；
 *           把 `clearSkillsChangePending` 的 `if (!dryRun)` 去掉，第 4 条必须红。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../lib/index.js';
import { mockCtx, makeSkillsDir, makeStatsJsonl } from './_helpers.mjs';

/** 装一个能捕获订阅的假总线：把所有 (topic, handler) 记下来，供用例手工触发 */
function makeBus() {
  const subs = [];
  return {
    subs,
    subscribeService: (sub, handler) => { subs.push({ sub, handler }); },
    publishService: async () => ({ accepted: true, deliveredTo: [], deadLettered: [] }),
    fire(topic, event = {}) {
      for (const s of subs.filter((x) => x.sub?.topic === topic)) s.handler(event);
    },
  };
}

/** 建一个已挂载的 curator 实例，返回它暴露的服务 */
async function mount({ withBus = true } = {}) {
  const bus = makeBus();
  const skillsDir = makeSkillsDir([{ name: 'demo-skill', tools: ['bash'] }]);
  const stats = makeStatsJsonl([
    { tool: 'bash', sessionId: 's-1', timestamp: new Date().toISOString(), ok: true },
  ]);
  const services = {
    'agint.eventBus.publish': bus.publishService,
    ...(withBus ? { 'agint.eventBus.subscribe': bus.subscribeService } : {}),
  };
  const ctx = mockCtx(services);
  const config = { skills_dir: skillsDir, tool_stats_path: stats, auto_curation_enabled: true };
  apply(ctx, config);
  // ready 是 microtask 链，等一帧让订阅挂上
  await new Promise((r) => setTimeout(r, 30));
  return { ctx, bus, service: ctx._provided['agint.curator'], skillsDir, stats };
}

test('订阅 input.signal.host.skills-change（且只订阅这一条）', async () => {
  const { bus } = await mount();
  const topics = bus.subs.map((s) => s.sub?.topic);
  assert.deepEqual(topics, ['input.signal.host.skills-change']);
});

test('收到 skills/change 只置标记，绝不自动跑 run()', async () => {
  const { bus, service, ctx } = await mount();
  const before = service.skillsChange();
  // ⚠️ 订阅成功 ≠ 收到过事件。received 只表示「真的来过一条」，
  // 所以收到事件之前必须是 false —— 这个区分是本文件的第 6 条用例守的。
  assert.equal(before.received, false, '还没收到事件时 received 必须是 false');
  assert.equal(before.pending, false, '还没收到事件时不许说 pending');

  bus.fire('input.signal.host.skills-change');
  const after = service.skillsChange();
  assert.equal(after.pending, true, '收到事件后必须置 pending');
  assert.equal(after.batches, 1);

  // ⛔ 核心断言：没有自动策展的痕迹 —— reports 表必须还是空的
  const reports = await ctx.storageDomain.open().then((d) => d.table('reports'));
  assert.equal(reports._map.size, 0, '收到 skills/change 不许自动写 reports（= 不许自动跑 run）');
  // 也没有 run-completed 事件
  const audit = await ctx.storageDomain.open().then((d) => d.table('audit_log'));
  assert.equal(audit._map.size, 0, '不许自动 audit —— 自动跑 run() 会在这里留痕');
});

test('防抖：5 秒内的连发合并成一个批次，越过后另计一批', async () => {
  const { bus, service } = await mount();
  bus.fire('input.signal.host.skills-change');
  bus.fire('input.signal.host.skills-change');
  bus.fire('input.signal.host.skills-change');
  assert.equal(service.skillsChange().batches, 1, '5 秒内连发三次 = 一批（否则面板会被刷屏）');
  assert.equal(service.skillsChange().pending, true, '合并批次不影响「还没策展」这个事实');
});

test('真跑一次 run() 才清 pending；dry-run 不清（它没落盘也没归档）', async () => {
  const { bus, service } = await mount();
  bus.fire('input.signal.host.skills-change');
  assert.equal(service.skillsChange().pending, true);

  await service.dryRun({ nowMs: Date.now() });
  assert.equal(
    service.skillsChange().pending,
    true,
    'dry-run 不许清 pending —— 它没落盘、没归档，清了就等于谎报「已处理」',
  );

  await service.run({ nowMs: Date.now() });
  assert.equal(service.skillsChange().pending, false, '真跑过后才允许清 pending');
});

test('没有总线时纯降级：不抛、received=false，策展照常能跑', async () => {
  const { service } = await mount({ withBus: false });
  const st = service.skillsChange();
  assert.equal(st.received, false, '总线不在 ⇒ received 必须是 false，不能装作收到了');
  assert.equal(st.pending, false);
  const r = await service.run({ nowMs: Date.now() });
  assert.equal(typeof r.week, 'string', '降级后 run() 仍要能跑（这条守的是「退化不许变挂死」）');
});

test('received 与 pending 是两个问题：没通电 vs 通电了还没跑', async () => {
  const off = await mount({ withBus: false });
  const on = await mount();
  on.bus.fire('input.signal.host.skills-change');

  assert.deepEqual(
    [off.service.skillsChange().received, off.service.skillsChange().pending],
    [false, false],
    '没通电：received=false（链路问题）',
  );
  assert.deepEqual(
    [on.service.skillsChange().received, on.service.skillsChange().pending],
    [true, true],
    '通电未跑：received=true + pending=true（待办问题）',
  );
  // ⛔ 这两组值必须不同形 —— 否则排障时分不清是「没接上」还是「接上了没跑」
  assert.notDeepEqual(
    [off.service.skillsChange().received, off.service.skillsChange().pending],
    [on.service.skillsChange().received, on.service.skillsChange().pending],
  );
});
