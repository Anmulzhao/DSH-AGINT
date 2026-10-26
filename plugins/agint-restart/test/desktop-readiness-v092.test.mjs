/**
 * v0.9.2 防回归：桌面就绪判据 = 「拉起前不存在的新 GUI 树根」。
 *
 * 事故形状（2026-10-18 12:34 restart-result.json 实拍）：
 *   desktopShell.killed=true、launched=true、GUI 真的活了（它就是当时新起的），
 *   但 ready=false / readySignal=null / ok=false，白等 60257ms。
 *   根因两条就绪信号源都断了，各有取证：
 *     ① readiness.leasePath=sentinel.lease：桌面机实测 $DSH_HOME 下
 *        没有 sentinel.lease（Test-Path 判 False，桌面 app 不写它）；
 *     ② 端口不再固定：同日三次重启实测 GUI 监听口各不相同（随机高位口），
 *        v0.9.1 override 配的 19387 与老默认 3080 均无监听。
 *     ③ descendant 链走不通的取证：对活 GUI 进程树逐个走祖先链——
 *        新 GUI 根的父链首跳 GONE（wscript 壳启动后即退，链在 GUI 那跳断）。
 *
 * 这里断言的是**事实**不是日志：
 *   - guiRootPids / pickFreshGuiRoot 用进程数据形状直接喂（构造见各用例）；
 *   - 非法 exeName / WQL 注入面必须返回 null（探测不了 ≠ 没有根）；
 *   - 端到端只在 win32 真机跑枚举；posix 造壳形状不可靠，不造。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESPAWN_PATH = resolve(HERE, '../lib/respawn.js');
const { guiRootPids, pickFreshGuiRoot, advanceFreshRoot, listGuiRoots } = await import(
  pathToFileURL(RESPAWN_PATH).href
);

// ── guiRootPids：树根 = 父不在同 exe 集合里 ────────────────────────────────

test('guiRootPids：多进程 Electron 形状只认最顶上的根', () => {
  const list = [
    { pid: 100, ppid: 1 },    // 主进程（父已退/不属本集合）→ 根
    { pid: 101, ppid: 100 },  // GPU
    { pid: 102, ppid: 100 },  // renderer
    { pid: 200, ppid: 42 },   // 第二个实例的主进程 → 也是根
    { pid: 201, ppid: 200 },
  ];
  assert.deepEqual(guiRootPids(list).sort((a, b) => a - b), [100, 200]);
});

test('guiRootPids：空集合返回空（枚举成功但真没 GUI 是事实，不是不可达）', () => {
  assert.deepEqual(guiRootPids([]), []);
});

test('guiRootPids：ppid 字符串数字与 pid 类型不一致也能对齐（CIM JSON 形状）', () => {
  const list = [{ pid: '10', ppid: '3' }, { pid: '11', ppid: '10' }];
  assert.deepEqual(guiRootPids(list), [10]);
});

// ── pickFreshGuiRoot：新旧根集合差集 ───────────────────────────────────────

test('pickFreshGuiRoot：旧根全在、只多一个新根 ⇒ 认出新的那个', () => {
  const before = new Set([100001]);
  assert.equal(pickFreshGuiRoot(before, [100001, 100002]), 100002);
});

test('pickFreshGuiRoot：单实例锁被吞（无新根）⇒ null，不许判就绪', () => {
  const before = new Set([100001]);
  assert.equal(pickFreshGuiRoot(before, [100001]), null);
});

test('pickFreshGuiRoot：旧根消失且出现全新根 ⇒ 认新根', () => {
  const before = new Set([100]);
  assert.equal(pickFreshGuiRoot(before, [200]), 200);
});

// ── listGuiRoots：不可达边界必须 null（探测不了 ≠ 没有根）──────────────────

test('listGuiRoots：exeName 含单引号（WQL 注入面）⇒ null 拒查', async () => {
  assert.equal(await listGuiRoots("evil' or 1=1 or Name='x"), null);
});

test('listGuiRoots：exeName 空/非字符串 ⇒ null', async () => {
  assert.equal(await listGuiRoots(''), null);
  assert.equal(await listGuiRoots(undefined), null);
  assert.equal(await listGuiRoots(42), null);
});

// ── 真机正向（win32）：拿真实 powershell 枚举，必须能看见当前会话的 GUI ────

test('listGuiRoots 真机正例：枚举 DeepSeek Harness.exe 得到 ≥1 个根，且含本会话宿主', { skip: process.platform !== 'win32' && 'win32-only' }, async () => {
  const roots = await listGuiRoots('DeepSeek Harness.exe');
  assert.notEqual(roots, null, '真机 powershell/CIM 可达，不该返回 null');
  assert.ok(roots.length >= 1, `当前桌面必有 GUI 进程，实得 ${JSON.stringify(roots)}`);
  // 反查：roots 里至少有一个 pid 能被 CIM 直接查到且映像名一致
  const ok = roots.some((pid) => {
    const out = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").Name`,
    ], { encoding: 'utf8' }).trim();
    return out === 'DeepSeek Harness.exe';
  });
  assert.ok(ok, '快照根 pid 必须逐个可复查（不是拼出来的假 pid）');
});

// ── 真机负例：不存在的 exe 名 ⇒ 枚举成功且零根 = 空数组，不是 null ─────────

test('listGuiRoots 真机负例：不存在的名 ⇒ 空数组（事实零，不许冒充不可达）', { skip: process.platform !== 'win32' && 'win32-only' }, async () => {
  const roots = await listGuiRoots('agint-nonexistent-exe-9f3d.exe');
  assert.deepEqual(roots, [], '枚举通路正常时，没有该进程必须如实返回 []');
});

// ── 端到端（win32 真机）：走完整 respawn，正反两个形状 ─────────────────────
//
// 造法与事故同形：假 GUI 用**唯一命名**的 node.exe 副本（枚举按 Name 匹配，
// 机器上只有本用例在造它，不会把别的进程误当新根）。正向 = 副本常驻 ⇒ 必须
// ready=true 且 newPid 就是那个真根；负向 = 副本秒退 ⇒ 必须 ready=false。
// 断言读 restart-result.json 的事实字段，不读日志。

// ── advanceFreshRoot：新根必须连续两拍可见才判驻留（防"闪现即死"假绿）──────

test('advanceFreshRoot：单拍可见只挂 pending，不判就绪', () => {
  const s = advanceFreshRoot(null, 100004);
  assert.deepEqual(s, { ready: false, pending: 100004 }, '第一拍只记录，不下就绪结论');
});

test('advanceFreshRoot：同一个新根连续两拍可见 ⇒ 判就绪', () => {
  const s = advanceFreshRoot(100004, 100004);
  assert.deepEqual(s, { ready: true, pending: 100004 });
});

test('advanceFreshRoot：新根换了 → 重新计数（就绪必须来自同一 pid 的两拍存活）', () => {
  assert.deepEqual(advanceFreshRoot(100004, 100003), { ready: false, pending: 100003 });
});

test('advanceFreshRoot：闪现即死（第二拍消失）⇒ pending 清零、不就绪', () => {
  const s = advanceFreshRoot(100004, null);
  assert.deepEqual(s, { ready: false, pending: null }, '2026-10-13/15 崩溃弹窗形状的护栏');
});

/**
 * guiPid / targetPid 用一个**确定没人用**的号码，不能直接拿短命进程号：
 * deadPid 是刚退出的短命进程号，Windows 会回收复用 —— 若它恰好被别的真
 * 进程拿走，killDesktopShell 的 probeProcess 会查到"活着 + 名字是 node.exe"
 * 而与 guiExeName（假 GUI 副本名）不符 → name-mismatch 拒杀，测试形状就假了。
 * 取远高于当前 max pid 的号码（pid 探测返回 null → 'gui-gone' 干净跳过）。
 */
