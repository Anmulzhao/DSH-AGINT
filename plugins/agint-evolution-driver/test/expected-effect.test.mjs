/**
 * expected-effect 单测（1b 前置修正：期望串按目标类型声明）。
 *
 * 三层断言，缺一层就是假绿：
 *   A. 映射本身（skill vs 其他）。
 *   B. **解析后果**：代码串必须被解析成 SUCCESS_RATE（有仪器），
 *      技能串必须解析不出来（METRIC_UNSTATED ⇒ 不落锁）。
 *      B 是这次修正的全部意义 —— 谎报的危害不在措辞，在于它会被锁成一条预测。
 *   C. 两个串都得过 mutator 的 FROZEN 可证伪校验。⛔ 不在这里抄正则：
 *      跑**真 mutator 的 validate**（跨插件 import 只出现在测试里，与
 *      `test/contract-manager.test.mjs` 引 evolution-memory lib 同一先例）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  expectedEffectForTarget,
  EXPECTED_EFFECT_CODE,
  EXPECTED_EFFECT_SKILL,
} from '../lib/expected-effect.js';
import { resolveTargetMetric, METRIC_SOURCE } from '../lib/metric-resolver.js';
import { apply as applyMutator } from '../../agint-mutator/lib/index.js';

// ── A. 映射 ─────────────────────────────────────────────────────────────

test('按目标类型分声明：skill 与 repo 各一句，不复用', () => {
  assert.equal(expectedEffectForTarget({ targetType: 'repo' }), EXPECTED_EFFECT_CODE);
  assert.equal(expectedEffectForTarget({ targetType: 'skill' }), EXPECTED_EFFECT_SKILL);
  assert.notEqual(EXPECTED_EFFECT_CODE, EXPECTED_EFFECT_SKILL, '两句相同 = 修正没生效');
  // 未知类型按代码类处理（driver 目前只有这两种目标；宁可显式回落也不给 undefined）
  assert.equal(expectedEffectForTarget({ targetType: undefined }), EXPECTED_EFFECT_CODE);
  assert.equal(expectedEffectForTarget({}), EXPECTED_EFFECT_CODE);
});

test('代码类的期望串点名了仪器（场景集），不是裸写"通过率"', () => {
  assert.ok(EXPECTED_EFFECT_CODE.includes('场景集'),
    '不点名仪器的"通过率"与改动前那句谎话没有区别');
});

// ── B. 解析后果：这才是谎报真正的代价 ───────────────────────────────────

test('代码类 ⇒ 解析成 SUCCESS_RATE（有 R1 仪器，可以锁）', () => {
  const r = resolveTargetMetric({
    variantMetric: 'unspecified',
    expectedEffect: expectedEffectForTarget({ targetType: 'repo' }),
  });
  assert.equal(r.metric, 'SUCCESS_RATE', JSON.stringify(r));
  assert.equal(r.source, METRIC_SOURCE.EXPECTED_EFFECT);
});

test('⛔ 技能类 ⇒ 解析不出指标（METRIC_UNSTATED）⇒ 不落锁，链上 predictedDelta 留 null', () => {
  const r = resolveTargetMetric({
    variantMetric: 'unspecified',
    expectedEffect: expectedEffectForTarget({ targetType: 'skill' }),
  });
  assert.equal(r.metric, null, '技能类今天没有仪器，锁一条测不到的预测就是新的谎报');
  assert.equal(r.reason, 'METRIC_UNSTATED');
  assert.deepEqual(r.matched, []);
});

// ── C. 真 mutator 的 FROZEN 可证伪校验 ──────────────────────────────────

/** 复刻 mutator 测试的内存 ctx（`plugins/agint-mutator/test/smoke.mjs:112-119` 同型，补 get/has）。 */
function makeMutatorServices() {
  const services = {};
  const domain = () => {
    const s = new Map();
    const table = () => ({
      get size() { return s.size; },
      entries: () => Array.from(s, ([id, v]) => ({ id, ...v })),
      get: (id) => s.get(id),
      has: (id) => s.has(id),
      set: (id, v) => { s.set(id, v); return v; },
      put: async (id, v) => { s.set(id, v); },
      delete: (id) => s.delete(id),
    });
    return { table, close: async () => {} };
  };
  applyMutator({
    storageDomain: { open: async () => domain() },
    get: () => null,
    provide: (n, f) => { services[n] = f; },
    effect: () => () => {},
    on: () => () => {},
  });
  return services;
}

test('两句都满足 mutator 的可证伪契约（validate ok:true 且无"可证伪违规"）', async () => {
  const services = makeMutatorServices();
  const validate = services['agint.mutator.validate'];
  assert.equal(typeof validate, 'function', 'agint.mutator.validate 未注册');
  for (const [label, expectedEffect] of [['code', EXPECTED_EFFECT_CODE], ['skill', EXPECTED_EFFECT_SKILL]]) {
    const proposal = {
      id: `p-${label}`,
      kind: 'PROMPT_MUTATION',
      atomicScope: 'prompt',
      source: 'evolution-reversed',
      expectedEffect,
      rollbackCondition: 'regression → auto-rollback',
      payload: { promptId: 'smoke-prompt', oldText: 'a', newText: 'b', diffStrategy: 'unified_diff' },
      failureId: 'f-1',
      rootCause: 'PROMPT_DEFICIENCY: other',
      status: 'PENDING',
      preimageHash: 'sha256:abc',
      createdAt: '2026-10-03T04:00:00.000Z',
    };
    const out = await validate({ proposal });
    const findings = (out?.findings ?? []).map(String);
    assert.equal(out.ok, true, `${label} 被 validate 拒：${findings.join(' | ')}`);
    assert.equal(findings.filter((f) => f.includes('可证伪')).length, 0,
      `${label} 违反 FROZEN 可证伪形状：${findings.join(' | ')}`);
  }
});
