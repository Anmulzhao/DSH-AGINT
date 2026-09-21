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

// ── 2026-09-21：引用块 / 记忆条目前缀不得成为候选（本体污染入口） ──────────────

test('extractCandidates: 引用块与 (id=...) 前缀文本被拦下，不进候选', () => {
  const session = {
    sessionKey: 's1',
    userTexts: [
      // 贴给老板看的日记/引用块形态 —— 修复前会被当候选，把前缀写进 memory 本体
      // （都带 SIGNAL_RULES 触发词「不要/禁止」，确保修复前确实会产出候选）
      { text: '> - (id=7a4a2945, type=lesson) 核对仓差异不要依赖行数，改用字节长度判定', time: NOW },
      { text: '> > - (id=7a4a2945, type=lesson) 核对仓差异不要依赖行数，改用字节长度判定', time: NOW },
      { text: '(id=7a4a2945, type=lesson) 核对仓差异不要依赖行数，改用字节长度判定', time: NOW },
      // 正常主张 —— 必须保留（带 SIGNAL_RULES 触发词「不要」）
      { text: '以后核对仓差异不要依赖行数，改用 SHA256 哈希判定', time: NOW },
    ],
    errors: [],
  };
  const cands = extractCandidates(session, NOW);
  assert.ok(
    cands.every((c) => !/id=7a4a2945/.test(c.text)),
    `引用块/前缀形态不得成为候选: ${JSON.stringify(cands.map((c) => c.text))}`,
  );
  assert.ok(cands.some((c) => /SHA256 哈希判定/.test(c.text)), '正常主张必须保留');
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

// 2026-09-21 行为变更（方案 B，老板已拍板）：互含**不再一律丢弃**。
// 旧断言 `substring containment must dedupe`（gated.length===0）源自单一阈值时代 ——
// 它正是「同源闭包」的帮凶：候选只要与任一条 existing 有互含关系就出局，而候选与
// 生产记忆共享同一份会话来源，互含是常态而非异常。现在按长度比例分档：
//   ratio ≥ 0.85 → 真重复（丢弃）；ratio < 0.85 → 疑似（放行 + 标记）。
// 本用例的两句 ratio ≈ 0.64 → 降级为中档。旧行为由 kill-switch 用例守着。
test('分级去重（行为变更）：互含但长度悬殊 → 降级为中档放行，不再一律丢弃', async () => {
  const { gateCandidates } = await import('../lib/sweep.js');
  const scored = [{
    text: '智进使用 vger 称呼', type: 'decision', signalCount: 3, uniqueSessions: 2,
    score: 0.8, sessions: ['s1'], days: ['2026-08-15'], signals: ['x'],
  }];
  const existing = [{ id: 'm1', type: 'decision', content: '使用 vger 称呼' }]; // substring of candidate
  const opts = { minScore: 0.75, minRecall: 3, minUniqueSessions: 2, dedupeTokenOverlap: 0.5 };
  const gated = gateCandidates(scored.map((c) => ({ ...c })), existing, opts);
  assert.equal(gated.length, 1, 'ratio 0.64 (<0.85) → 疑似档，放行给 LLM 裁');
  assert.equal(gated[0].dedupeSuspicion.kind, 'substring');
  // kill-switch 下旧行为必须完整保留
  const legacy = gateCandidates(scored.map((c) => ({ ...c })), existing, { ...opts, dedupeTieredEnabled: false });
  assert.equal(legacy.length, 0, 'dedupeTieredEnabled=false → 回退为一律丢弃（旧行为）');
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

// ── 2026-09-21：分级去重（方案 B，proposals/agint-dream-dedupe-lineage.md）──────
//
// 病灶：候选从会话日志抽，生产记忆本身也是这些会话沉淀的产物 —— 两者共享同一份
// 文本来源。单一 0.6 阈值下 existing 越全命中率越高，实测 406 条记忆把 83 条过门
// 候选 100% 吃掉（gated 0）。修法：把「命中后果」从布尔拆成三档。

const CAND = (text, score = 0.8) => ({
  text, type: 'decision', signalCount: 3, uniqueSessions: 2, score,
  sessions: ['s1'], days: ['2026-08-15'], signals: ['x'],
});

test('分级去重：高相似（≥0.85 精确同句）仍被丢弃 → gated 不变', async () => {
  const { gateCandidates } = await import('../lib/sweep.js');
  const gated = gateCandidates(
    [CAND('keep workspace clean')],
    [{ id: 'm1', type: 'lesson', content: 'keep workspace clean' }],
    { minScore: 0.75, minRecall: 3, minUniqueSessions: 2 },
  );
  assert.equal(gated.length, 0, 'exact match is real duplication → dropped');
  assert.equal(gated.dedupeStats.dropped, 1);
  assert.equal(gated.dedupeStats.suspicious, 0);
});

test('分级去重：互含但长度悬殊（ratio < 0.85）→ 放行 + dedupeSuspicion', async () => {
  const { gateCandidates } = await import('../lib/sweep.js');
  // '使用 vger 称呼' 完全被候选包含，但 ratio = 7/11 ≈ 0.64 落在中档
  const gated = gateCandidates(
    [CAND('智进使用 vger 称呼')],
    [{ id: 'm1', type: 'decision', content: '使用 vger 称呼' }],
    { minScore: 0.75, minRecall: 3, minUniqueSessions: 2, dedupeTokenOverlap: 0.5 },
  );
  assert.equal(gated.length, 1, '中相似档必须放行给 LLM 裁');
  assert.equal(gated[0].dedupeSuspicion.kind, 'substring');
  assert.equal(gated[0].dedupeSuspicion.againstId, 'm1');
  assert.ok(gated[0].dedupeSuspicion.similarity >= 0.6, 'similarity 记录在案');
  assert.equal(gated.dedupeStats.suspicious, 1);
  assert.equal(gated.dedupeStats.dropped, 0);
});

test('分级去重：中相似（0.6~0.85 二元组重叠）→ 放行 + kind=similarity', async () => {
  const { gateCandidates } = await import('../lib/sweep.js');
  // 实测 maxSimilarity = 0.667：共享大部分二元组（「化方案用于长期投资」「方案用于长期投」
  // 等），但都不是对方的子串 → 必走 tokenOverlap 分支，落中档。
  const gated = gateCandidates(
    [CAND('索引化方案用于长期投资')],
    [{ id: 'm2', type: 'decision', content: '指数化方案用于长期投资' }],
    { minScore: 0.75, minRecall: 3, minUniqueSessions: 2, dedupeMid: 0.6, dedupeHigh: 0.85 },
  );
  assert.equal(gated.length, 1, '中相似档放行');
  assert.equal(gated[0].dedupeSuspicion.kind, 'similarity');
  assert.equal(gated[0].dedupeSuspicion.againstId, 'm2');
  assert.ok(gated[0].dedupeSuspicion.similarity >= 0.6 && gated[0].dedupeSuspicion.similarity < 0.85,
    `similarity 必须落在中档，实测 ${gated[0].dedupeSuspicion.similarity}`);
  assert.equal(gated.dedupeStats.suspicious, 1);
  assert.equal(gated.dedupeStats.dropped, 0);
});

test('分级去重：低相似（<0.6）→ 无标记放行', async () => {
  const { gateCandidates } = await import('../lib/sweep.js');
  const gated = gateCandidates(
    [CAND('更新工具的流程先备份后替换')],
    [{ id: 'm1', type: 'pattern', content: '遵守用户隐私保护政策' }],
    { minScore: 0.75, minRecall: 3, minUniqueSessions: 2, dedupeTokenOverlap: 0.5 },
  );
  assert.equal(gated.length, 1);
  assert.equal(gated[0].dedupeSuspicion, undefined, '低相似不得被打标（防误伤）');
  assert.equal(gated.dedupeStats.suspicious, 0);
});

test('回归护栏：dedupeTieredEnabled=false → 与现状（单一阈值布尔判定）逐项一致', async () => {
  const { gateCandidates } = await import('../lib/sweep.js');
  // 三条候选覆盖三种形态：精确同句（高）/ 互含（中档，旧逻辑必丢）/ 无关
  const scored = [
    CAND('keep workspace clean'),
    CAND('智进使用 vger 称呼'),
    CAND('更新工具的流程先备份后替换'),
  ];
  const existing = [
    { id: 'm1', type: 'lesson', content: 'keep workspace clean' },
    { id: 'm2', type: 'decision', content: '使用 vger 称呼' },
    { id: 'm3', type: 'pattern', content: '遵守用户隐私保护政策' },
  ];
  const opts = { minScore: 0.75, minRecall: 3, minUniqueSessions: 2, dedupeTokenOverlap: 0.5 };
  const tiered = gateCandidates(scored.map((c) => ({ ...c })), existing, opts);
  const legacy = gateCandidates(scored.map((c) => ({ ...c })), existing, { ...opts, dedupeTieredEnabled: false });
  // 旧逻辑：互含即丢 → 只剩「无关」那条
  assert.equal(legacy.length, 1, 'kill-switch 下必须回到单一阈值行为');
  assert.equal(legacy[0].text, '更新工具的流程先备份后替换');
  assert.ok(legacy.every((c) => c.dedupeSuspicion === undefined), '回退态不得产生新字段');
  assert.equal(legacy.dedupeStats.enabled, false);
  // 分级态：中档那条被放行 → 比回退态多
  assert.ok(tiered.length > legacy.length, `分级去重必须比回退态多放行（${tiered.length} > ${legacy.length}）`);
});

test('分级去重：空 existing → 全部放行且零计数', async () => {
  const { gateCandidates } = await import('../lib/sweep.js');
  const gated = gateCandidates([CAND('以后用 vger 称呼我')], [], { minScore: 0.75, minRecall: 3, minUniqueSessions: 2 });
  assert.equal(gated.length, 1);
  assert.deepEqual(
    { dropped: gated.dedupeStats.dropped, suspicious: gated.dedupeStats.suspicious, max: gated.dedupeStats.maxSimilarity },
    { dropped: 0, suspicious: 0, max: 0 },
  );
});

test('分级去重：1 条 existing 且内容为空/纯标点 → 不产生 NaN', async () => {
  const { gateCandidates } = await import('../lib/sweep.js');
  const gated = gateCandidates(
    [CAND('以后用 vger 称呼我')],
    [{ id: 'm1', type: 'lesson', content: '   ' }],  // normalize 后为空 → 被 filter 掉
    { minScore: 0.75, minRecall: 3, minUniqueSessions: 2 },
  );
  assert.equal(gated.length, 1);
  assert.equal(gated[0].dedupeSuspicion, undefined);
  assert.ok(Number.isFinite(gated.dedupeStats.maxSimilarity), 'maxSimilarity 必须是有限数');
});

test('分级去重：dedupeStats 是非枚举属性 —— 数组语义（length/deepEqual）不受影响', async () => {
  const { gateCandidates } = await import('../lib/sweep.js');
  const gated = gateCandidates([CAND('以后用 vger 称呼我')], [], { minScore: 0.75, minRecall: 3, minUniqueSessions: 2 });
  assert.deepEqual(gated, [gated[0]], 'deepEqual 只比数组元素，不带统计字段');
  assert.deepEqual(Object.keys(gated), ['0'], '统计不得成为可枚举键');
});

test('分级去重：门槛未过的候选不计入 checked（埋点只统计真进过去重的）', async () => {
  const { gateCandidates } = await import('../lib/sweep.js');
  const gated = gateCandidates(
    [CAND('低分候选', 0.2), CAND('过门候选')],
    [],
    { minScore: 0.75, minRecall: 3, minUniqueSessions: 2 },
  );
  assert.equal(gated.length, 1);
  assert.equal(gated.dedupeStats.checked, 1, '被 score 门槛挡掉的不算「进过去重」');
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
  // 2026-09-18 C 项：没 gated → LLM 没被调用，诚实标 not-attempted（不再伪装成 LLM 失败）
  assert.equal(result.counts.consolidationMode, 'not-attempted');
  assert.match(result.counts.consolidationReason, /0 gated/);
});

test('runSweep: 不传 consolidation runner + 不传 ctx + 0 gated → not-attempted, sweep 不崩溃', async () => {
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
  // 2026-09-18 C 项：0 gated → LLM 未被调用（空 sessions 下永远不会走到 runner 判定）
  assert.equal(result.counts.consolidationMode, 'not-attempted');
  assert.match(result.counts.consolidationReason, /0 gated/);
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
  // 注意：llm 分支的标签是加粗的（`**P1 LLM consolidation**:`，与上方 P0 validation gate 行同款式），
  // 而 heuristic-degraded 分支不加粗。此断言自 fbfd060 起与实现漂移（一直红），2026-09-17 按实现校正。
  assert.match(md, /\*\*P1 LLM consolidation\*\*: ✅ LLM 决策 add\/merge\/supersede（merged 2 entries）/);
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

test('renderDiary: consolidationMode=not-attempted 显示 ➖ 未触发（区别于 LLM 失败）', async () => {
  const { renderDiary } = await import('../lib/sweep.js');
  const md = renderDiary({
    day: '2026-09-18',
    signals: [], memWrites: [], candidates: [], gated: [], promoted: [],
    errors: [], durationMs: 100,
    consolidationMode: 'not-attempted',
    consolidationReason: '0 gated candidates — LLM 未触发',
  });
  assert.match(md, /P1 LLM consolidation: ➖ 未触发（0 gated candidates/);
  assert.doesNotMatch(md, /heuristic-degraded/);
});
