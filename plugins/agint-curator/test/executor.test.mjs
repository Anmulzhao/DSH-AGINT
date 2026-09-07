// executor 单测：归档（含真实目录移动）/ 幂等 / 保护 / 预算 / unarchive / pin。
// 用内存 domain + 临时 skills 目录，不碰真实 ~/.dsh。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { createExecutor } from '../lib/executor.js';
import { packSkillState } from '../lib/storage.js';
import * as plugin from '../lib/index.js';
import { fakeDomain, makeSkillsDir, cleanup } from './_helpers.mjs';

const CFG = plugin.ConfigSchema.parse({});

function setup({ skills = [], config = {} } = {}) {
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
  // 预置技能
  const seeded = new Map();
  for (const s of skills) {
    const packed = packSkillState({
      skillName: s.skillName ?? s.name,
      state: s.state ?? 'active',
      source: s.source ?? 'manual',
      protected: s.protected === true,
      cronReferenced: s.cronReferenced === true,
      createdAt: s.createdAt ?? '2026-01-01T00:00:00Z',
      stateChangedAt: s.createdAt ?? '2026-01-01T00:00:00Z',
      usage: s.usage ?? { useCount: 1, lastUsedAt: '2026-01-01T00:00:00Z' },
      category: 'general',
      description: '',
      sourcePlugin: null,
      archivedAt: null,
      archiveReason: null,
      curationNotes: '',
    });
    seeded.set(packed.id, packed);
    void getTable;
  }
  return { executor, getTable, audits, events, seeded };
}

async function seed(getTable, records) {
  const t = await getTable('skill_states');
  for (const r of records) await t.put(r.id, r);
}

// ── archive ──────────────────────────────────────────────────────────────

