/**
 * agint-dream: 会话日志命名兼容性回归（2026-09-17）。
 *
 * 背景：宿主自 2026-09-10 起把会话日志命名为 `session.v3.jsonl.zstd`，
 * 而 lib/sweep.js 当时只按精确名 `session.jsonl.zstd` 查找 → Light 通道
 * 连续 7 天扫到 0 个会话，dream_status 仍报 validation=OK。
 * 现有 sweep-integration.test.js 的 fixture 恰好用旧命名，所以没暴露。
 * 本文件固定：v3 命名 / 旧命名 / 未来改名（后缀兜底）/ 窗口过滤 / 噪声文件。
 *
 * Run with: node --test test/session-log-naming.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSessionLogs, resolveSessionLogPath } from '../lib/sweep.js';

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'agint-dream-naming-'));
  const ws = join(root, '--D-DSH--');
  await mkdir(ws, { recursive: true });
  return { root, ws };
}

async function touchSession(ws, dirName, fileName, ageDays = 0) {
  const d = join(ws, dirName);
  await mkdir(d, { recursive: true });
  const p = join(d, fileName);
  await writeFile(p, 'x');
  if (ageDays > 0) {
    const old = new Date(Date.now() - ageDays * 86400000);
    await utimes(p, old, old);
  }
  return p;
}

test('listSessionLogs 同时识别 v3 命名与旧命名', async () => {
  const { root, ws } = await makeRoot();
  try {
    await touchSession(ws, 'sess-v3', 'session.v3.jsonl.zstd');
    await touchSession(ws, 'sess-legacy', 'session.jsonl.zstd');
    const logs = await listSessionLogs(root, 2, 50);
    assert.equal(logs.length, 2, 'v3 与旧命名都应被列出');
    assert.ok(logs.some((l) => l.path.endsWith('session.v3.jsonl.zstd')));
    assert.ok(logs.some((l) => l.path.endsWith('session.jsonl.zstd')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('宿主再次改名时按后缀兜底，不静默失效', async () => {
  const { root, ws } = await makeRoot();
  try {
    await touchSession(ws, 'sess-future', 'session.v9.jsonl.zstd');
    const logs = await listSessionLogs(root, 2, 50);
    assert.equal(logs.length, 1);
    assert.ok(logs[0].path.endsWith('session.v9.jsonl.zstd'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('lookback 窗口仍然过滤旧会话', async () => {
  const { root, ws } = await makeRoot();
  try {
    await touchSession(ws, 'sess-old', 'session.v3.jsonl.zstd', 10);
    const logs = await listSessionLogs(root, 2, 50);
    assert.equal(logs.length, 0, '10 天前的会话不应进入 2 天窗口');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('噪声文件不被误收（dec / state / 非会话）', async () => {
  const { root, ws } = await makeRoot();
  try {
    await touchSession(ws, 'sess-noise', 'session.jsonl.dec.jsonl');
    await touchSession(ws, 'sess-noise', 'state.json');
    const logs = await listSessionLogs(root, 2, 50);
    assert.equal(logs.length, 0, 'dec/state 不应被当作会话日志');
    assert.equal(await resolveSessionLogPath(ws, 'sess-noise'), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});