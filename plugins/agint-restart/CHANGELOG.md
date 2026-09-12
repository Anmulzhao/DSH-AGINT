# Changelog — agint-restart

> 所有破环性变更必须写入本文件。变更流程：marker 文件格式 / brand 前缀 / 消息内容修改走 L0 治理（人类多签 + 7 天影子 + major 版本），其它按 semver。

---

## v0.8.2 — 2026-09-12 — 首挂 preset：让模型面能用 restart_request / restart_status / restart_cancel

**背景**：v0.8.1 插件本体已挂载（cordis.patch.yml 含 26 个 agint-* 段），`agint.restart.{request, status, cancel}` host service 在跑，但 `presets/agint/agent.cordis.yml` 没挂 `agint-restart-tools` row —— 模型面没有 `restart_request` / `restart_status` / `restart_cancel` 这三个工具，只能调 host service。

**改动**：

- `presets/agint/agent.cordis.yml` 末尾追加 9 行：
  - `- id: agint-restart-tools`
  - `  name: ../../profiles/web/plugins/agint-restart/lib/tools.js`
  - 含工具说明（restart_status read-only / restart_request+restart_cancel ASK-gated）
  - 平台分流注释（Windows 走 PowerShell runbook）
- 本次 **未改** `lib/`（plugin 本体代码）—— 故 `package.json` / `manifest.json` 不动。
- `cordis.patch.yml` 已含 `agint-restart` 段，不需重挂。

**为什么不算 v0.9.0（major）**：本插件 L0 治理字段（marker 文件格式 / brand 前缀 `[agint-restart]` / 通知文案）本次未动；preset 是配置层（model 平面），非 plugin 契约层。

**生效路径**（AGENTS.md 红线）：

1. `bin/plugin-check.sh --all` —— 验 9 维度（preset 不属于 plugin lint 范围，仅 syntax 校验）
2. `bin/safe-update.sh smoke` —— 当前 prod 基线
3. `bin/safe-update.sh mount-patch` —— 拍 4 份快照（patch / preset / plugins tar / storages）
4. 编辑 `/dsh/.agent-presets/agint/agent.cordis.yml` 加同样 9 行
5. `bin/restart-runbook.ps1`（PowerShell，**不是** `safe-update.sh restart`，那个会因 mingw 缺 pgrep 失败）
6. `restart_status` 工具可见 + 插件无回归

**回滚**：`bin/safe-update.sh rollback <TS>` 倒序回滚 patch+preset。

**测试**：

- `restart_status` 工具可见（preset row 加载成功）
- `restart_request` 仍受 confirm 必填 + cooldown(60s) + burst(3次/600s) 三重护栏（不变）
- 代码指纹（v0.8.1）在 `restart_status` 输出面仍可见

---

## v0.8.1 — 2026-09-11 — 补救：代码指纹必须出现在 restart_status 的输出面上

**背景（真机验收时发现）**：v0.8.0 激活后 `marker.json.codeFingerprint`、日志、契约字段都对了，
但**调用 `restart_status` 看不到它**——`lib/tools.js` 的 `render` 是手写字段子集（`tools.js:65-68`）。
数据在、面上没有 = 白造；这与本项目"静默失效"（空 catch + 表象正常但数据恒为 0）是同一类亏。

**改动（`lib/tools.js`）**：render 增加一行——
`code=<指纹>（与磁盘一致）`；stale 时 `code=<指纹>  ⚠️ 磁盘代码已改、进程里仍是旧版 → 需重启生效`；
指纹算不出时显示 `未知`（不静默留空）。

**测试**：新增 Case 34「restart_status 渲染必须带出代码指纹与 stale 警告」——把 `defineTool` 换成直通桩，
直接拿注册到的定义调 `render()`，断言三种形态（正常 / stale / 未知）都符合预期。smoke **41/41**。
（这条用例本身就是护栏：以后谁把 render 改回手写子集，它立刻红。）

**注**：render 改动属于"输出面"，需要一次重启（或 HMR re-apply）才生效；纯数据面（status()/marker/契约）
在 v0.8.0 已是好的。

---

## v0.8.0 — 2026-09-11 — 代码指纹：一眼确认跑的是哪版代码（"要不要重启"从推断变事实）

**来源**：老板决定实施提案 `0370b47f`。动因是同一晚重复踩了 3 次同一个坑——改完插件无法一眼确认
"跑着的进程到底是哪版代码"，只能靠间接指纹推断（marker 有没有被重新 apply 重写、日志里有没有该版本
独有的行、或手动 import host 文件比对），而"HMR 到底有没有重载"一直没有确定答案。

**改动**：

- 新增 `lib/fingerprint.js`：`codeFingerprint(dir)` 对目录下 `*.js` 按**文件名字典序**逐个 sha256，
  再对 `文件名\0哈希\0` 序列做一次 sha256 取前 12 位；纯函数、只读、**绝不抛**（出错返回 `null`）。
  另有 `fingerprintChanged(a, b)`：`null` 与 `null` 视为相同（算不出来时不下"变了"的结论）。
- `apply()` 时算一次并：① 写进 `marker.json.codeFingerprint`；② 打日志
  `code fingerprint <fp>（上一版 <old>）— 本次加载了新代码` / `（与上一版相同）`。
- `status()` 新增两个字段：`codeFingerprint`（apply 时那份，不随磁盘变化）、`codeStale`
  （**每次调用都重新算磁盘指纹并对比**；`true` = 磁盘改过、进程里仍是旧代码 → 需重启或等 HMR）。
  首次观察到 stale 时打一条 `host code changed since apply (旧 → 新) — 进程里仍是旧代码，需重启（或等 HMR）才生效`，之后不再刷屏。
- 测试钩子 `AGINT_RESTART_CODE_DIR`：可把"代码目录"指到别处的同名 lib 目录（smoke 用它模拟"磁盘被改过"，
  不必污染真实源码）。
- `lib/contract.js` 登记 `codeFingerprint` / `codeStale`（字段表漏登记会被 Case 25/30 判漂移）。

**验证**：`node test/smoke.mjs` **40/40**（新增 Case 32 纯函数 / Case 33 接线+stale）、`lib/detect.test.js` 12/12、
`test/pending-notice.test.mjs` 8/8；`JSON.parse` + `cordis.patch.yml` YAML 双校验。
**变异验证**：把 `codeStale` 写死成 `false` → **只有 Case 33 转红**（39/40），还原即绿。

**收益**：改完插件后"生效了吗"从 3 步推断变成一次 `restart_status` 调用；顺带回答"HMR 是否重载"；
减少为"确认是否生效"而发的无效重启。

---