function unusedPid() {
  return 1_000_000_007;
}

function makeReq(dir, { launchArgs, exeName, timeoutMs }) {
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const sleeper = join(dir, 'sleeper.mjs');
  writeFileSync(sleeper, 'setInterval(() => {}, 1e6);');
  const req = {
    requestId: 'r92test',
    reason: 'desktop-readiness e2e',
    requestedAt: new Date().toISOString(),
    targetPid: unusedPid(),
    stateDir,
    desktop: { guiCommand: join(dir, exeName), guiPid: unusedPid(), guiExeName: exeName },
    launch: { command: join(dir, exeName), args: launchArgs, cwd: dir, env: {} },
    waitExitMs: 500,
    forceKillAfterMs: 0,
    portFreeTimeoutMs: 300,
    readiness: { leasePath: null, port: 0, timeoutMs },
    logFile: join(dir, 'dsh.log'),
  };
  const reqPath = join(stateDir, 'restart-request.json');
  writeFileSync(reqPath, JSON.stringify(req, null, 2));
  return { reqPath, stateDir, req };
}

const EXE = process.platform === 'win32' ? 'agint-fake-gui-9f3d.exe' : null;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function desktopE2e(label, launchArgs, timeoutMs, expect) {
  test(label, { skip: process.platform !== 'win32' && 'win32-only' }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agint-r92-'));
    try {
      copyFileSync(process.execPath, join(dir, EXE));
      const { reqPath, stateDir } = makeReq(dir, { launchArgs, exeName: EXE, timeoutMs });
      execFileSync(process.execPath, [RESPAWN_PATH, reqPath], {
        stdio: 'ignore', timeout: timeoutMs + 90000,
      });
      const result = JSON.parse(readFileSync(join(stateDir, 'restart-result.json'), 'utf8'));
      await expect(result);
    } finally {
      // 清理本用例自己造的唯一命名进程（taskkill 按映像名，波及面只有假 GUI）
      try { execFileSync('taskkill', ['/F', '/IM', EXE], { stdio: 'ignore' }); } catch { /* 已退出 */ }
      // taskkill 返回≠文件句柄已释放：刚被杀的常驻进程可能还锁着复制的 .exe，
      // 立即 rm 会 EPERM。异步退避重试；清不掉不算用例失败（临时目录交 OS 回收）。
      for (let i = 0; i < 20; i++) {
        try { rmSync(dir, { recursive: true, force: true }); break; }
        catch { await sleepMs(300); }
      }
    }
  });
}

