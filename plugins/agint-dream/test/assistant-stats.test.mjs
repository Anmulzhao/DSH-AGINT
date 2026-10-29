/**
 * agint-dream: assistant 正文统计的出口（提案 d2b77b47，2026-10-29）。
 *
 * 为什么需要这组测试 —— `collectSessionSignals` 从 2026-10-28 起就在每条会话上挂
 * `assistantStats`（messages / chars / causalSentences），但**一个出口都没有**：
 * 日记不写、result.counts 不带、tools.js 的 schema 也不声明。数字被采到然后被丢掉，
 * 10-28 23:05 的 dry-run 实测过：处理 35 个会话，产出的 preview.md 里
 * `grep -i assistant` 命中 0 行。
 *
 * 两条口径由本文件钉住：
 *   ① 累加正确（跨会话求和，不是取平均、不是取最后一条）
 *   ② **两个 0 必须分得开**：
 *        - 一条 assistant 正文都没采到 → collectorFailed=true（采集口径失效的探针）
 *        - 采到了但没有因果句       → collectorFailed=false，causalSentences=0（正常）
 *
 * 另外守一条 K164 同形状事故的回归闸：`additionalProperties:false` 下漏声明一个键，
 * 整个工具不可用（前科 toolErrorFilter / evolutionTemplates / dedupeStats，
 * 其中 dedupeStats 只补了 dream_run_now 漏了 dream_status）。本提案的 assistant 段
 * 必须**两个工具都**声明，故这里直接数源码里的声明次数。
 *
 * Run with: node --test plugins/agint-dream/test/assistant-stats.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { aggregateAssistantStats, renderDiary } from '../lib/sweep.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 最小信号形状：renderDiary 会读 userTexts / errors / memWrites。 */
function signal(assistantStats, sessionKey = 's1') {
  return { sessionKey, userTexts: [], memWrites: [], errors: [], assistantStats };
}

test('aggregateAssistantStats: 跨会话累加，不是取最后一条', () => {
  const out = aggregateAssistantStats([
    signal({ messages: 3, chars: 100, causalSentences: 2 }, 'a'),
    signal({ messages: 5, chars: 400, causalSentences: 1 }, 'b'),
    signal(undefined, 'c'), // 没有 assistant 记录的会话（老日志/空会话）
  ]);
  assert.equal(out.sessions, 3);
  assert.equal(out.sessionsWithAssistant, 2);
  assert.equal(out.messages, 8);
  assert.equal(out.chars, 500);
  assert.equal(out.causalSentences, 3);
  assert.equal(out.collectorFailed, false);
});

test('两个 0 分得开：没采到 = collectorFailed，采到但无因果句 = 正常', () => {
  // ① 有会话、但一条 assistant 记录都没有 ⇒ 采集口径可能失效
  const none = aggregateAssistantStats([signal(undefined), signal(undefined)]);
  assert.equal(none.sessions, 2);
  assert.equal(none.sessionsWithAssistant, 0);
  assert.equal(none.collectorFailed, true, '一条都没采到必须标记 collectorFailed');

  // ② 采到了正文、只是没有因果句 ⇒ 正常，不许报「失效」
  const noCausal = aggregateAssistantStats([signal({ messages: 4, chars: 900, causalSentences: 0 })]);
  assert.equal(noCausal.messages, 4);
  assert.equal(noCausal.causalSentences, 0);
  assert.equal(noCausal.collectorFailed, false, '采到了就不是采集失效，只是没有因果句');

  // ③ 空输入不 panic，且不冤报失效（没有会话 ≠ 采集失效）
  const empty = aggregateAssistantStats([]);
  assert.equal(empty.sessions, 0);
  assert.equal(empty.collectorFailed, false, '没跑会话时不许报采集失效（重启后第一眼就是这种状态）');
});

test('renderDiary: assistant 段恒出一行，数值为 0 也要可见', () => {
  const diary = renderDiary({
    day: '2026-10-29',
    signals: [signal({ messages: 0, chars: 0, causalSentences: 0 }, 'a'), signal({ messages: 2, chars: 30, causalSentences: 1 }, 'b')],
    memWrites: [],
    candidates: [],
    gated: [],
    promoted: [],
    durationMs: 1000,
    windows: { light: 3, rem: 7, deep: 30 },
    assistantStats: aggregateAssistantStats([signal({ messages: 0, chars: 0, causalSentences: 0 }, 'a'), signal({ messages: 2, chars: 30, causalSentences: 1 }, 'b')]),
    apply: false,
  });
  const line = diary.split('\n').find((l) => l.includes('assistant 正文'));
  assert.ok(line, `日记里必须有 assistant 段，实际输出：\n${diary}`);
  assert.match(line, /1\/2 个会话/);
  assert.match(line, /2 条/);
  assert.match(line, /30 字/);
  assert.match(line, /因果句 1 条/);
  assert.doesNotMatch(line, /一条都没采到/, '采到了就不许喊失效');
});

test('renderDiary: 采集口径失效时要当场喊出来', () => {
  const stats = aggregateAssistantStats([signal(undefined, 'a')]);
  const diary = renderDiary({
    day: '2026-10-29',
    signals: [signal(undefined, 'a')],
    memWrites: [],
    candidates: [],
    gated: [],
    promoted: [],
    durationMs: 1000,
    windows: { light: 3, rem: 7, deep: 30 },
    assistantStats: stats,
    apply: false,
  });
  const line = diary.split('\n').find((l) => l.includes('assistant 正文'));
  assert.ok(line, 'assistant 段不许因为数值为 0 就整段消失');
  assert.match(line, /一条都没采到/);
});

test('K164 回归闸：assistant 段在 dream_status 与 dream_run_now 两处 schema 都声明了', () => {
  const src = readFileSync(resolve(HERE, '../lib/tools.js'), 'utf8');
  const n = src.split('assistant: { required: true,').length - 1;
  assert.equal(n, 2, `tools.js 里 assistant 段必须声明两次（status + run_now），实际 ${n} 次 —— 少一处就是整个工具不可用`);
});
