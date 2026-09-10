/**
 * agint-restart v0.7.0 —— 落盘待投（pending notice）回归测试
 *
 * 守的是 2026-09-10 那次事故：重启后 agents 注册表里一个活 agent 都没有
 * （会话只有被客户端打开时才 announce 进内存），于是恢复通知被直接丢弃，
 * 表现就是"重启后不注入消息"。
 *
 * 期望行为：重启后先把通知落盘，投递成功才删；之后任一会话被打开时补投。
 *
 * 跑法：
 *   node --test test/pending-notice.test.mjs
 *   node test/pending-notice.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply } from '../lib/index.js';

const LIB_DIR = fileURLToPath(new URL('../lib', import.meta.url));

/** 造一个假 agent：记录被投递的消息。 */
function makeAgent(id) {
  return {
    id,
    received: [],
    followup(msg) { this.received.push({ via: 'followup', msg }); },
    inject(msg) { this.received.push({ via: 'inject', msg }); },
  };
}

function makeAgentsService(agents) {
  return {
    list: () => agents.slice(),
    roots: () => agents.slice(),
    get: (id) => agents.find((a) => String(a.id) === String(id)) ?? undefined,
  };
}

/**
 * 建一个最小 cordis ctx 桩。
 * 关键点：effect() 要收集 disposer，测试末尾统一调用来 clearInterval，
 * 否则插件内部的 20 秒轮询会把测试进程拖住。
 */
function makeCtx({ agents = [] } = {}) {
  const handlers = new Map();
  const disposers = [];
  const logs = [];
  const service = makeAgentsService(agents);

  const ctx = {
    inject: (_deps, cb) => cb({ agents: service }),
    effect: (fn) => {
      const r = fn();
      if (typeof r === 'function') disposers.push(r);
      return r;
    },
    on: (evt, h) => {
      if (!handlers.has(evt)) handlers.set(evt, []);
      handlers.get(evt).push(h);
    },
    // 测试专用：手动派发事件
    emit(evt, payload) {
      for (const h of handlers.get(evt) ?? []) h(payload);
    },
    // 测试专用：把 agent 加进"内存池"并广播 session-start
    openSession(agent) {
      service.list = () => [agent];
      service.roots = () => [agent];
      service.get = (id) => (String(id) === String(agent.id) ? agent : undefined);
      ctx.emit('agent/session-start', { agent });
    },
    provide: () => {},
    cleanup() { for (const d of disposers.splice(0)) { try { d(); } catch { /* ignore */ } } },
    logs,
  };
  return ctx;
}

/** 准备一个"上次启动"的 marker：pid 与当前进程不同，且中断时长 > 防抖窗口。 */
function seedMarker(dshHome, { lastSessionId = 'session-A', hoursAgo = 2 } = {}) {
  const dir = join(dshHome, '.agint-restart');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'marker.json'), JSON.stringify({
    lastBootAt: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
    pid: 999999, // 故意不等于 process.pid → 判定为重启
    lastSessionId,
    lastActiveAt: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
  }), 'utf8');
  return dir;
}

