# agint-evolution-driver

闭环引擎的**驱动源**。一句话：它是 `agint-mutator` 一直缺的那个 caller。

## 为什么需要它

`agint-mutator` 的红线是「不调真 LLM」——它只登记和执行变异，内容（`oldText → newText`）必须由 caller 提供。
全仓从来没人写过这个 caller，于是 mutator / population 挂载了三年、测试全绿、生产一次没跑过
（见 `docs/known-limitations/evolution-main-chain-not-energized.md`）。

本插件补的就是这一段：

```
agint.evolve 的 proposed 提案（真实、人工审核过）
  → 定位目标资产（preset skills 的 SKILL.md）
  → spawn subagent（真 LLM）生成 oldText → newText
  → 硬校验：oldText 必须真实存在于原文   ← 幻觉闸门
  → agint.mutator.propose() → validate()
  → agint.population.ingest()（走 policy gate）
  → 发布 evolution.mutation.proposed
```

## Service

`ctx.get('agint.evolutionDriver')`

| 方法 | 说明 |
|---|---|
| `runOnce({ env, inject })` | 跑一轮。返回 `{skipped, candidateId, skill, proposalId, variantId, policyDecision}` 或 `{skipped:true, reason}` |
| `status()` | `{runs, proposed, ingested, degraded, lastRunAt, lastError, killSwitch, commitEnabled}` |
| `construct({candidate, skillName, fileText, llm})` | 单独的构造环节，可注入（测试 / 换实现） |

## 开关

| 变量 | 默认 | 含义 |
|---|---|---|
| `AGINT_EVOLUTION_DRIVER=off` | 开 | 总闸。出厂即开 |
| `AGINT_EVOLUTION_DRIVER_COMMIT=on` | **关** | 是否允许 commit（真改文件）。**默认关，理由见下** |

## ⛔ 第一阶段不 commit

commit 会真改文件，而**改部署位没有意义**——`install.sh` 下次镜像会把改动覆盖掉。
要 commit 就必须落到**仓库正本**，而「宿主进程怎么可靠地拿到仓库路径」目前没有干净答案
（hardcode 路径不可移植；`process.cwd()` 取决于 dsh 从哪启动）。

在它被解决前，commit 保持显式开启。这不是保守拖延，是**不确定就别动手**。

## 三条红线

1. **不自己编变异内容**：一律来自 LLM 结构化输出，且 `oldText` 必须是原文的真实子串；找不到就丢弃本次。
2. **全软依赖**：`inject=[]`，bundle apply 顺序不保证 ⇒ runtime 一律**调用时** `ctx.get`，不在 `apply()` 里缓存。
3. **观测失败不影响主流程**：事件总线挂了照样 propose/ingest。

## 测试

## goal 桥（v0.2.6，行动 #2）

`lib/goal-bridge.js`：进化提案 → dsh goal objective → `goals.create`（软依赖 `agint.goals`；
未挂载 / 无 create / 抛错 → `{ created:false, reason }`，不影响 runOnce 既有路径）。
kill-switch `AGINT_EVOLUTION_DRIVER_GOAL=on` 才启用（默认关）；**2026-09-28 已在宿主
User 级环境置 on**（宿主重启后生效）。只创建、不接管：轮次驱动完全由宿主 goal-round-driver 承担。


```sh
node test/smoke.mjs   # T1–T14
```

覆盖：kill-switch 语义 / commit 默认关 / 技能定位词边界 / 幻觉闸门 / validate 拒绝不 ingest /
总线不可用仍走完 / seen 去重不重复处理同一提案。
