/**
 * agint-metrics — `inc()` 出口测试（2026-11-02）
 * Run: node --test plugins/agint-metrics/test/service-inc.test.mjs
 *
 * 守的是什么：
 *   `agint-event-bus` 的 busCtx.metrics 出口从 v0.7.0 起就写的是
 *   `if (m?.inc) return m.inc(key, delta)`，而 metrics 服务**从来没有 inc**。
 *   于是总线的全部计数（publishInvalid / handlerError / deliveryFailed / deadletter /
 *   hostBridge*）一直是**静默丢弃**的 —— 不报错、不落表、调用方零信号。
 *
 * 这个文件锁三件事：
 *   ① inc 真的存在（不是 undefined）；
 *   ② 它真的落一条表记录，且 value = 传入的 delta；
 *   ③ 非法输入返回 false 且不写脏数据（不能把 NaN 写进时间序列）。
 *
 * 阴性对照：把 service 里的 inc 删掉，① 立即红。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildMetricsService } from '../lib/service.js';

/** 内存表：模仿 storage domain 的 table 句柄 */
function makeTable() {
  const t = new Map();
  const handle = {
    put: async (id, value) => { t.set(id, value); return true; },
    get: (id) => t.get(id) ?? null,
    entries: () => [...t.values()],
    get size() { return t.size; },
  };
  const fn = async () => handle;
  fn.tbl = handle;
  return fn;
}

let seq = 0;
const randomId = () => `inc-${++seq}`;

function makeService() {
  const table = makeTable();
  const svc = buildMetricsService({
    ctx: { get: () => null },
    table,
    computeMetrics: async () => [],
    describeMetric: () => ({}),
    randomId,
  });
  return { svc, table };
}

test('① inc 必须存在（缺失 = 总线全部计数静默丢弃）', () => {
  const { svc } = makeService();
  assert.equal(
    typeof svc.inc,
    'function',
    'metrics 服务必须提供 inc(key, delta) —— agint-event-bus 的 busCtx.metrics 全靠它',
  );
});

test('② inc 落一条表记录，value 等于 delta', async () => {
  const { svc, table } = makeService();
  const ok = await svc.inc('eventBus.hostBridgeFailed', 3);
  assert.equal(ok, true);
  assert.equal(table.tbl.size, 1);
  const rec = table.tbl.entries()[0];
  assert.equal(rec.key, 'eventBus.hostBridgeFailed');
  assert.equal(rec.value, 3);
  assert.equal(rec.unit, 'count');
  assert.equal(JSON.parse(rec.meta).via, 'inc');
  assert.ok(rec.ts, '必须有时间戳，否则 series 无法排序');
});

test('② 默认 delta = 1（调用方只传 key 也能用）', async () => {
  const { svc, table } = makeService();
  await svc.inc('eventBus.hostDomainIgnored');
  assert.equal(table.tbl.entries()[0].value, 1);
});

test('③ 非法输入返回 false 且不写脏数据（NaN 进了时间序列就再也洗不掉）', async () => {
  const { svc, table } = makeService();
  assert.equal(await svc.inc('', 1), false, '空 key 不得写');
  assert.equal(await svc.inc(null, 1), false, 'null key 不得写');
  assert.equal(await svc.inc('k', 'abc'), false, '非数字 delta 不得写');
  assert.equal(await svc.inc('k', NaN), false, 'NaN 不得写');
  assert.equal(table.tbl.size, 0, '非法输入一条都不许落表');
});

test('可累加：同一 key 多次 inc 产生多条记录（series 求和即总数）', async () => {
  const { svc, table } = makeService();
  await svc.inc('k', 2);
  await svc.inc('k', 5);
  assert.equal(table.tbl.size, 2);
  const sum = table.tbl.entries().filter((r) => r.key === 'k').reduce((a, r) => a + r.value, 0);
  assert.equal(sum, 7);
});
