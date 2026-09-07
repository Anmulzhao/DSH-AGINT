// aggregator 单测：frontmatter 解析 / 技能扫描 / D3 数据源过滤 / 使用聚合。
// D3 回归测试是 Sprint14 §3.6 验收的星标项：curriculum 挑战调用不得刷新 lastUsedAt。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseFrontmatter, scanSkills, filterRecords, groupTaskCalls, aggregateUsage,
} from '../lib/aggregator.js';

function tmpSkillsDir(skills) {
  const dir = mkdtempSync(join(tmpdir(), 'curator-skills-'));
  for (const s of skills) {
    mkdirSync(join(dir, s.dirName), { recursive: true });
    writeFileSync(join(dir, s.dirName, 'SKILL.md'), s.content, 'utf8');
  }
  return dir;
}

const SKILL_FM = (name, tools) => `---
name: ${name}
description: "demo skill ${name}"
triggers: [alpha, beta]
tools: [${tools.join(', ')}]
---

# ${name}
`;

test('parseFrontmatter：标量 / 引号 / 内联数组 / 列表数组', () => {
  const fm = parseFrontmatter(`---
name: demo
description: "带引号的描述"
triggers: [a, b, c]
tools:
  - file_read
  - file_write
---

body`);
  assert.equal(fm.name, 'demo');
  assert.equal(fm.description, '带引号的描述');
  assert.deepEqual(fm.triggers, ['a', 'b', 'c']);
  assert.deepEqual(fm.tools, ['file_read', 'file_write']);
});

test('parseFrontmatter：无 frontmatter → 空对象（不抛）', () => {
  assert.deepEqual(parseFrontmatter('# 只有正文'), {});
  assert.deepEqual(parseFrontmatter(''), {});
  assert.deepEqual(parseFrontmatter(null), {});
});

