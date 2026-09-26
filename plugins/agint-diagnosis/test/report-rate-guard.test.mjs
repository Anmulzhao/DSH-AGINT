/**
 * agint-diagnosis: report() 频率熔断验收 —— 2026-09-26（二修）
 * Run: node plugins/agint-diagnosis/test/report-rate-guard.test.mjs
 *
 * 背景（为什么这个文件存在）：
 *   2026-09-26 11:40:40 → 11:58:10，宿主里 report() 被连续调用 12,605 次
 *   （每秒 ~11 次，持续 18 分钟），reports 表堆到 12,615 条而 cap 是 50。
 *   同日一修只在 agint-self-model 内部堵了 `trigger==='diagnosis-completed'`
 *   这一处再入边，对「外部连续调用」无效 —— 现场全部报告的 windowDays 都是 7，
 *   即 aggregateCapabilityEvidence 的 fromDiagnosisEvent=false 分支。
 *
 *   二修改为「与调用方无关」的守门：60s 滑动窗口内超限直接拒绝并抛错。
 *   本文件锁死该行为，防止被静默改回。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const plugin = require('../lib/index.js');

/** 忠实复刻宿主 table API：entries() = 迭代器；size = getter。 */
function faithfulTable(map) {
  return {
    get size() { return map.size; },
    entries() { return [...map.entries()][Symbol.iterator](); },
    put: async (k, v) => { map.set(k, v); },
    get: async (k) => map.get(k),
    delete: async (k) => { map.delete(k); },
  };
}

function makeCtx({ config = {}, startsEmpty = true } = {}) {
  const stores = { annotations: new Map(), clusters: new Map(), reports: new Map() };
  if (!startsEmpty) stores.reports.set('seed', { id: 'seed', kind: 'report' });
  const services = {};
  plugin.apply({
    storageDomain: {
      open: async () => ({
        table: (n) => faithfulTable(stores[n] || new Map()),
        close: async () => undefined,
      }),
    },
    get: () => null,               // evolution / wiki / memory / bus 全软降级
    provide: (k, v) => { services[k] = v; },
    effect: () => () => undefined,
  }, config);
  return { services, stores };
}

test('默认上限 30：30 次放行，第 31 次抛错（不静默）', async () => {
  const { services } = makeCtx({ config: {} });
  const report = services['agint.diagnosis.report'];
  let ok = 0;
  let err = null;
  for (let i = 0; i < 31; i += 1) {
    try { await report({ windowDays: 7 }); ok += 1; }
    catch (e) { err = e; break; }
  }
  assert.equal(ok, 30, "前 30 次应放行");
  assert.ok(err, '第 31 次必须抛错（旧行为是静默继续灌）');
  assert.match(err.message, /rate limited/, `错误文案应含 rate limited，实际：${err.message}`);
});

test('熔断后可观测：stats().reportRateGuard.trips 计数并带窗口参数', async () => {
  const { services } = makeCtx({ config: {} });
  const report = services['agint.diagnosis.report'];
  for (let i = 0; i < 30; i += 1) await report({ windowDays: 7 });
  await assert.rejects(() => report({ windowDays: 7 }));
  const st = await services['agint.diagnosis.stats']();
  assert.equal(st.reportRateGuard.windowMs, 60_000);
  assert.equal(st.reportRateGuard.max, 30);
  assert.ok(st.reportRateGuard.trips >= 1, 'trips 应 >= 1');
  assert.ok(st.reportRateGuard.recent > 30, 'recent 应记录窗口内的调用数');
});

test('配置可放宽：rate_max_per_min=3 时第 4 次即拒（kill-switch 是调参不是关）', async () => {
  const { services } = makeCtx({ config: { rate_max_per_min: 3 } });
  const report = services['agint.diagnosis.report'];
  for (let i = 0; i < 3; i += 1) await report({ windowDays: 7 });
  await assert.rejects(() => report({ windowDays: 7 }), /rate limited/);
});

test('熔断发生在 cap 之前：表空也不能被高频灌满', async () => {
  const { services, stores } = makeCtx({ config: { rate_max_per_min: 5 } });
  const report = services['agint.diagnosis.report'];
  for (let i = 0; i < 5; i += 1) await report({ windowDays: 7 });
  await assert.rejects(() => report({ windowDays: 7 }), /rate limited/);
  assert.equal(stores.reports.size, 5, '被拒绝的调用不得落盘');
});
