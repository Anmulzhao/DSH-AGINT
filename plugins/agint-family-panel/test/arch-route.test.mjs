/**
 * GET /api/agint-family/v2/arch 路由级测试。
 *
 * ⛔ 为什么必须有：`collectArchData` 被单测过，不等于**路由能应答**。
 *   apply() 走的是 cordis ctx（webServer.register + 回环判定 + kill-switch），
 *   真宿主里这条链路只有在重启后才会第一次执行。这里用桩 ctx 把「注册 →
 *   回环 → 方法 → 应答形状」四件事在重启前钉住，避免上线才发现路由没挂上。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

const ARCH_PATH = '/api/agint-family/v2/arch';
let HOME;
let STORAGES;

before(() => {
  HOME = fs.mkdtempSync(join(os.tmpdir(), 'agint-arch-route-'));
  STORAGES = join(HOME, 'storages');
  fs.mkdirSync(STORAGES, { recursive: true });
  const w = (name, tables) => fs.writeFileSync(join(STORAGES, name), JSON.stringify({ tables }), 'utf8');
  w('agint_evolution.json', { evolution_log: {}, evolution_ledger: {}, failure_pattern: {}, prediction_outcomes: {}, benchmark_frozen_set: {} });
  w('agint_evolve.json', { proposal: { p1: { status: 'proposed', createdAt: '2026-11-01T00:00:00Z' } } });
  w('agint_metrics.json', { metric: { m1: { key: 'memory.total', value: 3, ts: '2026-11-10T00:00:00Z' } } });
  w('agint_cron.json', { cron_state: { j1: { lastResult: 'ok' } } });
  w('agint_curator.json', { skill_states: {}, reports: {}, audit_log: {} });
  w('agint_trajectory.json', { trajectories: {} });
  w('agint_skill_autocreate.json', { task_patterns: {}, candidates: {}, proposals: {}, releases: {} });
  w('agint_rules.json', { rule: {}, rule_audit: {} });
  w('agint_curriculum.json', { challenges: { c1: { status: 'open' } }, attempts: {}, audit_log: {} });
  w('agint_aesthetic_oracle.json', { oracle_cards: { k1: { topic: 'oracle.daily' } }, oracle_broadcasts: { b1: {} }, oracle_state: { latest: { topic: 'oracle.daily' } } });
  process.env.DSH_HOME = HOME;
});

after(() => {
  delete process.env.DSH_HOME;
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeCtx() {
  const registered = [];
  const base = {
    webServer: { register(route) { registered.push(route); return () => {}; } },
    provide() {},
    get() { return undefined; },
    effect() {},
    on() {},
    _registered: registered,
  };
  return base;
}

function makeRes() {
  const out = {};
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers; },
    setHeader(k, v) { (out.headers ??= {})[k] = v; },
    end(body) { out.body = body; },
  };
}

async function callRoute(ctx, { method = 'GET', remoteAddress = '127.0.0.1', path = ARCH_PATH } = {}) {
  const route = ctx._registered.find((r) => r.path === path);
  assert.ok(route, 'route ' + path + ' registered');
  const res = makeRes();
  await route.handler({ method, socket: { remoteAddress }, headers: {} }, res);
  return res.out;
}

test('apply 注册 /v2/arch，且不破坏既有三条路由', () => {
  const ctx = makeCtx();
  apply(ctx, {});
  const paths = ctx._registered.map((r) => r.path);
  for (const p of ['/api/agint-family/status', '/api/agint-family/v2', '/api/agint-family/v2/data', ARCH_PATH, '/api/agint-family/proposal/decision']) {
    assert.ok(paths.includes(p), '缺路由 ' + p + '（已注册：' + paths.join(', ') + '）');
  }
});

test('GET /v2/arch → 200，含 model 与 8 个片段', async () => {
  const ctx = makeCtx();
  apply(ctx, {});
  const out = await callRoute(ctx);
  assert.equal(out.status, 200);
  const d = JSON.parse(out.body);
  assert.equal(d.ok, true);
  assert.equal(d.mode, 'live');
  assert.equal(d.model.nodes.length, 21);
  assert.equal(d.model.edges.length, 26);
  assert.equal(Object.keys(d.fragments).length, 8);
  for (const k of ['kpis', 'overview', 'branch', 'vitals', 'digest', 'src', 'queues', 'check']) {
    assert.ok(typeof d.fragments[k] === 'string' && d.fragments[k].length > 0, '片段 ' + k + ' 为空');
  }
  // 精简传输：sparkSeries / domains 不应出现（fragments 已覆盖视图 HTML）
  assert.ok(!('sparkSeries' in d.model));
  assert.ok(!('domains' in d.model));
  // 不得泄漏绝对路径
  assert.ok(!out.body.includes(HOME), '响应不得含 storages 绝对路径');
});

test('非回环来源 → 403', async () => {
  const ctx = makeCtx();
  apply(ctx, {});
  const out = await callRoute(ctx, { remoteAddress: '10.0.0.9' });
  assert.equal(out.status, 403);
  assert.equal(JSON.parse(out.body).error, 'loopback-only');
});

test('POST → 405', async () => {
  const ctx = makeCtx();
  apply(ctx, {});
  const out = await callRoute(ctx, { method: 'POST' });
  assert.equal(out.status, 405);
});

test('kill-switch 关闭时 → ok:false 且不读盘', async () => {
  const ctx = makeCtx();
  apply(ctx, { enabled: false });
  const out = await callRoute(ctx);
  assert.equal(out.status, 200);
  const d = JSON.parse(out.body);
  assert.equal(d.ok, false);
  assert.equal(d.enabled, false);
  assert.equal(d.model, undefined);
});
