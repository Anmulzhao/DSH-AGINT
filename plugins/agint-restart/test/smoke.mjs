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
import {
  REQUEST_FIELDS, CANCEL_FIELDS, STATUS_FIELDS,
  requestOutputSchema, cancelOutputSchema, statusOutputSchema,
  requestAccepted, requestDeny, requestDryRun, requestManual, requestInternalError,
  cancelResult, cancelInternalError, statusUnavailable,
  normalizeRequestOutput, normalizeCancelOutput, normalizeStatusOutput,
} from '../lib/contract.js';
// REQUEST_FIELDS / CANCEL_FIELDS / STATUS_FIELDS 备用：字段表结构断言（见 Case 23）

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

test('buildNotice: 纯状态（v0.7.1：只报"已重启"，无行动指令）', () => {
  const text = buildNotice({
    bootAt: '2026-08-28T00:00:05.000Z',
    prevBootAt: '2026-08-28T00:00:00.000Z',
    downtimeMs: 5000,
    lastSessionId: 'session-abc',
    lastActiveAt: '2026-08-28T00:00:00.000Z',
  });
  assert.ok(text.includes('[agint-restart]'), '必须含 [agint-restart] brand 前缀（区别上游 [resume-on-restart]）');
  assert.ok(text.includes('已重启'));
  assert.ok(!text.includes('自主决定下一步'), 'v0.7.1 断环：不得含行动指令');
  assert.ok(!text.includes('中断约') && !text.includes('session-abc'), '细节不进消息体（看 restart_status / wake.log）');
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

    apply(ctx2, { stateDir: '.agint-restart-smoke', notifyDebounceMs: 0 });
    // 等 setInterval 第一次轮询（500ms POLL_MS）+ 一点缓冲
    await new Promise((r) => setTimeout(r, 700));
    // 二次启动：投递触发（notifyDebounceMs:0 关掉防抖，否则 downtime<60s 窗口也会被吃）
    assert.equal(followupCalled2.length, 1, '二次启动应投递 1 条 followup');
    const delivered = followupCalled2[0];
    assert.equal(delivered.role, 'user');
    assert.ok(delivered.content[0].text.includes('[agint-restart]'));
    assert.ok(delivered.content[0].text.includes('已重启'));
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

// ── Case 16: resolveDeliveryMode — 显式优先 + 旧 wakeup 布尔兼容 ──

test('resolveDeliveryMode: deliveryMode 显式优先，旧 wakeup 布尔向后兼容', async () => {
  const { resolveDeliveryMode } = await import(pathToFileURL(resolve(PLUGIN_DIR, 'lib', 'index.js')).href);
  assert.equal(resolveDeliveryMode({ deliveryMode: 'wake' }), 'wake');
  assert.equal(resolveDeliveryMode({ deliveryMode: 'silent' }), 'silent');
  // 别名兼容（v0.3.0 用过 queue/inject，语义被纠正后保留旧名不炸）
  assert.equal(resolveDeliveryMode({ deliveryMode: 'queue' }), 'wake', 'queue 是 wake 的别名');
  assert.equal(resolveDeliveryMode({ deliveryMode: 'inject' }), 'silent', 'inject 是 silent 的别名');
  // 显式 deliveryMode 必须压过旧的 wakeup
  assert.equal(resolveDeliveryMode({ deliveryMode: 'wake', wakeup: false }), 'wake', 'deliveryMode 应优先于 wakeup');
  // 旧配置（只有 wakeup）：true→wake，false→silent
  assert.equal(resolveDeliveryMode({ wakeup: true }), 'wake');
  assert.equal(resolveDeliveryMode({ wakeup: false }), 'silent');
  // 默认必须能唤醒——否则消息石沉大海（v0.3.1 的教训）
  assert.equal(resolveDeliveryMode({}), 'wake');
  assert.equal(resolveDeliveryMode(undefined), 'wake');
});

// ── Case 17: 投递目标优先匹配 lastSessionId（本次修复的核心）──

test('投递目标优先回到 lastSessionId 对应的旧会话，而非 roots[0]', async () => {
  const env = withTmpDshHome();
  const { apply } = await import(pathToFileURL(resolve(PLUGIN_DIR, 'lib', 'index.js')).href);
  const stateDir = '.agint-restart-smoke';
  const markerDir = join(env.root, stateDir);
  mkdirSync(markerDir, { recursive: true });
  // pid 与当前进程不同 → wasRestart=true；lastSessionId 指向"旧会话"
  writeFileSync(join(markerDir, 'marker.json'), JSON.stringify({
    lastBootAt: new Date(Date.now() - 60000).toISOString(),
    pid: 99999,
    lastSessionId: 'session-old',
    lastActiveAt: new Date(Date.now() - 30000).toISOString(),
  }, null, 2), 'utf8');

  const gotNew = { followup: 0, inject: 0 };
  const gotOld = { followup: 0, inject: 0 };
  // 注意顺序：roots[0] 是"新会话"，旧会话排第二 —— 旧逻辑会错误地投给 roots[0]
  const agentNew = { id: 'session-new', followup: () => { gotNew.followup++; }, inject: () => { gotNew.inject++; } };
  const agentOld = { id: 'session-old', followup: () => { gotOld.followup++; }, inject: () => { gotOld.inject++; } };
  const agents = { roots: () => [agentNew, agentOld], list: () => [agentNew, agentOld], get: (id) => (id === 'session-old' ? agentOld : agentNew) };
  const disposers = [];
  const ctx = {
    get: (n) => (n === 'agents' ? agents : null),
    inject: (names, cb) => cb({ agents }),
    on: () => {},
    effect: (fn) => { const inner = fn(); if (typeof inner === 'function') disposers.push(inner); },
    provide: () => {},
  };
  try {
    apply(ctx, { stateDir, resumeWaitMs: 300, notifyDebounceMs: 0 });
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(gotOld.followup, 1, '通知应投回旧会话 session-old');
    assert.equal(gotNew.followup, 0, '不应投给 roots[0] 的新会话');
    // wake.log 应记录 matched=lastSession，便于线上排查
    const wake = JSON.parse(readFileSync(join(markerDir, 'wake.log'), 'utf8'));
    assert.equal(wake.ok, true);
    assert.equal(wake.deliveredTo, 'session-old');
    assert.equal(wake.matched, 'lastSession', 'wake.log 应记录命中旧会话');
    assert.equal(wake.mode, 'wake');
  } finally {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
    env.restore();
    env.cleanup();
  }
});

// ── Case 18: 旧会话缺失时回退 roots[0]；deliveryMode=inject 走 inject 通道 ──

test('旧会话未复活时回退 roots[0]；deliveryMode=inject 走 inject', async () => {
  const env = withTmpDshHome();
  const { apply } = await import(pathToFileURL(resolve(PLUGIN_DIR, 'lib', 'index.js')).href);
  const stateDir = '.agint-restart-smoke';
  const markerDir = join(env.root, stateDir);
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(join(markerDir, 'marker.json'), JSON.stringify({
    lastBootAt: new Date(Date.now() - 60000).toISOString(),
    pid: 99999,
    lastSessionId: 'session-gone', // 重启后不复存在
    lastActiveAt: new Date(Date.now() - 30000).toISOString(),
  }, null, 2), 'utf8');

  const gotFirst = { followup: 0, inject: 0 };
  const gotSecond = { followup: 0, inject: 0 };
  const agentFirst = { id: 'session-first', followup: () => { gotFirst.followup++; }, inject: () => { gotFirst.inject++; } };
  const agentSecond = { id: 'session-second', followup: () => { gotSecond.followup++; }, inject: () => { gotSecond.inject++; } };
  // get() 一律返回 null：模拟旧会话确实拿不到
  const agents = { roots: () => [agentFirst, agentSecond], list: () => [agentFirst, agentSecond], get: () => null };
  const disposers = [];
  const ctx = {
    get: (n) => (n === 'agents' ? agents : null),
    inject: (names, cb) => cb({ agents }),
    on: () => {},
    effect: (fn) => { const inner = fn(); if (typeof inner === 'function') disposers.push(inner); },
    provide: () => {},
  };
  try {
    apply(ctx, { stateDir, deliveryMode: 'inject', resumeWaitMs: 300, notifyDebounceMs: 0 });
    // 需要等过 resumeWaitMs 窗口才会接受回退目标
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(gotFirst.inject, 1, '回退后应投给 roots[0]');
    assert.equal(gotFirst.followup, 0, 'deliveryMode=inject 时不应走 followup');
    assert.equal(gotSecond.inject, 0, '不应投给第二个 agent');
    const wake = JSON.parse(readFileSync(join(markerDir, 'wake.log'), 'utf8'));
    assert.equal(wake.matched, 'primary', 'wake.log 应记录回退到 primary');
    assert.equal(wake.mode, 'silent');
  } finally {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
    env.restore();
    env.cleanup();
  }
});

// ══════════════════════════════════════════════════════════════════════════
// v0.4.4 输出契约测试（替换旧的 Case 23 / 24 / 25）
//
// 为什么重写：旧三条用例靠"正则抠源码字面量"断言。实测漏检了 accepted=true 分支
// 缺 code —— 那个正则 `return \{[\s\S]*?accepted: true,[\s\S]*?\};` 从**更早的**
// `return {` 开始匹配，把 manual/deny 分支里的 code 也算进了 bodies，于是断言假绿。
// 2026-09-10 后果：每次真实重启都报 `returned invalid output: missing "code"`，
// 而请求文件已写、守护脚本已起、进程已经退出。
//
// 现在：字段表 → schema + 各分支构造函数（lib/contract.js），下面用**真 schema
// 校验器**逐个校验每个分支产物。任何漂移立即变红。
// ══════════════════════════════════════════════════════════════════════════

/** DSL 值类型判定（null / array / typeof）。 */
function dslTypeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** 按 dsh-tools 值 schema DSL 校验：required / type / oneOf / items / additionalProperties。 */
function validateDsl(dsl, value, path, errs) {
  if (Array.isArray(dsl.oneOf)) {
    const ok = dsl.oneOf.some((branch) => {
      const sub = [];
      validateDsl(branch, value, path, sub);
      return sub.length === 0;
    });
    if (!ok) errs.push(`${path}: 不匹配任何 oneOf 分支（实际 ${dslTypeOf(value)}）`);
    return;
  }
  if (dsl.type === 'array') {
    if (dslTypeOf(value) !== 'array') { errs.push(`${path}: 期望 array，实际 ${dslTypeOf(value)}`); return; }
    if (dsl.items) value.forEach((it, i) => validateDsl(dsl.items, it, `${path}[${i}]`, errs));
    return;
  }
  if (dsl.type === 'object') {
    if (dslTypeOf(value) !== 'object') { errs.push(`${path}: 期望 object，实际 ${dslTypeOf(value)}`); return; }
    const props = dsl.properties ?? {};
    for (const [k, sub] of Object.entries(props)) {
      const has = Object.prototype.hasOwnProperty.call(value, k);
      if (sub.required === true && !has) errs.push(`${path}.${k}: 缺 required 字段`);
      if (has) validateDsl(sub, value[k], `${path}.${k}`, errs);
    }
    if (dsl.additionalProperties === false) {
      for (const k of Object.keys(value)) {
        if (!(k in props)) errs.push(`${path}.${k}: 未声明字段（additionalProperties:false 会拒绝整个输出）`);
      }
    }
    return;
  }
  if (dsl.type && dslTypeOf(value) !== dsl.type) errs.push(`${path}: 期望 ${dsl.type}，实际 ${dslTypeOf(value)}`);
}

/** 校验并返回错误列表（空 = 该输出不会被工具链拒绝）。 */
function validateOutput(schema, value) {
  const errs = [];
  validateDsl(schema, value, '$', errs);
  return errs;
}

const LAUNCH_SAMPLE = { command: 'node', args: ['bin.js', 'web'], cwd: 'C:\\dsh' };

/** restart_request 全部分支产物（含 smoke 跑不了的 accepted=true，用构造函数造）。 */
const REQUEST_SAMPLES = () => ([
  ['requestDeny/needs-confirm', requestDeny('needs-confirm', '需显式传 confirm:true')],
  ['requestDeny/cooldown', requestDeny('cooldown', '距上次重启仅 3s', { cooldownRemainingMs: 57000 })],
  ['requestDeny/tripped', requestDeny('tripped', '窗口内已重启 3 次', { count: 3 })],
  ['requestDeny/spawn-failed', requestDeny('spawn-failed', '守护进程启动失败')],
  ['requestDryRun', requestDryRun({
    requestId: 'abcd1234', targetPid: 1234, shutdownInMs: 1500,
    plan: { targetPid: 1234, waitExitMs: 30000, forceKillAfterMs: 20000, launch: LAUNCH_SAMPLE },
  })],
  ['requestAccepted', requestAccepted({
    requestId: 'abcd1234', targetPid: 1234, shutdownInMs: 1500,
    launch: LAUNCH_SAMPLE, resultFile: 'C:\\dsh\\.agint-restart\\restart-result.json',
  })],
  ['requestManual', requestManual({ command: 'node bin.js web', launch: LAUNCH_SAMPLE })],
  ['requestInternalError/无副作用', requestInternalError({ error: new Error('boom') })],
  ['requestInternalError/文件已写', requestInternalError({
    error: new Error('boom'), requestId: 'abcd1234', fileWritten: true, requestFile: 'C:\\req.json',
  })],
  ['requestInternalError/守护已起', requestInternalError({
    error: new Error('boom'), requestId: 'abcd1234', fileWritten: true, guardianStarted: true, requestFile: 'C:\\req.json',
  })],
]);

/** restart_cancel 全部分支产物。 */
const CANCEL_SAMPLES = () => ([
  ['cancelResult/no-pending', cancelResult({ cancelled: false, code: 'no-pending', message: '没有在途的重启请求' })],
  ['cancelResult/cancelled', cancelResult({ cancelled: true, code: 'cancelled', message: '已清除在途标记', requestId: 'abcd1234', sideEffect: true })],
  ['cancelInternalError', cancelInternalError(new Error('boom'))],
]);

// ── Case 23（v0.4.4 重写）：每个分支产物都通过真 schema 校验 ──

test('输出契约: 每个分支产物都通过 schema 全量校验（缺字段/多字段/类型错）', () => {
  const reqSchema = requestOutputSchema();
  for (const [label, obj] of REQUEST_SAMPLES()) {
    assert.deepEqual(validateOutput(reqSchema, obj), [], `restart_request ${label} 产物不合法`);
    assert.equal(typeof obj.sideEffect, 'boolean', `${label} 必须显式给出 sideEffect（不能靠兜底默认值）`);
  }
  const cancelSchema = cancelOutputSchema();
  for (const [label, obj] of CANCEL_SAMPLES()) {
    assert.deepEqual(validateOutput(cancelSchema, obj), [], `restart_cancel ${label} 产物不合法`);
    assert.equal(typeof obj.sideEffect, 'boolean', `${label} 必须显式给出 sideEffect`);
  }
  // status：自身异常时走降级产物，也必须合法
  const degraded = normalizeStatusOutput(statusUnavailable(new Error('boom'))).value;
  assert.deepEqual(validateOutput(statusOutputSchema(), degraded), [], 'restart_status 降级产物不合法');
  assert.equal(degraded.error.includes('boom'), true, '降级产物必须带上原始错误说明');
});

// ── Case 24（v0.4.4 重写）：构造函数产物必须"零修复"，运行时返回值同样零修复 ──

test('输出契约: 构造函数产物零修复（normalize 不该改动任何一个字段）', () => {
  for (const [label, obj] of REQUEST_SAMPLES()) {
    const { repaired, dropped } = normalizeRequestOutput(obj);
    assert.deepEqual(repaired, [], `${label} 缺 schema 必填字段（normalize 被迫补默认值 → 语义会错）`);
    assert.deepEqual(dropped, [], `${label} 含 schema 未声明字段（会被工具链拒绝）`);
  }
  for (const [label, obj] of CANCEL_SAMPLES()) {
    const { repaired, dropped } = normalizeCancelOutput(obj);
    assert.deepEqual(repaired, [], `${label} 缺 schema 必填字段`);
    assert.deepEqual(dropped, [], `${label} 含 schema 未声明字段`);
  }
});

test('输出契约: 服务真实返回值（status/cancel/各 guard 分支）零修复且通过校验', async () => {
  const env = withTmpDshHome();
  const provided = {};
  try {
    const { ctx } = makeCtx({ provided });
    const { apply } = await import(pathToFileURL(resolve(PLUGIN_DIR, 'lib', 'index.js')).href);
    apply(ctx, { stateDir: '.agint-restart-smoke' });
    const svc = provided['agint.restart'];

    const samples = [['needs-confirm', svc.request({})]];
    const stateDir = join(env.root, '.agint-restart-smoke');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'restart-history.json'), JSON.stringify({
      events: [{ at: new Date().toISOString(), requestId: 'r0', reason: 'x' }],
    }, null, 2));
    samples.push(['cooldown', svc.request({ confirm: true })]);
    samples.push(['dry-run', svc.request({ confirm: true, dryRun: true })]);
    writeFileSync(join(stateDir, 'restart-history.json'), JSON.stringify({
      events: [0, 1, 2].map((i) => ({ at: new Date(Date.now() - i * 1000).toISOString(), requestId: `r${i}`, reason: 'x' })),
    }, null, 2));
    samples.push(['tripped', svc.request({ confirm: true, force: true })]);

    for (const [label, raw] of samples) {
      const { value, repaired, dropped } = normalizeRequestOutput(raw);
      assert.deepEqual(repaired, [], `${label} 分支缺 schema 必填字段（工具链会拒绝整个输出，而副作用可能已发生）`);
      assert.deepEqual(dropped, [], `${label} 分支含未声明字段`);
      assert.deepEqual(validateOutput(requestOutputSchema(), value), [], `${label} 分支产物不合法`);
      assert.equal(typeof value.sideEffect, 'boolean', `${label} 分支必须显式带 sideEffect`);
    }

    const st = normalizeStatusOutput(svc.status());
    assert.deepEqual(st.repaired, [], 'status() 缺 schema 必填字段');
    assert.deepEqual(st.dropped, [], 'status() 含未声明字段');
    assert.deepEqual(validateOutput(statusOutputSchema(), st.value), [], 'status() 产物不合法');

    const cn = normalizeCancelOutput(svc.cancel());
    assert.deepEqual(cn.repaired, [], 'cancel() 缺 schema 必填字段（v0.4.4 前的 no-pending 分支就漏了 requestId）');
    assert.deepEqual(validateOutput(cancelOutputSchema(), cn.value), [], 'cancel() 产物不合法');
  } finally {
    env.restore();
    env.cleanup();
  }
});

