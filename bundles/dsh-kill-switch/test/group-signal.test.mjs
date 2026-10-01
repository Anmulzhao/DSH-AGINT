#!/usr/bin/env node
/**
 * 组信号前提验证：kill(-pgid) 能否收掉「快照之后才加入该进程组」的子进程。
 *
 * 为什么要单独测这一条
 * ────────────────────
 * killer.js 选组信号（`kill(-pgid)`）而不是逐个杀，唯一的理由就是：
 * 逐个杀只能打到 `readProcTable()` 快照里已有的那些 pid，而组信号由内核按
 * **当前**进程组成员投递，快照之后的成员照样中招。
 *
 * 这个前提此前只有设计推理，没有实测。若它不成立，整条组杀路线的理由就没了，
 * 得退回逐个杀（并接受「快照后新生的子进程会漏」）。所以单独立一条测试。
 *
 * ⚠️ 这测的是**前提**，不是 killer.js 的端到端：这里手工编排了
 * 「枚举 → 等待 → 组杀」的时序（真实 killer 的这个窗口只有微秒级，
 * 无法稳定构造）。但 collectTree 是直接从 ../killer.js import 的，
 * 且发信号用的就是 killTree 里那条 `process.kill(-pgid, sig)`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectTree, readProcTable, isAlive } from '../killer.js'

const IDLE = 'setInterval(() => {}, 1000)'

/** 一个组长进程 + 一个已存在的子进程；它能把「新子进程 pid」写到指定文件。 */
function spawnLeader(dir) {
  const kidScript = join(dir, 'kid.cjs')
  writeFileSync(kidScript, IDLE)
  const outFile = join(dir, 'late-child.pid')
  const script = join(dir, 'leader.cjs')
  writeFileSync(script, [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    `const kidScript = ${JSON.stringify(kidScript)}`,
    `const outFile = ${JSON.stringify(outFile)}`,
    '// 由外部 SIGUSR2 触发生子：这个时刻已经在 collectTree 的快照之后了',
    "process.on('SIGUSR2', () => {",
    '  const c = spawn(process.execPath, [kidScript], { stdio: "ignore" })',
    '  fs.writeFileSync(outFile, String(c.pid))',
    '})',
    'setInterval(() => {}, 1000)',
    "process.stdout.write(JSON.stringify({ pid: process.pid }) + '\\n')",
  ].join('\n'))

  const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('leader 启动超时')), 10000)
    child.stdout.on('data', (d) => {
      buf += d.toString()
      if (!buf.includes('\n')) return
      clearTimeout(timer)
      resolve({ pid: JSON.parse(buf.trim().split('\n')[0]).pid, child, outFile, dir })
    })
    child.on('error', reject)
  })
}

test('组信号能收掉快照之后才加入进程组的子进程（组杀路线的成立前提）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kill-switch-group-'))
  const leader = await spawnLeader(dir)
  t.after(() => {
    try { process.kill(leader.pid, 'SIGKILL') } catch {}
    rmSync(dir, { recursive: true, force: true })
  })

  // ── 快照时刻（等价于 killer.js 的 readProcTable + collectTree）──
  const snapshot = readProcTable()
  const treeAtSnapshot = collectTree(snapshot, leader.pid)
  assert.deepEqual(treeAtSnapshot, [leader.pid], '快照里应只有组长自己')

  // 组长确实是进程组长 —— canUseGroup 的第一判据
  assert.equal(snapshot.get(leader.pid).pgid, leader.pid, 'leader 应自成组长')
  assert.notEqual(leader.pid, process.pid, '绝不能把测试壳自己的组当目标')

  // ── 快照之后，让组长 fork 一个新子进程 ──────────────────────
  process.kill(leader.pid, 'SIGUSR2')
  const born = await new Promise((resolve, reject) => {
    const deadline = Date.now() + 8000
    const poll = async () => {
      const { readFileSync } = await import('node:fs')
      try {
        const raw = readFileSync(leader.outFile, 'utf8').trim()
        if (raw) return resolve(Number(raw))
      } catch { /* 还没写 */ }
      if (Date.now() > deadline) return reject(new Error('子进程未出生'))
      setTimeout(poll, 50)
    }
    poll()
  })

  assert.equal(isAlive(born), true, '新子进程应已出生并存活')
  assert.ok(!treeAtSnapshot.includes(born), '新子进程按定义不在快照里 —— 这正是要测的点')

  // ── 发组信号（与 killer.js 阶段 1/2 同一条语句）──────────────
  const pgid = snapshot.get(leader.pid).pgid
  process.kill(-pgid, 'SIGTERM')

  const deadline = Date.now() + 6000
  while (Date.now() < deadline && (isAlive(leader.pid) || isAlive(born))) {
    await new Promise((r) => setTimeout(r, 100))
  }

  assert.equal(isAlive(leader.pid), false, '组长应已终止')
  assert.equal(
    isAlive(born), false,
    `快照之后才加入进程组的子进程 ${born} 也应被组信号收掉 —— 若此断言失败，组杀路线的理由不成立，须退回逐个杀`,
  )
})
