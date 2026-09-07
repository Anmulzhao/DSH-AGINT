// state-engine 单测：转换规则 + 四类保护**逐条**覆盖（Sprint14 §3.6 验收）。
// 纯函数，无 I/O、无时间依赖（nowMs 显式注入）。

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateSkill, evaluateAll, daysSinceUseOf } from '../lib/state-engine.js';
import * as plugin from '../lib/index.js';

const CFG = plugin.ConfigSchema.parse({});
const NOW = Date.parse('2026-09-07T00:00:00Z');
const DAY = 86_400_000;
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();

function skill(over = {}) {
  return {
    skillName: 'demo',
    state: 'active',
    source: 'manual',
    protected: false,
    cronReferenced: false,
    createdAt: daysAgo(400),
    usage: { useCount: 5, lastUsedAt: daysAgo(1) },
    ...over,
  };
}

// ── 转换规则 ─────────────────────────────────────────────────────────────

test('active + 30 天未用 → stale', () => {
  const d = evaluateSkill({ skill: skill({ usage: { useCount: 1, lastUsedAt: daysAgo(45) } }), config: CFG, nowMs: NOW });
  assert.equal(d.action, 'stale');
  assert.equal(d.to, 'stale');
  assert.match(d.reason, /45 天未使用/);
});

test('active + 未达 30 天 → keep', () => {
  const d = evaluateSkill({ skill: skill({ usage: { useCount: 1, lastUsedAt: daysAgo(10) } }), config: CFG, nowMs: NOW });
  assert.equal(d.action, 'keep');
  assert.match(d.reason, /未达阈值/);
});

test('active + 超过 90 天也只走一步（active→stale，安全 > 效率）', () => {
  const d = evaluateSkill({ skill: skill({ usage: { useCount: 1, lastUsedAt: daysAgo(200) } }), config: CFG, nowMs: NOW });
  assert.equal(d.from, 'active');
  assert.equal(d.to, 'stale');
});

test('stale + 90 天未用 → archive', () => {
  const d = evaluateSkill({
    skill: skill({ state: 'stale', usage: { useCount: 1, lastUsedAt: daysAgo(120) } }), config: CFG, nowMs: NOW,
  });
  assert.equal(d.action, 'archive');
  assert.equal(d.to, 'archived');
  assert.match(d.reason, /120 天未使用/);
});

test('stale + 最近 7 天有使用 → reactivate', () => {
  const d = evaluateSkill({
    skill: skill({ state: 'stale', usage: { useCount: 1, lastUsedAt: daysAgo(3) } }), config: CFG, nowMs: NOW,
  });
  assert.equal(d.action, 'reactivate');
  assert.equal(d.to, 'active');
});

test('archived 不自动恢复（防 archive/unarchive 抖动）', () => {
  const d = evaluateSkill({
    skill: skill({ state: 'archived', usage: { useCount: 1, lastUsedAt: daysAgo(1) } }), config: CFG, nowMs: NOW,
  });
  assert.equal(d.action, 'keep');
  assert.match(d.reason, /需人工 unarchive/);
});

// ── 保护 1：pinned ───────────────────────────────────────────────────────

test('保护1 pinned：200 天未用也不转换', () => {
  const d = evaluateSkill({
    skill: skill({ state: 'pinned', usage: { useCount: 0, lastUsedAt: daysAgo(200) } }), config: CFG, nowMs: NOW,
  });
  assert.equal(d.action, 'keep');
  assert.match(d.reason, /pinned/);
});

// ── 保护 2：protected ────────────────────────────────────────────────────

test('保护2 protected：受保护技能不参与自动转换', () => {
  const d = evaluateSkill({
    skill: skill({ protected: true, usage: { useCount: 0, lastUsedAt: daysAgo(200) } }), config: CFG, nowMs: NOW,
  });
  assert.equal(d.action, 'keep');
  assert.match(d.reason, /protected/);
});

test('保护2 附带：source=bundled 等非本地管理技能不碰（P0-2 §1.3）', () => {
  for (const src of ['bundled', 'hub', 'external']) {
    const d = evaluateSkill({
      skill: skill({ source: src, usage: { useCount: 0, lastUsedAt: daysAgo(200) } }), config: CFG, nowMs: NOW,
    });
    assert.equal(d.action, 'keep', src);
    assert.match(d.reason, new RegExp(src));
  }
});

