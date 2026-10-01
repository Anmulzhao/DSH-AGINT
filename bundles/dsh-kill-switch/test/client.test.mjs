#!/usr/bin/env node
/**
 * client.js 契约测试。
 *
 * 为什么只能静态断言：client.js 不是一个可 import 的 ES 模块，它是
 * `window.__ModuleLoader__.load({ id, factory(require) {...} })` 脚本，
 * 直接跑会撞上未定义的 `window`。所以这里读源码，断言它**不再**引用那个
 * 根本不存在的 API —— 这正是 v2.0.0 线上报错的根因。
 *
 * 每条断言都写明取证来源，换环境/换版本时要重新核对来源，不能凭印象改。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const RAW = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/**
 * 只对**代码**做断言：文件头的取证注释里刻意引用了 `ctx.remote`（记录根因），
 * 直接对整份源码 grep 会把那段说明也判成违规。注释不参与执行，剥掉再看。
 * 本文件的注释都是块注释和整行行注释，无嵌套块、无 `//` 出现在字符串里。
 */
const SRC = RAW
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')

/**
 * 取证快照（2026-10-01，cordis_inspect_list platform=client / Slots.listSubTree）。
 * 若 dsh 升级后这几个事实变了，本文件的断言也要跟着重新取证。
 */
const CLIENT_SERVICES = ['layout', 'locale', 'sessions', 'slots', 'theme', 'timer', 'uiWorkspace', 'workspaces']
const SLOT_STANDARD_PROPS = [
  'useResource', 'useWorkspaces', 'usePanelInfo', 'useSessions', 'useSessionStatus',
  'useSessionRetainInfo', 'useChat', 'useConversation', 'useInput', 'inputActions',
  'useSession', 'sessionId', 'useProjection', 'useTrajectory',
]

test('不得再引用 ctx.remote —— 它不是客户端服务（v2.0.0 的线上报错）', () => {
  // 当时的报错：cannot get property "remote.commands" without inject
  assert.doesNotMatch(SRC, /ctx\.remote/, 'client.js 不得再访问 ctx.remote')
  assert.doesNotMatch(SRC, /remote\.commands\.execute/, 'commands.execute 也不是真实 API')

  // inject 声明里也不该再有 remote —— 声明一个不存在服务只会让失败更晚更难懂
  const injectMatch = SRC.match(/inject:\s*\[([^\]]*)\]/)
  assert.ok(injectMatch, '应能读出 inject 声明')
  const declared = injectMatch[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  assert.deepEqual(declared.sort(), ['locale', 'slots'], `inject 应只声明真实存在的服务，实际：${declared}`)
  for (const name of declared) {
    assert.ok(CLIENT_SERVICES.includes(name), `${name} 不在实测的客户端服务清单里`)
  }
})

test('走 InputActions：setDraft + submit，不发明 RPC', () => {
  // InputActions 契约来源：
  // dsh-client-ui-conversation/lib/types/client/contract/input.d.ts
  //   setDraft(text: string): void
  //   submit(): void
  assert.match(SRC, /inputActions\.setDraft\(/, '应通过 setDraft 写入命令草稿')
  assert.match(SRC, /inputActions\.submit\(/, '应通过 submit 触发命令仲裁')
  assert.match(SRC, /function KillButton\(\{\s*inputActions\s*\}\)/, '组件应从 slot 标准 props 取 inputActions')
  assert.doesNotMatch(SRC, /function KillButton\(\{\s*sessionId\s*\}\)/, '不应再以 sessionId 为唯一 prop')
  assert.match(SRC, /'\/kill-dsh'/, '草稿应写入 /kill-dsh')

  // setDraft / submit 都必须走 slot 契约；inputActions 确实是该 slot 的标准 prop
  assert.ok(SLOT_STANDARD_PROPS.includes('inputActions'),
    '取证前提：inputActions 属于 conversation.composer.dock 的 standardProps')
})

test('两步确认的护栏没有被这次修复削掉', () => {
  assert.match(SRC, /ARM_MS = 4000/, '两击之间的武装窗口应保留')
  assert.match(SRC, /phase === 'armed'/, '第二击必须落在 armed 相位上')
  // 卸载/超时要能回到 idle，避免按钮永久停在危险态
  assert.match(SRC, /if \(remaining === 0\) setPhase\('idle'\)/, '倒计时结束应自动解除武装')
})

test('inputActions 缺失时降级为可执行的提示，而不是在点击回调里抛异常', () => {
  assert.match(SRC, /typeof inputActions\.submit !== 'function'/, '应先探测 inputActions 是否可用')
  assert.match(SRC, /setNote\(t\('noComposer'\)\)/, '不可用时应给出手动 /kill-dsh 的指引')
  assert.ok(SRC.includes("noComposer: '该输入框没有可用的输入动作"), '应提供 noComposer 文案')
})

test('文案不再承诺拿到宿主回执', () => {
  // submit() 无返回值，且页面马上要断 —— 声称"已终止"是撒谎，只能说"已提交"
  assert.match(SRC, /sent: '已提交终止/, '中文文案应说明是「已提交」')
  assert.doesNotMatch(SRC, /sent: '已排程终止/, 'v2.0.0 的「已排程」措辞已随通道变更更新')
  // 页面没断 = 命令被拒，这个失败信号必须告诉用户
  assert.match(SRC, /若页面没断/, '必须提示「页面没断即命令被拒」')
})
