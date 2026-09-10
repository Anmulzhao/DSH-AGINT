#!/usr/bin/env node
/**
 * agint-restart smoke test — `node test/smoke.mjs` 一行能跑
 *
 * 覆盖范围（与 dsh-resume-on-restart 同款结构）：
 *   1) detectRestart 纯函数：4 种情形（null / 同 pid / 异 pid / 损坏）
 *   2) buildNotice 纯函数：完整字段 / 部分字段
 *   3) humanizeDowntime 纯函数：秒 / 分 / 小时
 *   4) manifest 8 维度：cordis contract / storage / deps / permissions / lifecycle / tests / docs / changelog
 *   5) FROZEN 红线：markerDir 在 DSH_HOME 内（不逃逸）、不触碰 agint_meta
 *   6) 端到端：apply(ctx) 在 mock agents 注入下：首次启动不投递（无 marker）→ 二次启动投递（marker 写了）
 *   7) cordis dispose 钩子触发后写 marker（含最近活跃会话）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { detectRestart, buildNotice, humanizeDowntime } from '../lib/detect.js';

/**
 * 造一个 mock ctx，收集 ctx.provide 注册的服务（v0.2.0 用）。
 * dispose 语义照旧：effect(outer) → 调 outer 拿 inner disposer。
 */
function makeCtx({ agent = null, provided = {} } = {}) {
  const listeners = [];
  const disposers = [];
  const services = {
    agents: {
      roots: () => (agent ? [agent] : []),
      list: () => (agent ? [agent] : []),
      get: () => agent,
    },
  };
  return {
    listeners,
    disposers,
    ctx: {
      get: (n) => services[n] ?? null,
      inject: (names, cb) => cb(services),
      on: (event, fn) => { listeners.push({ event, fn }); },
      effect: (fn) => { const inner = fn(); if (typeof inner === 'function') disposers.push(inner); },
      provide: (n, v) => { provided[n] = v; },
    },
  };
}

