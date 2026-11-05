/**
 * bash — 智进在 Windows 上的 `bash` 工具（Git Bash）。
 *
 * 为什么需要它：DSH 官方 `bash` 行按平台启用（POSIX 启用、win32 禁用），
 * 本机 host 的 shell 服务在 win32 上是 pwsh。智进要的是**真 bash**，所以
 * 在 win32 上另挂一个工具名同为 `bash` 的工具；两条按平台互斥，不会重复注册。
 *
 * 做法与 liangshen preset 的 custom-bash.mjs 同一套（那是本机唯一的既有先例）：
 *   - 可执行文件解析顺序：显式 config.bashPath → Git 常规安装根 → PATH 上的
 *     `bash`。`C:\Windows\System32\bash.exe`（WSL 启动器）**永远拒绝**，
 *     PATH 命中它时不会把 WSL 外壳交给模型。
 *   - 解析只在挂载时做一次；全部候选都找不到就**跳过注册**（不注册一个
 *     每次调用都失败的工具）。
 *
 * 执行面：`ctx.subprocess.spawn` + `bash -c <command>`，不经 PTY——DSH 的
 * PTY 后端只支持 linux/darwin，win32 上 subprocess 会抛 "terminal inspection
 * is unsupported on platform win32"。代价是 Windows 上没有 OS 级沙箱约束
 * （landlock 只在 linux），工具描述里写明。
 *
 * 语义与官方 bash 工具一致：每次调用一个新 shell，非零退出码作为失败上报
 * （抛错）而不是静默返回。
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'agint-bash'

/** The subprocess and tools services must exist before this tool can register. */
export const inject = ['subprocess', 'tools']

const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_MAX_OUTPUT_BYTES = 64000

/** Tool parameter schema for the model-facing command. */
const commandSchema = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: 'The bash command to execute (`bash -c` string domain).',
    },
    workdir: {
      type: 'string',
      description: 'Optional working directory; defaults to the session cwd.',
    },
  },
  required: ['command'],
  additionalProperties: false,
}

/** Windows' System32 bash.exe is the WSL launcher, not the Git Bash executor. */
export function isWindowsSubsystemLauncher(path) {
  return /[\\/]windows[\\/](?:system32|sysnative)[\\/]bash\.exe$/i.test(path)
}

/** Git Bash locations in deterministic order (explicit config first). */
export function windowsBashCandidates(config = {}, environment = process.env) {
  const explicit = config.bashPath
  if (typeof explicit === 'string' && explicit.length > 0) return [explicit]

  const candidates = []
  const seen = new Set()
  const add = (candidate) => {
    const key = candidate.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(candidate)
  }
  for (const root of [environment.ProgramFiles, environment['ProgramFiles(x86)']]) {
    if (typeof root !== 'string' || root.length === 0) continue
    add(`${root}\\Git\\bin\\bash.exe`)
    add(`${root}\\Git\\usr\\bin\\bash.exe`)
  }
  if (typeof environment.LOCALAPPDATA === 'string' && environment.LOCALAPPDATA.length > 0) {
    add(`${environment.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe`)
    add(`${environment.LOCALAPPDATA}\\Programs\\Git\\usr\\bin\\bash.exe`)
  }
  add('bash')
  return candidates
}

/** Resolve Git Bash without accidentally accepting the WSL compatibility shim. */
export async function resolveWindowsBash(subprocess, config = {}, environment = process.env) {
  const failures = []
  for (const candidate of windowsBashCandidates(config, environment)) {
    try {
      const resolved = await subprocess.resolveExecutable(candidate)
      if (isWindowsSubsystemLauncher(resolved)) {
        failures.push(`${candidate}: resolved to the Windows Subsystem for Linux launcher`)
        continue
      }
      return resolved
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`Git Bash executable unavailable (${failures.join('; ')})`)
}

function warn(ctx, message) {
  try {
    ctx.logger.warn(message)
  } catch {
    // Logger unavailable — registration is skipped either way.
  }
}

/** Register the model-facing `bash` tool. */
export async function apply(ctx, config) {
  const source = config === undefined ? {} : config
  const timeoutMs = Number.isSafeInteger(source.timeoutMs) && source.timeoutMs > 0 ? source.timeoutMs : DEFAULT_TIMEOUT_MS
  const maxOutputBytes = Number.isSafeInteger(source.maxOutputBytes) && source.maxOutputBytes > 0 ? source.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES

  let bashPath
  try {
    bashPath = await resolveWindowsBash(ctx.subprocess, source)
  } catch (error) {
    warn(ctx, `agint-bash: ${error instanceof Error ? error.message : String(error)} — the Windows bash tool is not registered`)
    return
  }

  ctx.tools.register({
    name: 'bash',
    description: [
      'Run commands in a bash shell (Git Bash on Windows)',
      '* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.',
      '* State does NOT persist across command calls: each call runs in a fresh shell.',
      "* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.",
      '* Please avoid commands that may produce a very large amount of output.',
      '* NOTE: runs without OS sandbox confinement on Windows (no landlock); treat output as untrusted.',
    ].join('\n'),
    parameters: commandSchema,
    timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const workdir = typeof args.workdir === 'string' && args.workdir.length > 0
        ? args.workdir
        : exec?.agent?.session?.header?.cwd
      const signal = exec?.signal
      const handle = ctx.subprocess.spawn({
        argv: [bashPath, '-c', args.command],
        ...workdir !== undefined ? { cwd: workdir } : {},
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: maxOutputBytes },
          stderr: { maxBytes: maxOutputBytes },
        },
        ...signal !== undefined ? { signal } : {},
        graceMs: 3000,
      })
      let outcome
      try {
        outcome = await handle.done
      } catch (error) {
        // A spawn-level failure (bad executable, EPERM) surfaces as a throw,
        // which the runtime turns into an isError result.
        throw new Error(`bash spawn failed: ${String(error)}`)
      }
      let stdout = ''
      let stderr = ''
      try {
        stdout = handle.collected.stdout.readFrom(0).text
        stderr = handle.collected.stderr.readFrom(0).text
      } catch {
        // Collected readers may be unavailable on some backends; tolerate.
      }
      const text = [stdout, stderr].filter((part) => part.length > 0).join('\n')
      const tail = text.length > 0 ? text : `exit code: ${outcome.exitCode} (no output)`
      if (outcome.exitCode !== 0) {
        // Non-zero exit is a reported failure, not a throw: the model sees the
        // command output plus the exit code.
        throw new Error(tail)
      }
      return { text: tail }
    },
  })
}
