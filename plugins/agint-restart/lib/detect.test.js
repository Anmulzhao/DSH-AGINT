/**
 * agint-restart — pure-function unit tests
 * 来源：nickkkkkk123123/dsh-resume-on-restart/lib/detect.test.js（逐字 1:1）
 *
 * 注意：沙箱 PowerShell 里 `node --test` spawn 子进程报 EPERM（沙箱边界），
 *       所以这份文件**不被直接跑**——同样的测试并入 test/smoke.mjs（用 import test 形式）。
 *       本文件保留作为契约层 + 独立可读单元参考。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNotice, detectRestart, humanizeDowntime, shouldNotify } from './detect.js';

test('detectRestart: no marker -> not a restart', () => {
  assert.deepEqual(detectRestart(null, 1000, 42), { wasRestart: false, downtimeMs: 0 });
});

test('detectRestart: same pid -> not a restart', () => {
  const marker = { lastBootAt: '2026-08-28T00:00:00.000Z', pid: 42 };
  assert.deepEqual(detectRestart(marker, 1000, 42), { wasRestart: false, downtimeMs: 0 });
});

test('detectRestart: different pid -> restart with downtime', () => {
  const marker = { lastBootAt: '2026-08-28T00:00:00.000Z', pid: 42 };
  const now = Date.parse('2026-08-28T00:00:05.000Z');
  assert.deepEqual(detectRestart(marker, now, 99), { wasRestart: true, downtimeMs: 5000 });
});

test('detectRestart: corrupt marker (missing pid) -> not a restart', () => {
  assert.deepEqual(detectRestart({ lastBootAt: 'x' }, 1000, 1), { wasRestart: false, downtimeMs: 0 });
});

test('buildNotice: 纯状态陈述，无行动指令（v0.7.1 断环）', () => {
  const base = {
    bootAt: '2026-08-28T00:00:05.000Z',
    prevBootAt: '2026-08-28T00:00:00.000Z',
    downtimeMs: 5000,
    lastSessionId: 'session-abc',
    lastActiveAt: '2026-08-28T00:00:00.000Z',
  };
  const text = buildNotice(base);
  assert.equal(text, '[agint-restart] DSH 已重启。');
  assert.ok(!text.includes('自主决定下一步'), 'v0.7.1：不得含行动指令');
  assert.ok(!text.includes('不需要再次重启'), 'v0.7.1：不得含指令性断环说明');
  assert.ok(!text.includes('中断约') && !text.includes('session-abc'), '细节不进消息体');
  assert.equal(buildNotice({ ...base, selfRestart: true }), text, '自触发与外部重启文案必须一致');
});

test('buildNotice: no downtime or session -> omits those lines', () => {
  const text = buildNotice({ bootAt: '2026-08-28T00:00:00.000Z', prevBootAt: null, downtimeMs: 0 });
  assert.ok(!text.includes('中断约'));
  assert.ok(!text.includes('最近活跃的会话'));
});

test('humanizeDowntime: formats seconds, minutes and hours', () => {
  assert.equal(humanizeDowntime(5000), '5 秒');
  assert.equal(humanizeDowntime(65000), '1 分 5 秒');
  assert.equal(humanizeDowntime(3900000), '1 小时 5 分');
});

// v0.4.0: shouldNotify — 抖动窗口判定
test('shouldNotify: wasRestart=false 时不投（不论窗口多大）', () => {
  assert.deepEqual(shouldNotify({ wasRestart: false, downtimeMs: 5_000_000 }, 60_000), { debounced: false, reason: null });
});

test('shouldNotify: downtime < 窗口 → 抖动，debounced=true', () => {
  assert.deepEqual(shouldNotify({ wasRestart: true, downtimeMs: 5_000 }, 60_000), { debounced: true, reason: 'within-debounce' });
  // 边界：恰好等于窗口不算抖动（< 不是 <=）
  assert.deepEqual(shouldNotify({ wasRestart: true, downtimeMs: 60_000 }, 60_000), { debounced: false, reason: null });
});

test('shouldNotify: downtime >= 窗口 → 真重启，照常投', () => {
  assert.deepEqual(shouldNotify({ wasRestart: true, downtimeMs: 120_000 }, 60_000), { debounced: false, reason: null });
  assert.deepEqual(shouldNotify({ wasRestart: true, downtimeMs: 30 * 60_000 }, 60_000), { debounced: false, reason: null });
});

test('shouldNotify: 窗口 <=0 视为关闭（不抖）', () => {
  assert.deepEqual(shouldNotify({ wasRestart: true, downtimeMs: 100 }, 0), { debounced: false, reason: null });
  assert.deepEqual(shouldNotify({ wasRestart: true, downtimeMs: 100 }, -1), { debounced: false, reason: null });
});

test('shouldNotify: 窗口非有限值（NaN/Infinity）视为关闭', () => {
  assert.deepEqual(shouldNotify({ wasRestart: true, downtimeMs: 100 }, NaN), { debounced: false, reason: null });
  assert.deepEqual(shouldNotify({ wasRestart: true, downtimeMs: 100 }, Infinity), { debounced: false, reason: null });
});