/** 用独立 DSH_HOME 跑一次 apply，返回上下文与落盘路径。 */
function boot({ agents = [], config = {}, marker } = {}) {
  const dshHome = mkdtempSync(join(tmpdir(), 'agint-restart-pending-'));
  const prevEnv = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  const origLog = console.log;
  const origWarn = console.warn;
  const logs = [];
  console.log = (...a) => { logs.push(a.join(' ')); };
  console.warn = (...a) => { logs.push(a.join(' ')); };
  try {
    seedMarker(dshHome, marker ?? {});
    const ctx = makeCtx({ agents });
    apply(ctx, { stateDir: '.agint-restart', ...config });
    ctx.logs.push(...logs);
    return { ctx, dshHome, pendingPath: join(dshHome, '.agint-restart', 'pending-notice.json') };
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    if (prevEnv === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevEnv;
  }
}

test('重启后内存里没有活 agent：通知必须落盘，不得丢弃', () => {
  const { ctx, pendingPath } = boot();
  try {
    assert.ok(existsSync(pendingPath), '无活 agent 时应把通知落盘到 pending-notice.json');
    const doc = JSON.parse(readFileSync(pendingPath, 'utf8'));
    assert.equal(doc.lastSessionId, 'session-A', '待投通知要记住重启前那个会话');
    assert.equal(doc.reason, 'boot');
    assert.ok(typeof doc.bootAt === 'string' && doc.bootAt.length > 0);
    assert.ok(
      ctx.logs.some((l) => l.includes('notice parked')),
      '应打印落盘日志，便于事后取证：',
    );
  } finally {
    ctx.cleanup();
  }
});

test('待投通知：任一会话被打开后补投（wake = followup），并删除落盘副本', () => {
  const { ctx, pendingPath } = boot();
  try {
    assert.ok(existsSync(pendingPath));
    const agent = makeAgent('session-B'); // 不是重启前那个会话，也应补投
    ctx.openSession(agent);

    assert.equal(agent.received.length, 1, '会话起来后应补投一条');
    assert.equal(agent.received[0].via, 'followup', 'deliveryMode=wake 必须走 followup（真唤醒）');
    const text = agent.received[0].msg.content[0].text;
    assert.match(text, /已重启/, '补投的应是恢复通知原文');
    assert.ok(!text.includes('session-A'), 'v0.7.1 起会话 id 不再进消息体（纯状态陈述）');
    assert.ok(!existsSync(pendingPath), '补投成功后必须删除落盘副本');
  } finally {
    ctx.cleanup();
  }
});

test('已送达就不重复投：池里有目标时直接投，后续 session-start 不再补投', () => {
  const target = makeAgent('session-A');
  const { ctx, pendingPath } = boot({ agents: [target] });
  try {
    assert.equal(target.received.length, 1, '重启前那个会话若在内存中，应立即投递');
    assert.ok(!existsSync(pendingPath), '已送达就不该留下待投副本');

    const another = makeAgent('session-C');
    ctx.openSession(another);
    assert.equal(another.received.length, 0, '已送达后不应重复投递');
  } finally {
    ctx.cleanup();
  }
});

test('parkNoticeOnNoTarget:false 时退回旧行为：不落盘', () => {
  const { ctx, pendingPath } = boot({ config: { parkNoticeOnNoTarget: false } });
  try {
    assert.ok(!existsSync(pendingPath), '显式关闭时必须退回"找不到就丢弃"的旧行为');
  } finally {
    ctx.cleanup();
  }
});

test('pendingOnlyLastSession:true 时只认重启前那个会话', () => {
  const { ctx, pendingPath } = boot({ config: { pendingOnlyLastSession: true } });
  try {
    assert.ok(existsSync(pendingPath));
    const other = makeAgent('session-X');
    ctx.openSession(other);
    assert.equal(other.received.length, 0, '不是重启前那个会话，不应投递');
    assert.ok(existsSync(pendingPath), '未送达，待投副本应保留');

    const right = makeAgent('session-A');
    ctx.openSession(right);
    assert.equal(right.received.length, 1, '重启前那个会话起来后应补投');
    assert.ok(!existsSync(pendingPath));
  } finally {
    ctx.cleanup();
  }
});

test('非重启启动（pid 未变）不落盘也不投递', () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'agint-restart-norestart-'));
  const prevEnv = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  const origLog = console.log;
  const logs = [];
  console.log = (...a) => logs.push(a.join(' '));
  try {
    mkdirSync(join(dshHome, '.agint-restart'), { recursive: true });
    writeFileSync(join(dshHome, '.agint-restart', 'marker.json'), JSON.stringify({
      lastBootAt: new Date().toISOString(),
      pid: process.pid, // 与当前进程相同 → 判定为"没重启"
      lastSessionId: 'session-A',
    }), 'utf8');
    const ctx = makeCtx({ agents: [] });
    apply(ctx, { stateDir: '.agint-restart' });
    assert.ok(
      !existsSync(join(dshHome, '.agint-restart', 'pending-notice.json')),
      '正常启动不该落盘',
    );
    assert.ok(logs.some((l) => l.includes('no restart detected')), '应走正常启动分支');
    ctx.cleanup();
  } finally {
    console.log = origLog;
    if (prevEnv === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevEnv;
  }
});

test('源码护栏：找不到目标时必须落盘，不得再出现"直接丢弃"的旧分支', () => {
  const src = readFileSync(join(LIB_DIR, 'index.js'), 'utf8');
  assert.ok(!/skip wake/.test(src), '不应再出现 skip wake（旧行为会把通知丢掉）');
  assert.ok(/writePending\('boot'\)/.test(src), '重启分支必须先落盘通知');
  assert.ok(/tryFlushPending\(agent\)/.test(src), 'session-start 时必须尝试补投');
  assert.ok(/clearPending\(\)/.test(src), '送达后必须清除落盘副本');
  assert.ok(/deliveredForBoot/.test(src), 'v0.7.2：必须有"同一次 boot 只投一次"的去重位');
});

test('同一次 boot 只投一次：补投成功后 boot 轮询不得再投（v0.7.2 去重）', async () => {
  const { ctx, pendingPath } = boot();
  try {
    assert.ok(existsSync(pendingPath), '无活 agent 时应先落盘');
    const agent = makeAgent('session-A'); // 与 marker.lastSessionId 相同
    ctx.openSession(agent); // 走补投路径（matched=pending）
    assert.equal(agent.received.length, 1, 'session-start 时应补投 1 条');
    assert.ok(!existsSync(pendingPath), '补投成功应清掉落盘副本');
    // 让 boot 轮询跑满 ≥2 个周期（POLL_MS=500）：v0.7.1 会在这里投出第二条
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal(agent.received.length, 1, '同一次 boot 不得重复投递（双唤醒 = 重启环暴露面翻倍）');
  } finally {
    ctx.cleanup();
  }
});
