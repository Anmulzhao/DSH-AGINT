// Sprint 15 P0-2 阶段 2 端到端集成：重叠检测 + 质量评估 + 质量加速 + 报告增强。
// 验收标准（P0-2 §12.2）：重叠对识别 / 质量下降标记 / 质量加速生效 / 报告含
// 重叠+质量章节 / 跨域读 evolution 评估历史（HARM 缺失降级不阻断）。

import test from 'node:test';
import assert from 'node:assert/strict';

import * as plugin from '../lib/index.js';
import { mockCtx, makeSkillsDir, makeStatsJsonl, cleanup } from './_helpers.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-08T00:00:00Z');
const at = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

/** 建环境：三技能（两个重叠 + 一个无关）+ 质量下降技能 + tool-stats */
function makeEnv({ config = {}, services = {}, decliningUsedDaysAgo = 2 } = {}) {
  const skillsDir = makeSkillsDir([
    // report 声明 3 工具（含 report-gen），summary 声明 4 工具（含 2 个未用）：
    // 覆盖率推断下 s1/s2 任务只命中 report（summary 覆盖率 2/4=0.5 < 0.6），
    // useCount 可区分；tools 维 Jaccard=2/5=0.4 <0.7 → 描述+触发 2 维达标判重叠。
    { name: 'weekly-report', description: '生成每周工作报告并归档到云盘', triggers: ['周报', '周总结'], tools: ['write', 'archive', 'report-gen'] },
    { name: 'weekly-summary', description: '生成每周工作报告并归档到云盘', triggers: ['周报', '周总结'], tools: ['write', 'archive', 'unused-a', 'unused-b'] },
    { name: 'poetry', description: '写诗', triggers: ['诗'], tools: ['write'] },
    { name: 'declining-skill', description: '质量下降示例技能', triggers: ['下降'], tools: ['read'] },
  ]);
  // 注意：ts 必须为 number（filterRecords 对非 number 静默丢弃）
  const records = [
    { ts: NOW - 3 * DAY, sessionId: 's1', turn: 1, tool: 'write', ok: true, latencyMs: 10 },
    { ts: NOW - 3 * DAY, sessionId: 's1', turn: 1, tool: 'archive', ok: true, latencyMs: 10 },
    { ts: NOW - 3 * DAY, sessionId: 's1', turn: 1, tool: 'report-gen', ok: true, latencyMs: 10 },
    { ts: NOW - 60 * DAY, sessionId: 's2', turn: 1, tool: 'write', ok: true, latencyMs: 10 },
    { ts: NOW - 60 * DAY, sessionId: 's2', turn: 1, tool: 'archive', ok: false, latencyMs: 10 },
    { ts: NOW - 1 * DAY, sessionId: 's3', turn: 1, tool: 'write', ok: true, latencyMs: 5 },
    // declining-skill：默认 2 天前用过；陈旧路径测试用 decliningUsedDaysAgo=70
    { ts: NOW - decliningUsedDaysAgo * DAY, sessionId: 's4', turn: 1, tool: 'read', ok: true, latencyMs: 5 },
  ];
  const jsonlPath = makeStatsJsonl(records);
  const events = [];
  const ctx = mockCtx({ 'agint.eventBus.publish': async (e) => { events.push(e); }, ...services });
  plugin.apply(ctx, {
    skills_dir: skillsDir,
    jsonlPath,
    usage_lookback_days: 400,
    ...config,
  });
  return { ctx, events, skillsDir, jsonlPath, svc: ctx._provided['agint.curator'] };
}

