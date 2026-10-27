# agint-executor

> 提案批准之后，由**它**动手 —— 不用人再点第二次。
>
> v0.1.0（2026-10-27）。补的是「`approved` 之后没人执行」这个断口。

## 它解决的是什么

`agint-evolve` 自 2026-10-23 起有 `approved` 这一档，`agint-evolution-driver` 有完整的
「提案 → LLM 原子编辑 → mutator → population → 写入后验证 → policy → commit」流水线。
两者**从来没接上**：driver 的 `runOnce()` 只挑 `status:'proposed'`，`approved` 的行它不看。

于是批准完的提案在家族面板里挂成一张「已批准待执行（工作单）」，等老板自己想起来去改代码。
2026-10-27 老板明确要求：批准即进执行流程，**可以立即执行，也可以定时执行**，
不要再生成催办单。

```
提案 proposed ──批准（选 immediate / scheduled）──▶ approved + 入 execution 队列
                                                       │
                        agint-executor.tick()（15s 一轮，入队时 wake 立即捅一下）
                                                       ▼
                                    claimDueExecutions() → 逐条过六道闸
                                                       ▼
                        agint.evolutionDriver.runForProposal(proposalId)
                                    （D-QAF / preimage / policy 全是既有路径）
                                        │成功                    │失败
                                        ▼                        ▼
                           提案 → applied（带落地证据）   留原因；有额度则排队重试
```

## 六道闸（顺序有意义，改顺序会改变事故形态）

| # | 闸门 | 不通过时 | 为什么必须是这样 |
|---|---|---|---|
| ① | 提案还在 | 撤单 | 行都没了 |
| ② | 仍是 `approved` | 撤单 | 人撤销了批准，后台不许继续改代码 |
| ③ | 没有 `blocker` | 撤单 | 批准的是方向，前置没到位 ≠ 现在能做（a85ef850 教训） |
| ④ | driver 可用 | **失败** | 能力缺失不是「等下周」，不能被顺延掩盖 |
| ⑤ | 本周自动落地 < 3 | **顺延**到下周起点 | 对齐 AGENTS.md「不要跨周累计自动部署超过 3 次」 |
| ⑥ | 尝试次数 < maxAttempts | **失败**收尾 | 防无限重试烧 token |

④ 必须在 ⑤ 之前：配置缺失不该消耗本周额度，也不该被伪装成「下周就能跑」。

## 状态机

执行行（`agint_evolve.execution`）：

```
queued ──claim──▶ running ──成功──▶ succeeded
   ▲                  ├──失败且有额度──▶ queued（dueAt = now + retryDelayMs）
   │                  └──失败且额度用尽──▶ failed
   ├──周上限到顶──▶ deferred（dueAt = 下周起点，到期自动恢复）
   └──请求撤销 / 状态不再 qualified──▶ cancelled
```

提案行上的 `execState` 与它一一对应（`queued / running / succeeded / failed / deferred / cancelled / idle`），
面板直接读这两个字段，不再用「已批准待执行」一个标签盖住五种处境。

## Services

- `agint.executor.tick(opts)` —— 跑一轮（可重入保护；`inFlight` 期间返回 skipped）
- `agint.executor.wake()` —— 入队后捅一下调度器（同轮去重，不必等满一个 tick）
- `agint.executor.status()` —— 计数器 + 配置 + kill-switch（零副作用）
- `agint.executor.runNow(proposalId, opts)` —— 手动放行：入队 + 立刻跑一轮
- `agint.executor.runTick(opts)` —— `tick` 的显式别名

## Config（cordis.patch.yml）

| 键 | 默认 | 含义 |
|---|---|---|
| `tickMs` | `15000` | 轮询兜底间隔（真实延迟通常远小于它，因为入队会 wake） |
| `weeklyCommitCap` | `3` | 本周自动落地上限；`0` = 不限（仅排查时用） |
| `maxAttempts` | `2` | 同一提案最多试几次（含首次） |
| `retryDelayMs` | `300000` | 失败后多久重试 |
| `maxPerTick` | `1` | 每 tick 最多跑几条（串行，不抢 CPU） |
| `enabled` | `true` | 关掉后只能手动 `tick()`（测试 / 排障） |

环境变量：`AGINT_EXECUTOR=off` 整体停摆。**关掉不丢提案** —— 它们停在「排队中」，面板一眼可见。

## 边界（三条，越一条这事就不成立）

1. **不造变异内容、不写仓库、不做 D-QAF 决策。** 那些全在 `agint-evolution-driver` 里，
   本插件只回答「现在该不该跑」「跑完算不算数」。
2. **不自己存状态。** 队列正本在 `agint_evolve.execution`；自己再存一份 = 重启后两份对不上，
   而症状是「面板说排队中、实际没人跑」。
3. **默认不接管老提案。** 加字段之前批准的提案 `execMode` 归一成 `manual` ——
   升级不会让 50+ 条历史提案突然开始自动改代码。要跑必须有人这一次明确选了立即 / 定时。

## 测试

```bash
node test/executor.test.mjs
```

覆盖：六道闸逐条、周上限顺延目标、失败重试与额度耗尽、commit 未发生不算落地、
kill-switch、`runNow`，以及**自然周口径与 `agint-evolve` 的一致性**（两处各有一份
`startOfWeek`，跨插件不 import，靠用例钉住等价）。
