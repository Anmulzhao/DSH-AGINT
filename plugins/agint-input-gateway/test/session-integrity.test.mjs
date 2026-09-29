/**
 * session 完整性检测器测试（v0.3.0 实装）。
 * 真调 inspectSessionFile / listRecentSessions：
 *   - 用 zstd 造"损坏会话文件"（坏行 + seq 断裂 + 缺 content + 未配对 call）
 *   - 用真实格式的正常会话 → 无异常
 * 需要 zstd（D:/Tools/zstd/zstd 或 PATH），不可用时 skip。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectSessionFile, listRecentSessions } from '../lib/channels/self-observation.js';

function resolveZstd() {
  if (process.env.ZSTD_BIN) return process.env.ZSTD_BIN;
  const fallback = ['D:/Tools/zstd/zstd.exe', 'C:/Tools/zstd/zstd.exe', 'D:/Tools/zstd/zstd', 'C:/Tools/zstd/zstd', 'zstd'];
  for (const p of fallback) {
    try { if (existsSync(p)) return p; } catch { /* ignore */ }
  }
  return 'zstd';
}

function makeSessionFile({ broken, seqGaps, missingContentCount, unpaired, baseMtimeAgoMs }) {
  const dir = mkdtempSync(join(tmpdir(), 'agint-sessint-'));
  const ws = join(dir, 'ws-test');
  const sid = 'session-abc123';
  const sessionDir = join(ws, sid);
  mkdirSync(sessionDir, { recursive: true });

  const lines = [];
  lines.push(JSON.stringify({ type: 'session', version: 4, id: sid, createdAt: new Date().toISOString(), cwd: '/tmp', agentPreset: 'agint' }));
  const events = [];
  events.push({ type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } });
  events.push({ type: 'message', seq: 1, time: 2, data: { content: 'hello' } });
  events.push({ type: 'tool/call', seq: 2, time: 3, data: { turn: 0, step: 0, callId: 'call-1', name: 'bash', arguments: '{}' } });
  // 正常应有 seq 3 的 tool/result；构造 seqGaps 时跳过它
  if (!seqGaps) {
    events.push({ type: 'tool/result', seq: 3, time: 4, data: { turn: 0, step: 0, message: { content: [{ type: 'tool-result', toolCallId: 'call-1', content: ['ok'], isError: false }] } } });
  } else {
    events.push({ type: 'tool/result', seq: 4, time: 4, data: { turn: 0, step: 0, message: { content: [{ type: 'tool-result', toolCallId: 'call-1', content: ['ok'], isError: false }] } } });
  }
  events.push({ type: 'message', seq: 4, time: 5, data: { content: 'world' } });
  for (const e of events) lines.push(JSON.stringify(e));

  // 缺 content 事件
  for (let i = 0; i < missingContentCount; i++) {
    lines.push(JSON.stringify({ type: 'message', seq: 100 + i, time: 100 + i, data: { content: '' } }));
  }

  // 坏行
  if (broken) {
    for (let i = 0; i < broken; i++) lines.push('this-is-not-json-line-' + i);
  }

  // 未配对 call
  if (unpaired) {
    lines.push(JSON.stringify({ type: 'tool/call', seq: 200, time: 200, data: { turn: 1, step: 0, callId: 'call-orphan', name: 'bash', arguments: '{}' } }));
  }

  const file = join(sessionDir, 'session.v4.jsonl.zstd');
  const plain = join(sessionDir, 'session.v4.jsonl.tmp');
  writeFileSync(plain, lines.join('\n') + '\n', 'utf8');
  const bin = resolveZstd();
  execFileSync(bin, ['-f', '-q', plain, '-o', file], { stdio: 'pipe' });
  rmSync(plain, { force: true });
  return { dir, file, sessionId: sid, mtimeMs: Date.now() - (baseMtimeAgoMs ?? 48 * 60 * 60 * 1000) };
}

test('inspectSessionFile: 正常会话无异常（坏行 0 / seq 断裂 0 / 缺 content 0）', { skip: !existsSync(resolveZstd()) ? 'zstd unavailable' : false }, () => {
  const { dir, file, sessionId } = makeSessionFile({ broken: 0, seqGaps: false, missingContentCount: 0, unpaired: false });
  try {
    const insp = inspectSessionFile({ path: file, sessionId, mtimeMs: Date.now() - 48 * 60 * 60 * 1000 });
    assert.equal(insp.badLines, 0);
    assert.equal(insp.seqGaps, 0);
    assert.equal(insp.missingContent, 0);
    assert.ok(insp.totalLines >= 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inspectSessionFile: 坏行 + seq 断裂 + 缺 content + 未配对 call 全部检出', { skip: !existsSync(resolveZstd()) ? 'zstd unavailable' : false }, () => {
  const { dir, file, sessionId } = makeSessionFile({ broken: 3, seqGaps: true, missingContentCount: 3, unpaired: true });
  try {
    const insp = inspectSessionFile({ path: file, sessionId, mtimeMs: Date.now() - 48 * 60 * 60 * 1000 });
    assert.ok(insp.badLines >= 3, `badLines=${insp.badLines}`);
    assert.ok(insp.seqGaps >= 1, `seqGaps=${insp.seqGaps}`);   // seq 3 被跳过 → 2→4 断裂
    assert.ok(insp.missingContent >= 3, `missingContent=${insp.missingContent}`);
    assert.ok(insp.unpairedCalls >= 1, `unpairedCalls=${insp.unpairedCalls}`);
    assert.equal(insp.isRecent, false);                          // 48h 前 → 非进行中
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listRecentSessions: 按 mtime 取最近 N 个，多格式只取最新存在者', () => {
  const oldHome = process.env.DSH_HOME;
  const root = mkdtempSync(join(tmpdir(), 'agint-sesslist-'));
  try {
    const sessRoot = join(root, 'sessions');
    mkdirSync(join(sessRoot, 'ws-a', 'sid-1'), { recursive: true });
    mkdirSync(join(sessRoot, 'ws-a', 'sid-2'), { recursive: true });
    // sid-1 同时有 v4 + jsonl（应只收 v4）；sid-2 只有 v3
    writeFileSync(join(sessRoot, 'ws-a', 'sid-1', 'session.v4.jsonl.zstd'), 'x');
    writeFileSync(join(sessRoot, 'ws-a', 'sid-1', 'session.jsonl.zstd'), 'x');
    writeFileSync(join(sessRoot, 'ws-a', 'sid-2', 'session.v3.jsonl.zstd'), 'x');
    process.env.DSH_HOME = root;
    const logs = listRecentSessions(8);
    assert.equal(logs.length, 2);
    const ids = logs.map((l) => l.sessionId).sort();
    assert.deepEqual(ids, ['sid-1', 'sid-2']);
    const s1 = logs.find((l) => l.sessionId === 'sid-1');
    assert.ok(s1.path.endsWith('session.v4.jsonl.zstd'), 'sid-1 应优先收 v4 格式');
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  }
});
