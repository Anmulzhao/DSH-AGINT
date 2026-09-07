// boundary-probe 单元测试（§4.3 [1] 纯函数）。

import test from 'node:test';
import assert from 'node:assert/strict';

import { probeDomains, coolingDomains } from '../lib/boundary-probe.js';
import { makeSnapshot, makeCapability } from './_helpers.mjs';

const NOW = Date.parse('2026-09-08T00:00:00Z');

test('UNCERTAIN 域必练（能力缺口）', () => {
  const snap = makeSnapshot([
    makeCapability('codegen', 'UNCERTAIN', { lastVerifiedAt: '2026-09-01T00:00:00Z' }),
  ]);
  const { domains } = probeDomains(snap, { staleReverifyDays: 30, nowMs: NOW });
  assert.equal(domains.length, 1);
  assert.equal(domains[0].domain, 'codegen');
  assert.ok(domains[0].reason.some((r) => r.includes('UNCERTAIN')));
});

test('CAN 超过 staleReverifyDays 未复验 → 待练；未超时不练', () => {
  const old = makeCapability('codegen', 'CAN', { lastVerifiedAt: '2026-01-01T00:00:00Z' });
  const fresh = makeCapability('planning', 'CAN', { lastVerifiedAt: '2026-09-07T00:00:00Z' });
  const { domains } = probeDomains(makeSnapshot([old, fresh]), { staleReverifyDays: 30, nowMs: NOW });
  const names = domains.map((d) => d.domain);
  assert.ok(names.includes('codegen'), '30 天前验证的 CAN 应复验');
  assert.ok(!names.includes('planning'), '昨天验证的 CAN 不应练');
});

test('miscalibrated 域必练（权重与 UNCERTAIN 同级）', () => {
  const snap = makeSnapshot(
    [
      makeCapability('codegen', 'CAN', { lastVerifiedAt: '2026-09-07T00:00:00Z' }),  // 近期 → 不触发
      makeCapability('planning', 'CAN', { lastVerifiedAt: '2026-09-07T00:00:00Z' }),
    ],
    { domains: 2, maxError: 0.2, miscalibrated: ['planning'] },
  );
  const { domains } = probeDomains(snap, { staleReverifyDays: 30, nowMs: NOW });
  assert.deepEqual(domains.map((d) => d.domain), ['planning']);
  assert.ok(domains[0].reason.some((r) => r.includes('miscalibrated')));
});

test('UNCERTAIN + miscalibrated 叠加权重最高（score 排最前）', () => {
  const snap = makeSnapshot(
    [
      makeCapability('codegen', 'UNCERTAIN', { lastVerifiedAt: '2026-08-01T00:00:00Z' }),   // 2 × 38天
      makeCapability('reasoning', 'UNCERTAIN', { lastVerifiedAt: '2026-08-01T00:00:00Z' }), // 2+2 × 38天
    ],
    { domains: 2, maxError: 0.2, miscalibrated: ['reasoning'] },
  );
  const { domains } = probeDomains(snap, { staleReverifyDays: 30, nowMs: NOW });
  assert.deepEqual(domains.map((d) => d.domain), ['reasoning', 'codegen']);
});

test('排序：缺口权重 × 久未验证（同权重时久未验证排前）', () => {
  const snap = makeSnapshot([
    makeCapability('codegen', 'UNCERTAIN', { lastVerifiedAt: '2026-08-01T00:00:00Z' }),
    makeCapability('reasoning', 'UNCERTAIN', { lastVerifiedAt: '2026-07-01T00:00:00Z' }),
    makeCapability('planning', 'CAN', { lastVerifiedAt: '2026-09-07T00:00:00Z' }), // 不触发
  ]);
  const { domains } = probeDomains(snap, { staleReverifyDays: 30, nowMs: NOW });
  assert.deepEqual(domains.map((d) => d.domain), ['reasoning', 'codegen']);
});

test('权重优先级：缺口(2) > CAN 复验(1)（同验证时间下）', () => {
  const snap = makeSnapshot(
    [
      makeCapability('codegen', 'UNCERTAIN', { lastVerifiedAt: '2026-08-01T00:00:00Z' }), // 2
      makeCapability('planning', 'CAN', { lastVerifiedAt: '2026-08-01T00:00:00Z' }),      // miscalibrated → 2
      makeCapability('tool-use', 'CAN', { lastVerifiedAt: '2026-08-01T00:00:00Z' }),      // 复验 → 1
    ],
    { domains: 3, maxError: 0.2, miscalibrated: ['planning'] },
  );
  const { domains } = probeDomains(snap, { staleReverifyDays: 30, nowMs: NOW });
  // 同 age：codegen(2) == planning(2) > tool-use(1)
  assert.deepEqual(domains.slice(0, 2).map((d) => d.domain).sort(), ['codegen', 'planning']);
  assert.equal(domains[2].domain, 'tool-use');
});

test('无模板域 → unverifiable（C1/Q5 诚实留白），不进待练列表', () => {
  const snap = makeSnapshot([
    makeCapability('custom-domain', 'UNCERTAIN', { lastVerifiedAt: '2026-08-01T00:00:00Z' }),
    makeCapability('codegen', 'UNCERTAIN', { lastVerifiedAt: '2026-08-01T00:00:00Z' }),
  ]);
  const { domains, unverifiable } = probeDomains(snap, { staleReverifyDays: 30, nowMs: NOW });
  assert.deepEqual(domains.map((d) => d.domain), ['codegen']);
  assert.deepEqual(unverifiable.map((d) => d.domain), ['custom-domain']);
  assert.ok(unverifiable[0].reason.some((r) => r.includes('无法自动判定')));
});

test('不在任何筛选条件的能力 → 不练', () => {
  const snap = makeSnapshot([
    makeCapability('codegen', 'CAN', { lastVerifiedAt: '2026-09-07T00:00:00Z' }),
  ]);
  const { domains, unverifiable } = probeDomains(snap, { staleReverifyDays: 30, nowMs: NOW });
  assert.equal(domains.length, 0);
  assert.equal(unverifiable.length, 0);
});

test('空 snapshot / 非法输入 → 空结果不抛', () => {
  const { domains, unverifiable } = probeDomains(null);
  assert.deepEqual(domains, []);
  assert.deepEqual(unverifiable, []);
  const { domains: d2 } = probeDomains(makeSnapshot([null, {}, { domain: 'x' }]), { nowMs: NOW });
  assert.deepEqual(d2, []);
});

test('coolingDomains：24h 内生成过的域返回冷却；超过不冷却', () => {
  const generated = [
    { domain: 'codegen', lastGeneratedAt: '2026-09-07T20:00:00Z' },   // 4h 前
    { domain: 'planning', lastGeneratedAt: '2026-09-01T00:00:00Z' },  // 7 天前
  ];
  const cooling = coolingDomains(generated, { cooldownHours: 24, nowMs: NOW });
  assert.deepEqual(cooling, ['codegen']);
});

test('coolingDomains：无 lastGeneratedAt 或空列表 → 不冷却', () => {
  assert.deepEqual(coolingDomains([], { cooldownHours: 24, nowMs: NOW }), []);
  assert.deepEqual(coolingDomains([{ domain: 'x', lastGeneratedAt: null }], { cooldownHours: 24, nowMs: NOW }), []);
});
