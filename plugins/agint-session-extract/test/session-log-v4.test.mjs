/**
 * v4 会话日志支持测试（M1 供料断链工单 / 2026-10-04）。
 *
 * 背景：宿主 2026-09-22 15:52 起把会话日志改名为 `session.v4.jsonl.zstd`。
 * 发现层只列 v3 与无版本名 ⇒ 260 个会话目录不可见，autocreate 供料归零 12 天。
 * 本文件钉四件事：
 *   1. v4 能被发现（且与旧版本并存时取最新）；
 *   2. 名字表落后时后缀兜底仍发现（防下一次改名）；
 *   3. 读不到要出声（静默 [] 是这次拖 12 天的直接原因）；
 *   4. v4 的调用—结果配对与结果文本可读（⛔ 漏了会「看得见但把失败读成没失败」）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listSessionLogs,
  extractToolCalls,
  eventToText,
  sessionLogRank,
  sessionLogFormat,
  SESSION_FILE_NAMES,
  SESSION_LOG_SUFFIX,
} from '../index.js';

/** 造临时 sessions root：spec = { ws: [ { sid: [文件名…] } ] }，返回 { root, warns } */
async function makeRoot(spec) {
  const root = await mkdtemp(join(tmpdir(), 'sess-v4-'));
  for (const [ws, sessions] of Object.entries(spec)) {
    for (const { sid, files } of sessions) {
      await mkdir(join(root, ws, sid), { recursive: true });
      for (const f of files) await writeFile(join(root, ws, sid, f), '');
    }
  }
  const warns = [];
  return { root, warns, warn: (m) => warns.push(m) };
}

const fmtOf = (logs, sid) => logs.find((l) => l.sessionId === sid)?.format ?? null;
const pathOf = (logs, sid) => logs.find((l) => l.sessionId === sid)?.path ?? null;

// ── 1. 发现层 ──────────────────────────────────────────────────────────────

test('v4 单独存在时必须被发现，format=v4', async () => {
  const { root, warn } = await makeRoot({
    ws1: [{ sid: 'sessA', files: ['session.v4.jsonl.zstd'] }],
  });
  const logs = await listSessionLogs(root, { warn });
  assert.equal(logs.length, 1);
  assert.equal(fmtOf(logs, 'sessA'), 'v4');
  assert.ok(pathOf(logs, 'sessA').endsWith('session.v4.jsonl.zstd'));
});

test('v4 与 v3 并存取 v4（版本取新，不再固定取 v3）', async () => {
  const { root, warn } = await makeRoot({
    ws1: [{ sid: 'sessB', files: ['session.v3.jsonl.zstd', 'session.v4.jsonl.zstd'] }],
  });
  const logs = await listSessionLogs(root, { warn });
  assert.equal(logs.length, 1, '同会话只出一条（去重）');
  assert.equal(fmtOf(logs, 'sessB'), 'v4');
});

test('v3 与无版本名并存仍取 v3（旧行为零变化）', async () => {
  const { root, warn } = await makeRoot({
    ws1: [{ sid: 'sessC', files: ['session.jsonl.zstd', 'session.v3.jsonl.zstd'] }],
  });
  const logs = await listSessionLogs(root, { warn });
  assert.equal(fmtOf(logs, 'sessC'), 'v3');
});

test('名字表落后时按后缀兜底：未知 v5 也要发现', async () => {
  // 这条防的是「下一次宿主改名又致盲」——发现不靠名字表。
  assert.ok(!SESSION_FILE_NAMES.includes(`session.v5${SESSION_LOG_SUFFIX}`),
    '用例前提：v5 确实不在名字表里');
  const { root, warn } = await makeRoot({
    ws1: [
      { sid: 'sessD', files: ['session.v5.jsonl.zstd'] },
      { sid: 'sessE', files: ['session.v4.jsonl.zstd', 'session.v5.jsonl.zstd'] },
    ],
  });
  const logs = await listSessionLogs(root, { warn });
  assert.equal(logs.length, 2);
  assert.equal(fmtOf(logs, 'sessD'), 'v5', '未知版本也要如实标出来');
  assert.equal(fmtOf(logs, 'sessE'), 'v5', '并存时取更新的版本');
});

test('派生杂项名不压过正主（.dec.jsonl.zstd rank 低于 session.jsonl.zstd）', async () => {
  const { root, warn } = await makeRoot({
    ws1: [{ sid: 'sessF', files: ['session.jsonl.dec.jsonl.zstd', 'session.jsonl.zstd'] }],
  });
  const logs = await listSessionLogs(root, { warn });
  assert.equal(logs.length, 1);
  assert.equal(fmtOf(logs, 'sessF'), 'jsonl');
});

// ── 2. 出声（这次能拖 12 天就是因为不出声）────────────────────────────────

test('会话目录里没有日志 ⇒ 返回 [] 且 warn 一条', async () => {
  const { root, warns, warn } = await makeRoot({
    ws1: [{ sid: 'sessG', files: ['notes.txt'] }],
  });
  const logs = await listSessionLogs(root, { warn });
  assert.deepEqual(logs, []);
  assert.equal(warns.length, 1, '必须出声');
  assert.match(warns[0], /没发现/);
  assert.match(warns[0], /sess|workspace/, '出声要带可定位的上下文');
});

