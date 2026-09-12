#!/usr/bin/env node
/**
 * agint-trajectory smoke — `node test/smoke.mjs` 一行能跑（plugin-check 维度 6）。
 *
 * 不挂 Cordis、不开真 storage domain：用内存 domain 走完整条主链路
 *   五源 record → count-only 标定 → 切 live → stats → ShareGPT 分离导出
 * 并断言五条 FROZEN 不变量的可见行为。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as plugin from '../lib/index.js';
import * as schema from '../lib/schema.js';
import * as storage from '../lib/storage.js';
import { SUBSCRIBED_TOPICS } from '../lib/subscribers.js';
import { createFakeDomain, mount } from './_helpers.mjs';

const checks = [];
const ok = (label, fn) => {
  fn();
  checks.push(`  ✓ ${label}`);
};

// 1. 导出契约 + 域声明
ok('导出契约：name / inject / optionalInject / apply / ConfigSchema', () => {
  assert.equal(plugin.name, 'agint-trajectory');
  assert.deepEqual(plugin.inject, ['storageDomain']);
  assert.ok(plugin.optionalInject.includes('agint.eventBus'));
  assert.equal(typeof plugin.apply, 'function');
});
ok('域：agint_trajectory / schemaVersion 1 / 3 表（不变量 #1 独占）', () => {
  assert.equal(storage.spec.name, 'agint_trajectory');
  assert.equal(storage.spec.version, 1);
  const tables = Object.keys(storage.spec.tables ?? storage.spec.config?.tables ?? {});
  for (const t of ['trajectories', 'counters', 'calibration']) assert.ok(tables.includes(t), t);
});
ok('默认档位 count-only（不变量 #5：必须 count-only 起步）', () => {
  assert.equal(schema.ConfigSchema.parse({}).recordMode, 'count-only');
});
ok('订阅清单：只列已核实存在的事件（§5.1）', () => {
  assert.ok(SUBSCRIBED_TOPICS.includes('dream.completed'));
  assert.ok(SUBSCRIBED_TOPICS.includes('evolution.evaluated'));
  assert.ok(!SUBSCRIBED_TOPICS.includes('subagent.ended'), 'v0.1 虚构事件不得回归');
});

const run = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'traj-smoke-'));
  try {
    const h = await mount(plugin, {
      sampleRates: { task: 1, dream: 1, eval: 1, evolution: 1, subagent: 1 },
      exportDir: dir,
    }, { domain: createFakeDomain() });
    const svc = h.service;

    // 2. count-only 干跑：不落盘但产出体积估算
    const dry = await svc.record({
      source: 'task', kind: 'success', title: 'dry',
      steps: [{ seq: 0, role: 'human', content: 'hello' }],
    });
    assert.equal(dry.reason, 'count-only');
    assert.ok(dry.bytes > 0);
    checks.push('  ✓ count-only 干跑：不落盘但产出体积估算（§7.1）');

    // 3. 不变量 #5 硬门禁
    assert.throws(() => svc.setRecordMode('live'), /缺少标定期报告/);
    checks.push('  ✓ 不变量 #5：无标定期报告时切 live 抛错');
    const report = svc.calibration();
    assert.equal(report.ready, true);
    svc.setRecordMode('live');
    checks.push(`  ✓ 标定期报告 ready：perDay=${report.perDay} p95=${report.p95Bytes}B 建议容量=${report.suggested.maxCount} 条`);

    // 4. 五源落盘（§2.1 R1）
    for (const source of ['task', 'dream', 'eval', 'evolution', 'subagent']) {
      const r = await svc.record({
        source,
        kind: source === 'evolution' ? 'failure' : 'success',
        title: `${source} demo`,
        taskRef: { variantId: 'v-1', round: 7, subagentTaskId: source === 'subagent' ? 't1' : null },
        steps: [
          { seq: 0, role: 'human', content: 'do it' },
          { seq: 1, role: 'gpt', content: 'ok', tool: 'bash', toolOk: true },
          { seq: 2, role: 'observation', content: 'done' },
        ],
        final: { decision: 'DONE' },
      });
      assert.ok(r.id, `${source} 应落盘`);
    }
    const s = await svc.stats();
    assert.equal(s.total, 5);
    assert.equal(Object.keys(s.bySource).length, 5);
    checks.push('  ✓ 五源落盘：task / dream / eval / evolution / subagent');

    // 5. fail-open 混沌：注入写失败，主链路无感
    const broken = await mount(plugin, { sampleRates: { task: 1 }, failStreakLimit: 5 },
      { domain: createFakeDomain({ failPutFor: 'trajectories' }) });
    for (let i = 0; i < 2; i++) {
      await broken.service.record({ source: 'task', steps: [{ seq: 0, role: 'human', content: 'calib' }] });
    }
    broken.service.calibration();
    broken.service.setRecordMode('live');
    for (let i = 0; i < 5; i++) {
      const r = await broken.service.record({ source: 'task', steps: [{ seq: 0, role: 'human', content: 'x' }] });
      assert.equal(r.reason, 'error');
    }
    const bst = await broken.service.state();
    assert.equal(bst.counters.writeFailures, 5);
    assert.equal(bst.enabled, false, '连续 5 次写失败自动熔断');
    checks.push('  ✓ fail-open：写失败不抛、计数留痕、连续 5 次熔断（不变量 #1）');

    // 6. 分离导出 + 自检
    const res = await svc.export({ format: 'sharegpt', date: '2026-11-16' });
    assert.equal(res.counts.success, 4);
    assert.equal(res.counts.failure, 1);
    assert.equal(res.valid, true);
    checks.push(`  ✓ 分离导出：success=${res.counts.success} failure=${res.counts.failure}（不变量 #3）+ 自检通过`);

    console.log('agint-trajectory smoke: PASS');
    for (const c of checks) console.log(c);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

run().catch((err) => {
  console.error('agint-trajectory smoke: FAIL');
  console.error(err);
  process.exit(1);
});