test('scanSkills：目录扫描 + 跳过隐藏目录（.archive）+ 缺失 SKILL.md 跳过', async () => {
  const dir = tmpSkillsDir([
    { dirName: 'alpha', content: SKILL_FM('alpha', ['file_read', 'file_write']) },
    { dirName: 'beta', content: SKILL_FM('beta', ['terminal']) },
  ]);
  mkdirSync(join(dir, '.archive', 'old-skill'), { recursive: true });
  writeFileSync(join(dir, '.archive', 'old-skill', 'SKILL.md'), SKILL_FM('old-skill', []), 'utf8');
  mkdirSync(join(dir, 'broken'), { recursive: true }); // 无 SKILL.md
  try {
    const skills = await scanSkills(dir);
    assert.deepEqual(skills.map((s) => s.name), ['alpha', 'beta']);
    assert.deepEqual(skills[0].tools, ['file_read', 'file_write']);
    assert.ok(skills[0].createdAt); // birthtime/mtime 兜底
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scanSkills：目录不存在 → 空数组（不抛，冒烟友好）', async () => {
  const skills = await scanSkills(join(tmpdir(), 'curator-不存在-xyz'));
  assert.deepEqual(skills, []);
});

test('D3 回归：curriculum- 前缀 sessionId 整条丢弃（不刷新 lastUsedAt）', () => {
  const now = Date.parse('2026-09-07T00:00:00Z');
  const records = [
    { ts: now - 86400_000, sessionId: 's1', turn: 1, tool: 'file_read', ok: true, latencyMs: 10 },
    { ts: now - 3600_000, sessionId: 'curriculum-challenge-42', turn: 1, tool: 'file_read', ok: true, latencyMs: 10 },
    { ts: now - 3600_000, sessionId: 's2', turn: 1, tool: 'file_read', ok: true, latencyMs: 10, source: 'curriculum' },
    { ts: now - 10 * 86400_000, sessionId: 's3', turn: 1, tool: 'file_read', ok: true, latencyMs: 10 }, // 超窗
    { ts: now - 3600_000, sessionId: 's4', turn: 1, tool: 'file_read', ok: true }, // 无 ts 之外字段正常
  ];
  const kept = filterRecords(records, { lookbackDays: 7, nowMs: now });
  assert.equal(kept.length, 2);
  assert.deepEqual(kept.map((r) => r.sessionId), ['s1', 's4']);
});

test('groupTaskCalls：按 (sessionId, turn) 聚成任务', () => {
  const tasks = groupTaskCalls([
    { ts: 1, sessionId: 's1', turn: 1, tool: 'a', ok: true, latencyMs: 5 },
    { ts: 2, sessionId: 's1', turn: 1, tool: 'b', ok: false, latencyMs: 15 },
    { ts: 3, sessionId: 's1', turn: 2, tool: 'c', ok: true, latencyMs: 20 },
    { ts: 4, sessionId: 's2', turn: 1, tool: 'd', ok: true },
    { ts: 5, tool: 'orphan', ok: true }, // 无 sessionId/turn → 丢弃
  ]);
  assert.equal(tasks.length, 3);
  const first = tasks[0];
  assert.deepEqual(first.toolSequence, ['a', 'b']);
  assert.equal(first.okCount, 1);
  assert.equal(first.totalCount, 2);
  assert.equal(first.latencySumMs, 20);
});

test('aggregateUsage：工具覆盖率推断命中（≥0.6）', () => {
  const skills = [
    { name: 'alpha', tools: ['file_read', 'file_write'] },
    { name: 'beta', tools: ['terminal', 'bash', 'shell'] },
  ];
  const tasks = [
    { toolSequence: ['file_read', 'file_write'], startedAt: 1000, endedAt: 2000, okCount: 2, totalCount: 2, latencySumMs: 30, latencySampleCount: 2, skillTags: [] },
    { toolSequence: ['terminal'], startedAt: 3000, endedAt: 4000, okCount: 1, totalCount: 2, latencySumMs: 10, latencySampleCount: 1, skillTags: [] },
  ];
  const { usage, inference } = aggregateUsage(tasks, skills, { inferenceEnabled: true, minToolCoverage: 0.6 });
  assert.equal(inference, 'inferred');
  assert.equal(usage.alpha.useCount, 1); // 覆盖率 2/2 = 1.0
  assert.equal(usage.beta.useCount, 0);  // 覆盖率 1/3 = 0.33 < 0.6
  assert.equal(usage.alpha.avgTokenCost, null); // tool-stats 无 token 计量，恒 null
});

test('aggregateUsage：记录带 skill 字段时走准确路径（P0-1 上线后自动生效）', () => {
  const skills = [{ name: 'alpha', tools: [] }, { name: 'beta', tools: [] }];
  const tasks = [
    { toolSequence: ['x'], startedAt: 1, endedAt: 2, okCount: 1, totalCount: 1, latencySumMs: 0, latencySampleCount: 0, skillTags: ['alpha'] },
  ];
  const { usage, inference } = aggregateUsage(tasks, skills, { inferenceEnabled: true, minToolCoverage: 0.6 });
  assert.equal(inference, 'explicit');
  assert.equal(usage.alpha.useCount, 1);
  assert.equal(usage.beta.useCount, 0);
});

test('aggregateUsage：inference 关闭 → 无命中（但技能条目仍在）', () => {
  const skills = [{ name: 'alpha', tools: ['file_read'] }];
  const tasks = [{ toolSequence: ['file_read'], startedAt: 1, endedAt: 2, okCount: 1, totalCount: 1, latencySumMs: 0, latencySampleCount: 0, skillTags: [] }];
  const { usage, inference } = aggregateUsage(tasks, skills, { inferenceEnabled: false });
  assert.equal(inference, 'disabled');
  assert.equal(usage.alpha.useCount, 0);
  assert.equal(usage.alpha.lastUsedAt, null);
});

test('aggregateUsage：lastUsedAt 取最后一次命中，firstUsedAt 取第一次', () => {
  const skills = [{ name: 'alpha', tools: ['file_read'] }];
  const base = Date.parse('2026-09-01T00:00:00Z');
  const tasks = [
    { toolSequence: ['file_read'], startedAt: base, endedAt: base, okCount: 1, totalCount: 1, latencySumMs: 0, latencySampleCount: 0, skillTags: [] },
    { toolSequence: ['file_read'], startedAt: base + 3 * 86400_000, endedAt: base + 3 * 86400_000, okCount: 1, totalCount: 1, latencySumMs: 0, latencySampleCount: 0, skillTags: [] },
  ];
  const { usage } = aggregateUsage(tasks, skills, { inferenceEnabled: true, minToolCoverage: 0.6 });
  assert.equal(usage.alpha.useCount, 2);
  assert.equal(usage.alpha.firstUsedAt, new Date(base).toISOString());
  assert.equal(usage.alpha.lastUsedAt, new Date(base + 3 * 86400_000).toISOString());
});
