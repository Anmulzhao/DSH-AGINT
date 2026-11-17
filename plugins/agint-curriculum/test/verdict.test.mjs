// verdict 单元测试（§4.4：C1/C2/C3 外部化判定）。

import test from 'node:test';
import assert from 'node:assert/strict';

import { judge, listVerifierTypes } from '../lib/verdict.js';
import { generateChallenge } from '../lib/challenge-gen.js';

const mk = (domain, level) => generateChallenge(domain, level, { sessionId: 's1' });

test('C3：无 evidence → fail（自评不算证据）；requireEvidence=false 时仍按断言判', () => {
  const ch = mk('codegen', 'D1');
  const v = judge(ch, {}, { requireEvidence: true });
  assert.equal(v.result, 'fail');
  assert.match(v.reason, /无 evidence/);

  // requireEvidence=false：空 evidence 交给断言 → exitCode 缺失 → fail
  const v2 = judge(ch, {}, { requireEvidence: false });
  assert.equal(v2.result, 'fail');
});

test('C2：selfAssessment 剥离进 notes，绝不参与判定', () => {
  const ch = mk('reasoning', 'D1'); // expected = A
  const v = judge(ch, {
    conclusion: 'A',
    selfAssessment: '我感觉做对了，而且用了三段论推理',
  });
  assert.equal(v.result, 'pass');
  assert.equal(v.notes, '我感觉做对了，而且用了三段论推理');
  assert.equal(v.evidence.selfAssessment, undefined, 'selfAssessment 不得留在判定证据里');

  // 即使自评说"我没把握"，只要断言通过就是 pass（C2：自评不影响结果）
  const v2 = judge(ch, { conclusion: 'A', selfAssessment: '我不确定' });
  assert.equal(v2.result, 'pass');
});

test('exit-code-output：exitCode=0 + 非空输出 → pass；否则 fail', () => {
  const ch = mk('codegen', 'D1');
  assert.equal(judge(ch, { exitCode: 0, output: '2\n4\n6' }).result, 'pass');
  assert.equal(judge(ch, { exitCode: 1, output: 'boom' }).result, 'fail');
  assert.equal(judge(ch, { exitCode: 0, output: '   ' }).result, 'fail', '空白输出不算');
});

test('conclusion-match：与预期一致 → pass；不一致/缺失 → fail', () => {
  const ch = mk('reasoning', 'D1'); // expected = A
  assert.equal(judge(ch, { conclusion: 'A' }).result, 'pass');
  assert.equal(judge(ch, { conclusion: 'B' }).result, 'fail');
  assert.equal(judge(ch, { conclusion: '' }).result, 'fail');
  assert.equal(judge(ch, { conclusion: '  A  ' }).result, 'pass', '容忍首尾空白');
});

test('step-list：数量达标 + 全部关键词 → pass；任一不满足 → fail', () => {
  const ch = mk('planning', 'D2'); // min 4, keywords [test, build]
  assert.equal(judge(ch, { steps: ['a', 'b', 'c', 'd', 'test', 'build'] }).result, 'pass');
  assert.equal(judge(ch, { steps: ['a', 'b', 'c'] }).result, 'fail', '步数不足');
  assert.equal(judge(ch, { steps: ['a', 'b', 'c', 'd'] }).result, 'fail', '缺关键词');
  assert.equal(judge(ch, { steps: 'not-array' }).result, 'fail', '非数组');
});

test('tool-match：工具命中 + exitCode=0 → pass；任一不满足 → fail', () => {
  const ch = mk('tool-use', 'D1'); // tool = read_file
  assert.equal(judge(ch, { toolUsed: 'read_file', exitCode: 0, output: '42 lines' }).result, 'pass');
  assert.equal(judge(ch, { toolUsed: 'glob', exitCode: 0 }).result, 'fail', '工具不符');
  assert.equal(judge(ch, { toolUsed: 'read_file', exitCode: 1 }).result, 'fail', '退出码非 0');
});

test('防御性：verifySpec 缺失 → fail 不 pass（宁 fail 不 pass）', () => {
  const broken = { ...mk('codegen', 'D1'), verifySpec: null };
  const v = judge(broken, { exitCode: 0, output: 'ok' });
  assert.equal(v.result, 'fail');
  assert.match(v.reason, /防御性 fail/);
});

test('listVerifierTypes 覆盖 5 种断言（v0.2.4 增 exec-code）', () => {
  assert.deepEqual(
    [...listVerifierTypes()].sort(),
    ['conclusion-match', 'exec-code', 'exit-code-output', 'step-list', 'tool-match'],
  );
});

// ── v0.2.4（提案 2cac5f70）：D5 封顶换题型 exec-code ──────────────────────

test('exec-code：exitCode=0 + 输出含全部确定性信号 → pass', () => {
  const ch = generateChallenge('integration', 'D5', { variant: 3 }); // diff=[4] / consistent=false
  assert.equal(ch.verifySpec.type, 'exec-code');
  assert.equal(judge(ch, { exitCode: 0, output: 'region diff diff=[4], consistent=false' }).result, 'pass');
});

test('exec-code：缺任一信号 / 口述步骤 / exitCode≠0 → fail（宁 fail 不 pass）', () => {
  const ch = generateChallenge('integration', 'D5', { variant: 3 });
  assert.equal(judge(ch, { exitCode: 0, output: '我会在两边做一致性校验' }).result, 'fail', '口述不算真实执行');
  assert.equal(judge(ch, { exitCode: 0, output: 'diff=[4] only' }).result, 'fail', '信号不齐');
  assert.equal(judge(ch, { exitCode: 1, output: 'diff=[4] consistent=false' }).result, 'fail', '运行失败');
});

test('exec-code：3 道新题 pass 证据真跑可判 pass（提案风险章节要求预判验证）', () => {
  const cases = [
    { v: 3, output: 'diff=[4] consistent=false' },
    { v: 4, output: 'rollback=true active_version=v1 canary_aborted=true' },
    { v: 5, output: 'migrated=100 cutover=done downtime=0s' },
  ];
  for (const { v, output } of cases) {
    const ch = generateChallenge('integration', 'D5', { variant: v });
    assert.equal(judge(ch, { exitCode: 0, output }).result, 'pass', `variant=${v} 应可判 pass`);
  }
});

test('step-list：参数层数组包装 { item: [...] } 可还原（2026-11-17 传输缺陷回归）', () => {
  const ch = mk('planning', 'D2'); // min 4, keywords [test, build]
  const wrapped = { item: ['a', 'b', 'c', 'd', 'test', 'build'] };
  assert.equal(judge(ch, { steps: wrapped }).result, 'pass', '包装形态应还原后按原判据判定');
  assert.equal(judge(ch, { steps: { item: ['a', 'b', 'c'] } }).result, 'fail', '还原后步数不足仍 fail');
  assert.equal(judge(ch, { steps: { item: ['a', 'b', 'c', 'd'] } }).result, 'fail', '还原后缺关键词仍 fail');
  assert.equal(judge(ch, { steps: { item: [1, 2, 3, 4, 'test', 'build'] } }).result, 'fail', '非字符串元素不放宽判据');
  assert.equal(judge(ch, { steps: { 0: 'a', 1: 'b', 2: 'c', 3: 'd', 4: 'test', 5: 'build' } }).result, 'pass', '数字下标形态可还原');
});
