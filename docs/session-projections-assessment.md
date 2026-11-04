# `ctx.sessionProjections` 评估：AGINT 现在不该用它

> **结论先行**：宿主 0.2.1 确实给了 `ctx.sessionProjections`，本机 profile 也已挂载。
> 但把 AGINT 现有的四类派生值逐条核对下来，**没有一类适合它** —— 问题不在服务，
> 在「投影的对象」与「AGINT 派生值的数据源」对不上。
> 本文件回答「为什么不做」，并写清「什么条件下该重新评估」，避免半年后被无依据地问第二遍。
>
> 日期：2026-11-02 · 对应提案 `proposals/agint-dsh-surface-absorption-20261101.md` 的 B4

---

## 1. 事实：服务在本机确实可用

| 事实 | 取证 |
|---|---|
| 包在安装树 | `@deepseek-ai/dsh-session-projection` 存在于 dsh 0.2.1-rc.5 的 dependencies |
| profile 已挂载 | `dsh --profile web --dump-config` 输出含 `- id: session-projection`（还有 `session-projection-cache`） |
| 契约 | `register(definition)` / `register(host-only)` / `stateOf(session, key)` / `snapshot(session, keys)` / `onChanged(listener)` |

⇒ 「拿不到服务」不是不做的理由。下面是真理由。

## 2. 判据：投影适合什么样的值

读契约里那几句关键描述：

> `register(definition)` —— "Register one domain's unit. **The registration is an effect on the calling
> context's fiber**"
> `stateOf(session, key)` —— "Read one unit's current host state after **materializing every
> registered unit at the Session cursor**"

⇒ 投影的定义域是**一个 Session 的事件游标**：把一个聚合函数挂在日志增长上，
由宿主在 cursor 处物化。它天然适合：

- 数据源**就是该 session 的事件流**；
- 值是**随日志单调增长而累积**的聚合（计数、求和、窗口）；
- 需要**不需要自己管缓存与失效**。

反过来，三种情况不该用：
1. 数据源不是这个 session 的日志（哪怕它也叫"会话内"）；
2. 值是持久事实而不是派生（那就该落 storage domain）；
3. 值**跨 session**（投影的作用域就是单个 session）。

## 3. 逐条核对 AGINT 的候选派生值

| 候选 | 数据源 | 判定 | 依据 |
|---|---|---|---|
| `agint-tool-stats` 的 `resourceWindow()` | **`storages/agint_tool_stats.jsonl`**（自落盘），`readAllRecords` 全量读 | ❌ 不适用 | 数据源不是 session 日志，投影的 cursor 对不上。`lib/index.js` 的 `resourceWindow()` 第一行就是 `await readAllRecords(jsonlPath)` |
| `agint-compress-guard` 的压缩检查点 | `agint.memoryProvider.runPreCompressCheckpoint()` → storage domain | ❌ 不适用 | 这是**持久事实**（要能跨重启恢复的洞察），不是派生值。落 storage 才是对的 |
| `agint-evolve` 的提案 `stage` | `agint_evolve` 域 | ❌ 不适用 | **跨 session**：提案的生命周期远长于一个会话。v0.24.0 已明确「派生值不落盘、每次现算」的设计决定，理由正是它会随状态变化而过期 |
| `agint-self-model` 的能力快照 | 各插件 `stats()` 的聚合 | ❌ 不适用 | 全局视角，不绑任何单个 session |

四条全不满足。**不是"再想想就能用上"，是对象不匹配。**

## 4. 那 AGINT 有没有"该用"的地方？

有，但现在还没有那种东西：**一个只依赖当前会话日志、且要频繁读的聚合值**。

具体说，如果要建，会是这类：

- 「本次会话已经调了多少次工具、失败几次、累计 token」—— 但 `toolMeter` 已经能做（压力差口径），
  且 `agint-tool-stats` 的落盘版本要用于**跨会话**统计（`resourceWindow` 的分母就是跨会话的），
  两者需求不同；
- 「本次会话的规则拒绝次数」—— `agint-rules` 现在是内存计数，本来就不重算，没有性能问题。

⇒ 现状是**没有痛点**。加投影 = 为了用而用。

## 5. 什么条件下重新评估（写死，别靠记忆）

任一条成立时，回来重读本文件并重新评估：

1. AGINT 出现「**只依赖当前 session 事件流**、且每次读都要扫全量」的派生值；
2. `agint-tool-stats` 的数据源**改成从 session 日志 live fold**（而不是现在自落 jsonl）——
   那时 `resourceWindow` 就天然适合投影；
3. 宿主把 `sessionProjections` 的**作用域扩到跨 session 或跨进程**（现在不是）。

## 6. 如果将来要用，先验这四件事（别直接信文档）

1. `ctx.get('sessionProjections')` 在 **AGINT 插件的 ctx**（不是 host ctx）里返回非空 ——
   `dump-config` 证明"配置挂了"，**不等于**"插件 ctx 拿得到"，本项目已有多起同类误判；
2. `register()` 的 disposer 是否随插件 fiber dispose 自动摘掉（否则热重载会重复注册）；
3. `stateOf()` 在**会话中途**（日志还在长）读到的值与现算是否逐字相同；
4. `session/disposed` 之后 `onChanged` 是否静默（不静默就是泄漏）。

## 7. 顺带记录：本评估没覆盖的东西

`sessionProjectionCache`（配套的持久化缓存）本文件没有评估。它的语义是「把投影结果落盘复用」，
如果 AGINT 哪天要做「跨重启的会话聚合」，那才是它的场景。现在不涉及。

---

**一句话总结**：服务是真的、契约是真的、AGINT 的四个候选派生值一个都对不上。
不做，且已写清什么时候该做。
