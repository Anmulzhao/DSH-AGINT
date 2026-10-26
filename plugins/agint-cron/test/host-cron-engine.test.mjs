// agint-cron D5 测试（2026-10-21）：cron 规则引擎走上游 dsh-schedule
//
// 判据纪律（three-state-audit）：不测「我抄的逻辑」，真调上游模块。
// 核心判据是**对照**：同一个表达式、同一个基准时刻，上游引擎与自研实现
// 必须给出同一个时刻 —— 这才证明"复用上游"没有改变调度语义。
//
// ⛔ 每条都配阴性对照（放宽 ⇒ 变红），否则「全绿」不能证明它在校验：
//   · 引擎缺席 ⇒ 必须回落自研（不能整个调度瘫掉）
//   · 上游模块缺方法 ⇒ buildCronEngine 必须判不可用（半截实现比没有更危险）

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, nextFire, lastFire, setHostCronEngine, getHostCronEngine, localTimeZone } from '../lib/cron.js';
import { buildCronEngine } from '../lib/host-schedule.js';

/** 宿主模块缺席时（不注入）⇒ 引擎必须判不可用。 */
const NO_HOST = null;

test('buildCronEngine: 宿主模块缺席 ⇒ 返回 null（不能造一个半截引擎）', () => {
  assert.equal(buildCronEngine(NO_HOST), null);
});

test('buildCronEngine: 上游缺方法 ⇒ 返回 null（半截实现比没有更危险）', () => {
  const partial = { canonicalizeCronExpression: () => 'x' }; // 缺 create/resolve
  assert.equal(buildCronEngine(partial), null, '缺方法必须判不可用');
});

test('setHostCronEngine: 注入非法值 ⇒ 引擎为 null（不会带着半截实现跑）', () => {
  setHostCronEngine({ nope: 1 });
  assert.equal(getHostCronEngine(), null);
  setHostCronEngine(null);
  assert.equal(getHostCronEngine(), null);
});

test('⛔ 引擎缺席 ⇒ nextFire/lastFire 仍能用（回落自研，调度不能瘫）', () => {
  setHostCronEngine(null);
  const p = parseCron('0 6 * * *');
  const next = nextFire(p, new Date('2026-01-15T12:00:00'));
  assert.ok(next instanceof Date, '引擎缺席时必须仍能算出下一次');
  assert.equal(next.getHours(), 6);
});

// ── 上游对照（需要宿主模块；不可用时 skip）──────────────────────────────
let host = null;
try {
  host = await import('@deepseek-ai/dsh-schedule');
} catch {
  host = null;
}
const skip = host ? false : 'host @deepseek-ai/dsh-schedule unavailable';

const EXPRESSIONS = [
  '0 6 * * *',        // 每天 06:00
  '30 3 * * 1,3,5',  // 周一/三/五 03:30
  '30 2 * * 1',      // 周一 02:30
  '0 3 * * 0',       // 周日 03:00
  '*/30 7-23 * * *', // 高频步进
  '15 2 * * 5',      // 周五 02:15
];
const BASES = [
  new Date('2026-01-15T12:00:00'),
  new Date('2026-01-11T06:00:00'),
  new Date('2026-08-20T00:00:00'),
  new Date('2026-03-08T02:30:00'),
];

test('D5：上游引擎与自研实现对同一表达式/时刻给出同一结果（nextFire）', { skip }, () => {
  const engine = buildCronEngine(host);
  assert.ok(engine, '宿主模块在位时应能装配出引擎');
  let checked = 0;
  for (const expr of EXPRESSIONS) {
    for (const base of BASES) {
      const p = parseCron(expr);
      setHostCronEngine(null);
      const local = nextFire(p, base);
      setHostCronEngine(engine);
      const upstream = nextFire(p, base);
      setHostCronEngine(null);
      assert.ok(local && upstream, `${expr} @ ${base.toISOString()}：两边都该算出下一次`);
      assert.equal(
        upstream.getTime(),
        local.getTime(),
        `${expr} @ ${base.toISOString()}：上游与自研的"下一次"必须一致（本地=${local.toISOString()} 上游=${upstream.toISOString()}）`,
      );
      checked += 1;
    }
  }
  assert.equal(checked, EXPRESSIONS.length * BASES.length, '对照组数要符合预期，别少跑');
});

test('D5：上游引擎与自研实现对同一表达式/时刻给出同一结果（lastFire）', { skip }, () => {
  const engine = buildCronEngine(host);
  assert.ok(engine);
  let checked = 0;
  for (const expr of EXPRESSIONS) {
    for (const base of BASES) {
      const p = parseCron(expr);
      setHostCronEngine(null);
      const local = lastFire(p, base);
      setHostCronEngine(engine);
      const upstream = lastFire(p, base);
      setHostCronEngine(null);
      assert.ok(local && upstream, `${expr} @ ${base.toISOString()}：两边都该算出上一次`);
      assert.equal(
        upstream.getTime(),
        local.getTime(),
        `${expr} @ ${base.toISOString()}：上游与自研的"上一次"必须一致（本地=${local.toISOString()} 上游=${upstream.toISOString()}）`,
      );
      checked += 1;
    }
  }
  assert.equal(checked, EXPRESSIONS.length * BASES.length);
});

test('D5：上游引擎遵守"严格晚于基准"（nextFire 不能返回基准本身）', { skip }, () => {
  const engine = buildCronEngine(host);
  setHostCronEngine(engine);
  try {
    const p = parseCron('0 6 * * *');
    const base = new Date('2026-01-16T06:00:00'); // 正好是触发点
    const n = nextFire(p, base);
    assert.ok(n.getTime() > base.getTime(), '下一次必须严格晚于基准');
    assert.equal(n.getTime(), new Date('2026-01-17T06:00:00').getTime());
  } finally {
    setHostCronEngine(null);
  }
});

test('D5：localTimeZone 返回 IANA 时区名（上游 cron 规则需要显式时区）', () => {
  const tz = localTimeZone();
  assert.equal(typeof tz, 'string');
  assert.ok(tz.length > 0);
  assert.notEqual(tz, 'undefined');
});

test('D5：parseCron 带上 expression + timeZone（上游引擎需要它们）', () => {
  const p = parseCron('0 6 * * *');
  assert.equal(p.expression, '0 6 * * *');
  assert.equal(p.timeZone, localTimeZone());
});
