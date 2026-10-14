// 回归用例：detectToolAnomaly 的「连续失败」检测被 break 截断。
//
// 取证（2026-10-14 实测生产存储 agint_tool_stats.jsonl，16822 行）：
//   最近 200 条里 pwsh 有连续 16 次 ok===false（阈值 ≥3，该报）。
//   但 self-observation 的 detectToolAnomaly 产出空 —— channel.health()
//   显示 5 个检测器全 active=true，fetch() 返回 []，看起来健康实则漏检。
// 根因（lib/channels/self-observation.js:113-115 修复前）：
//   从后往前扫时写了 `else { break; }` —— 一旦遇到末尾第一条成功的记录
//   就整个退出循环。真实数据末尾那条是成功的 ⇒ count 恒为 0 ⇒ 永不报警。
//   「连续失败」的语义应是「窗口内同一 tool 的最长失败游程」，
//   不是「文件末尾的失败游程」。
//
// ⛔ 纪律（Playbook §3.5 / §3.29）：先取证真实存储再写码。真实 schema 是
//   boolean `ok`，失败标记是 `ok === false`。
// ⛔ 纪律（§3.5）：不写占位断言。本文件全走 channel.fetch() 端到端，
//   真读临时 storages、真产出信号对象，断言 signalType / payload.detection。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { selfObservationChannel } = await import('../lib/channels/self-observation.js');

function rec(tool, ok) {
  return {
    ts: Date.now(),
    sessionId: 'session-test',
    turn: 1,
    step: 1,
    tool,
    callId: `call-${Math.random().toString(36).slice(2, 10)}`,
    latencyMs: 10,
    ok,
    errorKind: ok ? null : 'exit_nonzero',
  };
}

const tmpRoots = [];

/** 造一个假 DSH_HOME，把 records 写进 storages/agint_tool_stats.jsonl，返回 fetch 结果。 */
async function fetchWith(records) {
  const dir = mkdtempSync(join(tmpdir(), 'agint-gw-home-'));
  tmpRoots.push(dir);
  const storages = join(dir, 'storages');
  mkdirSync(storages, { recursive: true });
  writeFileSync(
    join(storages, 'agint_tool_stats.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8',
  );
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    return await selfObservationChannel.fetch({});
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
}

test.after(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

test('取证：fetch() 返回数组，channel.health() 报 5 个检测器全 active', async () => {
  const r = await fetchWith(Array.from({ length: 30 }, () => rec('read', true)));
  assert.ok(Array.isArray(r), 'fetch() 必须返回数组');
  const h = await selfObservationChannel.health();
  assert.equal(h.subSources, 5, `子源数应为 5，实得 ${h.subSources}`);
  const actives = Object.values(h.detectors).filter((d) => d.active !== false).length;
  assert.equal(actives, 5, `5 个检测器应全 active，实得 ${actives}`);
});

test('⛔ 修复后：中间段的连续失败必须被检出（末尾是成功也不漏）', async () => {
  const records = [];
  for (let i = 0; i < 20; i++) records.push(rec('read', true));
  for (let i = 0; i < 5; i++) records.push(rec('pwsh', false));   // 中间连续 5 次失败
  for (let i = 0; i < 10; i++) records.push(rec('read', true));   // 末尾成功 ⇒ 旧版在这里 break
  const signals = await fetchWith(records);

  const streak = signals.find(
    (s) => s.signalType === 'tool.anomaly' && s.payload?.detection === 'consecutive_failures',
  );
  assert.ok(
    streak,
    `末尾成功时，中间段连续 5 次失败仍须检出。实得 ${signals.length} 条信号：` +
      JSON.stringify(signals.map((s) => s.signalType + '/' + (s.payload?.detection ?? '?'))),
  );
  assert.equal(streak.payload.tool, 'pwsh');
  assert.ok(streak.payload.consecutiveFailures >= 5,
    `连续失败数应 ≥5，实得 ${streak.payload.consecutiveFailures}`);
});

test('安全不回退：全成功数据不得产出 tool.anomaly（防「永远有信号」）', async () => {
  const signals = await fetchWith(Array.from({ length: 60 }, () => rec('read', true)));
  const anomaly = signals.filter((s) => s.signalType === 'tool.anomaly');
  assert.equal(anomaly.length, 0,
    `全成功场景不得产出 tool.anomaly，实得 ${anomaly.length} 条`);
});

test('安全不回退：孤立失败（连续 1 次）不触发 streak 阈值 3', async () => {
  const records = [];
  for (let i = 0; i < 30; i++) records.push(rec('read', true));
  records.push(rec('pwsh', false));                                // 孤立 1 次
  for (let i = 0; i < 30; i++) records.push(rec('read', true));
  const signals = await fetchWith(records);

  const streak = signals.find((s) => s.payload?.detection === 'consecutive_failures');
  assert.equal(streak, undefined,
    `连续 1 次不得触发阈值 3，实得 ${JSON.stringify(streak?.payload ?? null)}`);
});

test('样本不足（<20 条）不产信号，不是产 0 分信号', async () => {
  const signals = await fetchWith(Array.from({ length: 10 }, () => rec('pwsh', false)));
  const anomaly = signals.filter((s) => s.signalType === 'tool.anomaly');
  assert.equal(anomaly.length, 0, '样本 <20 条应整条跳过，不得产出低置信信号');
});