## v0.7.2 — 2026-09-11 — 去重：同一次 boot 只投一次恢复通知

**背景（真机观察 n=2）**：v0.7.1 上线后第一次重启（`8f7ffbda` → pid 31304）实测**收到两条**相同通知
（第二条排队到下一轮 turn 才投出来）；同一次 boot 的日志里也是两条 `notice delivered`。

**真因**：同一个 boot 上有两条投递路径，各自独立成功——

1. `agent/session-start` → `tryFlushPending(agent)`：投出落盘通知（`matched=pending`）并 `clearPending()`；
2. `ctx.inject(['agents'])` 回调里的 boot 轮询 → `deliver(found)`：随后再投一次（`matched=lastSession`），
   此时 `clearPending()` 已成空操作。

危害不只是"看着烦"：`wake` 模式下等于**双唤醒**——被唤醒两次的会话面对的是同一批上下文指令，
把重启环（`restart-loop-incident-20260910.md`）的暴露面翻倍。

**改动（`lib/index.js`）**：新增 `deliveredForBoot` 去重位——`deliverTo()` 入口先判，
**投递成功才置位**（失败仍可在窗口内重试，不会把通知卡死）。

**测试**：`test/pending-notice.test.mjs` 新增回归用例「同一次 boot 只投一次：补投成功后 boot 轮询不得再投」
（等 ≥2 个 POLL 周期断言仍只有 1 条）；源码护栏加 `deliveredForBoot` 断言。

**顺带修复（同类教训）**：v0.7.1 提交里 `manifest.json` 的 description 混入了未转义的**直引号** →
JSON 非法，smoke 的两个 manifest 维度用例当场 parse 失败。已换成「」，并固化规矩：
**改 manifest.json 后必须跑一次 `JSON.parse` 校验**（与「改 cordis.patch.yml 后必须跑 YAML 解析」并列）。

---

## v0.7.1 — 2026-09-11 — 断环：注入文案退化为纯状态「已重启」

**背景（老板拍板）**：「其实重启后注入 已重启 就行了」——针对 2026-09-10 的重启环事故
（`restart-loop-incident-20260910.md`：19:55 与 20:20 两次重启，reason 字符串一字不差）。

**性质**：v0.6.1 的断环手段本身是**新的风险源**。它选择「照常投递 + 文案明示"不需要再次重启"」，
把机制保证退化成"依赖模型读到文案后自觉"；而文案里同时还有
「如需继续之前的工作，或启动新任务，请自主决定下一步」这种**指令性**措辞——
一条状态消息因此被读成工作指令，被唤醒的会话顺手把上下文里**未完成的老板旧指令**又执行了一遍。

**改动（`lib/detect.js`）**：

- `buildNotice()` 只产出 `[agint-restart] DSH 已重启。`（+ 可选的配置 `notice`）。
- 移除：中断时长、上次运行/本次启动时间、重启前最近活跃会话 id、自触发说明、结尾的行动号召。
  这些细节各有落点，不需要挤进注入消息：`restart_status().lastRestart`、`wake.log`、`restart-history.json`。
- `selfRestart` 参数保留但**不再影响文本**（自触发与外部重启文案一致），避免"两种文案"再被读出额外含义。

**测试**：`lib/detect.test.js` 与 `test/smoke.mjs` Case 2 / Case 28b 改为**反向断言**——
必须不含 `自主决定下一步`、不含 `不需要再次重启`、不含中断时长与会话 id；
`test/pending-notice.test.mjs` 的补投断言同步改为只认「已重启」且**不得**再带会话 id。

**未做（留给后续决策）**：跨重启的 burst 账本（现熔断只统计同进程生命周期，跨重启必重置）
与「同 reason 短窗口二次重启需 override」的机制护栏，已作为提案
`1e8f7292-88b9-4994-9070-6030e320f00f` 记录（本版先不动机制，只削文案）。

**回滚**：`cp` 回 `~/.dsh/profiles/web/plugins/agint-restart/lib/detect.js` 旧版即可（快照见
`~/.dsh/.agint-backups/agint-plugins-<TS>.tar.gz`）。

---

## v0.7.0 — 2026-09-11 — 修正：重启后恢复通知被丢弃（落盘待投 + 会话起来补投）

**背景（老板反馈）**：「现在的 dsh 重启后不注入消息，且容易出现历史加载错误」

**性质**：v0.6.1 只解决了"自触发重启被吞掉"这一半；另一半根因在 dsh 侧，之前没看穿。

**真因（读 dsh 源码确认，三级证据链）**：

1. `dsh-agent/lib/index.js`：`agents.get / list / roots` 读的都是**运行时注册表** `store`，
   只装**内存里活着的 agent**；硬盘上的历史会话不算。
2. `dsh-agent-loop/lib/index.js:1716`：`sessions.enter` → `agents.announce(agent)` →
   `agent/session-start`，只在 `publish()` 被调用时发生，而 publish 由
   `dsh-api-gateway` 的**客户端连接**驱动。
3. dsh **没有**"启动时自动恢复上次会话"的机制。

→ 重启那一刻若老板还没用**新 token 的 URL** 连上来，内存池就是空的，`findTarget()`
必然落空。v0.6.x 的行为是"等 5 秒 → 等 20 秒 → 放弃丢弃"，表现就是**重启后不注入消息**。
实测对照：19:47 那次池空失败（`no target agent found after wait`），19:55 那次池里有会话成功。

**"历史加载错误"同源**：token 每次重启都换，旧页面连不上新实例 → 既加载不了历史，
也不会把会话载入内存 → 插件无处可投。已排除会话文件损坏（4 个会话多帧解压 0 失败）。

**改动**：

- 重启后**先把通知落盘**到 `.agint-restart/pending-notice.json`，投递成功才删除。
  即便 `agents` 服务压根没就绪（连回调都不执行），通知也已安全躺在磁盘上。
- 复用已有的 `agent/session-start` 监听：**任一会话被打开时补投**并删除落盘副本。
- 新增配置：`parkNoticeOnNoTarget`（默认 true，置 false 退回旧行为）、
  `pendingOnlyLastSession`（默认 false = 任一会话都投；true = 只认重启前那个）。
- `status()` 新增 `parkedNotice` 字段（契约表已登记），便于排查"还压着没送出去吗"。
- 日志指纹：`notice parked at …` / `parked notice flushed to …`。

**验证**：`test/smoke.mjs` 38/38 PASS；新增 `test/pending-notice.test.mjs` 7/7 PASS
（落盘 / 补投 / 防重复 / 关闭开关 / 只认旧会话 / 非重启不落盘 / 源码护栏）。repo + host 双端一致。

