/**
 * Host half of the kill-switch bundle.
 *
 * The browser half owns the button; this file owns the only code that actually
 * stops the process. The button reaches it through the `kill-dsh` session
 * command, so a user can also run the same line in the composer — one
 * operation, one implementation, two human-facing callers.
 *
 * No agent tool is registered on purpose. A model tool that ends its own host
 * would let a turn kill the process it is still running inside, so this control
 * stays user-driven.
 */

/** @type {readonly ['commands']} */
export const inject = ['commands']

/** Shortest delay we honour, so the command result reaches the browser first. */
const MIN_DELAY_MS = 100
const MAX_DELAY_MS = 30_000
const DEFAULT_DELAY_MS = 800
/** A process that ignores SIGTERM still goes away. */
const FORCE_AFTER_MS = 2_000

export function apply(ctx) {
  /**
   * The one scheduled kill, or null. Held in this closure rather than at module
   * scope so unloading the plugin also drops a pending kill.
   * @type {{ timer: NodeJS.Timeout, at: number, delayMs: number, mode: string } | null}
   */
  let pending = null

  function clearPending() {
    if (!pending) return null
    clearTimeout(pending.timer)
    const was = pending
    pending = null
    return was
  }

  function fire(mode) {
    if (mode === 'exit') {
      process.exit(0)
    }
    const signal = mode === 'kill' ? 'SIGKILL' : 'SIGTERM'
    try {
      process.kill(process.pid, signal)
    } catch {
      process.exit(1)
    }
    setTimeout(() => process.exit(1), FORCE_AFTER_MS)
  }

  function schedule(delayMs, mode) {
    clearPending()
    pending = {
      timer: setTimeout(() => fire(mode), delayMs),
      at: Date.now() + delayMs,
      delayMs,
      mode,
    }
  }

  function describeMode(mode) {
    if (mode === 'exit') return 'process.exit(0)'
    return mode === 'kill' ? 'SIGKILL' : 'SIGTERM'
  }

  function handle(rawInput) {
    const tokens = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)

    if (tokens[0] === 'status' || tokens[0] === 'pending') {
      if (!pending) {
        return { kind: 'success', text: 'no kill is scheduled; this process is running' }
      }
      const left = Math.max(0, pending.at - Date.now())
      return {
        kind: 'success',
        text: `kill scheduled in ${left} ms via ${describeMode(pending.mode)}; run /kill-dsh cancel to stop it`,
      }
    }

    if (tokens[0] === 'cancel') {
      return clearPending()
        ? { kind: 'success', text: 'scheduled kill cancelled' }
        : { kind: 'success', text: 'nothing to cancel' }
    }

    let delayMs = DEFAULT_DELAY_MS
    let mode = 'term'
    for (const token of tokens) {
      if (/^\d+$/.test(token)) {
        delayMs = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Number(token)))
      } else if (token === 'term' || token === 'kill' || token === 'exit') {
        mode = token
      } else {
        return {
          kind: 'error',
          text: `unknown option "${token}". Usage: /kill-dsh [<delayMs>] [term|kill|exit] | status | cancel`,
        }
      }
    }

    schedule(delayMs, mode)
    return {
      kind: 'success',
      text: `kill scheduled in ${delayMs} ms via ${describeMode(mode)}; run /kill-dsh cancel to stop it`,
    }
  }

  const dispose = ctx.commands.register({
    name: 'kill-dsh',
    definitionId: '@local/dsh-kill-switch/kill-dsh',
    description: 'Terminate the DSH host process after a short delay. Use "status" or "cancel" to manage a pending one.',
    input: { hint: '[<delayMs>] [term|kill|exit] | status | cancel' },
    handler: ({ rawInput }) => handle(rawInput),
  })

  return () => {
    clearPending()
    dispose()
  }
}
