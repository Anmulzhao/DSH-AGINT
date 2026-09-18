// 每日 LLM 预算测试（LLM 接入方案 §9、§10 第 4 行）。
//
// 这个文件锁的是「钱不能失控」这一条：
//   ① 达上限后不再放行，且**不报错**（静默回落轨道 B，由调用方留痕）
//   ② 跨本地日重置（用 UTC 日切会让东八区的晚上算错一天）
//   ③ 进程重启从审计恢复用量（否则重启 = 免费用量）
//   ④ 恢复失败时按 0 算 —— 读不到审计不等于把 LLM 全关
//   ⑤ limit=0 是一个额外的 kill-switch（配置旋钮即可关停）
//   ⑥ 退还是「调用其实没发生」的补救（服务不可用 / schema 自检失败等零成本早退）

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDailyBudget, localDayKey } from '../lib/llm-budget.js';

/** 可控时钟 + 可控恢复源 */
function harness({ limit = 3, restored = 0, day = '2026-09-18', loadThrows = false } = {}) {
  const state = { day, loadCalls: [] };
  const budget = createDailyBudget({
    limit,
    dayKey: () => state.day,
    loadUsed: async (d) => {
      state.loadCalls.push(d);
      if (loadThrows) throw new Error('audit storage unavailable');
      return typeof restored === 'function' ? restored(d) : restored;
    },
  });
  return { budget, state };
}

// ── ① 上限 ──────────────────────────────────────────────────────────────

test('上限内全部放行，第 limit+1 次起拒绝（且不抛）', async () => {
  const { budget } = harness({ limit: 3 });
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await budget.take(), { ok: true, firstRejection: false }, `第 ${i + 1} 次应放行`);
  }
  const denied = await budget.take();
  assert.equal(denied.ok, false);
  assert.equal(denied.firstRejection, true);
  assert.equal((await budget.snapshot()).used, 3, '被拒的调用不该计数');
});

test('「当天首次耗尽」只报一次，避免后续每轮都刷日志', async () => {
  const { budget } = harness({ limit: 1 });
  await budget.take();
  assert.equal((await budget.take()).firstRejection, true);
  assert.equal((await budget.take()).firstRejection, false);
  assert.equal((await budget.take()).firstRejection, false);
});

test('limit=0 → 立即全禁（配置层多一个 kill-switch）', async () => {
  const { budget } = harness({ limit: 0 });
  assert.equal((await budget.take()).ok, false);
  assert.equal((await budget.snapshot()).remaining, 0);
});

test('limit 传函数：运行时改配置立即生效，不必等下一日', async () => {
  let lim = 1;
  const budget = createDailyBudget({ limit: () => lim, dayKey: () => '2026-09-18' });
  await budget.take();
  assert.equal((await budget.take()).ok, false);
  lim = 5;                                  // 老板当场放宽
  assert.equal((await budget.take()).ok, true);
  assert.equal((await budget.snapshot()).limit, 5);
});

// ── ② 跨本地日重置 ──────────────────────────────────────────────────────

test('跨日重置：新的一天用量归零，且重新向恢复源查询', async () => {
  const { budget, state } = harness({ limit: 2 });
  await budget.take();
  await budget.take();
  assert.equal((await budget.take()).ok, false);

  state.day = '2026-09-19';
  assert.equal((await budget.take()).ok, true, '新的一天额度应恢复');
  assert.deepEqual(state.loadCalls, ['2026-09-18', '2026-09-19'], '每天只查一次');
  assert.deepEqual(await budget.snapshot(), { day: '2026-09-19', used: 1, limit: 2, remaining: 1 });
});

test('localDayKey 用**本地**日（构造于本地时刻 → 取本地年月日）', () => {
  assert.equal(localDayKey(new Date(2026, 0, 2, 0, 30)), '2026-01-02');
  assert.equal(localDayKey(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
  // 本地午夜两侧必须落到不同日键（UTC 日切在东八区会在这里出错）
  const before = localDayKey(new Date(2026, 8, 18, 23, 59));
  const after = localDayKey(new Date(2026, 8, 19, 0, 1));
  assert.notEqual(before, after);
  assert.equal(localDayKey(new Date('不是日期')), 'invalid', '非法输入不该抛');
});

// ── ③④ 恢复 ────────────────────────────────────────────────────────────

test('进程重启从审计恢复：恢复值已到上限 → 重启后第一次就拒绝', async () => {
  const { budget, state } = harness({ limit: 3, restored: 3 });
  assert.equal((await budget.take()).ok, false, '重启不该等于免费用量');
  assert.deepEqual(state.loadCalls, ['2026-09-18']);
});

test('部分用量的恢复：恢复 2、上限 3 → 只还能拿 1 次', async () => {
  const { budget } = harness({ limit: 3, restored: 2 });
  assert.equal((await budget.take()).ok, true);
  assert.equal((await budget.take()).ok, false);
});

test('恢复源抛错 → 按 0 算（读不到审计不等于把 LLM 全关）', async () => {
  const { budget } = harness({ limit: 2, loadThrows: true });
  assert.equal((await budget.take()).ok, true, '恢复失败必须放行，不是拒绝');
  assert.equal((await budget.snapshot()).used, 1);
});

test('恢复值是垃圾（非数字 / 负数）→ 不污染计数器', async () => {
  const bad = createDailyBudget({ limit: 2, dayKey: () => '2026-09-18', loadUsed: async () => 'nope' });
  assert.equal((await bad.snapshot()).used, 0);
  const neg = createDailyBudget({ limit: 2, dayKey: () => '2026-09-18', loadUsed: async () => -5 });
  assert.equal((await neg.snapshot()).used, 0);
});

// ── ⑥ 退还 ──────────────────────────────────────────────────────────────

test('refund 退还配额：实质未发生的调用不该吃掉预算', async () => {
  const { budget } = harness({ limit: 1 });
  await budget.take();
  assert.equal((await budget.take()).ok, false);
  await budget.refund();                    // 调用其实零成本早退
  assert.equal((await budget.take()).ok, true);
});

test('refund 在 0 用量的空账上不会把计数器压成负数', async () => {
  const { budget } = harness({ limit: 2 });
  await budget.refund();
  await budget.refund();
  assert.equal((await budget.snapshot()).used, 0);
  assert.equal((await budget.snapshot()).remaining, 2);
});

test('「耗尽」是**当日一次**的通知，不是每次拒绝都报（退还后再耗尽也不重复报）', async () => {
  const { budget } = harness({ limit: 1 });
  await budget.take();
  assert.equal((await budget.take()).firstRejection, true);
  await budget.refund();                    // 这一轮其实没花钱
  await budget.take();
  assert.equal((await budget.take()).firstRejection, false,
    '当天已经报过「额度耗尽」，再报只是刷日志；精确用量看 snapshot');
  // 但**新的一天**必须重新报，否则运维会以为额度从没耗过
  const next = harness({ limit: 1, day: '2026-09-19' });
  await next.budget.take();
  assert.equal((await next.budget.take()).firstRejection, true);
});

// ── snapshot 报告 ───────────────────────────────────────────────────────

test('snapshot 报告日键/已用/上限/剩余，剩余不为负', async () => {
  const { budget } = harness({ limit: 2 });
  assert.deepEqual(await budget.snapshot(), { day: '2026-09-18', used: 0, limit: 2, remaining: 2 });
  await budget.take();
  await budget.take();
  await budget.take();                      // 超发被拒
  assert.deepEqual(await budget.snapshot(), { day: '2026-09-18', used: 2, limit: 2, remaining: 0 });
});
