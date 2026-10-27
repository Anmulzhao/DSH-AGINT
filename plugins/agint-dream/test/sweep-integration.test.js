/**
 * agint-dream: integration tests for the full runSweep after P0 + P2 integration.
 * Verifies: validation gate wired in, recall store write/read/promotedAt, dream.rejected
 * event hook, 30-day pruning.
 *
 * Run with: node --test packages/agint-dream/test/sweep-integration.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSweep } from '../lib/sweep.js';
import { readStoreRobust, listPromotedKeys } from '../lib/recall-store.js';

const execFileAsync = promisify(execFile);
const NOW = Date.parse('2026-09-05T10:00:00.000Z');

async function writeZstdSession(dir, records) {
  const jsonl = records.map((r) => JSON.stringify(r)).join('\n');
  // 用 zstd 压缩（agint-dream sweep 读 .zstd）。
  // Windows 上 zstd 用 stdin pipe 压缩会 hang（不返回 EOF），必须先写临时文件再用 -o 输出。
  const tmpJsonl = join(dir, 'session.jsonl');
  const outPath = join(dir, 'session.jsonl.zstd');
  await writeFile(tmpJsonl, jsonl);
  await execFileAsync('zstd', ['-q', '--no-progress', '-o', outPath, tmpJsonl]);
  await rm(tmpJsonl, { force: true });
}

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'agint-sweep-int-'));
  const sessionsRoot = join(root, 'sessions');
  const diaryRoot = join(root, 'diary');
  const recallPath = join(root, 'recall.jsonl');
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(diaryRoot, { recursive: true });
  const ws = join(sessionsRoot, 'ws-1');
  const s1 = join(ws, 'sess-1');
  const s2 = join(ws, 'sess-2');
  await mkdir(s1, { recursive: true });
  await mkdir(s2, { recursive: true });
  // s1: 老板是创造者（3 条同类信号）
  const s1Records = [
    { type: 'session', id: 's1', seq: 0, time: NOW - 60000 },
    { type: 'user/message', seq: 1, time: NOW - 50000, data: { source: { kind: 'user', rpcId: 'rpc-fixture', clientTimeZone: 'Asia/Shanghai' }, content: [{ type: 'text', text: '老板，以后统一把 AGINT 老板看作创造者，反馈优先级最高' }] } },
    { type: 'user/message', seq: 2, time: NOW - 40000, data: { source: { kind: 'user', rpcId: 'rpc-fixture', clientTimeZone: 'Asia/Shanghai' }, content: [{ type: 'text', text: '老板是创造者，反馈优先级高' }] } },
    { type: 'user/message', seq: 3, time: NOW - 30000, data: { source: { kind: 'user', rpcId: 'rpc-fixture', clientTimeZone: 'Asia/Shanghai' }, content: [{ type: 'text', text: '老板就是创造者' }] } },
  ];
  await writeZstdSession(s1, s1Records);
  // s2: 禁止 rm -rf（不同主题）
  const s2Records = [
    { type: 'session', id: 's2', seq: 0, time: NOW - 60000 },
    { type: 'user/message', seq: 1, time: NOW - 50000, data: { source: { kind: 'user', rpcId: 'rpc-fixture', clientTimeZone: 'Asia/Shanghai' }, content: [{ type: 'text', text: '禁止在生产环境直接 rm -rf 文件' }] } },
    { type: 'user/message', seq: 2, time: NOW - 40000, data: { source: { kind: 'user', rpcId: 'rpc-fixture', clientTimeZone: 'Asia/Shanghai' }, content: [{ type: 'text', text: '禁止在生产环境直接 rm -rf 文件，必须用 trash' }] } },
    { type: 'user/message', seq: 3, time: NOW - 30000, data: { source: { kind: 'user', rpcId: 'rpc-fixture', clientTimeZone: 'Asia/Shanghai' }, content: [{ type: 'text', text: '生产环境禁止 rm -rf' }] } },
  ];
  await writeZstdSession(s2, s2Records);
  return { root, sessionsRoot, diaryRoot, recallPath };
}

function fakeMemory(initial = []) {
  const store = new Map(initial.map((e) => [e.id, e]));
  return {
    list: async () => [...store.values()].map((e) => ({ ...e })),
    write: async (input) => {
      const id = input.id ?? `mem-${store.size + 1}`;
      const rec = { ...input, id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      store.set(id, rec);
      return { ...rec };
    },
    _store: store,
  };
}

test('sweep: LLM operations 齐备时 validation gate 正常放行', async () => {
  const fx = await makeFixture();
  try {
    const mem = fakeMemory();
    const rejectEvents = [];
    const result = await runSweep({
      sessionsRoot: fx.sessionsRoot,
      diaryRoot: fx.diaryRoot,
      memory: mem,
      recallPath: fx.recallPath,
      apply: true,
      nowMs: NOW,
      // 让 dedupe 宽松，避免先被 dedupe 掉
      minScore: 0.0,
      minRecall: 1,
      minUniqueSessions: 1,
      publishReject: async (info) => { rejectEvents.push(info); },
      // 无降级后没有 ctx 就不再走启发式；本用例显式注入 LLM 成功结果。
      consolidation: async (gated) => ({
        ok: true,
        mode: 'llm',
        operations: gated.map((c) => ({ candidateKey: c.key, action: 'added', priorEntries: [] })),
      }),
    });
    assert.equal(result.counts.validationOk, true);
    assert.equal(rejectEvents.length, 0);
    // P2 recall store 写入
    assert.ok(result.counts.recallAppended > 0, 'recall store 应该 append 一些 entry');
    // promoted 应该 >= 0
    assert.ok(result.counts.promoted >= 0);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test('sweep: P0 dream.rejected 事件 hook 触发（operations 数量不对）', async () => {
  const fx = await makeFixture();
  try {
    const mem = fakeMemory();
    const rejectEvents = [];
    // 故意传一个不合法的 operations（数量少于 gated 候选数）
    const result = await runSweep({
      sessionsRoot: fx.sessionsRoot,
      diaryRoot: fx.diaryRoot,
      memory: mem,
      recallPath: fx.recallPath,
      apply: true,
      nowMs: NOW,
      minScore: 0.0,
      minRecall: 1,
      minUniqueSessions: 1,
      operations: [{ candidateKey: 'nope', action: 'added', priorEntries: [] }], // 数量不对
      publishReject: async (info) => { rejectEvents.push(info); },
    });
    // operations 数量 != gated 候选数 → validateAndApply 返回 ok=false → publishReject 被调用
    // （gated 候选数为 3，传了 1 个 operation，数量不匹配）
    assert.equal(result.counts.validationOk, false, 'validation 应因 operations 数量不匹配被拒');
    assert.equal(rejectEvents.length, 1, 'publishReject 应被触发一次');
    assert.equal(rejectEvents[0].gatedCount, result.counts.gated, 'reject 载荷应带 gatedCount');
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test('sweep: P2 recall store 跨 sweep 累积 promotedAt', async () => {
  const fx = await makeFixture();
  try {
    const mem = fakeMemory();
    // 第一次 sweep：写候选
    const r1 = await runSweep({
      sessionsRoot: fx.sessionsRoot,
      diaryRoot: fx.diaryRoot,
      memory: mem,
      recallPath: fx.recallPath,
      apply: true,
      nowMs: NOW,
      minScore: 0.0,
      minRecall: 1,
      minUniqueSessions: 1,
    });
    assert.ok(r1.counts.recallAppended > 0, 'sweep 1 应该 append recall store');

    // 检查 recall store 状态
    const r1Store = await readStoreRobust(fx.recallPath, NOW);
    assert.ok(r1Store.entries.size > 0, 'recall store 应该有 entry');
    const beforePromoted = await listPromotedKeys(fx.recallPath);
    // apply=true 应该把 promotedAt 写回去
    if (r1.counts.promoted > 0) {
      assert.ok(beforePromoted.length > 0, 'apply=true 后 promotedAt 应该非空');
    }

    // 第二次 sweep：同样的 fixture，看 recall store 是否累积 recallCount
    const mem2 = fakeMemory();
    const r2 = await runSweep({
      sessionsRoot: fx.sessionsRoot,
      diaryRoot: fx.diaryRoot,
      memory: mem2,
      recallPath: fx.recallPath,
      apply: true,
      nowMs: NOW + 24 * 60 * 60 * 1000, // 第二天
      minScore: 0.0,
      minRecall: 1,
      minUniqueSessions: 1,
    });
    const r2Store = await readStoreRobust(fx.recallPath, NOW + 24 * 60 * 60 * 1000);
    assert.ok(r2Store.entries.size >= r1Store.entries.size, 'recall store 应该累积');
    // 同一 key 的 recallCount 应该累加
    const sampleKey = [...r1Store.entries.keys()][0];
    const e1 = r1Store.entries.get(sampleKey);
    const e2 = r2Store.entries.get(sampleKey);
    if (e1 && e2) {
      assert.ok(e2.recallCount >= e1.recallCount, `recallCount 应该累加或保持: ${e1.recallCount} → ${e2.recallCount}`);
    }
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test('sweep: 30 天剪枝（apply=true 时跑）', async () => {
  const fx = await makeFixture();
  try {
    const mem = fakeMemory();
    const result = await runSweep({
      sessionsRoot: fx.sessionsRoot,
      diaryRoot: fx.diaryRoot,
      memory: mem,
      recallPath: fx.recallPath,
      apply: true,
      nowMs: NOW,
      minScore: 0.0,
      minRecall: 1,
      minUniqueSessions: 1,
    });
    // recallPruned 应该 >= 0
    assert.ok(result.counts.recallPruned >= 0, 'recallPruned 字段应该存在');
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test('sweep: diary markdown 含 P0/P2 扩展字段', async () => {
  const fx = await makeFixture();
  try {
    const mem = fakeMemory();
    const result = await runSweep({
      sessionsRoot: fx.sessionsRoot,
      diaryRoot: fx.diaryRoot,
      memory: mem,
      recallPath: fx.recallPath,
      apply: true,
      nowMs: NOW,
      minScore: 0.0,
      minRecall: 1,
      minUniqueSessions: 1,
    });
    const { readFile } = await import('node:fs/promises');
    const diary = await readFile(result.diaryPath, 'utf8');
    assert.match(diary, /Deep — 评分与提升/, 'diary 应有 Deep 段');
    assert.match(diary, /Light — 信号采集/, 'diary 应有 Light 段');
    assert.match(diary, /REM — 候选提炼/, 'diary 应有 REM 段');
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

// ── 2026-10-09 回归：deep-recovery 通道重复写入本轮主通道刚提升的候选 ──────
//
// 复现条件（对齐生产实况 agint.json 里 6 条 `deep-recovery from` 重复条目）：
// 同一条主张跨 ≥2 天、≥3 条信号 ⇒ 主通道提升它，同时 recovery 通道的
// signalCount>=3 && uniqueDays>=2 门槛也放行它。
// 修前：existing 是 sweep.js:1166 的陈旧快照（不含本轮 promoted）+ recovery
//      没有主通道 1173-1176 那道 promotedAt 过滤 ⇒ 同内容写两遍。
// 修后：promotedKeys 过滤 + existingForRecovery 回灌 ⇒ 只写一遍。
test('sweep: deep-recovery 不得重复写入本轮主通道刚提升的候选', async () => {
  const fx = await makeFixture();
  try {
    const mem = fakeMemory();
    const CLAIM = '以后统一把配置文件放在仓库根目录，禁止散落到各插件目录下';
    // 跨 3 天各 1 条同主张信号 → uniqueDays=3 / signalCount=3
    // （session 文件 mtime 决定能否被 listSessionLogs 扫到，故直接写当前）
    for (let d = 0; d < 3; d += 1) {
      const ws = join(fx.sessionsRoot, 'ws-day');
      const sd = join(ws, `sess-day-${d}`);
      await mkdir(sd, { recursive: true });
      const ts = NOW - d * 86400_000;
      await writeZstdSession(sd, [
        { type: 'session', id: `sess-day-${d}`, seq: 0, time: ts },
        { type: 'user/message', seq: 1, time: ts + 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: CLAIM }] } },
      ]);
    }
    const result = await runSweep({
      sessionsRoot: fx.sessionsRoot,
      diaryRoot: fx.diaryRoot,
      memory: mem,
      recallPath: fx.recallPath,
      apply: true,
      recover: true,
      deepRecoveryDays: 30,
      remLookbackDays: 7,
      nowMs: NOW,
      minScore: 0.0,
      minRecall: 1,
      minUniqueSessions: 1,
    });
    // 判据不是「promoted 了多少」，而是「同内容有没有写两遍」——
    // 这正是生产上漏掉的那一层（只数条数看不出重复）。
    const byContent = new Map();
    for (const e of mem._store.values()) {
      const c = (e.content ?? '').trim();
      byContent.set(c, (byContent.get(c) ?? 0) + 1);
    }
    const dupes = [...byContent.entries()].filter(([, n]) => n > 1);
    assert.equal(
      dupes.length,
      0,
      `deep-recovery 不应重写主通道已提升的候选，实际重复：${JSON.stringify(dupes.map(([c, n]) => [c.slice(0, 40), n]))}`,
    );
    // 该主张确实被提升了（否则上面的断言是空转）
    assert.ok(
      [...mem._store.values()].some((e) => (e.content ?? '').includes('禁止散落到各插件目录下')),
      '该主张应至少被提升一次（否则重复断言没意义）',
    );
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});
