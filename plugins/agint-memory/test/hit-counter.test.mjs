/**
 * 召回命中计数（2026-11-07）
 *
 * 背景：生产记忆池 869 条 recalls 869/869 全为 0 —— 计数从未被接线。
 * 根因链：唯一写点 `agint.memory.recall()` 的生产调用者被默认关闭的
 * `builtin_recall_touch` 挡住，而其入口 `manager.beginTurn()` 全仓无调用者
 * （宿主 app.asar 命中 0、preset 命中 0）。
 *
 * 本次实现：模型面向的检索命中记到旁路 JSONL（`lib/hits.js`），读接口合并呈现。
 * 为什么旁路：memory 表是 single-layout 单元（单文件 ~879KB），单行写实测
 * ~700ms（工具统计：memory_write 平均 764ms），一次检索命中 20 条要等 ~15 秒 ⇒
 * 写回型计数在生产上不可行。
 *
 * 判据要点（check-soundness）：
 * - 判据打在最终产物上：服务读接口 `list()` / `search()` 返回的 `recalls` 值。
 * - 负控制：不带 `countHits` 的后台检索、`memory_read` 都不许推进计数。
 *   若有人把计数写进 `search()` 默认路径，或把 read 也算进去，这两条会红。
 * - 持久化：新实例（同路径）读得到历史计数 ⇒ 不是内存里的一次性数字。
 * - 容错：文件尾部半行不许吃掉已记的计数。
 *
 * 运行：node --test plugins/agint-memory/test/hit-counter.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply as applyService } from '../lib/index.js';
import { apply as applyTools } from '../lib/tools.js';

const HITS_FILE = 'agint_memory_hits.jsonl';

/** 每条测试一个临时 DSH_HOME —— 计数文件按 DSH_HOME 推导，不许串味。 */
async function withHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'agint-memory-hits-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

const entry = (content, extra = {}) => ({
  type: 'lesson',
  content,
  level: 'L1',
  confidence: 0.9,
  lastRecall: '2026-11-01T00:00:00.000Z',
  recalls: 0,
  evidence: '',
  resolved: false,
  replacedBy: null,
  lineageKey: null,
  supersedesKey: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...extra,
});

/** 起真插件，拿到 ctx.provide 出来的 agint.memory service。 */
function makeService(rows = []) {
  const store = new Map(rows.map(([id, e]) => [id, { ...e }]));
  const table = {
    entries: () => store.entries(),
    get: (id) => store.get(id),
    put: async (id, rec) => { store.set(id, rec); return rec; },
    delete: async (id) => store.delete(id),
  };
  let service = null;
  const ctx = {
    storageDomain: { open: async () => ({ table: () => table, close: async () => {} }) },
    provide(name, svc) { if (name === 'agint.memory') service = svc; },
    effect() {},
    get() { return undefined; },
  };
  applyService(ctx);
  assert.ok(service, 'fake ctx 必须拿到 agint.memory service');
  return service;
}

/** 拿 memory_search 工具（模型面向的检索入口）。 */
function searchTool(service) {
  const registered = [];
  applyTools({ 'agint.memory': service, tools: { register(def) { registered.push(def); } } });
  const tool = registered.find((t) => t.name === 'memory_search');
  assert.ok(tool, 'memory_search 未注册');
  return tool;
}

// ── 生产者：模型检索命中 = 一次召回 ────────────────────────────────────

test('memory_search 命中一次 → 该条 recalls = 1（list 与返回值都看得到）', async () => {
  await withHome(async () => {
    const service = makeService([['m1', entry('alpha 条目')]]);
    const tool = searchTool(service);

    const out = await tool.execute({ query: 'alpha' });
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].recalls, 1, '返回值里的 recalls 要是合并后的值，不能是 0');

    const list = await service.list();
    assert.equal(list[0].recalls, 1, 'list() 读接口也要看到计数');
  });
});

test('连续两次检索同一条 → recalls 0→1→2（不是一次性数字）', async () => {
  await withHome(async () => {
    const service = makeService([['m1', entry('alpha 条目')]]);
    const tool = searchTool(service);

    const t1 = await tool.execute({ query: 'alpha' });
    assert.equal(t1.results[0].recalls, 1);
    const t2 = await tool.execute({ query: 'alpha' });
    assert.equal(t2.results[0].recalls, 2);
  });
});

