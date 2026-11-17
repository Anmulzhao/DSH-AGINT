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
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
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

test('inspectSessionFile: 正常会话无异常（坏行 0 / seq 断裂 0 / 缺 content 0）', { skip: !existsSync(resolveZstd()) ? 'zstd unavailable' : false }, async () => {
  const { dir, file, sessionId } = makeSessionFile({ broken: 0, seqGaps: false, missingContentCount: 0, unpaired: false });
  try {
    const insp = await inspectSessionFile({ path: file, sessionId, mtimeMs: Date.now() - 48 * 60 * 60 * 1000 });
    assert.equal(insp.badLines, 0);
    assert.equal(insp.seqGaps, 0);
    assert.equal(insp.missingContent, 0);
    assert.ok(insp.totalLines >= 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inspectSessionFile: 坏行 + seq 断裂 + 缺 content + 未配对 call 全部检出', { skip: !existsSync(resolveZstd()) ? 'zstd unavailable' : false }, async () => {
  const { dir, file, sessionId } = makeSessionFile({ broken: 3, seqGaps: true, missingContentCount: 3, unpaired: true });
  try {
    const insp = await inspectSessionFile({ path: file, sessionId, mtimeMs: Date.now() - 48 * 60 * 60 * 1000 });
    assert.ok(insp.badLines >= 3, `badLines=${insp.badLines}`);
    assert.ok(insp.seqGaps >= 1, `seqGaps=${insp.seqGaps}`);   // seq 3 被跳过 → 2→4 断裂
    assert.ok(insp.missingContent >= 3, `missingContent=${insp.missingContent}`);
    assert.ok(insp.unpairedCalls >= 1, `unpairedCalls=${insp.unpairedCalls}`);
    assert.equal(insp.isRecent, false);                          // 48h 前 → 非进行中
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ⛔ 2026-10-21 回退（运行态取证）：本通道**只读本地原始日志**，不走上游。
// 判据：inspectSessionFile 不接受 sessionSource（签名里没有这个参数），
// 且 listRecentSessions 必须给出**可解压的本地路径**（上游记录不含 path）。
test('⛔ inspectSessionFile: 不接受上游（签名无 sessionSource ⇒ 只能读原始日志）', () => {
  const src = readFileSync(new URL('../lib/channels/self-observation.js', import.meta.url), 'utf8');
  const sig = /export async function inspectSessionFile\(([^)]*)\)/.exec(src);
  assert.ok(sig, '必须能定位到 inspectSessionFile 的签名');
  assert.ok(
    !/sessionSource/.test(sig[1]),
    `inspectSessionFile 的签名不该再收 sessionSource（实际：${sig[1].trim()}）`,
  );
});

test('⛔ listRecentSessions: 必须给可解压的本地路径（上游记录无 path ⇒ 会全判 undecompressible）', async () => {
  const oldHome = process.env.DSH_HOME;
  const root = mkdtempSync(join(tmpdir(), 'agint-sesspath-'));
  try {
    const sessRoot = join(root, 'sessions');
    mkdirSync(join(sessRoot, 'ws-a', 'sid-p'), { recursive: true });
    writeFileSync(join(sessRoot, 'ws-a', 'sid-p', 'session.v4.jsonl.zstd'), 'x');
    process.env.DSH_HOME = root;
    const logs = await listRecentSessions(8);
    assert.equal(logs.length, 1);
    assert.ok(logs[0].path && logs[0].path.length > 0, `path 不能是空串（实际：${JSON.stringify(logs[0].path)}）`);
    assert.equal(logs[0].sessionId, 'sid-p');
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  }
});

// 2026-10-19 新增：宿主改名兜底。
// 背景：这里原先硬编码 v4/v3/无版本三个名字且**无后缀兜底**，宿主下次改名（v5）
// 会再瞎一次 —— 09-22 改 v4 时同类事故让 autocreate 供料断了 12 天（M1 断链）。
// 判据：造一个**三个候选名都不叫**的新格式，必须仍能发现（靠 .jsonl.zstd 后缀）。
test('⛔ 宿主再次改名（v5）不得归零 —— 后缀兜底必须生效', async () => {
  const oldHome = process.env.DSH_HOME;
  const root = mkdtempSync(join(tmpdir(), 'agint-sessv5-'));
  try {
    const sessRoot = join(root, 'sessions');
    mkdirSync(join(sessRoot, 'ws-a', 'sid-v5'), { recursive: true });
    // 故意不叫 session.v4/v3/session.jsonl —— 模拟宿主下次改名
    writeFileSync(join(sessRoot, 'ws-a', 'sid-v5', 'session.v9.jsonl.zstd'), 'x');
    process.env.DSH_HOME = root;
    const logs = await listRecentSessions(8);
    assert.equal(logs.length, 1, '未知名但后缀匹配，必须被发现（不得归零）');
    assert.ok(logs[0].path.endsWith('session.v9.jsonl.zstd'));
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  }
});

// 2026-10-19：listRecentSessions 改异步（要走 agint-session-source 的上游探测），
// 调用方必须 await。不 await 会拿到 Promise 而不是数组 —— 这类错误静默且难查。
test('listRecentSessions: 按 mtime 取最近 N 个，多格式只取最新存在者', async () => {
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
    const logs = await listRecentSessions(8);
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

// ── 2026-11-02：假读数治理 —— 设计路径不得被报成「降级」 ─────────────────
// 背景：2026-10-21 回退时，listRecentSessions 每次调用都 notify 一条
//   `local-by-design: ...` 到默认 console.warn ⇒ 每周一条「会话源降级」。
// 但本通道**按设计**读原始日志（上游是重放校验后的产物，拿它做完整性检查 = 检测能力归零），
// 那不是降级。v0.13.0 静默失败治理治的是「真故障不吭声」，这条是「没事喊狼来了」——
// 方向相反，同样是假读数。
test('⛔ 设计路径不得报降级：正常发现会话时不得往 console.warn 写任何东西', async () => {
  const oldHome = process.env.DSH_HOME;
  const root = mkdtempSync(join(tmpdir(), 'agint-sessquiet-'));
  const warns = [];
  const origWarn = console.warn;
  try {
    const sessRoot = join(root, 'sessions');
    mkdirSync(join(sessRoot, 'ws-a', 'sid-q'), { recursive: true });
    writeFileSync(join(sessRoot, 'ws-a', 'sid-q', 'session.v4.jsonl.zstd'), 'x');
    process.env.DSH_HOME = root;
    console.warn = (...args) => { warns.push(args.map(String).join(' ')); };

    const logs = await listRecentSessions(8);
    assert.equal(logs.length, 1);
    assert.equal(
      logs[0].sourceMode,
      'local-raw',
      '必须显式标注这是设计路径，不能让下游靠「有没有告警」猜',
    );
    assert.deepEqual(warns, [], '设计路径不该告警（实际：' + JSON.stringify(warns) + '）');
  } finally {
    console.warn = origWarn;
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  }
});

// 阴性对照：与上一条成对。若哪天有人顺手把 onFallback 也删了（「反正不告警了」），
// 这条必须红 —— 真降级（一个会话都没找到）必须出声，否则「扫了 0 个」与
// 「扫了 8 个都没问题」在 health 面上又长得一样。
test('阴性对照：真降级（候选名 + 后缀兜底全没命中）必须出声', async () => {
  const oldHome = process.env.DSH_HOME;
  const root = mkdtempSync(join(tmpdir(), 'agint-sessempty-'));
  try {
    mkdirSync(join(root, 'sessions'), { recursive: true }); // 空目录：没有任何会话
    process.env.DSH_HOME = root;
    const seen = [];
    const logs = await listRecentSessions(8, { onFallback: (r) => seen.push(r) });
    assert.equal(logs.length, 0);
    assert.equal(seen.length, 1, '真降级必须出声一次（不是 0 次，也不是每次都喊）');
    assert.ok(/no-session-log-found/.test(seen[0]), '出声原因要可判（实际：' + seen[0] + '）');
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  }
});
