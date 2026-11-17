# external-anchor 阶段 1：`labelAuthority` 采集契约

> 状态：**ACTIVE · 阶段 1**（2026-11-07 老板撤销 2026-10-01 存档决定后重启）
> 依据：`proposals/agint-external-anchor-eval.md` §3.2 四条不变量 / §3.4 三层样本集 / §8 首个最小动作
> 工程规格：`AGINT-边界放宽实施规格-20261107.md`（工作区根，非入库）
> ⛔ 本文件刻意**不放在 `docs/specs/`** —— `bin/check-spec-consistency.mjs` 会把未登记的新 specs 文件判「孤儿规范」，而 `INDEX.json` 是 `build-spec-index.mjs` 生成的，手改会被覆盖。

---

## 1. 枚举：复用，不另造

`labelAuthority` 的唯一真源是 `bin/lib/scenario-tier.mjs` 的 `LABEL_AUTHORITY_VALUES`：

| 值 | 含义 | 能否进判定一致率 | 能否通过自动写入闸 G2 |
|---|---|---|---|
| `UNSET` | 无外部冻结标签（**当前全库实际状态**） | ⛔ 否 | ⛔ 否 |
| `SILVER` | 标签来自系统自评 | ⛔ 否（选手不能当裁判） | ⛔ 否 |
| `GOLD` | 授权人工冻结，被评对象只读 | ✅ 是 | ✅ 是 |
| `HELDOUT` | 重大版本才开一次的金牌标签，**一次性** | ✅ 是 | ✅ 是 |

另有两个正交维度，不得混进上表：

- `visibility`（`EVOLUTION` / `VALIDATION` / `FROZEN`）回答的是「进化过程能看到哪些评估数据」，防 benchmark overfitting；
- `labelAuthority` 回答的是「**判定基准的真值标签由谁写**」，防选手当裁判。

见 `docs/specs/evaluation-protocol-v1.md` §2 / §4.2。

> ⚠️ 2026-11-07 修正：`bin/evolution-evidence.mjs` 旧实现把「任意非 `UNSET`」都算外部锚定，会把 `SILVER` 误计；示例值还用过不存在的 `HUMAN_FROZEN`。已改为只认 `GOLD` / `HELDOUT`，并补 `SILVER` 阴性对照。

---

## 2. 采集契约

### 2.1 判定样本的最小形状

```json
{
  "id": "cap-L3-001",
  "kind": "curriculum",
  "layer": "L3",
  "labelAuthority": "GOLD",
  "frozenLabel": "PASS",
  "frozenBy": "<授权人工标识>",
  "frozenAt": "<ISO 8601>",
  "compositeScore": 0.82,
  "notes": "自评结论只进 notes，不参与 label"
}
```

- `frozenLabel ∈ {PASS, REJECT}`；`compositeScore === null` 时 `decision = REJECT`（提案 §3.3）。
- 自评 / LLM 输出一律只进 `notes`。**LLM 不作真值源**（提案 §4「不让 LLM 当标签源」）。

### 2.2 四条不变量在本契约的落法

| 不变量 | 落法 |
|---|---|
| 1 判定标准与被评对象不同池 | 冻结集落 `eval/capability-baseline/sets/`，**不写** `agint_evolution.success_template`；每份 set 带 `contentHash` 防篡改 |
| 2 判定权与写入权分离 | `SILVER` 被 `isExternalFrozen()` 排除；被评对象只有读权 |
| 3 真值标签外部冻结 | 只有 `GOLD` / `HELDOUT` 且带 `frozenBy` / `frozenAt` 才有效；**本批 0 条** |
| 4 无外部证据记 fail | `UNSET` / `SILVER` / 字段缺失 → 不进分子分母，单独计数；`rate` 返回 `{value:null, reason}`，**绝不返回 0** |

### 2.3 三层分离（提案 §3.4）

| 集 | 用途 | 谁可写 | 轮换 |
|---|---|---|---|
| `gold` | 一致率基准 | 授权人工 append-only | 老样本沉淀后迁出 |
| `verify` | 轮换验证 | 授权人工 | 每季度换 20% |
| `heldout` | 只在宣布重大版本时开一次 | 授权人工 + 留审计 | 单次使用后降级并入 `verify` |

⛔ **不许拿金标集调参** —— 一旦拿 `gold` 调参，验证集即退化为训练集。`bin/capability-baseline.mjs` 会强制 `gold ∩ heldout = ∅`。

---

## 3. 降级路径

```
labelAuthority 列不存在           → NO_LABEL_AUTHORITY_FIELD（无数据，不是「0 条锚定」）
labelAuthority = UNSET / SILVER   → 排除，单独计 excluded
labelAuthority = GOLD / HELDOUT   → 进分母，决策与 frozenLabel 对拍
无任何可用样本                    → rate = { value: null, reason }，拒绝出结论
```

这条三态纪律与 `bin/evolution-evidence.mjs`、`bin/growth-report.mjs` 一致：**0 是查过的真 0，null 是没测过**，两者不可互换。

---

## 4. 阶段边界

| 阶段 | 内容 | 本批状态 |
|---|---|---|
| 1 | `anchor.mjs` 纯函数 + 单测 + 本契约；**不挂载、不建域、零运行时影响** | ✅ 已落地 |
| 2 | 基准外置（迁出 `success_template`）+ 一致率接 `weeklyTask` 退化探测 | ⛔ 未启动，需 D1–D5 拍板 + ≥4 周数据 |
| 3 | 撤 `self-evaluate` throw，自评结果只能 `PENDING_REVIEW` | ⛔ 未启动，需三项准入全满足 |

⛔ 本批**没有**产生任何外部冻结标签，也不改 `prediction_outcomes` 里那 4 行生产数据（手改 storages JSON 会撞版本校验）。当前体检脚本仍应报 `NO_LABEL_AUTHORITY_FIELD` —— 这是正确读数，不是缺陷。
