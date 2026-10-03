# Benchmark Isolation v1.0（Frozen Benchmark 三层隔离）

> **设计来源**：[Phase-3 设计方案 §2.4](../../DSH-AGINT.wiki/Phase-3%20Self-Improving%20Harness%20Ecosystem%20设计方案.md) + [三层隔离配额定案](../eval/three-tier-quota.md)
> **载体**：`eval/scenarios/inventory.json` 的 `units[].visibility` / `units[].labelAuthority` + sidecar `eval/tiers/agint-tiering.json`
> **判据层**：`bin/lib/scenario-tier.mjs`（纯函数，36 条单测）
> **生成器**：`bin/build-scenario-inventory.mjs`（`--check` 只校验不写盘；`--emit-tiering` 出 sidecar）
> **读端门**：`eval/scenarios/driver.js --tier=<EVOLUTION|VALIDATION|FROZEN|ALL>`
> **防篡改留证**：`plugins/agint-evolution-memory/lib/frozen-set.js` → `benchmark_frozen_set` 表
> **状态**：`DESIGN` —— 字段 + 判据 + 读端门已生效，**三层物理目录与 Frozen 集尚未建立**（见 §7）

---

## 1. 这是什么

三层隔离把 123 个评估单元分成三份，让「进化过程能看到的」与「判定它能用的」分离：

| 层 | 回答的问题 | 谁可以动它 |
|---|---|---|
| `EVOLUTION` | 进化/调参**只**能看见这一层 | 可增删改 |
| `VALIDATION` | 中途校验：调完了看看有没有跑偏 | 只读，只增不减 |
| `FROZEN` | 最终裁决：进化过程**从未见过** | 冻结，只增不减 |

**一句话判据**：一个单元进了 `FROZEN`，进化过程从此必须看不见它。
只给单元贴标签而**不过滤读端**，等于没做 —— 见 §5。

---

## 2. 两条硬约束

| # | 约束 | 违反的后果 |
|---|---|---|
| **A** | 进化/调参路径**只能**看见 `EVOLUTION` 层 | benchmark overfitting：模型把冻结集背下来了 |
| **B** | `VALIDATION` 与 `FROZEN` **只增不减** | 基准被污染：难度下降看起来像能力上升 |

约束 B 的机器判据是 H5（§4），落盘在 `benchmark_frozen_set`（§6）。

---

## 3. 标签存哪：sidecar，不写进场景文件

三层标签放在 **sidecar** `eval/tiers/agint-tiering.json`：

```json
{ "tieringVersion": "1.0", "units": { "<unitId>": { "visibility": "EVOLUTION", "labelAuthority": "UNSET" } } }
```

⛔ **为什么不把标签写进 `.scenario.json`**：`contentHash` 是对场景单元**内容**算的
（`canonicalHash(u, { prefix: true })`）。标签写进场景文件 ⇒ 123 个 `contentHash` 全部改变
⇒ 而 `contentHash` 正是 Frozen 防篡改基线比对的输入 ⇒ **加了防篡改字段反而把基线毁了**。

实测（Sprint 19）：重生成后 `contentHash` 变化 **0 条**，单元集合无增无减。

**sidecar 缺失或某个 `unitId` 没映射 ⇒ 硬错，不给默认值**（`assignTiers`）。
缺映射就静默给 `EVOLUTION`，等于把「没登记」当成「可进化」，是假防线。

---

## 4. 判据 H1–H5

全部实现在 `bin/lib/scenario-tier.mjs` 的 `checkTierAssignment()`（纯函数，不读盘不取时钟）。

| 约束 | 判据 | 性质 |
|---|---|---|
| **H1** | `EVOLUTION` 保留的存量 fail ≥ `⌈0.6 × failCount⌉` | 随 fail 数重算 |
| **H2** | `FROZEN` 中 ≥60% 为新编写 | 分配期约束，不在自动判据内 |
| **H3** | `FROZEN` 中存量 fail 探针 ≤ `failCount − ⌈0.6 × failCount⌉` | **算术结果，不是偏好** |
| **H4** | 某域单元数 < 3 ⇒ 不得进 `FROZEN` | `dream`=1、`memory`=1 永远进不去 |
| **H5** | 相邻两版的 `FROZEN` 名单必须是子集关系 | 减一个即判基准污染 |

### 4.1 `statusKnown`：静态门禁必须显式跳过 H1/H3

H1/H3 的输入是「这一版单元的**实测**状态」。`--check` 这类静态门禁**不跑 driver**，
单元状态全 `UNKNOWN`。此时拿上一版的 fail 数去配这一版的「0 个 FAIL」，会**稳定产出假阳性**。

⇒ 判据层提供 `statusKnown`（默认 `true`）。传 `false` 时跳过 H1/H3，并**显式**记进
`observed.skipped` 与清单的 `tierBaseline.criteriaSkipped`。

⛔ 跳过必须看得见。静默跳过 = 假防线（继承教训：把「字段不存在」当「检查通过」）。

### 4.2 quality 单域主导

`quality` 域占 57/123 = **46.3%**。抽样必须压低它，且清单 `summary.qualityRatio`
回写**实际**占比（不是目标值）—— 目标值进 summary 会让「超标」这件事看不见。

---

## 5. 读端门：三层隔离唯一真正起作用的地方

`eval/scenarios/driver.js`：

