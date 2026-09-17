/**
 * agint-session-extract 纯函数单测（无 I/O、无 zstd 依赖）。
 * 锚定两条链唯一共享单点：解压/解析/提取的每一处配对逻辑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSession,
  extractToolCalls,
  argsToHead,
  extractTextWindows,
  extractMemorySignals,
  eventToText,
} from '../index.js';

const SESSION_ID = 'sess-x';

// 合成会话事件（形状来自 2026-09-17 实盘探针）
function makeEvents() {
  return [
    { type: 'tool/call', time: 1000, seq: 1, data: { turn: 1, step: 1, callId: 'c1', name: 'glob', arguments: '{"pattern":"src/**/*.js"}' } },
    { type: 'tool/result', time: 1010, seq: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false }] } } },
    { type: 'tool/call', time: 2000, seq: 3, data: { turn: 1, step: 2, callId: 'c2', name: 'grep', arguments: '{"pattern":"foo"}' } },
    { type: 'tool/result', time: 2030, seq: 4, data: { turn: 1, step: 2, message: { content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'err' }], isError: true }] } } },
    // 无 result 事件 → ok=null
    { type: 'tool/call', time: 3000, seq: 5, data: { turn: 2, step: 1, callId: 'c3', name: 'read', arguments: '{}' } },
    // 坏 arguments 字符串 → args={}
    { type: 'tool/call', time: 4000, seq: 6, data: { turn: 2, step: 2, callId: 'c4', name: 'write', arguments: 'not-json' } },
    // 无名调用 → 跳过
    { type: 'tool/call', time: 5000, seq: 7, data: { turn: 2, step: 3, callId: 'c5', arguments: '{}' } },
  ];
}

test('parseSession 跳过坏行，保留合法事件', () => {
  const text = [
    '{"type":"tool/call","data":{}}',
    'this is not json',
    '',
    '{"type":"turn/start"}',
  ].join('\n');
  const ev = parseSession(text);
  assert.equal(ev.length, 2);
  assert.equal(ev[0].type, 'tool/call');
  assert.equal(ev[1].type, 'turn/start');
});

test('extractToolCalls 配对 call+result，产出聚合器兼容 record', () => {
  const recs = extractToolCalls(makeEvents(), { sessionId: SESSION_ID });
  // 无名调用被跳过 → 4 条
  assert.equal(recs.length, 4);

  const c1 = recs.find((r) => r.callId === 'c1');
  assert.equal(c1.tool, 'glob');
  assert.equal(c1.ok, true);
  assert.equal(c1.latencyMs, 10);
  assert.deepEqual(c1.args, { pattern: 'src/**/*.js' });
  assert.equal(c1.argsHead, 'pattern=src/**/*.js');
  assert.equal(c1.turn, 1);
  assert.equal(c1.step, 1);
  assert.equal(c1.sessionId, SESSION_ID);

  const c2 = recs.find((r) => r.callId === 'c2');
  assert.equal(c2.ok, false);
  assert.equal(c2.latencyMs, 30);
  assert.equal(c2.errorKind, 'tool-result-isError');

  const c3 = recs.find((r) => r.callId === 'c3');
  assert.equal(c3.ok, null); // 无 result → 诚实缺失
  assert.equal(c3.latencyMs, null);

  const c4 = recs.find((r) => r.callId === 'c4');
  assert.deepEqual(c4.args, {}); // 坏 JSON → 空对象
});

test('extractToolCalls 兼容 arguments 已是对象（非字符串）', () => {
  const ev = [{ type: 'tool/call', time: 1, data: { turn: 1, step: 1, callId: 'a', name: 'ls', arguments: { path: '/x' } } }];
  const recs = extractToolCalls(ev, {});
  assert.equal(recs.length, 1);
  assert.deepEqual(recs[0].args, { path: '/x' });
});

test('argsToHead 收敛成短串并截断', () => {
  assert.equal(argsToHead({ pattern: 'src/**/*.js' }), 'pattern=src/**/*.js');
  const long = argsToHead({ a: 'x'.repeat(500), b: 'y' });
  assert.ok(long.length <= 121);
  assert.ok(long.endsWith('…'));
});

test('extractTextWindows 取锚点前后文本', () => {
  const events = [
    { type: 'user/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '我想找重复任务' }] } } },
    { type: 'tool/call', time: 1, data: { turn: 1, step: 2, callId: 'c1', name: 'glob', arguments: '{}' } },
    { type: 'tool/result', time: 2, data: { turn: 1, step: 2, message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '找到 3 个' }], isError: false }] } } },
    { type: 'assistant/message', data: { turn: 1, step: 3, message: { content: [{ type: 'text', text: '建议沉淀为技能' }] } } },
  ];
  const win = extractTextWindows(events, { turn: 1, step: 2 }, 4);
  assert.ok(win.before.some((t) => t.includes('我想找重复任务')));
  assert.ok(win.after.some((t) => t.includes('建议沉淀为技能')));
});

test('extractMemorySignals 仅认 memory 类调用', () => {
  const events = [
    { type: 'tool/call', time: 1, data: { turn: 1, step: 1, callId: 'm1', name: 'memory_write', arguments: '{"key":"k","value":"v"}' } },
    { type: 'tool/call', time: 2, data: { turn: 1, step: 2, callId: 'g1', name: 'glob', arguments: '{}' } },
  ];
  const sig = extractMemorySignals(events);
  assert.equal(sig.length, 1);
  assert.equal(sig[0].tool, 'memory_write');
  assert.deepEqual(sig[0].args, { key: 'k', value: 'v' });
});

test('eventToText 从 tool/result 与 message 提取文本', () => {
  const r = { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'x', content: [{ type: 'text', text: 'hi' }] }] } } };
  assert.equal(eventToText(r), 'hi');
  const u = { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'hello' }] } } };
  assert.equal(eventToText(u), 'hello');
  assert.equal(eventToText({ type: 'x' }), null);
});

// 回归（2026-09-17 Phase 2 验收发现）：真实 user/message **没有** data.message 包装，
// 正文直接挂在 data.content。只认 data.message.content 会让全部人类消息不可见
// （实测 401/401 返 null），静默掐死「WHY 取人类意图句」这条主通道。
test('eventToText 认 data.content（真实 user/message 形态，无 message 包装）', () => {
  const real = {
    type: 'user/message',
    data: { content: [{ type: 'text', text: '帮我检查一下 skills_root 里的半成品目录' }], source: { kind: 'user' }, role: 'user', id: 'm1' },
  };
  assert.equal(eventToText(real), '帮我检查一下 skills_root 里的半成品目录');

  // data.content 为裸字符串（旧/异形格式）
  assert.equal(eventToText({ type: 'user/message', data: { content: 'plain text' } }), 'plain text');

  // 多块拼接
  const multi = { type: 'user/message', data: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } };
  assert.equal(eventToText(multi), 'a\nb');

  // data.message.content 仍优先（assistant 形态），且不再因它为空而漏掉 data.content
  const both = {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'from-message' }] }, content: [{ type: 'text', text: 'from-content' }] },
  };
  assert.equal(eventToText(both), 'from-message');

  const emptyMessage = { type: 'user/message', data: { message: { content: [] }, content: [{ type: 'text', text: 'fallback' }] } };
  assert.equal(eventToText(emptyMessage), 'fallback');
});
