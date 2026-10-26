/**
 * agint-wiki — wiki.updated 发布接线测试（2026-10-26）
 * Run: node --test plugins/agint-wiki/test/bus-publish.test.mjs
 *
 * 背景：agint-wiki 此前对事件总线零感知（check-wiring 查 E' 的 UNWIRED）——
 *   知识层的写入在总线上完全无痕迹，没有任何插件能对 wiki 变化做反应。
 *
 * 本测试锁死三组契约：
 *   1. 发布侧 —— write / remove 每次**真实变更**发一条 wiki.updated；
 *   2. 不造事件 —— 删除不存在的文件、写入失败，都不该产生事件
 *      （否则 wiki.updatedCount 变成调用计数而非变更计数）；
 *   3. 直连红线 —— bus 缺席或 publish 抛错时文件操作照常成功（K63/K64）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

function makeMockCtx({ bus } = {}) {
  const ctx = {
    _provides: new Map(),
    _warns: [],
    logger: { warn: (msg, extra) => { ctx._warns.push({ msg, extra }); } },
    effect(fn) { fn(); },
    provide(k, v) { this._provides.set(k, v); },
    get(k) { return this._provides.get(k) ?? null; },
    on() {},
  };
  // bus 两种注册形态：函数 = 分服务名 agint.eventBus.publish；对象 = 伞键
  if (typeof bus === 'function') ctx.provide('agint.eventBus.publish', bus);
  else if (bus) ctx.provide('agint.eventBus', bus);
  return ctx;
}

function recorder() {
  const envelopes = [];
  const fn = async (env) => {
    envelopes.push(env);
    return { envelopeId: 'env-1', deliveredTo: 0, deadLettered: 0 };
  };
  fn.envelopes = envelopes;
  return fn;
}

async function withWiki(bus, fn) {
  const root = await mkdtemp(join(tmpdir(), 'agint-wiki-test-'));
  try {
    const ctx = makeMockCtx({ bus });
    apply(ctx, { root });
    return await fn({ ctx, wiki: ctx.get('agint.wiki'), root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ───────────────────────── 1. 发布侧 ─────────────────────────

test('write() 发布 wiki.updated，载荷带 action / path / bytes', async () => {
  const rec = recorder();
  await withWiki(rec, async ({ wiki }) => {
    const out = await wiki.write('tech/note.md', '# hello');
    assert.equal(out.path, 'tech/note.md');

    assert.equal(rec.envelopes.length, 1, `write 应发恰好 1 条，实际 ${rec.envelopes.length}`);
    const env = rec.envelopes[0];
    assert.equal(env.topic, 'wiki.updated');
    assert.equal(env.version, 1);
    assert.equal(env.source, 'agint-wiki');
    assert.equal(env.payload.action, 'write');
    assert.equal(env.payload.path, 'tech/note.md');
    assert.equal(env.payload.bytes, out.bytes, 'bytes 必须来自落盘后的真实 stat，不是入参长度');
  });
});

test('remove() 删除成功时发布', async () => {
  const rec = recorder();
  await withWiki(rec, async ({ wiki }) => {
    await wiki.write('a.md', 'x');
    rec.envelopes.length = 0;

    assert.equal(await wiki.remove('a.md'), true);
    assert.equal(rec.envelopes.length, 1);
    assert.equal(rec.envelopes[0].payload.action, 'remove');
    assert.equal(rec.envelopes[0].payload.path, 'a.md');
  });
});

// ───────────────────── 2. 不造事件（只发真实变更） ─────────────────────

test('删除不存在的文件不发事件（返回 false 表示无变更）', async () => {
  const rec = recorder();
  await withWiki(rec, async ({ wiki }) => {
    assert.equal(await wiki.remove('ghost.md'), false);
    assert.equal(rec.envelopes.length, 0, '无变更却发事件 ⇒ 计数器变成调用计数');
  });
});

test('write 内容非法时抛错且不发事件', async () => {
  const rec = recorder();
  await withWiki(rec, async ({ wiki }) => {
    await assert.rejects(() => wiki.write('bad.md', '   '), /non-empty/);
    assert.equal(rec.envelopes.length, 0, '写入失败不该产生变更事件');
  });
});

// ───────────────────── 3. 直连红线 ─────────────────────

test('红线：bus 缺席时 write / remove 照常成功', async () => {
  await withWiki(null, async ({ wiki }) => {
    const out = await wiki.write('x.md', 'body');
    assert.equal(out.path, 'x.md');
    assert.equal((await wiki.read('x.md')).content, 'body\n');
    assert.equal(await wiki.remove('x.md'), true);
  });
});

test('红线：publish 抛错时 write 照常成功，并留下告警', async () => {
  await withWiki(async () => { throw new Error('bus exploded'); }, async ({ ctx, wiki }) => {
    const out = await wiki.write('y.md', 'body');
    assert.equal(out.path, 'y.md', 'publish 抛错不该让 write 失败');
    assert.equal((await wiki.read('y.md')).content, 'body\n', '文件必须真的落盘');
    assert.ok(
      ctx._warns.some((w) => String(w.msg).includes('wiki.updated')),
      'publish 失败必须留下告警，否则静默失败无人知晓（K64 教训）',
    );
  });
});

// ───────────── 4. 探测形态（K63 回归防线） ─────────────

test('伞键形态（agint.eventBus.publish 挂在对象上）也能发布', async () => {
  const rec = recorder();
  await withWiki({ publish: rec }, async ({ wiki }) => {
    await wiki.write('z.md', 'body');
    assert.equal(rec.envelopes.length, 1, '伞键形态下没发布 —— 探测形态写窄了');
    assert.equal(rec.envelopes[0].topic, 'wiki.updated');
  });
});
