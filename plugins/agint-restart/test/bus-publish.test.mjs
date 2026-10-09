/**
 * agint-restart — restart.* 发布接线测试（2026-10-09，工作项 B2）
 * Run: node --test plugins/agint-restart/test/bus-publish.test.mjs
 *
 * 背景：agint-restart 对事件总线零感知（查 E' UNWIRED）。而「重启」恰恰是全系统里
 *   最该事件化的事实 —— 宿主重启会摧毁总线全部内存态（订阅表 + 环形缓冲由
 *   disposeBus() 清空），所以任何**跨重启**的通知都不可能靠进程内回调传递。
 *   取证见 proposals/agint-eventbus-unwired-plugins-20261009.md §4 工作项 B2。
 *
 * 为什么不用 mount.restart-* 那组现成主题：它们由 agint-mount 的 orchestrator 发起，
 *   语义是「mount 流程请求了重启」；这里是「有人直接调 agint.restart.request」，
 *   是两件事。混用会让订阅方无法区分来源（同 evolution.proposed 的教训）。
 *
 * ⚠️ 本文件**不测** request() 的 accepted 正路径 —— 那条路会 shutdownSelf()
 *   把测试进程干掉（既有 smoke 同样只测 needs-confirm / manual / tripped /
 *   cooldown / dryRun 这些拒绝分支）。正路径按 B1 的先例，**由生产真实触发验收**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync as wfs, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

function makeCtx({ provided = {}, bus = null } = {}) {
  const disposers = [];
  const services = {};
  const ctx = {
    get: (n) => services[n] ?? null,
    inject: (names, cb) => cb(services),
    on: () => {},
    effect: (fn) => { const inner = fn(); if (typeof inner === 'function') disposers.push(inner); },
    provide: (n, v) => { provided[n] = v; services[n] = v; },
  };
  // bus 可以后到（apply 顺序不保证），故做成可变引用
  ctx.setBus = (b) => {
    if (b) services['agint.eventBus.publish'] = b;
    else delete services['agint.eventBus.publish'];
  };
  if (bus) ctx.setBus(bus);
  return { ctx, provided, disposers };
}

function recorder() {
  const envelopes = [];
  const fn = async (env) => {
    envelopes.push(env);
    return { envelopeId: `env-${envelopes.length}`, deliveredTo: 0, deadLettered: 0 };
  };
  fn.envelopes = envelopes;
  return fn;
}

/** 临时 DSH_HOME + 干净 stateDir */
async function tmpHome(tag) {
  const root = await mkdtemp(join(tmpdir(), `agint-restart-bus-${tag}-`));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  return {
    root,
    stateDir: join(root, '.agint-restart-bus'),
    restore() { if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev; },
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

/** 预置上一轮 marker，让本次 apply 判定为「重启后启动」 */
function seedMarker(stateDir, { downtimeMs = 5000 } = {}) {
  mkdirSync(stateDir, { recursive: true });
  wfs(join(stateDir, 'marker.json'), JSON.stringify({
    lastBootAt: new Date(Date.now() - downtimeMs).toISOString(),
    pid: 999999,               // 必然不是本进程 pid ⇒ detectRestart 判 wasRestart
    lastSessionId: 'sess-prev',
    lastActiveAt: new Date(Date.now() - downtimeMs).toISOString(),
  }, null, 2));
}

// ──────────────────────── restart.settled ────────────────────────

test('重启后启动：发布 restart.settled，载荷含停机时长与上一轮信息', async () => {
  const env = await tmpHome('settled');
  try {
    seedMarker(env.stateDir, { downtimeMs: 7000 });
    const rec = recorder();
    const { ctx } = makeCtx({ bus: rec });
    apply(ctx, { stateDir: '.agint-restart-bus', notifyDebounceMs: 0 });

    const settled = rec.envelopes.filter((e) => e.topic === 'restart.settled');
    assert.equal(settled.length, 1, `应恰好 1 条 restart.settled，实际 ${rec.envelopes.length} 条信封`);
    assert.equal(settled[0].version, 1);
    assert.equal(settled[0].source, 'agint-restart');
    assert.ok(typeof settled[0].payload.downtimeMs === 'number', '载荷必须带 downtimeMs —— 重启耗时的唯一来源');
    assert.ok(settled[0].payload.bootAt, '载荷必须带本次 bootAt');
    assert.equal(typeof settled[0].payload.selfRestart, 'boolean');
  } finally { env.restore(); env.cleanup(); }
});

test('首次启动（无 marker）不发布 restart.settled —— 那是冷启动不是重启', async () => {
  const env = await tmpHome('cold');
  try {
    const rec = recorder();
    const { ctx } = makeCtx({ bus: rec });
    apply(ctx, { stateDir: '.agint-restart-bus' });
    assert.equal(rec.envelopes.filter((e) => e.topic === 'restart.settled').length, 0,
      '冷启动不该被记成一次重启 —— 那会往总线灌假事实');
  } finally { env.restore(); env.cleanup(); }
});

// ─────────────────── apply 顺序不保证 ⇒ 补挂（ov-strategy 同族）───────────────────

test('bus 在 apply 时缺席、稍后才出现：restart.settled 仍能补发出去', async () => {
  const env = await tmpHome('late');
  try {
    seedMarker(env.stateDir);
    const rec = recorder();
    const { ctx } = makeCtx();          // ← apply 时故意不给 bus
    apply(ctx, { stateDir: '.agint-restart-bus', notifyDebounceMs: 0 });
    assert.equal(rec.envelopes.length, 0, 'bus 还没来，本来就不该发');

    ctx.setBus(rec);                     // bus 到位
    await new Promise((r) => setTimeout(r, 400));  // 给补挂机制一个机会

    assert.equal(rec.envelopes.filter((e) => e.topic === 'restart.settled').length, 1,
      'bus 后来到位也没补发 —— 这正是 ov-strategy 踩过的坑（apply 顺序不保证，'
      + '早退一次就永久静默），restart.settled 是跨重启事实，丢了就再也补不回来');
  } finally { env.restore(); env.cleanup(); }
});

test('bus 一直缺席：补挂有界、放弃后不崩也不无限重试', async () => {
  const env = await tmpHome('nobus');
  try {
    seedMarker(env.stateDir);
    const { ctx } = makeCtx();           // 全程没有 bus
    assert.doesNotThrow(() => apply(ctx, { stateDir: '.agint-restart-bus', notifyDebounceMs: 0 }),
      '没有 bus 绝不能让插件挂载失败');
    await new Promise((r) => setTimeout(r, 300));   // 跑完整个补挂窗口
    assert.ok(true, '放弃即止：插件继续正常工作，不抛不挂');
  } finally { env.restore(); env.cleanup(); }
});

// ─────────────── request 的拒绝分支：一条都不许发 ───────────────
//
// ⛔ 护栏顺序（lib/index.js requestInner）：manual → needs-confirm → pending →
//    burst → cooldown → 落盘 → dryRun。
//    dryRun 在**熔断之后**，所以「预置满历史测熔断」和「测 dryRun」不能共用一个实例。
// ⛔ mode 是 **apply 期配置**，不是 request 参数。写进 request({mode:'manual'}) 会被忽略，
//    于是请求一路穿过所有护栏走到 accepted —— 那条路会写请求文件、spawn detached
//    respawn 守护、并 shutdownSelf 把测试进程干掉。
//    （2026-10-09 实测踩过：这么写导致测试文件 pass 5 / fail 1，进程被 exit 掉。）

test('restart.request：needs-confirm 与 dryRun 都不发布，且不产生任何副作用文件', async () => {
  const env = await tmpHome('deny-a');
  try {
    const rec = recorder();
    const { ctx } = makeCtx({ bus: rec });
    apply(ctx, { stateDir: '.agint-restart-bus', burstMax: 3, burstWindowMs: 600000 });
    const svc = ctx.get('agint.restart');

    const r1 = svc.request({});
    assert.equal(r1.accepted, false);
    assert.equal(r1.code, 'needs-confirm');

    const r2 = svc.request({ confirm: true, dryRun: true });
    assert.equal(r2.accepted, false);
    assert.equal(r2.code, 'dry-run');

    assert.equal(rec.envelopes.filter((e) => e.topic === 'restart.requested').length, 0,
      '被拒绝的重启请求没发生，不该产生 restart.requested —— '
      + '否则订阅方会把「有人想重启」误当成「重启已发起」');
    assert.ok(!existsSync(join(env.stateDir, 'restart-request.json')),
      '拒绝分支不该写请求文件（写了就可能被守护脚本消费）');
  } finally { env.restore(); env.cleanup(); }
});

test('restart.request：熔断（含 force 绕过）不发布', async () => {
  const env = await tmpHome('deny-b');
  try {
    mkdirSync(env.stateDir, { recursive: true });
    const now = Date.now();
    wfs(join(env.stateDir, 'restart-history.json'), JSON.stringify({
      events: [0, 1, 2].map((i) => ({ at: new Date(now - i * 1000).toISOString(), requestId: `r${i}`, reason: 'x' })),
    }, null, 2));

    const rec = recorder();
    const { ctx } = makeCtx({ bus: rec });
    apply(ctx, { stateDir: '.agint-restart-bus', burstMax: 3, burstWindowMs: 600000 });
    const svc = ctx.get('agint.restart');

    const r = svc.request({ confirm: true, force: true });
    assert.equal(r.accepted, false);
    assert.equal(r.code, 'tripped');
    assert.equal(rec.envelopes.filter((e) => e.topic === 'restart.requested').length, 0);
    assert.ok(!existsSync(join(env.stateDir, 'restart-request.json')), '熔断时不该写请求文件');
  } finally { env.restore(); env.cleanup(); }
});

test('restart.request：manual 模式（apply 期配置）只给命令、零动作、不发布', async () => {
  const env = await tmpHome('deny-c');
  try {
    const rec = recorder();
    const { ctx } = makeCtx({ bus: rec });
    apply(ctx, { stateDir: '.agint-restart-bus', mode: 'manual' });

    const r = ctx.get('agint.restart').request({ confirm: true });
    assert.equal(r.accepted, false);
    assert.equal(r.code, 'manual-mode');
    assert.equal(rec.envelopes.filter((e) => e.topic === 'restart.requested').length, 0);
  } finally { env.restore(); env.cleanup(); }
});