test('sessions root 不可读 ⇒ warn 一条并返回 []', async () => {
  const warns = [];
  const logs = await listSessionLogs(join(tmpdir(), 'no-such-root-xyz-123'), {
    warn: (m) => warns.push(m),
  });
  assert.deepEqual(logs, []);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /不可读/);
});

test('不传 warn 时默认走 process.emitWarning（宿主日志能收到）', async () => {
  const { root } = await makeRoot({ ws1: [{ sid: 'sessH', files: ['session.v4.jsonl.zstd'] }] });
  const seen = [];
  const onWarning = (w) => seen.push(w);
  process.on('warning', onWarning);
  try {
    const logs = await listSessionLogs(root);
    assert.equal(logs.length, 1);
    assert.equal(seen.length, 0, '正常路径不emit');
  } finally {
    process.off('warning', onWarning);
  }
});

// ── 3. 配对层（v4 的形状变化）─────────────────────────────────────────────

/** v3 形状：id/isError 在 content 的 tool-result 块上 */
const v3Events = [
  { type: 'tool/call', time: 1000, data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a"}' } },
  { type: 'tool/result', time: 1200, data: { turn: 1, step: 1, message: { role: 'tool', content: [
    { type: 'tool-result', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: '文件内容' }] },
  ] } } },
];

/** v4 形状：id/isError 提到 message 层，content 块只剩 text */
const v4Events = [
  { type: 'tool/call', time: 2000, data: { turn: 1, step: 1, callId: 'c9', name: 'rule_check', arguments: '{"x":1}' } },
  { type: 'tool/result', time: 2350, data: { turn: 1, step: 1, message: {
    role: 'tool', toolCallId: 'c9', isError: false, id: 'm1',
    content: [{ type: 'text', text: 'rule_check: NO_MATCH — 没有规则命中这个调用。' }],
  } } },
];

test('v4 事件形状能配对：ok / latencyMs 不再恒 null', async () => {
  const recs = extractToolCalls(v4Events, { sessionId: 's4' });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].ok, true, '配对成功才可能有 ok');
  assert.equal(recs[0].latencyMs, 350);
  assert.equal(recs[0].tool, 'rule_check');
  assert.deepEqual(recs[0].args, { x: 1 });
});

test('v4 失败调用要读成 ok=false（⛔ 不许读成「没有失败」）', async () => {
  const failed = [{
    type: 'tool/result', time: 2600, data: { turn: 1, step: 1, message: {
      role: 'tool', toolCallId: 'c9', isError: true, content: [{ type: 'text', text: 'boom' }],
    } },
  }];
  const recs = extractToolCalls([...v4Events.slice(0, 1), ...failed], { sessionId: 's4' });
  assert.equal(recs[0].ok, false);
});

test('v3 事件形状配对行为零变化（回归钉）', async () => {
  const recs = extractToolCalls(v3Events, { sessionId: 's3' });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].ok, true);
  assert.equal(recs[0].latencyMs, 200);
});

// ── 4. 文本层（提案「为什么/避坑」的取数）──────────────────────────────────

test('eventToText 读得出 v4 结果体文本', async () => {
  const txt = eventToText(v4Events[1]);
  assert.ok(txt, 'v4 结果体是 {type:"text"}，必须可见');
  assert.match(txt, /NO_MATCH/);
});

test('eventToText 对 v3 结果体仍取 tool-result 文本（回归钉）', async () => {
  const txt = eventToText(v3Events[1]);
  assert.match(txt, /文件内容/);
});

test('eventToText 对无文本的 tool/result 如实返回 null', async () => {
  assert.equal(eventToText({ type: 'tool/result', data: { message: { content: [] } } }), null);
});

// ── 5. 纯函数表驱动 ────────────────────────────────────────────────────────

test('sessionLogRank：数字版本优先，杂项殿后', () => {
  assert.ok(sessionLogRank('session.v4.jsonl.zstd') > sessionLogRank('session.v3.jsonl.zstd'));
  assert.ok(sessionLogRank('session.v3.jsonl.zstd') > sessionLogRank('session.jsonl.zstd'));
  assert.ok(sessionLogRank('session.jsonl.zstd') > sessionLogRank('session.jsonl.dec.jsonl.zstd'));
  assert.equal(sessionLogRank('session.v10.jsonl.zstd'), 10, '两位数版本按数值排，不按字典序');
  assert.equal(sessionLogRank('session.jsonl.zstd'), 0);
});

test('sessionLogFormat：版本名如实回显，异形名不编造', () => {
  assert.equal(sessionLogFormat('session.v4.jsonl.zstd'), 'v4');
  assert.equal(sessionLogFormat('session.jsonl.zstd'), 'jsonl');
  assert.equal(sessionLogFormat('session.v5.jsonl.zstd'), 'v5');
  assert.equal(sessionLogFormat('session.weird.jsonl.zstd'), 'session.weird.jsonl.zstd');
});

test('名字表按新→旧排（v4 在 v3 前）', () => {
  assert.deepEqual([...SESSION_FILE_NAMES], [
    'session.v4.jsonl.zstd',
    'session.v3.jsonl.zstd',
    'session.jsonl.zstd',
  ]);
});
