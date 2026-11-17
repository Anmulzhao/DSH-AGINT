/**
 * 方案 C（2026-11-07）：准入口径从「逐字复现」改成「形态 + LLM 裁决」。
 *
 * 背景（实测）：老准入要求「同一句逐字复现 ≥3 次且跨 ≥2 个会话」。真实语料里
 * 这种形态几乎不存在 —— 7 天窗口 129 个不同句子只有 1 个够门槛 ⇒ 候选池被永久
 * 关死，梦境自 2026-10-21 起过门数持续为 0，最后一次非零提升是 2026-10-20。
 *
 * 本次落地：
 *   ① extractCandidates 新增 assistant 正文作为第三条候选源（形态判据 + 拒绝计数）
 *   ② gateCandidates 支持 admission='shape'：不按复现次数拒绝，复现退回评分权重
 *   ③ Config 出厂默认 admissionMode='shape'，可运行时改回 'repetition'（kill-switch）
 *
 * 判据要点（check-soundness）：
 *   - 负控制：把 DEFAULTS.admissionMode 改回 'repetition' ⇒ 形状准入的用例必须变红。
 *   - 回滚开关本身也有用例：admission='repetition' 时同一候选必须被挡。
 *   - 拒绝原因必须可见（shapeStats.byReason），否则「候选 0 条」分不清是没采到还是全被挡。
 *
 * 运行：node --test plugins/agint-dream/test/admission-shape.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCandidates,
  gateCandidates,
  scoreCandidates,
  admissionStatsOf,
  aggregateShapeStats,
  renderDiary,
  DEFAULTS,
} from '../lib/sweep.js';
import { Config, RUNTIME_CONFIG_KEYS } from '../lib/index.js';

const session = (over = {}) => ({
  sessionKey: 's1',
  userTexts: [],
  assistantTexts: [],
  errors: [],
  memWrites: [],
  ...over,
});

const CAND = (text, extra = {}) => ({
  text,
  type: 'lesson',
  source: 'assistant',
  sessionKey: 's1',
  time: Date.parse('2026-11-01T00:00:00Z'),
  signals: [text],
  score: 0.3,          // 故意低于 minScore：形状准入不看分数
  signalCount: 1,      // 故意低于 minRecall
  uniqueSessions: 1,   // 故意低于 minUniqueSessions
  ...extra,
});

// ── ① assistant 源：形态判据 ────────────────────────────────────────────

test('assistant 正文里的主张句进候选（source=assistant，type 按判据定）', () => {
  const s = session({
    assistantTexts: [{ text: '所以以后修改配置前必须先跑一次 check-wiring，确认三副本一致。', time: 1 }],
  });
  const cands = extractCandidates(s, Date.now(), {});
  assert.equal(cands.length, 1, '含经验词的中文陈述句应当进候选');
  assert.equal(cands[0].source, 'assistant');
  assert.equal(cands[0].type, 'lesson');
  assert.match(cands[0].text, /check-wiring/);
});

test('assistant 的四类噪音不进候选：引用块 / 工具回显 / 代码骨架 / 疑问句', () => {
  const s = session({
    assistantTexts: [
      { text: '> - (id=abc, type=lesson) 老记忆条目的形态，不要当成新主张。', time: 1 },
      { text: 'memory_search: 3 hit(s) (memory=3, wiki=0)', time: 2 },
      { text: 'const x = require("fs"); 必须在 plugins/agint-memory/lib/index.js 里改。', time: 3 },
      { text: '这个结论应该先跑一次 check-wiring 再重启吗？', time: 4 },
      { text: '好的，已经处理完成。', time: 5 },
    ],
  });
  const cands = extractCandidates(s, Date.now(), {});
  assert.equal(cands.length, 0, '噪音句一条都不该进候选');
  const stats = aggregateShapeStats([cands]);
  assert.ok(stats.dropped >= 4, `拒绝计数必须可见，实际 ${stats.dropped}`);
  assert.ok(stats.byReason.quoted >= 1, '引用块原因要能区分出来');
  assert.ok(stats.byReason['tool-echo'] >= 1, '工具回显原因要能区分出来');
  assert.ok(stats.byReason.code >= 1, '代码骨架原因要能区分出来');
  assert.ok(stats.byReason.question >= 1, '疑问句原因要能区分出来');
});

test('用户原话里的桶命中仍然照旧进候选（assistant 源不能挤掉老源）', () => {
  const s = session({
    userTexts: [{ text: '以后用 vger 称呼我', time: 1 }],
  });
  const cands = extractCandidates(s, Date.now(), {});
  assert.equal(cands.length, 1);
  assert.equal(cands[0].source, 'user');
});

test('候选来源统计：用户 / assistant / 工具错误分开计', () => {
  const s = session({
    userTexts: [{ text: '以后用 vger 称呼我', time: 1 }],
    assistantTexts: [{ text: '所以每次改完必须先跑一次 check-wiring 再重启宿主。', time: 2 }],
  });
  const cands = extractCandidates(s, Date.now(), {});
  const stats = aggregateShapeStats([cands]);
  assert.equal(stats.sources.user, 1);
  assert.equal(stats.sources.assistant, 1);
});

// ── ② 准入口径 ─────────────────────────────────────────────────────────

test('admission=shape：单次出现的候选也能过门（复现次数不作准入）', () => {
  const scored = [CAND('所以以后改配置前必须先跑 check-wiring')];
  const gated = gateCandidates(scored, [], { admission: 'shape', maxGated: 20 });
  assert.equal(gated.length, 1, '形状准入下，单次出现的候选必须放行');
  const stats = admissionStatsOf(gated);
  assert.equal(stats.mode, 'shape');
  assert.equal(stats.capped, 0);
});

test('admission=repetition：同一候选被复现门槛挡住（回滚开关有效）', () => {
  // 分数给高一点：这样挡下它的必须是复现门槛本身，而不是分数门槛。
  const scored = [CAND('所以以后改配置前必须先跑 check-wiring', { score: 0.9 })];
  const gated = gateCandidates(scored, [], { admission: 'repetition', minScore: 0.6, minRecall: 3, minUniqueSessions: 2 });
  assert.equal(gated.length, 0, '复现口径下这条（signalCount=1）必须被挡');
  const stats = admissionStatsOf(gated);
  assert.equal(stats.rejectedByScore, 0, '分数这一关它是通过的');
  assert.equal(stats.rejectedBySignal, 1, '必须是复现次数这一关挡下它');
});

test('形状准入有上限：超过 maxGated 的按分数截断，且截断数可见', () => {
  const scored = [
    CAND('所以以后改配置前必须先跑 check-wiring 确认三副本一致', { score: 0.9 }),
    CAND('所以重启前必须先跑一次 check-wiring 确认副本一致', { score: 0.8 }),
    CAND('所以修改配置前必须先跑 check-wiring 确认副本一致', { score: 0.7 }),
  ];
  const gated = gateCandidates(scored, [], { admission: 'shape', maxGated: 2 });
  assert.equal(gated.length, 2, '超上限的必须截断');
  assert.equal(gated[0].score, 0.9, '截断前按分数排序');
  const stats = admissionStatsOf(gated);
  assert.equal(stats.capped, 1, '被上限截掉的条数必须可见');
});

test('去重仍然生效：与 existing 高度重合的候选不进门（形状准入不退化去重）', () => {
  const scored = [CAND('所以以后改配置前必须先跑 check-wiring 确认三副本一致')];
  const existing = [{ id: 'm1', type: 'lesson', content: '所以以后改配置前必须先跑 check-wiring 确认三副本一致' }];
  const gated = gateCandidates(scored, existing, { admission: 'shape', maxGated: 20, dedupeTieredEnabled: true, dedupeHigh: 0.85, dedupeMid: 0.6 });
  assert.equal(gated.length, 0, '与已有记忆完全同句的候选必须被去重吃掉');
});

// ── ③ 配置与回滚开关 ───────────────────────────────────────────────────

test('Config 出厂默认：形态准入 + 上限 20（K51 出厂即开）', () => {
  const parsed = Config.parse({ root: '/tmp/dreams-test' });
  assert.equal(parsed.admissionMode, DEFAULTS.admissionMode);
  assert.equal(parsed.admissionMode, 'shape');
  assert.equal(parsed.maxGated, DEFAULTS.maxGated);
  assert.equal(parsed.maxGated, 20);
});

test('回滚开关可运行时改（admissionMode 必须在 RUNTIME_CONFIG_KEYS 里）', () => {
  assert.ok(RUNTIME_CONFIG_KEYS.includes('admissionMode'),
    'admissionMode 不在 RUNTIME_CONFIG_KEYS ⇒ config() 改它会静默无效');
});

// ── ④ 日记可观测 ───────────────────────────────────────────────────────

test('日记必须写出候选来源与准入口径（否则「候选 0 条」分不清原因）', () => {
  const md = renderDiary({
    day: '2026-11-07',
    apply: false,
    signals: [],
    memWrites: [],
    candidates: [],
    gated: [],
    promoted: [],
    durationMs: 1000,
    windows: { light: 2, rem: 7, deep: 30 },
    shapeStats: { sentences: 120, kept: 3, dropped: 117, byReason: { 'no-claim-word': 100, code: 17 }, sources: { user: 0, assistant: 3, 'tool-error': 0 } },
    admissionStats: { mode: 'shape', maxGated: 20, rejectedByScore: 0, rejectedBySignal: 0, rejectedBySessions: 0, capped: 0 },
  });
  assert.match(md, /候选来源：用户原话 0 · assistant 正文 3 · 工具错误 0/);
  assert.match(md, /assistant 形态判据：句子 120 · 入池 3 · 挡 117/);
  assert.match(md, /no-claim-word×100/);
  assert.match(md, /准入：形态准入/);
});
