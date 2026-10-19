// agint-session-source 测试（2026-10-19）
//
// 判据纪律（three-state-audit §一.2）：不测「我抄的逻辑」，真调生产 createSessionSource()。
// 每条都配阴性对照（放宽 ⇒ 变红），否则「全绿」不能证明它在校验。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionSource, probeUpstream, findSessionLogFile, SESSION_LOG_NAMES_BY_RANK, SESSION_LOG_SUFFIX } from '../lib/index.mjs';
import { join } from 'node:path';

/** 造一个像样的 ctx.get。 */
function ctxWith(svc) {
  return { get: (k) => (k === 'sessionQuery' ? svc : undefined) };
}

const FULL_UPSTREAM = {
  listSessions: async () => [],
  searchSessions: async () => ({ hits: [] }),
  searchEvents: async () => ({ hits: [] }),
  readSession: async () => ({}),
};

const okFallback = async () => [{ dir: 'fb', path: '/tmp/fb', mtimeMs: 1 }];

// ── 探测：完整 vs 半截 ──────────────────────────────────────────────────────
test('上游完整 ⇒ probeUpstream 返回服务', () => {
  assert.ok(probeUpstream(ctxWith(FULL_UPSTREAM)));
});

test('上游缺方法 ⇒ 判不可用（半截实现比没有更危险）', () => {
  const half = { ...FULL_UPSTREAM };
  delete half.searchEvents;
  assert.equal(probeUpstream(ctxWith(half)), null, '缺一个方法就该判不可用，不能算部分可用');
});

test('上游不存在 / ctx 异常 ⇒ 判不可用，不抛', () => {
  assert.equal(probeUpstream(ctxWith(undefined)), null);
  assert.equal(probeUpstream(null), null);
  assert.equal(probeUpstream({}), null, 'ctx 没有 get 方法也不该崩');
});

// ── 走哪条路 ────────────────────────────────────────────────────────────────
test('上游可用 ⇒ mode=upstream，且**不**回落', async () => {
  let fell = 0;
  const src = createSessionSource({
    ctx: ctxWith(FULL_UPSTREAM),
    fallback: async () => { fell += 1; return []; },
    onFallback: () => { throw new Error('不应回落'); },
    source: 't',
  });
  assert.equal(src.mode, 'upstream');
  await src.listRecent();
  assert.equal(fell, 0, '上游可用时不得回落');
});

test('上游缺失 ⇒ 回落**且出声**（不静默）', async () => {
  const heard = [];
  const src = createSessionSource({
    ctx: ctxWith(undefined),
    fallback: okFallback,
    onFallback: (r) => heard.push(r),
    source: 'dream',
  });
  assert.equal(src.mode, 'fallback');
  const got = await src.listRecent();
  assert.equal(got.length, 1, '应拿到回落结果');
  assert.equal(heard.length, 1, '回落必须出声且只出一次');
  assert.match(heard[0], /upstream-absent/);
  assert.match(heard[0], /\[session-source\/dream\]/, '出声要带调用方标识，便于定位是哪条线在降级');
});

test('上游报错 ⇒ 也回落，但出声标 upstream-failed（不是 absent）', async () => {
  const heard = [];
  const src = createSessionSource({
    ctx: ctxWith({ ...FULL_UPSTREAM, listSessions: async () => { throw new Error('boom'); } }),
    fallback: okFallback,
    onFallback: (r) => heard.push(r),
    source: 'input-gateway',
  });
  const got = await src.listRecent();
  assert.equal(got.length, 1, '上游炸了也要有数据，不能让通道断供');
  assert.match(heard[0], /upstream-failed/);
  assert.match(heard[0], /boom/, '要把上游的真实错误带出来');
});

// ── 反向判据：不许静默降级 ───────────────────────────────────────────────────
test('⛔ 没给 onFallback ⇒ 拒绝静默降级（直接抛，不悄悄回落）', async () => {
  const src = createSessionSource({
    ctx: ctxWith(undefined),
    fallback: okFallback,
    // 故意不传 onFallback
    source: 't',
  });
  await assert.rejects(() => src.listRecent(), /拒绝静默降级/);
});

test('⛔ 没给 fallback ⇒ 构造即抛（不允许没有回落通道的会话源）', () => {
  assert.throws(
    () => createSessionSource({ ctx: ctxWith(FULL_UPSTREAM) }),
    /fallback 必须是函数/,
  );
});

