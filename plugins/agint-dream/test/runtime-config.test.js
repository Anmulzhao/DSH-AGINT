/**
 * agint-dream: 运行时配置子集（K51 kill-switch）一致性测试。
 *
 * 守护两件事：
 *   1. RUNTIME_CONFIG_KEYS 里的每个键都必须真实存在于 Config schema
 *      （否则 config({ key: v }) 会静默无效 —— 老板以为关掉了其实没关，
 *       这正是 kill-switch 最危险的失败模式）。
 *   2. Config schema 里分级去重的三个键默认值必须与 DEFAULTS 一致
 *      （否则 patch.yml 不写该键时，运行时看到的值和 sweep 实际用的值不一致）。
 *
 * Run: node --test plugins/agint-dream/test/runtime-config.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Config, RUNTIME_CONFIG_KEYS, name } from '../lib/index.js';
import { DEFAULTS } from '../lib/sweep.js';

test('RUNTIME_CONFIG_KEYS: 每个键都在 Config schema 里真实存在（防静默失效）', () => {
  const shape = Config.shape ?? Config._def?.shape;
  assert.ok(shape, 'Config 必须是 zod object');
  const known = new Set(Object.keys(shape));
  for (const k of RUNTIME_CONFIG_KEYS) {
    assert.ok(known.has(k), `RUNTIME_CONFIG_KEYS 里的 "${k}" 不在 Config schema 中 → config() 会静默无效`);
  }
});

test('RUNTIME_CONFIG_KEYS: 不含敏感/结构性键（root、sessionsRoot 不可运行时改）', () => {
  for (const forbidden of ['root', 'sessionsRoot', 'lookbackDays', 'deepRecoveryDays']) {
    assert.ok(!RUNTIME_CONFIG_KEYS.includes(forbidden), `"${forbidden}" 不应可运行时改`);
  }
});

test('Config 默认值：分级去重三键与 DEFAULTS 对齐，且出厂即开（K51）', () => {
  const parsed = Config.parse({ root: '/tmp/dreams-test' });
  assert.equal(parsed.dedupeTieredEnabled, DEFAULTS.dedupeTieredEnabled);
  assert.equal(parsed.dedupeHigh, DEFAULTS.dedupeHigh);
  assert.equal(parsed.dedupeMid, DEFAULTS.dedupeMid);
  // 出厂即开 —— 不是「默认关、等老板批」
  assert.equal(parsed.dedupeTieredEnabled, true);
  assert.equal(parsed.dedupeHigh, 0.85);
  assert.equal(parsed.dedupeMid, 0.6);
});

test('DEFAULTS 自洽：dedupeMid 必须等于 dedupeTokenOverlap（兼容承诺）', () => {
  // gateCandidates 里 dedupeMid 的默认值跟 dedupeTokenOverlap 走；若两者不等，
  // 只改 dedupeTokenOverlap 的部署会得到意外档位。
  assert.equal(DEFAULTS.dedupeMid, DEFAULTS.dedupeTokenOverlap,
    'dedupeMid 默认必须与 dedupeTokenOverlap 相等（否则旧配置静默失配）');
  assert.ok(DEFAULTS.dedupeHigh > DEFAULTS.dedupeMid, '高档阈值必须严格大于中档');
});

test('配置模块导出面完整', () => {
  assert.equal(name, 'agint-dream');
  assert.ok(Array.isArray(RUNTIME_CONFIG_KEYS));
  assert.ok(RUNTIME_CONFIG_KEYS.length > 0);
});