**回滚**：配置 `parkNoticeOnNoTarget: false` 即回到 v0.6.x 行为，不用换代码。

---

## v0.6.1 — 2026-09-11 — 修正：重启后恢复通知发不出去，会话不接续

**背景（老板反馈）**：「现在重启没问题了，但是重启后不注入信息，会话没接续」

**性质**：v0.5.0「断环」设计过头，把正常投递一并掐死。属于**设计事故**，不是新 bug。

### 根因：两道闸门同时咬人

1. **`resumeOnSelfRestart: false`（默认）**
   `detectSelfRestart()` 的判据是"这次启动是不是留下了 `restart-request.json`，
   且 `targetPid` 对得上"——也就是"**这次重启是不是经插件协议发起的**"。
   而 agent 自己调 `restart_request`、外部按协议发起，**都会留请求文件**，
   于是"自触发"实际覆盖了**几乎所有重启**。默认不投 = 恢复通知几乎永远发不出去。
   实测：老板让 agent 重启并要求"重启完成后向我问好"，
   日志只有 `self-initiated restart (request=dfc694c3) skip resume notice`，消息被吞。

2. **`notifyDebounceMs: 300000`（5 分钟）**
   随后另一次重启（`fb49611e`）被这道闸挡下：
   `restart detected but within debounce window (300000ms), skip notice (downtime=100131ms)`。
   100 秒 < 300 秒 → 不投。

### 修法：把断环从"不投递"改成"投递 + 文案明示"

| 项 | 旧 | 新 |
|---|---|---|
| `resumeOnSelfRestart` | `false` | **`true`** |
| `notifyDebounceMs` | `300000` | **`60000`** |
| 自触发时的通知文案 | —（不投） | 附「本次重启由本会话先前发起，现已完成——不需要再次重启。」 |

- 断环不再依赖"不投递"，改由 **通知文案明示** + `restart_request` 已有的
  **burst 熔断**（`burstWindowMs` 内 `burstMax` 次即拒）承担——环最多跑满就被熔断。
- `notifyDebounceMs` 只保留"挡住刚起来又被拉起"的抖动功能。
- `resumeOnSelfRestart: false` 仍可显式配置，用于退回旧行为。

### 测试

- Case 28 重写：自触发**默认必须投递**（并校验 wake.log）；外部重启照常投递；
  显式 `false` 时不投。
- 新增 Case 28b：`buildNotice({selfRestart:true})` 必须含"不需要再次重启"，
  `false` 时不得含（避免对外部中断产生歧义）。
- Case 31 契约断言反转：`notifyDebounceMs` 必须 ∈(0,120000]，
  并新增 `resumeOnSelfRestart` 默认必须为 `true` 的断言。
- 变异验证：默认值改回 `false` → 契约用例 + 端到端用例双双变红，确认非摆设。
- 冒烟 38/38。

---

## v0.6.0 — 2026-09-11 — 修 win32「每调一次工具弹一次黑框」

**背景（老板反馈）**：「我发现 dsh 每次调工具都会弹一次」

**性质**：这是 **v0.2.0 主动重启引入的回归**，不是新问题。

### 根因

dsh 的 Windows 沙箱 `dsh-sandbox-windows-acl` 在源码里**刻意不设控制台隔离**：

> Console isolation (CREATE_NO_WINDOW / CREATE_NEW_CONSOLE) is **intentionally absent** …
> **the child shares the host console.** (`lib/types/spawn.d.ts`)

也就是说，dsh 的一切子进程（沙箱进程、node-pty 辅助进程、pwsh 工具）都假设
"**宿主 dsh 自己有一个控制台**"，它们共享它、不新建窗口。

而 v0.2.0 的 `respawn.js` 用 `detached: true` + `windowsHide: true` 拉起新 dsh——
这两个选项在 Windows 上分别对应 DETACHED_PROCESS 和 CREATE_NO_WINDOW，
**都不给进程控制台**。于是新 dsh 成了无控制台的孤儿，它每 spawn 一个子进程，
Windows 就给那个子进程新建一个控制台窗口 → **每调一次工具弹一次黑框**。

从终端手动跑 `dsh web` 时不会出现（继承终端控制台），只有被 respawn 拉起后才出现。

### 证据

1. 运行中的 dsh 进程父进程已退出、名下无任何 `conhost.exe`（= 无控制台）；
   而它 spawn 的 powershell 子进程名下**有** `conhost.exe`（= 子进程新建了窗口）。
2. 对照实验（探针进程 + 检查 conhost 归属）：

   | 启动方式 | 探针自己的控制台 | 探针的子进程 |
   |---|---|---|
   | `detached:true` + `windowsHide:true`（旧做法） | 无 | **新建控制台 → 弹窗** |
   | WScript 隐藏窗口（新做法） | 有（不可见） | 共享，**不弹** |

3. 日志里 `node-pty/lib/conpty_console_list_agent.js` 的 `AttachConsole failed` 崩溃栈
   是同一根因的旁证（其辅助进程被 fork 时也在新建控制台）。

### 修复

win32 分支改走 `WScript.Shell.Run(cmd, 0, False)`：窗口风格 `0` = SW_HIDE
（窗口不可见，但进程**真的分配到了控制台**），`False` = 不等待。中间包一层
`respawn-launch.cmd` 接管输出重定向（`Run` 本身不支持重定向）。
Node 的 `spawn` 表达不出"窗口不可见但控制台存在"这个语义，所以必须借一层 WScript。

- 新增 `launchHiddenWin32()` / `launchDetachedPosix()`（按平台分发）
- 新增 `findListenerPid()`：壳进程（wscript）不是 dsh，就绪后用 `netstat -ano`
  反查真实 dsh pid 写入 `result.newPid`，壳 pid 另存 `result.launchShellPid`
- POSIX 行为不变（无控制台概念，仍是纯 detached spawn）
- 新增 Case 31 护栏：静态断言 win32 路径必须走隐藏启动、不得出现 `detached:true`，
  且 POSIX 分支仍保留 detached（已做变异验证：改坏即变红）

### 验证

端到端跑真实 `respawn.js` 拉起一个模拟进程（带端口监听 + console 子进程）：
`ok=true`、`newPid` 反查正确、**子进程未新建控制台**。

---

## v0.5.0 — 2026-09-11 — 防弹窗 + 断环

**背景（老板反馈）**：「重启插件不停的造成弹窗，是循环注入吗」

**排查结论**：不是循环注入（机械层面已排除），但有两个真实问题。

### 一、每次重启自动弹一次浏览器（真 bug）