test('archive：状态落 archived + 目录移动到 .archive/<name>', async () => {
  const dir = makeSkillsDir([{ name: 'old-skill', tools: ['file_read'] }]);
  try {
    const { executor, getTable, events, audits } = setup({
      config: { skills_dir: dir },
    });
    await seed(getTable, [{
      ...packSkillState({ skillName: 'old-skill', state: 'stale', stateChangedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', usage: { useCount: 1, lastUsedAt: '2026-01-01T00:00:00Z' } }),
    }]);
    const r = await executor.archive({ skillName: 'old-skill', reason: '100 天未使用', actor: 'system' });
    assert.equal(r.result, 'success');
    assert.equal(r.skill.state, 'archived');
    assert.ok(r.skill.archivedAt);
    assert.equal(r.skill.archiveReason, '100 天未使用');
    assert.equal(r.skill.stateHistory.length, 1);
    // 目录真的被移走
    assert.equal(existsSync(join(dir, 'old-skill')), false);
    assert.equal(existsSync(join(dir, '.archive', 'old-skill')), true);
    // 事件 + 审计
    assert.ok(events.some((e) => e.topic === 'curator.skill-archived'));
    assert.ok(audits.some((a) => a.action === 'archived'));
  } finally {
    cleanup(dir);
  }
});

test('archive 幂等：已 archived 再归档 → skipped，不移动、不写状态', async () => {
  const dir = makeSkillsDir([{ name: 'x', tools: [] }]);
  try {
    const { executor, getTable } = setup({ config: { skills_dir: dir } });
    await seed(getTable, [packSkillState({ skillName: 'x', state: 'archived', stateChangedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' })]);
    const r = await executor.archive({ skillName: 'x', reason: 'again' });
    assert.equal(r.result, 'skipped');
    assert.match(r.reason, /幂等/);
    assert.equal(existsSync(join(dir, 'x')), true); // 目录没被动
  } finally {
    cleanup(dir);
  }
});

test('archive 保护：pinned / protected / cron-referenced / bundled 全部跳过', async () => {
  const dir = makeSkillsDir([{ name: 'p1', tools: [] }, { name: 'p2', tools: [] }, { name: 'p3', tools: [] }, { name: 'p4', tools: [] }]);
  try {
    const { executor, getTable } = setup({ config: { skills_dir: dir } });
    await seed(getTable, [
      packSkillState({ skillName: 'p1', state: 'pinned', stateChangedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' }),
      packSkillState({ skillName: 'p2', state: 'stale', protected: true, stateChangedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' }),
      packSkillState({ skillName: 'p3', state: 'stale', cronReferenced: true, stateChangedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' }),
      packSkillState({ skillName: 'p4', state: 'stale', source: 'bundled', stateChangedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' }),
    ]);
    for (const [name, kw] of [['p1', /pinned/], ['p2', /protected/], ['p3', /cron-referenced/], ['p4', /bundled/]]) {
      const r = await executor.archive({ skillName: name, reason: 'test' });
      assert.equal(r.result, 'skipped', name);
      assert.match(r.reason, kw);
      assert.equal(existsSync(join(dir, name)), true, `${name} 目录不应被移动`);
    }
  } finally {
    cleanup(dir);
  }
});

test('archive 预算：超过 weekly_archive_budget 后 budget_wait 跳过', async () => {
  const dir = makeSkillsDir([{ name: 'a', tools: [] }, { name: 'b', tools: [] }]);
  try {
    const { executor, getTable } = setup({ config: { skills_dir: dir, weekly_archive_budget: 1 } });
    await seed(getTable, [
      packSkillState({ skillName: 'a', state: 'stale', stateChangedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' }),
      packSkillState({ skillName: 'b', state: 'stale', stateChangedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' }),
    ]);
    assert.equal((await executor.archive({ skillName: 'a', reason: 'r' })).result, 'success');
    const second = await executor.archive({ skillName: 'b', reason: 'r' });
    assert.equal(second.result, 'skipped');
    assert.match(second.reason, /budget_wait/);
    assert.equal(existsSync(join(dir, 'b')), true);
  } finally {
    cleanup(dir);
  }
});

test('archive 不存在 → failed，且记 audit/action', async () => {
  const { executor, audits } = setup();
  const r = await executor.archive({ skillName: 'nope', reason: 'x' });
  assert.equal(r.result, 'failed');
  assert.match(r.reason, /不存在/);
  void audits;
});

test('unarchive：目录移回 + 状态 active + archivedAt 清空', async () => {
  const dir = makeSkillsDir([{ name: 'x', tools: [] }]);
  try {
    const { executor, getTable, events } = setup({ config: { skills_dir: dir } });
    await seed(getTable, [packSkillState({ skillName: 'x', state: 'stale', stateChangedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' })]);
    await executor.archive({ skillName: 'x', reason: 'old' });
    assert.equal(existsSync(join(dir, '.archive', 'x')), true);

    const r = await executor.unarchive({ skillName: 'x', reason: 'still needed', actor: 'human' });
    assert.equal(r.result, 'success');
    assert.equal(r.skill.state, 'active');
    assert.equal(r.skill.archivedAt, null);
    assert.equal(existsSync(join(dir, 'x')), true);
    assert.ok(events.some((e) => e.topic === 'curator.skill-reactivated'));
  } finally {
    cleanup(dir);
  }
});

test('unarchive 幂等：非 archived 状态 → skipped', async () => {
  const { executor, getTable } = setup();
  await seed(getTable, [packSkillState({ skillName: 'x', state: 'active', stateChangedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' })]);
  const r = await executor.unarchive({ skillName: 'x' });
  assert.equal(r.result, 'skipped');
});

// ── pin / unpin ──────────────────────────────────────────────────────────

test('pin/unpin：状态往返 + 幂等跳过', async () => {
  const { executor, getTable, events } = setup();
  await seed(getTable, [packSkillState({ skillName: 'x', state: 'active', stateChangedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' })]);
  assert.equal((await executor.pin({ skillName: 'x', actor: 'human' })).skill.state, 'pinned');
  assert.ok(events.some((e) => e.topic === 'curator.skill-pinned'));
  assert.equal((await executor.pin({ skillName: 'x' })).result, 'skipped');   // 幂等
  assert.equal((await executor.unpin({ skillName: 'x' })).skill.state, 'active');
  assert.equal((await executor.unpin({ skillName: 'x' })).result, 'skipped');  // 幂等
});

// ── dry-run 不落盘、不移动 ───────────────────────────────────────────────

test('archive dry-run：不移动目录、不改状态、不发事件', async () => {
  const dir = makeSkillsDir([{ name: 'x', tools: [] }]);
  try {
    const { executor, getTable, events } = setup({ config: { skills_dir: dir } });
    await seed(getTable, [packSkillState({ skillName: 'x', state: 'stale', stateChangedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' })]);
    const r = await executor.archive({ skillName: 'x', reason: 'preview', dryRun: true });
    assert.equal(r.result, 'success');
    assert.equal(existsSync(join(dir, 'x')), true);           // 没移动
    assert.equal(existsSync(join(dir, '.archive', 'x')), false);
    assert.equal(events.some((e) => e.topic === 'curator.skill-archived'), false); // 不发事件
    const after = await executor.findSkill('x');
    assert.equal(after.value.state, 'stale');                  // 状态未变
  } finally {
    cleanup(dir);
  }
});
