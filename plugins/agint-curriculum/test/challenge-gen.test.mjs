// challenge-gen 单元测试（§4.3 [2] + §5.2 B-3：4 个域模板）。

import test from 'node:test';
import assert from 'node:assert/strict';

import { generateChallenge, hasTemplate, listTemplateDomains } from '../lib/challenge-gen.js';
import { DIFFICULTY_LEVELS, TEMPLATE_DOMAINS, TEMPLATE_DESCRIPTIONS } from '../lib/schema.js';

test('4 个域模板全覆盖（codegen / reasoning / planning / tool-use）', () => {
  assert.deepEqual(listTemplateDomains(), TEMPLATE_DOMAINS);
  for (const d of TEMPLATE_DOMAINS) {
    assert.equal(hasTemplate(d), true, `${d} 应有模板`);
    assert.ok(TEMPLATE_DESCRIPTIONS[d], `${d} 应有描述`);
  }
  assert.equal(hasTemplate('unknown'), false);
});

test('每域 × 每难度档（D1-D5）都能确定性生成，且必带可自动判定 verifySpec（C1）', () => {
  for (const domain of TEMPLATE_DOMAINS) {
    for (const level of DIFFICULTY_LEVELS) {
      const a = generateChallenge(domain, level, { sessionId: 's1' });
      const b = generateChallenge(domain, level, { sessionId: 's1' });
      assert.deepEqual(a, b, `${domain}@${level} 应确定性`);
      assert.ok(a.prompt.length > 0);
      assert.ok(a.passCriteria.length > 0);
      assert.ok(a.verifySpec?.type, `${domain}@${level} 必须带 verifySpec（C1）`);
      assert.equal(a.templateType, domain);
      assert.equal(a.status, 'open');
      assert.equal(a.attemptCount, 0);
    }
  }
});

test('verifySpec 类型与域匹配（断言类型正确）', () => {
  assert.equal(generateChallenge('codegen', 'D1').verifySpec.type, 'exit-code-output');
  assert.equal(generateChallenge('reasoning', 'D1').verifySpec.type, 'conclusion-match');
  assert.equal(generateChallenge('planning', 'D1').verifySpec.type, 'step-list');
  assert.equal(generateChallenge('tool-use', 'D1').verifySpec.type, 'tool-match');
});

test('难度影响内容（D1 ≠ D5 的 prompt / verifySpec 参数）', () => {
  const d1 = generateChallenge('codegen', 'D1');
  const d5 = generateChallenge('codegen', 'D5');
  assert.notEqual(d1.prompt, d5.prompt);

  const r1 = generateChallenge('reasoning', 'D1');
  const r5 = generateChallenge('reasoning', 'D5');
  assert.notEqual(r1.verifySpec.expected, r5.verifySpec.expected, 'reasoning 答案应随难度变化');
});

test('无效域抛错；无 sessionId 时生成默认 curriculum- 前缀', () => {
  assert.throws(() => generateChallenge('unknown', 'D1', {}), /无模板/);
  const c = generateChallenge('codegen', 'D1');
  assert.ok(c.sessionId.startsWith('curriculum-'), '默认 sessionId 必须带 curriculum- 前缀（D1）');
});
