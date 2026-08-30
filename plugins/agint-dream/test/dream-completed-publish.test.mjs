/**
 * agint-dream dream.completed publish tests — Sprint 12 / A8 (T1 影子期).
 * Run: node --test plugins/agint-dream/test/dream-completed-publish.test.mjs
 *
 * 覆盖：
 *   1. sweep() 在 bus 可用时 publish `dream.completed`（topic/version/source + payload 各字段）
 *   2. bus 不可用（ctx.get 返回 null）→ 软降级，sweep 仍正常返回
 *   3. publish 抛错 → 软降级，sweep 仍正常返回
 *   4. publish 用单 service 接口（topic 直达，无伞键）
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const plugin = require('../lib/index.js');

function makeCtx({ withBus = true, busThrows = false } = {}) {
  const services = {};
  const published = [];
  const memoryWrites = [];
  const ctx = {
    get: (n) => {
      if (n === 'agint.eventBus.publish') {
        if (!withBus) return null;
        if (busThrows) return async () => { throw new Error('bus down'); };
        return async (env) => { published.push(env); return { published: true, deliveredTo: ['x'] }; };
      }
      if (n === 'agint.memory') {
        return { list: async () => [], write: async (e) => { memoryWrites.push(e); return { id: `m-${memoryWrites.length}`, ...e }; } };
      }
      return null;
    },
    provide: (n, f) => { services[n] = f; },
    effect: () => () => undefined,
  };
  return { ctx, services, published, memoryWrites };
}

async function makeDirs() {
  const base = await mkdtemp(join(tmpdir(), 'dream-a8-'));
  const sessions = join(base, 'sessions');
  const diary = join(base, 'diary');
  await mkdir(sessions, { recursive: true });
  await mkdir(diary, { recursive: true });
  return { base, sessions, diary };
}

before(async () => { /* noop */ });
after(async () => { /* dirs cleaned by tmp */ });

test('A8: sweep() 在 bus 可用时 publish dream.completed', async () => {
  const { base, sessions, diary } = await makeDirs();
  const { ctx, services, published } = makeCtx({ withBus: true });
  plugin.apply(ctx, { root: diary, sessionsRoot: sessions });
  const dream = services['agint.dream'];
  assert.equal(typeof dream.sweep, 'function');
  const r = await dream.sweep({ apply: false });
  await new Promise((res) => setTimeout(res, 30));
  // sweep 正常返回
  assert.equal(typeof r.durationMs, 'number');
  // publish dream.completed
  const env = published.find((e) => e.topic === 'dream.completed');
  assert.ok(env, '应 publish dream.completed');
  assert.equal(env.version, 1);
  assert.equal(env.source, 'agint-dream');
  const p = env.payload;
  assert.equal(typeof p.sweepId, 'string');
  assert.equal(typeof p.completedAt, 'string');
  assert.equal(p.apply, false);
  assert.equal(typeof p.countCandidates, 'number');
  assert.equal(typeof p.countPromoted, 'number');
  assert.equal(typeof p.diaryPath, 'string');
  await rm(base, { recursive: true, force: true });
});

test('A8: bus 不可用 → 软降级，sweep 仍正常返回', async () => {
  const { base, sessions, diary } = await makeDirs();
  const { ctx, services, published } = makeCtx({ withBus: false });
  plugin.apply(ctx, { root: diary, sessionsRoot: sessions });
  const r = await services['agint.dream'].sweep({ apply: false });
  assert.equal(typeof r.durationMs, 'number');
  assert.equal(published.length, 0);
  await rm(base, { recursive: true, force: true });
});

test('A8: publish 抛错 → 软降级，sweep 仍正常返回 && 不 throw', async () => {
  const { base, sessions, diary } = await makeDirs();
  const { ctx, services, published } = makeCtx({ withBus: true, busThrows: true });
  plugin.apply(ctx, { root: diary, sessionsRoot: sessions });
  const r = await services['agint.dream'].sweep({ apply: false });
  assert.equal(typeof r.durationMs, 'number');
  assert.equal(published.length, 0);
  await rm(base, { recursive: true, force: true });
});

test('A8: publish 单 service 接口（topic 直达无伞键）', async () => {
  const { base, sessions, diary } = await makeDirs();
  const { ctx, services, published } = makeCtx({ withBus: true });
  plugin.apply(ctx, { root: diary, sessionsRoot: sessions });
  await services['agint.dream'].sweep({ apply: false });
  await new Promise((res) => setTimeout(res, 30));
  const env = published.find((e) => e.topic === 'dream.completed');
  assert.ok(env);
  // 无伞键：直接 publish with topic/source，非 envelope 里套 umbrella
  assert.equal(env.topic, 'dream.completed');
  assert.ok(!('kind' in env && 'payload' in env && 'meta' in env), '不应有伞键结构');
  await rm(base, { recursive: true, force: true });
});
