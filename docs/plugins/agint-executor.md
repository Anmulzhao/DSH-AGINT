# agint-executor

> 提案批准之后由它动手：可选**立即执行**或**定时执行**，不再生成催办工作单。
> v0.1.0（2026-10-27）新增。

## 职责

- 提供 `agint.executor` host Service
- 轮询 `agint_evolve.execution` 队列，按到期时间 claim 执行
- 调 `agint.evolutionDriver.runForProposal(proposalId)` 走既有 D-QAF 流水线
- 成功 → 提案 `applied`（带落地证据）；失败 → 留原因 + 有限重试
- 守护：状态/blocker 复核、本周自动落地上限、重试上限、kill-switch

**不做**：造变异内容、写仓库、D-QAF 决策、自己存状态。

**六道闸**（顺序有意义）：① 提案还在 → ② 还是 approved → ③ `blocker` 为空 →
④ 驱动可用 → ⑤ 本周额度 → ⑥ 尝试次数。判据实现在 `lib/plan.js:decideRun()`，
逐条说明见下方「六道闸」表 —— ⛔ 那张表是**唯一**一份，别在这里再抄一遍
（本文档此前同时存在「七道闸」和「六道闸」两份，前者是 2026-10-29 撤闸前的旧文，
两处互相矛盾了三天）。

**2026-10-29 撤掉的是原第 ③ 道**（`autoExecutable === false` ⇒ 撤单）。老板裁定
「批准即自动执行」，字段仍在存储里但**不参与任何判据**；跑不动的提案由 driver 的
目标解析给出确定性失败，不用语义闸提前挡。

**确定性失败不重试**：driver 定向执行失败时若判为 `not-actionable`（确定性 ——
定位不到目标 / LLM 判定不适用 / 幻觉闸门拒绝，重试也不会变），执行器**一次收尾**，
失败模式记 `executor-run-not-actionable`；⛔ 偶发失败（LLM 挂了、网络断了）照常重试。

**确定性失败自动收口（2026-11-07, v0.6.0）**：收尾后调用
`agint.evolve.markNotActionable()` —— 提案保留 `approved`，`execMode` 降 `manual`、
`execState` 归 `idle`，原因写进 `execError`/`note`。面板档位从 `person/failed`
（执行失败·等处理）变为 `person/plan`（待定执行计划），由人决定 applied / wontfix /
拆分可执行单元。⛔ 机器不自动标 applied 或 wontfix —— 已实现与不适用都要证据和判断。

**注入**：`inject = ['timer']` —— `ctx.setInterval`（tick）/ `ctx.setTimeout`（wake 去重）
由宿主 `timer` 服务提供。⛔ 漏声明不是「软降级」而是 apply 抛错、插件整个不挂载
（v0.1.0 首次部署即此坑，见 CHANGELOG v0.1.1）。

## 为什么需要它

```
agint-evolve:       proposed ──批准──▶ approved   ← 2026-10-23 补的状态档
                                              ✗ 这里断链：没人捡 approved
agint-evolution-driver: runOnce() 只挑 status:'proposed'
```

批准与执行之间缺一个"捡起来"的部件。缺它时，`approved` 的行在家族面板里
表现为一张「已批准待执行（工作单）」，等于把自动化的决定退回成人肉待办。
2026-10-27 老板明确要求补上：**批准即执行，可选立即 / 定时。**

## 执行计划（提案行上的字段）

| 字段 | 含义 |
|---|---|
| `execMode` | `manual`（只批准，默认）/ `immediate`（立即）/ `scheduled`（定时） |
| `execAt` | 定时到期时刻（ISO）；其它模式为空串 |
| `execState` | `idle` / `queued` / `running` / `succeeded` / `failed` / `deferred` / `cancelled` / `partial` |
| `execAttempts` | 已尝试次数（claim 时自增） |
| `execError` | 最近一次失败 / 顺延原因 |
| `execStartedAt` / `execFinishedAt` | 最近一次起止时刻 |

⛔ 默认 `manual` 是刻意的：**升级不会让历史提案开始自动改代码。**

## 队列（`agint_evolve.execution` 表）

一行 = 一次批准触发的一次执行（重试复用同一行，`attempts` 自增，`log` 追加）。
独立成表的理由：提案行只放得下「最近一次」，而自动执行会失败重试 ——
「第一次为什么失败、重试几次、每次写到哪个文件」必须留得下来。

```
queued ──claim──▶ running ──成功──▶ succeeded
   ▲                  ├──失败 + 有额度──▶ queued（dueAt = now + retryDelayMs）
   │                  └──失败 + 额度用尽──▶ failed
   ├──本周上限到顶──▶ deferred（dueAt = 下周起点，到期自动恢复）
   └──撤销 / 状态不再 qualified──▶ cancelled
```

## 六道闸

