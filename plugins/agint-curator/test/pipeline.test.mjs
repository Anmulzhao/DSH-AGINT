// 端到端集成：mock ctx + 内存 domain + 临时 skills 目录 + 临时 tool-stats JSONL。
// 覆盖 Sprint14 §3.6 验收项：每周策展跑通 / 保护机制 / dry-run 一致性 /
// curriculum 调用不刷新 lastUsedAt（D3 星标回归）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import * as plugin from '../lib/index.js';
import { mockCtx, makeSkillsDir, makeStatsJsonl, cleanup } from './_helpers.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-07T00:00:00Z');
const at = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

/** 建环境：两个技能 + 一段 tool-stats */
function makeEnv({ extraRecords = [], config = {} } = {}) {
  const skillsDir = makeSkillsDir([
    { name: 'alpha', tools: ['file_read', 'file_write'] },   // 常用
    { name: 'beta', tools: ['terminal', 'bash'] },           // 陈旧
  ]);
  const records = [
    // alpha：1 天前用过
    { ts: NOW - 1 * DAY, sessionId: 's1', turn: 1, tool: 'file_read', ok: true, latencyMs: 10 },
    { ts: NOW - 1 * DAY, sessionId: 's1', turn: 1, tool: 'file_write', ok: true, latencyMs: 10 },
    // beta：200 天前用过
    { ts: NOW - 200 * DAY, sessionId: 's2', turn: 1, tool: 'terminal', ok: true, latencyMs: 20 },
    { ts: NOW - 200 * DAY, sessionId: 's2', turn: 1, tool: 'bash', ok: false, latencyMs: 30 },
    ...extraRecords,
  ];
  const jsonlPath = makeStatsJsonl(records);
  const events = [];
  const ctx = mockCtx({ 'agint.eventBus.publish': async (e) => { events.push(e); } });
  plugin.apply(ctx, {
    skills_dir: skillsDir,
    jsonlPath,
    usage_lookback_days: 400,
    move_directory_on_archive: true,
    ...config,
  });
  return { ctx, events, skillsDir, jsonlPath, svc: ctx._provided['agint.curator'] };
}

test('端到端：扫描 → 聚合 → active→stale→archived（一次只走一步）', async () => {
  const env = makeEnv();
  try {
    const first = await env.svc.run({ nowMs: NOW, trigger: 'weekly_curation' });
    assert.equal(first.skillsScanned, 2);
    assert.equal(first.inference, 'inferred');
    assert.deepEqual(first.applied.staled.map((x) => x.skillName), ['beta']);
    assert.equal(first.applied.archived.length, 0); // active 一次只走一步
    assert.equal((await env.svc.getSkill('beta')).state, 'stale');
    assert.equal((await env.svc.getSkill('alpha')).state, 'active');

    // 第二周：stale + 200 天未用 → archive（目录真的移走）
    const second = await env.svc.run({ nowMs: NOW, trigger: 'weekly_curation' });
    assert.deepEqual(second.applied.archived.map((x) => x.skillName), ['beta']);
    assert.equal(existsSync(join(env.skillsDir, 'beta')), false);
    assert.equal(existsSync(join(env.skillsDir, '.archive', 'beta')), true);
    assert.ok(env.events.some((e) => e.topic === 'curator.skill-archived'));
    assert.ok(env.events.some((e) => e.topic === 'curator.run-completed'));
  } finally {
    cleanup(env.skillsDir);
  }
});

test('D3 端到端回归：curriculum 挑战调用不刷新 lastUsedAt（陈旧技能照样归档）', async () => {
  // beta 在 2 天前有「挑战调用」，但 sessionId 带 curriculum- 前缀
  const env = makeEnv({
    extraRecords: [
      { ts: NOW - 2 * DAY, sessionId: 'curriculum-challenge-7', turn: 1, tool: 'terminal', ok: true, latencyMs: 5 },
      { ts: NOW - 2 * DAY, sessionId: 'curriculum-challenge-7', turn: 1, tool: 'bash', ok: true, latencyMs: 5 },
    ],
  });
  try {
    await env.svc.run({ nowMs: NOW });                 // active → stale
    const second = await env.svc.run({ nowMs: NOW });  // stale → archived
    assert.deepEqual(second.applied.archived.map((x) => x.skillName), ['beta']);
    const beta = await env.svc.getSkill('beta');
    assert.equal(beta.state, 'archived');
    // lastUsedAt 仍是 200 天前那次，没有被挑战调用刷新
    assert.equal(beta.usage.lastUsedAt, at(200));
  } finally {
    cleanup(env.skillsDir);
  }
});

test('保护机制端到端：protected 技能（记忆纪律）不参与任何自动转换（连 stale 都不标）', async () => {
  // 设计稿 P0-2 §9.1：protected 列表中的核心技能「不参与任何自动转换」；
  // 与之对照，cron-referenced 才是「可 stale 但不可 archive」。
  const skillsDir = makeSkillsDir([{ name: 'memory-discipline', tools: ['file_read'] }]);
  const jsonlPath = makeStatsJsonl([
    { ts: NOW - 300 * DAY, sessionId: 's1', turn: 1, tool: 'file_read', ok: true, latencyMs: 5 },
  ]);
  try {
    const ctx = mockCtx({});
    plugin.apply(ctx, { skills_dir: skillsDir, jsonlPath, usage_lookback_days: 400 });
    const svc = ctx._provided['agint.curator'];
    await svc.run({ nowMs: NOW });
    await svc.run({ nowMs: NOW });
    const s = await svc.getSkill('memory-discipline');
    assert.equal(s.protected, true);           // 命中 protected_skills 白名单
    assert.equal(s.state, 'active');           // 300 天未用也不标 stale
    assert.equal(existsSync(join(skillsDir, 'memory-discipline')), true); // 绝不归档
  } finally {
    cleanup(skillsDir);
  }
});

