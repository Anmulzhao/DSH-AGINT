#!/usr/bin/env node
/**
 * 异进程组子孙测试 —— 真机形状的复现。
 *
 * 起因（2026-10-01 17:22 抓到的真 bug）
 * ──────────────────────────────────────
 * killer 原来在 `canUseGroup` 分支里**只发组信号**（`kill(-pgid)`），一个逐个信号都不发。
 * 组信号只能打到与宿主同组的进程，而实测 dsh 起的工具进程 **PGID ≠ PPID**：
 *
 *     PID    PPID    PGID    SESS
 *   531931 531931  531931        dsh（组长）
 *   565588 531931  565588 565588 bash ← PGID 就是它自己，不在 dsh 的组里
 *
 * 也就是说 dsh 起的每个工具（bash / pwsh / 后台任务）都在**独立进程组**里，
 * 只发组信号会把它们全漏掉 —— 漏掉的当场就变 PPID=1 的孤儿。
 *
 * 为什么上一轮没测出来：`spawnFakeTree` 用 `detached:true` 起假 dsh，它 fork 的子进程
 * **继承** dsh 的进程组，于是全落在组杀的覆盖范围内，异组这种形状压根没被造出来过。
 *
 * 这组用例固定住「异组子孙也必须死干净」这条不变量。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { killTree, readProcTable, isAlive } from '../killer.js'

const IDLE = 'setInterval(() => {}, 1000)'

/**
 * 造一棵**异组**的假树：组长 dsh + 一个 detached（自成组）的子孙。
 * 形状与真机一致：子孙 PPID 挂在 dsh 下，但 PGID 是它自己。
 */
function spawnMixedGroupTree(dir) {
  const kidScript = join(dir, 'own-group.cjs')
  writeFileSync(kidScript, IDLE)
  const script = join(dir, 'fake-dsh.cjs')
  writeFileSync(script, [
    "const { spawn } = require('node:child_process')",
    `const kidScript = ${JSON.stringify(kidScript)}`,
    // detached:true → 这个子孙自己开进程组，PPID 是 dsh，PGID 是自己。
    // 这正是真机上 bash 工具的形状。
    'const k = spawn(process.execPath, [kidScript], { detached: true, stdio: "ignore" })',
    'k.unref()',
    "process.stdout.write(JSON.stringify({ pid: process.pid, ownGroupKid: k.pid }) + '\\n')",
    IDLE,
  ].join('\n'))

  const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('fake dsh 启动超时')), 10000)
    child.stdout.on('data', (d) => {
      buf += d.toString()
      if (!buf.includes('\n')) return
      clearTimeout(timer)
      const info = JSON.parse(buf.trim().split('\n')[0])
      resolve({ ...info, dir })
    })
    child.on('error', reject)
  })
}

test('子孙在独立进程组时也必须被杀干净（组信号够不到的那部分）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kill-switch-owngroup-'))
  const fake = await spawnMixedGroupTree(dir)
  t.after(() => {
    for (const pid of [fake.pid, fake.ownGroupKid]) { try { process.kill(pid, 'SIGKILL') } catch {} }
    rmSync(dir, { recursive: true, force: true })
  })

  // 前置：确认这棵树的形状确实是「异组」，否则这个用例证明不了任何东西
  const table = readProcTable()
  const leader = table.get(fake.pid)
  const kid = table.get(fake.ownGroupKid)
  assert.equal(leader.pgid, fake.pid, '假 dsh 应是组长（与真机一致）')
  assert.equal(kid.ppid, fake.pid, '子孙的父应是 dsh')
  assert.notEqual(kid.pgid, leader.pgid, '子孙必须自成进程组 —— 否则本用例就退化成同组的老形状')
  assert.equal(isAlive(fake.ownGroupKid), true, '子孙起始应存活')

  const result = await killTree({ targetPid: fake.pid, mode: 'term', scope: 'tree', graceMs: 1500 })

  assert.equal(result.ok, true, `终止应成功，survivors=${JSON.stringify(result.survivors)}`)
  assert.deepEqual(result.survivors, [], '不应留下任何进程 —— 包括异组的那个')
  assert.equal(result.targetGone, true, 'dsh 应已消失')
  assert.equal(
    isAlive(fake.ownGroupKid), false,
    `异进程组的子孙 ${fake.ownGroupKid} 必须被杀干净；它变孤儿正是 v2.0.1 之前的组杀分支的漏网`,
  )
  // 逐个补刀必须真的发生过（组信号覆盖不到它）
  assert.ok(
    result.signalled.includes(fake.ownGroupKid) || result.escalated.includes(fake.ownGroupKid),
    `回执应留下对 pid ${fake.ownGroupKid} 的逐个投递记录，实际 signalled=${JSON.stringify(result.signalled)} escalated=${JSON.stringify(result.escalated)}`,
  )
})

test('SIGKILL 模式同样覆盖异组子孙', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kill-switch-owngroup-k-'))
  const fake = await spawnMixedGroupTree(dir)
  t.after(() => {
    for (const pid of [fake.pid, fake.ownGroupKid]) { try { process.kill(pid, 'SIGKILL') } catch {} }
    rmSync(dir, { recursive: true, force: true })
  })

  const table = readProcTable()
  assert.notEqual(table.get(fake.ownGroupKid).pgid, table.get(fake.pid).pgid, '前置：子孙异组')

  const result = await killTree({ targetPid: fake.pid, mode: 'kill', scope: 'tree' })

  assert.equal(result.ok, true, `survivors=${JSON.stringify(result.survivors)}`)
  assert.equal(isAlive(fake.ownGroupKid), false, '异组子孙在 SIGKILL 模式下也必须死')
  assert.equal(isAlive(fake.pid), false)
})