test('端到端：重叠检测识别重叠对 + 落盘 + 事件 + 推荐动作', async () => {
  const env = makeEnv();
  try {
    const r = await env.svc.run({ nowMs: NOW, trigger: 'weekly_curation' });
    assert.equal(r.overlaps.length, 1);
    const o = r.overlaps[0];
    assert.ok((o.skillA === 'weekly-report' && o.skillB === 'weekly-summary') || (o.skillA === 'weekly-summary' && o.skillB === 'weekly-report'));
    assert.equal(o.dims.dimsMet, 2); // 描述+触发 2 维（工具维 Jaccard 0.4 < 0.7，诚实不达标）
    // 推荐保留使用率高的 weekly-report（覆盖率推断下 s1/s2 只命中 report）
    assert.equal(o.recommendation.keep, 'weekly-report');
    assert.equal(o.recommendation.archive, 'weekly-summary');

    // 落盘 overlap_candidates + 事件
    const list = await env.svc.listOverlaps({});
    assert.equal(list.length, 1);
    assert.ok(env.events.some((e) => e.topic === 'curator.overlap-detected'));
    assert.ok(env.events.some((e) => e.topic === 'curator.consolidate-proposed'));

    // 报告章节
    assert.equal(r.report.overlaps.length, 1);
    assert.equal(r.report.summary.overlapsDetected, 1);
  } finally {
    cleanup(env.skillsDir);
  }
});

test('端到端：成功率连续下降 → quality_declining + 报告 declining 章节 + 事件', async () => {
  const env = makeEnv();
  try {
    // 预置质量历史：declining-skill 近 4 周成功率 0.9→0.8→0.7（连续 2 周降>10%）
    await env.svc.run({ nowMs: NOW, trigger: 'weekly_curation' });
    const s = await env.svc.getSkill('declining-skill');
    s.quality.history = [
      { week: '2026-W33', successRate: 0.9, useCount: 5 },
      { week: '2026-W34', successRate: 0.8, useCount: 5 },
      { week: '2026-W35', successRate: 0.7, useCount: 5 },
    ];
    // 直接写回表（模拟历史积累；真实场景由每周 run 自然积累）
    const domain = env.ctx.storageDomain;
    const t = await domain.open().then((d) => d.table('skill_states'));
    for (const [k, v] of t.entries()) if (v.skillName === 'declining-skill') { await t.put(k, s); break; }

    const r = await env.svc.run({ nowMs: NOW + DAY, trigger: 'weekly_curation' });
    assert.equal(r.declining.length, 1);
    assert.equal(r.declining[0].skillName, 'declining-skill');
    assert.equal(r.report.summary.newlyDeclining, 1);
    assert.ok(r.report.declining.some((d) => d.skillName === 'declining-skill'));
    assert.ok(env.events.some((e) => e.topic === 'curator.quality-declining' && e.payload?.skillName === 'declining-skill'));

    // Service：listDeclining 可见
    const declining = await env.svc.listDeclining({});
    assert.ok(declining.some((x) => x.skillName === 'declining-skill'));
  } finally {
    cleanup(env.skillsDir);
  }
});

test('端到端：quality_declining + 陈旧 → 质量加速归档（60 天，非 90）', async () => {
  const env = makeEnv({ config: { stale_after_days: 30 }, decliningUsedDaysAgo: 70 });
  try {
    // 首轮：active + 70 天未用 → stale（30 天阈值）
    await env.svc.run({ nowMs: NOW, trigger: 'weekly_curation' });
    const s = await env.svc.getSkill('declining-skill');
    assert.equal(s.state, 'stale');
    // 注入质量历史（真实场景由每周 run 自然积累）
    s.quality.history = [
      { week: '2026-W33', successRate: 0.9, useCount: 2 },
      { week: '2026-W34', successRate: 0.8, useCount: 2 },
      { week: '2026-W35', successRate: 0.7, useCount: 2 },
    ];
    const domain = env.ctx.storageDomain;
    const t = await domain.open().then((d) => d.table('skill_states'));
    for (const [k, v] of t.entries()) if (v.skillName === 'declining-skill') { await t.put(k, s); break; }

    // 第二轮：stale(71d) + 质量下降 → quality_declining（合并观察）
    const r1 = await env.svc.run({ nowMs: NOW + DAY, trigger: 'weekly_curation' });
    assert.ok(r1.applied.declining.some((d) => d.skillName === 'declining-skill') || r1.declining.some((d) => d.skillName === 'declining-skill'));

    // 第三轮：quality_declining + 72 天 ≥ 质量加速 60 天 → 归档
    const r2 = await env.svc.run({ nowMs: NOW + 2 * DAY, trigger: 'weekly_curation' });
    assert.ok(r2.applied.archived.some((a) => a.skillName === 'declining-skill'), '质量下降且陈旧应被加速归档');
    const s2 = await env.svc.getSkill('declining-skill');
    assert.equal(s2.state, 'archived');
  } finally {
    cleanup(env.skillsDir);
  }
});

