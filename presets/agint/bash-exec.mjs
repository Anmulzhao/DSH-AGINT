/**
 * bash-exec — 直接执行一个程序（argv 精确传参，不经 shell 字符串解析）。
 *
 * 与 `bash` 的分工：
 *   - `bash`（以及官方 `@deepseek-ai/dsh-tool-bash`）跑的是**命令字符串**：
 *     `bash -c "<command>"`，参数要自己转义。
 *   - `bash-exec` 跑的是**程序 + 参数数组**：argv 原样传给进程，没有 shell
 *     解析，也就没有引号地狱和元字符注入面。返回值分列 stdout / stderr /
 *     exitCode，非零退出码是**结果**而不是错误。
 *
 * 为什么智进要这个：AGINT 的日常动作大量是「跑一个脚本/一个程序带参数」
 * （跑一个 .sh、跑一个 .py、跑一个 .mjs），用命令字符串写要手工转义路径，
 * 路径里有空格或中文时最容易出错。argv 形式把这些都消掉。
 *
 * 执行面：`ctx.subprocess.spawn`（跨平台），不经 PTY——DSH 的 PTY 后端只支持
 * linux/darwin。因此本工具没有 OS 级沙箱约束（landlock 只在 linux），
 * 工具描述里写明。程序路径解析失败时报错并提示改用 `bash`。
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'agint-bash-exec'

/** The subprocess and tools services must exist before this tool can register. */
export const inject = ['subprocess', 'tools']

const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_MAX_OUTPUT_BYTES = 64000

/** Tool parameter schema for the model-facing execution request. */
const execSchema = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description:
        'The program to execute. A bare name is looked up on PATH; a path with a separator is used as given. ' +
        'With no `args`, whitespace inside `command` is split into program + arguments.',
    },
    args: {
      type: 'array',
      items: { type: 'string' },
      description: 'Arguments passed to the program, in order. No shell parsing is applied.',
    },
    cwd: {
      type: 'string',
      description: 'Optional working directory; defaults to the session cwd.',
    },
    timeoutMs: {
      type: 'number',
      description: 'Optional per-call timeout in milliseconds; defaults to 120000.',
    },
  },
  required: ['command'],
  additionalProperties: false,
}

/** Split a command string into program + arguments when no explicit args are given. */
export function splitCommand(command, args) {
  if (Array.isArray(args) && args.length > 0) return [command, ...args.map(String)]
  const parts = command.trim().split(/\s+/).filter(part => part.length > 0)
  if (parts.length === 0) throw new Error('bash-exec: command is empty')
  return parts
}

/** A command that names a file is used as given; a bare name goes through PATH lookup. */
export function looksLikePath(program) {
  return /[\\/]/.test(program)
}

/** Register the model-facing `bash-exec` tool. */
export function apply(ctx, config) {
  const source = config === undefined ? {} : config
  const defaultTimeoutMs = Number.isSafeInteger(source.timeoutMs) && source.timeoutMs > 0 ? source.timeoutMs : DEFAULT_TIMEOUT_MS
  const maxOutputBytes = Number.isSafeInteger(source.maxOutputBytes) && source.maxOutputBytes > 0 ? source.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES

  ctx.tools.register({
    name: 'bash-exec',
    description: [
      'Execute a program directly (argv-exact, no shell parsing) and return stdout, stderr and the exit code.',
      '* Use this for "run this program/script with these arguments"; use `bash` for command strings.',
      '* The program is looked up on PATH unless the command contains a path separator.',
      '* Arguments are passed verbatim: no quoting, no globbing, no variable expansion.',
      '* A non-zero exit code is reported in the result, not raised as an error.',
      '* NOTE: runs without OS sandbox confinement (no landlock); treat output as untrusted.',
    ].join('\n'),
    parameters: execSchema,
    timeoutMs: defaultTimeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          exitCode: { type: 'integer' },
        },
        required: ['stdout', 'stderr', 'exitCode'],
      },
      render: (_args, value) => {
        const parts = []
        if (value.stdout.length > 0) parts.push(value.stdout)
        if (value.stderr.length > 0) parts.push(value.stderr)
        if (parts.length === 0) parts.push(`exit code: ${value.exitCode} (no output)`)
        return [{ type: 'text', text: `${parts.join('\n')}\n[exit code: ${value.exitCode}]` }]
      },
    },
    async execute(args, exec) {
      const argv = splitCommand(String(args.command), args.args)
      const [program, ...rest] = argv

      let resolved = program
      if (!looksLikePath(program)) {
        try {
          resolved = await ctx.subprocess.resolveExecutable(program)
        } catch (error) {
          throw new Error(
            `bash-exec: program "${program}" was not found on PATH ` +
            `(${error instanceof Error ? error.message : String(error)}); ` +
            'use the `bash` tool for command strings, or pass a full path',
          )
        }
      }

      const workdir = typeof args.cwd === 'string' && args.cwd.length > 0
        ? args.cwd
        : exec?.agent?.session?.header?.cwd
      const timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : defaultTimeoutMs

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const signals = [controller.signal]
      if (exec?.signal !== undefined) signals.push(exec.signal)
      const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals)

      try {
        const handle = ctx.subprocess.spawn({
          argv: [resolved, ...rest],
          ...workdir !== undefined ? { cwd: workdir } : {},
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: maxOutputBytes },
            stderr: { maxBytes: maxOutputBytes },
          },
          signal,
          graceMs: 3000,
        })
        let outcome
        try {
          outcome = await handle.done
        } catch (error) {
          if (controller.signal.aborted) {
            throw new Error(`bash-exec: timed out after ${timeoutMs} ms`)
          }
          throw new Error(`bash-exec: spawn failed: ${String(error)}`)
        }
        let stdout = ''
        let stderr = ''
        try {
          stdout = handle.collected.stdout.readFrom(0).text
          stderr = handle.collected.stderr.readFrom(0).text
        } catch {
          // Collected readers may be unavailable on some backends; tolerate.
        }
        return {
          stdout,
          stderr,
          exitCode: typeof outcome.exitCode === 'number' ? outcome.exitCode : -1,
        }
      } finally {
        clearTimeout(timer)
      }
    },
  })
}
