# agint-restart

> AGINT 插件：DSH 重启**闭环** —— 检测重启 + 信息性消息投递（v0.1.0）+ **主动发起重启**（v0.2.0）+ **通知回到被中断的会话**（v0.3.0）。
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

解决"DSH 重启后会话中断、工作丢失"、"重启只能人工执行"以及"通知投错会话"三个问题。

## 特性

- 🔄 **重启检测**：通过 marker 文件（`~/.dsh/.agint-restart/marker.json`，记录上次 pid / 启动时间）判断是否发生重启
- 💬 **信息性消息**：重启后投递"检测到重启 + 中断时长 + 上次活跃会话"摘要，由 agent 自主决定下一步（而非命令式强制"继续"）
- 🎯 **活动追踪**：运行期间通过 cordis 事件（`agent/session-start`、`agent/pre-step`）追踪最近活跃会话，供重启后参考
- 🎯 **回到原会话（v0.3.0）**：投递时先按 `lastSessionId` 精确匹配旧会话，命中即投；匹配不到才回退 `target`。
  重启后 agent 异步加载，因此留出 `resumeWaitMs`（默认 5 秒）等旧会话出现，避免"第一次只找到新会话就投了"
- 🪝 **优雅关闭**：cordis dispose 钩子持久化最近活跃会话（**不**用 SIGTERM 处理器——避免上游 `process.kill(process.pid, ...)` 二次 kill bug）
- ✅ **兼容 DSH Desktop**：只依赖 cordis ctx 的 `agents` 服务，不 import 任何 `@deepseek-ai/dsh-*` 内部包
- 🔁 **主动重启（v0.2.0）**：`restart_request` 工具 / `agint.restart.request()` 真正重启 DSH
- 🛡️ **三重护栏**：`confirm` 必填 + 冷却期 + 窗口内次数熔断（防误触与重启循环）
- 🧪 **dryRun / manual**：先看计划再执行，或只生成命令交给人工执行

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
   [agint-restart] 检测到 DSH 服务已重启。
   上次运行于 ...，本次于 ... 重启完成。
   中断约 X 秒。
   重启前最近活跃的会话：<session-id>
   如需继续之前的工作，或启动新任务，请自主决定下一步。
   ```

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
                                        spawn 新 dsh web（复现启动时的 command/args/cwd/env）
                                          ↓
                                        等就绪（sentinel.lease 被刷新 或 端口可连）
                                          ↓
                                        写 restart-result.json + restart.log
```

`respawn.js` 是 detached + unref 的独立进程，父进程（dsh）死后变孤儿继续跑，不受影响。它只用 node 内置模块，**不经 shell**。

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

### 产物文件（都在 `~/.dsh/.agint-restart/`）

| 文件 | 内容 |
|---|---|
| `marker.json` | v0.1.0 起：pid / lastBootAt / lastSessionId / lastActiveAt |
| `restart-request.json` | 本次重启请求（含拉起命令快照） |
| `restart-result.json` | 守护脚本回写的结果（newPid / ready / 各阶段耗时） |
| `restart-history.json` | 最近 50 条重启记录（熔断与冷却的依据） |
| `restart.log` | 人类可读的追加日志 |

## 配置（cordis.patch.yml）

| 配置项 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件开关 |
| `stateDir` | `.agint-restart` | marker/状态文件存放目录（相对 DSH_HOME） |
| `target` | `primary` | **回退**目标（`primary`=主 agent，或指定会话 id）；仅在旧会话匹配不到时使用 |
| `deliveryMode` | `wake` | `wake`=followup（`send(next-turn, wakeup=true)`）→ **唤醒 agent 真正干活**；`silent`=inject（`send(next-step, wakeup=false)`）→ 只入收件箱，**不唤醒、看不到回音**。⚠️ 别凭方法名猜：`inject` 是静默塞入，不是立即触发。别名 `queue`→`wake`、`inject`→`silent`。选 `wake` 时旧会话若中断的是长任务/危险操作，agent 会**自行继续**——想先"汇报等我确认"，用 `notice` 加约束语 |
| `resumeLastSession` | `true` | 优先把通知投回"重启前最近活跃的会话"（只有它带着被中断的上下文） |
| `resumeWaitMs` | `5000` | 为"等旧会话复活"额外留的时间；超时就接受回退目标（`0`=不等） |
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
| `launch` | `null` | 手工覆盖拉起命令 `{command,args,cwd,env}`；默认从当前进程自动快照 |

> **重启耗时构成（实测 25s → 优化后约 21-22s）**：等旧进程退出 4.6s（其中 3s 曾是插件自身延迟）
> + 端口释放 ~0s + **等新实例就绪 20.2s**。最后这段是 dsh 加载全部插件的固有耗时，
> **不在本插件能力范围内**——要再快需优化 dsh 启动链本身。

> **`shutdownGraceMs` 未消费**：上游也没用这字段（位于 manifest 默认值，但代码不读）。如果需要"距上次活跃 ≤ grace 视为任务相关"的语义，v0.2 加。

## Service

| Service | 签名 | 职责 |
|---|---|---|
| `agint.restart.detect` | `() → {wasRestart, downtimeMs, lastSessionId, lastActiveAt, prevBootAt, currentBootAt, pid}` | 只读：返回当前 marker 状态 + 是否发生过重启（不重新触发投递）。v0.1.0 只在 README 里承诺，v0.2.0 真正注册。 |
| `agint.restart.status` | `() → {enabled, mode, pid, bootAt, wasRestart, pending, cooldownRemainingMs, burst, lastRestart, historyCount, lastResult, launch}` | 只读：当前状态 + 冷却/熔断 + 上次结果 + 拉起命令快照。 |
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
