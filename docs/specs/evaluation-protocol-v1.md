# Evaluation Protocol v1.0（二维标注统一规范）

> **设计来源**：[Phase-3 设计方案 §2.4](../../DSH-AGINT.wiki/Phase-3%20Self-Improving%20Harness%20Ecosystem%20设计方案.md)
> **载体**：`eval/scenarios/inventory.json` 的 `units[].visibility` + `units[].labelAuthority`
> **生成器**：`bin/build-scenario-inventory.mjs`（`--check` 只校验不写盘）
> **门禁**：`bin/check-spec-consistency.mjs`（索引登记）/ `bin/build-scenario-inventory.mjs --check`（字段合法性）
> **状态**：`DESIGN` —— 字段已进 schema 与生成器，**Phase 0 三层隔离尚未落地**，故 `visibility` 全部为默认值

---

## 1. 这是什么

一个评估场景有**两个正交属性**，本规范把两者显式分开标注：

| 维度 | 回答的问题 | 取值 |
|---|---|---|
| `visibility` | **进化过程**能看到哪些评估数据？ | `EVOLUTION` / `VALIDATION` / `FROZEN` |
| `labelAuthority` | **判定基准**的真值标签由谁写？ | `UNSET` / `SILVER` / `GOLD` / `HELDOUT` |

⚠️ **为什么必须拆成两个字段**：Phase 0 的三层隔离与 external-anchor 提案的三层
**回答的是不同问题**（见 §2），合在一个字段里必然出现「改了 A 语义却以为在改 B」的
事故。两组值的**生命周期规则互相冲突**（`FROZEN` 永不删改 vs `HELDOUT` 用后降级），
但冲突只发生在「第三层规则」上，**不是属性本身冲突** —— 拆分后即可各管各的。

---

## 2. 为什么两个维度不冲突（设计 §2.4.1）

| | Phase 0 三层（`visibility`） | external-anchor 三层（`labelAuthority`） |
|---|---|---|
| 回答的问题 | 进化过程能看到哪些评估数据？ | 判定基准的真值标签由谁写？ |
| 维度性质 | **可见性**（access visibility） | **判定权**（label authority） |
| 保护对象 | 防 benchmark overfitting | 防「选手当裁判」 |
| 度量对象 | Agent 能力（HARM / 成功率） | 判定质量（锚定一致率） |

⇒ **同一批场景可同时具有两个维度的属性**，例如
`{ visibility: FROZEN, labelAuthority: GOLD }` 是合法组合，不冲突。

---

## 3. 生命周期冲突的解法（设计 §2.4.2）

**冲突表象**：`FROZEN` 说「永不删改」，`HELDOUT` 说「用一次后降级」。

**解法：把两者作用在不同对象上。**

```
FROZEN  约束【场景定义文件】—— .scenario.json 的内容与 contentHash
        → 永不删改 ✓

HELDOUT 约束【标签的使用次数】—— labelAuthority 的状态迁移
        → 场景文件不动，只是标签从 HELDOUT 降级为 GOLD
```

⇒ 一次 HELDOUT 场景被使用后：
- `visibility` 仍是 `FROZEN`（文件与 hash 不变）
- `labelAuthority` 从 `HELDOUT` → `GOLD`（标签已曝光，降级）

**关键区分**：「场景定义」与「真值标签」在现有系统中本来就是分离的
（场景在 `eval/scenarios/`，标签在 `agint_evolution.success_template` 里以
`baseline-suite` 前缀混存 —— 正是 external-anchor 提案 G1 批评的「同池」问题）。

---

## 4. 取值定义

### 4.1 `visibility`（Phase 0 维度）

| 值 | 含义 | 进化过程可访问？ |
|---|---|---|
| `EVOLUTION` | 进化集：可训练 / 调参 / 构造变异 | ✅ 可读可写 |
| `VALIDATION` | 验证集：仅用于筛选 candidate | ✅ 只读 |
| `FROZEN` | 冻结集：永久隐藏，仅发版裁决 | ⛔ 完全不可见 |

### 4.2 `labelAuthority`（external-anchor 维度）

| 值 | 含义 | 标签可被被评对象影响？ |
|---|---|---|
| `UNSET` | 无外部冻结标签 —— **当前全部 123 个场景的实际状态** | — |
| `SILVER` | 标签来自系统自评 | ⚠️ 可（这是它叫「银」的原因） |
| `GOLD` | 标签由授权人工冻结，被评对象只读 | ⛔ 不可 |
| `HELDOUT` | 重大版本才开一次的金牌标签 | ⛔ 不可，且**一次性** |

---

## 5. 字段落点与默认值

`inventory.json` 的每个 `units[]` 元素新增两个字段：

```json
{
  "unitId": "cron-parse-and-nextFire",
  "visibility": "EVOLUTION",
  "labelAuthority": "UNSET"
}
```

| 字段 | 默认值 | 为什么是这个默认 |
|---|---|---|
| `visibility` | `EVOLUTION` | Phase 0 三层隔离**尚未落地**（实测 `eval/scenarios/` 下只有 `dedicated/` 与 `mocks/`，无三层目录）⇒ 如实反映「当前全部可被进化访问」，**不假装已隔离** |
| `labelAuthority` | `UNSET` | external-anchor 提案已被老板拍板存档（2026-10-01）⇒ 如实反映「无外部冻结标签」，**不假装已锚定** |

