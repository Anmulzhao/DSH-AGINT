/**
 * agint-dream: 零命中告警回归（2026-09-18）。
 *
 * 背景：宿主 2026-09-10 起改会话日志命名，Light 通道连续 7 天扫到 0 个会话，
 * 而 `dream_status` 仍报 validation=OK —— **"没扫到东西"和"扫到了但没过关"
 * 在返回里长得一模一样**。命名问题 09-17 已修，但"零命中不告警"这个洞还在：
 * 下次再换一种失效方式（路径改了、权限没了、zstd 没了）照样静默。
 *
 * 本文件固定：连续 N 次零命中 → health.status=degraded，且状态跨 sweep 持久化。
 *
 * 设计取舍（K51 可回滚 > 可审批，自进化默认）：
 *   - 判据是**纯规则**（连续计数 ≥ 阈值），机器可判、可回放，不引入人工环节；
 *   - **不阻断** sweep（观察层，可观测优先于可审批），只标记 + 落 diary + warn；
 *   - 带 kill-switch（`zeroHitAlert`）与可调阈值（`zeroHitAlertThreshold`）；
 *   - 状态落盘而非内存 —— 否则每次进程重启计数归零，告警永远等不到。
 *
 * Run with: node --test test/zero-hit-health.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSweep } from '../lib/sweep.js';
import {
  updateZeroHitState,
  evaluateZeroHitHealth,
  readHealthState,
  HEALTH_STATE_FILE,
} from '../lib/health.js';

const NOW = Date.parse('2026-09-18T10:00:00.000Z');
const ISO = new Date(NOW).toISOString();

function fakeMemory() {
  const store = new Map();
  return {
    list: async () => [...store.values()],
    write: async (input) => {
      const id = input.id ?? `mem-${store.size + 1}`;
      const rec = { ...input, id };
      store.set(id, rec);
      return { ...rec };
    },
  };
}

/** 空 sessionsRoot = 必然零命中 */
async function makeEmptyFixture() {
  const root = await mkdtemp(join(tmpdir(), 'agint-dream-zh-'));
  const sessionsRoot = join(root, 'sessions');
  const diaryRoot = join(root, 'diary');
  const recallPath = join(root, 'recall.jsonl');
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(diaryRoot, { recursive: true });
  return { root, sessionsRoot, diaryRoot, recallPath };
}

function sweepOnce(fx, extra = {}) {
  return runSweep({
    sessionsRoot: fx.sessionsRoot,
    diaryRoot: fx.diaryRoot,
    memory: fakeMemory(),
    recallPath: fx.recallPath,
    nowMs: NOW,
    apply: false,
    qualityEval: false,
    evolution: false,
    ...extra,
  });
}

// ── 纯函数层 ──────────────────────────────────────────────────────────────

test('updateZeroHitState: 连续零命中累加', () => {
  let s = { consecutiveZeroHit: 0, totalSweeps: 0, totalZeroHits: 0 };
  for (let i = 1; i <= 3; i += 1) {
    s = updateZeroHitState(s, { hit: false, nowIso: ISO });
    assert.equal(s.consecutiveZeroHit, i);
  }
  assert.equal(s.totalSweeps, 3);
  assert.equal(s.totalZeroHits, 3);
  assert.equal(s.lastZeroHitAt, ISO);
  assert.equal(s.lastNonZeroAt, null, '从未命中过 → null，不编造时间戳');
});

test('updateZeroHitState: 命中一次即归零，并记录最后命中时间', () => {
  let s = { consecutiveZeroHit: 5, totalSweeps: 5, totalZeroHits: 5, lastZeroHitAt: ISO };
  s = updateZeroHitState(s, { hit: true, nowIso: ISO });
  assert.equal(s.consecutiveZeroHit, 0, '命中后连续计数必须归零');
  assert.equal(s.lastNonZeroAt, ISO);
  assert.equal(s.totalZeroHits, 5, '累计零命中次数是历史账，不因恢复而抹掉');
});

test('updateZeroHitState: 首次状态（undefined）也能建起来', () => {
  const s = updateZeroHitState(undefined, { hit: false, nowIso: ISO });
  assert.equal(s.consecutiveZeroHit, 1);
  assert.equal(s.totalSweeps, 1);
});

test('evaluateZeroHitHealth: 阈值边界（2 次 ok / 3 次 degraded）', () => {
  const at = (n) => evaluateZeroHitHealth({ consecutiveZeroHit: n }, { threshold: 3 });
  assert.equal(at(0).status, 'ok');
  assert.equal(at(2).status, 'ok', '未达阈值不得告警');
  assert.equal(at(3).status, 'degraded', '达到阈值必须告警');
  assert.equal(at(9).status, 'degraded');
});

