#!/usr/bin/env node
/**
 * agint-restart — killer（独立进程，唯一真正发信号的地方）。
 *
 * 为什么需要它
 * ─────────────
 * 「终止 DSH」要的是整棵进程树干净退出，不是换一个孤儿接着跑。宿主一旦死了，
 * 执行者就没了，所以信号必须由一个已经脱离宿主的进程来发。与 respawn.js 同一形状：
 *   1) 宿主写 stop-request.json → detached 拉起本脚本 → 自己按 delay 退出
 *   2) 本脚本成为孤儿后继续跑：枚举进程树 → 叶子优先 SIGTERM → 升级 SIGKILL → 写回执
 *
 * 「重启」用 respawn.js，「终止」用本文件。两者都只经宿主派发，宿主不自杀。
 *
 * 用法：node killer.js <stop-request.json>
 * 回执：<stateDir>/stop-result.json（宿主已死，没人当场读；下次启动由 /stop-dsh status 补读）
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** SIGTERM 后给优雅收尾的窗口；超时才升级 SIGKILL。 */
const DEFAULT_GRACE_MS = 3000;
/** 升级 SIGKILL 后确认消失的窗口。 */
const DEFAULT_KILL_WAIT_MS = 4000;
/** 轮询间隔。 */
const POLL_MS = 100;

/** 永不触碰的 pid：init 自己，和本脚本。误杀任何一个都等于把机器搞坏。 */
const FORBIDDEN = new Set([0, 1, process.pid]);

/** 进程是否还活着（信号 0 = 只探测，不发送）。 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 存在但不属于当前用户，仍算活着
    return err?.code === 'EPERM';
  }
}

/**
 * 读 Linux /proc 的进程表。
 *
 * 只用 node 内置模块：这是「杀宿主」的最后一道执行者，它能依赖的东西越少越好 ——
 * 宿主此刻正在退出，任何一次 import 失败都等于这次终止静默失效。
 *
 * @returns {Map<number, {pid:number, ppid:number, pgid:number, state:string, fingerprint:string}>}
 */
function readProcTable() {
  const table = new Map();
  let names;
  try {
    names = readdirSync('/proc');
  } catch {
    return table; // 非 Linux 或 /proc 不可读 → 交由调用方降级
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let stat;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      continue; // 进程在我们读的时候没了
    }
    // comm 字段可能含空格和括号（`(my proc)`），所以不能按空格切：
    // pid 后是 `(`，comm 到**最后一个** `)` 结束，之后才是 state/ppid/pgrp/session。
    const open = stat.indexOf('(');
    const close = stat.lastIndexOf(')');
    if (open < 0 || close < open) continue;
    const comm = stat.slice(open + 1, close);
    const rest = stat.slice(close + 2).trim().split(/\s+/);
    const state = rest[0];
    const ppid = Number(rest[1]);
    const pgid = Number(rest[2]);
    table.set(pid, {
      pid,
      ppid,
      pgid,
      state,
      // comm 可能含空格与括号（`(my proc)`），原样留着，事后能看出这个 pid 是谁
      comm,
      // pid 复用防护用的指纹：信号发出去之前必须还是这个进程
      fingerprint: `${comm}|${ppid}|${state}`,
    });
  }
  return table;
}

/** win32 的进程表：wmic 在新系统上已被移除，PowerShell CIM 是现役通路。 */
function readProcTableWin32() {
  return new Promise((res) => {
    const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { maxBuffer: 32 * 1024 * 1024, timeout: 15000 },
      (err, stdout) => {
        if (err || !stdout) return res(new Map());
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          return res(new Map());
        }
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        const table = new Map();
        for (const r of rows) {
          const pid = Number(r?.ProcessId);
          if (!Number.isFinite(pid)) continue;
          const ppid = Number(r?.ParentProcessId) || 0;
          table.set(pid, {
            pid,
            ppid,
            pgid: pid, // Windows 无进程组，组语义退化为单进程
            state: '?',
            fingerprint: `${r?.Name ?? ''}|${ppid}`,
          });
        }
        res(table);
      },
    );
  });
}

const isWin32 = process.platform === 'win32';