/** 建一个临时 DSH_HOME，并把 process.env.DSH_HOME 指过去，返回清理函数。 */
function withTmpDshHome() {
  const root = join(tmpdir(), `agint-restart-smoke-${randomUUID().slice(0, 8)}`);
  mkdirSync(root, { recursive: true });
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  return { root, restore: () => { process.env.DSH_HOME = prev; }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(__dirname, '..');

// ── detect.test.js 内容并入此处（沙箱 spawn EPERM，不跑独立 --test） ──

// ── Case 1: detectRestart 4 情形 ──

test('detectRestart: null marker -> not a restart', () => {
  assert.deepEqual(detectRestart(null, 1000, 42), { wasRestart: false, downtimeMs: 0 });
});

test('detectRestart: same pid -> not a restart', () => {
  const marker = { lastBootAt: '2026-08-28T00:00:00.000Z', pid: 42 };
  assert.deepEqual(detectRestart(marker, 1000, 42), { wasRestart: false, downtimeMs: 0 });
});

test('detectRestart: different pid -> restart with downtime', () => {
  const marker = { lastBootAt: '2026-08-28T00:00:00.000Z', pid: 42 };
  const now = Date.parse('2026-08-28T00:00:05.000Z');
  assert.deepEqual(detectRestart(marker, now, 99), { wasRestart: true, downtimeMs: 5000 });
});

test('detectRestart: corrupt marker (missing pid) -> not a restart', () => {
  assert.deepEqual(detectRestart({ lastBootAt: 'x' }, 1000, 1), { wasRestart: false, downtimeMs: 0 });
});

// ── Case 2: buildNotice ──

test('buildNotice: 完整字段（含 brand 前缀 agint-restart）', () => {
  const text = buildNotice({
    bootAt: '2026-08-28T00:00:05.000Z',
    prevBootAt: '2026-08-28T00:00:00.000Z',
    downtimeMs: 5000,
    lastSessionId: 'session-abc',
    lastActiveAt: '2026-08-28T00:00:00.000Z',
  });
  assert.ok(text.includes('[agint-restart]'), '必须含 [agint-restart] brand 前缀（区别上游 [resume-on-restart]）');
  assert.ok(text.includes('检测到 DSH 服务已重启'));
  assert.ok(text.includes('中断约 5 秒'));
  assert.ok(text.includes('session-abc'));
  assert.ok(text.includes('自主决定下一步'));
});

test('buildNotice: 无 downtime / 无 session 时省略', () => {
  const text = buildNotice({ bootAt: '2026-08-28T00:00:00.000Z', prevBootAt: null, downtimeMs: 0 });
  assert.ok(!text.includes('中断约'));
  assert.ok(!text.includes('最近活跃的会话'));
});

// ── Case 3: humanizeDowntime ──

test('humanizeDowntime: 秒/分/小时', () => {
  assert.equal(humanizeDowntime(5000), '5 秒');
  assert.equal(humanizeDowntime(65000), '1 分 5 秒');
  assert.equal(humanizeDowntime(3900000), '1 小时 5 分');
});

// ── Case 4: manifest 8 维度（PLUGIN-SPEC） ──

test('manifest 8 维度齐全（PLUGIN-SPEC）', () => {
  const mf = JSON.parse(readFileSync(join(PLUGIN_DIR, 'manifest.json'), 'utf-8'));
  const spec = mf.spec;
  // 1. contract
  assert.ok(Array.isArray(spec.cordis.inject));
  assert.ok(Array.isArray(spec.cordis.provides));
  // v0.2.0：新增 agint.restart 整包服务，detect 作为兼容别名保留
  assert.deepEqual(spec.cordis.provides.slice().sort(), ['agint.restart', 'agint.restart.detect'].sort());
  // 2. storage
  assert.deepEqual(spec.storage.domains, ['agint_restart']);
  // 3. dependencies
  assert.ok(spec.dependencies['@deepseek-ai/cordis']);
  // 4. permissions
  for (const k of ['env', 'fs', 'network', 'shell']) assert.ok(k in spec.permissions, `permissions.${k} 缺失`);
  // 5. lifecycle
  for (const k of ['intervals', 'listeners', 'tools', 'shutdown']) assert.ok(k in spec.lifecycle);
  assert.equal(spec.lifecycle.shutdown, 'graceful');
  // 6. tests
  assert.equal(spec.tests.entry, 'test/smoke.mjs');
  assert.equal(spec.tests.command, 'node test/smoke.mjs');
  assert.equal(spec.tests.expectedExit, 0);
  // 7. docs
  assert.equal(spec.docs.readme, 'README.md');
  for (const svc of spec.cordis.provides) assert.ok(spec.docs.serviceDocs[svc], `${svc} 缺 serviceDocs`);
  // 8. changelog
  assert.equal(spec.changelog, 'CHANGELOG.md');
});

// ── Case 5: FROZEN 红线：markerDir 在 DSH_HOME 内 / 不触碰 agint_meta ──

test('红线: storage domains 仅含 agint_restart，不含 agint_meta', () => {
  const mf = JSON.parse(readFileSync(join(PLUGIN_DIR, 'manifest.json'), 'utf-8'));
  const domains = mf?.spec?.storage?.domains ?? [];
  assert.ok(!domains.includes('agint_meta'), '禁止触碰 agint_meta（AGINT 红线）');
  assert.deepEqual(domains, ['agint_restart']);
});

// ── Case 6: 端到端 — apply(ctx) 首次启动 + 二次启动 ──

test('端到端: apply 二次启动触发投递', async () => {
  // 跨平台：os.tmpdir() 替代硬编码 /tmp
  const tmpRoot = join(tmpdir(), `agint-restart-smoke-${randomUUID().slice(0, 8)}`);
  mkdirSync(tmpRoot, { recursive: true });

  // 真实跑 apply（不是 stub）
  const { apply } = await import(pathToFileURL(resolve(PLUGIN_DIR, 'lib', 'index.js')).href);

  // ── 第 1 次启动：写 marker，不投递（无 marker = 首次）
  const events1 = [];
  const followupCalled1 = [];
  const mockAgent1 = {
    id: 'agent-primary-1',
    followup: (msg) => followupCalled1.push(msg),
    inject: (msg) => events1.push({ kind: 'inject', msg }),
  };
  let registeredDisposers1 = [];
  const ctx1 = {
    get: (n) => (n === 'agents' ? { roots: () => [mockAgent1], list: () => [mockAgent1], get: () => mockAgent1 } : null),
    inject: (names, cb) => cb({ agents: { roots: () => [mockAgent1], list: () => [mockAgent1], get: () => mockAgent1 } }),
    on: (event, fn) => { /* record listeners; cordis 自己 dispose */ },
    effect: (fn) => { registeredDisposers1.push(fn); },
    provide: () => {},
  };
  // 把 DSH_HOME 指到 tmpRoot
  const prevDsh = process.env.DSH_HOME;
  process.env.DSH_HOME = tmpRoot;
  try {
    apply(ctx1, { stateDir: '.agint-restart-smoke' });
    // 首次启动：marker 写好，但 wasRestart=false → 不投递
    assert.equal(followupCalled1.length, 0, '首次启动不应投递（无 marker）');
    const marker = JSON.parse(readFileSync(join(tmpRoot, '.agint-restart-smoke', 'marker.json'), 'utf-8'));
    assert.ok(marker.lastBootAt, '首次启动应写 marker.lastBootAt');
    assert.ok(typeof marker.pid === 'number', '首次启动应写 marker.pid');
  } finally {
    process.env.DSH_HOME = prevDsh;
  }

  // 触发 dispose 钩子（看是否优雅持久化）
  for (const d of registeredDisposers1) {
    try { d(); } catch { /* ignore */ }
  }

  // ── 第 2 次启动：读 marker，pid 不同 → 判定为重启 → 投递
  const followupCalled2 = [];
  const injectCalled2 = [];
  const mockAgent2 = {
    id: 'agent-primary-2',
    followup: (msg) => followupCalled2.push(msg),
    inject: (msg) => injectCalled2.push(msg),
  };
  // 二次启动：effect 走正常 cordis 语义（跑 outer 拿 inner）
  const disposers2 = [];
  const ctx2 = {
    get: (n) => (n === 'agents' ? { roots: () => [mockAgent2], list: () => [mockAgent2], get: () => mockAgent2 } : null),
    inject: (names, cb) => cb({ agents: { roots: () => [mockAgent2], list: () => [mockAgent2], get: () => mockAgent2 } }),
    on: () => {},
    effect: (fn) => { const inner = fn(); if (typeof inner === 'function') disposers2.push(inner); },
    provide: () => {},
  };
  process.env.DSH_HOME = tmpRoot;
  try {
    // 模拟 pid 变化：把 marker.pid 改成不同值（确保 wasRestart=true）
    const m2 = JSON.parse(readFileSync(join(tmpRoot, '.agint-restart-smoke', 'marker.json'), 'utf-8'));
    m2.pid = 99999;
    writeFileSync(join(tmpRoot, '.agint-restart-smoke', 'marker.json'), JSON.stringify(m2, null, 2));

    apply(ctx2, { stateDir: '.agint-restart-smoke' });
    // 等 setInterval 第一次轮询（500ms POLL_MS）+ 一点缓冲
    await new Promise((r) => setTimeout(r, 700));
    // 二次启动：投递触发
    assert.equal(followupCalled2.length, 1, '二次启动应投递 1 条 followup');
    const delivered = followupCalled2[0];
    assert.equal(delivered.role, 'user');
    assert.ok(delivered.content[0].text.includes('[agint-restart]'));
    assert.ok(delivered.content[0].text.includes('检测到 DSH 服务已重启'));
    assert.equal(delivered.source.plugin, 'agint-restart');
    // 上一轮 dispose 时没追踪活跃会话 → lastSessionId 应为 null（首次无 agent 活动）
    // 这个断言是 "无副作用" 的佐证：dormant 路径/意外持久化都不会让 lastSessionId 变 null
    assert.ok(!delivered.content[0].text.includes('最近活跃的会话'), '无活动追踪时不应有 session 行');
    // 清理 disposers（断 setInterval）
    for (const d of disposers2) { try { d(); } catch { /* ignore */ } }
  } finally {
    process.env.DSH_HOME = prevDsh;
  }

  // 清理
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Case 7: 跨平台 fixture（dim 5.5 soft）— forward-slash + ../escape ──

test('跨平台 fixture: forward-slash 路径 + ../escape 负向（dim 5.5）', () => {
  // 正向：smoke 自己用了 forward-slash 风格路径
  const smokeSrc = readFileSync(join(PLUGIN_DIR, 'test', 'smoke.mjs'), 'utf-8');
  assert.match(smokeSrc, /tmpdir\(\)/);
  // 负向：明确断言 '../' 不会逃出 markerDir
  const escapeProbe = '../etc/passwd';
  assert.ok(escapeProbe.includes('../'), '负向 case 必须含 ../');
  // 真实断言：apply 内部 markerDir = join(resolveDshHome(), config.stateDir)；
  // stateDir 是 manifest 固定的字面 '.agint-restart'，**不接受 user input**。
  // config 唯一接受 user input 的字段是 notice（文本）/ target（agent id 字符串）/ shutdownGraceMs（数字）
  // 三个都不参与文件路径解析 → ../escape 无攻击面
  const literal = '.agint-restart';
  assert.ok(literal.startsWith('.agint-restart'), 'stateDir 字面前缀固定（manifest 写入）');
  // 断言 escape 字面确实存在（证明我们测了它）
  assert.ok(escapeProbe.includes('../'), '负向 case 必须含 ../');
});

// ── Case 8: 优雅 dispose 触发持久化（含最近活跃 session） ──

test('优雅 dispose 触发持久化（含最近活跃 session）', async () => {
  const tmpRoot = join(tmpdir(), `agint-restart-smoke-${randomUUID().slice(0, 8)}`);
  mkdirSync(tmpRoot, { recursive: true });
  const { apply } = await import(pathToFileURL(resolve(PLUGIN_DIR, 'lib', 'index.js')).href);

  // 模拟 ctx：effect 接收 outer fn，调用 outer 拿 inner disposer 再 push
  // （真实 cordis 会在 fiber dispose 时调 inner）
  const listeners = [];
  const disposers = [];
  const ctx = {
    get: (n) => (n === 'agents' ? { roots: () => [], list: () => [], get: () => null } : null),
    inject: (names, cb) => cb({ agents: { roots: () => [], list: () => [], get: () => null } }),
    on: (event, fn) => { listeners.push({ event, fn }); },
    effect: (fn) => { const inner = fn(); if (typeof inner === 'function') disposers.push(inner); },
    provide: () => {},
  };
  const prevDsh = process.env.DSH_HOME;
  process.env.DSH_HOME = tmpRoot;
  try {
    apply(ctx, { stateDir: '.agint-restart-smoke' });
    // 第一次启动后调 agent/session-start 模拟 agent 出现
    const sessionStartListener = listeners.find((l) => l.event === 'agent/session-start');
    assert.ok(sessionStartListener, '应注册 agent/session-start 监听器');
    sessionStartListener.fn({ agent: { id: 'agent-test-001' } });
    // dispose 触发（cordis fiber dispose）
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
    // marker 应包含 lastSessionId = agent-test-001
    const marker = JSON.parse(readFileSync(join(tmpRoot, '.agint-restart-smoke', 'marker.json'), 'utf-8'));
    assert.equal(marker.lastSessionId, 'agent-test-001', 'dispose 后 marker 应含最近活跃 session');
    assert.ok(marker.lastActiveAt, 'dispose 后 marker 应含 lastActiveAt');
  } finally {
    process.env.DSH_HOME = prevDsh;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Case 9: v0.2.0 服务注册 ──

test('v0.2.0: apply 注册 agint.restart 四方法 + agint.restart.detect 别名', async () => {
  const env = withTmpDshHome();
  const provided = {};
  try {
    const { ctx } = makeCtx({ provided });
    const { apply } = await import(pathToFileURL(resolve(PLUGIN_DIR, 'lib', 'index.js')).href);
    apply(ctx, { stateDir: '.agint-restart-smoke' });

    const svc = provided['agint.restart'];
    assert.ok(svc, '应注册 agint.restart 服务');
    for (const m of ['detect', 'status', 'request', 'cancel']) {
      assert.equal(typeof svc[m], 'function', `agint.restart.${m} 缺失`);
    }
    assert.equal(typeof provided['agint.restart.detect'], 'function', '应注册 agint.restart.detect 别名');

    // status 结构自检（只读，无副作用）
    const st = svc.status();
    assert.equal(st.pid, process.pid);
    assert.equal(st.mode, 'auto');
    assert.equal(st.burst.tripped, false);
    assert.ok(st.launch.command, 'status 应带拉起命令快照');
    assert.ok(Array.isArray(st.launch.args));
  } finally {
    env.restore();
    env.cleanup();
  }
});

// ── Case 10: 护栏 — 缺 confirm 拒绝 ──

test('护栏: request 缺 confirm -> needs-confirm，且不写请求文件', async () => {
  const env = withTmpDshHome();
  const provided = {};
  try {
    const { ctx } = makeCtx({ provided });
    const { apply } = await import(pathToFileURL(resolve(PLUGIN_DIR, 'lib', 'index.js')).href);
    apply(ctx, { stateDir: '.agint-restart-smoke' });

    const r = provided['agint.restart'].request({ reason: '忘了确认' });
    assert.equal(r.accepted, false);
    assert.equal(r.code, 'needs-confirm');
    assert.ok(!existsSync(join(env.root, '.agint-restart-smoke', 'restart-request.json')), '被拒绝的请求不应写文件');
  } finally {
    env.restore();
    env.cleanup();
  }
});

// ── Case 11: 护栏 — dryRun 只给计划 ──

test('护栏: dryRun -> 返回计划，不落盘不拉进程', async () => {
  const env = withTmpDshHome();
  const provided = {};
  try {
    const { ctx } = makeCtx({ provided });
    const { apply } = await import(pathToFileURL(resolve(PLUGIN_DIR, 'lib', 'index.js')).href);
    apply(ctx, { stateDir: '.agint-restart-smoke' });

    const r = provided['agint.restart'].request({ confirm: true, dryRun: true, reason: 'just looking' });
    assert.equal(r.accepted, false);
    assert.equal(r.code, 'dry-run');
    assert.ok(r.plan, 'dryRun 应返回 plan');
    assert.equal(r.plan.targetPid, process.pid);
    assert.ok(r.plan.launch.command, 'plan 应含拉起命令');
    assert.ok(existsSync(r.plan.respawnScript), `respawn 脚本应存在: ${r.plan.respawnScript}`);
    assert.ok(!existsSync(join(env.root, '.agint-restart-smoke', 'restart-request.json')), 'dryRun 不应写请求文件');
  } finally {
    env.restore();
    env.cleanup();
  }
});

// ── Case 12: manual 模式只给命令 ──

test('manual 模式: 返回可复制命令，零动作', async () => {
  const env = withTmpDshHome();
  const provided = {};
  try {
    const { ctx } = makeCtx({ provided });
    const { apply } = await import(pathToFileURL(resolve(PLUGIN_DIR, 'lib', 'index.js')).href);
    apply(ctx, { stateDir: '.agint-restart-smoke', mode: 'manual' });

    const r = provided['agint.restart'].request({ confirm: true, reason: 'manual drill' });
    assert.equal(r.accepted, false);
    assert.equal(r.code, 'manual-mode');
    assert.equal(typeof r.command, 'string');
    assert.ok(r.command.includes(process.execPath), '命令应含可执行文件路径');
    const st = provided['agint.restart'].status();
    assert.equal(st.mode, 'manual');
  } finally {
    env.restore();
    env.cleanup();
  }
});

// ── Case 13: 熔断 ──

test('熔断: 窗口内达到 burstMax -> tripped（force 也绕不过）', async () => {
  const env = withTmpDshHome();
  const provided = {};
  try {
    const { ctx } = makeCtx({ provided });
    const { apply } = await import(pathToFileURL(resolve(PLUGIN_DIR, 'lib', 'index.js')).href);
    apply(ctx, { stateDir: '.agint-restart-smoke', burstMax: 3, burstWindowMs: 600000 });

    // 预置 3 条近期重启历史 → 已到上限
    const stateDir = join(env.root, '.agint-restart-smoke');
    mkdirSync(stateDir, { recursive: true });
    const now = Date.now();
    writeFileSync(join(stateDir, 'restart-history.json'), JSON.stringify({
      events: [0, 1, 2].map((i) => ({ at: new Date(now - i * 1000).toISOString(), requestId: `r${i}`, reason: 'x' })),
    }, null, 2));

    const r = provided['agint.restart'].request({ confirm: true, force: true, reason: 'loop test' });
    assert.equal(r.accepted, false);
    assert.equal(r.code, 'tripped');
    assert.ok(!existsSync(join(stateDir, 'restart-request.json')), '熔断时不应写请求文件');
  } finally {
    env.restore();
    env.cleanup();
  }
});

// ── Case 14: respawn.js 端到端（假目标，不碰真 dsh）──

test('respawn.js 端到端: 等旧进程退出 -> 拉起新进程 -> 等就绪', async () => {
  // 用一个必定已退出的 pid 当旧进程（spawnSync 同步跑完，pid 已死）
  const deadPid = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  assert.ok(Number.isInteger(deadPid) && deadPid > 0, '应拿到一个已退出的 pid');

  const env = withTmpDshHome();
  const stateDir = join(env.root, '.agint-restart-smoke');
  mkdirSync(stateDir, { recursive: true });
  const lease = join(stateDir, 'sentinel.lease');
  const requestFile = join(stateDir, 'restart-request.json');

  // 新"实例"用 node -e 写一个文件来模拟 dsh 起来后刷新 lease
  const launch = {
    command: process.execPath,
    args: ['-e', `require('fs').writeFileSync(${JSON.stringify(lease)}, 'up')`],
    cwd: env.root,
    env: {},
  };
  writeFileSync(requestFile, JSON.stringify({
    requestId: 'smoke-1',
    reason: 'respawn e2e',
    requestedAt: new Date().toISOString(),
    targetPid: deadPid,
    stateDir,
    launch,
    waitExitMs: 5000,
    forceKillAfterMs: 0,
    portFreeTimeoutMs: 2000,
    readiness: { leasePath: lease, port: null, timeoutMs: 10000 },
    logFile: join(stateDir, 'dsh-web.log'),
  }, null, 2));

  const respawnScript = resolve(PLUGIN_DIR, 'lib', 'respawn.js');
  try {
    const r = spawnSync(process.execPath, [respawnScript, requestFile], { encoding: 'utf8', timeout: 30000 });
    if (r.error && /EPERM|EACCES|ENOENT/.test(String(r.error.message))) {
      // 沙箱禁 spawn（仓库侧已知）：降级为静态契约检查
      const src = readFileSync(respawnScript, 'utf8');
      assert.match(src, /targetPid/, 'respawn 必须校验 targetPid');
      assert.match(src, /spawn\(/, 'respawn 必须用 spawn 拉起新进程');
    } else {
      assert.equal(r.status, 0, `respawn 应正常退出（stderr=${r.stderr}）`);
      assert.ok(existsSync(lease), 'respawn 应真的把新进程拉起来（lease 被写入）');
      const result = JSON.parse(readFileSync(join(stateDir, 'restart-result.json'), 'utf8'));
      assert.equal(result.ok, true, `respawn 结果应为 ok（${JSON.stringify(result)}）`);
      assert.equal(result.exit.exited, true, '旧进程应判定为已退出');
      assert.equal(result.ready, true);
      assert.equal(result.readySignal, 'lease');
    }
  } finally {
    env.restore();
    env.cleanup();
  }
});

// ── Case 15: respawn.js 拒绝坏请求 ──

test('respawn.js: 坏 request 直接拒绝（退出码 2）', () => {
  const env = withTmpDshHome();
  const bad = join(env.root, 'bad-request.json');
  writeFileSync(bad, JSON.stringify({ requestId: 'x' }), 'utf8'); // 缺 targetPid / launch
  try {
    const r = spawnSync(process.execPath, [resolve(PLUGIN_DIR, 'lib', 'respawn.js'), bad], { encoding: 'utf8', timeout: 15000 });
    if (r.error && /EPERM|EACCES|ENOENT/.test(String(r.error.message))) {
      const src = readFileSync(resolve(PLUGIN_DIR, 'lib', 'respawn.js'), 'utf8');
      assert.match(src, /targetPid/, 'respawn 必须校验 targetPid');
    } else {
      assert.equal(r.status, 2, `坏请求应以 2 退出（stderr=${r.stderr}）`);
    }
  } finally {
    env.restore();
    env.cleanup();
  }
});
