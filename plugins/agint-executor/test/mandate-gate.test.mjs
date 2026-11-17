// agint-executor × 审批凭据（W8-3，2026-11-03）。
//
// 钉的是「凭据真的能拦住执行」，而不只是「凭据签发得对」。
// agint-evolve 侧有 11 例证明签发与判定；这里证明**判定结果进了判决**。
//
// 三条口径：
//   G1 mismatch ⇒ cancel，且理由里要有人能读懂的原因（不能只说"已撤销"）
//   G2 ⛔ unknown ⇒ **放行**（老提案没凭据不是越权；拦下来等于升级即停摆）
//   G3 凭据核验必须在**周额度之前**：越权不是"这次不该跑"，顺延到下周照样无效
//
// 独立实现，不 import agint-evolve（部署位各自独立目录，跨插件 import 会 ENOENT）。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideRun } from '../lib/plan.js';

const NOW = Date.parse('2026-11-03T10:00:00+08:00');

const job = (over = {}) => ({ id: 'j1', proposalId: 'p1', attempts: 1, maxAttempts: 2, ...over });
const proposal = (over = {}) => ({ id: 'p1', status: 'approved', blocker: '', ...over });
const base = { job: job(), proposal: proposal(), driverReady: true };

test('G0 没有任何凭据信息 ⇒ 照常 run（不改变既有行为）', () => {
  assert.equal(decideRun({ ...base, now: NOW }).action, 'run');
});

test('G1 凭据 mismatch ⇒ cancel，理由包含越权原因', () => {
  const verdict = decideRun({
    ...base,
    mandate: { state: 'mismatch', reason: '正文路径超出批准范围（plugins/x.js）' },
    now: NOW,
  });
  assert.equal(verdict.action, 'cancel');
  assert.ok(verdict.reason.includes('重新审批'),
    `理由必须指向"要重新审批"，实际：${verdict.reason}`);
  assert.ok(verdict.reason.includes('plugins/x.js'),
    '要指出具体越界的路径，否则人不知道该改哪个');
});

test('G2 ⛔ 凭据 unknown ⇒ 放行（老提案不是越权）', () => {
  const verdict = decideRun({
    ...base,
    mandate: { state: 'unknown', reason: '这条提案没有审批凭据' },
    now: NOW,
  });
  assert.equal(verdict.action, 'run',
    '⛔ 升级瞬间 90+ 条历史提案都没有凭据 —— 判成拦会把它们集体停摆');
});

test('G2b 凭据 ok ⇒ 放行', () => {
  assert.equal(decideRun({ ...base, mandate: { state: 'ok' }, now: NOW }).action, 'run');
});

test('G3 越权 + 周额度已满 ⇒ 仍然是 cancel，而不是 defer', () => {
  const verdict = decideRun({
    ...base,
    weekCommits: 9, cap: 5,
    mandate: { state: 'mismatch', reason: '超出批准范围' },
    now: NOW,
  });
  assert.equal(verdict.action, 'cancel',
    '⛔ 顺序反了会把这个提案"顺延"到下周 —— 下周凭据照样无效，等于无限拖延');
});

test('G4 越权但驱动没挂载 ⇒ 先报驱动缺失（能力问题比授权问题更前置）', () => {
  const verdict = decideRun({
    ...base, driverReady: false,
    mandate: { state: 'mismatch', reason: '超出批准范围' },
    now: NOW,
  });
  assert.equal(verdict.action, 'fail');
  assert.ok(verdict.error.includes('evolutionDriver'));
});

test('G5 越权但状态已不是 approved ⇒ 撤单理由是状态，不是凭据', () => {
  const verdict = decideRun({
    ...base, proposal: proposal({ status: 'proposed' }),
    mandate: { state: 'mismatch', reason: '超出批准范围' },
    now: NOW,
  });
  assert.equal(verdict.action, 'cancel');
  assert.ok(verdict.reason.includes('proposed'),
    '状态这条更早判定，理由不能被凭据盖掉（否则人以为只是授权问题）');
});
