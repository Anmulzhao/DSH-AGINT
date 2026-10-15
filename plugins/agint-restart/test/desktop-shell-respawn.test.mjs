/**
 * 防回归：桌面 profile 的重启必须复现 GUI 主进程，不是复现 headless host。
 *
 * 重演的真实事故（2026-10-13 与 2026-10-15 两次，同因）：
 *   `/restart-dsh` 在桌面 profile 下按「我自己怎么起的」复现 ⇒ 拉起一个没有界面的
 *   headless host 抢走 127.0.0.1:19387 ⇒ GUI 自己那个 host 必然 EADDRINUSE
 *   ⇒ 必需插件 webserver 激活失败 ⇒ 12 个插件缺服务挂起 ⇒ DesktopHostFatalError
 *   ⇒ 弹「Another DSH instance is running」。点框里的 Restart 也无效（端口仍被占）。
 *
 * 判据取自两处必须同时成立的点：
 *   1. 拉起快照换成裸起 exe（detectDesktopShell）；
 *   2. 裸起 exe 时 ELECTRON_RUN_AS_NODE 必须不在最终 env 里
 *      （带着它 exe 会进 node 模式、没有入口脚本，立刻退出）。
 * 外加拒杀护栏：guiPid 是开机时记下的，重启可能发生在几天后，pid 完全可能被回收
 * 给别的程序 —— 核身不过就必须拒绝，宁可留下旧窗口也不能乱杀老板的东西。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { basename } from 'node:path';
import { detectDesktopShell } from '../lib/index.js';
import { pickEnv, killDesktopShell, isDescendantOf } from '../lib/respawn.js';

const GUI_EXE = 'D:\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe';
const HOST_ENTRY = 'D:\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js';

// ── 1. detectDesktopShell：什么时候算「我是桌面 host 子进程」────────────

test('detectDesktopShell: win32 桌面 host argv → 认出 GUI', () => {
  const got = detectDesktopShell({
    argv: [GUI_EXE, HOST_ENTRY, 'runtimeDir', 'projectDir'],
    execPath: GUI_EXE,
    ppid: 25544,
  });
  assert.deepEqual(got, {
    guiCommand: GUI_EXE,
    guiPid: 25544,
    guiExeName: 'DeepSeek Harness.exe',
  });
});

test('detectDesktopShell: posix 桌面 host argv 同样认出（分隔符换成 /）', () => {
  const got = detectDesktopShell({
    argv: ['/opt/dsh/dsh', '/opt/dsh/app/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'],
    execPath: '/opt/dsh/dsh',
    ppid: 4242,
  });
  assert.equal(got.guiCommand, '/opt/dsh/dsh');
  assert.equal(got.guiExeName, 'dsh');
  assert.equal(got.guiPid, 4242);
});

test('detectDesktopShell: 入口不在 argv[1]（前面插了 --expose-internals）也要认出', () => {
  // 真机 2026-10-15 21:41 实测形状：GUI 是 spawn(exe, ["--expose-internals", entry, ...])。
  // 第一版按 argv[1] 判定，被这条真实输入当场打回 —— 判据必须扫全量 argv。
  const got = detectDesktopShell({
    argv: [GUI_EXE, '--expose-internals', HOST_ENTRY, 'runtimeDir', 'projectDir'],
    execPath: GUI_EXE,
    ppid: 15784,
  });
  assert.ok(got, '带前置 flag 时不得判成"非桌面 host"，否则又回去拉 headless host');
  assert.equal(got.guiPid, 15784);
  assert.equal(got.guiExeName, 'DeepSeek Harness.exe');
});

test('detectDesktopShell: CLI `dsh web` 的 argv → null（走原自复现链路）', () => {
  assert.equal(
    detectDesktopShell({
      argv: [process.execPath, '/home/u/.dsh/node_modules/@deepseek-ai/dsh/lib/bin.js', 'web'],
      execPath: process.execPath,
      ppid: 1,
    }),
    null,
  );
});

test('detectDesktopShell: argv[1] 只是路径里含 dsh-desktop-host（不是入口脚本）→ null', () => {
  assert.equal(
    detectDesktopShell({
      argv: ['node', '/tmp/dsh-desktop-host/lib/other.js'],
      execPath: 'node',
      ppid: 1,
    }),
    null,
  );
});

test('detectDesktopShell: execPath 缺失 → null；ppid<=0 → guiPid 为 null（不拿 0 去杀）', () => {
  assert.equal(detectDesktopShell({ argv: ['x', HOST_ENTRY], execPath: '', ppid: 9 }), null);
  const noParent = detectDesktopShell({ argv: ['x', HOST_ENTRY], execPath: GUI_EXE, ppid: 0 });
  assert.equal(noParent.guiPid, null, 'ppid=0 在 win32 是「杀整个进程组」的语义，必须落成 null');
});

// ── 2. pickEnv：裸起 GUI 必须剥掉 node 模式标记 ────────────────────────

test('pickEnv: guiLaunch=true 时 base 与 launch.env 两侧的 ELECTRON_RUN_AS_NODE 都剥掉', () => {
  const merged = pickEnv(
    { ELECTRON_RUN_AS_NODE: '1', DSH_HOME: 'D:\\DSH\\AGINT-date' },
    { guiLaunch: true },
  );
  assert.ok(!('ELECTRON_RUN_AS_NODE' in merged), '带着它裸起 exe 会进 node 模式立刻退出');
  assert.equal(merged.DSH_HOME, 'D:\\DSH\\AGINT-date', '只剥这一个键，不牵连同批快照键');
});

test('pickEnv: 非 GUI 拉起保留 ELECTRON_RUN_AS_NODE（headless host 复现要靠它）', () => {
  const prev = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = '1';
  try {
    assert.equal(pickEnv({}, {}).ELECTRON_RUN_AS_NODE, '1');
  } finally {
    if (prev === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = prev;
  }
});

test('pickEnv: guiLaunch 的剥离打在展开之后（launch.env 带回来的也拦得住）', () => {
  // 2026-10-06 NODE_OPTIONS 那次的同形教训：delete 只删 base，展开时 launch.env
  // 排在后面又把它原样加回来 —— 单测全绿、真机行为没变。这里按真实形状造两侧。
  const merged = pickEnv({ ELECTRON_RUN_AS_NODE: '1' }, { guiLaunch: true });
  assert.ok(!('ELECTRON_RUN_AS_NODE' in merged));
  assert.ok(!('NODE_OPTIONS' in merged), 'NODE_OPTIONS 的既有剥离语义不受影响');
});

// ── 3. killDesktopShell：核身不过就拒绝，且绝不误杀 ─────────────────────

test('killDesktopShell: 没有 guiPid → 拒杀并说明原因', async () => {
  const dir = os.tmpdir();
  const got = await killDesktopShell({ guiPid: null, guiExeName: 'x.exe' }, path.join(dir, 'no-such-restart.log'));
  assert.deepEqual(got, { killed: false, reason: 'no-gui-pid' });
});

test('killDesktopShell: pid 已不存在 → 不杀（gui-gone）', async () => {
  const got = await killDesktopShell(
    { guiPid: 2147483000, guiExeName: 'DeepSeek Harness.exe' },
    path.join(os.tmpdir(), 'no-such-restart.log'),
  );
  assert.equal(got.killed, false);
  assert.equal(got.reason, 'gui-gone');
});

test('killDesktopShell: pid 被回收给别的程序（映像名不符）→ 拒杀且对方毫发无损', async () => {
  // 造一个真实活着、但名字肯定不是 "DeepSeek Harness.exe" 的进程顶在 guiPid 位上。
  // 这是 pid 复用防护的正身：判据取「事后它还在不在」，不取「日志说了什么」。
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    const got = await killDesktopShell(
      { guiPid: child.pid, guiExeName: 'DeepSeek Harness.exe' },
      path.join(os.tmpdir(), 'no-such-restart.log'),
    );
    assert.equal(got.killed, false);
    assert.equal(got.reason, 'name-mismatch');
    assert.ok(child.kill(0), '被误杀则 kill(0) 抛 ESRCH —— 护栏必须挡住');
  } finally {
    child.kill();
  }
});

test('killDesktopShell: 映像名对得上但其实是 headless host（命令行含入口脚本）→ 不当 GUI 杀', async () => {
  // 这正是 2026-10-15 挡路的那个进程形状：同一个 exe、命令行里带着
  // dsh-desktop-host/lib/index.js。它该走「遗留 host 单独清」的路径，
  // 不能被当成 GUI 主进程杀掉后又被误记为「桌面壳已重启」。
  const entryArg = process.platform === 'win32'
    ? 'X:\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js'
    : '/x/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js';
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', entryArg], { stdio: 'ignore' });
  try {
    const got = await killDesktopShell(
      { guiPid: child.pid, guiExeName: basename(process.execPath) },
      path.join(os.tmpdir(), 'no-such-restart.log'),
    );
    assert.equal(got.killed, false);
    assert.equal(got.reason, 'not-gui-main');
    assert.ok(child.kill(0), '被误杀则 kill(0) 抛 ESRCH');
  } finally {
    child.kill();
  }
});

// ── 4. isDescendantOf：桌面链路的监听者身份判据 ────────────────────────

test('isDescendantOf: 真父子 → true；无亲属关系 → false（不靠 mock，用真进程链）', async () => {
  // 形状与真机一致：壳(respawn/wscript) → GUI → host(监听 19387)。
  // 这里用 node 真起两层，验的是「往上走链能不能走到」这件事本身。
  const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {
    stdio: 'ignore',
    detached: false,
  });
  try {
    assert.ok(await isDescendantOf(grandchild.pid, process.pid), '孙进程应被认在本进程树下');
    assert.ok(await isDescendantOf(grandchild.pid, grandchild.pid), '自身即祖先时应直接命中');
    assert.equal(
      await isDescendantOf(process.pid, grandchild.pid),
      false,
      '反方向不得成立（链走不到）',
    );
  } finally {
    grandchild.kill();
  }
});

test('isDescendantOf: 不存在的 pid → false（不得抛，判据要能在探测失败时保持 degraded）', async () => {
  assert.equal(await isDescendantOf(2147483000, process.pid), false);
  assert.equal(await isDescendantOf(process.pid, 2147483000), false);
});