/**
 * 从进程表里取出 rootPid 的整棵子树，返回**叶子优先**的 pid 列表。
 *
 * 叶子优先的理由：先让子进程自己收尾（它还知道自己该关什么），最后才轮到宿主。
 * 反过来先杀父，子进程立刻变孤儿 —— 那些收尾逻辑就全丢了。
 *
 * @param {Map<number, object>} table
 * @param {number} rootPid
 * @param {Set<number>} exclude 不得纳入的 pid（通常是执行者自己）
 */
export function collectTree(table, rootPid, exclude = new Set()) {
  const children = new Map();
  for (const info of table.values()) {
    if (!children.has(info.ppid)) children.set(info.ppid, []);
    children.get(info.ppid).push(info.pid);
  }
  const out = [];
  const seen = new Set();
  // 显式栈做深度优先，出栈顺序即叶子优先
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid) || exclude.has(pid) || FORBIDDEN.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    const kids = children.get(pid);
    if (kids) stack.push(...kids);
  }
  // 反转：DFS 出栈是「根→叶」，倒过来才是「叶→根」
  return out.reverse();
}

/** 发一个信号；返回是否真的发出去了。 */
function signal(pid, sig) {
  if (FORBIDDEN.has(pid)) return false;
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false; // ESRCH = 已经没了；EPERM 见下
  }
}

/** win32 用 taskkill /T /F（/T 连子进程一起，/F 强杀）。 */
function taskkillTree(pid) {
  return new Promise((res) => {
    execFile('taskkill', ['/F', '/T', '/PID', String(pid)], () => res());
  });
}

/** 等一组 pid 全部消失；返回还活着的。 */
async function waitGone(pids, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const alive = pids.filter(isAlive);
    if (alive.length === 0) return [];
    await sleep(POLL_MS);
  }
  return pids.filter(isAlive);
}

/**
 * 校验 pid 仍是快照时那个进程（防 pid 复用误杀无关进程）。
 *
 * 顺序要紧：**先查表再比指纹**。进程已从快照里消失时返回 false 而非 true ——
 * 发信号给一个「已经不在了」的 pid，在它被系统回收复用的那一刻就是误杀。
 * 拿不到指纹（fingerprint 为空）只说明无法比对，不等于可以放行。
 *
 * @param {Map<number, object>} table 快照时的进程表
 * @param {number} pid
 * @param {string|null|undefined} fingerprint 快照时记下的指纹
 * @returns {boolean} true = 确认还是那个进程，可以发信号
 */
export function stillSameProcess(table, pid, fingerprint) {
  const now = table.get(pid);
  if (!now) return false;
  if (!fingerprint) return true;
  return now.fingerprint === fingerprint;
}

/**
 * 真正执行终止。
 *
 * @param {object} req stop-request.json 的内容
 * @returns {object} 回执
 */
