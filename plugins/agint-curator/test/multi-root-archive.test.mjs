// 多根归档路径单测（2026-10-21）。
//
// 根因回归：skills_dir 改成目录列表后，executor 仍 `join(cfg.skills_dir, ...)`，
// 数组进 path.join 抛 ERR_INVALID_ARG_TYPE —— 归档静默失效（fail-safe：目录不动、
// 状态不落、只留一条 archive_failed 审计）。本文件覆盖：
//
//   T0 数组配置不再抛错（直接回归本次根因）
//   T1 多根归档：技能归到「它自己那个根」的 .archive/，另一个根不受影响
//   T2 恢复：unarchive 后目录回到原根原位
//   T3 目录名 ≠ frontmatter name → 按 dirName 定位物理路径
//   T4 单根回归：skills_dir 仍是字符串时行为不变
//   T5 存量记录兼容：记录无 rootDir → 回退第一根；物理在别的根时不误动
//
// 不挂 Cordis、不碰真实 ~/.dsh。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { createExecutor } from '../lib/executor.js';
import { packSkillState } from '../lib/storage.js';
import * as plugin from '../lib/index.js';
import { fakeDomain, makeSkillsDir, cleanup } from './_helpers.mjs';

const CFG = plugin.ConfigSchema.parse({});

function setup({ config = {} } = {}) {
  const domain = fakeDomain();
  const tables = new Map();
  const getTable = async (n) => {
    if (!tables.has(n)) tables.set(n, domain.table(n));
    return tables.get(n);
  };
  const audits = [];
  const events = [];
  const cfg = { ...CFG, ...config };
  const executor = createExecutor({
    getTable,
    audit: async (e) => { audits.push(e); return e; },
    publishEvent: async (t, p) => { events.push({ topic: t, payload: p }); return true; },
    effectiveConfig: () => cfg,
  });
  return { executor, getTable, audits, events };
}

async function seed(getTable, records) {
  const t = await getTable('skill_states');
  for (const r of records) await t.put(r.id, r);
}

function stateOf(extra = {}) {
  return packSkillState({
    skillName: 'x',
    state: 'stale',
    stateChangedAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    usage: { useCount: 1, lastUsedAt: '2026-01-01T00:00:00Z' },
    category: 'general',
    description: '',
    sourcePlugin: null,
    archivedAt: null,
    archiveReason: null,
    curationNotes: '',
    ...extra,
  });
}

// ── T0 根因回归 ──────────────────────────────────────────────────────────

test('T0 根因回归：skills_dir 是数组时归档不再抛 ERR_INVALID_ARG_TYPE', async () => {
  const root1 = makeSkillsDir([{ name: 'a' }]);
  const root2 = makeSkillsDir([{ name: 'b' }]);
  try {
    const { executor, getTable, audits } = setup({ config: { skills_dir: [root1, root2] } });
    await seed(getTable, [stateOf({ skillName: 'b', rootDir: root2, dirName: 'b' })]);
    const r = await executor.archive({ skillName: 'b', reason: 't0' });
    assert.equal(r.result, 'success', r.reason);
    assert.equal(audits.some((a) => a.action === 'archive_failed'), false, '不应有 archive_failed 审计');
    assert.equal(existsSync(join(root2, '.archive', 'b')), true);
  } finally {
    cleanup(root1, root2);
  }
});

// ── T1 多根归档：各归各根 ────────────────────────────────────────────────

test('T1 多根归档：技能归到它自己那个根的 .archive/，另一个根不受影响', async () => {
  const root1 = makeSkillsDir([{ name: 'in-root1' }]);
  const root2 = makeSkillsDir([{ name: 'in-root2' }]);
  try {
    const { executor, getTable } = setup({ config: { skills_dir: [root1, root2] } });
    await seed(getTable, [
      stateOf({ skillName: 'in-root1', rootDir: root1, dirName: 'in-root1' }),
      stateOf({ skillName: 'in-root2', rootDir: root2, dirName: 'in-root2' }),
    ]);
    const r = await executor.archive({ skillName: 'in-root2', reason: 't1' });
    assert.equal(r.result, 'success', r.reason);
    // 根 2 的技能被移走，归档在根 2 自己的 .archive/ 下（不跨根搬）
    assert.equal(existsSync(join(root2, 'in-root2')), false);
    assert.equal(existsSync(join(root2, '.archive', 'in-root2')), true);
    assert.equal(existsSync(join(root1, '.archive')), false, '根 1 不该出现 .archive');
    // 根 1 的技能目录仍在原位（下方 existsSync 断言为证）
    assert.equal(existsSync(join(root1, 'in-root1')), true);
    assert.equal(existsSync(join(root1, '.archive', 'in-root1')), false);
  } finally {
    cleanup(root1, root2);
  }
});