`dsh web` 的 `openBrowser` 默认 `true`（`dsh-web-app: handoffBrowser`），
插件原样快照老板的启动参数（`[...bin.js, web]`）→ respawn 每次拉起都走一次 `openBrowser(url)`。

证据：`dsh-web.log` 里 `opening the default browser; pass --no-open to disable`
**出现 16 次 = 16 次重启 = 16 次弹浏览器**。

**修**：新增 `openBrowserOnRestart: false`（默认）→ `normalizeLaunch()` 给 `dsh web` 补 `--no-open`。
只在确实是 `web` 子命令时动手；已显式带 `--no-open` / `--open[=x]` 的一律不碰。
入口 URL/token 仍打印在新实例日志里，需要时手动开。

### 二、自维持的重启环（设计缺陷，不是注入环）

`mode: wake` + 通知文案「请自主决定下一步」+ agent 手上就有 `restart_request` 工具，
三者组合成闭环：**通知唤醒 agent → agent 接着干活 → 干完为加载改动调 restart_request → 重启 → 又投通知 → …**

证据（会话 `session-179dc25d`）：16:05:40 收到通知 → 16:05:44 开始调工具 → 16:08:27 查状态
→ 16:08:34 调 `restart_request`。94 分钟内这样滚了 16 次重启。
当时唯一刹住它的是 300s 抖动窗口（那一轮 boot 被判 215s < 300s 抑制了）。

**修**：新增 `resumeOnSelfRestart: false`（默认）→ 由插件自己发起的重启**不再投递恢复通知**。
判据（`detectSelfRestart()`，两条都满足才算自触发）：
1. 请求文件的 `targetPid` === marker 里上次启动进程的 pid
2. 请求时间晚于上次启动时间（排除陈旧残留文件）

外部重启（老板手动 / 崩溃）**不受影响，照常投递**——否则真正的中断会被吞掉。
想恢复旧行为配 `resumeOnSelfRestart: true`。

### 其它

- `status()` / `detect()` 新增 `selfRestart` / `selfRestartRequestId`，排查时一眼看出这次重启是谁发起的
- 修掉 `cordis.patch.yml` 模板里 **重复的 `shutdownDelayMs` 键**（v0.4.3 引入，YAML 直接报
  `duplicated mapping key (83:9)`，该文件不参与 dsh 加载所以一直没暴露）
- 测试 31 → 34：新增 `normalizeLaunch` / `detectSelfRestart` / 「自触发不投递、外部照常投递」端到端
- 变异验证：把补 `--no-open` 短路掉 → Case 32 变红；把自触发抑制短路掉 → Case 34 变红

### 排查中排除的假设（记录以免重复劳动）

- **不是循环注入**：`dsh-web.log` 12 条 `notice delivered` 对应 12 次真实重启；
  逐帧解压全部 142 个会话文件，每个会话 1-3 条通知，与会话被重启命中的次数一致
- **不是控制台黑框**：`dsh-subprocess-local` 对 win32 显式 `windowsHide: true`，dsh 的子进程不创建控制台窗口
- **不是前端桌面通知**：前端 bundle 里没有 `new Notification` / `requestPermission`

---

## v0.4.4 — 2026-09-10 — 修「报错但重启已经发生」：输出契约单一事实源

**事故（实测复现）**：重启一次，工具返回的是

```
Error: tool "restart_request" returned invalid output:
  missing required property "value.code"; missing required property "value.plan"
```

但 `restart.log` 显示那次调用**全部成功**：请求文件已写 → 守护脚本已拉起 → 旧进程
2640 优雅退出（2.9s）→ 端口释放 → 新进程 7196 就绪。调用方（模型）只看到 Error。

**根因**：工具 output schema 是 `additionalProperties: false` + 逐字段 `required: true`
的严格校验，而 `accepted: true` 分支的**手写返回字面量漏了 `code`**（`plan` 是 v0.4.2
手工补的 null——同一类补丁式修法）。schema 校验发生在返回阶段，此时副作用已不可回滚。

**为什么旧测试没拦住**：Case 25 用正则抠 `accepted: true` 返回字面量：

```js
idxSrc.match(/return \{[\s\S]*?accepted: true,[\s\S]*?\};/)
```

`[\s\S]*?` 从**更早的** `return {`（manual / deny 分支）开始匹配，把别处的 `code`
也算进了检查区间 → 断言假绿。Case 23/24 只覆盖 smoke 能触发的分支，碰不到 accepted。

**改法（结构上消除这一类 bug，而不是再补一个字面量）**：

- 新增 **`lib/contract.js`**：字段表（key + DSL + fallback）→ 生成 schema
  + `*Result()` 各分支构造函数 + `normalize*Output()` 兜底。schema 与返回值绑在同一张表上。
- `lib/tools.js`：三个工具的 schema 全部改为 `*OutputSchema()` 生成；`execute` 加
  try/catch，**绝不抛异常**；结果一律过 `normalize*Output`。
- `lib/index.js`：`request()` 拆成 `requestInner` + 包装层，包装层把任何异常翻译成
  schema 合法的返回；返回值全部走 `requestAccepted/requestDryRun/requestManual/requestDeny`。
- **新增 `sideEffect` 字段**：本次调用是否真的推进了重启链路（保证"看到异常时"能判断
  要不要重试）。`internal-error` 按已完成的步骤如实标注 + 在 message 里写清可否安全重试。
- 顺带修同类漂移：`restart_cancel` 的 `no-pending` 分支漏了 `requestId`（schema required）；
  `spawn-failed` 分支此前没说"请求文件已写入但不会重启"。

**测试重写（Case 23/24/25 → 4 条契约用例）**：实现一个**真 schema 校验器**
（required / type / oneOf / items / additionalProperties），逐个校验每个分支产物
——包括 smoke 跑不了的 `accepted=true`（改用构造函数造样本）。断言：
① 每个产物通过 schema 全量校验；② 构造函数产物"零修复"（normalize 不改一个字段）；
③ `status()` / `cancel()` / 各 guard 分支真实返回值零修复；④ 静态守卫：tools.js 不得
再手写 output schema、index.js 不得再手写 `accepted: true/false` 字面量。

**变异验证**：把 `contract.requestAccepted()` 的 `code: 'scheduled'` 改名后立刻变红
（`$.code: 缺 required 字段` + `requestAccepted 缺 schema 必填字段`），恢复即绿。
`node test/smoke.mjs` → **31/31 pass，exitCode 0**。

**⚠️ 生效条件**：改的是 `lib/`，必须重启 DSH 才加载新代码（见 AGENTS.md「仓库 ≠ host
加载点」+ 重启红线）；host 副本需与仓库哈希一致。

---

