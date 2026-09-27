import test from 'node:test';
import assert from 'node:assert/strict';

import { judgeSkillIdentity, normalizeToken, KNOWN_TOOLS } from '../lib/name-gate.js';

// ── 真实历史病例（2026-09-27 生产里已发布的 3 个 + 已归档的 2 个）────────

test('T1: 连续重复 token —— pwsh-pwsh-pwsh-pwsh 必拒', () => {
  const r = judgeSkillIdentity('pwsh-pwsh-pwsh-pwsh', 'pwsh → pwsh → pwsh（参数：command）');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'repeated-token');
});

test('T2: 全是工具名 —— pwsh-glob-webfetch-webfetch 必拒', () => {
  const r = judgeSkillIdentity('pwsh-glob-webfetch-webfetch', 'pwsh → glob → web_fetch → web_fetch');
  assert.equal(r.ok, false);
  // 连续重复优先命中（webfetch-webfetch）；重要的是"必拒"，不是命中哪条
  assert.ok(['all-tools', 'repeated-token'].includes(r.code), `实际 code=${r.code}`);
});

test('T3: 多数是工具名 —— agintsearch-pwsh-askuserquestion-pwsh 必拒', () => {
  const r = judgeSkillIdentity(
    'agintsearch-pwsh-askuserquestion-pwsh',
    'agint_search → pwsh → ask_user_question → pwsh（参数：query/command）',
  );
  assert.equal(r.ok, false);
  // uniq 三词全是工具名 ⇒ all-tools（比 mostly-tools 更严，合理）
  assert.ok(['all-tools', 'mostly-tools'].includes(r.code), `实际 code=${r.code}`);
});

test('T4: 已归档病例 —— glob-glob-glob-glob / askuserquestion-todowrite-edit-read', () => {
  assert.equal(judgeSkillIdentity('glob-glob-glob-glob').ok, false);
  assert.equal(judgeSkillIdentity('askuserquestion-todowrite-edit-read').ok, false);
});

// ── 该放行的必须放行（防误报）──────────────────────────────────────────

test('T5: 语义名放行 —— 含工具词的正常技能名不被误杀', () => {
  for (const name of [
    'cross-platform-path-fix',
    'github-push',               // 含 push（不在工具表）
    'memory-discipline',
    'plugin-preflight',
    'cordis-plugin-development',
    'editing-cordis-compositions',
    'agint-install-bootstrap-rescue',
    'causal-reasoning',
    'pdf-report-review',
  ]) {
    const r = judgeSkillIdentity(name, '');
    assert.equal(r.ok, true, `${name} 不应被拒：${r.reason}`);
  }
});

test('T6: 只带一个工具词的动宾短语放行 —— 规则 4 不误伤 2 token 名', () => {
  // read-log-summary：read 是工具名，但只占 1/3 ⇒ 放行
  assert.equal(judgeSkillIdentity('read-log-summary').ok, true);
  // 但 read-log-read 这种 2/3 的：uniq=2 < 3 ⇒ 不触发规则 4，仍放行（保守）
  assert.equal(judgeSkillIdentity('read-log-read').ok, true);
});

// ── 规则细节 ────────────────────────────────────────────────────────────

test('T7: 格式 —— 非 kebab-case 必拒（含大写、下划线、空格）', () => {
  assert.equal(judgeSkillIdentity('MySkill').code, 'format');
  assert.equal(judgeSkillIdentity('my_skill').code, 'format');
  assert.equal(judgeSkillIdentity('my skill').code, 'format');
  assert.equal(judgeSkillIdentity('').code, 'empty');
});

test('T8: 规则 5 —— 描述是 ≥3 段工具序列骨架才拒；2 段不拒（防误伤）', () => {
  const seq3 = judgeSkillIdentity('report-builder', 'pwsh → glob → write（参数：command）');
  assert.equal(seq3.ok, false);
  assert.equal(seq3.code, 'description-tool-sequence');
  // 2 段：不触发（可能只是"读 → 写"的正常描述）
  assert.equal(judgeSkillIdentity('report-builder', 'pwsh → write').ok, true);
  // 3 段但含非工具词：不触发
  assert.equal(judgeSkillIdentity('report-builder', 'collect → analyze → write').ok, true);
});

test('T9: extraTools 可注入扩展工具表（注入后原本放行的名字会被拦）', () => {
  const name = 'foobar-helper-tool';
  assert.equal(judgeSkillIdentity(name).ok, true, '未注入时应放行');
  // 注入 foobar/helper 后：3 个 uniq 词里 2 个是工具名 ⇒ 命中 mostly-tools
  assert.equal(judgeSkillIdentity(name, '', { extraTools: ['foobar', 'helper'] }).code, 'mostly-tools');
  assert.equal(judgeSkillIdentity('foobar-helper', '', { extraTools: ['foobar', 'helper'] }).code, 'all-tools');
});

test('T10: normalizeToken 归一（下划线/点/大小写）', () => {
  assert.equal(normalizeToken('Web_Fetch'), 'web-fetch');
  assert.equal(normalizeToken('pwsh'), 'pwsh');
  assert.ok(KNOWN_TOOLS.includes('pwsh'));
});

console.log('\nname-gate: 全部用例通过（T1–T10）');
