/**
 * v2-data 事件总线 per-record 布局单测（2026-11-15）。
 *
 * 背景：agint-event-bus v0.9.0 起域声明 layout:'per-record'，介质从
 * <storages>/agint_event_bus.json 换成 <storages>/agint_event_bus/<表>/<key>.json
 * （单记录文档 {version, record}）。aggBus 必须两种布局都认：
 *   1) per-record 目录在 ⇒ 读目录（权威），deadletter 数目录里的文件；
 *   2) 目录不在 ⇒ 回退 single 文件（未迁移的老部署）；
 *   3) 两者并存 ⇒ 以 per-record 为准，不双计（single 是迁移前旧快照）；
 *   4) 新事件文件落地 ⇒ mtime 签名变化，TTL 内缓存也要失效。
 * 独占 mkdtemp home，与 v2-data.test.mjs 同款并行安全纪律。
 */
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { makeStorages } from './fixtures/make-storages.mjs';
import { collectV2Data, clearV2Cache } from '../lib/v2-data.js';

const here = dirname(fileURLToPath(import.meta.url));
const SHARED = join(here, 'fixtures', 'v2-home');
const HOME = mkdtempSync(join(tmpdir(), 'panel-v2-bus-perrecord-'));
cpSync(join(SHARED, 'profiles'), join(HOME, 'profiles'), { recursive: true });
const STORAGES = makeStorages(HOME); // 先铺 single 布局（含 tools/cron，聚合不降级）
const DIRS = {
  pluginsDir: join(HOME, 'profiles', 'web', 'plugins'),
  storagesDir: STORAGES,
  repoPluginsDir: join(here, 'fixtures', 'v2-repo', 'plugins'),
};
const now = Date.now();
const D = 86400000;

const BUS_DIR = join(STORAGES, 'agint_event_bus');
const EVENTS = join(BUS_DIR, 'events');
const DEAD = join(BUS_DIR, 'deadletter');
/** 与 dsh-storage-json serializeRecord 同口径：{version:1, record} + 尾换行。 */
const putRecord = (dir, key, record) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${key}.json`), `${JSON.stringify({ version: 1, record }, null, 2)}\n`);
};
const ev = (id, topic, source, ago) => ({
  envelope: { id, topic, version: 1, source, occurredAt: new Date(now - ago).toISOString(), payload: {} },
  deliveries: {},
});

// ── 1) single 回退：只有旧文件时口径不变 ──
{
  const P = collectV2Data(DIRS, { now, cache: new Map() });
  assert.equal(P.bus.total, 3);
  assert.equal(P.bus.deadletter, 0);
  assert.deepEqual(P.bus.topics[0], ['alpha.did', 2]);
}

// ── 2) 两者并存：per-record 为准，不双计 ──
putRecord(EVENTS, 'p1', ev('p1', 'alpha.did', 'agint-alpha', 1 * 3600e3));
putRecord(EVENTS, 'p2', ev('p2', 'gamma.did', 'agint-gamma', 2 * D));
putRecord(DEAD, 'p1__sub-x', { id: 'p1__sub-x', envelopeId: 'p1', subscriptionId: 'sub-x' });
{
  const P = collectV2Data(DIRS, { now, cache: new Map() });
  assert.equal(P.bus.total, 2, 'per-record 两条，不混入 single 的三条');
  assert.equal(P.bus.deadletter, 1, 'deadletter 数目录文件');
  assert.deepEqual(P.bus.topics, [['alpha.did', 1], ['gamma.did', 1]]);
  assert.equal(P.bus.topicLast['alpha.did'], new Date(now - 1 * 3600e3).toISOString());
  assert.equal(P.bus.daily['agint-alpha'].reduce((s, v) => s + v, 0), 1);
  assert.equal(P.bus.daily['agint-gamma'].reduce((s, v) => s + v, 0), 1);
  assert.equal(P.bus.range.length, 2);
  assert.ok(P.bus.observedAt, 'observedAt 取 events 目录 mtime');
}

// ── 3) 坏记录跳过，不整源报废 ──
writeFileSync(join(EVENTS, 'broken.json'), '{half-written');
{
  const P = collectV2Data(DIRS, { now, cache: new Map() });
  assert.equal(P.bus.total, 2, '坏文件跳过');
}
rmSync(join(EVENTS, 'broken.json'));

// ── 4) 新事件落地 ⇒ 签名变化，TTL 内缓存失效 ──
{
  const c = new Map();
  const p1 = collectV2Data(DIRS, { now, cache: c });
  const p2 = collectV2Data(DIRS, { now: now + 1000, cache: c });
  assert.equal(p1.generatedAt, p2.generatedAt, 'TTL 内无变化命中缓存');
  putRecord(EVENTS, 'p3', ev('p3', 'delta.did', 'agint-delta', 30 * 60e3));
  const p3 = collectV2Data(DIRS, { now: now + 2000, cache: c });
  assert.notEqual(p1.generatedAt, p3.generatedAt, 'events 目录 mtime 变化 ⇒ 重算');
  assert.equal(p3.bus.total, 3);
}

// ── 5) 只有 per-record（无 single 文件，本机实况）：照常聚合 ──
rmSync(join(STORAGES, 'agint_event_bus.json'));
{
  const P = collectV2Data(DIRS, { now, cache: new Map() });
  assert.equal(P.bus.total, 3);
  assert.equal(P.bus.deadletter, 1);
}

// ── 6) 两种布局都没有：bus 独立降级，不拖垮其余源 ──
rmSync(BUS_DIR, { recursive: true });
{
  const P = collectV2Data(DIRS, { now, cache: new Map() });
  assert.equal(P.bus.state, 'error');
  assert.equal(P.tools.total, 7, 'tools 不受影响');
}

// ── 7) tool_stats 文件缺席（新机器还没记录过工具调用）= 空态，不是降级 ──
rmSync(join(STORAGES, 'agint_tool_stats.jsonl'));
{
  const P = collectV2Data(DIRS, { now, cache: new Map() });
  assert.equal(P.tools.state, undefined, '缺席不报 error');
  assert.equal(P.tools.total, 0);
  assert.deepEqual(P.tools.rows, []);
  assert.equal(P.tools.observedAt, null);
}

clearV2Cache();
console.log('v2-bus-perrecord.test.mjs PASS');