// ── T2 恢复 ──────────────────────────────────────────────────────────────

test('T2 恢复：unarchive 后目录回到原根原位', async () => {
  const root1 = makeSkillsDir([{ name: 'x' }]);
  const root2 = makeSkillsDir([{ name: 'y' }]);
  try {
    const { executor, getTable, events } = setup({ config: { skills_dir: [root1, root2] } });
    await seed(getTable, [stateOf({ skillName: 'y', rootDir: root2, dirName: 'y' })]);
    await executor.archive({ skillName: 'y', reason: 't2' });
    assert.equal(existsSync(join(root2, '.archive', 'y')), true);

    const r = await executor.unarchive({ skillName: 'y', reason: 'still needed', actor: 'human' });
    assert.equal(r.result, 'success', r.reason);
    assert.equal(r.skill.state, 'active');
    assert.equal(r.skill.archivedAt, null);
    // 回到它原来那个根，不是第一根
    assert.equal(existsSync(join(root2, 'y')), true);
    assert.equal(existsSync(join(root1, 'y')), false);
    assert.ok(events.some((e) => e.topic === 'curator.skill-reactivated'));
  } finally {
    cleanup(root1, root2);
  }
});

// ── T3 目录名 ≠ frontmatter name ─────────────────────────────────────────

test('T3 目录名 ≠ frontmatter name：按 dirName 定位物理路径', async () => {
  const root = makeSkillsDir([{ name: 'front-name', dirName: 'physical-dir' }]);
  try {
    const { executor, getTable } = setup({ config: { skills_dir: [root] } });
    await seed(getTable, [stateOf({ skillName: 'front-name', rootDir: root, dirName: 'physical-dir' })]);
    const r = await executor.archive({ skillName: 'front-name', reason: 't3' });
    assert.equal(r.result, 'success', r.reason);
    assert.equal(existsSync(join(root, 'physical-dir')), false, '物理目录应被移走');
    assert.equal(existsSync(join(root, '.archive', 'physical-dir')), true);
  } finally {
    cleanup(root);
  }
});

// ── T4 单根回归 ──────────────────────────────────────────────────────────

test('T4 单根回归：skills_dir 仍是字符串时行为不变', async () => {
  const root = makeSkillsDir([{ name: 'x' }]);
  try {
    const { executor, getTable } = setup({ config: { skills_dir: root } });
    await seed(getTable, [stateOf({ skillName: 'x', rootDir: root, dirName: 'x' })]);
    const r = await executor.archive({ skillName: 'x', reason: 't4' });
    assert.equal(r.result, 'success', r.reason);
    assert.equal(existsSync(join(root, 'x')), false);
    assert.equal(existsSync(join(root, '.archive', 'x')), true);
  } finally {
    cleanup(root);
  }
});

// ── T5 存量记录兼容 ──────────────────────────────────────────────────────

test('T5 存量记录兼容：记录不带 rootDir 时在所有根里找目录；找不到则只改账不移动', async () => {
  const root1 = makeSkillsDir([{ name: 'legacy' }]);
  const root2 = makeSkillsDir([{ name: 'legacy' }]);
  try {
    // 记录不带 rootDir 字段（stateOf 未传该字段，见本文件上方定义）→ 在根里逐个找
    const { executor, getTable } = setup({ config: { skills_dir: [root1, root2] } });
    await seed(getTable, [stateOf({ skillName: 'legacy' })]);
    const r = await executor.archive({ skillName: 'legacy', reason: 't5' });
    assert.equal(r.result, 'success', r.reason);
    assert.equal(existsSync(join(root1, '.archive', 'legacy')), true, '应归到第一个找到的根');
    assert.equal(existsSync(join(root2, 'legacy')), true, '另一个根的同名目录不应被动');
  } finally {
    cleanup(root1, root2);
  }

  // 记录不带 rootDir、所有根里都找不到该目录 → 只改账不移动（movedTo=null）
  const root3 = makeSkillsDir([{ name: 'other-skill' }]);
  const root4 = makeSkillsDir([{ name: 'other-skill-2' }]);
  try {
    const s2 = setup({ config: { skills_dir: [root3, root4] } });
    await seed(s2.getTable, [stateOf({ skillName: 'nowhere-skill' })]);
    const r2 = await s2.executor.archive({ skillName: 'nowhere-skill', reason: 't5b' });
    assert.equal(r2.result, 'success', r2.reason);
    assert.equal(r2.movedTo, null, '目录找不到时不应声称移动过');
    assert.equal(existsSync(join(root3, 'other-skill')), true, '不应动第一根');
    assert.equal(existsSync(join(root4, 'other-skill-2')), true, '不应动第二根');
  } finally {
    cleanup(root3, root4);
  }
});
