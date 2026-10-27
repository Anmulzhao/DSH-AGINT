/**
 * test/effective-delta.test.mjs — D-QAF §5.3 有效进化增量判定（2026-10-26，D2 收口）
 *
 * 判据纪律：不测「我抄的公式」，测**判定表**（effectiveDelta.js 文件头那张表）。
 * 每条都配阴性对照 —— 把 fail-closed 的门槛放宽后，该红的一条必须真变成红。
 *
 * 重点三条：
 *   1) token 项不完整 ⇒ verdict='unknown' + reason='token-unmeasured'，
 *      **绝不**退回「步数 + 耗时」冒充完整分母（这是 F3 的正题）
 *   2) 完成率涨但资源涨更多 ⇒ ineffective + shouldBlockDeploy=true（宪法 §5.3）
 *   3) unknown 与 effective 的措辞必须不同（周复盘不能把「没测」读成「通过」）
 *
 * Run: node --test plugins/agint-quality/agint-quality-eval/test/effective-delta.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeEffectiveDelta,
  formatEffectiveDeltaLine,
  relativeDelta,
  MIN_TOKEN_COVERAGE,
} from '../lib/effectiveDelta.js';

/** 造一个窗口读数（只给判定关心的字段）。 */
const win = ({ tasks = 10, rate = 0.8, steps = 100, durationMs = 10000, tokens = 1000, coverage = 1 } = {}) => ({
  tasks,
  completedTasks: Math.round(tasks * rate),
  completionRate: rate,
  steps,
  durationMs,
  records: steps,
  tokens: { sum: tokens, measured: Math.round(steps * coverage), coverage, source: 'tokenMeter' },
});

test('完成率涨、资源涨得少 ⇒ effective，且 value > 0', () => {
  const r = computeEffectiveDelta({
    baseline: win({ rate: 0.6, steps: 100, durationMs: 10000, tokens: 1000 }),
    current: win({ rate: 0.8, steps: 110, durationMs: 10500, tokens: 1100 }),
  });
  assert.equal(r.verdict, 'effective');
  assert.equal(r.reason, 'ok');
  assert.ok(r.value > 0);
  assert.equal(r.shouldBlockDeploy, false);
  assert.equal(r.numerator, 0.2);
});

test('⛔ 完成率下降而资源上涨 ⇒ ineffective + 拒绝自动部署（宪法 §5.3）', () => {
  const r = computeEffectiveDelta({
    baseline: win({ rate: 0.60, steps: 100, durationMs: 10000, tokens: 1000 }),
    current: win({ rate: 0.55, steps: 400, durationMs: 40000, tokens: 4000 }),
  });
  assert.equal(r.verdict, 'ineffective');
  assert.equal(r.reason, 'ok');
  assert.ok(r.value < 0, '分子为负 ⇒ 比值 < 0 ⇒ ≤ 0 判无效');
  assert.equal(r.shouldBlockDeploy, true, '这一条才是真正拦部署的那条');
});

test('⚠️ 口径边界：完成率微涨但资源涨 3 倍 ⇒ 比值仍为正（判 effective）', () => {
  // 宪法原文只写「≤ 0 ⇒ 无效」，没有写「收益太小也算无效」。
  // 这条测试把这个语义**钉住**：比值极小 = 有效但代价吃掉收益，
  // 「值不值得」是上层阈值/人工的事，不由本函数偷偷改判。
  const r = computeEffectiveDelta({
    baseline: win({ rate: 0.60, steps: 100, durationMs: 10000, tokens: 1000 }),
    current: win({ rate: 0.61, steps: 400, durationMs: 40000, tokens: 4000 }),
  });
  assert.equal(r.verdict, 'effective');
  assert.ok(r.value > 0 && r.value < 0.01, `比值应极小，实际 ${r.value}`);
  assert.equal(r.shouldBlockDeploy, false);
});

test('完成率没涨（0 增量）⇒ ineffective，即使资源降了', () => {
  const r = computeEffectiveDelta({
    baseline: win({ rate: 0.8, steps: 200 }),
    current: win({ rate: 0.8, steps: 100 }),
  });
  assert.equal(r.verdict, 'ineffective');
  assert.equal(r.reason, 'resource-shrink');
  assert.equal(r.shouldBlockDeploy, true);
});

