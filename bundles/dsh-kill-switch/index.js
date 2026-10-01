/**
 * Host half of the kill-switch bundle.
 *
 * The browser half owns the button; this file hands the request to `killer.js`,
 * which is the only code that actually sends a signal. The button reaches it
 * through the `kill-dsh` session command, so a user can also run the same line
 * in the composer — one operation, one implementation, two human-facing callers.
 *
 * No agent tool is registered on purpose. A model tool that ends its own host
 * would let a turn kill the process it is still running inside, so this control
 * stays user-driven.
 *
 * ── v2.0.0：为什么不再自己 kill 自己 ──────────────────────────────
 * v1.0.0 在这里做 `process.kill(process.pid, sig)`，只打给自己一个 pid。实测
 * （2026-10-01，dsh pid 1509258 带子进程 mcp-proxy 1515057）主进程一死，子进程
 * 立刻变 PPID=1 的孤儿继续跑 —— 端口不释放、内存不回收，「终止」名不副实。
 *
 * 现在流程与 agint-restart 的 respawn 同形：宿主只负责**派发**与**留痕**，
 * 真正发信号的是 detached 出去的 killer.js。
 *
 *   宿主：写 kill-request.json → detached 拉起 killer → 静候
 *   killer：枚举进程树 → 叶子优先 SIGTERM → 升级 SIGKILL → 写 kill-result.json
 *
 * 宿主**不自杀**，这是刻意的：killer 做 pid 复用防护时比对的是「ppid 仍在原主」的
 * 指纹，宿主先死就会让子进程的 ppid 变成 1、指纹失配、被误判成「不是那个进程」而漏杀。
 * 叶子优先的顺序保证宿主是最后一个被打死的，命令结果早已回到浏览器。
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

/** @type {readonly ['commands']} */
export const inject = ['commands']

/** Shortest delay we honour, so the command result reaches the browser first. */
const MIN_DELAY_MS = 100
const MAX_DELAY_MS = 30_000
const DEFAULT_DELAY_MS = 800
/** A process that ignores SIGTERM still goes away. */
const FORCE_AFTER_MS = 2_000

const stateDir = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.dsh-kill-switch')
const requestPath = () => join(stateDir(), 'kill-request.json')
const resultPath = () => join(stateDir(), 'kill-result.json')
const killerScript = fileURLToPath(new URL('./killer.js', import.meta.url))

