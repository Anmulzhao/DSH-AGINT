# 冻结能力基准集（A2）

> 状态：**规格 + 空集就位，0 冻结标签**（2026-11-07 · 麒麟机）
> 依据：`AGINT-P1拍板单-20261107.md` A2；`proposals/agint-external-anchor-eval.md` §3.4 三层样本集
> 配套：`eval/anchor/README.md`（`labelAuthority` 采集契约）、`bin/capability-baseline.mjs`（只读校验器）

---

## 0. 这份基准集要解决的，正是「分数涨到 99.9 而能力证据为空」

`AGINT-分数与能力证据对照-20261107.md` 判 `NOT_COMPARABLE`：左侧 `aesthetic_score` 有连续 6 周（W40 80.3 → W45 99.9），右侧 `capability_map` 只覆盖 1 个 ISO 周、`CAN` 条目恒为 0。

本目录提供**右侧**该有的东西：一组跨 L0–L5、机械可验证、真值标签外部冻结的能力基准。

⛔ 但本批**不提供任何标签**：题目与 `PASS/REJECT` 真值必须由授权人工冻结。脚本不会替人推断标签，0 标签时校验器按设计**拒绝出任何能力结论**。

---

## 1. 三层分离（提案 §3.4）

| 集 | 文件 | 用途 | 谁可写 | 轮换 |
|---|---|---|---|---|
| `gold` | `sets/gold.json` | 一致率基准 | 授权人工 append-only | 老样本沉淀后迁出 |
| `verify` | `sets/verify.json` | 轮换验证 | 授权人工 | 每季度换 20% |
| `heldout` | `sets/heldout.json` | 只在宣布重大版本时开一次 | 授权人工 + 留审计 | 单次使用后降级并入 verify |

硬约束：

- ⛔ **`gold ∩ heldout = ∅`**，由 `bin/capability-baseline.mjs` 强制；否则 `CORRUPT`。
- ⛔ **不许拿 `gold` 调参**。一旦拿金标集调参，验证集即退化为训练集。
- 每份 set 带 `contentHash`（对 `samples` 的 `canonicalHash`），改动任一条即 `CORRUPT`。
- `contentHash: ""` 且 `samples: []` 是合法的 **UNSEALED**（未密封）状态 —— 即本批状态；有样本却未密封 ⇒ `CORRUPT`。

---

## 2. L0–L5 绑定：每层的机械验证形态

下表只定义**「通过/失败该怎么机械判定」**（规格），**不写具体题目、不写期望答案** —— 那些是真值标签，须由人冻结。

| 层 | 路线图口径 | 机械可验证的通过形态 | 当前麒麟机证据 |
|---|---|---|---|
| L0 | 挂载与工具注册 | 声明的工具行全部 `tools.register()` 成功，无 `did not activate` | 需实测采集 |
| L1 | 单插件行为 | `manifest.tests.command` 在**部署位**跑通，无 FAIL | 需实测采集 |
| L2 | 跨插件服务 / 事件 | `check-wiring.mjs` 查 A / A2 无硬缺口 | ⚠️ 当前 2 个 `NO_SUBSCRIBER` 既有红 |
| L3 | 自主代码生成（P6 已验证） | mutator 产出的 diff 可编译且单测通过 | 需实测采集 |
| L4 | 自主课程学习（P7 进行中） | challenge 有 attempt、verdict 带外部证据 | ⚠️ 当前 5 挑战 / 1 attempt / 4 open |
| L5 | 元进化（P8 Deferred） | 判尺改动经离线回放 + 人工复核，历史分段可解释 | ⚠️ 当前 0 已标注周，不可判 |

> ⚠️ 第三列是「判据形状」不是「能力结论」；第四列是只读体检读数，不是评估。判定权归外部冻结基准与授权人工。

---

## 3. 样本形状

```json
{
  "id": "cap-L3-001",
  "layer": "L3",
  "kind": "mutator",
  "description": "<机械可验证的任务描述>",
  "mechanicalCheck": "<怎么算 PASS / REJECT>",
  "label": null,
  "labelAuthority": "UNSET",
  "frozenBy": "",
  "frozenAt": ""
}
```

- `label ∈ { PASS, REJECT, null }`；`labelAuthority` 沿用 `bin/lib/scenario-tier.mjs` 的 `UNSET / SILVER / GOLD / HELDOUT`。
- 只有 `GOLD` / `HELDOUT` 且 `label` 非 null 才计入 `usableFrozenLabels`。
- ⛔ `SILVER`（系统自评）与 `UNSET` 一律不进分母 —— external-anchor 不变量 4「无外部证据记 fail」。
- 自评 / LLM 输出只可写进 `notes`，**不可作真值**（提案 §4）。

---

## 4. 当前状态（2026-11-07）

| 项 | 值 |
|---|---|
| `gold` / `verify` / `heldout` | 三份空集，`UNSEALED` |
| 冻结标签 | **0**（真 0，不是没测过） |
| 校验器判词 | `NO_FROZEN_LABELS` |
| 能力结论 | `{ value: null, reason: ... }` —— **拒绝输出** |

**回滚**：删本目录与 `bin/capability-baseline.mjs`（未跟踪文件，零残留）。不占周额度、不重启、不改任何运行时数据。

**下一步（需人投入）**：由你或指定人按 §2 逐层出题并冻结 `GOLD` 标签；之后 `bin/capability-baseline.mjs` 会转 `READY`，`eval/anchor/anchor.mjs` 才有分母可算一致率。⛔ 在此之前不要写「AGINT 能力有提升」这类结论。

---

## 5. 就绪包：把出题后的手工活压成三条命令（2026-11-07 第四批）

`bin/capability-baseline-freeze.mjs` 只做**模板 / 只读校验 / 密封**，⛔ 绝不代填真值：

```bash
node bin/capability-baseline-freeze.mjs --template     # 单条样本形状，零写入
node bin/capability-baseline-freeze.mjs --check        # 治理体检（只读）
node bin/capability-baseline-freeze.mjs --seal gold    # 只写 contentHash
```

- **唯一被写入的字段是 `contentHash = canonicalHash(samples)`**；`samples` / `label` /
  `labelAuthority` / `frozenBy` / `frozenAt` / `authority` 逐字段对拍不变。
- 硬拒：占位署名（`agent`/`system`/`ai`/`''` …）、`frozenAt` 非 ISO8601、
  `verify` 样本标 `GOLD`/`HELDOUT`、`gold ∩ heldout` 有交集、缺 `description`/
  `mechanicalCheck`、空集密封、路径越出 `sets/`。
- ⚠ `verify.authority="VERIFY"` 是合法用途标记（`deriveAnchorAuthority` 只读
  gold/heldout），脚本不要求它落在 `labelAuthority` 枚举内，不倒逼改既有数据。
- ⚠ 「有样本但 `contentHash` 为空」是**待密封的正常态**，`--check` 记为
  `UNSEALED_PENDING` 与 warning，不当治理违规（否则密封永远进不去）。

顺序：`--template` 看形状 → 人按 §2 出题、给 `PASS/REJECT`、逐条署名 →
`--check` 通过 → 逐份 `--seal` → `node bin/capability-baseline.mjs --json` 判 `READY`
→ `node bin/oracle-live-tick.mjs --storages "$DSH_HOME/storages" --switch on --status`
看到 `G2_external_anchor` 变 ✓。

⛔ **五闸 5/5 仍不等于生产写入**：默认/心跳 sink 仍是 dry-run。真正的写入许可
要另走 `eval/gated-features/生产投递评审单.md` 的单独评审。