test('⛔ token 覆盖率不足 ⇒ unknown + token-unmeasured（不回退成「步数+耗时」）', () => {
  const r = computeEffectiveDelta({
    baseline: win({ rate: 0.6, coverage: 0.1 }),
    current: win({ rate: 0.9, coverage: 0.2 }),
  });
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reason, 'token-unmeasured');
  assert.equal(r.value, null, '算不出来就是 null，不许给一个只看半条分母的数字');
  assert.equal(r.shouldBlockDeploy, false, 'unknown ≠ 通过，也 ≠ 拦；它是「护栏未生效」');
  assert.deepEqual(r.tokenCoverage, { baseline: 0.1, current: 0.2 });
});

test('⛔ 阴性对照：把 minTokenCoverage 放到 0 ⇒ 同一组数据变成可算（证明拦的是门槛不是数据）', () => {
  const args = { baseline: win({ rate: 0.6, coverage: 0.1 }), current: win({ rate: 0.9, coverage: 0.2 }) };
  const strict = computeEffectiveDelta(args);
  const loose = computeEffectiveDelta({ ...args, minTokenCoverage: 0 });
  assert.equal(strict.verdict, 'unknown');
  assert.notEqual(loose.verdict, 'unknown');
  assert.equal(MIN_TOKEN_COVERAGE, 0.5);
});

test('窗口内没有可归属任务 ⇒ unknown + window-empty', () => {
  const r = computeEffectiveDelta({ baseline: win({ tasks: 0, rate: null }), current: win() });
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reason, 'window-empty');
});

test('基线某项资源为 0 ⇒ 无法归一化 ⇒ unknown + baseline-resource-zero', () => {
  const r = computeEffectiveDelta({
    baseline: win({ tokens: 0, coverage: 1 }),
    current: win({ tokens: 500 }),
  });
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reason, 'baseline-resource-zero');
});

test('资源完全没变、完成率上升 ⇒ effective（zero-resource-growth）', () => {
  const r = computeEffectiveDelta({
    baseline: win({ rate: 0.6, steps: 100, durationMs: 5000, tokens: 800 }),
    current: win({ rate: 0.9, steps: 100, durationMs: 5000, tokens: 800 }),
  });
  assert.equal(r.verdict, 'effective');
  assert.equal(r.reason, 'zero-resource-growth');
  assert.equal(r.value, null, '分母为 0 时比值无意义，不编一个 Infinity 出来');
  assert.equal(r.denominator, 0);
});

test('资源下降 + 完成率上升 ⇒ effective（resource-shrink）', () => {
  const r = computeEffectiveDelta({
    baseline: win({ rate: 0.6, steps: 200, durationMs: 20000, tokens: 2000 }),
    current: win({ rate: 0.75, steps: 100, durationMs: 10000, tokens: 1000 }),
  });
  assert.equal(r.verdict, 'effective');
  assert.equal(r.reason, 'resource-shrink');
  assert.equal(r.shouldBlockDeploy, false);
});

test('relativeDelta：0/0 视为没变；0 → 正数视为无法归一化', () => {
  assert.equal(relativeDelta(0, 0), 0);
  assert.equal(relativeDelta(0, 5), null);
  assert.equal(relativeDelta(100, 150), 0.5);
  assert.equal(relativeDelta(100, null), null);
});

test('⛔ 一行文本三态措辞互不相同：unknown 必须明说「护栏未生效」', () => {
  const unknown = formatEffectiveDeltaLine({
    verdict: 'unknown', reason: 'token-unmeasured',
    tokenCoverage: { baseline: 0, current: 0.09 }, minTokenCoverage: 0.5,
  });
  const ineffective = formatEffectiveDeltaLine({
    verdict: 'ineffective', reason: 'ok', value: -0.02,
    numerator: 0.01, denominator: -0.5,
    baseline: { completionRate: 0.6 }, current: { completionRate: 0.61 },
    terms: { tokens: 3, steps: 3, duration: 3 },
  });
  const effective = formatEffectiveDeltaLine({
    verdict: 'effective', reason: 'ok', value: 0.5,
    baseline: { completionRate: 0.6 }, current: { completionRate: 0.8 },
    terms: { tokens: 0.1, steps: 0, duration: 0.05 },
  });
  assert.match(unknown, /护栏未生效/);
  assert.match(unknown, /测不出来/);
  assert.doesNotMatch(unknown, /有效进化增量：(\d|比值)/, 'unknown 不许看起来像有结论');
  assert.match(ineffective, /无效进化/);
  assert.match(ineffective, /拒绝部署/);
  assert.match(effective, /有效进化增量：比值/);
  assert.doesNotMatch(effective, /无效/);
});