## v0.4.3 — 2026-09-10 — 缩短重启等待 + 抖动窗口扩到 5 分钟

**老板反馈两条**：① 重启等待时间要缩短；② 通知还是"隔几秒弹一次"。

**① 重启等待：实测 25 秒，能压的只有前后约 3.5 秒**

拆解（restart.log 实测，四次重启高度一致）：

| 阶段 | 耗时 | 能否压缩 |
|---|---|---|
| 发出请求 → 旧进程退出 | 4.6s | ✅ 其中 3s 是插件自己延迟退出 |
| 端口释放 | 0.01s | — |
| 拉起新实例 → 端口就绪 | 20.2s | ❌ **dsh 自身启动耗时，插件管不了** |

改动：

- `shutdownDelayMs`: 3000 → **1500**（省 1.5s）。工具返回值落地不需要 3 秒。
- respawn 轮询间隔：退出 500→200ms、端口 500→200ms、就绪 1000→250ms（省约 1.5-2s）。
  提为 `POLL_EXIT_MS` / `POLL_PORT_MS` / `POLL_READY_MS` 常量，便于以后调。
- 预期总耗时 25s → **约 21-22s**。

**⚠️ 诚实的结论**：剩下 20 秒是 dsh 加载 26 个插件的固有耗时，**不在本插件能力范围内**。
要再快只能优化 dsh 启动链（并行加载 / 延迟加载非关键插件），属于另一个议题。

**② 抖动窗口 60s → 300s**

排查发现 v0.4.0 的窗口方向对但**太窄**。判据是"本次启动时间 − 上次启动时间"，
**包含上次进程的存活时长**。实测老板验证期的重启间隔是 1 分 48 秒 / 11 分 / 9 分 40 秒 /
4 分钟——只有 60s 窗口时全都拦不住，于是"每次重启都弹"，感受就是反复弹。

扩到 5 分钟后：连续验证（几分钟内多次 restart）只弹第一条；正常使用（间隔数小时）照常通知。

**配置显式化**：`notifyDebounceMs` 与 `shutdownDelayMs` 此前只存在于代码 DEFAULTS、
host patch 里没有——现在两者都写进 `cordis.patch.yml`，改参数不用碰代码。

**测试 28 → 30**：新增 **Case 25** 重启耗时契约——断言三个轮询常量 ≤300ms、无裸 `sleep(N)`、
`shutdownDelayMs ≤2000`、`notifyDebounceMs ≥180000`。**变异验证**：把 `POLL_EXIT_MS`
改回 500 后 Case 25 立刻变红，恢复即绿。

**版本号修正**：`package.json` 此前漏升（停在 0.3.1，而 manifest 已 0.4.2），本次统一到 0.4.3。

---

## v0.4.2 — 2026-09-10 — deny/dryRun 返回补齐 schema required 字段（K19 续）

**现象**：v0.4.1 修完 schema 后，`restart_request {confirm:true, dryRun:true}` 仍报：

```
missing required property "value.shutdownInMs"; missing required property "value.targetPid"
```

**真因**：schema 标了 `shutdownInMs: { required: true }` 和 `targetPid: { required: true }`，
但：

1. **`deny()` 工厂**只返回 `{accepted, code, message, ...extra}`——所有拒绝路径
   （needs-confirm / cooldown / tripped / already-pending / write-failed / spawn-failed）都缺
   `requestId` / `shutdownInMs` / `plan` / `targetPid`。
2. **dryRun 分支**虽然手动设了 `requestId` + `plan`，但**没**设 `shutdownInMs` 和 `targetPid`。

schema `required:true` 约束下，字段缺失整个对象会被工具链拒绝——调用方拿不到返回值。

**修法**：
1. `deny()` 默认填 4 个 null：`requestId: null, shutdownInMs: null, plan: null, targetPid: null`
   （额外字段走 `...extra`，仍可覆盖）
2. dryRun 路径补上 `targetPid: payload.targetPid` 和 `shutdownInMs: delayMs`

**测试**：27 → 28。新增 **Case 24**：`index.js request() 返回值包含所有 schema required 字段`。
对每条分支（needs-confirm / cooldown / dryRun / tripped）真值调一遍，断言返回对象
**所有 schema required:true 字段都有 key**（null 也算"含"）。

**变异验证**（v0.4.2）：把 deny 的 4 行 null 默认值删掉，Case 24 立刻变红：

```
✖ index.js request() 返回值包含所有 schema required 字段（防漂移）
AssertionError: needs-confirm 分支返回缺字段 'requestId'
```

恢复后 28/28 绿。

**教训**：和 Case 23 一起——"工具链 + schema"双层断言必须都覆盖。Case 23 验 schema 自身，
Case 24 验 index.js 返回对 schema 的承诺。

---

## v0.4.1 — 2026-09-10 — restart_request output schema 补齐真实返回字段（K19 漂移修复）

**现象**：跑 v0.4.0 重启验证时，调 `restart_request {confirm:true}` 工具链报：

```
invalid output: missing required property "value.code"; missing required property "value.plan";
"value.launch" is not a declared property (additionalProperties: false);
"value.resultFile" is not a declared property (additionalProperties: false)
```

工具调用方**拿不到返回值**——只能看到调用方返回为空对象。

**真因**：`lib/tools.js` 的 `restart_request.output.schema` 漏声明了 `restart.request(...)`
真实会返回的几个字段：

- `launch` — accepted=true 时返回（拉起命令快照）
- `resultFile` — accepted=true 时返回（result.json 路径）
- `command` — manual-mode 时返回（可复制的人工命令）
- `cooldownRemainingMs` — cooldown 被拒时返回
- `count` — tripped 被拒时返回（窗口内次数）

`additionalProperties: false`（K19 严管）下，schema 里没声明的字段在工具链返给调用方时会被
**整个对象拒绝**，调用方啥都拿不到。**v0.2.0 写 schema 时只覆盖了"主路径"7 字段**，
没意识到 `request(...)` 还有 5 个分支字段。

**修法**：补齐 schema 的 `properties`，全部用 `oneOf: [..., {type:'null'}]` 兜空（运行时该字段
缺失就视为 null 不会炸；只有"额外多出来的字段"才会被 additionalProperties:false 拒绝）：

- `launch`: `{ type:'object', additionalProperties:false, properties:{ command, cwd, args } } | null`
- `resultFile`: `string | null`
- `command`: `string | null`
- `cooldownRemainingMs`: `number | null`
- `count`: `number | null`

**测试**：26 → 27。新增 **Case 23**：`restart_request output schema 涵盖真实返回字段（防 K19 漂移）`。
它做两件事：
1. 真值跑 `request({})` / `request({confirm:true})` / `dryRun:true` / `force:true` 触发 4 个
   分支，收集所有返回 key