test('一次检索命中多条 → 一行记录，命中条目各记 1 次', async () => {
  await withHome(async (dir) => {
    const service = makeService([
      ['m1', entry('alpha 甲')],
      ['m2', entry('alpha 乙')],
      ['m3', entry('无关条目')],
    ]);
    const tool = searchTool(service);

    const out = await tool.execute({ query: 'alpha' });
    assert.equal(out.results.length, 2, '只该命中两条');

    const raw = await readFile(join(dir, 'storages', HITS_FILE), 'utf8');
    assert.equal(raw.trim().split('\n').length, 1, '一次检索写一行，不是每命中写一行');

    const list = await service.list();
    const byId = Object.fromEntries(list.map((e) => [e.id, e.recalls]));
    assert.equal(byId.m1, 1);
    assert.equal(byId.m2, 1);
    assert.equal(byId.m3, 0, '未命中的条目不许被记');
  });
});

// ── 对照组：什么不算召回 ────────────────────────────────────────────────

test('后台自检检索（不传 countHits）不推进计数', async () => {
  await withHome(async () => {
    const service = makeService([['m1', entry('alpha 条目')]]);
    // 模拟 provider prefetch / 压缩兜底 / 诊断反事实：这些检索不许算用户召回
    await service.search('alpha', {});
    await service.search('alpha', { limit: 5 });
    assert.equal((await service.list())[0].recalls, 0, '后台检索不许计数');
    assert.deepEqual(await service.hitCounts(), {}, '后台检索不许写进命中计数');
  });
});

test('memory_read 不推进计数（读不是用）', async () => {
  await withHome(async () => {
    const service = makeService([['m1', entry('alpha 条目')]]);
    await service.read('m1');
    assert.equal((await service.list())[0].recalls, 0);
  });
});

test('memory_read 返回合并后的 recalls（与 search / list 同一口径）', async () => {
  await withHome(async () => {
    const service = makeService([['m1', entry('alpha 条目')]]);
    await searchTool(service).execute({ query: 'alpha' });
    const read = await service.read('m1');
    assert.equal(read.recalls, 1, 'read 必须与 search/list 同一口径，不能一个 1 一个 0');
  });
});

test('没被检索过的条目，read 的 recalls 仍是 0', async () => {
  await withHome(async () => {
    const service = makeService([['m1', entry('alpha 条目')]]);
    assert.equal((await service.read('m1')).recalls, 0);
    assert.equal(await service.read('不存在'), null);
  });
});

test('memory_list 不推进计数', async () => {
  await withHome(async () => {
    const service = makeService([['m1', entry('alpha 条目')]]);
    await service.list({});
    assert.equal((await service.list())[0].recalls, 0);
  });
});

// ── 持久化与容错 ────────────────────────────────────────────────────────

test('计数落文件：新建实例仍读得到历史命中', async () => {
  await withHome(async () => {
    const s1 = makeService([['m1', entry('alpha 条目')]]);
    await searchTool(s1).execute({ query: 'alpha' });

    const s2 = makeService([['m1', entry('alpha 条目')]]);   // 同路径新实例
    assert.equal((await s2.list())[0].recalls, 1, '计数必须持久化');
  });
});

test('文件尾部半行不许吃掉已记的计数', async () => {
  await withHome(async (dir) => {
    const s1 = makeService([['m1', entry('alpha 条目')]]);
    await searchTool(s1).execute({ query: 'alpha' });
    await appendFile(join(dir, 'storages', HITS_FILE), '{"version":1,"ts":1,"ids":["m1"', 'utf8');

    const s2 = makeService([['m1', entry('alpha 条目')]]);
    assert.equal((await s2.list())[0].recalls, 1, '坏行跳过，已记的不能丢');
  });
});

test('空命中数组不写文件、不计数', async () => {
  await withHome(async (dir) => {
    const service = makeService([['m1', entry('alpha 条目')]]);
    assert.equal(await service.noteHits([]), 0);
    assert.deepEqual(await service.hitCounts(), {});
    const exists = await readFile(join(dir, 'storages', HITS_FILE), 'utf8').catch(() => null);
    assert.equal(exists, null, '没有命中就不该产生文件');
  });
});

// ── 合并口径 ────────────────────────────────────────────────────────────

test('合并口径：表内 legacy recalls(2) + 命中(1) = 3', async () => {
  await withHome(async () => {
    const service = makeService([['m1', entry('alpha 条目', { recalls: 2 })]]);
    await searchTool(service).execute({ query: 'alpha' });
    assert.equal((await service.list())[0].recalls, 3);
  });
});

test('召回计数不改变排序口径（effectiveConfidence 不含 recalls）', async () => {
  await withHome(async () => {
    const service = makeService([
      ['m1', entry('alpha 甲', { confidence: 0.9 })],
      ['m2', entry('alpha 乙', { confidence: 0.5 })],
    ]);
    const tool = searchTool(service);
    const before = (await tool.execute({ query: 'alpha' })).results.map((r) => r.id);
    await tool.execute({ query: 'alpha' });
    const after = (await tool.execute({ query: 'alpha' })).results.map((r) => r.id);
    assert.deepEqual(after, before, '计数不许改变排序结果');
  });
});
