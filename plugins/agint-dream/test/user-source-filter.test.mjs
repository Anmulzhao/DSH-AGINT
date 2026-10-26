/**
 * agint-dream: 用户消息信号源过滤（提案 0f6c69bc）。
 *
 * 判据来源 —— 2026-10-23 实测 60 个会话（脚本 _diag_dream_source_20261023.mjs）：
 *   kind='user' 的记录共 163 条
 *     - source 带 rpcId/clientTimeZone：155 条 → 全部真人
 *     - source 只有 kind：              8 条 → 全部 subagent prompt（8/8 指令式开头）
 *   ⇒ source keys 判据成立。
 *
 * 文本特征判据（"你是"/"只读"等特征词）**不可用**：155 条真人里有 4 条命中
 * （如"你现在是什么模型"、"你是按照两票简明手册的要求进行审核的吗"），
 * 误杀率 2.6%，且误杀的是真人问句。故只用 source keys，不用文本特征。
 *
 * 护栏：若一整轮里 kind='user' 的记录全部没有 rpcId/clientTimeZone，
 * 说明宿主改了记录方式，判据可能已失效 —— 此时记 degraded，让零命中告警出声，
 * 而不是静默地一条不收。
 *
 * Run with: node --test plugins/agint-dream/test/user-source-filter.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectSessionSignals, classifyUserSource, aggregateSourceFilterStats } from '../lib/sweep.js';

const NOW = Date.parse('2026-10-23T01:00:00+08:00');

/** 真人消息：宿主记录时带 rpcId 与 clientTimeZone。 */
function humanRecord(text) {
  return {
    type: 'user/message',
    seq: 1,
    time: NOW,
    data: {
      source: { kind: 'user', rpcId: 'rpc-abc-123', clientTimeZone: 'Asia/Shanghai' },
      content: [{ type: 'text', text }],
    },
  };
}

/** subagent prompt：宿主也标 kind='user'，但没有 rpcId/clientTimeZone。 */
function subagentRecord(text) {
  return {
    type: 'user/message',
    seq: 2,
    time: NOW,
    data: {
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
    },
  };
}

const BASE = { type: 'session', id: 's1' };

test('classifyUserSource: 三种分类各归其位', () => {
  assert.equal(classifyUserSource(humanRecord('x')), 'human');
  assert.equal(classifyUserSource(subagentRecord('x')), 'subagent-prompt');
  assert.equal(
    classifyUserSource({ type: 'user/message', data: { source: { kind: 'plugin' } } }),
    'other-kind',
  );
  assert.equal(
    classifyUserSource({ type: 'user/message', data: { source: { kind: 'skill-catalog' } } }),
    'other-kind',
  );
});

test('classifyUserSource: 两个人类标记任一存在即判 human', () => {
  const onlyTz = { data: { source: { kind: 'user', clientTimeZone: 'Asia/Shanghai' } } };
  const onlyRpc = { data: { source: { kind: 'user', rpcId: 'rpc-1' } } };
  assert.equal(classifyUserSource(onlyTz), 'human');
  assert.equal(classifyUserSource(onlyRpc), 'human');
});

test('classifyUserSource: 空串标记不算人类标记（negative control）', () => {
  const emptyRpc = { data: { source: { kind: 'user', rpcId: '', clientTimeZone: '' } } };
  assert.equal(classifyUserSource(emptyRpc), 'subagent-prompt');
});

test('collectSessionSignals: subagent prompt 不进候选，真人进', () => {
  const records = [
    BASE,
    humanRecord('以后用 vger 称呼我'),
    subagentRecord('你是 AGINT 仓库的改动执行者。工作目录 D:\\DSH。任务板 id: task-1。'),
  ];
  const s = collectSessionSignals(records);
  assert.equal(s.userTexts.length, 1, JSON.stringify(s.userTexts));
  assert.equal(s.userTexts[0].text, '以后用 vger 称呼我');
  assert.equal(s.sourceFilter.subagentDropped, 1);
  assert.equal(s.sourceFilter.humanKept, 1);
  assert.equal(s.sourceFilter.degraded, false);
});

test('collectSessionSignals: 指令式 subagent prompt 文本特征也不漏（含"只读"）', () => {
  const records = [
    BASE,
    subagentRecord('任务：盘点 AGINT 仓库全部插件的能力。只读调研，不要修改任何文件。'),
  ];
  const s = collectSessionSignals(records);
  assert.equal(s.userTexts.length, 0, 'subagent prompt 必须被挡住');
  assert.equal(s.sourceFilter.subagentDropped, 1);
});

test('collectSessionSignals: 真人问句不会被文本特征误杀（negative control）', () => {
  const records = [
    BASE,
    humanRecord('你现在是什么模型，推理等级是什么'),
    humanRecord('你是按照两票简明手册的要求进行审核的吗'),
  ];
  const s = collectSessionSignals(records);
  assert.equal(s.userTexts.length, 2, '真人消息一条都不能丢');
  assert.equal(s.sourceFilter.subagentDropped, 0);
});