export async function killTree(req) {
  const targetPid = Number(req?.targetPid);
  const scope = req?.scope === 'self' ? 'self' : 'tree';
  const mode = req?.mode === 'kill' ? 'kill' : 'term';
  const graceMs = Number.isFinite(req?.graceMs) ? req.graceMs : DEFAULT_GRACE_MS;
  const killWaitMs = Number.isFinite(req?.killWaitMs) ? req.killWaitMs : DEFAULT_KILL_WAIT_MS;
  const dryRun = req?.dryRun === true;

  const table = isWin32 ? await readProcTableWin32() : readProcTable();
  const target = table.get(targetPid);
  const targets = scope === 'self' ? [targetPid] : collectTree(table, targetPid);
  const fingerprints = new Map(targets.map((p) => [p, table.get(p)?.fingerprint]));

  // 宿主自称组长时，组信号能连「快照之后才冒出来的子进程」一起收掉 ——
  // 这是逐个杀做不到的。但必须三重排除，否则会连坐整台机器或把执行者自己杀掉。
  const canUseGroup = !isWin32
    && scope === 'tree'
    && target?.pgid === targetPid
    && targetPid > 1
    && target.pgid !== process.pid;

  const plan = {
    targetPid,
    targetAlive: isAlive(targetPid),
    scope,
    mode,
    graceMs,
    killWaitMs,
    dryRun,
    groupSignal: canUseGroup ? target.pgid : null,
    // `comm` 留痕：事后能判断「这个 pid 当时到底是什么进程」，也能把一次回执和另一次对上号。
    // cmd 不落盘（可能很长且含用户数据），只留内核给的 comm 短名。
    tree: targets.map((pid) => ({
      pid,
      ppid: table.get(pid)?.ppid ?? 0,
      comm: table.get(pid)?.comm ?? '',
    })),
  };
  if (dryRun) {
    return { ...plan, signalled: [], escalated: [], survivors: [], ok: false, dryRun: true };
  }

  // ── 两层投递：组信号 + 逐个补刀，二者缺一不可 ──────────────────
  //
  // ⚠️ 组信号只能打到**与宿主同进程组**的进程。dsh 起的工具进程 PGID ≠ PPID，
  // 也就是每个工具都在独立进程组里。只发组信号会漏掉它们，漏掉的就变孤儿。
  // 所以：组信号负责「快 + 收掉快照之后才加入本组的进程」，逐个信号负责「不漏」。
  //
  // 组信号的另一个代价：**无法逐个校验指纹**，pid 复用防护在那一路上不生效。
  // 安全性押在 canUseGroup 的三条判据上（dsh 自称组长 / 非 pid 1 / 不是执行者自己的组）。
  const signalled = [];
  const termSig = mode === 'kill' ? 'SIGKILL' : 'SIGTERM';
  if (canUseGroup && signal(-target.pgid, termSig)) signalled.push(-target.pgid);
  for (const pid of targets) {
    // 指纹变了说明这个 pid 已经被别的进程复用了，打过去是误伤
    if (mode !== 'kill' && !stillSameProcess(table, pid, fingerprints.get(pid))) continue;
    if (signal(pid, termSig)) signalled.push(pid);
  }

  const afterTerm = await waitGone(targets, mode === 'kill' ? killWaitMs : graceMs);
  const escalated = [];

  // ── 阶段 2：升级 SIGKILL ────────────────────────────────────────
  if (afterTerm.length) {
    if (isWin32) {
      await taskkillTree(afterTerm[0]);
    } else {
      if (canUseGroup && signal(-target.pgid, 'SIGKILL')) escalated.push(-target.pgid);
      // 补刀：等组信号生效一小会儿再看谁还活着 —— 组信号够不到的那些
      // （异进程组的子孙）只有这一层能收掉。
      await sleep(POLL_MS * 3);
      for (const pid of targets.filter(isAlive)) {
        if (signal(pid, 'SIGKILL')) escalated.push(pid);
      }
    }
    await waitGone(afterTerm, killWaitMs);
  }

  const survivors = targets.filter(isAlive);
  return {
    ...plan,
    signalled,
    escalated,
    survivors,
    targetGone: !isAlive(targetPid),
    // 「终止」的定义：目标进程消失，且没有留下还在跑的孤儿
    ok: !isAlive(targetPid) && survivors.length === 0,
  };
}

async function main() {
  const reqPath = process.argv[2];
  if (!reqPath) {
    console.error('usage: node killer.js <stop-request.json>');
    process.exit(2);
  }
  let req;
  try {
    req = JSON.parse(readFileSync(reqPath, 'utf8'));
  } catch (err) {
    console.error('[agint-restart/killer] bad request:', err?.message ?? err);
    process.exit(2);
  }

  const stateDir = req?.stateDir || dirname(reqPath);
  const resultPath = join(stateDir, 'stop-result.json');
  const requestId = req?.requestId ?? null;

  let result;
  try {
    result = await killTree(req);
  } catch (err) {
    result = { ok: false, error: String(err?.message ?? err) };
  }

  const doc = {
    requestId,
    startedAt: req?.requestedAt ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    killerPid: process.pid,
    platform: process.platform,
    ...result,
  };
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(resultPath, JSON.stringify(doc, null, 2));
  } catch { /* 回执写不出去也不能让终止失败 */ }
  console.log(`[agint-restart/killer] done ok=${doc.ok} survivors=${(doc.survivors || []).length}`);
}

// 只在「被当作脚本直接执行」时跑 main。被 import（测试 / 复用函数）时不自动执行 ——
// 判据比 endsWith 可靠：文件名相似不等于就是这个文件。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[agint-restart/killer] fatal:', err);
    process.exit(1);
  });
}

// collectTree / killTree / stillSameProcess 已在各自定义处 export，此处只补剩下的
export { readProcTable, isAlive };