desktopE2e(
  'e2e 正向：假 GUI 常驻 ⇒ ready=true / ok=true / newPid=真根（不是被吞的壳 pid）',
  [ 'sleeper.mjs' ], 20000,
  (result) => {
    assert.equal(result.launched, true, '假 GUI 被拉起');
    assert.equal(result.ready, true, `新根必须出现（result=${JSON.stringify(result)}）`);
    assert.equal(result.readySignal, 'desktop-gui-root');
    assert.equal(result.readyVerified, 'new-gui-root');
    assert.equal(result.ok, true, '桌面结构判据成立 ⇒ ok 必须为 true（这就是修掉的假阴位）');
    assert.equal(result.readyDegraded, false, '结构判据是验过的身份，不是 degraded 兜底');
    const roots = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "Name='${EXE}'").ProcessId`], { encoding: 'utf8' })
      .trim().split(/\r?\n/).map(Number).filter(Boolean);
    assert.ok(roots.includes(result.newPid), `newPid=${result.newPid} 必须是真实存在的假 GUI 根（实存 ${roots}）`);
    assert.notEqual(result.newPid, result.launchShellPid, 'newPid 应已从壳 pid 换成真根 pid');
  },
);

desktopE2e(
  'e2e 负向：假 GUI 秒退（无新根驻留）⇒ ready=false / ok=false，不许把失败洗成成功',
  [ '-e', 'process.exit(0)' ], 3000,
  (result) => {
    assert.equal(result.ready, false, `秒退不该判就绪（result=${JSON.stringify(result)}）`);
    assert.equal(result.readySignal, null, '不就绪时不得编造信号名');
    assert.equal(result.ok, false, '新判据不得比老判据更松');
  },
);
