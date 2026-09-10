# agint-restart

> AGINT 插件：DSH 重启**闭环** —— 检测重启 + 信息性消息投递（v0.1.0）+ **主动发起重启**（v0.2.0）+ **通知回到被中断的会话**（v0.3.0）+ **不弹窗 / 不断环**（v0.5.0）。
>
> 思路来源（检测部分）：[nickkkkkk123123/dsh-resume-on-restart](https://github.com/nickkkkkk123123/dsh-resume-on-restart)（MIT），scope 1:1。
> 关键差异：优雅关闭走 cordis dispose 钩子（修正上游 SIGTERM 二次 kill bug）；持久化目录 `.agint-restart`；brand 前缀 `[agint-restart]`；v0.2.0 新增两段式自重启 + 三重护栏。

---

## 一句话定义

两件事：

1. **检测**（v0.1.0）：DSH 服务进程级重启后，自动向主 agent 投递一条**信息性消息**（含中断时长、上次活跃会话），由 agent **自主决定**是否继续之前的工作。
2. **重启**（v0.2.0）：提供 `agint.restart` 服务与 `restart_*` 工具，让 agent / 其它插件能**真正把 DSH 拉起来**——不再依赖老板手跑 `restart-runbook.ps1`。
3. **回到原会话**（v0.3.0）：通知优先投回"重启前最近活跃"的那个会话（只有它带着被中断的上下文），
   而不是随便取第一个 agent；投递方式可显式指定 `queue`（排队）或 `inject`（立即触发 agent 干活）。
4. **不弹窗 / 不断环**（v0.5.0）：拉起新实例时补 `--no-open`（不再每次重启弹一次浏览器）；
   自触发重启不再投递恢复通知，切断「通知唤醒 agent → 干活 → 自己重启 → 又通知」的自维持环。

解决"DSH 重启后会话中断、工作丢失"、"重启只能人工执行"以及"通知投错会话"三个问题。

## 特性

- 🔄 **重启检测**：通过 marker 文件（`~/.dsh/.agint-restart/marker.json`，记录上次 pid / 启动时间）判断是否发生重启
- 💬 **信息性消息（v0.7.1 起为纯状态）**：重启后只投递一句「`[agint-restart] DSH 已重启。`」——**不含任何行动指令**。
  中断时长 / 上次活跃会话等细节改看 `restart_status` 的 `lastRestart` 与 `~/.dsh/.agint-restart/wake.log`。
  原因（2026-09-10 重启环复盘）：指令性措辞会把一条状态消息变成工作指令，唤醒后的会话会把上下文里
  未完成的老板旧指令当新指令再执行一遍 → 「唤醒 → 重执行 → 又重启」的自维持环
- 🧭 **代码指纹（v0.8.0）**：`apply()` 时对自身 `lib/*.js` 算聚合 sha256（前 12 位），写进 `marker.json`
  与 `status().codeFingerprint`；`status().codeStale` 每次现算磁盘指纹并对比——**`true` 就是"插件改过、
  但进程里还是旧代码"的事实依据**，不必再靠 marker 时间戳或日志指纹反推"是否已生效 / HMR 有没有重载"
- 🎯 **活动追踪**：运行期间通过 cordis 事件（`agent/session-start`、`agent/pre-step`）追踪最近活跃会话，供重启后参考
- 🎯 **回到原会话（v0.3.0）**：投递时先按 `lastSessionId` 精确匹配旧会话，命中即投；匹配不到才回退 `target`。
  重启后 agent 异步加载，因此留出 `resumeWaitMs`（默认 5 秒）等旧会话出现，避免"第一次只找到新会话就投了"
- 🪝 **优雅关闭**：cordis dispose 钩子持久化最近活跃会话（**不**用 SIGTERM 处理器——避免上游 `process.kill(process.pid, ...)` 二次 kill bug）
- ✅ **兼容 DSH Desktop**：只依赖 cordis ctx 的 `agents` 服务，不 import 任何 `@deepseek-ai/dsh-*` 内部包
- 🔁 **主动重启（v0.2.0）**：`restart_request` 工具 / `agint.restart.request()` 真正重启 DSH
- 🧾 **输出契约（v0.4.4）**：字段表 → schema + 分支构造函数单一事实源（`lib/contract.js`）；
  `request()` 绝不抛异常，返回值带 `sideEffect` 说明副作用是否已发生——消除「报错但其实重启了」
- 🛡️ **三重护栏**：`confirm` 必填 + 冷却期 + 窗口内次数熔断（防误触与重启循环）
- 🧪 **dryRun / manual**：先看计划再执行，或只生成命令交给人工执行
- 🚫 **不弹窗（v0.5.0）**：拉起新实例时给 `dsh web` 补 `--no-open`。
  `dsh web` 默认 `openBrowser=true`，插件每次拉起都会**弹一个新浏览器标签/窗口**；重启是后台行为，不该抢焦点
- ⛔ **不断环（v0.5.0）**：自触发重启不再投递恢复通知。
  否则会形成「通知唤醒 agent → agent 干活 → agent 自己 `restart_request` → 又通知」的自维持重启环
  （2026-09-10 实测：94 分钟内这样滚了 16 次重启）

## 与上游 dsh-resume-on-restart 的差异

| 借鉴点 | dsh-resume-on-restart | agint-restart |
|---|---|---|
| 持久化目录 | `~/.dsh/.resume-on-restart/` | `~/.dsh/.agint-restart/` |
| brand 前缀 | `[resume-on-restart]` | `[agint-restart]` |
| 优雅关闭 | SIGTERM/SIGINT 处理器（**bug**：`process.kill(process.pid, ...)` 二次 kill） | cordis dispose 钩子（一次性注册，cordis 自己负责停机时机） |
| 活动追踪 | 监听 `agent/session-start` + `agent/pre-step` | 同上（1:1 移植） |
| 重启判定 | pid 对比 | 同上（1:1 移植） |
| 信息性消息格式 | 多行文本 | 同上（1:1 移植，brand 改前缀） |
| dormant 状态 | 不存在（plugin 即装即用） | **v0.1.0 默认 enabled**（无需 dormant 设计） |
| 真投递 | `target.followup(msg)` 真唤醒 | 同上（1:1 移植） |

## 安装

```powershell
# 复制 cordis.patch.yml 内容到顶层 profile-patches/web/cordis.patch.yml
# （agint-restart 默认 mountOrder=50，排在 mount 后面）
# 跑 bin/safe-update.sh smoke 验一遍
# 跑 bin/restart-runbook.ps1 重启
```

## 运行逻辑

每次 DSH 启动时：

1. 读取 marker 文件（`~/.dsh/.agint-restart/marker.json`），记录上次的 `pid` / `lastBootAt`
2. 判断是否重启：当前进程 `pid` ≠ marker 的 `pid` → 判定发生重启
3. 写入新的 marker（更新为当前 pid / 时间）
4. 若判定为重启，轮询等待主 agent 出现（最长 20 秒），投递信息性消息：

   ```
   [agint-restart] DSH 已重启。
   ```

   就这一行（v0.7.1 起）。中断时长、上次活跃会话、是否自触发等细节**不进消息体**——
   看 `restart_status`（`lastRestart`）+ `~/.dsh/.agint-restart/wake.log` + `restart-history.json`。

运行期间通过 `agent/session-start` 和 `agent/pre-step` 事件持续记录最近活跃会话，下次重启时消息会包含它。

## 主动重启（v0.2.0）

### 为什么不能"自己拉起自己"

正在退出的进程无法拉起继任者：旧进程还占着 3080 端口时，新实例会直接 `EADDRINUSE` 起不来。所以拆成两段：

```
[插件，在 dsh 进程内]                    [respawn.js，独立孤儿进程]
写 restart-request.json
  ↓
detached spawn lib/respawn.js
  ↓
延迟 shutdownDelayMs 后自己退出 ──────→  等旧 pid 消失（waitExitMs，超时强杀）
                                          ↓
                                        等 3080 端口释放（portFreeTimeoutMs）
                                          ↓
                                        拉起新 dsh web（复现启动时的 command/args/cwd/env）
                                        · win32：借 WScript 隐藏窗口启动，目的是让新 dsh
                                          拿到一个「不可见的控制台」——详见下方「坑」
                                          ↓
                                        等就绪（sentinel.lease 被刷新 或 端口可连）
                                          ↓
                                        写 restart-result.json + restart.log
```

`respawn.js` 是 detached + unref 的独立进程，父进程（dsh）死后变孤儿继续跑，不受影响。它只用 node 内置模块；**POSIX 上不经 shell**（纯 detached spawn）。

### 坑（v0.6.0 修）：新 dsh 必须有一个控制台，否则每调一次工具弹一次黑框

dsh 的 Windows 沙箱（`dsh-sandbox-windows-acl`）在源码里**刻意不做控制台隔离**，注释原话是
"`the child shares the host console`"——它默认宿主（dsh）自己有一个控制台。

而 `detached: true`（DETACHED_PROCESS）和 `windowsHide: true`（CREATE_NO_WINDOW）**都不会给进程控制台**。
所以旧实现拉起的新 dsh 是无控制台的孤儿，于是它每 spawn 一个子进程（沙箱子进程、node-pty 辅助进程、
pwsh 工具…），Windows 就给那个子进程**新建一个控制台窗口**——表现为"每调一次工具弹一次黑框"。

Node 的 `spawn` 表达不了"窗口不可见但控制台存在"这个语义，所以 win32 路径改走：

```
respawn.js --(wscript.exe)--> respawn-launch.vbs   Run "…\respawn-launch.cmd", 0, False
                               └ 0 = SW_HIDE（窗口不可见，进程仍分配控制台）
                               └ False = 不等待
                                  ↓
                             respawn-launch.cmd      cd /d <cwd> && <dsh 命令> >> <log> 2>&1
                               └ .cmd 只负责输出重定向（VBS 的 Run 不支持重定向）
```

wscript 启动后立即退出；`.cmd` 会一直等到 dsh 结束（它就是控制台的持有者）。
`restart-result.json` 里 `launchShellPid` 是壳进程（wscript）的 pid，`newPid` 是就绪后
用 `netstat -ano` 反查出来的**真实 dsh pid**。

### 怎么触发

```js
// 服务调用
ctx['agint.restart'].request({ confirm: true, reason: '挂载新插件' });

// 工具调用（preset 挂上后模型可见）
restart_request { confirm: true, reason: '挂载新插件' }
restart_status                        // 只读
restart_cancel                        // 清除在途标记
```

### 护栏

| 护栏 | 默认 | 行为 |
|---|---|---|
| `confirm` 必填 | — | 不显式 `confirm:true` 直接拒绝（`force:true` 可绕过） |
| 冷却期 | 60s | 距上次重启不足则拒绝，返回剩余冷却时间 |
| 熔断 | 600s / 3 次 | 窗口内满 3 次拒绝，**force 也绕不过**——专门防重启循环 |
| 单在途请求 | 120s | 已有 pending 则拒绝 |
| `dryRun` | false | 只返回计划，不落盘不拉进程 |
| `mode:'manual'` | auto | 只返回可复制的启动命令，零动作 |

> 熔断是最后一道保险：如果新实例一起就挂、又被自动拉起，最多滚 3 次就停，不会无限重启把机器拖死。

### 输出契约与排障（v0.4.4）

工具的 output schema 是**严格校验**（`additionalProperties: false` + 逐字段 `required`）。
schema 与返回值一旦漂移，工具链会在**副作用已经发生之后**才报错：

```
Error: tool "restart_request" returned invalid output:
  missing required property "value.code"; missing required property "value.plan"
```

⚠️ **看到这类报错，先跑 `restart_status`，不要直接重试**。报错不代表没重启——2026-09-10
实测那次：报错的同时请求文件已写、守护脚本已起、旧进程 3 秒后退出。盲目重试 = 重复重启
（冷却期 60s + 熔断 3 次/600s 是兜底，不是许可）。

v0.4.4 起结构上消除这类漂移：

- 字段表 + schema + 各分支构造函数集中在 **`lib/contract.js`**（单一事实源）；
  `lib/tools.js` 与 `lib/index.js` 不再手写任何输出字段/返回字面量，smoke 有静态守卫兜住。
- `request()` **绝不抛异常**：意外都被翻译成 schema 合法的 `code: 'internal-error'` 返回。
- 返回值新增 **`sideEffect`**（boolean）：本次调用**是否真的推进了重启链路**
  （写请求文件 + 拉起守护脚本 = 进程确定会退出）。护栏拒绝 / dryRun / manual 为 `false`；
  `internal-error` 按实际已完成的步骤判定，并在 `message` 里写清"能不能安全重试"。
- 万一将来还有分支漏字段，`normalize*Output` 会补默认值、丢弃未声明字段，并把
  "补了什么、丢了什么"写进 `message`（不静默修补，避免掩盖 bug）。

### 产物文件（都在 `~/.dsh/.agint-restart/`）

| 文件 | 内容 |
|---|---|
| `marker.json` | v0.1.0 起：pid / lastBootAt / lastSessionId / lastActiveAt |
| `restart-request.json` | 本次重启请求（含拉起命令快照） |
| `restart-result.json` | 守护脚本回写的结果（newPid / ready / 各阶段耗时） |
| `restart-history.json` | 最近 50 条重启记录（熔断与冷却的依据） |
| `restart.log` | 人类可读的追加日志 |
| `pending-notice.json` | **v0.7.0 起**：还压着没送出去的恢复通知（落盘待投），送达后删除 |

### 落盘待投（v0.7.0）：为什么重启后消息可能"晚到"而不是"不到"

dsh 的 `agents` 注册表只装**内存里活着的 agent**（`dsh-agent/lib` 的 `get/list/roots`
读的都是运行时 `store`），而会话只有被客户端（UI/API）打开时才 announce 进注册表
（`dsh-agent-loop` 的 `publish`），**dsh 没有"启动时自动恢复上次会话"的机制**。

所以重启那一刻如果还没人用新 token 的 URL 连上来，内存池就是空的，插件找不到投递目标。
v0.6.x 的行为是等 5~20 秒后**丢弃**通知 —— 这就是"重启后不注入消息"的根因。

v0.7.0 起改为：重启后先把通知**落盘**到 `pending-notice.json`，投递成功才删；
之后**任一会话被打开**时补投。因此恢复通知可能"晚到"（你打开 UI 的那一刻），
但不会再丢。

## 配置（cordis.patch.yml）

| 配置项 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件开关 |
| `stateDir` | `.agint-restart` | marker/状态文件存放目录（相对 DSH_HOME） |
| `target` | `primary` | **回退**目标（`primary`=主 agent，或指定会话 id）；仅在旧会话匹配不到时使用 |
| `deliveryMode` | `wake` | `wake`=followup（`send(next-turn, wakeup=true)`）→ **唤醒 agent 真正干活**；`silent`=inject（`send(next-step, wakeup=false)`）→ 只入收件箱，**不唤醒、看不到回音**。⚠️ 别凭方法名猜：`inject` 是静默塞入，不是立即触发。别名 `queue`→`wake`、`inject`→`silent`。选 `wake` 时旧会话若中断的是长任务/危险操作，agent 会**自行继续**——想先"汇报等我确认"，用 `notice` 加约束语 |
| `resumeLastSession` | `true` | 优先把通知投回"重启前最近活跃的会话"（只有它带着被中断的上下文） |
| `resumeWaitMs` | `5000` | 为"等旧会话复活"额外留的时间；超时就接受回退目标（`0`=不等） |
| `parkNoticeOnNoTarget` | `true` | **v0.7.0**：找不到活 agent 时把通知落盘待投，之后有会话起来再补投。置 `false` 退回 v0.6.x 的"等不到就丢弃" |
| `pendingOnlyLastSession` | `false` | **v0.7.0**：`false`=任一会话起来就补投（保证一打开 UI 就能看到）；`true`=只投给重启前那个会话 |
| `wakeup` | — | **已废弃**，仅为向后兼容保留：`true`→`queue`，`false`→`inject`。显式 `deliveryMode` 优先 |
| `notice` | `''` | 附加到消息末尾的自定义提示 |
| `shutdownGraceMs` | `600000` | 配置项已声明（**v0.1.0 未消费**，跟上游一致） |
| `ignoredSessionPrefixes` | `['head-']` | 不追踪的会话 id 前缀（如多代理团队的根会话） |
| `mode` | `auto` | `auto`=真拉起；`manual`=只给命令 |
| `cooldownMs` | `60000` | 两次重启最小间隔 |
| `burstWindowMs` | `600000` | 熔断统计窗口 |
| `burstMax` | `3` | 窗口内重启次数上限（达到即熔断） |
| `waitExitMs` | `30000` | 等旧进程退出的时间 |
| `forceKillAfterMs` | `20000` | 超时后强杀旧进程（`0`=不强杀） |
| `portFreeTimeoutMs` | `15000` | 等 3080 释放的时间 |
| `readiness.leasePath` | `sentinel.lease` | 就绪判定文件（相对 DSH_HOME） |
| `readiness.port` | `3080` | 就绪判定端口 |
| `readiness.timeoutMs` | `60000` | 就绪等待上限 |
| `logFile` | `%TEMP%/dsh-web.log` | 新实例 stdout/stderr 落盘位置 |
| `exitStrategy` | win32 `exit` / 其它 `signal` | 自己怎么退出（`exit`=`process.exit`，`signal`=发 SIGTERM；win32 无真信号故默认 exit） |
| `shutdownDelayMs` | `1500` | 发请求后延迟多久退出（留出返回值时间）。**这段完全计入用户感知的"重启等待"**，故从 3000 收紧 |
| `notifyDebounceMs` | `300000` | 抖动窗口：相邻两次启动间隔 < 此值则**不投递**通知。判据含"上次进程存活时长"，5 分钟可覆盖连续 restart 验证；`<=0` 关闭 |
| `openBrowserOnRestart` | `false` | v0.5.0：拉起新实例时是否允许它自动打开浏览器。`false` = 给 launch 参数补 `--no-open`。`dsh web` 默认 `openBrowser=true`，不改的话**每次重启都会弹一次浏览器**（实测 16 次重启 = 16 次） |
| `resumeOnSelfRestart` | `false` | v0.5.0：agent 自己调 `restart_request` 引起的重启，是否也投递"恢复"通知。`false` = 不投（断环）；外部/意外重启照常投递。置 `true` 恢复旧行为 |
| `launch` | `null` | 手工覆盖拉起命令 `{command,args,cwd,env}`；默认从当前进程自动快照 |

> **重启耗时构成（实测 25s → 优化后约 21-22s）**：等旧进程退出 4.6s（其中 3s 曾是插件自身延迟）
> + 端口释放 ~0s + **等新实例就绪 20.2s**。最后这段是 dsh 加载全部插件的固有耗时，
> **不在本插件能力范围内**——要再快需优化 dsh 启动链本身。

> **`shutdownGraceMs` 未消费**：上游也没用这字段（位于 manifest 默认值，但代码不读）。如果需要"距上次活跃 ≤ grace 视为任务相关"的语义，v0.2 加。

## Service

| Service | 签名 | 职责 |
|---|---|---|
| `agint.restart.detect` | `() → {wasRestart, downtimeMs, lastSessionId, lastActiveAt, prevBootAt, currentBootAt, pid, selfRestart, selfRestartRequestId}` | 只读：返回当前 marker 状态 + 是否发生过重启（不重新触发投递）。v0.1.0 只在 README 里承诺，v0.2.0 真正注册。`selfRestart=true` 表示这次中断是插件自己发起的（v0.5.0）。 |
| `agint.restart.status` | `() → {enabled, mode, pid, bootAt, wasRestart, selfRestart, selfRestartRequestId, pending, cooldownRemainingMs, burst, lastRestart, historyCount, lastResult, launch}` | 只读：当前状态 + 冷却/熔断 + 上次结果 + 拉起命令快照。 |
| `agint.restart.request` | `({confirm, reason?, delayMs?, dryRun?, force?}) → {accepted, code, message, requestId?, plan?, shutdownInMs?}` | 发起重启。护栏全在这里：`needs-confirm` / `cooldown` / `tripped` / `already-pending` / `manual-mode` / `dry-run`。 |
| `agint.restart.cancel` | `() → {cancelled, code, message, requestId?}` | 清除在途标记（守护脚本已启动则只能靠人工确认）。 |

对应模型可见工具：`restart_status` / `restart_request` / `restart_cancel`（`lib/tools.js`，需在 preset 挂 `- id: agint-restart-tools`）。

## 开发 / 测试

```bash
# 运行 smoke（含 12 用例）
node test/smoke.mjs
# 或
npm test
```

测试覆盖：
- 纯函数 `detectRestart` / `buildNotice` / `humanizeDowntime`（4+2+1 = 7 cases）
- manifest 8 维度（PLUGIN-SPEC）自检
- 红线：storage domains 仅含 `agint_restart`，不触碰 `agint_meta`
- 端到端：apply 在 mock agents 注入下二次启动触发投递
- 跨平台 fixture（dim 5.5）：forward-slash 路径 + `../escape` 负向
- 优雅 dispose：触发持久化（含最近活跃 session）

## 借鉴与原创边界

| 部分 | 借鉴 | 原创 |
|---|---|---|
| `lib/detect.js` 纯函数 | 1:1 移植（dsh-resume-on-restart/lib/detect.js） | 无 |
| `lib/detect.test.js` 纯函数单测 | 1:1 移植 | 无 |
| 优雅关闭（SIGTERM 二次 kill 修法） | 借鉴上游设计意图 | **agint-restart 原创**：改用 cordis dispose 钩子 |
| 持久化目录命名（`.agint-restart`） | 上游用 `.resume-on-restart` | **agint-restart 原创**：避免与上游命名冲突，便于回滚 |
| 8 维度 manifest + PLUGIN-SPEC | 不存在（上游没 manifest.json） | **agint-restart 原创** |
| cordis.patch.yml loader 模板 | 上游无（上游即装即用） | **agint-restart 原创**：遵守 AGINT 红线（首次挂载走 safe-update） |
| 端到端 smoke（端到端投递验证） | 不存在（上游无端到端测试） | **agint-restart 原创** |
| Cordis dispose 优雅关闭 + 跨平台 fixture | 不存在 | **agint-restart 原创** |

## License

MIT
