#!/usr/bin/env node
/**
 * index.js 冒烟：命令解析、排程/取消、以及「不误杀」的自证。
 *
 * 安全约束：这里**永远不会真的触发 fire**。所有排程都用大 delayMs，
 * 测试结束前统一 cancel。任何一处 schedule 没被 clear，都会让测试进程自己
 * 把自己杀掉 —— 那正是这套用例想守住的那条线，所以它是自证的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

/** 最小 ctx：只提供 commands.register，够跑通 apply。 */
function fakeCtx() {
  const registered = []
  return {
    registered,
    commands: {
      register(spec) {
        registered.push(spec)
        return () => {
          const i = registered.indexOf(spec)
          if (i >= 0) registered.splice(i, 1)
        }
      },
    },
  }
}

/** 跑一行命令，返回 handler 的结果。 */
function run(ctx, rawInput) {
  const spec = ctx.registered.find((r) => r.name === 'kill-dsh')
  assert.ok(spec, 'kill-dsh 命令应已注册')
  return spec.handler({ rawInput })
}

test('apply 注册 kill-dsh，dispose 能撤销', () => {
  const ctx = fakeCtx()
  const dispose = apply(ctx)
  assert.equal(ctx.registered.length, 1)
  assert.equal(ctx.registered[0].name, 'kill-dsh')
  dispose()
  assert.equal(ctx.registered.length, 0, 'dispose 应撤销注册')
})

/**
 * 把插件的落盘目录指到临时目录再跑。
 *
 * 为什么必须隔离：`stateDir()` 取 `process.env.DSH_HOME`，所以 status 会去读
 * **真实的** `~/.dsh/.dsh-kill-switch/kill-result.json`。2026-10-01 真机点过一次
 * 按钮之后这个文件就存在了，同一个用例的输出随之改变 —— 结论取决于开发机点没点过
 * 按钮，那是测试没关好门，不是代码问题。
 */
function withStateDir(fn) {
  const prev = process.env.DSH_HOME
  const dir = mkdtempSync(join(tmpdir(), 'kill-switch-state-'))
  process.env.DSH_HOME = dir
  try {
    return fn(join(dir, '.dsh-kill-switch'))
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(dir, { recursive: true, force: true })
  }
}

test('status 在无待杀时报「正在运行」，并说明没有回执', () => {
  withStateDir(() => {
    const ctx = fakeCtx()
    const dispose = apply(ctx)
    try {
      const out = run(ctx, 'status')
      assert.equal(out.kind, 'success')
      assert.match(out.text, /pending: none; this process is running/)
      // 隔离目录下不可能有回执；这条断言「查不到就说查不到」，不许编一个 ok
      assert.match(out.text, /last kill: no receipt on disk/)
    } finally {
      dispose()
    }
  })
})

test('status 能读出上一次终止的真实回执（含 tree 长度与 survivors）', () => {
  withStateDir((stateDir) => {
    // 造一份真机回执的形状：tree 长度 1、survivors 0（2026-10-01 17:02 那次）
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'kill-result.json'), JSON.stringify({
      requestId: 'testreq1',
      finishedAt: '2026-10-01T09:02:52.727Z',
      targetPid: 424242,
      scope: 'tree',
      mode: 'term',
      ok: true,
      tree: [{ pid: 424242, ppid: 1, comm: 'node' }],
      signalled: [-424242],
      escalated: [],
      survivors: [],
    }))

    const ctx = fakeCtx()
    const dispose = apply(ctx)
    try {
      const out = run(ctx, 'status')
      assert.match(out.text, /last kill \(2026-10-01T09:02:52\.727Z\)/)
      assert.match(out.text, /ok=true scope=tree mode=term tree=1 .*survivors=0/)
    } finally {
      dispose()
    }
  })
})

test('status 在有孤儿时点名列出 survivors —— ok=true 不等于杀干净', () => {
  withStateDir((stateDir) => {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'kill-result.json'), JSON.stringify({
      finishedAt: '2026-10-01T09:02:52.727Z',
      ok: false,
      scope: 'tree',
      mode: 'term',
      tree: [{ pid: 1, ppid: 0, comm: 'node' }],
      survivors: [5150],
    }))

    const ctx = fakeCtx()
    const dispose = apply(ctx)
    try {
      const out = run(ctx, 'status')
      assert.match(out.text, /ok=false/)
      assert.match(out.text, /survivor pids: 5150/)
    } finally {
      dispose()
    }
  })
})

