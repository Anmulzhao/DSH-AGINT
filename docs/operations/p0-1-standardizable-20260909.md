# P0-1 [4] 可标准化判断：实现与验证报告

- 日期：2026-09-09
- 触发：W1 第一项（门槛离线回放）挖出「[4] 整段缺失」，老板拍板「动手补 [4]」
- 产出：`lib/standardizable.js`（新增）、`lib/templates.js` 工具名归一化（修）、
  `lib/index.js` 接入、`lib/schema.js` 配置；测试 78/78 PASS
- 版本：`agint-skill-autocreate` 0.2.0 → **0.2.1**（已同步 host 运行时）

---

## 1. 核查确认：[4] 确实整段缺失

| 位置 | 实测 |
|---|---|
| `detector.js:110-111` | `standardizable: null` / `standardizableConfidence: null` —— **写死恒空** |
| `proposer.js` | grep `diagnosis` / `annotate` / `standardizable` —— **0 命中** |
| 设计链路 | `[3] 检测 → [4] 可标准化判断 → [5] 提案生成`，实际是 `[3] → [5]`，**[4] 跳过** |
| schema 层 | `STANDARDIZABLE_ROOT_CAUSES` / `NON_STANDARDIZABLE_ROOT_CAUSES` /
  `min_standardizable_confidence` **都已预留**，只是没有消费方 |

结论：不是"实现得不好"，是**从未实现**。数据契约留了位置，逻辑没人填。

---

## 2. 设计稿那条路走不通（必须记下来，否则后来人会照抄）

设计稿 §3.1 [4] 原文：

> 对每个「重复模式」，调用 diagnosis.annotate 判断根因。
> 可标准化条件：rootCause ∈ {TOOL_GAP, KNOWLEDGE_GAP, PROMPT_DEFICIENCY}
> 且 confidence ≥0.6，且 counterfactual 显示成功率提升 ≥20%。

实测 `agint-diagnosis` v0.6.0 后确认这条路**在语义上不成立**：

### 2.1 `classify()` 只认失败信号

`root-cause-classifier.js` 的 6 类特征全是**失败特征**：

| 根因类 | 匹配信号 |
|---|---|
| TOOL_GAP | `tool not found` / `ENOENT` / `tool.*missing` |
| KNOWLEDGE_GAP | `wiki.*miss` / `memory.*miss` / `no entry found` |
| PROMPT_DEFICIENCY | prompt 段落被引用 ≥2 次 / prompt 版本变更后立即失败 |
| REASONING_ERROR | 逻辑矛盾 / `chain.consistency=false` |
| PLANNING_FAILURE | 子任务顺序异常 / 同目标重做无进展 |
| ENVIRONMENT_SHIFT | 4xx/5xx 占比 ≥30% / 外部 outage |

而 P0-1 的「重复模式」是**成功执行的工具序列**，喂进去 → 任一正则都不命中
→ `maxHits === 0` → 返回 `UNCERTAIN`（在 NON_STANDARDIZABLE 名单里）
→ **全部判「不可标准化」**。

> 硬套 diagnosis = 把链路彻底堵死，比不实现还糟（不实现至少还能出候选）。

### 2.2 `counterfactual()` 需要 failureId

`simulate()` 签名要求 `failureId`（必须能在 `failure_pattern` 表里找到）
+ `evolution.queryFailures` 服务 + 样本数 ≥ `COLD_START_MIN`。
重复成功模式既无 failureId、也不在 failure_pattern 里 → **不适用**。

### 2.3 语义本身也拧着

diagnosis 回答的是「**为什么会失败**」；[4] 要回答的是
「**这个流程值不值得固化成技能**」。成功率 100% 的稳定重复流程恰恰是最该
标准化的，但它对 diagnosis 而言是"无话可说"（没有失败可归因）。

---

## 3. 实现：双轨判定

### 轨道 A（diagnosis 归因）— 接口预留，当前不激活