test('evaluateZeroHitHealth: kill-switch 关闭时恒 ok（判定函数不是空转）', () => {
  // 反例：证明 status 是被 enabled 真正影响的，而不是因为函数坏了才返回 ok
  const r = evaluateZeroHitHealth({ consecutiveZeroHit: 99 }, { threshold: 3, enabled: false });
  assert.equal(r.status, 'ok');
  const on = evaluateZeroHitHealth({ consecutiveZeroHit: 99 }, { threshold: 3, enabled: true });
  assert.equal(on.status, 'degraded');
});

test('evaluateZeroHitHealth: 阈值可配（配 1 则首次零命中即告警）', () => {
  assert.equal(evaluateZeroHitHealth({ consecutiveZeroHit: 1 }, { threshold: 1 }).status, 'degraded');
  assert.equal(evaluateZeroHitHealth({ consecutiveZeroHit: 1 }, { threshold: 5 }).status, 'ok');
});

// ── 集成层 ────────────────────────────────────────────────────────────────

test('runSweep: 单次零命中返回 health.ok，但计数已记为 1', async () => {
  const fx = await makeEmptyFixture();
  try {
    const r = await sweepOnce(fx);
    assert.equal(r.counts.sessions, 0, '空 sessionsRoot 必然扫到 0 个会话');
    assert.equal(r.health.consecutiveZeroHit, 1);
    assert.equal(r.health.status, 'ok', '首次不该告警 —— 可能只是这两天没活动');
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test('runSweep: 连续 3 次零命中 → degraded（状态跨 sweep 持久化）', async () => {
  const fx = await makeEmptyFixture();
  try {
    const r1 = await sweepOnce(fx);
    assert.equal(r1.health.consecutiveZeroHit, 1);
    assert.equal(r1.health.status, 'ok');

    const r2 = await sweepOnce(fx);
    assert.equal(r2.health.consecutiveZeroHit, 2, '第 2 次必须读到上次的状态（持久化生效）');
    assert.equal(r2.health.status, 'ok');

    const r3 = await sweepOnce(fx);
    assert.equal(r3.health.consecutiveZeroHit, 3);
    assert.equal(r3.health.status, 'degraded', '第 3 次必须告警');
    assert.match(String(r3.health.reason), /零命中|zero/i);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test('runSweep: 状态真的落到 diary 盘上（不是内存计数）', async () => {
  const fx = await makeEmptyFixture();
  try {
    await sweepOnce(fx);
    await sweepOnce(fx);
    const onDisk = await readHealthState(fx.diaryRoot);
    assert.equal(onDisk.consecutiveZeroHit, 2, '重读磁盘应得到 2');
    const raw = JSON.parse(await readFile(join(fx.diaryRoot, HEALTH_STATE_FILE), 'utf8'));
    assert.equal(raw.consecutiveZeroHit, 2);
    assert.equal(raw.totalSweeps, 2);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test('runSweep: kill-switch 关掉后不告警（回滚通道）', async () => {
  const fx = await makeEmptyFixture();
  try {
    const opts = { zeroHitAlert: false };
    await sweepOnce(fx, opts);
    await sweepOnce(fx, opts);
    const r3 = await sweepOnce(fx, opts);
    assert.equal(r3.health.consecutiveZeroHit, 3, '计数照记（可观测性不丢）');
    assert.equal(r3.health.status, 'ok', '告警被 kill-switch 关掉了');
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test('runSweep: 阈值可配（配 2 则第 2 次即告警）', async () => {
  const fx = await makeEmptyFixture();
  try {
    const opts = { zeroHitAlertThreshold: 2 };
    const r1 = await sweepOnce(fx, opts);
    assert.equal(r1.health.status, 'ok');
    const r2 = await sweepOnce(fx, opts);
    assert.equal(r2.health.status, 'degraded');
    assert.equal(r2.health.threshold, 2);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test('readHealthState: 文件不存在/损坏 → 返回初始态而非抛错（fail-open）', async () => {
  const fx = await makeEmptyFixture();
  try {
    const s = await readHealthState(fx.diaryRoot);
    assert.equal(s.consecutiveZeroHit, 0);
    assert.equal(s.totalSweeps, 0);
    // 写坏文件
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(fx.diaryRoot, HEALTH_STATE_FILE), '{ not json', 'utf8');
    const s2 = await readHealthState(fx.diaryRoot);
    assert.equal(s2.consecutiveZeroHit, 0, '损坏时退回初始态，绝不让告警链路自己把 sweep 搞挂');
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});