2. 静态解析 `lib/tools.js` 的 schema，断言"返回 key 集合 ⊆ 声明 key 集合"
3. 另外对 accepted=true 路径专属字段（`launch` / `resultFile`）手动声明——因为不能 smoke 触发
   真重启

**变异验证**（证明测试真在测）：把仓库 `lib/tools.js` 的 `resultFile: { oneOf:... },` 删掉，
Case 23 立刻变红：

```
✖ restart_request output schema 涵盖真实返回字段（防 K19 漂移）
AssertionError: accepted=true 时会返回 'resultFile'，schema 必须声明
```

恢复后全 27/27 绿。

**没破环**：
- ✅ 工具调用方式不变（参数 schema 不动）
- ✅ 服务签名不变（`agint.restart.request(args)` 还是返回同样的对象）
- ✅ schema 补齐只让"返回字段被允许存在"，不会改运行时行为
- ✅ `additionalProperties:false` 仍生效（防未来再添未声明字段）

**教训**（值得写进流程）：**任何 `additionalProperties:false` 的 output schema，
必须用真实返回值跑一遍断言**——不能只看 `execute()` 返回值字段，工具链还会做 schema 校验。
本次漏检是 v0.2.0 写 tools.js 时没跑过 `restart_request {confirm:true}` 真值（那次只测了
`needs-confirm` 拒绝路径）。以后 v0.2 写新插件的 tools.js，smoke 必跑每个返回分支。

---

## v0.4.0 — 2026-09-10 — 抖动窗口：避免老板连续 restart 反复弹通知

**现象**：30 分钟内老板连续 7 次触发主动重启（`restart-history.json` 14:34 / 14:36 / 14:38 /
14:58 / 14:59 / 15:09 / 15:11），每次都因 `process.pid` 变化被插件判为"重启"并向 agent 投递一条
信息性消息——**新会话一打开就连续弹出多条 "[agint-restart] 检测到 DSH 服务已重启"**。

**真因**：v0.3.x 的 `wasRestart` 只看 `marker.pid !== process.pid`，不看"距上次启动多久"。
抖动的连续重启也会被当成"多次重启"投递。

**修法**：新增 `notifyDebounceMs`（默认 60000ms），在 `detect.js` 里抽出纯函数
`shouldNotify({ wasRestart, downtimeMs }, debounceMs)`：

- `downtimeMs < debounceMs` → 抖动（`debounced: true`），跳过投递；
- `downtimeMs >= debounceMs` → 真重启，照常投递；
- `wasRestart=false` 或 `debounceMs <= 0` → 不参与判定。

marker / status / 主动重启链路不受影响——防抖只作用于"是否投递通知"那条分支。

**默认值 `cordis.patch.yml`**：`notifyDebounceMs: 60000`（60 秒）。想关闭设 0。
线上若想"看到每次重启"再设大一些；平时 60s 已够用——人为操作不会 60 秒连点一次。

**测试**：26 → **26**（删 Case 6 默认行为没动，加 `notifyDebounceMs: 0` 关防抖保留原断言；
新增 Case 20/21/22 覆盖抖动判定）。变异（短路 `debounce.debounced`）后 Case 20 立刻变红，
Case 21/22 不变——证明测试真的在测防抖。

**踩坑**：调试时 Case 6 第一次跑挂了——它构造"首次启动 → 二次启动"场景时
`marker.lastBootAt` 距 now 才几百毫秒，被新加的 60s 防抖吃掉了。**正确做法**：测试场景要
"真重启"时显式传 `notifyDebounceMs: 0`，不能依赖默认行为。这是 v0.4.0 唯一的向后兼容点
——其他用例自然兼容。

**没破环**：
- ✅ `wasRestart` / `downtimeMs` 语义未变（其他插件 / wiki 引用这些字段的不受影响）
- ✅ marker 文件格式未变
- ✅ 投递链路 / `deliveryMode` / `resumeLastSession` / `target` 全部不变
- ✅ `agint.restart` 服务四方法签名不变
- ✅ 不在 AGINT L0 治理范围（仅新增配置项 + 新增纯函数）

---

## v0.3.1 — 2026-09-10 — 修正 inject / followup 语义反转（实测打脸）

**现象**：老板选了 `deliveryMode: inject` 并重启，`wake.log` 记 `ok:true`、
`matched:lastSession`、`mode:inject`——一切正常，但 UI 上什么都没有。
扫遍 134 个会话文件，**`agint-restart` 零命中**，消息根本没落盘。

**真因**：v0.3.0 我凭方法名臆断语义，结论**完全反了**。dsh 源码
（`dsh-agent-loop/lib/index.js`）：

```js
send(message, target, wakeup) {
    this.inbox.splice(resolvedTarget, Infinity, 0, [message]);
    if (wakeup) this.wakeDriver(wakingAfterAbort);
}
followup(input) { this.send(input, "next-turn", true); }   // wakeup = TRUE  → 唤醒
inject(input)   { this.send(input, "next-step", false); }  // wakeup = FALSE → 只入收件箱
```

`inject` 是**静默塞入、不唤醒 driver**；`followup` 才是真唤醒。
所以 v0.3.0 里"`inject` = 立即触发 agent 干活"的描述是错的——恰恰相反，
`inject` 会让消息石沉大海。老板按我的错误描述选了 `inject`，等于选了"没人理"。

**修正**：

- 配置项改名并纠正语义：`wake`（= followup，唤醒）/ `silent`（= inject，静默）。
  默认 `wake`。旧名 `queue`→`wake`、`inject`→`silent` 作别名保留，不会炸。
- 源码注释写清 `wakeup=true/false` 的真实含义，附源码位置。
- 线上配置改为 `deliveryMode: wake`。

**教训（值得写进流程）**：**涉及第三方 SDK 的方法语义，必须读源码，不能凭方法名推断。**
这次是"看起来最像的那个词"错了。以后凡是 `followup` / `inject` / `steer` / `send`
这类词，一律先 `sed` 出实现再下结论。

**测试 22 → 23**：新增 Case 19 语义契约用例，直接对 **dsh 源码**断言
`followup` 必须 wakeup=true、`inject` 必须 wakeup=false——dsh 升级导致语义漂移时会自己报警。

---

## v0.3.0 — 2026-09-10 — 修正投递语义：消息回到被中断的会话

**背景**：v0.2.1 起链路是通的（`wake.log` 记 `ok:true`），但老板反馈"没看到消息"。查日志发现
投递目标与重启前会话对不上：marker 记的是 `session-e5459975`，实际投递到 `session-7a352812`。
插件等于只做了一半——通知发了，却没发到需要它的那个会话。