test('排程后 status 报出倒计时与作用域，cancel 能撤销', () => {
  const ctx = fakeCtx()
  const dispose = apply(ctx)
  try {
    const armed = run(ctx, '20000 kill tree')
    assert.equal(armed.kind, 'success')
    assert.match(armed.text, /kill scheduled in 20000 ms via SIGKILL \(whole process tree\)/)

    const stat = run(ctx, 'status')
    assert.match(stat.text, /pending: kill in \d+ ms/)
    assert.match(stat.text, /SIGKILL \(whole process tree\)/)

    const cancelled = run(ctx, 'cancel')
    assert.equal(cancelled.kind, 'success')
    assert.match(cancelled.text, /scheduled kill cancelled/)

    assert.match(run(ctx, 'status').text, /pending: none/)
    // 重复 cancel 是幂等的，不该报错
    assert.match(run(ctx, 'cancel').text, /nothing to cancel/)
  } finally {
    dispose()
  }
})

test('dispose 会丢弃待杀 —— 插件卸载不该留下一个悬在上面的杀', () => {
  const ctx = fakeCtx()
  const dispose = apply(ctx)
  run(ctx, '25000 kill')
  dispose()
  // 若 dispose 没清 timer，这个测试进程会在 25s 后自杀。
  // 这里只断言"没有异常"，真正的验证是：跑完整套测试后本进程仍活着。
  assert.equal(ctx.registered.length, 0)
})

test('延迟被夹在 100ms–30000ms，防止误填出永不触发或立刻触发的杀', () => {
  for (const [input, expected] of [['0', '100'], ['99999999', '30000'], ['5000', '5000']]) {
    const ctx = fakeCtx()
    const dispose = apply(ctx)
    try {
      const out = run(ctx, `${input} self`)
      assert.match(out.text, new RegExp(`kill scheduled in ${expected} ms`), `${input} → ${expected}`)
      run(ctx, 'cancel')
    } finally {
      dispose()
    }
  }
})

test('self 作用域只打自己，不承诺动子进程', () => {
  const ctx = fakeCtx()
  const dispose = apply(ctx)
  try {
    const out = run(ctx, '20000 self')
    assert.match(out.text, /SIGTERM \(self only\)/)
    run(ctx, 'cancel')
  } finally {
    dispose()
  }
})

test('exit 模式强制收敛到 self 作用域（两者都只作用于一个进程）', () => {
  const ctx = fakeCtx()
  const dispose = apply(ctx)
  try {
    const out = run(ctx, '20000 exit tree')
    assert.match(out.text, /process\.exit\(0\)/)
    assert.doesNotMatch(out.text, /whole process tree/, 'exit 不该被 tree 作用域带偏')
    run(ctx, 'cancel')
  } finally {
    dispose()
  }
})

test('未知选项被拒绝并给出用法', () => {
  const ctx = fakeCtx()
  const dispose = apply(ctx)
  try {
    const out = run(ctx, 'sudo rm -rf')
    assert.equal(out.kind, 'error')
    assert.match(out.text, /unknown option "sudo"/)
    assert.match(out.text, /Usage: \/kill-dsh/)
  } finally {
    dispose()
  }
})

test('插件可加载：index.js 与 killer.js 都能裸 import（部署后自毁的兜底）', () => {
  // install.sh 的裸 import 门禁依赖这个性质，这里守住它
  assert.ok(existsSync(new URL('../index.js', import.meta.url).pathname))
  assert.ok(existsSync(new URL('../killer.js', import.meta.url).pathname))
  // killer.js 被 import 时不得自动执行 main（否则 import 它就等于触发一次终止）
  const src = readFileSync(new URL('../killer.js', import.meta.url), 'utf8')
  assert.match(src, /resolve\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)/,
    'killer 的 main 必须由「是否被直接执行」守卫，而不是 import 即跑')
})

test('package.json 会把 killer.js 一起装出去', () => {
  // ⚠️ 这是本 bundle 最容易静默失效的一处：files 里没有 killer.js → 安装后部署位
  // 没有这个文件 → index.js spawn 失败 → 兜底退化成 v1.0.0 的「只杀自己」，
  // 而日志只有一行 warn，用户看到的还是「按钮点下去 DSH 没了」，看不出树没杀干净。
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.files.includes('killer.js'), 'files 必须含 killer.js')
  assert.equal(pkg.exports['./killer'], './killer.js', 'exports 应暴露 killer 入口')
  // 2.0.0 破了环（只杀自己 → 杀整棵树）；2.0.1 才真正修好 client 那个不存在的 API。
  // 断言 major >= 2 而不是钉死补丁号 —— 后者只会在正常升版时制造噪音。
  assert.match(pkg.version, /^2\.\d+\.\d+$/, `主版本应 >= 2（行为已破环），实际 ${pkg.version}`)
})
