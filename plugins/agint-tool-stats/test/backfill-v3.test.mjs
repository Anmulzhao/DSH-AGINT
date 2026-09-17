/**
 * backfill 的 v3 会话覆盖回归测试（Phase 1，2026-09-17）。
 *
 * 历史 bug：backfill 的 listSessionLogs 只认 `session.jsonl.zstd`，漏读全部
 * `session.v3.jsonl.zstd` 会话 → 这些会话的 turn/step/latency 永远补不上。
 * 修复：复用中立提取器 agint-session-extract（双格式 + 去重）。
 *
 * 本测试用 v3 会话 fixture 锁定该修复。
 * 注：需 zstd 造 fixture，通过 resolveZstdBin() 取绝对路径（绕开 bash shim）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backfill } from '../lib/index.js';
import { resolveZstdBin } from '../../agint-session-extract/index.js';

const execFileAsync = promisify(execFile);

async function writeV3Session(root, ws, sid, events) {
  const dir = join(root, ws, sid);
  await mkdir(dir, { recursive: true });
  const jsonl = events.map((e) => JSON.stringify(e)).join('\n');
  const bin = resolveZstdBin();
  const { stdout } = await execFileAsync(bin, ['-c', '-'], { input: jsonl, encoding: 'utf8' });
  await writeFile(join(dir, 'session.v3.jsonl.zstd'), stdout);
}

test('backfill 能从 v3 会话补齐 turn/step/sessionId（历史的 v3 漏读）', async () => {
  if (resolveZstdBin() === 'zstd') return; // 无绝对 zstd → 跳过
  const root = await mkdtemp(join(tmpdir(), 'bf-v3-'));
  try {
    const sessionsRoot = join(root, 'sessions');
    // v3 会话里有一条 tool/call，callId=v3call1，turn=7 step=2
    await writeV3Session(sessionsRoot, 'ws1', 'sessV3', [
      { type: 'tool/call', time: 5000, seq: 1, data: { turn: 7, step: 2, callId: 'v3call1', name: 'file_read', arguments: '{"path":"x"}' } },
      { type: 'tool/result', time: 5120, seq: 2, data: { turn: 7, step: 2, message: { content: [{ type: 'tool-result', toolCallId: 'v3call1', isError: false }] } } },
    ]);

    // tool_stats 记录：只有 callId + ts，缺 turn/step/sessionId（emit 路径的典型缺口）
    const jsonlPath = join(root, 'tool_stats.jsonl');
    await writeFile(jsonlPath, JSON.stringify({
      ts: 5120, sessionId: null, turn: null, step: null,
      tool: 'file_read', callId: 'v3call1', latencyMs: null, ok: true, args: { path: 'x' },
    }) + '\n', 'utf8');

    const result = await backfill(sessionsRoot, jsonlPath);
    assert.equal(result.records, 1);
    assert.equal(result.sessions, 1);       // ← 修复前此处为 0（v3 被漏读）
    assert.equal(result.updated, 1);

    const out = JSON.parse((await readFile(jsonlPath, 'utf8')).trim());
    assert.equal(out.turn, 7);
    assert.equal(out.step, 2);
    assert.equal(out.sessionId, 'sessV3');
    assert.equal(out.latencyMs, 120);       // ts - callTs = 5120 - 5000
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('backfill 幂等：二次跑不再改动（updated=0）', async () => {
  if (resolveZstdBin() === 'zstd') return;
  const root = await mkdtemp(join(tmpdir(), 'bf-idem-'));
  try {
    const sessionsRoot = join(root, 'sessions');
    await writeV3Session(sessionsRoot, 'ws1', 'sessA', [
      { type: 'tool/call', time: 1000, seq: 1, data: { turn: 1, step: 1, callId: 'c1', name: 'glob', arguments: '{}' } },
    ]);
    const jsonlPath = join(root, 'tool_stats.jsonl');
    await writeFile(jsonlPath, JSON.stringify({ ts: 1000, tool: 'glob', callId: 'c1' }) + '\n', 'utf8');

    const first = await backfill(sessionsRoot, jsonlPath);
    assert.equal(first.updated, 1);
    const second = await backfill(sessionsRoot, jsonlPath);
    assert.equal(second.updated, 0); // 已补齐 → 不再变
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