test('T7 跨域集成：读 evolution-log phase3-provisional（HARM 缺失降级不阻断）', async () => {
  const evoLog = [
    { id: 'e1', targetId: 'sc_001', targetKind: 'skill', decision: 'PENDING_REVIEW', scores: { composite: 71.4, rankingScore: 0.6 }, tags: ['phase3-provisional', 'candidate:sc_001'], timestamp: '2026-09-01T00:00:00Z' },
    { id: 'e2', targetId: 'sc_002', targetKind: 'skill', decision: 'PENDING_REVIEW', scores: { composite: 80, rankingScore: 0.8 }, tags: ['phase3-provisional', 'candidate:sc_002'], timestamp: '2026-09-02T00:00:00Z' },
    { id: 'e3', targetId: 'x', targetKind: 'skill', decision: 'AUTO_DEPLOY', scores: {}, tags: ['other'], timestamp: '2026-09-01T00:00:00Z' },
  ];
  let readCount = 0;
  const env = makeEnv({
    services: {
      'agint.evolution': { readLogRangeMerged: async () => { readCount++; return evoLog; } },
    },
  });
  try {
    const r = await env.svc.run({ nowMs: NOW, trigger: 'weekly_curation' });
    // evolution 被读了一次（T7 通道），运行不因 HARM 缺失阻断
    assert.equal(readCount, 1);
    assert.ok(r.report); // 报告正常生成
    // 无技能级 HARM 匹配 → declining 为空（本环境无质量下降历史）
    assert.ok(Array.isArray(r.declining));
  } finally {
    cleanup(env.skillsDir);
  }
});

test('T7 降级：evolution 未挂载（undefined）→ 运行照常，不抛错', async () => {
  const env = makeEnv(); // 无 'agint.evolution' service
  try {
    const r = await env.svc.run({ nowMs: NOW, trigger: 'weekly_curation' });
    assert.ok(r.report);
    assert.equal(r.skillsScanned, 4);
  } finally {
    cleanup(env.skillsDir);
  }
});

test('工具/报告：curator_get_report 取最新报告，含 Sprint 15 章节', async () => {
  const env = makeEnv();
  try {
    await env.svc.run({ nowMs: NOW, trigger: 'weekly_curation' });
    const rep = await env.svc.getReport();
    assert.ok(rep);
    assert.ok('overlaps' in rep);
    assert.ok('declining' in rep);
    assert.ok('newlyDeclining' in rep.summary);
    assert.ok('overlapsDetected' in rep.summary);
  } finally {
    cleanup(env.skillsDir);
  }
});

test('dry-run 与真实执行同路径：重叠/质量章节输出一致（除不落盘）', async () => {
  const env = makeEnv();
  try {
    const dry = await env.svc.dryRun({ nowMs: NOW });
    assert.equal(dry.overlaps.length, 1);
    assert.equal((await env.svc.listOverlaps({})).length, 0); // dry-run 不落盘

    const real = await env.svc.run({ nowMs: NOW });
    assert.deepEqual(dry.overlaps, real.overlaps);
    assert.deepEqual(dry.declining, real.declining);
    assert.deepEqual(dry.report.overlaps, real.report.overlaps);
    assert.equal((await env.svc.listOverlaps({})).length, 1); // 真实 run 写一条

    // 再 dry-run：仍不追加
    const dryAgain = await env.svc.dryRun({ nowMs: NOW + DAY });
    assert.equal(dryAgain.overlaps.length, 1);
    assert.equal((await env.svc.listOverlaps({})).length, 1);
  } finally {
    cleanup(env.skillsDir);
  }
});
