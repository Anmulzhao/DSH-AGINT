#!/usr/bin/env node
/**
 * dsh-kill-switch — killer（独立进程，v1.0.0 里唯一真正发信号的地方）。
 *
 * 为什么必须是独立进程
 * ─────────────────────
 * v1.0.0 在宿主内部做 `process.kill(process.pid, signal)` —— 只打给自己一个 pid。
 * 实测（2026-10-01，Linux aarch64，dsh pid 1509258）它挂着子进程
 * `mcp-proxy.mjs`（pid 1515057，同 PGID）：主进程一死，子进程立刻变成 PPID=1 的
 * 孤儿继续跑，端口和内存都不回收。「终止」要的是整棵树干净，不是换一个孤儿接着跑。
 *
 * 而「谁来发信号」又必须发生在宿主**之外** —— 宿主一旦死了，执行者就没了。
 * 所以拆成两段（与 agint-restart 的 respawn 同一形状）：
 *   1) 宿主写 kill-request.json → detached 拉起本脚本 → 自己按 delay 退出
 *   2) 本脚本成为孤儿后继续跑：枚举进程树 → 叶子优先 SIGTERM → 升级 SIGKILL → 写回执
 *
 * 用法：node killer.js <kill-request.json>
 * 回执：<stateDir>/kill-result.json（宿主已死，没人当场读；下次启动由 status 补读）
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
      // pid 复用防护用的指纹：信号发出去之前必须还是这个进程
      fingerprint: `${comm}|${ppid}|${state}`,
    });
  }
  return table;
}

/** win32 的进程表：wmic 在新系统上已被移除，PowerShell CIM 是现役通路。 */
function readProcTableWin32() {
  return new Promise((resolve) => {
    const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { maxBuffer: 32 * 1024 * 1024, timeout: 15000 },
      (err, stdout) => {
        if (err || !stdout) return resolve(new Map());
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          return resolve(new Map());
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
        resolve(table);
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
  return new Promise((resolve) => {
    execFile('taskkill', ['/F', '/T', '/PID', String(pid)], () => resolve());
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

/** 校验 pid 仍是快照时那个进程（防 pid 复用误杀无关进程）。 */
export function stillSameProcess(table, pid, fingerprint) {
  if (!fingerprint) return true;
  const now = table.get(pid);
  return now ? now.fingerprint === fingerprint : false;
}

/**
 * 真正执行终止。
 *
 * @param {object} req kill-request.json 的内容
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
    tree: targets.map((pid) => ({ pid, ppid: table.get(pid)?.ppid ?? 0, ...(target ? {} : {}) })),
  };
  if (dryRun) {
    return { ...plan, signalled: [], escalated: [], survivors: [], ok: false, dryRun: true };
  }

  // ── 阶段 1：SIGTERM（mode='kill' 才直接跳到强杀）─────────────────
  //
  // ⚠️ 组信号与逐个信号有一处本质差别：组信号是内核按进程组一次性投递的，
  // **无法逐个校验指纹**，所以 pid 复用防护在组模式下不生效。那里的安全性全部
  // 押在 canUseGroup 的三条判据上（dsh 自称组长 / 非 pid 1 / 不是执行者自己的组）。
  // 这是刻意的取舍：组杀能收掉「快照之后才冒出来的子进程」，逐个杀收不掉。
  const signalled = [];
  if (mode === 'kill') {
    if (canUseGroup) {
      if (signal(-target.pgid, 'SIGKILL')) signalled.push(-target.pgid);
    } else {
      for (const pid of targets) if (signal(pid, 'SIGKILL')) signalled.push(pid);
    }
  } else if (canUseGroup) {
    if (signal(-target.pgid, 'SIGTERM')) signalled.push(-target.pgid);
  } else {
    for (const pid of targets) {
      // 指纹变了说明这个 pid 已经被别的进程复用了，打过去是误伤
      if (!stillSameProcess(table, pid, fingerprints.get(pid))) continue;
      if (signal(pid, 'SIGTERM')) signalled.push(pid);
    }
  }

  const afterTerm = await waitGone(targets, mode === 'kill' ? killWaitMs : graceMs);
  const escalated = [];

  // ── 阶段 2：升级 SIGKILL ────────────────────────────────────────
  if (afterTerm.length) {
    if (isWin32) {
      await taskkillTree(afterTerm[0]);
    } else if (canUseGroup) {
      if (signal(-target.pgid, 'SIGKILL')) escalated.push(-target.pgid);
    } else {
      for (const pid of afterTerm) {
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
    console.error('usage: node killer.js <kill-request.json>');
    process.exit(2);
  }
  let req;
  try {
    req = JSON.parse(readFileSync(reqPath, 'utf8'));
  } catch (err) {
    console.error('[kill-switch] killer: bad request:', err?.message ?? err);
    process.exit(2);
  }

  const stateDir = req?.stateDir || dirname(reqPath);
  const resultPath = join(stateDir, 'kill-result.json');
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
  console.log(`[kill-switch] killer done ok=${doc.ok} survivors=${(doc.survivors || []).length}`);
}

// 只在「被当作脚本直接执行」时跑 main。被 import（测试 / 复用函数）时不自动执行 ——
// 判据比 endsWith 可靠：文件名相似不等于就是这个文件。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[kill-switch] killer: fatal:', err);
    process.exit(1);
  });
}

// collectTree / killTree / stillSameProcess 已在各自定义处 export，此处只补剩下的
export { readProcTable, isAlive };
