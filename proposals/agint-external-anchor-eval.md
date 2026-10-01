# Proposal: 外部锚定评估架构（判定权与被评对象分离）

> **状态**：草案（draft） · 类别 `framework` · **未启动**（老板 2026-10-01 拍板：先存档，以后再做）
> **目标插件**：`agint-quality-eval`（v0.2.0 当前）+ `agint-quality-policy` + `agint-evolution-memory`（读侧）
> **作者**：智进（agint preset 会话） · **日期**：2026-10-01
> **风险等级**：P1（新增 storageDomain + 新增插件行 → 需走挂载/重启 SOP；**不破 FROZEN 契约**）
> **配套设计稿**：`D:\DSH\wiki\AGINT\外部锚定评估架构.md`（含完整论证、指标定义、轮换规则）

---

## 0. 一句话

**AGINT 要做到「自己开发自己」，判定权必须外部锚定。** 自评可以做，但只能当假设生成器，不能当裁判。

本提案**不主张**废除任何现有自评防护，也**不主张**立刻撤 `self-evaluate` throw。

---

## 1. 背景与动机

### 1.1 起因

老板指出：AGINT 的定位就是自进化，"现在有我参与，以后就是它自己进化，肯定有自己开发自己的活"。因此提议改掉 `agint-quality-eval` 里那句「Reject self-evaluation」。

### 1.2 查证后的更正（重要）

该 throw 的**射程只有一个模块**：

```js
// plugins/agint-quality/agint-quality-eval/lib/index.js:222-225
// 拒绝自评（递归陷阱）
if (target.id === SELF_PLUGIN_ID) { throw ... }
```

它**不阻止**系统评估自身组件——`BASELINE_TARGETS`（`lib/regression.js:33-43`）已覆盖 9 个 core plugin（memory / rules / metrics / cron / dream / evolve / wiki / tool-stats / quality-contract）。

**结论：自进化本来就在跑，去掉这个 throw 不会"解锁"它。** 这条是递归陷阱护栏，不是自进化的闸门。

对照证据：`docs/architecture.md` §关键不变量 6、`agint-curriculum/lib/verdict.js:84-90`（C1/C2/C3 外部化判定）。

---

## 2. 缺口定位

### 2.1 ⚠️ 核心缺口：外部真值没有独立存储

判定基准 `baseline-suite` 当成一条 **success template** 存入 `agint_evolution.success_template`：

```js
// agint-quality-eval/lib/index.js:393-405
const appliesTo = ['baseline-suite', ...snapshot.targetIds.slice(0, 3)];
return await evo.addSuccess({ template: `baseline-suite-passrate:...`, appliesTo, evidence });
```

读取端靠 `appliesTo` 子串从同一张表捞（`lib/index.js:164-175`）。三个事实叠加：

| # | 事实 | 证据 |
|---|---|---|
| a | 基准与**全部** success template 共用一张表，上限 **50** | `agint-evolution-memory/lib/index.js:53`；`lib/tools.js:128`（"cap 50"） |
| b | 该表有 **model-visible 写工具** `evolution_addSuccess`（ASK 门禁） | `agint-evolution-memory/lib/tools.js:126`；preset 行 `agint-evolution-memory-tools` |
| c | 基准记录**无 provenance、无校验标识** | 仅靠 `appliesTo` 含 `baseline-suite` 区分 |

**后果**：唯一真值锚点的存储与被评对象同池、且可被写。

**定性说明（避免夸大）**：`setBaseline` 当前**只有一个调用方**——测试场景 driver（`eval/scenarios/driver.js:1260`），**生产路径无自动调用**；`weeklyTask` 只读基准（`lib/index.js:574` → `runBaselineSuite`）。所以这是**结构性缺陷**，不是正在漏的口子。

### 2.2 缺口清单

| # | 缺口 | 严重度 |
|---|---|---|
| G1 | 判定基准与被评对象同池、可写、无 provenance | **高**（唯一外部锚点） |
| G2 | 无 held-out 纪律：调优与验证共用同一批样本 | 高（长期必然过拟合） |
| G3 | evaluator 自身不可被评测：`self-evaluate` throw + 不在 BASELINE_TARGETS | 中（阶段 3 才处理） |
| G4 | 无一致率指标：无法度量判定质量本身 | 中 |
| G5 | `AGENTS.md`「不要评估自己」口径模糊，易被误读为「禁止自进化」 | 低（文档级） |

---

## 3. 方案概要

### 3.1 角色分离（不是二选一）

| 角色 | 谁干 | 为什么 |
|---|---|---|
| 提出改进、写代码、跑实验 | **系统自己** | 自进化本体 |
| 生成自评、提出假设 | **系统自己** | 便宜、快，是**输入** |
| **判定** | **外部锚定** | 裁判不能是选手 |

### 3.2 四条不变量（拟与 `docs/architecture.md` §关键不变量并列）

1. **判定标准与被评对象不同池**：基准/金标存 `agint_quality_anchor`，不得写入 `agint_evolution.success_template`
2. **判定权与写入权分离**：evaluator 可被评，但不得成为自己那条链的最终裁判
3. **真值标签外部冻结**：金标标签只能由授权人工增改，被评对象只有读权
4. **无外部证据记 fail**：沿用 curriculum C3，自评一律只进 notes

### 3.3 指标：锚定一致率

用**判定类别**而非 composite 分数（scale 会漂移）：

```
对金标样本 s（冻结标签 label(s) ∈ {PASS, REJECT}）：
  decision(s) = compositeScore(evaluate(s)) === null ? REJECT : PASS
  一致率 = |{s : decision(s) === label(s)}| / |G|
```

