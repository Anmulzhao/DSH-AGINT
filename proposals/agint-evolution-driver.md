# 提案：agint-evolution-driver —— 闭环引擎的驱动源

> 状态：**已实现**（2026-09-27）｜插件 `plugins/agint-evolution-driver/`｜cron job `evolution-cycle`
> 上游文档：`docs/known-limitations/evolution-main-chain-not-energized.md`

## 一、要解决什么

`agint-mutator` 与 `agint-population` 挂载至今从未运行。既有文档把原因记为「没有触发点、没人调用」——
属实（§1.2 已证：全仓生产零引用，15 个 cron job 里也没有它们）。

**但这只是第一层。第二层更硬**：`propose()` 要求 caller 自带变异内容（`oldText → newText`、
工具 stubs、策略 steps），而 mutator 的红线是「不调真 LLM」——它只登记和执行变异，**不负责想出变异**。
AGINT 至今没有任何东西在"想"。

所以这不是一根线没接，是**中间缺了一个部件**。本提案补的就是它。

## 二、做什么

```
agint.evolve 的 proposed 提案（真实、人工审核过的改进点）
  → 定位目标资产：preset skills 的 SKILL.md（7 个）
  → spawn subagent（真 LLM）→ 结构化输出 {applicable, targetSkill, oldText, newText, rationale}
  → 硬校验：oldText 必须是原文真实子串        ← 幻觉闸门
  → agint.mutator.propose({source:'evolution-reversed', atomicScope:'prompt', promptPayload})
  → agint.mutator.validate()  （不通过 → 发 rejected 事件，不进种群）
  → agint.population.ingest() （走 policy gate，得 variant）
  → 发 evolution.mutation.proposed
```

目标资产选 **preset skills 的 SKILL.md**，理由：它们是真实的 prompt 资产，改动的爆炸半径
远小于改代码（最坏情况是一个技能提示变差，不会让整个框架起不来），适合作为"第一次真实变异"的靶子。

## 三、为什么不一口气做到 commit

1. **改部署位没意义**：`install.sh` 下次镜像会覆盖。commit 必须落到**仓库正本**。
2. **仓库路径没有干净答案**：hardcode 不可移植；`process.cwd()` 取决于 dsh 从哪启动
   （本机是 `D:/DSH`，不是仓库）。

⇒ 在「宿主如何可靠定位仓库正本」被解决前，**commit 默认关**（`AGINT_EVOLUTION_DRIVER_COMMIT=on` 才开）。
这是记忆第七条里"人工审批只作兜底"的一个例外，理由充分：让 AI 第一次改自己代码，必须有人看着。
老板一句话就能开。

## 四、红线

| # | 红线 | 为什么 |
|---|---|---|
| R1 | 不自己编变异内容 | 内容一律来自 LLM 结构化输出，且 oldText 必须真实存在于原文；找不到就丢弃本次 |
| R2 | 全软依赖，调用时取 | `inject=[]`，bundle apply 顺序不保证 ⇒ 不许在 `apply()` 里缓存 `ctx.get` 结果 |
| R3 | 观测失败不影响主流程 | 事件总线挂了照样 propose/ingest |
| R4 | 不持存储域 | 正本在 `agint_mutator` / `agint_population`，不制造第二份真相 |

## 五、失败域

| 情况 | 行为 |
|---|---|
| kill-switch `=off` | 直接 skipped |
| evolve / mutator 不可用 | skipped + degraded 计数，不抛 |
| 提案定位不到任何技能 | 换下一条候选，不硬凑 |
| LLM 判定 `applicable=false` | 跳过本次 |
| LLM 不可用 / 超时 | 跳过本次（超时双保险：AbortController） |
| **oldText 不在原文** | **丢弃**（幻觉闸门），绝不"修一修再用" |
| validate 不通过 | 发 `evolution.mutation.rejected`，不进种群 |
| policy gate REJECT | ingest 抛错 → 记 lastError，proposal 已落 mutator 域（可审计） |

## 六、已知限制 / 未决

1. **commit 第二阶段**：需先解决"仓库正本定位"。候选方案：install.sh 写一份
   `$DSH_HOME/agint-repo-path.json`；或让 driver 只产出 diff 文件，由外部（CI/人工）落地。
2. **候选只挑最老一条**：每轮一条，避免一次灌进一堆未经验证的变异。
3. **snippet 截断 6000 字符**：长 SKILL.md 的尾部内容 LLM 看不到 ⇒ 它可能选不到最优锚点。
   属可接受的第一版约束。
4. **`AGENT_HOME` 依赖**：`resolveTargetSkill` 靠提案文本里出现技能名来定位；
   提案没提任何技能名就跳过 —— 精度换安全，宁可漏不可错。

## 七、验收

| 层 | 判据 |
|---|---|
| 静态 | `node test/smoke.mjs` T1–T14 全绿（已过） |
| 接线 | `bin/check-wiring.mjs` PASS |
| 通电 | 重启后首个周日 04:15（或手动唤 `runOnce`）⇒ `agint_mutator.json` / `agint_population.json` **首次出现** |
| 观测 | 事件总线出现 `evolution.mutation.proposed`；`status().proposed ≥ 1` |
| ⛔ 反向 | 若只出现 `degraded` 增长而 `proposed=0`，说明 LLM 通道或定位环节有问题，回到 §五 逐条查 —— **别直接认定"还没触发"** |

## 八、挂载行

```yaml
  - id: agint-evolution-driver
    name: ./plugins/agint-evolution-driver
    config: {}
```

（`mountOrder: 61`，在 `agint-ov-strategy` 之后；双副本：bundle 位 + 兼容镜像位，K83）
