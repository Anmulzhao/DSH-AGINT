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

**七道闸**（顺序有意义）：① 提案还在 → ② 还是 approved → ③ **能不能自动执行**
（`autoExecutable === false` ⇒ 撤单）→ ④ blocker 还在 → ⑤ 驱动可用 → ⑥ 本周额度 →
⑦ 尝试次数。

**确定性失败不重试**：driver 定向执行失败时若判为 `not-actionable`（确定性 ——
定位不到目标 / LLM 判定不适用 / 幻觉闸门拒绝，重试也不会变），执行器**一次收尾**，
失败模式记 `executor-run-not-actionable`；⛔ 偶发失败（LLM 挂了、网络断了）照常重试。

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
| `execState` | `idle` / `queued` / `running` / `succeeded` / `failed` / `deferred` / `cancelled` |
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

## 三道红线

| 开关 | 默认 | 作用 |
|---|---|---|
| `AGINT_EXECUTOR` | `on` | `off` 整体停摆（提案停在「排队中」，不丢） |
| `weeklyCommitCap` | `3` | 本周自动落地次数上限，对齐 AGENTS.md「不跨周累计自动部署 >3 次」 |
| `maxAttempts` | `2` | 重试上限，防无限烧 token |

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
