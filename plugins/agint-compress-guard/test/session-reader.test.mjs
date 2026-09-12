// session-reader 单测：多帧 zstd 会话文件的 seq 索引 + shadowedSeqs 回溯。
// 用 node:zlib zstdCompressSync 现做两帧拼接 fixture（与宿主 dsh 持久化格式同构）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { indexSessionFile, listSessionFiles, findShadowedMessages, clearSessionCache } from '../lib/session-reader.js';

const FRAME1 = [
  JSON.stringify({ type: 'session', version: 3, id: 'session-t1', createdAt: 1 }),
  JSON.stringify({ seq: 1, type: 'user/message', data: { content: '第一句：老板拍板了方案 A。' } }),
  JSON.stringify({ seq: 2, type: 'assistant/message', data: { content: '收到。' } }),
  '',
].join('\n');

const FRAME2 = [
  JSON.stringify({ seq: 3, type: 'compaction/summary', data: { compactionId: 'c1', shadowedSeqs: [1, 2], shadowedTokenCount: 50 } }),
  JSON.stringify({ seq: 4, type: 'user/message', data: { content: '压缩后的新消息。' } }),
  '',
].join('\n');

let root;

test.beforeEach(() => {
  clearSessionCache();
  root = mkdtempSync(join(tmpdir(), 'cguard-test-'));
  const sessionDir = join(root, '--D-test--', 'session-t1');
  mkdirSync(sessionDir, { recursive: true });
  // 两帧拼接（append-only 容器）
  const blob = Buffer.concat([zstdCompressSync(Buffer.from(FRAME1)), zstdCompressSync(Buffer.from(FRAME2))]);
  writeFileSync(join(sessionDir, 'session.v3.jsonl.zstd'), blob);
});

test.afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('listSessionFiles：只收 session*.jsonl.zstd，递归子目录', () => {
  const files = listSessionFiles(root);
  assert.equal(files.length, 1);
  assert.ok(files[0].endsWith('session.v3.jsonl.zstd'));
});

test('indexSessionFile：多帧全部解出，seq 索引 1-4 齐全', () => {
  const files = listSessionFiles(root);
  const seqMap = indexSessionFile(files[0]);
  assert.ok(seqMap);
  assert.deepEqual([...seqMap.keys()].sort((a, b) => a - b), [1, 2, 3, 4]);
  assert.equal(seqMap.get(3).type, 'compaction/summary');
});

test('findShadowedMessages：按 shadowedSeqs 回溯被压缩的原始消息', async () => {
  const found = await findShadowedMessages({ shadowedSeqs: [1, 2], sessionId: 'session-t1', sessionsRoot: root });
  assert.equal(found.length, 2);
  const seqs = found.map((f) => f.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, [1, 2]);
  const rec1 = found.find((f) => f.seq === 1);
  assert.ok(JSON.stringify(rec1.record).includes('拍板'), '原文内容仍在文件中（R10：原文可检索）');
});

test('findShadowedMessages：部分命中也返回已找到的（诚实返回，不凑数）', async () => {
  const found = await findShadowedMessages({ shadowedSeqs: [1, 999], sessionId: 'session-t1', sessionsRoot: root });
  assert.equal(found.length, 1);
  assert.equal(found[0].seq, 1);
});

test('findShadowedMessages：空 seq 列表 → 空结果（不扫描）', async () => {
  const found = await findShadowedMessages({ shadowedSeqs: [], sessionId: 'session-t1', sessionsRoot: root });
  assert.deepEqual(found, []);
});

test('跨平台 fixture：正斜杠路径可用；越界 sessionIds 过滤后不误扫', async () => {
  const forwardRoot = root.replace(/\\/g, '/');
  const found = await findShadowedMessages({ shadowedSeqs: [4], sessionId: 'session-t1', sessionsRoot: forwardRoot });
  assert.equal(found.length, 1);
  assert.equal(found[0].seq, 4);
  // ../escape 负向：不存在的 sessionId 过滤后扫不到
  const none = await findShadowedMessages({ shadowedSeqs: [1], sessionId: '../escape', sessionsRoot: forwardRoot });
  assert.deepEqual(none, []);
});

test('缓存生效：同文件二次索引不重复解帧（mtime/size 命中）', () => {
  const files = listSessionFiles(root);
  const m1 = indexSessionFile(files[0]);
  const m2 = indexSessionFile(files[0]);
  assert.equal(m1, m2, '同一 mtime/size 返回缓存实例');
});
