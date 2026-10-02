# Evolution Contract v1.0（人读版）

> **机器读版**：[`evolution-contract-v1.schema.json`](./evolution-contract-v1.schema.json)
> **校验器**：`bin/validate-contract-schema.mjs`（手写，零第三方依赖，不引 ajv）
> **设计来源**：[Phase-0 设计方案 §4.2](../../DSH-AGINT.wiki/Phase-0%20验证体系形式化与补强%20设计方案.md)
> **自测**：`node bin/validate-contract-schema.mjs --fixtures`（20 个用例）

---

## 1. 这是什么

单次进化的完整记录契约：**假设 → 执行 → 裁决 → 结果**。
它把"这次进化为什么做、改了什么、怎么评的、结果如何"固化成一份可机读、可校验、
可回溯的证据对象，供 Phase 1 的 Ledger 消费。

⚠️ **格式纪律**：Contract 由 driver **运行时**读写 ⇒ 必须 JSON。
依据 `eval/scenarios/README.md:297`「避免引入 yaml npm 依赖（AGINT 仓不引入第三方运行时依赖）」。
同理，校验器手写，不引 ajv。

---

## 2. 结构总览

| 段 | 阶段 | 说明 |
|---|---|---|
| `identity` | 创建时 | contractId / 版本 / 创建者 |
| `hypothesis` | DRAFT 前必填 | 假设本体，**锁定后不可改** |
| `evaluationPlan` | DRAFT 前必填 | 用什么集合、多少样本、什么检验 |
| `budget` | DRAFT 前必填 | token / 时长 / 沙箱 / 部署预算 |
| `execution` | 各阶段回填 | diagnosis → mutation → population → mount → abtest |
| `decision` | 裁决 | policy 结果 |
| `outcome` | 评估后回填 | 实际增量 + **取数来源** |
| `audit` | 全程 | hash / 事件 ID / 状态 |

---

## 3. 生命周期（设计 §4.2.2）

```
DRAFT ──diagnosis.completed──▶ DIAGNOSED ──mutator 事务──▶ MUTATED
  │                                                            │
  │ ★ 此时计算 hypothesisLock（防事后编造）                     ▼
  │                                                        EVALUATED
  │                                                            │
  └────────────────────────────────────────────────────────────┘
       ──mount──▶ MOUNTED ──abtest──▶ TESTED ──policy──▶ DECIDED
                                                            │
                                       REJECT ◀─────────────┤
                                                            ▼
                                                        COMPLETED ──▶ ARCHIVED

异常分支：
  任意阶段检测到 hypothesis 被改写 → TAMPERED（终态，不计入任何统计）
  任意阶段 fail-closed（沙箱不可用 / policy REJECT）→ 保留已填字段，
    status 停在当前阶段，decision.policyResult = REJECT
    ★ 不删除、不"清理"失败 Contract（真实 > 讨好）
```

`audit.status` 十态：`DRAFT | DIAGNOSED | MUTATED | EVALUATED | MOUNTED | TESTED | DECIDED | COMPLETED | ARCHIVED | TAMPERED`

---

## 4. 三条 JSON Schema 表达不了的规则

Schema 只能管形状，下面三条是**语义**规则，由校验器代码实现：

### 4.1 benchmarkSet 禁止 FROZEN

`evaluationPlan.benchmarkSet` 只能是 `EVOLUTION` 或 `VALIDATION`。

> **为什么**：Frozen Set 只用于**发版裁决**。若允许单期进化用它筛选 candidate，
> 它会被反复观察，从而失去"冻结"性质。

### 4.2 NO_EVIDENCE 纪律

`outcome.actualDeltas` 出现数值时，`outcome.dataSources.primary` **必须**记录实际命中的源。

取数优先级链（四源，按序尝试）：

```
1. agint_event_bus   ← evolution.mutation.committed / proposal 事件
2. agint_population  ← candidates 表的 commit_id 字段
3. 磁盘 preimage     ← .agint-preimage/ 命中即证明改动真实落盘
4. agint_mutator     ← ⚠️ 已知 stats.commits 为空表，仅作兜底
```

- 四源全空 → 标记 `NO_EVIDENCE`，**不得写 0 或 null 冒充"无改进"**
- 源之间矛盾 → 标记 `EVIDENCE_CONFLICT` + 记录各源的值，人工裁决

> **同型错误教训**：`路线图.md:129` 记载「按 mutator 口径取数会把跑成了读成没跑过」。
> 用 0 冒充未知，是同一个坑换个地方再踩一次。

### 4.3 hypothesisLock 防事后编造（设计 §4.2.4）

Phase 0 只做**埋点**。锁定必须在**看到结果之前**发生才有意义 ——
若等到 Phase 1 才加，Phase 0 期间产生的所有 Contract 都无法证明
"预测不是事后编的"，这批数据永久失去证据价值。

```javascript
// driver 在 DRAFT → DIAGNOSED 转换时
const hypothesisLock = sha256(canonicalStringify({
  contractId: contract.identity.contractId,
  hypothesis: contract.hypothesis,
  createdAt: contract.identity.createdAt,
}));
```

- 序列化规则见 `bin/lib/canonical-json.mjs`（key 码点序递归排序、无 BOM、数字不格式化）
- **锁定值不在 Contract 本体内** —— 设计 §4.2.6 把它的归宿定为独立的
  `contract_locks` 表（key: contractId, value: { hypothesisLock, lockedAt, lockEventId }）
- 校验时由外部传入：`node bin/validate-contract-schema.mjs <file> --lock=<hex>`

---

## 5. Phase 0 的诚实边界

设计 §4.2.3 实测：**约 10/14 个字段组可从现有数据源自动回填**，
但有 2 项是真正的新增能力，Phase 0 允许为 `null` 并显式标注：

| 字段 | 状态 | 说明 |
|---|---|---|
| `hypothesis.predictedDelta` | `null` + `predictedDeltaNote: "NOT_PREDICTED"` | 三级预测来源属 Phase 1 |
| `outcome.actualDeltas` | 依赖取数口径统一 | 属 Phase -1 的遗留问题 |

**不得用占位值或推算值填充。** 校验器对 `predictedDelta: null` 且未标注
`NOT_PREDICTED` 的情况给出 WARN（不拦），提醒补齐标注。

---

## 6. 用法

```bash
# 校验一份 Contract
node bin/validate-contract-schema.mjs path/to/contract.json

# 同时校验 hypothesis 锁定值（防事后编造）
node bin/validate-contract-schema.mjs path/to/contract.json --lock=<sha256hex>

# CI 消费
node bin/validate-contract-schema.mjs path/to/contract.json --json

# 跑内置用例自测（20 个）
node bin/validate-contract-schema.mjs --fixtures
```

退出码：`0` 通过 / `1` 校验失败 / `2` 脚本自身出错（schema 或文件读不到）

---

## 7. 已知边界

⚠️ **设计 §4.2.1 的 JSON 示例本身过不了本校验器** —— 它的枚举字段写成
`"SUCCESS_RATE | TOKEN_EFFICIENCY | ..."` 这种速记形式（表示"可选值范围"），
不是单一合法取值。示例是**示意性的**，不是可直接落盘的实例。
校验器按"单一取值"校验，这是正确的行为，不要为迁就示例而放宽枚举。