激活条件：pattern 携带 `failureEvidence` **且** diagnosis 暴露 `classify()`。

当前两条都不满足：
1. `aggregator.js` 只落 `successRate`，**不聚合 `errorKind`**（原始记录里有，
   聚合时丢了）→ 没有失败证据可传。
2. `agint-diagnosis` v0.6.0 服务只暴露 `annotate` / `counterfactual`，
   都要求 `failureId`，**没有 `classify`**。

→ 全部走轨道 B。代码里 `diagnosisSvc()` 软依赖 + `failureEvidence: null`
已就位，aggregator 补上 errorKind 聚合即可激活。

### 轨道 B（启发式）— 默认路径

**硬否决**（`standardizable: false`，明确低价值，不需要人工）：

| reason code | 规则 | 拦截的真实案例 |
|---|---|---|
| `EMPTY_SEQUENCE` | 序列为空 | — |
| `TOO_FEW_STEPS` | 步数 < 2 | `pwsh`×4、`ask_user_question`×2 |
| `TRIVIAL_SINGLE_TOOL` | 去重后工具数 < 2（**重复几次都不算流程**） | `pwsh→pwsh`×4、`pwsh×5`×3、`pwsh×9`×2 |
| `META_TOOL` | 命中 Agent 自我运维工具 | `memory_write`×4、`skill`×3、`autocreate_stats`×3、`evolve_propose`×2 |
| `NO_PARAM_STRUCTURE` | 参数 token 数 = 0 | — |

**软判定**（`standardizable: null`，证据不足 → 需人工，写周复盘）：
`LOW_CONFIDENCE` —— 过得了硬否决但打分 < 0.6。

> 区分 false / null 是有意的：硬否决是"明确垃圾"，null 是"看不准"。
> 设计稿原文「不可标准化 → 标记为需人工判断，写入周复盘」对应的是 null。

**正向信号打分**（`scoreSignals`，公式集中在 `standardizable.js` 便于校准）：

| 信号 | 分值 |
|---|---|
| 工具多样性 ≥3 类 / =2 类 | +0.35 / +0.25 |
| 步数 ≥5 / ≥3 | +0.2 / +0.15 |
| 有读写配对（有输入有输出） | +0.2 |
| 参数 token ≥4 / ≥2 | +0.25 / +0.15 |
| 成功率 ≥0.9 / ≥0.7 | +0.1 / +0.05 |
| 出现次数 ≥5 | +0.1 |

cap 1.0，阈值 `min_standardizable_confidence` = 0.6。

### 元工具黑名单（自指红线 §9.4）

前缀匹配：`autocreate_` `evolve_` `dream_` `curator_` `mutator_` `selfModel_`
`memory_` `eventBus_` `metrics_` `diagnosis_` `evolution_` `abtest_` `cordis_`
`population_` `recall_` `quality_` `tool_stats_` `cron_` `job_` `mount_` `skill`

理由：这些操作的是 **Agent 自己的状态**，不是"完成外部任务的步骤"。给「查
自己的统计」或「给自己建技能」生成技能 = 自指。

**精确匹配（不放宽成前缀）**：`rule_add` `rule_lint` `rule_audit` `rule_list`

> 教训：初版把 `rule_` 做成前缀，回放时发现 `rule_check > ssh_exec` 和
> `rule_check > pwsh` 被误杀。`rule_check` 是「查项目规范」——**业务输入
> 环节**，而「先查规范再执行」恰恰是个值得固化的好流程。已改为精确名单。

---

## 4. 顺带修掉的：[5] 模板匹配 100% 落空

补 [4] 时发现的**第二处断链**，比 [4] 更致命。

`templates.js` 的 `requiredTools` 写的是设计稿抽象名
（`terminal` / `file_read` / `file_write`），而生产 tool-stats 记录的是宿主
真实工具名（`pwsh` / `read` / `write` / `edit` / `glob` / `grep` / `ssh_exec`）。
**两者零交集**。

实测（修复前）：

