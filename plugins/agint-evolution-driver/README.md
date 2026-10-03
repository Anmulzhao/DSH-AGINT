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
| `status()` | `{runs, proposed, ingested, degraded, ledgerWritten, ledgerFailed, predictionLocked, predictionSkipped, lastRunAt, lastError, killSwitch, commitEnabled}` |
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

## 预测锁定（v0.2.12，Phase 1.1 支点 1a / 设计 §2.4.2）

`lib/prediction-locker.js` 是 `contract-manager.lockPrediction` 的软失败外壳，调用点在
**`commitToRepo` 之前**（写入与验证都还没发生）。顺序不可调换：锁定晚于执行一步，
"预测"就变成"照着一个已经发生的结果编的数字"，`hypothesisLock` 防事后编造的意义归零。

- 锁成功：落 `contract_locks` 一行 + 发 `evolution.contract.locked`（不可撤回的外部见证），
  返回带 `locked:true` 的凭证。
- 无预测可用（生产实况是 `targetMetric:'unspecified'`）：返回 `NO_PREDICTION_AVAILABLE`，
  **不写锁行** —— 表里的"覆盖"必须是真覆盖。
- 锁不上（服务缺失 / 落表抛错 / 已锁过）：warn + `predictionSkipped` 计数 +
  `cycle.summary.prediction.status` 带出，`predictedDelta` 留 null，主流程照走。
  外壳存在的理由：`lockPrediction` 的硬失败（抛错中止进化）若直接进主循环，
  会被 commit 的 `catch` 收成"commit threw"并触发真实回滚 —— 观测缺陷不该毁掉一次仓库改动。

Ledger 条目侧的证据门在 `ledger-writer.js` 的 `lockedPredictionOf`：只认带 `locked:true`
+ 有限数 + 非空 `hypothesisLock` + enum 内来源的入参，四个条件缺一就留 null。
⛔ 不要在 `buildLedgerEntry` 里现算预测 —— 守卫测试「无证据字段一律 null」锁的就是这个。

### targetMetric 从哪来（v0.2.13）

`lib/metric-resolver.js`：variant 行记过指标就用它；落兜底 `unspecified` 时才读
**提案自己声明的** `expectedEffect` 串（mutator FROZEN 要求它可证伪，如
`'baseline 通过率 >= 95% 在 7 天'` ⇒ `SUCCESS_RATE`）。关键词表封闭，四类之外的指标名原样放行。
读不出就 `null`：一个都不匹配是 `METRIC_UNSTATED`，命中两类以上是 `METRIC_AMBIGUOUS`（歧义不取第一个 ——
那是让关键词表的顺序替系统做预测）。

解析结果**同一个值**要同时进锁和 Ledger 条目：`hypothesisLock` 把 targetMetric 折进了摘要，
两边不一致，归档重算必判假篡改。出处（`VARIANT` / `EXPECTED_EFFECT`）落 `cycle.summary.prediction`。

### 期望串按目标类型声明（v0.2.14）

`lib/expected-effect.js`：`expectedEffectForTarget({ targetType })`。
代码类目标 ⇒ `场景集通过率 >= 95% 在 7 天`（点名 R1 仪器 `eval/scenarios/driver.js`）⇒ 解析成
`SUCCESS_RATE` ⇒ 锁。技能/preset 类 ⇒ `技能输出质量评分 >= 90% 在 7 天`，这个词刻意不进
`METRIC_KEYWORDS` ⇒ `METRIC_UNSTATED` ⇒ **不锁**，链上留 null。

改动前对所有变异硬写同一句「baseline 通过率…」，于是改 SKILL.md 也声称通过率会涨——
而技能类今天没有测量手段（abtest 0 行、population fitness/traffic 0 行、token/latency 无生产者）。
⛔ 别把技能类那句改回带「通过率/成功率」的措辞：`metric-resolver` 会照词面锁一条测不到的预测，
`test/expected-effect.test.mjs` 就是钉这条的。mutator 的 FROZEN 契约要求必须给可证伪串，
所以给的是真实想改善的量，不是留空。

## 实测 actualDelta（v0.2.15，Phase 1.1 支点 1b / R1′）

1a 锁住了「预测」。本层补对面那半：量出「实际」，`actualDelta` 才有值，PQ 与 τ 才有得算。

判据来自一次真实对照实验（2026-10-03，拿 2026-09-29 那次自改做的）：
`eval/scenarios` 场景集 123 条对那处 160 行改动**逐条零差异**；按被改文件筛出的测试子集
看得见（3/3 → 2/3）；全仓 1928 条 passRate 只动 0.05pp，远小于死区 1.5pp。
⇒ 度量集 = **改动面筛出的测试子集**，双态各跑一遍。不是场景集，也不是全仓。

