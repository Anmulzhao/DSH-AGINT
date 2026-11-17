/**
 * test/smoke.mjs — agint-tool-stats smoke test（2026-11-12）
 *
 * 覆盖两件新做的事（参数指纹化 + 保留机制），外加一条读侧降级：
 *   ① storeArgs:false ⇒ 写出的行**不含** `args` 键，含 `argsBytes` + `argsPreview`；
 *   ② storeArgs:true  ⇒ 写出的行含 `args`（回退到旧行为）；
 *   ③ prune 删掉超期行、30 天内的行不被删、rollup 行数正确（含同键合并）；
 *   ④ dryRun:true ⇒ **不产生任何文件变化**（明细字节/行数不变、rollup 不落盘）；
 *   ⑤ 读侧降级：记录没有 args 时 repeatPatterns 不抛错，标注 argsUnavailable。
 *
 * 另加两条配置通路验证（防止"函数对了但配置没接上"）：
 *   ⑥ apply(ctx, {storeArgs:false}) 默认关 ⇒ 事件写入的行不带 args；
 *   ⑦ apply(ctx, {storeArgs:true})  ⇒ 事件写入的行带 args。
 *
 * 运行：node plugins/agint-tool-stats/test/smoke.mjs（exit 0 = 全绿）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REAL_LIB = resolve(__dirname, '../lib/index.js');

const { apply, persist, Config } = await import(pathToFileURL(REAL_LIB).href);
const { pruneToolStats, weekKeyOf } = await import(
  pathToFileURL(resolve(__dirname, '../lib/prune.js')).href
);
const { repeatPatterns } = await import(pathToFileURL(resolve(__dirname, '../lib/aggregate.js')).href);

const DAY_MS = 86400000;

/** 建一个临时目录（每个用例独立，互不污染）。 */
async function tmpDir() {
  return mkdtemp(join(tmpdir(), 'agint-tool-stats-smoke-'));
}

/** 读 JSONL 行（非空行）。 */
async function readLines(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter((l) => l.trim());
}

/** 极简 cordis ctx 替身：够 apply() 用。 */
function makeCtx() {
  const handlers = new Map();
  const provides = new Map();
  return {
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(fn);
    },
    provide(key, val) {
      provides.set(key, val);
    },
    get(key) {
      return provides.has(key) ? provides.get(key) : null;
    },
    tools: { register() {} },
    async emit(ev, ...args) {
      for (const fn of handlers.get(ev) ?? []) await fn(...args);
    },
  };
}