test('collectSessionSignals: 非 user kind 的注入仍被挡（既有行为不退化）', () => {
  const records = [
    BASE,
    { type: 'user/message', time: NOW, data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: '技能目录' }] } },
    { type: 'user/message', time: NOW, data: { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: '注入原文' }] } },
    humanRecord('继续'),
  ];
  const s = collectSessionSignals(records);
  assert.equal(s.userTexts.length, 1);
  assert.equal(s.sourceFilter.humanKept, 1);
  assert.equal(s.sourceFilter.subagentDropped, 0);
});

test('collectSessionSignals: 全轮无人类标记时记 degraded（判据失效要出声）', () => {
  const records = [
    BASE,
    subagentRecord('你是独立核验者。工作目录 D:\\DSH。'),
    subagentRecord('任务：只读调研，不要修改任何文件。'),
  ];
  const s = collectSessionSignals(records);
  assert.equal(s.userTexts.length, 0);
  assert.equal(s.sourceFilter.humanKept, 0);
  assert.equal(s.sourceFilter.subagentDropped, 2);
  assert.equal(s.sourceFilter.degraded, true, '判据失效必须标记 degraded');
});

test('aggregateSourceFilterStats: 跨会话汇总，判据正常时不报失效', () => {
  const signals = [
    collectSessionSignals([BASE, humanRecord('a'), subagentRecord('你是执行者。工作目录 D:\\DSH。')]),
    collectSessionSignals([BASE, humanRecord('b'), humanRecord('c')]),
  ];
  const s = aggregateSourceFilterStats(signals);
  assert.equal(s.humanKept, 3);
  assert.equal(s.subagentDropped, 1);
  assert.equal(s.userKindTotal, 4);
  assert.equal(s.degradedSessions, 0);
  assert.equal(s.judgeFailed, false);
});

test('aggregateSourceFilterStats: 只收到 subagent prompt 时判 judgeFailed', () => {
  const signals = [collectSessionSignals([BASE, subagentRecord('任务：只读调研，不要修改任何文件。')])];
  const s = aggregateSourceFilterStats(signals);
  assert.equal(s.humanKept, 0);
  assert.equal(s.subagentDropped, 1);
  assert.equal(s.judgeFailed, true, '判据失效必须报出来');
});

test('aggregateSourceFilterStats: 有老格式兜底时不判 judgeFailed（negative control）', () => {
  // 老格式会话没有 source，收得到消息 ⇒ 不能算判据失效。
  const signals = [
    collectSessionSignals([BASE, { type: 'user/message', time: NOW, data: { content: [{ type: 'text', text: '老格式' }] } }]),
    collectSessionSignals([BASE, subagentRecord('你是执行者。')]),
  ];
  const s = aggregateSourceFilterStats(signals);
  assert.equal(s.unknownKept, 1);
  assert.equal(s.humanKept, 0);
  assert.equal(s.degradedSessions, 1);
  assert.equal(s.judgeFailed, false, '老格式能收消息时不算失效');
});

test('aggregateSourceFilterStats: 空 signals 不炸也不报失效', () => {
  const s = aggregateSourceFilterStats([]);
  assert.equal(s.humanKept, 0);
  assert.equal(s.judgeFailed, false);
});

test('classifyUserSource: 无 source 字段的老格式判 unknown-source', () => {
  assert.equal(
    classifyUserSource({ type: 'user/message', data: { content: [{ type: 'text', text: 'x' }] } }),
    'unknown-source',
  );
});

test('collectSessionSignals: 老格式（无 source）保守收，不整轮归零', () => {
  // 这条是防「静默失效 7 天」同型错：老格式会话没有 source 字段，
  // 判成 subagent prompt 会让这些会话的用户消息被全部丢掉。
  const records = [
    BASE,
    { type: 'user/message', seq: 1, time: NOW, data: { content: [{ type: 'text', text: '老格式消息' }] } },
  ];
  const s = collectSessionSignals(records);
  assert.equal(s.userTexts.length, 1, '老格式消息必须保留');
  assert.equal(s.sourceFilter.unknownKept, 1);
  assert.equal(s.sourceFilter.subagentDropped, 0);
  assert.equal(s.sourceFilter.degraded, false, '老格式不算判据失效');
});

test('collectSessionSignals: 无任何 user 记录时不记 degraded', () => {
  const records = [BASE, { type: 'assistant/message', time: NOW, data: { content: [{ type: 'text', text: 'hi' }] } }];
  const s = collectSessionSignals(records);
  assert.equal(s.sourceFilter.userKindTotal, 0);
  assert.equal(s.sourceFilter.degraded, false);
});
