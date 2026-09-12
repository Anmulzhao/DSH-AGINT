/**
 * agint-trajectory 脱敏单测（§7.2 / Q3）。
 *
 * 诚实边界同步写在这里：规则脱敏**不保证零泄漏**，它只覆盖已知形态。
 * 测试断言的是「已知形态必被命中 + 未知形态不假装命中」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { compileRules, redactText, redactSteps, redactValue } from '../lib/redact.js';
import { DEFAULT_REDACT_RULES, REDACTED } from '../lib/schema.js';

const rules = compileRules({});

test('默认规则编译：设计稿要求的 5 类起步形态齐全', () => {
  assert.ok(DEFAULT_REDACT_RULES.length >= 5);
  assert.ok(rules.length >= 5);
  const names = rules.map((r) => r.name);
  for (const n of ['openai-key', 'bearer', 'aws-akid', 'email']) assert.ok(names.includes(n), n);
});

test('命中：sk- / Bearer / AKIA / email / api_key= 全被替换', () => {
  const cases = [
    ['key is sk-abcdefghijklmnopqrstuv here', 'sk-'],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9xxxx', 'Bearer'],
    ['aws id AKIA1234567890ABCDEF', 'AKIA'],
    ['mail me at foo.bar@example.com now', '@example.com'],
    ['api_key: supersecretvalue123', 'supersecretvalue123'],
  ];
  for (const [text, mustNotAppear] of cases) {
    const r = redactText(text, rules);
    assert.equal(r.hit, true, `应命中: ${text}`);
    assert.ok(!r.text.includes(mustNotAppear), `残留 ${mustNotAppear}: ${r.text}`);
    assert.ok(r.text.includes(REDACTED));
  }
});

test('脱敏范围覆盖工具参数正文（v0.2 要求：不只是 token/key）', () => {
  const steps = [
    { seq: 0, role: 'human', content: '请帮我处理 sk-abcdefghijklmnopqrstuv' },
    { seq: 1, role: 'observation', content: 'ok user=foo.bar@example.com' },
  ];
  const r = redactSteps(steps, rules);
  assert.equal(r.hit, true);
  assert.ok(!r.steps[0].content.includes('sk-abcdefghijklmnopqrstuv'));
  assert.ok(!r.steps[1].content.includes('foo.bar@example.com'));
  // 不改原数组（纯函数）
  assert.ok(steps[0].content.includes('sk-abcdefghijklmnopqrstuv'));
});

test('redactValue 递归覆盖 final / feedback 的嵌套结构', () => {
  const r = redactValue({ a: { b: ['token AKIA1234567890ABCDEF'] }, c: 1 }, rules);
  assert.equal(r.hit, true);
  assert.ok(!JSON.stringify(r.value).includes('AKIA1234567890ABCDEF'));
  assert.equal(r.value.c, 1);
});

test('未命中：普通文本原样返回且 hit=false', () => {
  const r = redactText('今天天气不错，工具调用成功了', rules);
  assert.equal(r.hit, false);
  assert.equal(r.text, '今天天气不错，工具调用成功了');
});

test('自定义规则可追加；非法正则跳过而不是让记录器崩', () => {
  const cfg = { extraRedactRules: [{ name: 'internal-host', pattern: 'corp\\.internal' }, { name: 'bad', pattern: '([' }] };
  const r = compileRules(cfg);
  const names = r.map((x) => x.name);
  assert.ok(names.includes('internal-host'));
  assert.ok(!names.includes('bad'), '非法正则被跳过');
  const out = redactText('host=build.corp.internal', r);
  assert.ok(out.text.includes(REDACTED));
});

test('useDefaultRedactRules=false 时只用自定义规则（可关闭默认集）', () => {
  const r = compileRules({ useDefaultRedactRules: false, extraRedactRules: [{ name: 'x', pattern: 'SECRETWORD' }] });
  assert.equal(redactText('sk-abcdefghijklmnopqrstuv', r).hit, false);
  assert.equal(redactText('SECRETWORD here', r).hit, true);
});
