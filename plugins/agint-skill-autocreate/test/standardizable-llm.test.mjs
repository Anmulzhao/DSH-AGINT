// 轨道 C（LLM 判定）合成规则测试（LLM 接入方案 §10 第 2 行）。
//
// 这个文件锁的是**合成顺序与优先级**，不是 LLM 本身：
//   ① 硬否决**优先于** LLM（LLM 说 true 也拦得住）
//   ② shadow 档**不改变任何结论**，只把分歧写进 signals.llmShadow
//   ③ LLM 缺失/非法 → 回落轨道 B，行为与引入本特性之前**逐字一致**
//   ④ primary 档采用 LLM 判定，但 minConfidence 是**同一把尺**（LLM 无特权）
//   ⑤ 降级（llmDegraded）→ 结论跟随轨道 B，但 reason 标 llm_degraded 留痕

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  judgeStandardizable,
  hardVetoOf,
  scoreSignals,
  VERDICT_REASONS,
} from '../lib/standardizable.js';

/** 造一个能稳定过全部硬否决、且规则打分刚好 0.6 的 pattern */
function pattern(opt = {}) {
  const toolSequence = opt.toolSequence ?? ['file_read', 'file_write'];
  const paramSignature = {};
  for (const t of toolSequence) paramSignature[t] = 'path:str:.md|mode:str';
  return {
    toolSequence,
    paramSignature,
    description: opt.description ?? toolSequence.join(' → '),
    occurrenceCount: opt.occurrenceCount ?? 4,
    successRate: opt.successRate ?? 1,
  };
}

const llmV = (standardizable, confidence, rationale = 'r') => ({ standardizable, confidence, rationale });

// ── ① 硬否决优先于 LLM ───────────────────────────────────────────────────

test('硬否决优先：LLM 说 true，但空序列/元工具仍必须 false', () => {
  const cases = [
    { p: { toolSequence: [], paramSignature: {} }, want: VERDICT_REASONS.EMPTY_SEQUENCE },
    { p: { toolSequence: ['evolve_propose', 'file_write'], paramSignature: { evolve_propose: 'a|b', file_write: 'a|b' } }, want: VERDICT_REASONS.META_TOOL },
    // 注意步数充足但工具单一是 TRIVIAL_SINGLE_TOOL；只给 1 步会先命中 TOO_FEW_STEPS
    { p: { toolSequence: ['file_read', 'file_read'], paramSignature: { file_read: 'path:str|mode:str' } }, want: VERDICT_REASONS.TRIVIAL_SINGLE_TOOL },
    { p: { toolSequence: ['file_read', 'file_write'], paramSignature: {} }, want: VERDICT_REASONS.NO_PARAM_STRUCTURE },
  ];
  for (const { p, want } of cases) {
    const r = judgeStandardizable(p, { llmVerdict: llmV(true, 0.99) });
    assert.equal(r.standardizable, false, `hard veto must win for ${want}`);
    assert.equal(r.reason, want);
    assert.equal(r.route, 'heuristic', '硬否决时不应记成 llm 轨道');
  }
});

test('hardVetoOf 与 judgeStandardizable 的硬否决同源（预筛不会与判定漂移）', () => {
  const samples = [
    { toolSequence: [], paramSignature: {} },
    { toolSequence: ['memory_write', 'file_write'], paramSignature: { memory_write: 'x|y', file_write: 'x|y' } },
    { toolSequence: ['file_read'], paramSignature: { file_read: 'a|b' } },
    { toolSequence: ['file_read', 'file_write'], paramSignature: {} },
    pattern(),
  ];
  for (const p of samples) {
    const pre = hardVetoOf(p);
    const judged = judgeStandardizable(p, { llmVerdict: llmV(true, 0.99) });
    if (pre) {
      assert.equal(judged.reason, pre, `预筛判 ${pre}，判定给了 ${judged.reason}`);
    } else {
      assert.notEqual(judged.standardizable, false, '预筛放行后不该被硬否决判死');
    }
  }
});

