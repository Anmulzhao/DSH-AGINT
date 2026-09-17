/**
 * session-source 适配层测试（Phase 1 数据源切换）。
 *
 * 覆盖三种 source 模式 + 隔离性：
 *   - 'session'    直读会话日志 → aggregator 兼容 record（含 args 真实值）
 *   - 'tool_stats' 仅读 JSONL
 *   - 'both'       合并去重（同 callId 保留 session 侧）
 *   - 缺失 root    空记录、不抛
 *
 * 注：需 zstd 造会话 fixture。WorkBuddy 的 bash shim 在「经 PATH 解析 zstd」时
 * 会崩溃，故通过 resolveZstdBin() 取绝对路径（模块本身支持 ZSTD_BIN 覆盖）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSourceRecords } from '../lib/session-source.js';
import { resolveZstdBin } from '../../agint-session-extract/index.js';

const execFileAsync = promisify(execFile);

/** 把事件数组压成 session.v3.jsonl.zstd 落到 <root>/<ws>/<sid>/。 */
async function writeSessionFixture(root, ws, sid, events) {
  const dir = join(root, ws, sid);
  await mkdir(dir, { recursive: true });
  const jsonl = events.map((e) => JSON.stringify(e)).join('\n');
  const bin = resolveZstdBin();
  const { stdout } = await execFileAsync(bin, ['-c', '-'], { input: jsonl, encoding: 'utf8' });
  await writeFile(join(dir, 'session.v3.jsonl.zstd'), stdout);
}

test('source=session 直读会话日志 → aggregator 兼容 record', async () => {
  if (resolveZstdBin() === 'zstd') return; // 无绝对 zstd → 跳过
  const root = await mkdtemp(join(tmpdir(), 'src-sess-'));
  try {
    await writeSessionFixture(root, 'ws1', 'sessA', [
      { type: 'tool/call', time: 1000, seq: 1, data: { turn: 1, step: 1, callId: 'c1', name: 'glob', arguments: '{"pattern":"src/**/*.js"}' } },
      { type: 'tool/result', time: 1015, seq: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'c1', isError: false }] } } },
    ]);
    const { records, bySource } = await readSourceRecords({
      source: 'session',
      sessionsRoot: root,
      jsonlPath: join(root, 'nonexistent.jsonl'),
    });
    assert.equal(records.length, 1);
    const r = records[0];
    assert.equal(r.tool, 'glob');
    assert.equal(r.sessionId, 'sessA');
    assert.equal(r.turn, 1);
    assert.equal(r.step, 1);
    assert.equal(r.ok, true);
    assert.equal(r.latencyMs, 15);
    // 关键：args 是真实解析值（Phase 0 sampleArgs 死代码的上游保证）
    assert.deepEqual(r.args, { pattern: 'src/**/*.js' });
    assert.equal(bySource.session, 1);
    assert.equal(bySource.tool_stats, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source=tool_stats 只读 JSONL，不碰 sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'src-ts-'));
  try {
    const jsonlPath = join(root, 'tool_stats.jsonl');
    await writeFile(jsonlPath, [
      JSON.stringify({ ts: 500, sessionId: 'x', turn: 1, tool: 'file_read', ok: true, args: { path: 'a' } }),
    ].join('\n'), 'utf8');
    const { records, bySource } = await readSourceRecords({
      source: 'tool_stats',
      sessionsRoot: root,
      jsonlPath,
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].tool, 'file_read');
    assert.equal(bySource.tool_stats, 1);
    assert.equal(bySource.session, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source=both 合并去重：同 callId 保留 session 侧，独立记录保留', async () => {
  if (resolveZstdBin() === 'zstd') return;
  const root = await mkdtemp(join(tmpdir(), 'src-both-'));
  try {
    // session 侧：callId=dup1
    await writeSessionFixture(root, 'ws1', 'sessB', [
      { type: 'tool/call', time: 2000, seq: 1, data: { turn: 2, step: 1, callId: 'dup1', name: 'grep', arguments: '{"pattern":"foo"}' } },
    ]);
    const jsonlPath = join(root, 'tool_stats.jsonl');
    await writeFile(jsonlPath, [
      // 与 session 侧同 callId → 应被去重
      JSON.stringify({ ts: 2000, sessionId: 'sessB', turn: 2, step: 1, tool: 'grep', callId: 'dup1', ok: true, args: { pattern: 'foo' } }),
      // 独立 callId → 保留
      JSON.stringify({ ts: 2100, sessionId: 'sessZ', turn: 3, step: 1, tool: 'file_read', callId: 'other', ok: true, args: { path: 'z' } }),
    ].join('\n'), 'utf8');

    const { records, bySource } = await readSourceRecords({ source: 'both', sessionsRoot: root, jsonlPath });
    assert.equal(bySource.session, 1);
    assert.equal(bySource.tool_stats, 2);
    assert.equal(bySource.dedupedDropped, 1);
    assert.equal(records.length, 2);
    assert.ok(records.some((r) => r.callId === 'dup1'));
    assert.ok(records.some((r) => r.callId === 'other'));
    // session 侧记录带 sessionId（去重保留的是 session 那条）
    const dup = records.find((r) => r.callId === 'dup1');
    assert.equal(dup.sessionId, 'sessB');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source=session 且 sessions 目录不存在 → 空记录不抛', async () => {
  const { records, bySource } = await readSourceRecords({
    source: 'session',
    sessionsRoot: join(tmpdir(), 'nope-xyz-123-does-not-exist'),
    jsonlPath: join(tmpdir(), 'nope-does-not-exist.jsonl'),
  });
  assert.deepEqual(records, []);
  assert.equal(bySource.session, 0);
});

test('sinceMs 过滤：早于窗口的记录被剔除', async () => {
  const root = await mkdtemp(join(tmpdir(), 'src-since-'));
  try {
    const jsonlPath = join(root, 'tool_stats.jsonl');
    await writeFile(jsonlPath, [
      JSON.stringify({ ts: 1000, tool: 'old', callId: 'old1' }),
      JSON.stringify({ ts: 9000, tool: 'new', callId: 'new1' }),
    ].join('\n'), 'utf8');
    const { records } = await readSourceRecords({ source: 'tool_stats', jsonlPath, sinceMs: 5000 });
    assert.equal(records.length, 1);
    assert.equal(records[0].callId, 'new1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
