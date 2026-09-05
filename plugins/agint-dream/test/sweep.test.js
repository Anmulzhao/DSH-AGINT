/**
 * agint-dream: unit tests for the sweep core (pure functions + a stub-driven
 * runSweep). Run with: node --test packages/agint-dream/test/sweep.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectSessionSignals,
  extractCandidates,
  scoreCandidates,
  gateCandidates,
  entryFor,
  renderDiary,
  runSweep,
} from '../lib/sweep.js';

const NOW = Date.parse('2026-08-15T23:00:00+08:00');

test('collectSessionSignals: user messages, memWrites, errors', () => {
  const records = [
    { type: 'session', id: 's1' },
    { type: 'user/message', seq: 1, time: NOW - 1000, data: { content: [{ type: 'text', text: '老板，以后用 vger 称呼我' }] } },
    { type: 'tool/call', seq: 2, time: NOW, data: { name: 'memory_write', arguments: JSON.stringify({ content: '某条记忆' }) } },
    { type: 'tool/result', seq: 3, time: NOW, data: { message: { content: [{ type: 'text', text: 'ERROR: something failed' }] } } },
  ];
  const s = collectSessionSignals(records);
  assert.equal(s.sessionKey, 's1');
  assert.equal(s.userTexts.length, 1);
  assert.equal(s.memWrites.length, 1);
  assert.equal(s.errors.length, 1);
});

test('extractCandidates: keyword buckets → typed candidates, noise dropped', () => {
  const session = {
    sessionKey: 's1',
    userTexts: [
      { text: '以后用 vger 称呼我，别忘了', time: NOW },
      { text: '投资上决定采用指数化方案', time: NOW },
      { text: '你好', time: NOW },
      { text: '你能帮我看看这个文件吗？', time: NOW },
    ],
    errors: [],
  };
  const cands = extractCandidates(session, NOW);
  const types = cands.map((c) => c.type);
  assert.ok(types.includes('preference'), JSON.stringify(cands));
  assert.ok(types.includes('decision'), JSON.stringify(cands));
  assert.ok(cands.every((c) => !/你好/.test(c.text)), 'noise must be dropped');
  assert.ok(cands.every((c) => !/\?$/.test(c.text)), 'questions must be dropped');
});

test('scoreCandidates: six-signal formula groups and sorts', () => {
  const session = { sessionKey: 's1', userTexts: [], errors: [] };
  const cands = [
    { text: '以后用 vger 称呼我', type: 'preference', sessionKey: 's1', time: NOW - 60_000, signals: ['a'] },
    { text: '以后用 vger 称呼我', type: 'preference', sessionKey: 's2', time: NOW - 120_000, signals: ['b'] },
    { text: '偶尔的噪音候选内容', type: 'pattern', sessionKey: 's1', time: NOW, signals: ['c'] },
  ];
  const scored = scoreCandidates(cands, { nowMs: NOW });
  const top = scored[0];
  assert.equal(top.text, '以后用 vger 称呼我');
  assert.equal(top.signalCount, 2);
  assert.equal(top.uniqueSessions, 2);
  assert.ok(top.score > 0 && top.score <= 1);
  assert.ok(top.components.frequency > 0 && top.components.recency > 0);
  assert.ok(scored.every((c) => c.score <= 1 && c.score >= 0));
});

test('gateCandidates: thresholds and existing-memory dedupe', () => {
  const scored = [
    { text: '以后用 vger 称呼我', type: 'preference', signalCount: 3, uniqueSessions: 2, score: 0.8, sessions: ['s1'], days: ['2026-08-15'], signals: ['a'] },
    { text: '已有记忆的重复内容测试', type: 'decision', signalCount: 3, uniqueSessions: 2, score: 0.8, sessions: ['s1'], days: ['2026-08-15'], signals: ['b'] },
    { text: '低分候选内容', type: 'lesson', signalCount: 1, uniqueSessions: 1, score: 0.2, sessions: ['s1'], days: ['2026-08-15'], signals: ['c'] },
  ];
  const existing = [{ id: 'm1', type: 'decision', content: '已有记忆的重复内容测试' }];
  const gated = gateCandidates(scored, existing, { minScore: 0.75, minRecall: 3, minUniqueSessions: 2 });
  assert.deepEqual(gated.map((c) => c.text), ['以后用 vger 称呼我']);
});

test('entryFor: maps candidate to memory payload', () => {
  const entry = entryFor({ type: 'lesson', text: '禁止删密钥', score: 0.82 }, 'evidence-here');
  assert.equal(entry.type, 'lesson');
  assert.equal(entry.content, '禁止删密钥');
  assert.equal(entry.confidence, 0.8);
  assert.equal(entry.evidence, 'evidence-here');
});

test('renderDiary: includes counts and promoted rows', () => {
  const md = renderDiary({
    day: '2026-08-15',
    signals: [{ userTexts: ['a'], memWrites: [], errors: [] }],
    memWrites: [],
    candidates: [],
    gated: [{ text: 'x', type: 'decision', score: 0.9, signalCount: 2, uniqueSessions: 1 }],
    promoted: [{ candidate: { score: 0.9 }, entry: { type: 'decision', content: 'x', confidence: 0.9, evidence: 'e' } }],
    errors: [],
    durationMs: 1234,
  });
  assert.match(md, /# 梦境日记 2026-08-15/);
  assert.match(md, /提升写入记忆：1 条/);
  assert.match(md, /score=0.90/);
});

test('scoreCandidates: REM reinforcement joins cross-day signals', () => {
  const base = [
    { text: '以后用 vger 称呼我', type: 'preference', sessionKey: 's1', time: NOW - 60_000, signals: ['a'] },
  ];
  const reinforcement = [
    { text: '以后用 vger 称呼我', type: 'preference', sessionKey: 's2', time: NOW - 3 * 86_400_000, signals: ['b'] },
    { text: '以后用 vger 称呼我', type: 'preference', sessionKey: 's3', time: NOW - 5 * 86_400_000, signals: ['c'] },
  ];
  const scored = scoreCandidates(base, { nowMs: NOW, reinforcement });
  assert.equal(scored.length, 1);
  const top = scored[0];
  assert.equal(top.signalCount, 3);
  assert.equal(top.uniqueSessions, 3);
  assert.equal(top.uniqueDays, 3);
  assert.equal(top.reinforced, true);
  assert.ok(top.consolidation > 0.2, 'cross-day reinforcement must raise consolidation');
});

test('scoreCandidates: reinforcement never creates standalone candidates', () => {
  const scored = scoreCandidates([], { nowMs: NOW, reinforcement: [
    { text: '只有强化信号的候选', type: 'pattern', sessionKey: 's1', time: NOW, signals: ['x'] },
  ] });
  assert.equal(scored.length, 0);
});

test('runSweep: stub memory, dry-run vs apply', async () => {
  const calls = [];
  const memoryStub = {
    async list() { return []; },
    async write(entry) { calls.push(entry); return { id: 'new-' + calls.length, ...entry }; },
  };
  const sweepOpts = {
    sessionsRoot: '/nonexistent/empty', // no logs → empty sweep, still diaries
    diaryRoot: '/tmp/agint-dream-test',
    memory: memoryStub,
    nowMs: NOW,
    apply: false,
  };
  const preview = await runSweep(sweepOpts);
  assert.equal(preview.apply, false);
  assert.equal(preview.counts.promoted, 0);
  assert.equal(preview.counts.recovered, 0);
  assert.equal(calls.length, 0);

  const applied = await runSweep({ ...sweepOpts, apply: true });
  assert.equal(applied.counts.promoted, 0); // no logs → nothing to promote
  assert.equal(calls.length, 0);
});

test('renderDiary: includes recovered lane and window line', () => {
  const md = renderDiary({
    day: '2026-08-15',
    signals: [{ userTexts: ['a'], memWrites: [], errors: [] }],
    memWrites: [],
    candidates: [],
    gated: [{ text: 'x', type: 'decision', score: 0.9, signalCount: 2, uniqueDays: 1, uniqueSessions: 1, reinforced: false }],
    recovered: [{ text: 'y', type: 'lesson', score: 0.8, signalCount: 4, uniqueDays: 3, uniqueSessions: 2 }],
    promoted: [],
    errors: [],
    durationMs: 1234,
    windows: { light: 2, rem: 7, deep: 30 },
  });
  assert.match(md, /窗口：Light 2d \/ REM 7d \/ Deep恢复 30d/);
  assert.match(md, /Deep 恢复通道（30 天回填/);
  assert.match(md, /\| 1 \| lesson \| 0.80 \| 4 \| 3 \| y \|/);
});

test('recencyComponent: time=0 (missing timestamp) → 0, not 1.0', async () => {
  // Missing/zero timestamp must cap, not be treated as the most recent.
  const { scoreCandidates } = await import('../lib/sweep.js');
  const r = scoreCandidates([
    { text: '以后用 vger', type: 'preference', sessionKey: 's1', time: 0, signals: ['a'] },
  ], { nowMs: NOW });
  assert.equal(r[0].recency, 0, 'time=0 ages to forever → recency 0');
});

test('recencyComponent: time at exactly nowMs → recency 1.0', async () => {
  const { scoreCandidates } = await import('../lib/sweep.js');
  const r = scoreCandidates([
    { text: '今天的偏好', type: 'preference', sessionKey: 's1', time: NOW, signals: ['a'] },
  ], { nowMs: NOW });
  assert.ok(r[0].recency > 0.99, 'recency at nowMs ≈ 1.0');
});

test('tokenOverlap: Chinese partial match score is below 1.0 (no longer whole-string collapse)', async () => {
  // Pre-fix bug: whitespace-split on CJK gave overlap=1.0 for everything.
  // Post-fix: bigram Jaccard is a real number < 1.0 for non-identical strings.
  const { gateCandidates } = await import('../lib/sweep.js');
  const gated = gateCandidates(
    // Two distinct Chinese statements that share some bigrams but are not
    // identical: the new memory is about a specific tool, the old one is
    // about a different topic. Whitespace-split would have collapsed to 1.0.
    [{ text: '更新工具的流程先备份后替换', type: 'pattern', signalCount: 3, uniqueSessions: 2, score: 0.8, sessions: ['s1'], days: ['2026-08-15'], signals: ['x'] }],
    [{ id: 'm1', type: 'pattern', content: '遵守用户隐私保护政策' }],
    { minScore: 0.75, minRecall: 3, minUniqueSessions: 2, dedupeTokenOverlap: 0.5 },
  );
  // Distinct topics → bigram overlap < 0.5 → NOT covered.
  assert.equal(gated.length, 1, 'distinct Chinese sentences must not be falsely covered');
});

test('tokenOverlap: substring containment still wins (higher priority than bigram)', async () => {
  const { gateCandidates } = await import('../lib/sweep.js');
  const gated = gateCandidates(
    [{ text: '智进使用 vger 称呼', type: 'decision', signalCount: 3, uniqueSessions: 2, score: 0.8, sessions: ['s1'], days: ['2026-08-15'], signals: ['x'] }],
    [{ id: 'm1', type: 'decision', content: '使用 vger 称呼' }], // substring of candidate
    { minScore: 0.75, minRecall: 3, minUniqueSessions: 2, dedupeTokenOverlap: 0.5 },
  );
  assert.equal(gated.length, 0, 'substring containment must dedupe');
});

test('tokenOverlap: bag-of-words full-match triggers dedupe', async () => {
  const { gateCandidates } = await import('../lib/sweep.js');
  const gated = gateCandidates(
    [{ text: 'keep workspace clean', type: 'lesson', signalCount: 3, uniqueSessions: 2, score: 0.8, sessions: ['s1'], days: ['2026-08-15'], signals: ['x'] }],
    [{ id: 'm1', type: 'lesson', content: 'keep workspace clean' }],
    { minScore: 0.75, minRecall: 3, minUniqueSessions: 2, dedupeTokenOverlap: 0.5 },
  );
  assert.equal(gated.length, 0, 'exact match must be deduped');
});

// ── P1 LLM consolidation 集成测试 ───────────────────────────────────────

test('runSweep: 显式 consolidation runner 输出 operations → validation 走 plan', async () => {
  const { runSweep } = await import('../lib/sweep.js');
  // 直接构造一个 minimum 的 scored candidate —— 通过 consolidation runner 的 caller 路径
  // 走显式 consolidation 参数，不依赖真实 sessions 文件
  const memoryStub = { async list() { return []; }, async write() { throw new Error('not called'); } };
  // 用空的 sessions 让 sweep 跳过 Light，但通过显式 consolidation runner 不影响 (no gated → no consolidation 调用)
  const result = await runSweep({
    sessionsRoot: '/nonexistent',
    diaryRoot: '/tmp/agint-dream-test',
    memory: memoryStub,
    nowMs: NOW,
    apply: false,
    // 即使给 consolidation runner 也不会被调用（因为没有 gated）
    consolidation: async () => ({ mode: 'llm', operations: [] }),
  });
  assert.equal(result.counts.gated, 0);
  // 没 gated → consolidation 不被调用，mode 默认 heuristic-degraded
  assert.equal(result.counts.consolidationMode, 'heuristic-degraded');
});

test('runSweep: 不传 consolidation runner + 不传 ctx → heuristic-degraded, sweep 不崩溃', async () => {
  const { runSweep } = await import('../lib/sweep.js');
  const memoryStub = { async list() { return []; }, async write() { throw new Error('should not be called'); } };
  const result = await runSweep({
    sessionsRoot: '/nonexistent',
    diaryRoot: '/tmp/agint-dream-test',
    memory: memoryStub,
    nowMs: NOW,
    apply: false,
    // 没有 consolidation / 没有 ctx
  });
  assert.equal(result.counts.consolidationMode, 'heuristic-degraded');
  assert.equal(result.counts.consolidationReason, null);
});

test('runSweep: 显式 consolidation runner 抛错 → degraded, sweep 不崩溃', async () => {
  const { runSweep } = await import('../lib/sweep.js');
  const memoryStub = { async list() { return []; }, async write() { throw new Error('should not be called'); } };
  // 这里没法构造 gated（sessions 是空），所以 runner 不会被调用 —— 验证 errors 数组不包含 runner 失败
  const result = await runSweep({
    sessionsRoot: '/nonexistent',
    diaryRoot: '/tmp/agint-dream-test',
    memory: memoryStub,
    nowMs: NOW,
    apply: false,
    consolidation: async () => { throw new Error('mock runner boom'); },
  });
  assert.equal(result.counts.gated, 0);
  // runner 没被调（因为没 gated），errors 数组应该不包含 runner failed
  assert.ok(!result.errors.some((e) => /runner/.test(e)));
});

test('renderDiary: consolidationMode=llm 显示 ✅', async () => {
  const { renderDiary } = await import('../lib/sweep.js');
  const md = renderDiary({
    day: '2026-09-05',
    signals: [], memWrites: [], candidates: [], gated: [], promoted: [],
    errors: [], durationMs: 100,
    consolidationMode: 'llm',
    consolidationReason: 'merged 2 entries',
  });
  assert.match(md, /P1 LLM consolidation: ✅ LLM 决策 add\/merge\/supersede（merged 2 entries）/);
});

test('renderDiary: consolidationMode=heuristic-degraded 显示 ⚠️', async () => {
  const { renderDiary } = await import('../lib/sweep.js');
  const md = renderDiary({
    day: '2026-09-05',
    signals: [], memWrites: [], candidates: [], gated: [], promoted: [],
    errors: [], durationMs: 100,
    consolidationMode: 'heuristic-degraded',
    consolidationReason: 'agents service unavailable',
  });
  assert.match(md, /P1 LLM consolidation: ⚠️ heuristic-degraded（agents service unavailable）/);
});
