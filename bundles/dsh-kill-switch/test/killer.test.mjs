#!/usr/bin/env node
/**
 * killer 冒烟：造一棵假进程树，验证「整棵树真的死干净」。
 *
 * 安全约束（这个测试唯一的红线）：**目标 pid 全部来自本文件自己 spawn 的进程**。
 * 任何一处写死 pid、任何一处从环境里捞 pid，都可能把老板正在用的 dsh 杀掉。
 * 断言里因此一律用 `fake.pid` / `fake.kids`，没有一个数字是手写的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { killTree, collectTree, readProcTable, isAlive, stillSameProcess } from '../killer.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const KILLER = join(HERE, '..', 'killer.js')

/** 一个长驻的假进程：比 dsh 子进程更简单，不 fork、不写 stdout。 */
const IDLE = 'setInterval(() => {}, 1000)'

/** 假 dsh 的脚本文本：自己长驻，并 fork 出 `kidCount` 个长驻子进程（模拟 mcp-proxy）。 */
function fakeDshSource(kidCount) {
  return [
    "const { spawn } = require('node:child_process')",
    'const kids = []',
    `for (let i = 0; i < ${kidCount}; i++) {`,
    `  kids.push(spawn(process.execPath, ['-e', ${JSON.stringify(IDLE)}], { stdio: 'ignore' }))`,
    '}',
    "process.stdout.write(JSON.stringify({ pid: process.pid, kids: kids.map((k) => k.pid) }) + '\\n')",
    'setInterval(() => {}, 1000)',
  ].join('\n')
}

/** 起一棵假进程树并等它报出 pid。 */
function spawnFakeTree(kidCount = 2) {
  const dir = mkdtempSync(join(tmpdir(), 'kill-switch-test-'))
  const script = join(dir, 'fake-dsh.cjs')
  writeFileSync(script, fakeDshSource(kidCount))
  // detached:true 让假 dsh 自成进程组组长 —— 与真 dsh 的 PGID=SID=pid 一致，
  // 不这样就测不到组杀分支。
  const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('fake dsh 启动超时')), 10000)
    child.stdout.on('data', (d) => {
      buf += d.toString()
      if (!buf.includes('\n')) return
      clearTimeout(timer)
      const info = JSON.parse(buf.trim().split('\n')[0])
      resolve({ ...info, child, dir })
    })
    child.on('error', reject)
  })
}

/** 等条件成立；超时返回 false（由调用方断言，不静默通过）。 */
async function waitUntil(predicate, timeoutMs = 8000, stepMs = 100) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await new Promise((r) => setTimeout(r, stepMs))
  }
  return false
}

// ── 单元：进程树枚举 ──────────────────────────────────────────────

test('collectTree 返回叶子优先的顺序', () => {
  // 10 → 20 → 40, 10 → 30 → 50
  // 根刻意不用 pid 1：pid 1 在 FORBIDDEN 里，是设计上的保护对象，不能拿来当测试根
  const table = new Map([
    [10, { pid: 10, ppid: 1 }], [20, { pid: 20, ppid: 10 }], [30, { pid: 30, ppid: 10 }],
    [40, { pid: 40, ppid: 20 }], [50, { pid: 50, ppid: 30 }],
  ])
  const tree = collectTree(table, 10, new Set())
  assert.deepEqual([...tree].sort(), [10, 20, 30, 40, 50], '五个进程都应被枚举到')
  assert.equal(tree.at(-1), 10, '根必须排在最后（先杀子后杀父）')
  assert.ok(tree.indexOf(40) < tree.indexOf(20), '叶子 40 应先于父 20')
  assert.ok(tree.indexOf(50) < tree.indexOf(30), '叶子 50 应先于父 30')
  assert.ok(tree.indexOf(20) < tree.indexOf(10), '子 20 应先于根 10')
})

test('collectTree 绝不纳入 pid 1 与被排除的 pid', () => {
  const table = new Map([
    [1, { pid: 1, ppid: 0 }], [7, { pid: 7, ppid: 1 }], [8, { pid: 8, ppid: 7 }],
  ])
  assert.deepEqual(collectTree(table, 7, new Set([8])), [7], '只应剩根 7；pid 1 与被排除的 8 都不能进列表')
  assert.deepEqual(collectTree(table, 1, new Set()), [], '以 pid 1 为根时应返回空 —— init 不是可杀目标')
})