test('§9.4 自保护：名字含 curator 的技能自动 protected', async () => {
  const skillsDir = makeSkillsDir([{ name: 'skill-curator', tools: ['file_read'] }]);
  const jsonlPath = makeStatsJsonl([
    { ts: NOW - 300 * DAY, sessionId: 's1', turn: 1, tool: 'file_read', ok: true, latencyMs: 5 },
  ]);
  try {
    const ctx = mockCtx({});
    plugin.apply(ctx, { skills_dir: skillsDir, jsonlPath, usage_lookback_days: 400 });
    const svc = ctx._provided['agint.curator'];
    await svc.run({ nowMs: NOW });
    assert.equal((await svc.getSkill('skill-curator')).protected, true);
    await svc.run({ nowMs: NOW });
    assert.equal(existsSync(join(skillsDir, 'skill-curator')), true);
  } finally {
    cleanup(skillsDir);
  }
});

test('dry-run 与真实执行输出完全一致（除不落盘外）', async () => {
  const a = makeEnv();
  const b = makeEnv();
  try {
    const dry = await a.svc.dryRun({ nowMs: NOW });
    const real = await b.svc.run({ nowMs: NOW, dryRun: false });
    const strip = (r) => JSON.stringify({
      staled: r.applied.staled.map((x) => x.skillName),
      archived: r.applied.archived.map((x) => x.skillName),
      reactivated: r.applied.reactivated.map((x) => x.skillName),
      summary: r.report.summary,
      recommendations: r.report.recommendations,
    });
    assert.equal(strip(dry), strip(real));
    // 但 dry-run 不落盘：技能状态没变、目录没动
    assert.equal((await a.svc.getSkill('beta')).state, 'active');
    assert.equal(existsSync(join(a.skillsDir, 'beta')), true);
    assert.equal((await b.svc.getSkill('beta')).state, 'stale');
    // dry-run 报告默认不写 reports 表
    assert.equal(await a.svc.getReport(dry.week), null);
  } finally {
    cleanup(a.skillsDir, b.skillsDir);
  }
});

test('auto_curation_enabled=false：只检测不执行（等价于强制 dry-run）', async () => {
  const env = makeEnv({ config: { auto_curation_enabled: false } });
  try {
    const r = await env.svc.run({ nowMs: NOW, dryRun: false });
    assert.equal(r.dryRun, true);
    assert.equal((await env.svc.getSkill('beta')).state, 'active');
    assert.equal(r.report.summary.newlyStale, 1);
  } finally {
    cleanup(env.skillsDir);
  }
});

test('报告：写入 reports 表 + getReport 可取 + 内容含归档列表', async () => {
  const env = makeEnv();
  try {
    const r1 = await env.svc.run({ nowMs: NOW });
    const r2 = await env.svc.run({ nowMs: NOW });
    const rep = await env.svc.getReport(r2.week);
    assert.ok(rep);
    assert.equal(rep.summary.newlyArchived, 1);
    assert.deepEqual(rep.archived.map((x) => x.skillName), ['beta']);
    assert.ok(rep.recommendations.length >= 1);
  } finally {
    cleanup(env.skillsDir);
  }
});

test('pause/resume + 运行时 config 子集 + stats', async () => {
  const env = makeEnv();
  try {
    await env.svc.pause('human:boss');
    assert.equal((await env.svc.run({ nowMs: NOW })).skipped, true);
    assert.equal((await env.svc.run({ nowMs: NOW, force: true })).skipped, undefined);
    await env.svc.resume('human:boss');

    const cfg = env.svc.config({ weekly_archive_budget: 3, skills_dir: '/hack' });
    assert.equal(cfg.weekly_archive_budget, 3);
    assert.notEqual(cfg.skills_dir, '/hack'); // 子集外字段不改

    const stats = await env.svc.stats();
    assert.equal(stats.skills.total, 2);
    assert.ok(stats.limits.SKILL_STATES === 200);
  } finally {
    cleanup(env.skillsDir);
  }
});

test('Sprint 15：listOverlaps/listDeclining 已实现；Sprint 16 consolidate/prune 显式抛错，绝不静默', async () => {
  const env = makeEnv();
  try {
    // Sprint 15 已落地：空数据返回空数组，不抛错
    assert.deepEqual(await env.svc.listOverlaps({}), []);
    assert.deepEqual(await env.svc.listDeclining({}), []);
    // Sprint 16 仍显式抛错
    for (const fn of ['consolidate', 'prune']) {
      await assert.rejects(() => env.svc[fn]({}), /未实现/);
    }
  } finally {
    cleanup(env.skillsDir);
  }
});