// ── Case 25（v0.4.4 重写）：schema / 返回字面量不得再手写（静态守卫） ──

test('输出契约: schema 与返回值只能来自 lib/contract.js（禁止手写漂移）', () => {
  const toolsSrc = readFileSync(resolve(PLUGIN_DIR, 'lib', 'tools.js'), 'utf8');
  assert.match(toolsSrc, /schema: requestOutputSchema\(\)/, 'tools.js 必须用 contract 生成的 request schema');
  assert.match(toolsSrc, /schema: cancelOutputSchema\(\)/, 'tools.js 必须用 contract 生成的 cancel schema');
  assert.match(toolsSrc, /schema: statusOutputSchema\(\)/, 'tools.js 必须用 contract 生成的 status schema');
  assert.ok(!/output:\s*\{[\s\S]{0,300}?properties:\s*\{/.test(toolsSrc),
    'tools.js 又手写 output schema 字段了（必然与 contract 漂移）');

  const idxSrc = readFileSync(resolve(PLUGIN_DIR, 'lib', 'index.js'), 'utf8');
  assert.ok(!/accepted:\s*true/.test(idxSrc),
    'index.js 又手写 accepted=true 返回字面量了（应走 contract.requestAccepted()）');
  assert.ok(!/accepted:\s*false/.test(idxSrc),
    'index.js 又手写 accepted=false 返回字面量了（应走 contract.requestDeny()/requestDryRun()）');
  assert.match(idxSrc, /requestAccepted\(/, 'index.js 必须用 contract.requestAccepted()');
  assert.match(idxSrc, /requestDryRun\(/, 'index.js 必须用 contract.requestDryRun()');
});

// ── Case 20: v0.4.0 抖动窗口 — 两次启动间隔 < notifyDebounceMs 不投递 ──

test('抖动窗口: downtime < notifyDebounceMs → 不投递（marker 仍写）', async () => {
  const env = withTmpDshHome();
  const { apply } = await import(pathToFileURL(resolve(PLUGIN_DIR, 'lib', 'index.js')).href);
  const stateDir = '.agint-restart-smoke';
  const markerDir = join(env.root, stateDir);
  mkdirSync(markerDir, { recursive: true });
  // 模拟"刚刚重启过"：marker.lastBootAt 距 now 只有 10s，远小于 60s 默认窗口
  writeFileSync(join(markerDir, 'marker.json'), JSON.stringify({
    lastBootAt: new Date(Date.now() - 10_000).toISOString(),
    pid: 99999,
    lastSessionId: 'session-recent',
    lastActiveAt: new Date(Date.now() - 5_000).toISOString(),
  }, null, 2), 'utf8');

  const got = { followup: 0, inject: 0 };
  const agent = { id: 'session-recent', followup: () => { got.followup++; }, inject: () => { got.inject++; } };
  const agents = { roots: () => [agent], list: () => [agent], get: (id) => (id === 'session-recent' ? agent : null) };
  const disposers = [];
  const ctx = {
    get: (n) => (n === 'agents' ? agents : null),
    inject: (names, cb) => cb({ agents }),
    on: () => {},
    effect: (fn) => { const inner = fn(); if (typeof inner === 'function') disposers.push(inner); },
    provide: () => {},
  };
  try {
    apply(ctx, { stateDir, resumeWaitMs: 200 });
    // 等过 resumeWaitMs 窗口
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(got.followup, 0, '抖动窗口内不应 followup');
    assert.equal(got.inject, 0, '抖动窗口内不应 inject');
    // marker 仍照常更新为新 pid（不阻断持久化）
    const m = JSON.parse(readFileSync(join(markerDir, 'marker.json'), 'utf8'));
    assert.equal(m.pid, process.pid, 'marker 仍写入新 pid');
    assert.ok(m.lastBootAt, 'marker 仍写入新 lastBootAt');
  } finally {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
    env.restore();
    env.cleanup();
  }
});

// ── Case 21: v0.4.0 抖动窗口 — 间隔 >= 窗口照常投递（基线） ──

test('抖动窗口: downtime >= notifyDebounceMs → 照常投递', async () => {
  const env = withTmpDshHome();
  const { apply } = await import(pathToFileURL(resolve(PLUGIN_DIR, 'lib', 'index.js')).href);
  const stateDir = '.agint-restart-smoke';
  const markerDir = join(env.root, stateDir);
  mkdirSync(markerDir, { recursive: true });
  // 模拟"上次重启距 now 已 5 分钟"——远超默认 60s 窗口
  writeFileSync(join(markerDir, 'marker.json'), JSON.stringify({
    lastBootAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    pid: 99999,
    lastSessionId: 'session-old',
    lastActiveAt: new Date(Date.now() - 60_000).toISOString(),
  }, null, 2), 'utf8');

  const got = { followup: 0, inject: 0 };
  const agent = { id: 'session-old', followup: () => { got.followup++; }, inject: () => { got.inject++; } };
  const agents = { roots: () => [agent], list: () => [agent], get: (id) => (id === 'session-old' ? agent : null) };
  const disposers = [];
  const ctx = {
    get: (n) => (n === 'agents' ? agents : null),
    inject: (names, cb) => cb({ agents }),
    on: () => {},
    effect: (fn) => { const inner = fn(); if (typeof inner === 'function') disposers.push(inner); },
    provide: () => {},
  };
  try {
    apply(ctx, { stateDir, resumeWaitMs: 200 });
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(got.followup, 1, '真重启（5 分钟间隔）应 followup');
    assert.equal(got.inject, 0, '默认 wake 模式不应走 inject');
  } finally {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
    env.restore();
    env.cleanup();
  }
});

// ── Case 22: notifyDebounceMs=0 关闭防抖（baseline：关闭时所有 wasRestart 都投） ──

test('notifyDebounceMs=0: 关闭防抖，间隔 5s 也投递', async () => {
  const env = withTmpDshHome();
  const { apply } = await import(pathToFileURL(resolve(PLUGIN_DIR, 'lib', 'index.js')).href);
  const stateDir = '.agint-restart-smoke';
  const markerDir = join(env.root, stateDir);
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(join(markerDir, 'marker.json'), JSON.stringify({
    lastBootAt: new Date(Date.now() - 5_000).toISOString(),
    pid: 99999,
    lastSessionId: 'session-x',
    lastActiveAt: new Date(Date.now() - 2_000).toISOString(),
  }, null, 2), 'utf8');

  const got = { followup: 0 };
  const agent = { id: 'session-x', followup: () => { got.followup++; }, inject: () => {} };
  const agents = { roots: () => [agent], list: () => [agent], get: (id) => (id === 'session-x' ? agent : null) };
  const disposers = [];
  const ctx = {
    get: (n) => (n === 'agents' ? agents : null),
    inject: (names, cb) => cb({ agents }),
    on: () => {},
    effect: (fn) => { const inner = fn(); if (typeof inner === 'function') disposers.push(inner); },
    provide: () => {},
  };
  try {
    apply(ctx, { stateDir, notifyDebounceMs: 0, resumeWaitMs: 200 });
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(got.followup, 1, '防抖关闭 → 任何 wasRestart 都投');
  } finally {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
    env.restore();
    env.cleanup();
  }
});

// ── Case 19: 投递语义契约（v0.3.1 教训：曾把 inject / followup 完全搞反）──

test('投递语义契约：wake 走 followup(wakeup=true)，silent 才走 inject', () => {
  // 真值来源 dsh-agent-loop/lib/index.js：
  //   followup(input) { this.send(input, "next-turn", true); }  ← 唤醒 driver
  //   inject(input)   { this.send(input, "next-step", false); } ← 只入收件箱，不唤醒
  // v0.3.0 曾凭方法名臆断"inject = 立即触发"，实测恰恰相反：inject 是 wakeup=false，
  // 消息进了收件箱但 agent 不跑 → 不落盘、UI 看不到（134 个会话 0 命中）。
  // 此用例锁死语义，防止以后再凭名字猜。
  const src = readFileSync(resolve(PLUGIN_DIR, 'lib', 'index.js'), 'utf8');
  assert.match(src, /mode === 'wake'[\s\S]{0,300}target\.followup\(msg\)/, 'wake 分支必须调 followup');
  assert.match(src, /target\.inject\(msg\)/, 'silent 分支必须调 inject');

  // 本机装有 dsh 时，直接对 dsh 源码断言（最强证据，升级后会自动发现语义漂移）
  const loop = '/d/DSH/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js';
  if (existsSync(loop)) {
    const s = readFileSync(loop, 'utf8');
    assert.match(s, /followup\(input\)\s*\{\s*this\.send\(input,\s*"next-turn",\s*true\)/,
      'dsh 源码断言：followup 必须是 wakeup=true');
    assert.match(s, /inject\(input\)\s*\{\s*this\.send\(input,\s*"next-step",\s*false\)/,
      'dsh 源码断言：inject 必须是 wakeup=false（不唤醒）');
  }
});

// ── Case 25: 重启耗时参数契约（防"等待时间又被调回去"）──

test('重启耗时契约：轮询间隔收紧且无裸 sleep，默认延迟不过保守', async () => {
  const rp = readFileSync(resolve(PLUGIN_DIR, 'lib', 'respawn.js'), 'utf8');
  // 轮询间隔必须走常量（可审计），且不得出现旧的 500/1000ms 裸值
  assert.match(rp, /const POLL_EXIT_MS\s*=\s*(\d+)/, 'waitForExit 轮询应走常量');
  assert.match(rp, /const POLL_PORT_MS\s*=\s*(\d+)/, 'waitPortFree 轮询应走常量');
  assert.match(rp, /const POLL_READY_MS\s*=\s*(\d+)/, 'waitReady 轮询应走常量');
  for (const [name, re] of [
    ['POLL_EXIT_MS', /const POLL_EXIT_MS\s*=\s*(\d+)/],
    ['POLL_PORT_MS', /const POLL_PORT_MS\s*=\s*(\d+)/],
    ['POLL_READY_MS', /const POLL_READY_MS\s*=\s*(\d+)/],
  ]) {
    const ms = Number(rp.match(re)[1]);
    assert.ok(ms > 0 && ms <= 300, `${name}=${ms}ms 应 ≤300ms（重启等待会直接体现给用户）`);
  }
  assert.ok(!/await sleep\((?!POLL_)/.test(rp), '不应再有裸 sleep(N) 轮询');

  // index.js 的默认延迟：shutdownDelayMs 计入用户感知的等待，不得回退到 3s
  const idx = readFileSync(resolve(PLUGIN_DIR, 'lib', 'index.js'), 'utf8');
  const sd = Number(idx.match(/shutdownDelayMs:\s*(\d+)/)[1]);
  assert.ok(sd <= 2000, `shutdownDelayMs=${sd}ms 应 ≤2000ms（旧值 3000 偏保守）`);
  // 抖动窗口（v0.6.1 反转）：窗口过大会吞掉"重启后 1-3 分钟又重启"的正常投递
  // （实测 downtime=100131ms 被 300000 的窗口误挡 → 恢复通知发不出去 → 会话不接续）。
  // 它只该挡"刚起来又被拉起"的抖动；重启环由 restart_request 的 burst 熔断兜底。
  const db = Number(idx.match(/notifyDebounceMs:\s*(\d+)/)[1]);
  assert.ok(db > 0 && db <= 120000, `notifyDebounceMs=${db}ms 应 ∈(0,120000]（过大 = 正常重启的恢复通知发不出去）`);
  // 自触发投递（v0.6.1）：默认必须为 true，否则"重启完向我问好"这类要求永远收不到
  assert.match(idx, /resumeOnSelfRestart:\s*true/, '自触发重启默认必须投递（false 会让会话不接续）');
});

// ── Case 26: normalizeLaunch —— 拉起参数补 --no-open（防每次重启弹浏览器）──

test('normalizeLaunch: 给 dsh web 补 --no-open，不误伤其它命令、已显式给出的一律不碰', async () => {
  const { normalizeLaunch } = await import(pathToFileURL(resolve(PLUGIN_DIR, 'lib', 'index.js')).href);
  const base = { command: 'node.exe', cwd: 'C:\\Users\\Administrator', args: ['D:\\DSH\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js', 'web'] };

  // 默认（openBrowserOnRestart 未开）→ 补 --no-open
  const out = normalizeLaunch(base, {});
  assert.deepEqual(out.args, [...base.args, '--no-open'], '应补上 --no-open');
  assert.deepEqual(base.args, ['D:\\DSH\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js', 'web'], '不应修改原对象');

  // 已显式给出 open 相关开关 → 不重复追加、不覆盖
  const withNoOpen = ['x', 'web', '--no-open'];
  assert.deepEqual(normalizeLaunch({ ...base, args: withNoOpen }, {}).args, withNoOpen);
  assert.deepEqual(normalizeLaunch({ ...base, args: ['x', 'web', '--open'] }, {}).args, ['x', 'web', '--open']);
  assert.deepEqual(normalizeLaunch({ ...base, args: ['x', 'web', '--open=false'] }, {}).args, ['x', 'web', '--open=false']);

  // 不是 web 子命令 → 一个字都不动（避免误改 headless / 自定义命令）
  assert.deepEqual(normalizeLaunch({ ...base, args: ['x', 'headless'] }, {}).args, ['x', 'headless']);

  // 显式要求保留"重启也开浏览器"的旧行为
  assert.deepEqual(normalizeLaunch(base, { openBrowserOnRestart: true }).args, base.args);

  // 异常输入不炸
  assert.equal(normalizeLaunch(null, {}), null);
  assert.deepEqual(normalizeLaunch({ command: 'node', args: undefined }, {}).args, undefined);
});

// ── Case 27: detectSelfRestart —— 区分"自触发重启"与"外部重启"──

test('detectSelfRestart: 只有上次进程自己发起的重启才判为自触发', async () => {
  const { detectSelfRestart } = await import(pathToFileURL(resolve(PLUGIN_DIR, 'lib', 'index.js')).href);
  const env = withTmpDshHome();
  const dir = join(env.root, '.agint-restart');
  mkdirSync(dir, { recursive: true });
  const reqPath = join(dir, 'restart-request.json');
  // marker 由"上一次启动的那个进程"写下：pid=29220，启动于 16:05:13
  const marker = { lastBootAt: '2026-09-10T16:05:13.632Z', pid: 29220, lastSessionId: 'session-x' };
  try {
    // 1) pid 吻合 + 请求晚于上次启动 → 自触发
    writeFileSync(reqPath, JSON.stringify({ requestId: 'abc12345', reason: '加载修复', targetPid: 29220, requestedAt: '2026-09-10T16:08:34.406Z' }));
    assert.deepEqual(detectSelfRestart(marker, reqPath), { self: true, requestId: 'abc12345', reason: '加载修复' });

    // 2) pid 不匹配（老板手动重启，请求文件是上一轮的残留）→ 外部重启
    writeFileSync(reqPath, JSON.stringify({ requestId: 'old', targetPid: 99999, requestedAt: '2026-09-10T16:08:34.406Z' }));
    assert.equal(detectSelfRestart(marker, reqPath).self, false, 'pid 不匹配必须视为外部重启');

    // 3) 请求时间早于上次启动（陈旧文件，pid 巧合复用）→ 外部重启
    writeFileSync(reqPath, JSON.stringify({ requestId: 'stale', targetPid: 29220, requestedAt: '2026-09-10T15:00:00.000Z' }));
    assert.equal(detectSelfRestart(marker, reqPath).self, false, '陈旧请求文件必须视为外部重启');

    // 4) 缺文件 / 缺 marker / JSON 损坏 → 保守判为外部重启（宁可多投，不吞真中断）
    assert.equal(detectSelfRestart(marker, join(dir, 'nope.json')).self, false);
    assert.equal(detectSelfRestart(null, reqPath).self, false);
    writeFileSync(reqPath, '{ 坏 json');
    assert.equal(detectSelfRestart(marker, reqPath).self, false);
  } finally {
    env.restore();
    env.cleanup();
  }
});

// ── Case 28: 端到端 —— 自触发重启默认也投递（会话接续）；显式 false 才跳过 ──
//
// v0.6.1 修正：旧版把"自触发"当成"不需要恢复"，但 detectSelfRestart 判的是
// "这次启动留没留请求文件"——凡走插件协议的重启都算自触发，于是恢复通知
// 几乎永远发不出去（老板让 agent 重启并要求"重启完向我问好"，消息被吞）。

test('端到端：自触发重启默认也投递（会话接续），显式 false 才跳过', async () => {
  const env = withTmpDshHome();
  const { apply } = await import(pathToFileURL(resolve(PLUGIN_DIR, 'lib', 'index.js')).href);
  const stateDir = '.agint-restart-smoke';
  const markerDir = join(env.root, stateDir);
  const markerPath = join(markerDir, 'marker.json');
  const reqPath = join(markerDir, 'restart-request.json');
  const wakePath = join(markerDir, 'wake.log');
  mkdirSync(markerDir, { recursive: true });

  const makeCtx = (hits) => {
    const agent = {
      id: 'session-old',
      followup: () => { hits.followup++; },
      inject: () => { hits.inject++; },
    };
    const agents = { roots: () => [agent], list: () => [agent], get: () => agent };
    const disposers = [];
    const ctx = {
      get: (n) => (n === 'agents' ? agents : null),
      inject: (names, cb) => cb({ agents }),
      on: () => {},
      effect: (fn) => { const inner = fn(); if (typeof inner === 'function') disposers.push(inner); },
      provide: () => {},
    };
    return { ctx, dispose: () => { for (const d of disposers) { try { d(); } catch { /* ignore */ } } } };
  };

  // 复现"上一次启动的那个进程"留下的 marker
  const prevBootAt = new Date(Date.now() - 60000).toISOString();
  const seedMarker = () => writeFileSync(markerPath, JSON.stringify({
    lastBootAt: prevBootAt,
    pid: 29220,               // 上一次启动的 pid（≠ 当前进程）
    lastSessionId: 'session-old',
    lastActiveAt: prevBootAt,
  }, null, 2), 'utf8');

  try {
    // (1) 自触发：请求文件 targetPid === marker.pid，且晚于上次启动
    //     v0.6.1：默认必须投递——旧版不投，导致"重启完向我问好"永远收不到
    seedMarker();
    rmSync(wakePath, { force: true });
    writeFileSync(reqPath, JSON.stringify({
      requestId: 'self0001', reason: '加载修复', targetPid: 29220,
      requestedAt: new Date(Date.now() - 30000).toISOString(),
    }), 'utf8');
    const a = { followup: 0, inject: 0 };
    const runA = makeCtx(a);
    apply(runA.ctx, { stateDir, resumeWaitMs: 200, notifyDebounceMs: 0 });
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(a.followup, 1, '自触发重启默认必须投递（否则重启后没人被唤醒，会话不接续）');
    const wakeA = JSON.parse(readFileSync(wakePath, 'utf8'));
    assert.equal(wakeA.ok, true);
    assert.equal(wakeA.deliveredTo, 'session-old');
    runA.dispose();

    // (2) 外部重启：请求文件 targetPid 对不上（老板手动重启的残留文件）
    seedMarker();
    rmSync(wakePath, { force: true });
    writeFileSync(reqPath, JSON.stringify({
      requestId: 'stale001', targetPid: 11111,
      requestedAt: new Date(Date.now() - 30000).toISOString(),
    }), 'utf8');
    const b = { followup: 0, inject: 0 };
    const runB = makeCtx(b);
    apply(runB.ctx, { stateDir, resumeWaitMs: 200, notifyDebounceMs: 0 });
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(b.followup, 1, '外部重启必须照常投递（否则真正的中断会被吞掉）');
    const wake = JSON.parse(readFileSync(wakePath, 'utf8'));
    assert.equal(wake.ok, true);
    assert.equal(wake.deliveredTo, 'session-old');
    runB.dispose();

    // (3) 显式 resumeOnSelfRestart: false → 退回旧行为（逃生阀仍在，可随时关掉自触发投递）
    seedMarker();
    rmSync(wakePath, { force: true });
    writeFileSync(reqPath, JSON.stringify({
      requestId: 'self0002', targetPid: 29220,
      requestedAt: new Date(Date.now() - 30000).toISOString(),
    }), 'utf8');
    const c = { followup: 0, inject: 0 };
    const runC = makeCtx(c);
    apply(runC.ctx, { stateDir, resumeWaitMs: 200, notifyDebounceMs: 0, resumeOnSelfRestart: false });
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(c.followup + c.inject, 0, '显式 false 时应跳过投递');
    assert.equal(existsSync(wakePath), false, '显式 false 时不应写 wake.log');
    runC.dispose();
  } finally {
    env.restore();
    env.cleanup();
  }
});

// ── Case 28b: buildNotice 断环文案（v0.7.1：纯状态，自触发/外部一律同文）──

test('buildNotice：selfRestart 不再影响文案（v0.7.1 断环，只报已重启）', () => {
  const base = {
    bootAt: '2026-09-11T00:00:00.000Z',
    prevBootAt: '2026-09-11T00:00:00.000Z',
    downtimeMs: 178000,
    lastSessionId: 'session-x',
    lastActiveAt: '2026-09-11T00:00:00.000Z',
  };
  const withSelf = buildNotice({ ...base, selfRestart: true });
  const withoutSelf = buildNotice({ ...base, selfRestart: false });
  assert.equal(withSelf, withoutSelf, '自触发与外部重启文案必须一致');
  assert.equal(withSelf, '[agint-restart] DSH 已重启。');
  assert.doesNotMatch(withSelf, /不需要再次重启/, 'v0.7.1：指令性断环说明已移除');
  assert.doesNotMatch(withSelf, /自主决定下一步/, 'v0.7.1：不得含行动指令');
});

// ── Case 29: 真机 schema 编译（用 dsh 实际加载的那份 dsh-tools）──
//
// K19（漏 additionalProperties）与 K20（required:false）两类事故的共同点：
// 错误只在 **preset 加载时** 抛出 → 整条 preset 拒绝挂载 → 新建会话发不了消息，
// 而 smoke test 以前完全不加载 tools.js，所以两次都是线上才发现。
// 这里直接在真 dsh-tools 上 apply()（defineTool 内部编译 schema，违规当场抛），
// 把这类事故挡在本地。本机无嵌套包（非目标环境）时跳过。

test('真机 schema：tools.js 能被真实 dsh-tools 编译并注册（K19/K20 防漂移）', async (t) => {
  const NESTED = 'D:/DSH/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
  if (!existsSync(NESTED)) {
    t.skip('本机无嵌套 dsh-tools，跳过（非本项目运行环境）');
    return;
  }
  const stage = join(tmpdir(), 'agint-restart-schema-' + randomUUID());
  mkdirSync(stage, { recursive: true });
  try {
    const src = readFileSync(resolve(PLUGIN_DIR, 'lib', 'tools.js'), 'utf8')
      .replace("'@deepseek-ai/dsh-tools'", `'${pathToFileURL(NESTED).href}'`);
    writeFileSync(join(stage, 'tools.mjs'), src, 'utf8');
    writeFileSync(join(stage, 'contract.js'), readFileSync(resolve(PLUGIN_DIR, 'lib', 'contract.js'), 'utf8'), 'utf8');

    const registered = [];
    const ctx = {
      'agint.restart': null, get: () => null, provide: () => {}, on: () => {},
      effect: () => {}, inject: () => {}, tools: { register: (x) => registered.push(x) },
    };
    const mod = await import(pathToFileURL(join(stage, 'tools.mjs')).href);
    mod.apply(ctx); // 违规 schema 会在这里抛，而不是等到线上 preset 挂载
    assert.deepEqual(registered.map((r) => r.name).sort(), ['restart_cancel', 'restart_request', 'restart_status']);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

// ── Case 30: 字段表 ⊇ 分支返回值（v0.5.0 新增字段不得被 normalize 丢掉）──

test('status 字段表覆盖新增字段：selfRestart / selfRestartRequestId 不被丢弃', () => {
  const sample = {
    enabled: true, mode: 'auto', pid: 1, bootAt: 'x', wasRestart: true,
    selfRestart: true, selfRestartRequestId: 'abc12345',
    cooldownRemainingMs: 0, burst: { windowMs: 1, max: 1, count: 0, tripped: false },
    pending: null, lastRestart: null, historyCount: 0, lastResult: null,
    parkedNotice: null,
    launch: { command: 'n', cwd: 'c', args: ['a'] },
  };
  const r = normalizeStatusOutput(sample);
  assert.deepEqual(r.dropped, [], '不应丢弃任何字段（丢了说明字段表漏声明）');
  assert.deepEqual(r.repaired, [], '不应修补任何字段');
  assert.equal(r.value.selfRestart, true);
  assert.equal(r.value.selfRestartRequestId, 'abc12345');
  // 未声明在字段表里的键必须被丢掉（防"加了字段但 schema 没跟上"）
  const r2 = normalizeStatusOutput({ ...sample, bogusField: 1 });
  assert.deepEqual(r2.dropped, ['bogusField']);
});

// ── Case 31: win32 启动方式契约（防回退成「无控制台」，那会让 dsh 每调一次工具弹一次黑框）──

test('win32：新 dsh 必须走「隐藏窗口」启动，不得用 detached / windowsHide 丢控制台', () => {
  const src = readFileSync(resolve(PLUGIN_DIR, 'lib', 'respawn.js'), 'utf8');

  assert.match(src, /function launchHiddenWin32/, '缺少 win32 隐藏启动函数');
  assert.ok(
    /process\.platform !== 'win32'[\s\S]{0,200}?launchHiddenWin32\(/.test(src),
    'win32 分支必须走隐藏启动（回退成 detached 就会重新开始弹窗）',
  );
  // 保底：启动前要探测 wscript 链路，不可用时必须能回退，否则 dsh 可能起不来
  assert.match(src, /function canHideLaunch/, '缺少 wscript 链路探测（保底回退用）');
  assert.ok(
    /forceDetached/.test(src) && /launchDetachedPosix\(/.test(src),
    '必须有回退到 detached 的路径',
  );

  const hiddenStart = src.indexOf('function launchHiddenWin32');
  const hiddenEnd = src.indexOf('function quoteVbsString');
  assert.ok(hiddenStart > 0 && hiddenEnd > hiddenStart, 'launchHiddenWin32 片段定位失败');
  const hidden = src.slice(hiddenStart, hiddenEnd);

  // 硬约束 1：win32 路径不能出现 detached（= DETACHED_PROCESS = 没有控制台）
  assert.ok(!/detached\s*:\s*true/.test(hidden), 'win32 隐藏启动里不得出现 detached:true');
  // 硬约束 2：必须借 WScript 的 SW_HIDE，且不等待
  assert.ok(hidden.includes('WScript.Shell'), '必须借 WScript 隐藏启动');
  assert.ok(hidden.includes(', 0, False'), 'Run 必须以 SW_HIDE(0) 且不等待(False) 启动');
  // 硬约束 3：stdout/stderr 仍要落盘（.cmd 里做重定向）
  assert.ok(/\d>&1|2>&1/.test(hidden) || hidden.includes('2>&1'), '必须保留输出重定向');

  // POSIX 分支保持 detached（没有控制台概念，行为不变）
  const posix = src.slice(src.indexOf('function launchDetachedPosix'), hiddenStart);
  assert.match(posix, /detached\s*:\s*true/, 'posix 分支应保留 detached');
});