- **必须分组**（按 kind / HARM 维度）——整体值掩盖分组退化
- **假阴假阳分开统计**——漏放与误杀后果不对称
- 下降超 2% → 告警（复用 `regression.js` 的 `REGRESSION_DELTA_THRESHOLD = -0.02` 口径）

### 3.4 三层样本集（held-out 纪律）

**用来调优的集子会污染**，一旦拿金标集调参即从验证集退化为训练集。

| 集合 | 用途 | 谁可写 | 轮换 |
|---|---|---|---|
| gold | 一致率基准 | 授权人工（append-only） | 老样本沉淀后迁出 |
| verify | 轮换验证 | 授权人工 | 每季度换 20% |
| heldout | **只在宣布重大版本时开一次** | 授权人工 | 单次使用后降级并入 verify |

### 3.5 分阶段

| 阶段 | 内容 | 准入 | 回滚 |
|---|---|---|---|
| **1** | 代理验证：`anchor.js` 纯函数 + `agint_quality_anchor` 域 + `runAnchorConsistency()`，**不接入任何决策路径** | 无 | 删行 + 删域，零影响 |
| **2** | 基准外置（迁出 `success_template`）+ 一致率接入 `weeklyTask` 退化探测 | 阶段 1 产出 ≥ 4 周数据 | 读取端回退双读 |
| **3** | 撤 throw，自评路径强制 `path=null` + 结果**只能 PENDING_REVIEW** | **三项全满足**：≥8 周一致率稳定 / held-out 已开且与 gold 无显著背离 / 两条护栏有单测 | 恢复 throw（一行） |

---

## 4. 不做什么（边界）

- ❌ **不废除任何现有自评防护**：`curriculum` / `curator` / `skill-autocreate` / `memory-provider` 的 §9.3/§9.4 防护一律不动
- ❌ **不立刻撤 `self-evaluate` throw**——只在阶段 3、准入达标后
- ❌ **不改 `agint-quality-contract` 的 FROZEN 字段**（受 `bin/check-l0-frozen.mjs` 门禁）
- ❌ **不引入新决策入口**：一致率只喂既有 policy
- ❌ **不让 LLM 当标签源**：LLM 可作假设生成器，不可作真值

**本提案专注**：把判定权从被评对象手里分离出去，并让 evaluator 自身首次「可被外部验证」。

---

## 5. 准入 10 维度自评（待补全）

按 `wiki/插件准入-10维度.md` 填写（另有 `wiki/插件准入-9维度.md` / `wiki/插件准入-决策形状.md`）。
**阶段 1 实施前必须补完**，当前仅列初步判断：

| 维度 | 初判 | 说明 |
|---|---|---|
| 安全边界 | 待评 | 新增域、无外部网络 |
| L0 隔离 | 通过（预期） | 不碰 FROZEN 字段 |
| 契约依赖 | 待评 | 依赖 `agint.evolution`（读）、`storageDomain` |
| 可回滚性 | **高** | 阶段 1 删行即净 |
| 测试锚定 | 待评 | `anchor.js` 纯函数可单测 |
| 其余 5 维度 | 待评 | — |

---

## 6. 风险与诚实折扣

| 风险 | 缓解 |
|---|---|
| **过度优化代理指标**：金标集覆盖不到的能力会被系统性忽略 | 显式承认「金标集覆盖不到的能力 = 系统不会自主进化的能力」；指标需人工定期审视 |
| **金标集过时**：在饱和旧标准上刷分后停滞 | §3.4 季度轮换 |
| **held-out 泄漏** | 单次使用后立即降级并入 verify |
| **一致率成为新的一言堂** | 强制分组 + 假阴假阳分离报告 |
| **人工标注成瓶颈** | 接受慢启动（20-30 条起步）；这是必要人工投入 |

**一个必须说的历史教训**：纯自评的系统**不会崩**，会进入"看起来很稳"的状态——分数平滑上升、行为空间不动。这比崩溃更危险，因为没有告警会响。现有 `stagnation`（`STAGNATION_K=5`）与 HARM `homogeneity` 正为此而设。

---

## 7. 待决策清单（开工前必须全部拍板）

| # | 决策点 | 选项 | 建议 |
|---|---|---|---|
| **D1** | 金标样本来源 | A 从 `agint-mutator` 历史反推 + sandbox 硬真值作标签；B 直接复用 `eval/scenarios/`；C 先人工标 20-30 条 | **A**（真实分布） |
| **D2** | held-out 开启权限 | A 仅老板授权 + 留审计；B Agent 可自行开启事后报告 | **A**（否则 held-out 不 external） |
| **D3** | 阶段 3 准入阈值 | 具体一致率数字 | **先用阶段 1 真实数据定基线，暂不预设** |
| **D4** | 是否允许新增 `agint_quality_anchor` 插件行 | A 允许（走挂载/重启 SOP）；B 先只落纯函数不挂载 | **B 起步**（零运行时影响） |
| **D5** | 样本集落点 | A host profile（`~/.dsh/profiles/web/plugins/`）；B 仓库内 | 待定，取决于 D1 样本来源 |

---

## 8. 优先级与前置

**当前优先级：低（已存档，未启动）**

**开工前提**：
1. §7 五项决策全部拍板
2. §5 准入 10 维度补全
3. 若涉及新增插件行（D4=A）→ 按 `wiki/挂载-重启红线.md` 走挂载/重启 SOP

**建议的首个最小动作**（阶段 1 的零风险子集）：
只写 `anchor.js` 纯函数（`computeConsistency` / `groupByKind` / `splitFalsePosNeg`）+ 单测，**不挂载、不建域、零运行时影响**。可随时丢弃。

---

## 附：一句话立场

> 你要的「以后它自己进化」，靠的不是允许它给自己打分——是让它**能被外部验证，然后放心地自己动手**。前者是自欺，后者才是自治。