```
真实模式：pwsh → null        pwsh>pwsh → null       memory_write → null
         skill → null       autocreate_stats → null
设计稿名：terminal → shell-automation      file_read>file_write → file-processing
真实名（同语义）：pwsh>read>write → null   read>write → null
```

→ **即使 [4] 放行，[5] 也 100% 拒绝**，candidates 永远 0。

修法：加 `TOOL_CANONICAL_MAP` 归一化层，匹配前映射，渲染仍用原始名。
修复后：`read>write` → file-processing、`pwsh>read>write` → file-processing、
`pwsh>read` → code-lint。

---

## 5. 验证结果

### 5.1 单元测试

```
# tests 78   # pass 78   # fail 0
```
（原有 54 + 新增 24：`standardizable.test.mjs` 18 项、`template-alias.test.mjs` 6 项）

### 5.2 生产全量回放（5368 条 / 332 个任务实例）

**门槛 3（生产配置）：**

| 阶段 | 结果 |
|---|---|
| [3] 检测 | 306 个模式，跨门槛 7 个 |
| [4] 判定 | 放行 **0** / 明确拒绝 7 / 需人工 0 |
| 拒绝原因 | `trivial_single_tool` 3、`meta_tool` 3、`too_few_steps` 1 |

**门槛 2（验证过滤器不是一刀切）：**

| 阶段 | 结果 |
|---|---|
| [3] 检测 | 跨门槛 16 个 |
| [4] 判定 | 放行 **3** / 拒绝 13 |
| [5] 提案 | **3 个全部拿到模板，能生成候选** ✅ |

放行的 3 个：
- `write > read`（occ=2, conf=0.7）
- `rule_check > ssh_exec`（occ=2, conf=0.6）
- `rule_check > pwsh`（occ=2, conf=0.6）

> 关键结论：**[4] 不是一刀切全拒**。它拦下的是 7/7 人工确认无价值的真实
> 模式，同时在门槛 2 下放行了 3 个并能走完 [5]。

### 5.3 50 模式准确率（设计稿 §14.2）

25 个应通过 + 25 个应拒绝 → **50/50**。

⚠️ **诚实标注**：这个集合是**按判定规则设计的回归集**，作用是锁死行为、防
未来改动误伤，**不是独立 ground truth**。用它跑出的 100% 不代表真实准确率。
真正的准确率需要人工标注的真实模式集，而目前没有任何已发布的自动创建技能
可作标注样本（P0-1 阶段 3 尚未开工）。

本文件中唯一具备独立意义的是**生产回放 7 模式 → 7/7 被拒**：那 7 个是人工
看过确认无价值的模式。

---

## 6. 结论：瓶颈已从代码转移到数据

补完 [4] + 修完 [5] 后，**生产当前数据下产出仍然是 0**。但这不是代码问题：

1. 306 个模式里 299 个只出现 1–2 次（门槛 3 下无一达标）
2. 跨过门槛的 7 个全是单工具/元工具垃圾 → 被 [4] 正确拦下
3. `agint_tool_stats.jsonl` 最后一条是 **2026-09-08T14:50:37Z**，
   到核查时（09-09 12:04）近 22 小时零新记录
4. 日记录量衰减：2261 → 1698 → 727 → 526 → 151 → **5**

**下一步必须先回答**：是最近没在用 dsh，还是 tool-stats 写入链路断了？
若是后者，整条 P0-1 无米下锅，[4]/[5] 修得再好也是空转。

---

## 7. 落地状态

| 项 | 状态 |
|---|---|
| 仓库源码 | 已改（4 文件 + 2 测试文件） |
| 测试 | 78/78 PASS |
| host 运行时 | 已同步（快照 `~/.dsh/snapshots/skill-autocreate-20260909-122319`） |
| `cordis.patch.yml` | 无需改（`config: {}` 用默认值即可） |
| 生效 | **需老板手动重启 dsh**（插件代码在进程启动时加载） |