test('readProcTable 读得到自己，pid 与 ppid 与 os 一致', () => {
  const table = readProcTable()
  assert.ok(table.size > 0, '进程表不应为空')
  const me = table.get(process.pid)
  assert.ok(me, '进程表应包含自己')
  assert.equal(me.pid, process.pid)
  assert.equal(me.ppid, process.ppid, '自己那一行的 ppid 应与 os 一致（comm 解析没被空格/括号带偏）')
  // 不断言 pgid === pid：node --test 是 dsh 的子进程，自己并不是组长
  assert.equal(typeof me.pgid, 'number', 'pgid 应能解析出来（canUseGroup 依赖它）')
})

// ── 端到端：真杀一棵假树 ──────────────────────────────────────────

test('SIGKILL 模式把整棵进程树杀干净，survivors 为空', async (t) => {
  const fake = await spawnFakeTree(2)
  t.after(() => {
    for (const pid of [fake.pid, ...fake.kids]) { try { process.kill(pid, 'SIGKILL') } catch {} }
    rmSync(fake.dir, { recursive: true, force: true })
  })

  // 前置：子进程确实活着（否则这个测试在证明空气）
  for (const kid of fake.kids) {
    assert.equal(isAlive(kid), true, `假子进程 ${kid} 应当存活`)
  }

  const result = await killTree({ targetPid: fake.pid, mode: 'kill', scope: 'tree' })

  assert.equal(result.ok, true, `终止应成功，survivors=${JSON.stringify(result.survivors)}`)
  assert.deepEqual(result.survivors, [], '不应留下任何孤儿')
  assert.equal(result.targetGone, true, '目标进程应已消失')
  assert.equal(result.tree.length, 3, '树里应有 3 个进程（1 根 + 2 子）')
  // 这是 v1.0.0 缺的那一半：子进程必须跟着死
  for (const kid of fake.kids) {
    assert.equal(isAlive(kid), false, `假子进程 ${kid} 应随宿主一起终止`)
  }
})

test('SIGTERM 模式：扛得住 SIGTERM 的进程会被升级到 SIGKILL', async (t) => {
  // 装一个忽略 SIGTERM 的 handler —— 模拟「dsh 有优雅关闭逻辑、迟迟不退」
  const dir = mkdtempSync(join(tmpdir(), 'kill-switch-stubborn-'))
  const script = join(dir, 'stubborn.cjs')
  writeFileSync(script, [
    "process.on('SIGTERM', () => {})",
    'setInterval(() => {}, 1000)',
    "process.stdout.write(JSON.stringify({ pid: process.pid, kids: [] }) + '\\n')",
  ].join('\n'))
  const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  t.after(() => {
    try { process.kill(child.pid, 'SIGKILL') } catch {}
    rmSync(dir, { recursive: true, force: true })
  })

  const pid = await new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('启动超时')), 10000)
    child.stdout.on('data', (d) => {
      buf += d.toString()
      if (!buf.includes('\n')) return
      clearTimeout(timer)
      resolve(JSON.parse(buf.trim().split('\n')[0]).pid)
    })
  })

  const result = await killTree({ targetPid: pid, mode: 'term', scope: 'tree', graceMs: 800 })

  assert.equal(result.ok, true, '忽略 SIGTERM 也必须被升级强杀后终止')
  // stubborn 是 detached 启动的组长，走的是组信号分支，所以 escalated 记的是**组 id**
  // （负数 = -pgid）。这是刻意的：组杀能收掉快照之后才冒出来的子进程，逐个杀收不掉。
  assert.ok(
    result.escalated.some((e) => Math.abs(e) === pid),
    `pid ${pid} 应被升级强杀（escalated=${JSON.stringify(result.escalated)}）`,
  )
  assert.equal(result.signalled.every((s) => s < 0), true, 'term 阶段先发的应是组 SIGTERM，不该直接强杀')
  assert.equal(isAlive(pid), false)
})

