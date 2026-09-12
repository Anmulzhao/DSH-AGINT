/**
 * agint-trajectory payload 单测：归一化 / 摘要 / 用量聚合 / 截断（§3.2、§7bis.2）。
 *
 * 关键断言：截断**保头 + 保尾**（v0.3 Hermes 反衬结论——砍掉轨迹尾巴 = 砍掉
 * 最终输出与结局，是训练数据最不该丢的部分）+ truncated/droppedSteps 必留痕。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSteps, aggregateUsage, enrichUsageFromToolStats, truncatePayload, estimateBytes,
} from '../lib/payload.js';
import { DEFAULTS } from '../lib/schema.js';

const mkStep = (seq, content, extra = {}) => ({ seq, role: 'observation', content, ...extra });

test('归一化：补 seq、非法 role 降级为 observation（不丢内容）', () => {
  const out = normalizeSteps([{ content: 'a' }, { role: 'weird', content: 'b' }, { role: 'gpt', content: 'c' }]);
  assert.deepEqual(out.map((s) => s.seq), [0, 1, 2]);
  assert.equal(out[1].role, 'observation');
  assert.equal(out[2].role, 'gpt');
});

test('observation 轮只存结果摘要（≤200 字符），不复存参数正文（§3.2 / §8bis）', () => {
  const long = 'x'.repeat(500);
  const out = normalizeSteps([{ role: 'observation', content: long }, { role: 'human', content: long }]);
  assert.ok(out[0].content.length <= DEFAULTS.OBSERVATION_SUMMARY_CHARS + 1);
  assert.ok(out[0].content.endsWith('…'));
  assert.equal(out[1].content.length, 500, 'human 轮不截断（非工具结果）');
});

test('aggregateUsage：按工具聚合 count/ok/fail（v0.3 工具级成败）', () => {
  const steps = [
    mkStep(0, 'a', { tool: 'bash', toolOk: true }),
    mkStep(1, 'b', { tool: 'bash', toolOk: false }),
    mkStep(2, 'c', { tool: 'skill', toolOk: true }),
    mkStep(3, 'd'),
  ];
  const u = aggregateUsage(steps);
  assert.equal(u.toolCalls, 3);
  assert.deepEqual(u.toolStats.bash, { count: 2, ok: 1, fail: 1 });
  assert.deepEqual(u.toolStats.skill, { count: 1, ok: 1, fail: 0 });
  assert.equal(aggregateUsage([]).toolStats, null);
});

test('enrichUsageFromToolStats：按 callId 离线补 toolStats / errorKinds', () => {
  const records = [
    { callId: 'c1', tool: 'bash', ok: true, errorKind: null },
    { callId: 'c2', tool: 'bash', ok: false, errorKind: 'timeout' },
    { callId: 'c9', tool: 'nope', ok: false, errorKind: 'boom' },
  ];
  const u = enrichUsageFromToolStats({ toolCalls: 0 }, records, new Set(['c1', 'c2']));
  assert.deepEqual(u.toolStats.bash, { count: 2, ok: 1, fail: 1 });
  assert.deepEqual(u.errorKinds, { timeout: 1 });
  assert.equal(u.toolCalls, 2);
  // 无 records → 原样返回（不编造）
  assert.deepEqual(enrichUsageFromToolStats({ toolCalls: 3 }, [], null).toolStats, null);
});

test('未超限：不截断且 truncated=false（不变量 #2：禁止静默截断）', () => {
  const steps = [mkStep(0, 'a'.repeat(100)), mkStep(1, 'b'.repeat(100))];
  const r = truncatePayload({ steps, final: { ok: true } }, 64 * 1024);
  assert.equal(r.truncated, false);
  assert.equal(r.droppedSteps, 0);
  assert.equal(r.payload.steps.length, 2);
});

test('超限：保头 + 保尾丢中段，truncated=true + droppedSteps 留痕', () => {
  const steps = Array.from({ length: 20 }, (_, i) => mkStep(i, 'x'.repeat(1000)));
  const max = 6000; // 约容纳 5~6 步
  const r = truncatePayload({ steps }, max);
  assert.equal(r.truncated, true);
  assert.ok(r.droppedSteps > 0);
  const kept = r.payload.steps.map((s) => s.seq);
  assert.equal(kept[0], 0, '保头');
  assert.equal(kept[kept.length - 1], 19, '保尾（结局优先）');
  assert.ok(r.bytes <= max + estimateBytes(null), `落盘字节 ${r.bytes} 应 ≈ 上限 ${max}`);
  assert.equal(r.payload.droppedSteps, r.droppedSteps);
});

test('极端：final 已超预算时 steps 全丢但仍保住 final（结局不丢）', () => {
  const steps = [mkStep(0, 'x'.repeat(100))];
  const r = truncatePayload({ steps, final: { big: 'y'.repeat(5000) } }, 1000);
  assert.equal(r.truncated, true);
  assert.equal(r.payload.steps.length, 0);
  assert.ok(r.payload.final.big.length === 5000);
});

test('estimateBytes 与 JSON.stringify 一致（UTF-8）', () => {
  assert.equal(estimateBytes({ a: '中' }), Buffer.byteLength(JSON.stringify({ a: '中' }), 'utf8'));
  assert.equal(estimateBytes(null), 0);
  assert.equal(estimateBytes(undefined), 0);
});