// ── 形状对齐：上游结果与回落同形 ─────────────────────────────────────────────
test('上游结果形状与回落层一致（dir / path / mtimeMs）', async () => {
  const svc = {
    ...FULL_UPSTREAM,
    listSessions: async () => [
      { id: 'a', updatedAt: '2026-10-19T00:00:00Z', path: '/x/a.jsonl.zstd' },
      { id: 'b', updatedAt: '2026-10-01T00:00:00Z', path: null }, // 超窗，应被滤掉
    ],
  };
  const src = createSessionSource({
    ctx: ctxWith(svc),
    fallback: okFallback,
    onFallback: () => { throw new Error('不应回落'); },
    source: 't',
  });
  const got = await src.listRecent({ lookbackDays: 2, maxSessions: 10 });
  assert.equal(got.length, 1, '窗口外的应被滤掉');
  assert.deepEqual(Object.keys(got[0]).sort(), ['dir', 'mtimeMs', 'path', 'upstream']);
  assert.equal(got[0].dir, 'a');
  assert.ok(got[0].mtimeMs > 0, 'mtimeMs 必须是可比较的数字');
});

test('上游拿不到 path ⇒ 留 null，不编造路径', async () => {
  const svc = {
    ...FULL_UPSTREAM,
    listSessions: async () => [{ id: 'a', updatedAt: Date.now() }],
  };
  const src = createSessionSource({
    ctx: ctxWith(svc), fallback: okFallback, onFallback: () => {}, source: 't',
  });
  const got = await src.listRecent();
  assert.equal(got[0].path, null, '拿不到就留 null —— 编造路径比没有更坏');
});

// ── F5 收口：会话日志文件名发现（唯一真相源）────────────────────────────
// 背景：input-gateway 曾有两份硬编码三名字表且无后缀兜底。
// 判据：直调生产 findSessionLogFile，fs 用内存夹具（不 mock 逻辑本身）。
/** 造一个内存文件系统夹具：files = { '文件名': mtime }。 */
function memFs(files) {
  const entries = Object.keys(files).map((name) => ({
    name,
    isFile: () => true,
    isDirectory: () => false,
  }));
  return {
    statSync: (p) => {
      const name = String(p).split(/[\\/]/).pop();
      if (!(name in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return { mtimeMs: files[name] };
    },
    readdirSync: () => entries,
  };
}

test('F5：候选名命中 ⇒ 返回该文件（版本秩 v4 优先）', () => {
  const fs = memFs({ 'session.v4.jsonl.zstd': 1, 'session.v3.jsonl.zstd': 1 });
  const p = findSessionLogFile('/d/sid', fs);
  // ⚠ 期望值用 join 算：join 在 Windows 上会转反斜杠，写死正斜杠会假红。
  assert.equal(p, join('/d/sid', 'session.v4.jsonl.zstd'), 'v4 优先于 v3');
});

test('F5：只有 v3 ⇒ 命中 v3（版本秩不挑）', () => {
  const fs = memFs({ 'session.v3.jsonl.zstd': 1 });
  assert.equal(findSessionLogFile('/d/sid', fs), join('/d/sid', 'session.v3.jsonl.zstd'));
});

test('F5：⛔ 宿主改名（v9）仍须命中 —— 后缀兜底不得失效', () => {
  const fs = memFs({ 'session.v9.jsonl.zstd': 1 });
  const p = findSessionLogFile('/d/sid', fs);
  assert.equal(p, join('/d/sid', 'session.v9.jsonl.zstd'), '未知名但后缀匹配必须命中（不得归零）');
});

test('F5：目录内无任何会话日志 ⇒ 返回 null（不是 undefined、不报错）', () => {
  const fs = memFs({ 'other.txt': 1 });
  assert.equal(findSessionLogFile('/d/sid', fs), null);
});

test('F5：readdir 抛错（目录读不了）⇒ 返回 null，不炸', () => {
  const fs = {
    statSync: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
    readdirSync: () => { throw new Error('EACCES'); },
  };
  assert.equal(findSessionLogFile('/d/sid', fs), null);
});

test('F5：后缀匹配但不是文件（目录同名）⇒ 不算命中', () => {
  const fs = {
    statSync: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
    readdirSync: () => [{ name: 'x.jsonl.zstd', isFile: () => false, isDirectory: () => true }],
  };
  assert.equal(findSessionLogFile('/d/sid', fs), null, '目录不该被当成会话日志文件');
});

test('F5：名字表与后缀常量是导出的唯一真相源（供跨插件引用核对）', () => {
  assert.deepEqual(SESSION_LOG_NAMES_BY_RANK, [
    'session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.jsonl.zstd',
  ]);
  assert.equal(SESSION_LOG_SUFFIX, '.jsonl.zstd');
});