**改动一：投递目标优先匹配 `lastSessionId`**

- 旧逻辑 `findTarget()` 直接取 `roots[0] ?? list()[0]`，**从不匹配 `lastSessionId`**，
  旧会话只要不在列表首位就永远收不到。
- 新逻辑：先按 `lastSessionId` 精确匹配（`pool.find` → `agents.get` 回退），命中即投；
  匹配不到才回退 `target` 规则。新增 `resumeLastSession`（默认 `true`）可关。
- **等待窗口**：重启后 agent 是异步加载的，若第一次只找到回退目标就立即投递，
  `resumeLastSession` 会永远失效。因此新增 `resumeWaitMs`（默认 5000）：窗口期内继续等旧会话，
  超时才接受回退目标。总上限仍是 `MAX_WAIT_MS` 20 秒。

**改动二：`deliveryMode` 取代反直觉的 `wakeup` 布尔**

- 旧语义：`wakeup: true` → `followup`（排队）；`wakeup: false` → `inject`（立即）。**命名与直觉相反**。
- 新增 `deliveryMode: 'queue' | 'inject'`，语义自解释。旧的 `wakeup` 仍解析（兼容），
  但显式 `deliveryMode` 优先级更高，避免升级后行为打架。
- `resolveDeliveryMode()` 已导出，可直接单测。

**可观测性**：`wake.log` 新增 `matched`（`lastSession` / `primary` / `configured`）与 `mode` 字段。
排查时一眼能看出"消息到底投给了谁、走的哪条通道"。

**测试**：19 → 22。新增 Case 16（`resolveDeliveryMode` 8 断言）/ 17（优先回旧会话，
roots 顺序故意让新会话排首位，旧逻辑会投错）/ 18（旧会话缺失回退 + inject 通道）。
**Case 17 已做变异验证**：把优先匹配逻辑短路成 `false` 后用例立刻变红，恢复即绿——
证明测试真在测，不是假通过。

**配置变更**：`cordis.patch.yml` 的 `wakeup: true` 改为 `deliveryMode`（旧的 `wakeup` 仍兼容，可不改）。

**部署决定（老板拍板）**：线上选 **`inject`** —— 重启后 agent 自动续跑被中断的工作，
这才是 `dsh-resume-on-restart` 的原始意图。已知代价：旧会话若中断的是长任务/危险操作，
agent 会自行继续。想改成"先汇报、等我确认"，配 `notice` 加约束语即可，无需改代码。

---

## v0.2.1 — 2026-09-10 — 修复 preset 挂载失败（required:false 致命）

**现象**：挂上 `agint-restart-tools`  preset 行后，agint preset 起不来——新建会话发不了消息，
插件本体却正常（marker/wake.log 都写了，wake.log 报 `no target agent after wait`，
说明插件活着但没有 agent，是 preset 挂了）。

**真因**：`lib/tools.js` 的 `restart_request.parameters` 给可选参数写了 `required: false`。
dsh-tools 的编译期断言（`@deepseek-ai/dsh-tools/lib/index.js`）：

```js
if (Object.hasOwn(task.property, "required") && task.property.required !== true)
  authorError(`${task.path}.required must be true when present`);
```

而 `defineTool()` **内部就会编译**（`parameterSchemaSpecToJsonSchema(options.parameters)`），
所以错误发生在 preset 加载时 → 整条 preset 拒绝挂载。表现跟 K19（漏写 additionalProperties）
一模一样，极易误判。

**修复**：删掉所有 `required: false`——值 schema DSL 里，不写 `required` 就是可选。
编译结果验证：`required: ["confirm"]`，符合预期。

**防再犯**：仓库级护栏 `test/schema-guard.test.mjs` 新增 **K20** 规则——扫描所有
`lib/tools.js`，禁止 `required:false`（注释/字符串内不误报，用掩码实现）。护栏 5/5 通过。

**排查教训（通用）**：
- 插件 marker 写了 ≠ 插件健康，只能说明 `apply()` 跑过；preset 挂没挂要看有没有 agent。
- `wake.log` 的 `no target agent after wait` 是 preset 故障的**强信号**。
- 验证工具 schema 的正确姿势：直接调 `apply(mockCtx)`——`defineTool` 会在内部编译，
  有问题当场抛；不要把编译后的 JSON Schema 再拿去编译（会假报错）。

---

## v0.2.0 — 2026-09-10 — 主动重启能力

**动机**：v0.1.0 只会"重启后通知"，不会"发起重启"。重启 DSH 一直要靠老板手跑
`bin/restart-runbook.ps1`（Git Bash 缺 pgrep/pkill，safe-update restart 会误判并起第二个实例撞端口）。
本次让插件自己完成闭环。

### 新增（Added）

- **执行链**（为什么必须两段式）：正在退出的进程不能自己拉起继任者——旧进程还占着
  3080 时新实例会 EADDRINUSE 直接失败。所以拆成：
  1. 插件写 `restart-request.json`，`detached` 拉起 `lib/respawn.js`，自己延迟退出
  2. `respawn.js`（独立孤儿进程）等旧 pid 消失 → 等 3080 释放（超时可强杀）→ 拉起新 dsh → 等就绪 → 写 `restart-result.json`

- **新文件**：
  - `lib/respawn.js` — 零依赖守护脚本（只用 node 内置模块；不用 shell）
  - `lib/tools.js` — `restart_status` / `restart_request` / `restart_cancel`

- **新服务**：`agint.restart.{detect,status,request,cancel}`，并补上 v0.1.0 欠的
  `agint.restart.detect` 兼容别名（README 原标注"v0.2 加"，本版兑现）

- **启动快照**：apply 时抓取 `process.execPath` / `argv.slice(1)` / `cwd` / 过滤后的 env，
  作为 respawn 的拉起参数；可用 `config.launch` 手工覆盖

### 护栏（Changed / Safety）

| 护栏 | 行为 |
|---|---|
| `confirm:true` 必填 | 工具调用不显式确认就拒绝（防模型/脚本误触中断会话） |
| 冷却期 `cooldownMs`(60s) | 距上次重启不足 60s 拒绝，`force:true` 可绕过 |
| 熔断 `burstWindowMs`(600s)/`burstMax`(3) | 窗口内满 3 次即拒绝，**force 也绕不过**（防重启循环） |
| 单在途请求 | 120s 内已有 pending 则拒绝 |
| `dryRun:true` | 只返回将要执行的计划，不落盘、不拉进程 |
| `mode:'manual'` | 只生成可复制的启动命令，不做任何动作（最保守） |