// ── 保护 3：cron-referenced ──────────────────────────────────────────────

test('保护3 cron-referenced：可 stale，但不自动 archive', () => {
  const staleOk = evaluateSkill({
    skill: skill({ cronReferenced: true, usage: { useCount: 1, lastUsedAt: daysAgo(45) } }), config: CFG, nowMs: NOW,
  });
  assert.equal(staleOk.action, 'stale');

  const noArchive = evaluateSkill({
    skill: skill({ state: 'stale', cronReferenced: true, usage: { useCount: 1, lastUsedAt: daysAgo(120) } }), config: CFG, nowMs: NOW,
  });
  assert.equal(noArchive.action, 'keep');
  assert.match(noArchive.reason, /cron-referenced/);
});

// ── 保护 4：新技能保护期 ─────────────────────────────────────────────────

test('保护4 新技能保护期：创建 5 天 + 从未使用 → 不转 stale', () => {
  const s = skill({ createdAt: daysAgo(5), usage: { useCount: 0, lastUsedAt: null } });
  const d = evaluateSkill({ skill: s, config: CFG, nowMs: NOW });
  assert.equal(d.action, 'keep');
  assert.match(d.reason, /新技能保护期/);
});

test('保护4 边界：创建 13.9 天仍受保护，14.1 天不再受保护', () => {
  const inWindow = evaluateSkill({
    skill: skill({ createdAt: new Date(NOW - 13.9 * DAY).toISOString(), usage: { useCount: 0, lastUsedAt: null } }),
    config: CFG, nowMs: NOW,
  });
  assert.equal(inWindow.action, 'keep');
  assert.match(inWindow.reason, /新技能保护期/);

  const outWindow = evaluateSkill({
    skill: skill({ createdAt: new Date(NOW - 14.1 * DAY).toISOString(), usage: { useCount: 0, lastUsedAt: null } }),
    config: CFG, nowMs: NOW,
  });
  // 从未使用的技能以 createdAt 为基准 → 14.1 天 < 30 天阈值，仍是 keep，但理由不同
  assert.equal(outWindow.action, 'keep');
  assert.match(outWindow.reason, /未达阈值/);
});

test('保护4 不适用：用过但很久没用的技能（useCount>0）', () => {
  const d = evaluateSkill({
    skill: skill({ createdAt: daysAgo(20), usage: { useCount: 3, lastUsedAt: daysAgo(45) } }), config: CFG, nowMs: NOW,
  });
  assert.equal(d.action, 'stale');
});

// ── 未使用基准 ───────────────────────────────────────────────────────────

test('无使用数据时以 createdAt 为基准（从未使用的技能照样会被判定陈旧）', () => {
  const s = skill({ createdAt: daysAgo(100), usage: { useCount: 0, lastUsedAt: null } });
  const { days, basis } = daysSinceUseOf(s, NOW);
  assert.equal(basis, 'createdAt');
  assert.equal(Math.floor(days), 100);

  const d = evaluateSkill({ skill: { ...s, state: 'stale' }, config: CFG, nowMs: NOW });
  assert.equal(d.action, 'archive');
});

// ── 批量 ─────────────────────────────────────────────────────────────────

test('evaluateAll：归档候选按最久未用优先（预算受限时先处理最陈旧的）', () => {
  const skills = [
    skill({ skillName: 'a', state: 'stale', usage: { useCount: 1, lastUsedAt: daysAgo(100) } }),
    skill({ skillName: 'b', state: 'stale', usage: { useCount: 1, lastUsedAt: daysAgo(300) } }),
    skill({ skillName: 'c', state: 'active', usage: { useCount: 1, lastUsedAt: daysAgo(40) } }),
  ];
  const r = evaluateAll(skills, { config: CFG, nowMs: NOW });
  assert.deepEqual(r.toArchive.map((x) => x.skillName), ['b', 'a']);
  assert.deepEqual(r.toStale.map((x) => x.skillName), ['c']);
  assert.equal(r.decisions.length, 3);
});
