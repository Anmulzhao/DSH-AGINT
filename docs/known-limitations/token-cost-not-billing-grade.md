# 已知限制：token 成本是「压力差估计」，不是 billing 级精确计费

> 建档：2026-10-26（D2 收口当日）。适用版本：agint-tool-stats 0.2.0 /
> agint-quality-eval 0.4.0 / agint-quality-policy 0.9.0。
> 相关：[`docs/capability-boundary.md`](../capability-boundary.md) §4 F3 / §5 D2。

> ### ⚠️ 2026-11-06 复核：三周后覆盖率仍在门槛下，升级路径**仍未启用**
>
> | 判据 | 2026-10-26 记录 | 2026-11-06 实读 |
> |---|---|---|
> | `agint_tool_stats.jsonl` 总行数 | 4,746 | **7,032** |
> | 其中 `tokenSource = "tokenMeter"` | 412 | **2,698** |
> | 带 token 实测的行占比 | ~8.7% | **38.4%** |
>
> ⚠️ **口径提醒（本文 §口径表已写，此处重申，因为它是本条的判据核心）**：
> 38.4% 是**全部历史行**的占比；而 `computeEffectiveDelta` 要求的是
> **基线窗与当期窗各自 ≥ 0.5（`MIN_TOKEN_COVERAGE`）**。
> 历史累计覆盖率 38.4% 低于门槛 ⇒ **「有效进化增量：测不出来」大概率仍在报。**
>
> ✅ **覆盖率确实在涨**：8.7% → 38.4% ⇒ §「什么时候该回头看这份文档」第 1 条
> 说的「覆盖率会随日期推进自动达标」方向没错，**只是还没到**。
>
> ⛔ **升级路径仍未启用**：本文 §「想要 billing 级精确值时的升级路径」列的
> `@deepseek-ai/dsh-token-meter/client` → `deriveTurnTokenUsage(events)`
> —— **全仓仍未消费**：`grep -rn "dsh-token-meter\|deriveTurnTokenUsage"` 在插件代码里
> 只命中两处**注释**（`agint-family-panel` 的边界说明与其测试断言），**无一处 import**。
> ⇒ 「历史会话也能算、基线窗不再被迫 unknown」这个收益**仍然拿不到**。
>
> ⚠️ **未取证**：基线窗 / 当期窗**逐窗**的覆盖率本文没有算
> （需按 `computeEffectiveDelta` 的窗口切分重算）。
> **38.4% 是全局值，不能直接断言「护栏此刻报 unknown」** ——
> 那个断言要由 `agint-quality-eval` 的实际输出给出。
> 要确认请读 `agint_metrics.json` 的 `metric` 表里 quality-eval 相关键
> （本次实读：该表 4,264 行，**未见任何 token / coverage 命名的键**）。

## 一句话

D-QAF §5.2 的分母现在**算得出来**了（token 项接上上游 `ctx.tokenMeter`），
但它的量纲是「工具调用前后会话累计 token 的差值」，**不是**这次调用本身的计费额。
把它当账单用会错，把它当「这条路是不是越走越贵」的趋势信号用是对的。

## 口径（写在前面，避免下一个人重新踩）

| 项 | 事实 |
|---|---|
| 数据来源 | `agint-tool-stats` 的 `deltaTokens` 字段，来源 `ctx.tokenMeter.measure(session)` |
| 语义 | `总token(调用后) - 总token(调用前)`，**含该轮模型回复** |
| 量纲 | 上游的 **request-and-response pressure**（文本走固定启发式），非 provider 上报 usage |
| `null` | = **没测到**（上游缺席 / 没有 live session 对象） |
| `0` | = **测得零**（同一 turn 内连续两次工具调用之间没有新的模型 token） |
| 生产实测（2026-10-26 23:29） | 4746 行记录中 412 行带数值（tokenSource=`tokenMeter`），12 个会话，累计 437,957 tokens；其中 173 行按设计为 `0` |

⚠️ 因为「同一 turn 里只有第一次调用会拿到非零差值」，**逐次调用**的平均值会被 0 稀释。
要衡量「一次任务/一个技能花多少」，用任务级求和（curator / skill-autocreate 的
`groupTaskCalls` 就是这么做的），不要拿逐次均值当技能成本。

## 覆盖率门槛（这是护栏为什么会报 `unknown`）

`computeEffectiveDelta`（agint-quality-eval 0.4.0）要求基线窗与当期窗的 token 覆盖率
**都 ≥ 0.5**（`MIN_TOKEN_COVERAGE`）才肯给结论，否则返回
`verdict='unknown'` + `reason='token-unmeasured'`，并在周复盘里明说「护栏未生效」。

后果：**接上 token 计量的头两周，有效进化增量会稳定报 unknown**（基线窗里没有历史 token 数据）。
这是刻意的 —— 与其用「步数 + 耗时」算半个分母冒充完整读数，不如老实说测不出来。
覆盖率会随日期推进自动达标，不需要人工干预。

## 想要 billing 级精确值时的升级路径（已勘察，未实施）

上游 **已经提供**精确用量，只是 AGINT 尚未消费：

| 事实 | 证据（2026-10-26 实测） |
|---|---|
| 包 | `@deepseek-ai/dsh-token-meter`（0.2.1-rc.3） |
| 入口 | `@deepseek-ai/dsh-token-meter/client` → `deriveTurnTokenUsage(events)` |
| 语义 | 折叠一个完整 turn 的 attempt 生命周期，给**provider 上报的** `totalTokens` / `uncachedInputTokens` / `outputTokens` / `cacheRead/cacheWrite`；证据不全时返回 `undefined`（fail-closed，与本仓口味一致） |
| 可回溯历史 | 是 —— 它吃的是 session 事件流（`assistant/message` 的 usage），不是 live 会话 |
| 可解析性 | 部署位 `$DSH_HOME/.agint-bundle/node_modules/@deepseek-ai/dsh-token-meter` **存在**；**仓库根解析不到**（`ERR_MODULE_NOT_FOUND`） |

⇒ 要做就用**懒动态 import + 缺失时出声**（别在模块顶层 import，否则仓库侧
`plugin-check` 逐插件 import 会整片红）。收益：历史会话也能算，基线窗不再被迫 unknown。

## 什么时候该回头看这份文档

- 周复盘连续两周显示「有效进化增量：测不出来」→ 查 token 覆盖率（而不是去改门槛）。
- 想拿 token 数做容量/预算决策 → 先换成上面的精确路径，别用 pressure 估计当账单。
- 宿主升级后 `ctx.tokenMeter.measure()` 签名或返回结构变化 → `deltaTokens` 会集体转 `null`，
  本仓的 `null` 语义保证它**不会**被读成「成本降为零」。