/** Read a JSON file, missing-or-broken returns null. Never throws. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(path, doc) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(doc, null, 2))
    return true
  } catch {
    return false
  }
}

export function apply(ctx) {
  /**
   * The one scheduled kill, or null. Held in this closure rather than at module
   * scope so unloading the plugin also drops a pending kill.
   * @type {{ timer: NodeJS.Timeout, at: number, delayMs: number, mode: string, scope: string } | null}
   */
  let pending = null

  function clearPending() {
    if (!pending) return null
    clearTimeout(pending.timer)
    const was = pending
    pending = null
    return was
  }

  /**
   * Last-resort self-kill. Only reached when the killer cannot be started at all
   * (or when the caller explicitly asked for `self` / `exit`), because it leaves
   * the process tree exactly as dirty as v1.0.0 did.
   */
  function selfKill(mode) {
    if (mode === 'exit') {
      process.exit(0)
    }
    const signal = mode === 'kill' ? 'SIGKILL' : 'SIGTERM'
    try {
      process.kill(process.pid, signal)
    } catch {
      process.exit(1)
    }
    const t = setTimeout(() => process.exit(1), FORCE_AFTER_MS)
    t.unref?.()
  }

  /**
   * Hand the kill to the detached killer, then stand still and let it take us last.
   * @returns {{ok: boolean, dispatched: boolean, requestId: string, error?: string}}
   */
  function dispatch(mode, scope) {
    const requestId = randomUUID().slice(0, 8)
    const requestedAt = new Date().toISOString()
    const req = {
      requestId,
      requestedAt,
      // The killer reads this while we are still alive — a stale pid here would
      // make it signal an unrelated process that recycled the number.
      targetPid: process.pid,
      stateDir: stateDir(),
      mode,
      scope,
      graceMs: FORCE_AFTER_MS * 2,
      killWaitMs: 4000,
    }
    if (!writeJson(requestPath(), req)) {
      return { ok: false, dispatched: false, requestId, error: `无法写入 ${requestPath()}` }
    }
    try {
      const child = spawn(process.execPath, [killerScript, requestPath()], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: process.env,
      })
      child.unref()
      return { ok: true, dispatched: true, requestId }
    } catch (err) {
      return { ok: false, dispatched: false, requestId, error: String(err?.message ?? err) }
    }
  }

  function fire(mode, scope) {
    pending = null

    // `exit` and `self` never involve the tree, so they skip the killer entirely.
    if (mode === 'exit' || scope === 'self') {
      selfKill(mode)
      return
    }

    const r = dispatch(mode, scope)
    if (r.dispatched) return

    // The killer never started: nobody else is going to end this process, so
    // fall back to killing ourselves rather than leaving the host running after
    // the user was told it was stopping.
    console.warn(`[kill-switch] killer dispatch failed (${r.error}); falling back to self-kill`)
    selfKill(mode)
  }

  function schedule(delayMs, mode, scope) {
    clearPending()
    const timer = setTimeout(() => fire(mode, scope), delayMs)
    // unref so a pending kill never holds the event loop open on its own
    timer.unref?.()
    pending = { timer, at: Date.now() + delayMs, delayMs, mode, scope }
  }

  function describeMode(mode, scope) {
    if (mode === 'exit') return 'process.exit(0)'
    if (scope === 'self') return mode === 'kill' ? 'SIGKILL (self only)' : 'SIGTERM (self only)'
    return mode === 'kill' ? 'SIGKILL (whole process tree)' : 'SIGTERM → SIGKILL (whole process tree)'
  }

  const USAGE = 'Usage: /kill-dsh [<delayMs>] [term|kill|exit|self] | status | cancel'

  function statusText() {
    const parts = []
    if (pending) {
      const left = Math.max(0, pending.at - Date.now())
      parts.push(`pending: kill in ${left} ms via ${describeMode(pending.mode, pending.scope)}`)
    } else {
      parts.push('pending: none; this process is running')
    }
    // The real receipt from the last kill. The host is dead by the time the killer
    // writes it, so this is how a *later* start learns whether the previous stop
    // left orphans behind.
    const result = readJson(resultPath())
    if (result) {
      const when = result.finishedAt ?? result.startedAt ?? 'unknown time'
      const tree = Array.isArray(result.tree) ? result.tree.length : 0
      const survivors = Array.isArray(result.survivors) ? result.survivors.length : 0
      parts.push(
        `last kill (${when}): ok=${result.ok} scope=${result.scope ?? '-'} mode=${result.mode ?? '-'} ` +
        `tree=${tree} signalled=${(result.signalled || []).length} escalated=${(result.escalated || []).length} ` +
        `survivors=${survivors}` + (result.error ? ` error=${result.error}` : ''),
      )
      if (survivors > 0) parts.push(`survivor pids: ${result.survivors.join(', ')}`)
    } else {
      parts.push('last kill: no receipt on disk')
    }
    return parts.join('\n')
  }

  function handle(rawInput) {
    const tokens = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)

    if (tokens[0] === 'status' || tokens[0] === 'pending') {
      return { kind: 'success', text: statusText() }
    }

    if (tokens[0] === 'cancel') {
      return clearPending()
        ? { kind: 'success', text: 'scheduled kill cancelled' }
        : { kind: 'success', text: 'nothing to cancel' }
    }

    let delayMs = DEFAULT_DELAY_MS
    let mode = 'term'
    let scope = 'tree'
    for (const token of tokens) {
      if (/^\d+$/.test(token)) {
        delayMs = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Number(token)))
      } else if (token === 'term' || token === 'kill' || token === 'exit') {
        mode = token
      } else if (token === 'tree' || token === 'self') {
        scope = token
      } else {
        return { kind: 'error', text: `unknown option "${token}". ${USAGE}` }
      }
    }
    // `exit` and `self` are one-process actions; a tree scope would contradict them.
    if (mode === 'exit') scope = 'self'

    schedule(delayMs, mode, scope)
    return {
      kind: 'success',
      text: `kill scheduled in ${delayMs} ms via ${describeMode(mode, scope)}; run /kill-dsh cancel to stop it`,
    }
  }

  const dispose = ctx.commands.register({
    name: 'kill-dsh',
    definitionId: '@local/dsh-kill-switch/kill-dsh',
    description: 'Terminate the DSH host process and its child processes after a short delay. Use "status" or "cancel" to manage a pending one.',
    input: { hint: '[<delayMs>] [term|kill|exit|self] | status | cancel' },
    handler: ({ rawInput }) => handle(rawInput),
  })

  return () => {
    clearPending()
    dispose()
  }
}