/** 等文件出现 n 行（写盘是异步队列，不能假设 emit 返回时已落盘）。 */
async function waitForLines(path, n, timeoutMs = 3000) {
  const t0 = Date.now();
  for (;;) {
    const lines = await readLines(path);
    if (lines.length >= n) return lines;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`waitForLines timeout: ${path} 期望 ${n} 行，实际 ${lines.length}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

const SAMPLE_EXEC = { name: 'bash', arguments: { command: 'ls -la /tmp' }, time: 1000 };
const SAMPLE_RESULT = { time: 1200, message: 'ok' };

// ──────────────────────────────────────────────────────────────────────
test('real lib exists', () => {
  assert.ok(existsSync(REAL_LIB), `real lib must exist: ${REAL_LIB}`);
});

test('Config: storeArgs 默认 false（参数指纹化默认关）', () => {
  const c = Config.parse({});
  assert.equal(c.storeArgs, false, 'storeArgs 默认必须是 false');
  assert.equal(Config.parse({ storeArgs: true }).storeArgs, true);
});

// ── ① storeArgs:false ⇒ 无 args 键，有 argsBytes / argsPreview ────────
test('① storeArgs:false ⇒ 行内无 args 键，含 argsBytes 与 argsPreview', async () => {
  const dir = await tmpDir();
  try {
    const p = join(dir, 'stats.jsonl');
    await persist(SAMPLE_EXEC, SAMPLE_RESULT, 'sess-1', p, { storeArgs: false });
    const lines = await readLines(p);
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.ok(!('args' in rec), `storeArgs:false 的行不得含 args 键，实际 keys=${Object.keys(rec)}`);
    assert.equal(typeof rec.argsBytes, 'number', 'argsBytes 必须是数字');
    assert.ok(rec.argsBytes > 0, 'argsBytes 必须 > 0');
    assert.equal(typeof rec.argsPreview, 'string', 'argsPreview 必须是字符串');
    assert.ok(rec.argsPreview.includes('ls -la'), 'argsPreview 应含参数开头');
    // 指纹仍在（统计口径不依赖正文）
    assert.equal(typeof rec.argFingerprint, 'string');
    assert.equal(typeof rec.argsHash, 'string');
    assert.equal(rec.argFingerprint.length, 64, 'argFingerprint 应为 sha256');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('①b argsPreview 超 120 字符截断（argsBytes 记全长）', async () => {
  const dir = await tmpDir();
  try {
    const p = join(dir, 'stats.jsonl');
    const long = { command: 'x'.repeat(500) };
    await persist({ name: 'bash', arguments: long, time: 1 }, { time: 2, message: 'ok' }, 's', p, {
      storeArgs: false,
    });
    const rec = JSON.parse((await readLines(p))[0]);
    assert.equal(rec.argsPreview.length, 120, 'argsPreview 必须截断到 120 字符');
    assert.equal(rec.argsBytes, Buffer.byteLength(JSON.stringify(long), 'utf8'), 'argsBytes 记原 args 字节数');
    assert.ok(!('args' in rec));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── ② storeArgs:true ⇒ 含 args（行为与旧版一致）─────────────────────
test('② storeArgs:true ⇒ 行内含 args', async () => {
  const dir = await tmpDir();
  try {
    const p = join(dir, 'stats.jsonl');
    await persist(SAMPLE_EXEC, SAMPLE_RESULT, 'sess-1', p, { storeArgs: true });
    const rec = JSON.parse((await readLines(p))[0]);
    assert.ok('args' in rec, 'storeArgs:true 的行必须含 args');
    assert.deepEqual(rec.args, { command: 'ls -la /tmp' });
    assert.ok(!('argsBytes' in rec), 'storeArgs:true 时不写 argsBytes（与旧版行为一致）');
    assert.ok(!('argsPreview' in rec), 'storeArgs:true 时不写 argsPreview');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── ⑥⑦ apply 级：配置真的接到了写盘路径 ──────────────────────────────
test('⑥ apply(storeArgs:false) ⇒ 事件写入的行不带 args', async () => {
  const dir = await tmpDir();
  try {
    const p = join(dir, 'stats.jsonl');
    const ctx = makeCtx();
    apply(ctx, { jsonlPath: p, sessionsRoot: dir, storeArgs: false });
    await ctx.emit('tools/result', SAMPLE_EXEC, SAMPLE_RESULT);
    const lines = await waitForLines(p, 1);
    const rec = JSON.parse(lines[0]);
    assert.ok(!('args' in rec), 'apply 路径也必须遵守 storeArgs:false');
    assert.equal(typeof rec.argsBytes, 'number');
    assert.equal(typeof rec.argsPreview, 'string');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('⑦ apply(storeArgs:true) ⇒ 事件写入的行带 args', async () => {
  const dir = await tmpDir();
  try {
    const p = join(dir, 'stats.jsonl');
    const ctx = makeCtx();
    apply(ctx, { jsonlPath: p, sessionsRoot: dir, storeArgs: true });
    await ctx.emit('tools/result', SAMPLE_EXEC, SAMPLE_RESULT);
    const lines = await waitForLines(p, 1);
    const rec = JSON.parse(lines[0]);
    assert.ok('args' in rec, 'apply(storeArgs:true) 必须落 args');
    assert.deepEqual(rec.args, { command: 'ls -la /tmp' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── ③ prune：删超期、留 30 天内、rollup 行数正确 ──────────────────────
test('③ prune 删超期行、保留 30 天内的行、rollup 行数正确', async () => {
  const dir = await tmpDir();
  try {
    const p = join(dir, 'agint_tool_stats.jsonl');
    const rollupPath = join(dir, 'agint_tool_stats_rollup.jsonl');
    const now = Date.now();
    const oldTs = now - 40 * DAY_MS;
    const keepTs = now - 5 * DAY_MS;
    const rows = [
      { ts: oldTs, tool: 'bash', ok: true, latencyMs: 100, argFingerprint: 'f1', argsHash: 'h1' },
      { ts: oldTs, tool: 'bash', ok: false, latencyMs: 200, argFingerprint: 'f2', argsHash: 'h2' },
      { ts: keepTs, tool: 'bash', ok: true, latencyMs: 50, argFingerprint: 'f3', argsHash: 'h3' },
    ];
    await writeFile(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    const res = await pruneToolStats({ jsonlPath: p, rollupPath, opts: { maxAgeDays: 30 }, now });
    assert.equal(res.removed, 2, '应删 2 行超期明细');
    assert.equal(res.applied, true);
    assert.ok(res.freedBytes > 0, 'freedBytes 必须 > 0');

    const after = await readLines(p);
    assert.equal(after.length, 1, '30 天内的行必须保留');
    assert.equal(JSON.parse(after[0]).ts, keepTs, '保留的必须是那条 5 天前的行');

    // rollup：一周 × 一工具 = 一行
    const rl = await readLines(rollupPath);
    assert.equal(rl.length, 1, `rollup 应为 1 行（同一周同一工具），实际 ${rl.length}`);
    const row = JSON.parse(rl[0]);
    assert.equal(row.tool, 'bash');
    assert.equal(row.week, weekKeyOf(oldTs), '周口径 = UTC 周一那天');
    assert.equal(row.calls, 2);
    assert.equal(row.failures, 1);
    assert.equal(row.firstTs, oldTs);
    assert.equal(row.lastTs, oldTs);
    assert.equal(row.p95Ms, 200, 'p95 与 aggregate.js 同口径：升序取 min(n-1, floor(n*0.95))');
    assert.ok(!('args' in row), 'rollup 行不带 args');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('③b prune 同键合并：同一周同一工具仍只有一行（calls 累加）', async () => {
  const dir = await tmpDir();
  try {
    const p = join(dir, 'agint_tool_stats.jsonl');
    const rollupPath = join(dir, 'agint_tool_stats_rollup.jsonl');
    const now = Date.now();
    const oldTs = now - 40 * DAY_MS;
    await writeFile(
      p,
      [{ ts: oldTs, tool: 'bash', ok: true, latencyMs: 100 }].map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8',
    );
    await pruneToolStats({ jsonlPath: p, rollupPath, opts: { maxAgeDays: 30 }, now });
    // 第二次：同周同工具再来一行
    await writeFile(
      p,
      [{ ts: oldTs, tool: 'bash', ok: false, latencyMs: 300 }].map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8',
    );
    await pruneToolStats({ jsonlPath: p, rollupPath, opts: { maxAgeDays: 30 }, now });
    const rl = await readLines(rollupPath);
    assert.equal(rl.length, 1, '合并后仍是一周 × 一工具一行');
    const row = JSON.parse(rl[0]);
    assert.equal(row.calls, 2, 'calls 累加');
    assert.equal(row.failures, 1, 'failures 累加');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('③c prune 不动 30 天内的行（存量行不回填改写）', async () => {
  const dir = await tmpDir();
  try {
    const p = join(dir, 'agint_tool_stats.jsonl');
    const rollupPath = join(dir, 'agint_tool_stats_rollup.jsonl');
    const now = Date.now();
    const row = { ts: now - 3 * DAY_MS, tool: 'bash', ok: true, latencyMs: 10, args: { command: 'keepme' } };
    const text = JSON.stringify(row) + '\n';
    await writeFile(p, text, 'utf8');
    const res = await pruneToolStats({ jsonlPath: p, rollupPath, opts: { maxAgeDays: 30 }, now });
    assert.equal(res.removed, 0);
    assert.equal(res.freedBytes, 0);
    assert.equal(await readFile(p, 'utf8'), text, '存量行必须原样保留（含 args 原文）');
    assert.equal((await readLines(rollupPath)).length, 0, '没有超期行就不该有 rollup');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── ④ dryRun：只算不删不写 ───────────────────────────────────────────
test('④ dryRun:true ⇒ 不产生任何文件变化', async () => {
  const dir = await tmpDir();
  try {
    const p = join(dir, 'agint_tool_stats.jsonl');
    const rollupPath = join(dir, 'agint_tool_stats_rollup.jsonl');
    const now = Date.now();
    const oldTs = now - 40 * DAY_MS;
    const text =
      [
        { ts: oldTs, tool: 'bash', ok: true, latencyMs: 100 },
        { ts: now - 2 * DAY_MS, tool: 'bash', ok: true, latencyMs: 10 },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n';
    await writeFile(p, text, 'utf8');
    const before = await stat(p);
    const beforeBytes = before.size;
    const beforeMtime = before.mtimeMs;

    const res = await pruneToolStats({ jsonlPath: p, rollupPath, opts: { maxAgeDays: 30, dryRun: true }, now });
    assert.equal(res.dryRun, true);
    assert.equal(res.applied, false, 'dryRun 必须标明没落盘');
    assert.equal(res.removed, 1, 'dryRun 返回将删多少行');
    assert.ok(res.freedBytes > 0, 'dryRun 返回将释放多少字节');

    const after = await stat(p);
    assert.equal(after.size, beforeBytes, 'dryRun 后明细文件字节数不变');
    assert.equal(after.mtimeMs, beforeMtime, 'dryRun 后明细文件 mtime 不变（真的没写）');
    assert.equal(await readFile(p, 'utf8'), text, 'dryRun 后明细内容不变');
    assert.equal(existsSync(rollupPath), false, 'dryRun 不得创建 rollup 文件');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── ⑧ provider 接线 + toolStats.pruned 事件 ───────────────────────────
test('⑧ apply 后 ctx.get("agint.toolStats.prune") 可用，且发 toolStats.pruned', async () => {
  const dir = await tmpDir();
  try {
    const p = join(dir, 'agint_tool_stats.jsonl');
    const ctx = makeCtx();
    const published = [];
    // 模拟总线在场
    ctx.provide('agint.eventBus.publish', async (envelope) => {
      published.push(envelope);
      return { accepted: true };
    });
    apply(ctx, { jsonlPath: p, sessionsRoot: dir, storeArgs: false });

    const prune = ctx.get('agint.toolStats.prune');
    assert.equal(typeof prune, 'function', '必须 provide agint.toolStats.prune');

    const now = Date.now();
    await writeFile(
      p,
      [{ ts: now - 40 * DAY_MS, tool: 'bash', ok: true, latencyMs: 100 }].map((r) => JSON.stringify(r)).join('\n') +
        '\n',
      'utf8',
    );
    const res = await prune({ maxAgeDays: 30, now });
    assert.equal(res.removed, 1);
    assert.equal(res.rolled, 1);
    assert.equal(published.length, 1, 'prune 落地后应发一条事件');
    assert.equal(published[0].topic, 'toolStats.pruned');
    assert.deepEqual(published[0].payload, { removed: 1, freedBytes: res.freedBytes });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('⑧b 总线缺席时 prune 不抛错（静默跳过）', async () => {
  const dir = await tmpDir();
  try {
    const p = join(dir, 'agint_tool_stats.jsonl');
    const ctx = makeCtx(); // 不 provide eventBus.publish
    apply(ctx, { jsonlPath: p, sessionsRoot: dir });
    const prune = ctx.get('agint.toolStats.prune');
    const now = Date.now();
    await writeFile(
      p,
      [{ ts: now - 40 * DAY_MS, tool: 'bash', ok: true, latencyMs: 100 }].map((r) => JSON.stringify(r)).join('\n') +
        '\n',
      'utf8',
    );
    const res = await prune({ maxAgeDays: 30, now });
    assert.equal(res.removed, 1, '总线缺席不影响 prune 本身');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('⑧c 总线抛错时 prune 也不抛错', async () => {
  const dir = await tmpDir();
  try {
    const p = join(dir, 'agint_tool_stats.jsonl');
    const ctx = makeCtx();
    ctx.provide('agint.eventBus.publish', async () => {
      throw new Error('bus down');
    });
    apply(ctx, { jsonlPath: p, sessionsRoot: dir });
    const prune = ctx.get('agint.toolStats.prune');
    const now = Date.now();
    await writeFile(
      p,
      [{ ts: now - 40 * DAY_MS, tool: 'bash', ok: true, latencyMs: 100 }].map((r) => JSON.stringify(r)).join('\n') +
        '\n',
      'utf8',
    );
    const res = await prune({ maxAgeDays: 30, now });
    assert.equal(res.removed, 1);
    assert.equal(res.applied, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── ⑤ 读侧降级：没有 args 的记录，repeatPatterns 不抛错 ───────────────
test('⑤ 读侧降级：无 args 的记录 repeatPatterns 不抛错且标注 argsUnavailable', () => {
  const rows = [
    { ts: 1000, tool: 'bash', ok: true, latencyMs: 5, argFingerprint: 'abc', sessionId: 's1' },
    { ts: 2000, tool: 'bash', ok: true, latencyMs: 6, argFingerprint: 'abc', sessionId: 's1' },
    { ts: 3000, tool: 'bash', ok: true, latencyMs: 7, argFingerprint: 'abc', sessionId: 's2' },
  ];
  const out = repeatPatterns(rows, { minRepeats: 3 });
  assert.equal(out.length, 1);
  assert.equal(out[0].argsUnavailable, true, '必须标注 argsUnavailable');
  assert.equal(out[0].sampleArgs, undefined, 'sampleArgs 应为 undefined');
  assert.equal(typeof out[0].suggestedSkillName, 'string', '必须给出降级后的技能名');
  assert.equal(out[0].suggestedSkillName, 'bash-pattern', 'args 缺席时降级为 `${tool}-pattern`');
});

test('⑤b 存量行（有 args）仍能取出 sampleArgs', () => {
  const rows = [1, 2, 3].map((i) => ({
    ts: 1000 * i,
    tool: 'bash',
    ok: true,
    latencyMs: 5,
    argFingerprint: 'abc',
    sessionId: 's1',
    args: { command: 'ls -la' },
  }));
  const out = repeatPatterns(rows, { minRepeats: 3 });
  assert.equal(out[0].argsUnavailable, false);
  assert.deepEqual(out[0].sampleArgs, { command: 'ls -la' });
  assert.equal(out[0].suggestedSkillName, 'ls-la', '有 args 时走原命名逻辑（bash + command 首两词）');
});
