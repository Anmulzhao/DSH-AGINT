/**
 * agint-trajectory schema 单测：枚举 / 默认值 / 预算方程 / id 与日键。
 * 依据：设计稿 §3.2（schema）、§7.2（治理参数）、§7.4（预算方程）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCES, KINDS, ERROR_CLASSES, ROLES, RECORD_MODES, VIAS, DEFAULTS,
  ConfigSchema, CountersSchema, CalibrationStateSchema, TrajectorySchema,
  computeBudget, makeTrajectoryId, dayKey, clampText, DOMAIN_NAME, SCHEMA_VERSION,
} from '../lib/schema.js';

test('枚举：五源 / 三态 / 七类根因 / 四角色（§3.2）', () => {
  assert.deepEqual([...SOURCES], ['task', 'dream', 'eval', 'evolution', 'subagent']);
  assert.deepEqual([...KINDS], ['success', 'failure', 'aborted']);
  assert.equal(ERROR_CLASSES.length, 7);
  assert.ok(ERROR_CLASSES.includes('UNCERTAIN'), 'diagnosis 六类 + UNCERTAIN 兜底');
  assert.deepEqual([...ROLES], ['system', 'human', 'gpt', 'observation']);
  assert.deepEqual([...RECORD_MODES], ['count-only', 'live']);
  assert.deepEqual([...VIAS], ['explicit', 'event']);
});

test('治理参数默认值（§7.2）', () => {
  assert.equal(DEFAULTS.MAX_PAYLOAD_BYTES, 256 * 1024);
  assert.equal(DEFAULTS.REJECT_BYTES, 1024 * 1024);
  assert.equal(DEFAULTS.MAX_PER_DAY, 200);
  assert.equal(DEFAULTS.RETENTION_DAYS, 90);
  assert.equal(DEFAULTS.FAIL_STREAK_LIMIT, 5);
  assert.equal(DEFAULTS.OBSERVATION_SUMMARY_CHARS, 200);
  assert.equal(DEFAULTS.ERROR_MSG_CHARS, 500);
  assert.equal(DEFAULTS.SAMPLE_RATES.task, 0.1, 'task 采样待标定，初值 10%');
  assert.equal(DEFAULTS.SAMPLE_RATES.failure ?? DEFAULTS.SAMPLE_RATES.dream, 1);
});

test('预算方程：maxCount = 保留期 × 日均 × 安全系数；maxBytes = maxCount × P95（§7.4）', () => {
  const b = computeBudget({ perDay: 10, p95Bytes: 65 * 1024 }, { retentionDays: 90, safetyFactor: 2 });
  assert.equal(b.maxCount, 1800);
  assert.equal(b.maxBytes, 1800 * 65 * 1024);
  // MAX_PER_DAY 不参与容量规划（职责分离）
  const zero = computeBudget({ perDay: 0, p95Bytes: 0 });
  assert.equal(zero.maxCount, 0);
  assert.equal(zero.maxBytes, 0);
});

test('配置默认值：导出目录/工具统计路径跟随 DSH_HOME（可移植性，不变量 #4）', () => {
  const prev = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = '/tmp/dsh-home';
    const c = ConfigSchema.parse({});
    assert.equal(c.exportDir, '/tmp/dsh-home/trajectories/export');
    assert.equal(c.toolStatsPath, '/tmp/dsh-home/storages/agint_tool_stats.jsonl');
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
});

test('配置宽容：未知字段 passthrough（cordis patch 可能带额外键）', () => {
  const c = ConfigSchema.parse({ unknownKey: 'x', maxPerDay: 7 });
  assert.equal(c.maxPerDay, 7);
  assert.equal(c.unknownKey, 'x');
});

test('CountersSchema / CalibrationStateSchema / TrajectorySchema 可空解析', () => {
  const c = CountersSchema.parse({});
  assert.equal(c.droppedFull, 0);
  assert.equal(c.truncatedCount, 0);
  assert.equal(c.total, 0);
  const s = CalibrationStateSchema.parse({});
  assert.deepEqual(s.sampleBytes, []);
  assert.deepEqual(s.byDay, {});
  const t = TrajectorySchema.parse({
    id: 'traj_20261103_0000000a', source: 'dream', kind: 'success',
    startedAt: '2026-11-03T00:00:00Z', endedAt: '2026-11-03T00:01:00Z', createdAt: '2026-11-03T00:01:00Z',
  });
  assert.equal(t.durationMs, 0);
  assert.deepEqual(t.payload.steps, []);
  assert.equal(t.truncated, false);
  assert.equal(t.via, 'explicit');
});

test('TrajectorySchema 拒绝非法枚举（schema 是硬门禁，不是建议）', () => {
  assert.throws(() => TrajectorySchema.parse({
    id: 'x', source: 'unknown-source', kind: 'success', startedAt: 'a', endedAt: 'b', createdAt: 'c',
  }));
  assert.throws(() => TrajectorySchema.parse({
    id: 'x', source: 'task', kind: 'win', startedAt: 'a', endedAt: 'b', createdAt: 'c',
  }));
});

test('id / dayKey / clampText 形状', () => {
  const id = makeTrajectoryId(new Date('2026-11-03T10:00:00Z'), 'seed');
  assert.match(id, /^traj_20261103_[0-9a-f]{8}$/);
  assert.equal(dayKey(new Date('2026-11-03T23:59:59Z')), '2026-11-03');
  assert.equal(clampText('abcdef', 3), 'abc');
  assert.equal(clampText('ab', 3), 'ab');
  assert.equal(clampText(null, 3), '');
});

test('域标识：agint_trajectory / schemaVersion 1（不变量 #1 独占）', () => {
  assert.equal(DOMAIN_NAME, 'agint_trajectory');
  assert.equal(SCHEMA_VERSION, 1);
});