| # | 判据 | 不通过时 |
|---|---|---|
| ① | 提案存在 | 撤单 |
| ② | `status === 'approved'` | 撤单 |
| ③ | `blocker` 为空 | 撤单 |
| ④ | `agint.evolutionDriver.runForProposal` 可用 | **失败**（不消耗周额度） |
| ⑤ | 本周自动落地 < `weeklyCommitCap` | **顺延**到下周起点 |
| ⑥ | `attempts < maxAttempts` | **失败**收尾 + 落 `failure_pattern` |

④ 先于 ⑤：能力缺失是配置问题，不该被「下周再试」掩盖。

## 工单状态机（2026-11-01，v0.16.0 起由 agint-evolve 提供）

`status` 说「台账上算哪一档」，`execState` 说「最近一次执行跑到哪一步」——
**没有字段回答「现在该谁动」**。面板只能拿 execState 硬猜，猜出过两次相反的事故
（`a85ef850` 把「卡在前置」写成「待入队」；`846f4fbb` 把「没做完」写成「已落地」）。
`stage` 就是那个缺的字段：一条提案，一个答案。

判据是纯函数 `agint-evolve/lib/execution.js:ticketStage()`，**不读时钟、不碰 execution 表**
—— 只看提案行本身，这样面板（只读落盘 JSON）才能算出同一个答案。
读接口（`propose` / `listProposals` / `getProposal`）都带 `stage` / `stageSide` /
`stageLabel` / `stageWhy` 四个派生字段，**不落盘**（同 `staleSince`）。

| stage | side | 条件（自上而下第一个命中） | 面板标签 |
|---|---|---|---|
| `closed` | closed | status ∈ applied / rejected / wontfix | 已结束 |
| `draft` | person | status = proposed | 待批准 |
| `person/blocked` | person | `blocker` 非空 | 阻塞·等前置 |
| `person/failed` | person | `execState = failed` | 执行失败·等处理 |
| `person/review` | person | `execState = partial` | 部分落地·等续跑 |
| `person/plan` | person | 计划没定（manual / 定时缺时刻） | 待定执行计划 |
| `working/queued` | working | `execState ∈ {queued, deferred}` | 排队中 |
| `working` | working | `execState = running` | 执行中 |
| `stalled` | **system** | 计划就绪、队列里却没有执行 | 应入队未入队 |

⛔ **`stalled` 是 AGINT 独有的档**。dsh-superagent 的同一张表里有 `idle`
（「这轮干完了，等下一条 Trigger」）—— 那是健康静息态。AGINT 没有它：一条 `approved`
提案的唯一正常归宿是**被执行**。照抄 superagent 会把「应入队未入队」这个静默缺陷
画成「等着呢，会来的」。所以这一档 `side` 是 `system` 而不是 `person`：
**没有人需要回答什么问题，需要的是修一个缺陷。**

⛔ ③ blocker 排在任何 execState 之前：blocker 在时执行态没有意义（它根本排不进去）。


## 三道红线

| 开关 | 默认 | 作用 |
|---|---|---|
| `AGINT_EXECUTOR` | `on` | `off` 整体停摆（提案停在「排队中」，不丢） |
| `weeklyCommitCap` | 代码默认 `3`，**本机部署值 `5`** | 本周自动落地次数上限，对齐 AGENTS.md「不跨周累计自动部署 >5 次」 |
| `maxAttempts` | `2` | 重试上限，防无限烧 token |

⛔ `weeklyCommitCap` 的代码默认值（3）与红线值（5）**不是同一个数**，这是刻意的：
默认值只在新部署、没写 config 时生效；本机与 NAS 的 `cordis.patch.yml` 都显式写了 `5`。
2026-10-29 老板把红线从 3 改成 5（commit `a3b9b48`），代码默认值没跟着动 —— 改红线请改
config，别去改默认值，否则新机器会拿着一个未经裁定的数字开始自动改代码。

## 与其它插件的关系

| 插件 | 关系 |
|---|---|
| `agint-evolve` | **上游 + 存储正本**：`claimDueExecutions / finishExecution / requeueExecution / enqueueExecution / executionStats` |
| `agint-evolution-driver` | **执行引擎**：`runForProposal(proposalId)`（v0.5.0 新增） |
| `agint-evolution-memory` | 失败落 `evolution.failure_pattern`（周报查得动的通道） |
| `agint-family-panel` | 批准时选执行方式；待办里分「执行中 / 执行失败 / 等手动执行」三档 |

## 手动操作

```bash
# 看队列（model 工具）
evolve_executions action=list
# 立刻放行一条（会重新过状态与 blocker 复核）
evolve_executions action=run id=<proposalId>
# 撤销排队中/重试中的执行
evolve_executions action=cancel id=<proposalId>
```

## 已知边界

- **一条一条跑**：`maxPerTick=1` + 全局 `inFlight` 保护，不并发改仓库。
- **不做跨提案去重**：两条提案改同一处时，靠 driver 的 `oldText 唯一性` 与
  `commit` 后的 policy 决策兜底（第二条会因锚点失配失败并留原因）。
- **不重排历史**：`deferred` 的顺延目标是下周一 00:00（本地时区），
  不是「上次失败 + 7 天」。
