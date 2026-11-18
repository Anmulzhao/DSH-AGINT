/**
 * test/scoring.test.mjs — v2.1 三层打分模块（方案 §六）
 *
 * 覆盖：
 *   L1-check: scoreChecks 纯函数（通过率 / 空集 skipped / 异常检查项记 fail）
 *   L1-exec:  scoreExec 复用 curriculum verdict.judge（verifySpec 形状）
 *   L2:     judgeArtifact 边界（ctx 缺席 / 服务缺席 / structured 非法）+ 盲评 prompt 构造
 *   L3:     calibrationAgreement 一致率（<0.7 触发关闸建议）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCORING_PATH = pathToFileURL(resolve(__dirname, '../lib/scoring.js')).href;

// ── L1-check ───────────────────────────────────────────────────────────

test('scoreChecks: 3 过 1 挂 → score=0.75', async () => {
  const { scoreChecks } = await import(SCORING_PATH);
  const r = scoreChecks([
    { name: 'a', ok: true }, { name: 'b', ok: true }, { name: 'c', ok: true }, { name: 'd', ok: false },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.score, 0.75);
  assert.equal(r.passed, 3);
  assert.equal(r.total, 4);
});

test('scoreChecks: 空检查集 → ok=false + reason（不伪造分数）', async () => {
  const { scoreChecks } = await import(SCORING_PATH);
  const r = scoreChecks([]);
  assert.equal(r.ok, false);
  assert.ok(r.reason);
});

test('runArtifactChecks: 检查器抛错记 fail 不中断，score 照算', async () => {
  const { runArtifactChecks } = await import(SCORING_PATH);
  const r = await runArtifactChecks({
    artifactDir: '/nonexistent',
    checks: [
      { name: 'good', run: async () => ({ ok: true }) },
      { name: 'boom', run: async () => { throw new Error('checker crashed'); } },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.score, 0.5);
  assert.equal(r.results.find((x) => x.name === 'boom').ok, false);
});

// ── L1-exec ────────────────────────────────────────────────────────────

test('scoreExec: step-list 达标 → score=1', async () => {
  const { scoreExec } = await import(SCORING_PATH);
  const r = scoreExec({
    verifySpec: { type: 'step-list', expected: ['请求', '错误'], minLength: 3 },
    evidence: { steps: ['发请求', '处理错误码', '重试入口'] },
  });
  assert.equal(r.ok, true);
  assert.equal(r.score, 1);
});

test('scoreExec: step-list 不达标 → score=0', async () => {
  const { scoreExec } = await import(SCORING_PATH);
  const r = scoreExec({
    verifySpec: { type: 'step-list', expected: ['请求', '错误'], minLength: 3 },
    evidence: { steps: ['只有一步'] },
  });
  assert.equal(r.ok, true);
  assert.equal(r.score, 0);
});

test('scoreExec: 无 verifySpec → ok=false（不伪造分数）', async () => {
  const { scoreExec } = await import(SCORING_PATH);
  const r = scoreExec({ verifySpec: null, evidence: {} });
  assert.equal(r.ok, false);
});

test('scoreExec: expected-failure——exit=1 且含全部信号 → score=1（阴性对照）', async () => {
  const { scoreExec } = await import(SCORING_PATH);
  const r = scoreExec({
    verifySpec: { type: 'expected-failure', exitCode: 1, expected: ['[FAIL] package.json 缺失'] },
    evidence: { exitCode: 1, output: '─── broken-policy ───\n[FAIL] package.json 缺失\n' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.score, 1);
});

test('scoreExec: expected-failure——exit=0（该挂没挂）→ score=0', async () => {
  const { scoreExec } = await import(SCORING_PATH);
  const r = scoreExec({
    verifySpec: { type: 'expected-failure', exitCode: 1, expected: ['[FAIL]'] },
    evidence: { exitCode: 0, output: '[FAIL] 不该出现' },
  });
  assert.equal(r.score, 0);
});

test('scoreExec: expected-failure——缺信号 → score=0', async () => {
  const { scoreExec } = await import(SCORING_PATH);
  const r = scoreExec({
    verifySpec: { type: 'expected-failure', exitCode: 1, expected: ['[FAIL] package.json 缺失'] },
    evidence: { exitCode: 1, output: '别的错误' },
  });
  assert.equal(r.score, 0);
});

test('scoreExec: expected-failure——exitCode 可省略（全局门禁混杂时只断言输出信号）', async () => {
  const { scoreExec } = await import(SCORING_PATH);
  const spec = { type: 'expected-failure', expected: ['observability-reachability'] };
  assert.equal(scoreExec({ verifySpec: spec, evidence: { exitCode: 1, output: '维度 11 observability-reachability' } }).score, 1);
  assert.equal(scoreExec({ verifySpec: spec, evidence: { exitCode: 0, output: '没有那个维度' } }).score, 0);
});

// ── L2 judge 边界 ──────────────────────────────────────────────────────

test('judgeArtifact: ctx 缺席 → ok=false，不抛错', async () => {
  const { judgeArtifact } = await import(SCORING_PATH);
  const r = await judgeArtifact({ ctx: null, artifactText: 'x', rubric: { dims: [' clarity'] } });
  assert.equal(r.ok, false);
  assert.ok(r.reason);
});

test('judgeArtifact: agents 服务缺席 → ok=false + attempted=false（没花钱）', async () => {
  const { judgeArtifact } = await import(SCORING_PATH);
  const r = await judgeArtifact({ ctx: { get: () => null }, artifactText: 'x', rubric: { dims: ['clarity'] } });
  assert.equal(r.ok, false);
  assert.equal(r.attempted, false);
});

test('buildJudgePrompt: 盲评——不含 A/B 标签与变体来源，含 rubric 维度', async () => {
  const { buildJudgePrompt } = await import(SCORING_PATH);
  const rubric = { dims: ['clarity', 'correctness'], scale: '0..1' };
  const p = buildJudgePrompt({ artifactText: '工件正文', rubric });
  assert.ok(p.includes('工件正文'));
  assert.ok(p.includes('clarity'));
  assert.ok(p.includes('correctness'));
  assert.ok(!/变体\s*[AB]|variant\s*[AB]|版本\s*[AB]/i.test(p), 'judge prompt 不得泄露 A/B 标签');
});

test('normalizeJudgeScores: 维度分夹 0..1，缺维度/非法值 → null', async () => {
  const { normalizeJudgeScores } = await import(SCORING_PATH);
  const rubric = { dims: ['clarity', 'correctness'] };
  const ok = normalizeJudgeScores({ scores: { clarity: 1.4, correctness: -0.2 }, reason: 'r' }, rubric);
  assert.ok(ok);
  assert.equal(ok.scores.clarity, 1);
  assert.equal(ok.scores.correctness, 0);
  assert.equal(normalizeJudgeScores({ scores: { clarity: 0.5 } }, rubric), null);
  assert.equal(normalizeJudgeScores({ scores: { clarity: 'high', correctness: 0.5 } }, rubric), null);
  assert.equal(normalizeJudgeScores(null, rubric), null);
});

// ── L3 校准 ────────────────────────────────────────────────────────────

test('calibrationAgreement: |judge−human|≤0.15 记一致；一致率<0.7 建议关闸', async () => {
  const { calibrationAgreement } = await import(SCORING_PATH);
  const pairs = [
    { judge: 0.8, human: 0.85 },  // 一致
    { judge: 0.6, human: 0.6 },   // 一致
    { judge: 0.9, human: 0.3 },   // 不一致
    { judge: 0.2, human: 0.8 },   // 不一致
  ];
  const r = calibrationAgreement(pairs);
  assert.equal(r.n, 4);
  assert.equal(r.agreement, 0.5);
  assert.equal(r.disableRecommended, true);
});

test('calibrationAgreement: 全一致 → 不建议关闸；空样本 → ok=false', async () => {
  const { calibrationAgreement } = await import(SCORING_PATH);
  const r = calibrationAgreement([{ judge: 0.7, human: 0.75 }, { judge: 0.4, human: 0.5 }]);
  assert.equal(r.agreement, 1);
  assert.equal(r.disableRecommended, false);
  assert.equal(calibrationAgreement([]).ok, false);
});