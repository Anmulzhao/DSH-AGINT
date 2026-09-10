# Changelog — agint-restart

> 所有破环性变更必须写入本文件。变更流程：marker 文件格式 / brand 前缀 / 消息内容修改走 L0 治理（人类多签 + 7 天影子 + major 版本），其它按 semver。

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
