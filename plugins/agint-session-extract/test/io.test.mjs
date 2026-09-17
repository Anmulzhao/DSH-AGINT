/**
 * agint-session-extract I/O 集成测试。
 * - listSessionLogs 双格式去重（占位文件即可，不需 zstd）
 * - readSessionRecords 真实 zstd 往返（需 zstd 二进制，缺失则跳）
 *
 * 注：WorkBuddy 的 bash shim 在「经 PATH 解析 zstd」时会崩溃，故本测试通过
 * ZSTD_BIN 指向绝对路径来绕过（模块本身支持 ZSTD_BIN 覆盖）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSessionLogs, readSessionRecords, resolveZstdBin } from '../index.js';

const execFileAsync = promisify(execFile);

test('listSessionLogs 双格式去重：同会话优先 v3', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sess-extract-'));
  try {
    // sessA: 双格式并存 → 只取 v3
    await mkdir(join(root, 'ws1', 'sessA'), { recursive: true });
    await writeFile(join(root, 'ws1', 'sessA', 'session.v3.jsonl.zstd'), '');
    await writeFile(join(root, 'ws1', 'sessA', 'session.jsonl.zstd'), '');
    // sessB: 仅 jsonl
    await mkdir(join(root, 'ws1', 'sessB'), { recursive: true });
    await writeFile(join(root, 'ws1', 'sessB', 'session.jsonl.zstd'), '');
    // sessC: 仅 v3（另一 workspace）
    await mkdir(join(root, 'ws2', 'sessC'), { recursive: true });
    await writeFile(join(root, 'ws2', 'sessC', 'session.v3.jsonl.zstd'), '');

    const logs = await listSessionLogs(root);
    assert.equal(logs.length, 3);
    const a = logs.find((l) => l.sessionId === 'sessA');
    assert.equal(a.format, 'v3'); // 双格式取 v3（去重）
    const b = logs.find((l) => l.sessionId === 'sessB');
    assert.equal(b.format, 'jsonl');
    const c = logs.find((l) => l.sessionId === 'sessC');
    assert.equal(c.format, 'v3');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('listSessionLogs 空 root / 不存在 root → []', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sess-empty-'));
  try {
    assert.deepEqual(await listSessionLogs(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.deepEqual(await listSessionLogs(join(tmpdir(), 'does-not-exist-xyz')), []);
});

test('readSessionRecords 真实 zstd 往返：解析 tool/call + 配对 result', async () => {
  const bin = resolveZstdBin();
  if (bin === 'zstd') return; // 回退到 PATH 解析 → 本 harness 不可用，跳过
  const root = await mkdtemp(join(tmpdir(), 'sess-rt-'));
  try {
    const dir = join(root, 'ws', 'sess1');
    await mkdir(dir, { recursive: true });
    const jsonl = [
      JSON.stringify({ type: 'tool/call', time: 1000, seq: 1, data: { turn: 1, step: 1, callId: 'c1', name: 'glob', arguments: '{"pattern":"src/**/*.js"}' } }),
      JSON.stringify({ type: 'tool/result', time: 1015, seq: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false }] } } }),
      JSON.stringify({ type: 'tool/call', time: 2000, seq: 3, data: { turn: 1, step: 2, callId: 'c2', name: 'grep', arguments: '{"pattern":"foo"}' } }),
    ].join('\n');
    const file = join(dir, 'session.v3.jsonl.zstd');
    const { stdout } = await execFileAsync(bin, ['-c', '-'], { input: jsonl, encoding: 'utf8' });
    await writeFile(file, stdout);
    // 确认真的写成了 zstd（magic 25 232 35 1）
    const magic = Buffer.from(await import('node:fs/promises').then((fs) => fs.readFile(file)));
    assert.deepEqual([...magic.slice(0, 4)], [0x28, 0xb5, 0x2f, 0xfd]);

    const recs = await readSessionRecords(root);
    assert.equal(recs.length, 2);
    const c1 = recs.find((r) => r.callId === 'c1');
    assert.equal(c1.tool, 'glob');
    assert.equal(c1.ok, true);
    assert.equal(c1.latencyMs, 15);
    assert.equal(c1.sessionId, 'sess1');
    const c2 = recs.find((r) => r.callId === 'c2');
    assert.equal(c2.ok, null); // 无 result
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
