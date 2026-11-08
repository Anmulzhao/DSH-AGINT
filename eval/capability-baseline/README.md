# 冻结能力基准集（A2）

> 状态（2026-11-08）：三份集合已由「**委托机械真值**」填充并密封 —— 23 条断言 /
> 17 条可用冻结标签 / `READY`。⚠ **运营者授权 · agent 执行 · 非人类验证**，
> 语义已降级，⛔ 不得据此宣称 AGINT 能力水平或能力变化 —— 详见 §6。
> 历史（2026-11-07）：规格 + 空集就位，0 冻结标签。
> 依据：`AGINT-P1拍板单-20261107.md` A2；`proposals/agint-external-anchor-eval.md` §3.4 三层样本集
> 配套：`eval/anchor/README.md`（`labelAuthority` 采集契约）、`bin/capability-baseline.mjs`（只读校验器）

---

## 0. 这份基准集要解决的，正是「分数涨到 99.9 而能力证据为空」

`AGINT-分数与能力证据对照-20261107.md` 判 `NOT_COMPARABLE`：左侧 `aesthetic_score` 有连续 6 周（W40 80.3 → W45 99.9），右侧 `capability_map` 只覆盖 1 个 ISO 周、`CAN` 条目恒为 0。

本目录提供**右侧**该有的东西：一组跨 L0–L5、机械可验证、真值标签外部冻结的能力基准。

⛔ 2026-11-07 批次**不提供任何标签**：题目与 `PASS/REJECT` 真值按定义须由授权人工冻结；
0 标签时校验器按设计**拒绝出任何能力结论**。

⚠ 2026-11-08 第五批按运营者授权改由确定性断言实跑生成，但 `GOLD` / `HELDOUT`
的**语义已降级**，`humanValidated:false`，`capabilityConclusion` 仍恒 `null`
—— 见 §6，⛔ 勿把「真值已可读」误读成「能力已被验证」。

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

## 4. 历史状态快照（2026-11-07，⛔ 数值已被 §6 取代）

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

---

## 6. 委托机械真值（2026-11-08 第五批，⛔ 语义已降级）

> 依据 `eval/gated-features/生产投递评审单.md` §7 预留的宪法级边界变更路径：
> 运营者授权 agent **单独开一轮**代执行 G2 —— 单独改动、单独提交，
> 明确记录授权来源与降级后的语义；绝不悄悄塞进上一批、绝不伪装成人工 `GOLD`。

### 6.1 是什么，不是什么

| | |
|---|---|
| **是** | 一组对确定性**代码行为**的客观断言。每条 `label` 由 `bin/capability-baseline-mechanical.mjs` 的 `verify()` **实跑**得出（PASS=断言真 / REJECT=断言假），第三方重跑 `--verify` 得同解。真值外置于评分回路：不含分数字段、不读 `aesthetic_score`、不调 LLM、不依赖系统自评，密封后运行时不可篡改 |
| **不是** | ⛔ **不是授权人工冻结的能力金标**。题目由系统侧依现有代码契约构造 ⇒ 存在**构造期自参照**：系统可能挑自己易通过的断言。不得据此宣称 AGINT 能力水平或能力变化 |

`GOLD` / `HELDOUT` 在本批仅表示「外部冻结真值：断言可独立复现、密封不可篡改、
外置于评分回路」，**不再表示**「授权人工已验证 AGINT 能力」。

### 6.2 实测数据

| 项 | 值 |
|---|---|
| 断言总数 | **23**（gold 13 / verify 6 / heldout 4），L0–L5 全覆盖 |
| 实跑结果 | PASS **21** / REJECT **2**（两条真负控制，证明校验器不是一律盖章） |
| `verifyBaseline` | `READY` ｜ 三份 `SEALED` ｜ `usableFrozenLabels=17` |
| 分母口径 | 只有 gold 13（GOLD）+ heldout 4（HELDOUT）计入；verify 6 条 `SILVER` 不进分母 |
| `gold ∩ heldout` | **0** |
| `capabilityConclusion` | `{ value: null, reason: 'JUDGEMENT_EXTERNAL…' }` —— **仍拒绝输出** |
| 可复现对拍 | 重跑 23 / 冻结 23 / 不一致 **0** |

### 6.3 provenance 与治理护栏

每份集合顶层 `provenance` 八字段齐全：`basis=MECHANICAL_REPRODUCIBLE`、
`humanValidated=false`、`delegatedBy=operator`、`mandate`（授权原文）、
`executedBy=WorkBuddy agent（非人类）`、`semanticDowngrade`、
`knownLimitation`（构造期自参照）、`reproduceCommand`；另有 `authorityBasis`
显式标注，逐条样本带 `--id <id>` 可复现命令。

`bin/capability-baseline-freeze.mjs`（`FREEZE_SCHEMA 1.1`）对委托类别做**更严格**
的校验，不是靠「署名字符串碰巧不在禁词表」放行：

- 缺顶层 provenance / 缺 `authorityBasis` ⇒ 拒绝密封（禁止悄悄代签）；
- `humanValidated !== false` ⇒ 拒绝（绝不允许把机械真值说成人类已验证）；
- 混入人工署名、逐条缺 `reproduceCommand --id` ⇒ 拒绝；
- 未写出「不表示 / 不得据此」降级语义、未披露构造期自参照 ⇒ 拒绝；
- `--check` 打出醒目降级 banner，不静默放行。

⛔ 人工金标路径**完全未变**：占位署名硬拒、`verify` 样本标 GOLD 硬拒、
空集密封硬拒、`gold ∩ heldout` 交集硬拒、路径逃逸硬拒。

### 6.4 复核命令

```bash
export PATH=/home/kylin/.nvm/versions/node/v24.21.0/bin:$PATH
node bin/capability-baseline-mechanical.mjs --verify    # REPRODUCIBLE
node bin/capability-baseline-freeze.mjs --check          # 治理 ✓ + 降级 banner
node bin/capability-baseline.mjs --json                  # verdict=READY
```

### 6.5 不变式与已知局限

- ⛔ 不写 `humanVerdict` / `humanOverall`；人工标注仍 **0 条**。
- ⛔ 不改 `lib/scoring.js` 与任何评分常量；该文件哈希在本批前后未变。
- ⛔ 零 LLM、零 3080 调用、不挂 cordis、不碰生产 storages。
- ⛔ `verifyBaseline()` 仍不产出能力结论；`eval/anchor/anchor.mjs` 的一致率
  仍须以**真正的外部标注**为分母，不得把这 17 条机械真值当能力一致率用。
- ⚠ 已知局限：构造期自参照（§6.1）。要恢复「授权人工冻结」的原始语义，
  仍需人重新出题、给 `PASS/REJECT`、逐条署名；`git revert` 本批即可回到三份空集。

> 本节只解决「存在一组可独立复现、密封不可篡改的判据」；
> **不证明 AGINT 能力，也不构成生产写入许可**（评审判定见评审单 §8：**不予放行**）。
