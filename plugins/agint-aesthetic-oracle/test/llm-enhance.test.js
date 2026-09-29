/**
 * agint-aesthetic-oracle §8.1 LLM 增强档测试（v0.4.0）。
 *
 * 覆盖：
 *   AC-16：AGINT_AESTHETIC_ORACLE_LLM=off 时输出模板（llmMode 解析 + canL* 全 false）
 *   AC-17：LLM provider 不可用（mock ctx 无 agents）时降级 mode='heuristic-degraded'
 *   AC-18：L1 数字逐字节来自输入（fallback 路径原样返回模板文本）
 *   AC-18b：L2 在无 auditIds 时直接降级（不构造含正文的 prompt）
 *   AC-20：分级开关独立性（l1 / l1l2 / all 各级 canL* 正确）
 *
 * 不依赖真 LLM：所有 spawnOracleLlm 调用在无 agents/subagents 的 mock ctx 下走降级路径。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  llmMode, canL1, canL2, canL3,
  l1EnhanceAdvice, l2DeepDive, l3PolishProposal,
} from '../lib/llm-enhance.js';

// 无 agents/subagents 的空 ctx —— 所有 LLM 调用立即降级
const emptyCtx = { get: () => null };

// ── llmMode 解析（AC-16 / AC-20）─────────────────────────────────────────────

test('llmMode: 缺省 / 空 = all（默认拉满）', () => {
  assert.equal(llmMode({}), 'all');
  assert.equal(llmMode({ AGINT_AESTHETIC_ORACLE_LLM: '' }), 'all');
  assert.equal(llmMode({ AGINT_AESTHETIC_ORACLE_LLM: 'all' }), 'all');
});

test('llmMode: off / l1 / l1l2 精确解析（大小写不敏感）', () => {
  assert.equal(llmMode({ AGINT_AESTHETIC_ORACLE_LLM: 'off' }), 'off');
  assert.equal(llmMode({ AGINT_AESTHETIC_ORACLE_LLM: 'OFF' }), 'off');
  assert.equal(llmMode({ AGINT_AESTHETIC_ORACLE_LLM: 'l1' }), 'l1');
  assert.equal(llmMode({ AGINT_AESTHETIC_ORACLE_LLM: 'L1' }), 'l1');
  assert.equal(llmMode({ AGINT_AESTHETIC_ORACLE_LLM: 'l1l2' }), 'l1l2');
});

test('canL1/canL2/canL3 分级独立性（AC-20）', () => {
  assert.equal(canL1('off'), false);
  assert.equal(canL2('off'), false);
  assert.equal(canL3('off'), false);

  assert.equal(canL1('l1'), true);
  assert.equal(canL2('l1'), false);
  assert.equal(canL3('l1'), false);

  assert.equal(canL1('l1l2'), true);
  assert.equal(canL2('l1l2'), true);
  assert.equal(canL3('l1l2'), false);

  assert.equal(canL1('all'), true);
  assert.equal(canL2('all'), true);
  assert.equal(canL3('all'), true);
});

// ── L1 降级路径（AC-17 / AC-18）─────────────────────────────────────────────

test('l1EnhanceAdvice: LLM 不可用时降级回模板原文（AC-17/18）', async () => {
  const result = await l1EnhanceAdvice(emptyCtx, {
    templateAdvice: '为 71 条无 evidence 记忆补证据',
    templateEvidence: 'memory 表 evidence 字段扫描',
    worstKey: 'noise',
    value: 0.232,
  });
  assert.equal(result.mode, 'heuristic-degraded');
  // AC-18：数字逐字节来自输入——fallback 原样返回模板
  assert.equal(result.advice, '为 71 条无 evidence 记忆补证据');
  assert.equal(result.evidence, 'memory 表 evidence 字段扫描');
  assert.match(result.reason, /agents unavailable/);
});

test('l1EnhanceAdvice: 空 templateAdvice 直接返回 fallback', async () => {
  const result = await l1EnhanceAdvice(emptyCtx, {
    templateAdvice: '', templateEvidence: '', worstKey: 'noise', value: 0.2,
  });
  assert.equal(result.mode, 'heuristic-degraded');
});

// ── L2 降级路径（AC-18b）─────────────────────────────────────────────────────

test('l2DeepDive: 无 auditIds 时不构造 prompt 直接降级（AC-18b）', async () => {
  const result = await l2DeepDive(emptyCtx, {
    worstKey: 'noise', value: 0.232, threshold: 0.30,
    auditIds: [], adviceCtx: {},
  });
  assert.equal(result.mode, 'heuristic-degraded');
  assert.match(result.reason, /no auditIds/);
});

test('l2DeepDive: LLM 不可用时降级（AC-17）', async () => {
  const result = await l2DeepDive(emptyCtx, {
    worstKey: 'noise', value: 0.232, threshold: 0.30,
    auditIds: ['mem-0', 'mem-1', 'mem-2'], adviceCtx: {},
  });
  assert.equal(result.mode, 'heuristic-degraded');
  assert.match(result.narrative, /最丑指标/);
});

// ── L3 降级路径 ────────────────────────────────────────────────────────────

test('l3PolishProposal: LLM 不可用时降级回模板 body', async () => {
  const templateBody = '建议：归档 wiki orphans\n证据：wiki_lint 报告';
  const result = await l3PolishProposal(emptyCtx, {
    title: '美谕提案：噪声比',
    templateBody,
    deepDive: { narrative: '测试', pattern: 'noise' },
  });
  assert.equal(result.mode, 'heuristic-degraded');
  assert.equal(result.body, templateBody);
});

// ── topics schema mode 字段（AC-16 向后兼容）────────────────────────────────

test('topics schema: mode 字段缺省 = template（向后兼容）', async () => {
  const { validateTopicPayload } = await import('../lib/topics.js');
  // 不传 mode → default 'template' 应该校验通过
  const r = validateTopicPayload('oracle.daily', {
    kind: 'daily', asOf: '2026-09-29T00:00:00Z', score: 52.4,
    verdict: 'flat', worstKey: 'noise', lines: ['a', 'b'], text: 'a\nb',
  });
  assert.equal(r.ok, true, `schema rejected: ${r.issues ?? ''}`);
});

test('topics schema: mode=llm / heuristic-degraded 合法', async () => {
  const { validateTopicPayload } = await import('../lib/topics.js');
  for (const mode of ['llm', 'heuristic-degraded', 'template']) {
    const r = validateTopicPayload('oracle.weekly', {
      kind: 'weekly', asOf: '2026-09-29T00:00:00Z', score: 52.4,
      verdict: 'flat', worstKey: 'noise', lines: ['a'], text: 'a', mode,
    });
    assert.equal(r.ok, true, `mode=${mode} rejected: ${r.issues ?? ''}`);
  }
});
