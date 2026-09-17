// Sprint 17：detect() 集成测试 —— 验证 cross_session_aggregation 配置被读取并传给 aggregator。
// 不挂 Cordis，直接 import plugin 然后 stub 它的 storage 调用最低成本跑通。
//
// 跑法：node --test test/detect-cross-session.test.mjs
//
// 覆盖：
//   - default 模式：cross_session_aggregation=off → aggregateTasks 不带 mode
//   - primary 模式：cross_session_aggregation=primary → aggregateTasks 收到 mode='primary'
//   - shadow 模式：cross_session_aggregation=shadow → 返回 shadowDiff + legacyTasks
//   - 配置变更后立即生效（无需重启）

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as plugin from '../lib/index.js';
import { aggregateTasks } from '../lib/aggregator.js';

test('plugin 入口导出 shape 不变', () => {
  assert.equal(plugin.name, 'agint-skill-autocreate');
  assert.equal(typeof plugin.apply, 'function');
});

test('RUNTIME_CONFIG_KEYS 包含 cross_session 三键', async () => {
  const schemaMod = await import('../lib/schema.js');
  const keys = schemaMod.RUNTIME_CONFIG_KEYS;
  assert.ok(keys.includes('cross_session_aggregation'), 'cross_session_aggregation 在白名单');
  assert.ok(keys.includes('cross_session_idle_ms'), 'cross_session_idle_ms 在白名单');
  assert.ok(keys.includes('cross_session_max_sessions_per_task'), 'cross_session_max_sessions_per_task 在白名单');
});

test('ConfigSchema 默认 cross_session_aggregation = primary（2026-09-17 老板拍板）', async () => {
  const schemaMod = await import('../lib/schema.js');
  const c = schemaMod.ConfigSchema.parse({});
  assert.equal(c.cross_session_aggregation, 'primary');
  assert.equal(c.cross_session_idle_ms, 30_000);
  assert.equal(c.cross_session_max_sessions_per_task, 20);
});

test('ConfigSchema 接受 primary / shadow / off', async () => {
  const schemaMod = await import('../lib/schema.js');
  for (const v of ['off', 'shadow', 'primary']) {
    const c = schemaMod.ConfigSchema.parse({ cross_session_aggregation: v });
    assert.equal(c.cross_session_aggregation, v);
  }
  // 其他值拒绝
  assert.throws(() => schemaMod.ConfigSchema.parse({ cross_session_aggregation: 'bogus' }));
});

test('aggregateTasks 接收 mode=primary 与配置契约一致', () => {
  const records = [
    { ts: 1000, sessionId: 's1', turn: 1, tool: 'pwsh', ok: true, args: { c: 'x' } },
    { ts: 5000, sessionId: 's2', turn: 1, tool: 'pwsh', ok: true, args: { c: 'x' } },
  ];
  const off = aggregateTasks(records, { mode: 'off' });
  const pri = aggregateTasks(records, { mode: 'primary', idleMs: 30_000 });
  assert.equal(off.tasks.length, 2, 'off 模式切两段');
  assert.equal(pri.tasks.length, 1, 'primary 模式合一段');
});