### 验证

- `node test/smoke.mjs` — 18 用例全过（原 12 + 新增 6）
- 新增用例：service 四方法存在 / 缺 confirm 被拒 / dryRun 不落盘不拉进程 /
  manual 模式返回命令 / 熔断生效 / respawn 脚本 request 校验
- 真机重启验证需老板手工触发（`restart_request {confirm:true}`），本轮未跑

### 红线遵守

- ✅ 不 import 任何 `@deepseek-ai/dsh-*` 内部包
- ✅ 不动 `agint_meta` 域（仍只写 `agint_restart`）
- ✅ 不经过 shell（`spawn` 直接调可执行文件，`permissions.shell` 仍为 `false`）
- ✅ 重启历史只留最近 50 条，不无限增长
- ✅ 首挂 preset 工具行走 safe-update（AGENTS.md 红线），本 patch 未自动挂

---

## v0.1.0 — 2026-09-10 — 首次发版

**思路来源**：借鉴 `nickkkkkk123123/dsh-resume-on-restart@v0.1.0`（GitHub，MIT），scope 1:1 移植。

### 新增（Added）

- **核心能力**：
  - 启动时读 `~/.dsh/.agint-restart/marker.json`，对比 `pid` 判定是否发生重启
  - 写新 marker（pid / lastBootAt / lastSessionId / lastActiveAt）
  - 轮询等待主 agent 出现（最多 20s）→ 投递信息性 user 消息
  - 运行期间通过 `agent/session-start` + `agent/pre-step` 追踪最近活跃会话
  - 优雅关闭走 cordis dispose 钩子（**不**用 SIGTERM 二次 kill）

- **3 个核心文件**（`lib/`）：
  - `detect.js` — 纯函数（`detectRestart` / `buildNotice` / `humanizeDowntime`）
  - `detect.test.js` — 纯函数单测（保留为契约层 + 独立可读参考；沙箱 spawn EPERM 时走 smoke.mjs）
  - `index.js` — Cordis 入口 + marker 持久化 + 投递编排

- **test/smoke.mjs** — 12 用例契约层验证（4 detect + 2 buildNotice + 1 humanize + 1 manifest 8 维度 + 1 红线 + 1 端到端 + 1 跨平台 fixture + 1 优雅 dispose）

- **manifest.json** — PLUGIN-SPEC 8 维度齐全（contract / storage / deps / permissions / lifecycle / tests / docs / changelog）

- **cordis.patch.yml** — loader 模板（**不**自动挂顶层；首次挂载走 `bin/agint-mount.sh new` 或手工 cp 顶层 + safe-update）

### 借鉴取舍

| 借鉴点 | dsh-resume-on-restart | agint-restart |
|---|---|---|
| 持久化目录 | `~/.dsh/.resume-on-restart/` | `~/.dsh/.agint-restart/`（避免命名冲突 + 便于回滚） |
| brand 前缀 | `[resume-on-restart]` | `[agint-restart]` |
| 优雅关闭 | SIGTERM/SIGINT 处理器（**bug**：`process.kill(process.pid, ...)` 二次 kill 自己） | cordis dispose 钩子（一次性注册，cordis 自己负责停机时机） |
| 活动追踪 | 监听 `agent/session-start` + `agent/pre-step` | 1:1 移植 |
| 重启判定 | pid 对比 | 1:1 移植 |
| 信息性消息格式 | 多行文本 | 1:1 移植（brand 改前缀） |
| 投递目标 | `target.followup(msg)` 真唤醒 | 1:1 移植 |
| dormant 状态 | 不存在 | **v0.1.0 默认 enabled**（无需 dormant 设计） |
| Storage 域 | 不存在（用文件） | **`agint_restart` 域**（独占，schemaVersion=1） |
| 端到端 smoke | 不存在 | 12 用例 |
| 8 维度 manifest | 不存在 | 齐全 |
| PLUGIN-SPEC 准入 | 不存在 | 0 fail 0 warn（plugin-check） |

### 红线遵守

- ✅ **不破环** mount-result schema（mount 仓库未改动；v0.7.1-draft 已回退）
- ✅ **不破环** agint_mount 域 schemaVersion=1
- ✅ **不触碰** agint_meta 域（独立 agint_restart 域）
- ✅ **不破坏**既有 26 个插件
- ✅ **不抢 SIGTERM 处理器**（cordis dispose 钩子是更安全的替代）
- ✅ **不 import 任何 `@deepseek-ai/dsh-*` 内部包**（只依赖 cordis ctx 的 `agents` 服务）
- ✅ **不动 host 端 cordis.patch.yml**（loader 模板文件**不**自动挂顶层；首次挂载走 `bin/agint-mount.sh new` 或手工 cp 顶层 + safe-update）
- ✅ **不抢 L0 治理**（marker 文件格式 / brand 前缀 / 消息内容是 plugin 内部约定，**不**在 AGINT L0 治理范围——除非将来要把 marker 提到 DSH 平台层）

### 验证

- ✅ `node test/smoke.mjs` — **12/12 用例契约层验证全过**
  - case 1-4：detectRestart 4 情形
  - case 5-6：buildNotice 完整字段 + 部分字段
  - case 7：humanizeDowntime 秒/分/小时
  - case 8：manifest 8 维度（PLUGIN-SPEC）
  - case 9：红线（storage domains 仅含 agint_restart）
  - case 10：端到端（apply 二次启动触发投递）
  - case 11：跨平台 fixture（dim 5.5）
  - case 12：优雅 dispose 触发持久化
- ✅ plugin-check 0 fail 0 warn
- ⏳ `bin/safe-update.sh restart` — **不跑**（dormant 默认 + 仓库母版 ≠ host 副本，老板决定同步时机）

### 不在本 patch（v0.2 计划）

| 范围 | 责任方 | 备注 |
|---|---|---|
| 加 `agint.restart.detect` service（v0.1.0 没注册） | 下一轮 | 让上层 preset / 主 agent 主动调一次拿 marker 状态 |
| 真实 `shutdownGraceMs` 消费（"距上次活跃 ≤ grace 视为任务相关"） | 下一轮 | v0.1.0 留 manifest 默认值，代码不读 |
| 持久化 marker 到 storageDomain（替代文件） | 下一轮 | 跟 agint-* 兄弟插件对齐；当前用 `writeFileSync` 简单实现 |
| 首次挂载到 host（手工 cp + safe-update） | 老板 | 走 AGINT 红线流程 |

---

*下一步：老板 review 后由 `bin/agint-mount.sh new plugins/agint-restart` 走 lint → 拍快照 → patch → 重启 → smoke 挂载。*