// ── ② shadow 档：只观测，不改结论 ────────────────────────────────────────

test('shadow：LLM 说 false 但规则通过 → 结论仍是 true，分歧写进 signals.llmShadow', () => {
  const p = pattern();
  const base = judgeStandardizable(p);
  assert.equal(base.standardizable, true, 'fixture 必须能过规则轨，否则本用例没意义');

  const shadowed = judgeStandardizable(p, { llmVerdict: llmV(false, 0.9, '只是通用动作'), llmShadow: true });
  assert.equal(shadowed.standardizable, base.standardizable, 'shadow 不得改变结论');
  assert.equal(shadowed.reason, base.reason);
  assert.equal(shadowed.confidence, base.confidence);
  assert.deepEqual(shadowed.signals.llmShadow, {
    ruleVerdict: true,
    ruleConfidence: base.confidence,
    llmVerdict: false,
    llmConfidence: 0.9,
    agree: false,
    rationale: '只是通用动作',
  });
});

/** 规则分低于阈值的形态：全读类工具（无读写配对）+ 参数稀薄 */
const WEAK_PATTERN = {
  toolSequence: ['file_read', 'glob'],
  paramSignature: { file_read: 'path:str', glob: 'pattern:str' },
  description: 'x',
  occurrenceCount: 1,
  successRate: 0.5,
};

test('shadow：规则不确定（null）而 LLM 说 true → 结论仍是 null，agree=false', () => {
  const base = judgeStandardizable(WEAK_PATTERN);
  assert.equal(base.standardizable, null, 'fixture 必须落在「需人工」档，否则本用例没意义');
  const shadowed = judgeStandardizable(WEAK_PATTERN, { llmVerdict: llmV(true, 0.95), llmShadow: true });
  assert.equal(shadowed.standardizable, null);
  assert.equal(shadowed.signals.llmShadow.agree, false);
  assert.equal(shadowed.signals.llmShadow.ruleVerdict, null);
});

test('shadow：一致时 agree=true（正样本，防「永远 agree=false」的空转判据）', () => {
  const p = pattern();
  const shadowed = judgeStandardizable(p, { llmVerdict: llmV(true, 0.8), llmShadow: true });
  assert.equal(shadowed.signals.llmShadow.agree, true);
});

// ── ③ LLM 缺失 → 回落轨道 B，行为逐字不变 ────────────────────────────────

test('不传 llmVerdict 与传 null 的结果与引入本特性前完全一致', () => {
  const p = pattern();
  const plain = judgeStandardizable(p);
  const withNull = judgeStandardizable(p, { llmVerdict: null, llmShadow: false, llmDegraded: null });
  assert.deepEqual(withNull, plain);
  assert.equal(plain.signals.llmShadow, undefined);
});

test('llmVerdict 形状非法（confidence 非数字 / standardizable 非布尔）→ 视为不可用，回落轨道 B', () => {
  const p = pattern();
  const plain = judgeStandardizable(p);
  for (const bad of [
    { standardizable: true, confidence: 'high' },
    { standardizable: 'yes', confidence: 0.9 },
    null, undefined, 'nope',
  ]) {
    const r = judgeStandardizable(p, { llmVerdict: bad, llmShadow: false });
    assert.deepEqual({ ...r, signals: undefined }, { ...plain, signals: undefined },
      `should fall back for ${JSON.stringify(bad)}`);
  }
});

// ── ④ primary：采用 LLM 判定，同一把尺 ──────────────────────────────────

test('primary：LLM true → OK_LLM；LLM false → LLM_REJECT（route=llm）', () => {
  const p = pattern();
  const ok = judgeStandardizable(p, { llmVerdict: llmV(true, 0.83) });
  assert.equal(ok.standardizable, true);
  assert.equal(ok.reason, VERDICT_REASONS.OK_LLM);
  assert.equal(ok.route, 'llm');
  assert.equal(ok.confidence, 0.83);
  assert.equal(ok.signals.llmRationale, 'r');
  assert.ok(Number.isFinite(ok.signals.ruleConfidence), '规则置信度必须留档，分歧才有可比性');

  const no = judgeStandardizable(p, { llmVerdict: llmV(false, 0.77, '没有可复用领域信息') });
  assert.equal(no.standardizable, false);
  assert.equal(no.reason, VERDICT_REASONS.LLM_REJECT);
  assert.equal(no.confidence, 0.77);
});

