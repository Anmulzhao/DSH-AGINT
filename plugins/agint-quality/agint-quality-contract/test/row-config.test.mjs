/**
 * test/row-config.test.mjs — contract 读 patch 行 config（2026-11-18 根因修）
 *
 * 取证：apply(ctx) 此前硬编码 QualityConfigSchema.parse({})，行 config 被无视；
 * setConfig 只改内存，重启即回默认 ⇒ abtest.enabled 无持久化通道。
 * 修法：apply(ctx, config) 读行 config（QualityConfigSchema 校验，strict 拒未知键）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

function makeMockCtx() {
  const ctx = {
    _provides: new Map(),
    logger: { warn: () => {}, error: () => {} },
    effect(fn) { fn(); },
    provide(k, v) { this._provides.set(k, v); },
    get(k) { return this._provides.get(k) ?? null; },
    on() {},
  };
  return ctx;
}

test('行 config 带 abtest.enabled=true → getConfig 持久生效', () => {
  const ctx = makeMockCtx();
  apply(ctx, { abtest: { enabled: true, weight: 0.10, minSamples: 10, pValueThreshold: 0.05 } });
  const cfg = ctx.get('agint.quality').getConfig();
  assert.equal(cfg.abtest.enabled, true);
  assert.equal(cfg.abtest.weight, 0.10);
});

test('行 config 缺省 → abtest.enabled=false（向后兼容）', () => {
  const ctx = makeMockCtx();
  apply(ctx, {});
  assert.equal(ctx.get('agint.quality').getConfig().abtest.enabled, false);
});

test('行 config 未知键 → strict 拒绝（不静默吞）', () => {
  const ctx = makeMockCtx();
  assert.throws(() => apply(ctx, { notAField: 1 }));
});

test('setConfig 运行时调整仍生效（行 config 为初值）', async () => {
  const ctx = makeMockCtx();
  apply(ctx, { abtest: { enabled: true, weight: 0.10, minSamples: 10, pValueThreshold: 0.05 } });
  const q = ctx.get('agint.quality');
  await q.setConfig({ abtest: { enabled: false, weight: 0.10, minSamples: 10, pValueThreshold: 0.05 } });
  assert.equal(q.getConfig().abtest.enabled, false);
});