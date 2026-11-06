import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * preset 本地 shell 工具的**行为级**护栏（2026-11-05 立项）。
 *
 * ## 覆盖什么
 *
 * 智进 preset 新挂了两条 preset-local 工具行（文件在 preset 目录里，与
 * liangshen 的 custom-bash.mjs 同一形状）：
 *
 *   - `bash.mjs`      → 注册工具 `bash`（win32 上用 Git Bash，POSIX 上禁用）
 *   - `bash-exec.mjs` → 注册工具 `bash-exec`（argv 精确传参直接执行程序）
 *
 * 这两个文件**不在** `../../.agint-bundle/plugins/…` 那 25 个相对工具行里，
 * 所以 `test/preset-rows-import.test.mjs`（只扫 `../` 开头的行）扫不到它们。
 * 那条护栏只保证「import 不炸」；本条保证「注册得上、跑得出正确结果」。
 *
 * ## 为什么要有这条
 *
 * preset 行失败是**静默**的：行挂不上时智进照常起，只是少了这个工具，
 * 界面不报错（AGENTS.md 记的 2026-10-20/21 两起事故同族）。所以这里在
 * 不启动宿主的前提下，用一个**最小 subprocess 桩**把两个工具真跑一遍：
 * 命令确实执行、stdout/stderr 确实回传、退出码确实分开。
 *
 * 桩只实现工具用到的那两个方法（`resolveExecutable` / `spawn`），
 * 语义对齐 `dsh-subprocess-local`：`spawn` 返回一个 handle，
 * `handle.done` 是 { exitCode }，`handle.collected.stdout.readFrom(0).text`
 * 取回整段输出。
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRESET_DIR = path.join(REPO_ROOT, 'presets', 'agint');

/** PATH 上的可执行文件查找（对齐宿主 resolveExecutable 的行为）。 */
function resolveOnPath(command) {
  if (command.includes('/') || command.includes('\\')) {
    return fs.existsSync(command) ? command : null;
  }
  // win32 的 PATH 变量叫 `Path`（分号分隔 + PATHEXT 后缀），POSIX 叫 `PATH`
  // （冒号分隔、无后缀）。桩只认 Windows 形态时 Linux 上 `Path` 恒为 undefined
  // ⇒ resolveWindowsBash 找不到 bash ⇒ 跳过注册 ⇒ 两条行为用例假红。
  const isWin = process.platform === 'win32';
  const exts = isWin ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : [];
  const pathVar = isWin ? (process.env.Path || process.env.PATH || '') : (process.env.PATH || '');
  for (const dir of pathVar.split(isWin ? ';' : ':')) {
    if (dir.length === 0) continue;
    for (const ext of ['', ...exts]) {
      const candidate = path.join(dir, command + ext.toLowerCase());
      if (fs.existsSync(candidate)) return candidate;
      const upper = path.join(dir, command + ext.toUpperCase());
      if (fs.existsSync(upper)) return upper;
    }
  }
  return null;
}

/** 最小 subprocess 桩：只实现工具真正调用的两个方法。 */
function stubSubprocess() {
  return {
    async resolveExecutable(command) {
      const resolved = resolveOnPath(command);
      if (resolved === null) throw new Error(`${command}: not found on PATH`);
      return resolved;
    },
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        ...spec.cwd !== undefined ? { cwd: spec.cwd } : {},
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const done = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => resolve({ exitCode: code ?? -1 }));
      });
      return {
        done,
        collected: {
          stdout: { readFrom: () => ({ text: stdout }) },
          stderr: { readFrom: () => ({ text: stderr }) },
        },
      };
    },
  };
}

/** 收集注册上来的工具定义。 */
function stubContext() {
  const registered = new Map();
  return {
    registered,
    ctx: {
      subprocess: stubSubprocess(),
      tools: {
        register(definition) {
          registered.set(definition.name, definition);
          return () => registered.delete(definition.name);
        },
      },
      logger: { warn() {}, debug() {}, error() {} },
    },
  };
}

test('bash.mjs 注册 bash 工具并真跑出一条命令', async () => {
  const { apply } = await import(pathToFileUrl(path.join(PRESET_DIR, 'bash.mjs')));
  const { ctx, registered } = stubContext();
  await apply(ctx, {});
  assert.ok(registered.has('bash'), 'bash 工具没有注册');
  const tool = registered.get('bash');
  const result = await tool.execute({ command: 'echo agint-bash-ok' });
  assert.match(result.text, /agint-bash-ok/);
});

test('bash.mjs 的非零退出码作为失败上报', async () => {
  const { apply } = await import(pathToFileUrl(path.join(PRESET_DIR, 'bash.mjs')));
  const { ctx, registered } = stubContext();
  await apply(ctx, {});
  const tool = registered.get('bash');
  await assert.rejects(
    () => tool.execute({ command: 'exit 3' }),
    /exit code/,
  );
});

test('bash.mjs 永远拒绝 System32 的 WSL 启动器', async () => {
  const { isWindowsSubsystemLauncher } = await import(pathToFileUrl(path.join(PRESET_DIR, 'bash.mjs')));
  assert.equal(isWindowsSubsystemLauncher('C:\\Windows\\System32\\bash.exe'), true);
  assert.equal(isWindowsSubsystemLauncher('C:\\Windows\\Sysnative\\bash.exe'), true);
  assert.equal(isWindowsSubsystemLauncher('C:\\Program Files\\Git\\bin\\bash.exe'), false);
});

test('bash-exec.mjs 注册 bash-exec 工具并按 argv 精确执行', async () => {
  const { apply } = await import(pathToFileUrl(path.join(PRESET_DIR, 'bash-exec.mjs')));
  const { ctx, registered } = stubContext();
  apply(ctx, {});
  assert.ok(registered.has('bash-exec'), 'bash-exec 工具没有注册');
  const tool = registered.get('bash-exec');
  const result = await tool.execute({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("agint-exec-ok")'],
  });
  assert.equal(result.stdout, 'agint-exec-ok');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
});

test('bash-exec.mjs 把非零退出码放进结果而不是抛错', async () => {
  const { apply } = await import(pathToFileUrl(path.join(PRESET_DIR, 'bash-exec.mjs')));
  const { ctx, registered } = stubContext();
  apply(ctx, {});
  const tool = registered.get('bash-exec');
  const result = await tool.execute({
    command: process.execPath,
    args: ['-e', 'process.stderr.write("boom"); process.exit(7)'],
  });
  assert.equal(result.exitCode, 7);
  assert.equal(result.stderr, 'boom');
});

test('bash-exec.mjs 的命令串在无 args 时按空白拆分', async () => {
  const { splitCommand } = await import(pathToFileUrl(path.join(PRESET_DIR, 'bash-exec.mjs')));
  assert.deepEqual(splitCommand('node  -e  "x"', undefined), ['node', '-e', '"x"']);
  assert.deepEqual(splitCommand('node', ['-e', 'x']), ['node', '-e', 'x']);
});

function pathToFileUrl(file) {
  return new URL(`file:///${file.replace(/\\/g, '/')}`).href;
}