test('primary：LLM 说 true 但置信度 < minConfidence → 仍归「需人工」（LLM 无特权阈值）', () => {
  const p = pattern();
  const r = judgeStandardizable(p, { llmVerdict: llmV(true, 0.42) });
  assert.equal(r.standardizable, null);
  assert.equal(r.reason, VERDICT_REASONS.LLM_LOW_CONFIDENCE);
  assert.equal(r.confidence, 0.42);
});

test('primary：阈值对两侧同尺 —— 同一个分数在两条轨道上得到同一结论', () => {
  // 不满侧：规则分不管多少，只要 < 阈值就判「需人工」；
  // 把**同一个分数**喂给 LLM，它也必须判「需人工」（这正是「无特权阈值」的含义）。
  const weakRule = judgeStandardizable(WEAK_PATTERN);
  const weakScore = scoreSignals(weakRule.signals);
  assert.ok(weakScore < 0.6, `fixture 规则分 ${weakScore} 应低于阈值，否则本用例没意义`);
  assert.equal(weakRule.standardizable, null);

  const weakLlm = judgeStandardizable(WEAK_PATTERN, { llmVerdict: llmV(true, weakScore) });
  assert.equal(weakLlm.standardizable, null, `LLM 拿 ${weakScore} 也必须过不了线`);
  assert.equal(weakLlm.reason, VERDICT_REASONS.LLM_LOW_CONFIDENCE);

  // 过线侧：同一分数在两条轨道上都放行。
  const strongScore = scoreSignals(judgeStandardizable(pattern()).signals);
  assert.ok(strongScore >= 0.6, `fixture 规则分 ${strongScore} 应过线`);
  assert.equal(judgeStandardizable(pattern(), { llmVerdict: llmV(true, strongScore) }).standardizable, true);
});

// ── ⑤ 降级留痕（K59）────────────────────────────────────────────────────

test('llmDegraded：结论跟随轨道 B，但 reason 标 llm_degraded 且原结论码留在 signals.ruleReason', () => {
  const pass = judgeStandardizable(pattern(), { llmDegraded: 'llm verdict timeout (60000ms)' });
  assert.equal(pass.standardizable, true, '降级不得改变轨道 B 的结论');
  assert.equal(pass.reason, VERDICT_REASONS.LLM_DEGRADED);
  assert.equal(pass.route, 'heuristic');
  assert.equal(pass.signals.ruleReason, VERDICT_REASONS.OK_HEURISTIC);
  assert.equal(pass.signals.llmDegraded, true);
  assert.equal(pass.signals.llmDegradedReason, 'llm verdict timeout (60000ms)');

  // 用 WEAK_PATTERN（规则分 0.40，稳定落在「需人工」档），而不是临时造一个
  // 刚好卡在阈值线上的 fixture —— 后者只要打分公式微调就会翻转，测试会假绿。
  const uncertain = judgeStandardizable(WEAK_PATTERN, { llmDegraded: 'agents service unavailable' });
  assert.equal(uncertain.standardizable, null);
  assert.equal(uncertain.reason, VERDICT_REASONS.LLM_DEGRADED);
  assert.equal(uncertain.signals.ruleReason, VERDICT_REASONS.LOW_CONFIDENCE);
});

test('降级与 shadow 可同时生效：shadow 仍不改结论（不会因为降级就绕过 shadow 语义）', () => {
  const r = judgeStandardizable(pattern(), {
    llmVerdict: llmV(false, 0.9, 'x'),
    llmShadow: true,
    llmDegraded: null,
  });
  assert.equal(r.reason, VERDICT_REASONS.OK_HEURISTIC);
  assert.equal(r.signals.llmShadow.agree, false);
});