test('dryRun 只报计划，不动任何进程', async (t) => {
  const fake = await spawnFakeTree(1)
  t.after(() => {
    for (const pid of [fake.pid, ...fake.kids]) { try { process.kill(pid, 'SIGKILL') } catch {} }
    rmSync(fake.dir, { recursive: true, force: true })
  })

  const result = await killTree({ targetPid: fake.pid, mode: 'kill', scope: 'tree', dryRun: true })

  assert.equal(result.dryRun, true)
  assert.equal(result.tree.length, 2, 'dryRun 仍应报出树形')
  assert.equal(result.signalled.length, 0, 'dryRun 不应发任何信号')
  assert.equal(isAlive(fake.pid), true, 'dryRun 不得杀死目标')
})

test('目标早已消失时，终止应判定为已完成而不是失败', async () => {
  const result = await killTree({ targetPid: 999_999_999, mode: 'kill', scope: 'tree' })
  assert.equal(result.ok, true, '没有东西要杀时视为成功')
  assert.equal(result.targetAlive, false)
})

test('指纹失配的 pid 被跳过：pid 被复用时不误伤无关进程', () => {
  // 快照：pid 4242 当时是「(victim)|1|S」
  const snapshot = new Map([[4242, { pid: 4242, ppid: 1, pgid: 4242, state: 'S', fingerprint: 'victim|1|S' }]])

  assert.equal(stillSameProcess(snapshot, 4242, 'victim|1|S'), true, '指纹一致应放行')

  // 信号发出前 pid 被别的进程复用了：指纹不再匹配，必须拒绝
  const reused = new Map([[4242, { pid: 4242, ppid: 1, pgid: 4242, state: 'R', fingerprint: 'bystander|1|R' }]])
  assert.equal(stillSameProcess(reused, 4242, 'victim|1|S'), false, '指纹不一致必须拦下，否则会误杀无关进程')

  // 进程已经消失：表里查不到，同样不能当成"还是那个进程"
  assert.equal(stillSameProcess(new Map(), 4242, 'victim|1|S'), false, '查不到就必须跳过')

  // 没有指纹可比时（win32 拿不到稳定指纹）放行，交给后续的存活检查兜底
  assert.equal(stillSameProcess(reused, 4242, ''), true, '无指纹时应放行而不是全盘拒绝')
})

// ── 端到端：detached killer 进程的完整链路 ────────────────────────

test('detached killer 独立完成终止并写出回执', async (t) => {
  const fake = await spawnFakeTree(2)
  const stateDir = mkdtempSync(join(tmpdir(), 'kill-switch-receipt-'))
  t.after(() => {
    for (const pid of [fake.pid, ...fake.kids]) { try { process.kill(pid, 'SIGKILL') } catch {} }
    rmSync(fake.dir, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
  })

  const reqPath = join(stateDir, 'kill-request.json')
  writeFileSync(reqPath, JSON.stringify({
    requestId: 'testreq1',
    requestedAt: new Date().toISOString(),
    targetPid: fake.pid,
    stateDir,
    mode: 'kill',
    scope: 'tree',
  }))

  // 模拟 index.js 的派发方式
  const killer = spawn(process.execPath, [KILLER, reqPath], { detached: true, stdio: 'ignore' })
  killer.unref()
  assert.notEqual(killer.pid, fake.pid, 'killer 必须是自己独立拉起的进程')

  const resultFile = join(stateDir, 'kill-result.json')
  const appeared = await waitUntil(() => {
    try { return readJsonFile(resultFile)?.ok === true } catch { return false }
  }, 15000)

  assert.equal(appeared, true, '回执应在 15s 内落盘且 ok=true')
  const receipt = readJsonFile(resultFile)
  assert.equal(receipt.requestId, 'testreq1')
  assert.equal(receipt.killerPid, killer.pid, '回执应记录执行者 pid')
  assert.deepEqual(receipt.survivors, [])
  for (const kid of fake.kids) {
    assert.equal(isAlive(kid), false, `子进程 ${kid} 应随回执一同消失`)
  }
})

function readJsonFile(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}
