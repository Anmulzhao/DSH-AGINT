#!/usr/bin/env node
/**
 * bin/autonomous-write-gate.test.mjs
 * ⛔ 显式路径跑：node --test bin/autonomous-write-gate.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateAutonomousWrite, readSwitch,
  AUTONOMOUS_WRITE_SWITCH_ENV, ALLOWED_TARGETS,
} from './autonomous-write-gate.mjs';

/** 五闸全通过的合法输入（仅测试用，不代表生产已开）。 */
function fullPass(over = {}) {
  return {
    target: 'proposal_queue',
    labelAuthority: 'GOLD',
    predictedDelta: 0.12,
    predictedDeltaSource: 'cap-L3-001 冻结基准对照',
    humanVeto: false,
    emergencyStop: false,
    vetoWindowHours: 24,
    ...over,
  };
}

const opts = { switchOn: true };

// ── 默认拒绝 ───────────────────────────────────────────────────────────────
test('⛔ 空输入 / 无开关 ⇒ 五闸全拒，defaultDeny=true', () => {
  const r = evaluateAutonomousWrite({});
  assert.equal(r.allowed, false);
  assert.equal(r.defaultDeny, true);
  assert.equal(r.checks.length, 5);
  assert.ok(r.checks.every((c) => c.passed === false));
  assert.match(r.reason, /DEFAULT_DENY/);
});

test('⛔ 只开开关、其余缺省 ⇒ 仍拒绝（不存在「一半放行」）', () => {
  const r = evaluateAutonomousWrite({}, opts);
  assert.equal(r.allowed, false);
  assert.equal(r.checks.find((c) => c.id === 'G1_switch').passed, true);
  assert.equal(r.checks.filter((c) => !c.passed).length, 4);
});

test('✅ 五闸全通过才 allowed=true，且仍明确「非自动执行」', () => {
  const r = evaluateAutonomousWrite(fullPass(), opts);
  assert.equal(r.allowed, true);
  assert.ok(r.checks.every((c) => c.passed));
  assert.match(r.reason, /ALL_GATES_PASSED/);
  assert.match(r.reason, /仍非自动执行/);
});

// ── G1 开关语义 ────────────────────────────────────────────────────────────
test('⛔ 只认字面量 on：ON / 1 / true / yes 一律关闭', () => {
  for (const v of ['ON', '1', 'true', 'yes', 'on ', '']) {
    assert.equal(readSwitch({ [AUTONOMOUS_WRITE_SWITCH_ENV]: v }), false, `值 ${JSON.stringify(v)} 不应放行`);
  }
  assert.equal(readSwitch({ [AUTONOMOUS_WRITE_SWITCH_ENV]: 'on' }), true);
  assert.equal(readSwitch({}), false);
  const r = evaluateAutonomousWrite(fullPass(), { env: { [AUTONOMOUS_WRITE_SWITCH_ENV]: 'ON' } });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /G1_switch/);
});

// ── G2 外部锚定 ────────────────────────────────────────────────────────────
test('⛔ SILVER / UNSET / 缺字段 / 非法枚举一律拒绝（选手不能当裁判）', () => {
  for (const a of ['SILVER', 'UNSET', undefined, 'HUMAN_FROZEN']) {
    const r = evaluateAutonomousWrite(fullPass({ labelAuthority: a }), opts);
    assert.equal(r.allowed, false, `${a} 不应放行`);
    assert.equal(r.checks.find((c) => c.id === 'G2_external_anchor').passed, false);
  }
  assert.equal(evaluateAutonomousWrite(fullPass({ labelAuthority: 'HELDOUT' }), opts).allowed, true);
});

// ── G3 目标白名单 ──────────────────────────────────────────────────────────
test('⛔ 白名单外目标拒绝：storages / 评分常量 / prompt / rules', () => {
  for (const t of ['storages', 'scoring_constants', 'prompt', 'rules', undefined]) {
    const r = evaluateAutonomousWrite(fullPass({ target: t }), opts);
    assert.equal(r.allowed, false, `${t} 不应放行`);
  }
  for (const t of ALLOWED_TARGETS) {
    assert.equal(evaluateAutonomousWrite(fullPass({ target: t }), opts).allowed, true);
  }
});

// ── G4 可证伪预测 ──────────────────────────────────────────────────────────
test('⛔ predictedDelta 非有限数 / 缺来源 ⇒ 拒绝', () => {
  for (const d of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, '0.12']) {
    assert.equal(evaluateAutonomousWrite(fullPass({ predictedDelta: d }), opts).allowed, false);
  }
  assert.equal(evaluateAutonomousWrite(fullPass({ predictedDelta: 0 }), opts).allowed, true, '0 是合法有限预测');
  for (const src of [undefined, '', '   ']) {
    assert.equal(evaluateAutonomousWrite(fullPass({ predictedDeltaSource: src }), opts).allowed, false);
  }
});

// ── G5 人类否决 ────────────────────────────────────────────────────────────
test('⛔ 人工否决 / 急停 / 无撤销窗口 ⇒ 拒绝', () => {
  assert.equal(evaluateAutonomousWrite(fullPass({ humanVeto: true }), opts).allowed, false);
  assert.equal(evaluateAutonomousWrite(fullPass({ emergencyStop: true }), opts).allowed, false);
  for (const w of [0, -1, undefined, null, '24']) {
    assert.equal(evaluateAutonomousWrite(fullPass({ vetoWindowHours: w }), opts).allowed, false);
  }
});

// ── Goodhart 护栏 ──────────────────────────────────────────────────────────
test('⛔ 分数涨了也绝不放行：本闸不读任何分数/改善字段', () => {
  const tempting = {
    aestheticScore: 99.9,
    scoreImproved: true,
    verdict: '在变美',
    delta: +19.6,
  };
  const r = evaluateAutonomousWrite(tempting);
  assert.equal(r.allowed, false);
  assert.ok(r.checks.every((c) => c.passed === false));
  // 即使把分数塞进一个「合法」输入，也不改变任何一闸的结果。
  const withScore = evaluateAutonomousWrite({ ...fullPass(), ...tempting }, opts);
  const without = evaluateAutonomousWrite(fullPass(), opts);
  assert.deepEqual(withScore.checks, without.checks);
  assert.equal(withScore.allowed, without.allowed);
});

test('⛔ 输入为 null / 非对象不抛，仍默认拒绝', () => {
  for (const v of [null, undefined, 42, 'x']) {
    assert.equal(evaluateAutonomousWrite(v, opts).allowed, false);
  }
});
