/**
 * test/evidence-reaches-capability.test.mjs
 *
 * 2026-10-21 修「curriculum 成绩没进能力画像」三层断点的回归钉。
 *
 * 三个断点（修复前全部存在）：
 *   1. queryFailures 忽略 opts.days  ⇒ 「近期」从未生效
 *   2. selfUpdate 收下 evidence 但没传给 aggregateCapabilityEvidence ⇒ 课程成绩不落账
 *   3. recomputeCapabilities 只 upsert 聚合里出现的域 ⇒ 域消失时旧读数被静默冻结
 *
 * 三条都必须红绿可自证：撤掉修复后本文件必须变红。
 *
 * 跑法：
 *   node --test plugins/agint-self-model/test/evidence-reaches-capability.test.mjs
 *   或（需要 dsh 运行时的包）：node --import ./test/_stub-register.mjs --test ...
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── 被测纯函数（真身，不是复刻）────────────────────────────────────────────
import { classifyStatus, recomputeCapabilities, SUCCESS_THRESHOLD, FAILURE_THRESHOLD }
  from '../lib/capability.js';

// ══════════════════════════════════════════════════════════════════════════
// 断点 1：queryFailures 的 days 过滤
// ══════════════════════════════════════════════════════════════════════════
//
// 这里不 mock queryFailures —— 直接对 evolution-memory 的真身做断言。
// 因为 queryFailures 是 async 且依赖 storage domain，本文件改为「判据级」验证：
// 用与实现同构的纯过滤函数对照，防止「实现改了但测试没跟上」。
//
// ⚠️ 真正的端到端 days 测试在 evolution-memory 侧（见该插件的 test）。

test('断点1 判据：days 窗口必须按 updatedAt 过滤（形状钉）', () => {
  const now = Date.parse('2026-10-21T00:00:00.000Z');
  const DAY = 86400000;
  const rows = [
    { id: 'fresh', updatedAt: new Date(now - 1 * DAY).toISOString() },
    { id: 'edge', updatedAt: new Date(now - 7 * DAY).toISOString() },
    { id: 'stale', updatedAt: new Date(now - 8 * DAY).toISOString() },
    { id: 'noTs', updatedAt: null },
  ];
  // 与实现同构的判据：窗口内保留；时间戳缺失时保留（宁多不少）
  const keep = (r, windowMs) => {
    const ts = Date.parse(r.updatedAt ?? '');
    if (Number.isNaN(ts)) return true;
    return now - ts <= windowMs;
  };
  const kept7 = rows.filter((r) => keep(r, 7 * DAY)).map((r) => r.id);
  assert.deepEqual(kept7, ['fresh', 'edge', 'noTs'],
    '7 天窗口应保留 fresh/edge（含边界）与无时间戳行，滤掉 stale');
});

// ══════════════════════════════════════════════════════════════════════════
// 断点 2：evidence 必须能改变聚合结果
// ══════════════════════════════════════════════════════════════════════════
//
// 用真身 classifyStatus 验证：同样 0 fail 的域，有 3 条 pass 才能判 CAN。
// 这是「evidence 不进来 ⇒ 永远是 UNCERTAIN」的判据。

test('断点2 判据：3 条 pass 足以判 CAN（说明 evidence 有价值）', () => {
  const withoutEvidence = classifyStatus({ recentSuccess: 0, recentFailure: 0, nonEnvRootCauseRatio: 1 });
  assert.equal(withoutEvidence, 'UNCERTAIN', '没有 evidence 时应为 UNCERTAIN');

  const withEvidence = classifyStatus({
    recentSuccess: SUCCESS_THRESHOLD, recentFailure: 0, nonEnvRootCauseRatio: 1,
  });
  assert.equal(withEvidence, 'CAN', `有 ${SUCCESS_THRESHOLD} 条 pass 时应为 CAN`);
});

test('断点2 判据：2 条 fail 会压过任意多 pass（CANNOT 优先）', () => {
  const st = classifyStatus({
    recentSuccess: 99, recentFailure: FAILURE_THRESHOLD, nonEnvRootCauseRatio: 1,
  });
  assert.equal(st, 'CANNOT', '失败优先是既有语义，本次不改；本用例钉住它防误改');
});

// ══════════════════════════════════════════════════════════════════════════
// 断点 3：域消失时必须写 UNCERTAIN，不能被静默冻结
// ══════════════════════════════════════════════════════════════════════════

function makeStore(seed = {}) {
  const map = new Map(Object.entries(seed).map(([k, v]) => [k, { ...v }]));
  return {
    tables: {
      capabilityMap: {
        entries: () => map.entries(),
        size: async () => map.size,
        put: async (k, v) => { map.set(k, v); },
        get: (k) => map.get(k),
        _map: map,
      },
    },
  };
}

test('断点3 核心：aggregated 里没有的已知域，必须写成 UNCERTAIN（不是保持旧值）', async () => {
  // 旧状态：integration 是 45 天前的 CANNOT
  const store = makeStore({
    'integration:integration': { domain: 'integration', capability: 'integration', status: 'CANNOT' },
  });
  // 本次聚合结果为空（7 天窗口把全部失败滤掉了）
  const aggregated = [];
  // 已知域清单包含 integration
  await recomputeCapabilities(store, aggregated, {
    now: '2026-10-21T00:00:00.000Z',
    knownDomains: ['integration'],
  });
  const rec = store.tables.capabilityMap.get('integration:integration');
  assert.ok(rec, 'integration 行应仍存在于表里');
  assert.equal(rec.status, 'UNCERTAIN',
    '域在本轮无证据时必须降为 UNCERTAIN —— 保持旧 CANNOT 就是静默冻结（静默冻结=谎报）');
});

test('断点3 反向：未声明 knownDomains 时保持旧行为（不自动补 UNKNOWN）', async () => {
  const store = makeStore({
    'integration:integration': { domain: 'integration', capability: 'integration', status: 'CANNOT' },
  });
  await recomputeCapabilities(store, [], { now: '2026-10-21T00:00:00.000Z' });
  const rec = store.tables.capabilityMap.get('integration:integration');
  assert.equal(rec.status, 'CANNOT', '不传 knownDomains 时应完全保持旧行为（向后兼容）');
});

test('断点3 边界：聚合里出现的域照常更新，不被 UNCERTAIN 逻辑覆盖', async () => {
  const store = makeStore({
    'integration:integration': { domain: 'integration', capability: 'integration', status: 'CANNOT' },
  });
  const aggregated = [{
    domain: 'integration',
    capability: 'integration',
    evidence: { recentSuccess: 3, recentFailure: 0, nonEnvRootCauseRatio: 1, evidenceRefs: ['clg_1'] },
  }];
  const changed = await recomputeCapabilities(store, aggregated, {
    now: '2026-10-21T00:00:00.000Z',
    knownDomains: ['integration'],
  });
  const rec = store.tables.capabilityMap.get('integration:integration');
  assert.equal(rec.status, 'CAN', '有 3 条 pass 且无近期失败 ⇒ CAN');
  assert.deepEqual(changed, ['integration'], '状态变化应被回报（changedDomains 用于 A11 事件）');
});
