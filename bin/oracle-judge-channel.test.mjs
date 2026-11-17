/**
 * bin/oracle-judge-channel.test.mjs —— C2 notes-only 契约的阴性对照
 *
 * ⛔ 核心判据：verdict 只当假设、只进 notes；零评分链路字段；
 *    自评 preset 拒收；通道 READY 也不等于开始写或开始调 LLM。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JUDGE_SCHEMA, JUDGE_VERDICTS, SELF_PRESET_IDS, NOTES_ONLY_SINKS,
  FORBIDDEN_JUDGE_TARGETS, findScoringFields,
  wrapJudgeVerdict, assertNotesOnly, evaluateJudgeChannel,
} from './oracle-judge-channel.mjs';

function goodInput(extra = {}) {
  return {
    session: { presetId: 'judge-external-01', sessionId: 'sess-abc' },
    verdict: 'pass',
    evidence: '金标 gold.json#s1 与候选输出对拍',
    ...extra,
  };
}

test('⛔ 现状：0 冻结真值 + D1–D5 未拍板 ⇒ BLOCKED，零写入零 LLM', () => {
  const r = evaluateJudgeChannel({ frozenLabels: 0 });
  assert.equal(r.schemaVersion, JUDGE_SCHEMA);
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.ready, false);
  assert.equal(r.writes, 0);
  assert.equal(r.llmCalls, 0);
  assert.equal(r.verdictScope, 'notes-only');
  assert.equal(r.blockers.length, 4);
  assert.ok(r.blockers.some((b) => b.includes('NO_FROZEN_LABELS')));
  assert.ok(r.blockers.some((b) => b.includes('D1–D5')));
});

test('⛔ 冻结标签读数缺失 ⇒ EXTERNAL_TRUTH_UNKNOWN，不冒充 0', () => {
  const r = evaluateJudgeChannel({ frozenLabels: null });
  assert.ok(r.blockers.some((b) => b.includes('EXTERNAL_TRUTH_UNKNOWN')));
  assert.equal(r.writes, 0);
});

test('✅ 全部前置注入满足 ⇒ READY，但仍零写入（READY ≠ 开始执行）', () => {
  const r = evaluateJudgeChannel({
    frozenLabels: 12,
    d1d5Approved: true,
    independentPresetReady: true,
    notesOnlyContractWired: true,
  });
  assert.equal(r.status, 'READY');
  assert.equal(r.ready, true);
  assert.equal(r.blockers.length, 0);
  assert.equal(r.writes, 0);
  assert.equal(r.llmCalls, 0);
});

test('✅ 合法 judge 输入 ⇒ notes-only / hypothesisOnly / 零评分字段', () => {
  const w = wrapJudgeVerdict(goodInput());
  assert.equal(w.ok, true, w.reason);
  assert.equal(w.writes, 0);
  assert.equal(w.llmCalls, 0);
  assert.equal(Object.isFrozen(w.envelope), true);
  assert.equal(w.envelope.scope, 'notes-only');
  assert.equal(w.envelope.hypothesisOnly, true);
  assert.deepEqual(w.envelope.allowedSinks, [...NOTES_ONLY_SINKS]);
  assert.equal(w.envelope.session.independent, true);
  assert.deepEqual(assertNotesOnly(w.envelope), { ok: true, violations: [] });
});

test('⛔ 母 preset 与四个子 preset 都算自评 ⇒ 拒', () => {
  for (const presetId of SELF_PRESET_IDS) {
    const w = wrapJudgeVerdict(goodInput({ session: { presetId, sessionId: 's1' } }));
    assert.equal(w.ok, false, presetId);
    assert.match(w.reason, /PRESET_NOT_INDEPENDENT/);
    assert.equal(w.writes, 0);
  }
});

test('⛔ 输入混入评分链路字段 ⇒ SCORING_FIELD_PRESENT', () => {
  for (const key of ['aesthetic_score', 'THRESHOLDS', 'humanVerdict', 'composites']) {
    const w = wrapJudgeVerdict(goodInput({ [key]: 1 }));
    assert.equal(w.ok, false, key);
    assert.match(w.reason, /SCORING_FIELD_PRESENT/);
  }
  assert.deepEqual(findScoringFields({ a: { b: { score: 1 } } }), ['a.b.score']);
  assert.ok(FORBIDDEN_JUDGE_TARGETS.includes('scaleHash'));
  assert.ok(FORBIDDEN_JUDGE_TARGETS.includes('METRIC_DEFS'));
});

test('⛔ verdict 不在封闭枚举 / 缺证据 / 缺会话 ⇒ 拒', () => {
  assert.match(wrapJudgeVerdict(goodInput({ verdict: 'looks-good' })).reason, /VERDICT_INVALID/);
  assert.match(wrapJudgeVerdict(goodInput({ evidence: '' })).reason, /EVIDENCE_MISSING/);
  assert.match(wrapJudgeVerdict(goodInput({ session: { presetId: 'x' } })).reason, /SESSION_ID_MISSING/);
  assert.ok(JUDGE_VERDICTS.includes('abstain'), 'abstain 必须是合法档，避免强制造结论');
});

test('⛔ 篡改信封（scope/hypothesisOnly/allowedSinks/评分字段）⇒ assertNotesOnly 抓到', () => {
  const base = wrapJudgeVerdict(goodInput()).envelope;
  const cases = [
    { ...base, scope: 'metrics' },
    { ...base, hypothesisOnly: false },
    { ...base, allowedSinks: ['notes', 'metrics'] },
    { ...base, evidence: { score: 99 } },
  ];
  for (const e of cases) {
    const r = assertNotesOnly(e);
    assert.equal(r.ok, false, JSON.stringify(e).slice(0, 80));
    assert.ok(r.violations.length > 0);
  }
  assert.equal(assertNotesOnly(null).ok, false);
});