⛔ **两个默认值都是「如实反映现状」，不是「规划目标」**。这一点是本规范的核心纪律：
字段存在不等于能力已具备。`UNSET` 不等于「该场景没有基准」，而是「**没有外部锚定的基准**」。

---

## 6. 边界：本规范只定义协议，不实施提案

external-anchor 提案已被老板拍板存档。Phase 3 **只做协议层预留**，不实施提案内容：

| 提案内容 | 本规范是否实施 | 理由 |
|---|---|---|
| `labelAuthority` 二维标注**写入协议** | ✅ 做 | 纯协议定义，无运行时改动，零风险 |
| `inventory.json` 的 `units[]` 增加该字段（默认 `UNSET`） | ✅ 做 | 纯加法，不改变现有语义 |
| 新建 `agint_quality_anchor` 域 | ❌ **不做** | 提案阶段 1；老板已拍板存档，Phase 3 无权重启 |
| 迁移 `baseline-suite` 出 `success_template` | ❌ **不做** | 提案阶段 2 |
| 撤 `self-evaluate` throw | ❌ **不做** | 提案阶段 3；准入条件严格（≥8 周一致率稳定） |
| `runAnchorConsistency()` 一致率指标 | ❌ **不做** | 提案阶段 1 |
| 把 G1 缺口写入「已知限制」章（§7） | ✅ 做 | 如实上报，不掩盖 |

**提案重启时的映射**（供未来参考，本规范不实施）：

```
提案的 gold / verify / heldout  →  labelAuthority = GOLD / （verify 属轮换策略）/ HELDOUT
提案的 agint_quality_anchor 域  →  与本规范不冲突（本规范只定义标签语义，不规定存储位置）
提案阶段 1 的 anchor.js 纯函数 →  可复用 bin/lib/canonical-json.mjs 的 canonicalStringify
```

⇒ **协议预留的价值**：提案重启时无需重设计三层。

---

## 7. 已知限制（必填，不得省略）

### 限制 1：`dream` / `memory` 域无法被 Frozen Set 覆盖

- **证据**：`inventory.json` 的 `domainCounts` → `dream: 1`、`memory: 1`
- **规则**：Phase 0 §3.2.2 H4「单元数 < 3 的 domain 全留 Evolution Set」
- **后果**：这两个域的能力提升**无法被 Frozen Set 检出**
- **缓解**：① 优先为这两个域新编写 Frozen 场景（Phase 0 §3.2.3）
  ② `memory` 域改由 `recall_outcomes` 埋点评估（Phase 2 §2.3）
  ③ 在 Growth Report 中显式声明该盲区，**不假装全覆盖**

### 限制 2：`labelAuthority` 全为 `UNSET` ⇒ 判定基准无外部锚定

- **证据**：`units[].labelAuthority` 全部为默认值
- **后果（影响 Phase 3 交付物三）**：导出包若包含「该次进化通过了基准评估」的声明，
  而该基准存于 `agint_evolution.success_template`（上限 50、有 model-visible 写工具
  `evolution_addSuccess`、**无 provenance**）⇒ 接收方无法验证这个声明，
  基准可能在导出前被被评对象改写过
- **缓解**：导出包必须 ① 显式标注「基准来源 = `success_template` 同池可写，
  非外部锚定」② 提供 `baselineProvenance` 字段（若可得），不可得则标 `NOT_ANCHORED`
  ③ **不得声称**导出包的评估结论「不可篡改」
- **性质**：**诚实降级**，不是缺陷掩盖。完整信任模型需等 external-anchor 提案实施

### 限制 3：`visibility` 全为默认值 ⇒ 三层隔离未实际生效

- **证据**：`eval/scenarios/` 下无三层目录
- **后果**：字段已可标注、可校验，但**隔离能力不存在**
- **缓解**：Phase 0 Sprint 19 落地三层目录时，同步把 `visibility` 从默认值改为真实分层

---

## 8. 验收标准

| # | 判据 | 怎么验 |
|---|---|---|
| 1 | `inventory.json` 每个 `units[]` 都有 `visibility` 与 `labelAuthority` | `node bin/build-scenario-inventory.mjs --check` |
| 2 | 两字段取值都在本规范定义的枚举内 | 同上（生成器内枚举校验） |
| 3 | 生成器输出与入仓文件一致（不漂移） | `node bin/build-scenario-inventory.mjs --check`（比对 hash） |
| 4 | 规范已被 `INDEX.json` 登记 | `node bin/check-spec-consistency.mjs` |
| 5 | 提案内容**未被**实施（域未建、基准未迁、throw 未撤） | grep `agint_quality_anchor` / `baseline-suite` 应零命中 |

---

## 9. 变更纪律

1. **本规范是文档资产，不是运行时服务。** 严禁为它新建插件或存储域
   （`路线图.md:271` 红线：不引入新的中心化宏观架构层）。
2. **加字段是纯加法。** 改本规范不得改变既有字段的语义。
3. **默认值必须如实反映现状。** 字段存在 ≠ 能力具备 —— 任何把默认值当成
   「已具备该能力」的表述都是失真。
4. **升 major 的条件**（对齐 `compatibility-matrix.json` 的 `upgradePolicy`）：
   ① 改既有字段语义 ② 删字段 ③ 改枚举含义。纯新增字段 / 新增枚举值属向后兼容，不升 major。