| 文件 | 职责 |
|---|---|
| `lib/outcome-scope.js` | 纯判据：preimage 名 → 被改文件；被改文件 → 该跑哪台仪器（测试子集 / 技能金标集）；都筛不出就 `NO_EVIDENCE`。不读盘、不读时钟 |
| `lib/outcome-measurer.js` | 外部世界那一侧：跑候选态 → 临时换回 preimage 跑基线态 → 换回来核 sha → 打分 → 落 `prediction_outcomes` |
| `lib/skill-gate.js` | R2 第二台仪器：技能的**人工签核内容断言集**（`eval/skills/<preset>/<skill>.cases.json`）。未签核的 case 不进分母；0 条已签核 ⇒ 上层记 `NO_EVIDENCE` |

四条护栏（每条都对应一次会出事的形状）：

1. ⛔ 只换**一个**文件，且必须落在 `repoRoot` 内，不碰 `.git/`、`.agint-preimage/`。
2. ⛔ 换完必须换回来并核 sha。核不上 ⇒ 记录照写但 `restoreVerified:false` + `needsAttention`，
   cron job 据此抛错出声（静默等于让老板的源码树带伤跑一周）。
3. ⛔ `repoRoot` 下没有 `node_modules` 就拒测（`NO_TEST_RUNTIME`）。裸 worktree 实测得假基线 23/123。
4. ⛔ 测不到 ≠ 没改进。覆盖门没过 ⇒ `NO_EVIDENCE`，表里**一行都不写**（设计 §4.2.5）。

服务入口 `measureOutcomes({ repoRoot?, env?, limit?, inject? })`（cron job `outcome-measure`，Tue 10:15）。
`limit` 默认 5 条/轮；`status()` 暴露 `outcomeMeasured` / `outcomeRefused` / `outcomeAttention` 三个计数器。
只有 `decision ∈ {AUTO_DEPLOY, PENDING_REVIEW}` 的条目可测 —— REJECT/ABSTAIN 已从 preimage 回滚，
盘上没有"改后态"可量。`targetMetric` 只认 `SUCCESS_RATE`：跑测试数不出 token 也数不出延迟，
其余指标一律 `UNSUPPORTED_METRIC`（⛔ 不许换成"看起来像"的代理指标）。

⚠️ `nodeTestRunner` 必须清掉 `NODE_TEST_CONTEXT`：宿主若本身跑在 `node --test` 下，
这个变量会传给子进程，子 node 认定"递归调用"就跳过跑文件（E2E 实测踩到，症状 `RUNNER_UNPARSABLE`）。

## 归档校验（v0.2.16，设计 §2.4.2 第 6 步）

`lib/contract-audit.js` 是 `verifyHypothesisLock` 的**调用点**。校验函数与它的单测一直有，
缺的是 caller —— 而没人校验的锁只防"改 predictedDelta 数值"，防不到改 `targetMetric` /
`changedComponents` / `lockedAt`（这些都在摘要里），更防不到**删掉 `contract_locks` 的行**。

三向清点（`sweep()`）：

1. 表里每行按条目重算 ⇒ 对不上 = `CONTRACT_TAMPERED`。
2. 链上写了 `predictedDelta` 却没有锁行 = `LOCK_ROW_MISSING`（删证据）。
3. 条目缺任一摘要成分 ⇒ `UNEVIDENCED_HYPOTHESIS`，⛔ 不硬算。硬算会得到另一个 hash，
   把一条没被改过的锁判成篡改 —— 假警报会让整套判据失去可信度。

hypothesis 从 **Ledger 条目**复原（`summary.{mutationType,targetMetric,changedPlugins,
predictedDelta,predictionSource}` + `contract_locks.lockedAt`）。实时路径不产 Contract 对象，
条目就是唯一可复原的来源；这条配方由 `test/smoke.mjs` T25f 逐字节钉住。

调用顺序：**先验锁，再量账**。`measureOutcomes()` 开头跑一次全表 sweep（结果进返回值 `audit`
块与 `status().auditChecked` / `auditTampered`）；measurer 每条测之前再验一次自己那条，
对不上就 `CONTRACT_TAMPERED` —— **在跑测试之前**拒，不写 `prediction_outcomes`。
没有预测的条目（`predictedDelta=null`）不受这道门影响：它的 `actualDelta` 仍是真观测，
而"预测 vs 实测"这对关系它压根没有，伪造不了任何东西。

⛔ 只判定，绝不修复。修复等于重写历史，会让防篡改机制自我消解。处置 = 标记 + 不计入统计 +
出声（cron `outcome-measure` 对 `tampered` / `orphanPredictions` 抛错）。

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
