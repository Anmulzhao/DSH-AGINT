/**
 * 回归测试：sampleArgs 跨层透传（修复 K45.4 静默丢字段）。
 *
 * 根因：detector 组装 pattern 时未携带 sampleArgs，且 TaskPatternSchema 未声明该字段
 * → 落库经 zod .parse() 被 strip → templates.js 的「参数参考/触发器」两处读到的恒 {}（死代码）。
 * 证据：已发布技能 description 有参数键名、正文零具体值。
 *
 * 三层断言：
 *   1) detector.detectPatterns 把 task.sampleArgs 透传到 pattern（新建 + 命中刷新）
 *   2) TaskPatternSchema.parse 保留 sampleArgs；存量行无此字段 → 安全默认 {}
 *   3) templates.renderBody / extractTriggers 用 sampleArgs 渲染出具体值
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPatterns } from '../lib/detector.js';
import { TaskPatternSchema } from '../lib/schema.js';
import { renderBody, extractTriggers } from '../lib/templates.js';

const mkTask = (sampleArgs) => ({
  toolSequence: ['glob', 'grep'],
  paramSignature: { glob: 'pattern:s', grep: 'pattern:s' },
  sampleArgs,
  durationMs: 100,
  successRate: 1,
});

test('detector: sampleArgs 透传到新建 pattern', () => {
  const sampleArgs = { glob: { pattern: 'src/**/*.js' }, grep: { pattern: 'TODO' } };
  const { newRepeat } = detectPatterns(
    [mkTask(sampleArgs), mkTask(sampleArgs), mkTask(sampleArgs)],
    { minOccurrence: 3 },
  );
  assert.equal(newRepeat.length, 1);
  assert.deepEqual(newRepeat[0].sampleArgs, sampleArgs);
});

test('detector: 命中已有 pattern 时刷新为最新一次真实样本', () => {
  const first = { glob: { pattern: 'a/*.js' } };
  const fresh = { glob: { pattern: 'b/*.ts' } };
  const { upserts } = detectPatterns(
    [mkTask(first), mkTask(first), mkTask(first), mkTask(fresh), mkTask(fresh), mkTask(fresh)],
    { minOccurrence: 3 },
  );
  // 同一序列合并为 1 个 pattern，sampleArgs 应是最后出现的 fresh
  const merged = upserts.filter((p) => p.toolSequence.join() === 'glob,grep');
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sampleArgs, fresh);
});

test('schema: TaskPatternSchema 保留 sampleArgs', () => {
  const parsed = TaskPatternSchema.parse({
    toolSequence: ['glob'],
    paramSignature: {},
    description: 'glob',
    occurrenceCount: 1,
    firstSeenAt: 't',
    lastSeenAt: 't',
    successRate: 1,
    sampleArgs: { glob: { pattern: 'x' } },
  });
  assert.deepEqual(parsed.sampleArgs, { glob: { pattern: 'x' } });
});

test('schema: 存量 pattern 无 sampleArgs 字段 → 安全默认 {}（向后兼容）', () => {
  const parsed = TaskPatternSchema.parse({
    toolSequence: ['glob'],
    paramSignature: {},
    description: 'glob',
    occurrenceCount: 1,
    firstSeenAt: 't',
    lastSeenAt: 't',
    successRate: 1,
  });
  assert.deepEqual(parsed.sampleArgs, {});
});

test('templates: renderBody 用 sampleArgs 渲染真实参数值', () => {
  const pattern = {
    toolSequence: ['glob'],
    sampleArgs: { glob: { pattern: 'src/**/*.js' } },
    description: 'glob（参数：pattern）',
  };
  const body = renderBody(pattern, {});
  // Phase 2 改版：步骤行从「（参数参考：X），确认输出符合预期后再进入下一步。」
  // 改为直接给值「调用 glob：X」——原文案是纯复述，命中 A3 tool-recap-only。
  assert.match(body, /调用 glob：src\/\*\*\/\*\.js/);
  assert.doesNotMatch(body, /确认输出符合预期后再进入下一步/);
});

test('templates: extractTriggers 从 sampleArgs 提取参数 key 触发器', () => {
  const pattern = {
    toolSequence: ['glob'],
    sampleArgs: { glob: { pattern: 'src/**/*.js' } },
    description: 'glob',
  };
  const triggers = extractTriggers(pattern);
  assert.ok(triggers.some((t) => t.includes('pattern')), `trigger 应含参数 key，实际: ${triggers.join('|')}`);
});