| 调用 | 行为 |
|---|---|
| `node scenarios/driver.js` | 默认 `--tier=EVOLUTION`（**fail-closed 默认窄**） |
| `--tier=ALL` | 宽视图，必须显式给 |
| `--tier=FROZEN` | 只跑冻结集 |
| `--tier=<非法值>` | 报错 exit 1，⛔ 不退化成 ALL |

**失效即停**：sidecar 文件读不到、或某个单元缺映射 ⇒ exit 1。
宁可跑不起来，也不许「悄悄用全量」。

实测（Sprint 19）：

```
默认          → 可见 123/123（隐藏 0）  ← 因当前全部还是 EVOLUTION
--tier=ALL    → 117 passed / 6 failed / 123
--tier=FROZEN → 可见 0
--tier=BOGUS  → exit 1
```

⚠️ **当前「默认视图 = 全量」不是门坏了**，是三层还没分配：123 个单元全在 `EVOLUTION`。
分配之后，默认视图会真的开始隐藏单元 —— 那时这层门才第一次被考验。

---

## 6. Frozen 集防篡改

### 6.1 聚合 hash

`frozenAggregateHash(units)`：把 `FROZEN` 单元的 `{unitId, contentHash}` **排序后**
做 `canonicalHash`，压成一个值。增删任一 Frozen 单元、或改任一 Frozen 单元的内容 ⇒ hash 必变。

⛔ **hash 不含 `labelAuthority`**：`HELDOUT → GOLD` 是合法的一次性降级。
算进来会让每次合法降级都被判成篡改（假阳性，而且周期性发生）。

### 6.2 落哪里

`benchmark_frozen_set` 表（`agint-evolution-memory` 域），一行 = 一次冻结集快照：

| 字段 | 含义 |
|---|---|
| `setId` | 主键，`frozen-<ISO>` |
| `frozenUnitIds` / `frozenCount` | 名单与数量 |
| `frozenAggregateHash` | `sha256:<64 hex>` |
| `inventoryTotalUnits` / `failCount` / `h1EvolutionMinFail` / `h3FrozenFailProbeCap` | 当时的口径（让「分母变了」可读） |
| `source` | 谁写的（无 provenance 的留证不可信） |

**纪律**：只增不改（同 `setId` 二次写入抛 `frozen-set-already-exists`）、超限只 warn 不删。
允许覆盖 = 重算一遍新 hash 盖掉旧值 = 篡改不留痕。

⚠️ **加表不升 `descriptor.version`**：整单元格式做**严格相等**校验
（`dsh-storage-json/lib/index.js:102`），升版本会让生产 202 行 `evolution_log` 直接读不出来。

### 6.3 入账路径

⛔ **独立进程不能直写生产存储**。宿主把整个 unit 读进内存、每次 put 用内存态整体重写文件
（last-write-wins，`dsh-storage-json/lib/index.js:215-226`）⇒ 独立进程写的行会在宿主下一次
写入时被静默覆盖。

⇒ 入账走**宿主服务方法** `agint.evolution.recordFrozenSet(entry)`；
`bin/anchor-frozen-set.mjs` 只做只读预览（含重算对账与生产行数取证）。

---

## 7. 当前实况（2026-10-03 Sprint 19 实跑）

| 项 | 状态 | 证据 |
|---|---|---|
| 123/123 单元带两个枚举 | ✅ | `--check` exit 0；`summary.tierCounts` 加总 = 123 |
| `contentHash` 零变化 | ✅ | 重生成前后逐条比对，变化 0 |
| `--check` 真会红 | ✅ | 12 条「放宽⇒变红」实验全部实测变红 |
| 读端门 | ✅ | §5 四种调用实测 |
| Frozen 集分配 | ⛔ **0 个单元** | sidecar 全 `EVOLUTION`，`labelAuthority` 全 `UNSET` |
| 三层物理目录 | ⛔ 未建 | 本 Sprint 不动目录：`driver.js:2499` 非递归发现，迁目录会连带 `sourceFile` 历史路径 |
| `benchmark_frozen_set` 生产行数 | ⛔ **0 行** | 表 + 服务方法已就绪（17 单测），入账需部署 + 重启后走宿主方法 |

⇒ **「三层隔离已落地」这句话现在还不能说。** 落地的是**机制**，不是**三层**。

---

## 8. 已知偏差

| # | 偏差 | 处置 |
|---|---|---|
| 1 | 配额文档 `three-tier-quota.md §2.1` 写存量 fail = 5，实测 **6**（新增回归 `stats-reports-counts-and-limits`）⇒ H1 下限 3→4、H3 上限仍为 2 | 判据层按**实测** fail 数重算，不读文档常量；配额文档的 5 需 Sprint 20 订正 |
| 2 | 首期 Frozen 10 个（新编 6 + 现有 4）未分配 | 属「创作型」工作量，不在本 Sprint |

---

## 9. 未落地项的下一步

1. 分配首期 Frozen（新编 6 + 现有 4）⇒ sidecar 里 10 个单元改 `FROZEN`
2. 分配后**立刻**入账一条 `benchmark_frozen_set`（部署 + 重启后走宿主方法）
3. 建三层物理目录（需先解决 `driver.js:2499` 的非递归发现）
4. `labelAuthority` 随 external-anchor 提案推进（当前全 `UNSET`）
